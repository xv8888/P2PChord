import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export class StreamCache {
  constructor({
    client,
    logger,
    directory,
    ttlMs,
    maxBytes,
    maxActiveStreams,
    maxStreamBytes,
    streamTimeout,
    idleTransferTimeout,
    formatBytes,
  }) {
    this.client = client;
    this.logger = logger;
    this.directory = resolve(directory);
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.maxActiveStreams = maxActiveStreams;
    this.maxStreamBytes = maxStreamBytes;
    this.streamTimeout = streamTimeout;
    this.idleTransferTimeout = idleTransferTimeout;
    this.formatBytes = formatBytes;
    this.entries = new Map();
    this.entryInitializations = new Map();
    this.activePeerFiles = new Map();
    this.activeStreams = 0;
    this.initialization = null;
    this.sweepQueue = Promise.resolve();
  }

  log(level, message) {
    this.logger(level, message);
  }

  async initialize() {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      await mkdir(this.directory, { recursive: true });
      const names = await readdir(this.directory);
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const key = name.slice(0, -5);
        const metadataPath = join(this.directory, name);
        let metadata;
        try {
          metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") {
            this.log("WARN", `Ignoring invalid stream cache metadata ${name}: ${error.message}`);
            await rm(metadataPath, { force: true });
          }
          continue;
        }
        if (
          !metadata ||
          !Number.isSafeInteger(metadata.trackSize) ||
          metadata.trackSize < 1 ||
          !Number.isSafeInteger(metadata.lastAccess) ||
          typeof metadata.complete !== "boolean"
        ) {
          this.log("WARN", `Ignoring invalid stream cache metadata ${name}.`);
          await rm(metadataPath, { force: true });
          continue;
        }
        const partialPath = join(this.directory, `${key}.part`);
        const completePath = join(this.directory, `${key}.flac`);
        let completeInfo;
        try {
          completeInfo = await stat(completePath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (completeInfo && completeInfo.size !== metadata.trackSize) {
          await rm(completePath, { force: true });
          completeInfo = null;
        }
        let partialInfo;
        if (!completeInfo) {
          try {
            partialInfo = await stat(partialPath);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await rm(metadataPath, { force: true });
            continue;
          }
          if (partialInfo.size > metadata.trackSize) {
            await rm(partialPath, { force: true });
            await rm(metadataPath, { force: true });
            continue;
          }
        } else {
          await rm(partialPath, { force: true });
        }
        const complete = Boolean(completeInfo);
        const entry = this.makeEntry(
          key,
          metadata.trackSize,
          metadata.lastAccess,
          complete,
          completeInfo?.size ?? partialInfo.size,
        );
        entry.trackTitle = "";
        this.entries.set(key, entry);
      }
      for (const name of names) {
        const dataFile = /^([a-f0-9]{64})\.(?:part|flac)$/.exec(name);
        const metadataTemp = /^[a-f0-9]{64}\.json\..+\.tmp$/.test(name);
        if (dataFile && !this.entries.has(dataFile[1])) {
          await rm(join(this.directory, name), { force: true });
        } else if (metadataTemp) {
          await rm(join(this.directory, name), { force: true });
        }
      }
      await this.sweep();
    })();
    return this.initialization;
  }

  makeEntry(key, trackSize, lastAccess, complete, receivedBytes) {
    let resolveChange;
    const changed = new Promise((resolve) => {
      resolveChange = resolve;
    });
    return {
      key,
      trackSize,
      trackTitle: "",
      trackUser: "",
      trackFile: "",
      partialPath: join(this.directory, `${key}.part`),
      completePath: join(this.directory, `${key}.flac`),
      dataPath: join(this.directory, `${key}.${complete ? "flac" : "part"}`),
      metadataPath: join(this.directory, `${key}.json`),
      lastAccess,
      complete,
      receivedBytes,
      lastTransferStatus: "idle",
      lastError: null,
      consumers: 0,
      activeTransfer: null,
      idleTimer: null,
      evicting: false,
      eviction: null,
      metadataQueue: Promise.resolve(),
      changed,
      resolveChange,
    };
  }

  notify(entry) {
    const resolveChange = entry.resolveChange;
    entry.changed = new Promise((resolve) => {
      entry.resolveChange = resolve;
    });
    resolveChange();
  }

  async writeMetadata(entry) {
    const next = entry.metadataQueue.then(async () => {
      const temporaryPath = `${entry.metadataPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify({
        trackSize: entry.trackSize,
        lastAccess: entry.lastAccess,
        complete: entry.complete,
      }));
      await rename(temporaryPath, entry.metadataPath);
    });
    entry.metadataQueue = next.catch((error) => {
      this.log("ERROR", `Could not persist stream cache metadata: ${error.message}`);
    });
    await next;
  }

  async getEntry(track) {
    await this.initialize();
    const key = createHash("sha256")
      .update(`${track.user}\0${track.file}\0${track.size}`)
      .digest("hex");
    const existing = this.entries.get(key);
    if (existing?.evicting) {
      await existing.eviction;
      return this.getEntry(track);
    }
    if (existing) {
      this.addConsumer(existing);
      existing.trackTitle = track.title;
      existing.trackUser = track.user;
      existing.trackFile = track.file;
      this.log(
        "INFO",
        `Stream cache hit for "${track.title}" (${existing.complete ? "complete" : `${this.formatBytes(existing.receivedBytes)} partial`}).`,
      );
      return existing;
    }
    const pending = this.entryInitializations.get(key);
    if (pending) {
      const entry = await pending;
      this.addConsumer(entry);
      entry.trackTitle = track.title;
      entry.trackUser = track.user;
      entry.trackFile = track.file;
      return entry;
    }
    const initialization = (async () => {
      const entry = this.makeEntry(key, track.size, Date.now(), false, 0);
      entry.trackTitle = track.title;
      entry.trackUser = track.user;
      entry.trackFile = track.file;
      entry.consumers = 1;
      const handle = await open(entry.partialPath, "a");
      await handle.close();
      await this.writeMetadata(entry);
      this.entries.set(key, entry);
      this.log("INFO", `HTTP consumers for "${entry.trackTitle}": ${entry.consumers}.`);
      this.log("INFO", `Stream cache miss for "${track.title}".`);
      return entry;
    })();
    this.entryInitializations.set(key, initialization);
    try {
      return await initialization;
    } catch (error) {
      const entry = this.entries.get(key);
      if (entry) this.removeConsumer(entry);
      throw error;
    } finally {
      if (this.entryInitializations.get(key) === initialization) {
        this.entryInitializations.delete(key);
      }
    }
  }

  async touch(entry) {
    entry.lastAccess = Date.now();
    await this.writeMetadata(entry);
  }

  addConsumer(entry) {
    entry.consumers++;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    this.log(`INFO`, `HTTP consumers for "${entry.trackTitle}": ${entry.consumers}.`);
  }

  removeConsumer(entry) {
    entry.consumers = Math.max(0, entry.consumers - 1);
    this.log(`INFO`, `HTTP consumers for "${entry.trackTitle}": ${entry.consumers}.`);
    if (entry.consumers === 0 && entry.activeTransfer && !entry.complete) {
      entry.idleTimer = setTimeout(() => {
        if (entry.consumers === 0 && entry.activeTransfer && !entry.complete) {
          entry.activeTransfer.cancel("No active HTTP consumers");
        }
      }, this.idleTransferTimeout);
      entry.idleTimer.unref();
    }
    void this.sweep();
  }

  async ensureTransfer(entry, track, context = {}) {
    if (entry.complete) return;
    let transfer = entry.activeTransfer;
    if (transfer) {
      this.log(
        "STREAM",
        `File request ${context.requestId ?? "unknown"} reuses transfer result id=${track.id} ` +
          `from ${track.user}\\${track.file} (${this.formatBytes(entry.receivedBytes)} cached).`,
      );
    }
    if (!transfer) {
      const peerFileKey = `${track.user}\0${track.file}`;
      const conflictingTransfer = this.activePeerFiles.get(peerFileKey);
      if (conflictingTransfer && conflictingTransfer.entry !== entry) {
        const error = new Error(
          "A different version of this peer file is already streaming",
        );
        error.statusCode = 409;
        throw error;
      }
      if (this.activeStreams >= this.maxActiveStreams) {
        this.log(
          "WARN",
          `File request ${context.requestId ?? "unknown"} cannot start result id=${track.id} ` +
            `from ${track.user}\\${track.file}; no transfer slot available (${this.activeStreams}/${this.maxActiveStreams}).`,
        );
        throw new Error("Too many active Soulseek streams");
      }
      this.log(
        "INFO",
        `File request ${context.requestId ?? "unknown"} has a transfer slot for result id=${track.id} ` +
          `(${this.activeStreams + 1}/${this.maxActiveStreams}).`,
      );
      transfer = this.createTransfer(entry, track, peerFileKey, context);
    }
    await transfer.ready;
  }

  hasActiveTrackUse(track) {
    const key = createHash("sha256")
      .update(`${track.user}\0${track.file}\0${track.size}`)
      .digest("hex");
    const entry = this.entries.get(key);
    return Boolean(entry && (entry.consumers > 0 || entry.activeTransfer));
  }

  createTransfer(entry, track, peerFileKey, context) {
    const transfer = {
      entry,
      track,
      requestId: context.requestId,
      searchRequestIds: context.searchRequestIds ?? [],
      peerFileKey,
      fileHandle: null,
      writePosition: entry.receivedBytes,
      writeQueue: Promise.resolve(),
      writeError: null,
      finalizing: null,
      released: null,
      resolveReleased: null,
      timer: null,
      controller: new AbortController(),
      speedBytesPerSecond: null,
      lastProgressBytes: entry.receivedBytes,
      lastProgressAt: null,
      cancel: null,
      ready: null,
    };
    transfer.released = new Promise((resolve) => {
      transfer.resolveReleased = resolve;
    });
    entry.activeTransfer = transfer;
    this.activePeerFiles.set(peerFileKey, transfer);
    entry.lastError = null;
    entry.lastTransferStatus = "downloading";
    this.activeStreams++;
    this.log(
      "STREAM",
      `Starting Soulseek transfer for result id=${track.id} from ${track.user}\\${track.file} ` +
        `at ${this.formatBytes(transfer.writePosition)} (${this.activeStreams}/${this.maxActiveStreams} slots); ` +
        `file request ${transfer.requestId ?? "unknown"}; ` +
        `searchRequests=${transfer.searchRequestIds.join(",")}.`,
    );
    if (transfer.writePosition > 0) {
      this.log(
        "STREAM",
        `Resuming result id=${track.id} from byte ${transfer.writePosition} using the peer's offset request.`,
      );
    }
    transfer.timer = setTimeout(
      () => transfer.cancel("Soulseek transfer timed out"),
      this.streamTimeout,
    );
    transfer.timer.unref();
    transfer.cancel = (reason) => {
      if (transfer.controller.signal.aborted || transfer.finalizing) return;
      this.log(
        "STREAM",
        `Soulseek transfer result id=${track.id} from ${track.user}\\${track.file} ` +
          `stopped for file request ${transfer.requestId ?? "unknown"}: ${reason}.`,
      );
      transfer.controller.abort(new Error(reason));
    };
    transfer.ready = this.startTransfer(transfer);
    return transfer;
  }

  async startTransfer(transfer) {
    const { entry, track } = transfer;
    try {
      transfer.fileHandle = await open(entry.partialPath, "r+");
      if (transfer.writePosition >= entry.trackSize) {
        await transfer.fileHandle.truncate(0);
        transfer.writePosition = 0;
        entry.receivedBytes = 0;
      }
      const tempPath = join(tmpdir(), "BitSeekWin", `${randomUUID()}.flac`);
      const download = this.client.download({
        ...track,
        path: tempPath,
        offset: transfer.writePosition,
        timeout: this.streamTimeout,
        signal: transfer.controller.signal,
      });
      transfer.download = download;
      download.on("status", (status) => {
        const label = {
          requested: "Peer request sent; awaiting response",
          queued: "Queued by peer",
          connected: "Peer accepted transfer",
          downloading: "Receiving audio bytes",
          interrupted: "Transfer interrupted; retrying",
          complete: "Peer transfer complete",
          failed: "Peer rejected or failed transfer",
          cancelled: "Transfer cancelled",
        }[status] ?? status;
        this.log(
          status === "failed" ? "WARN" : "STREAM",
          `Soulseek result id=${track.id} from ${track.user}\\${track.file} ` +
            `(file request ${transfer.requestId ?? "unknown"}): ${label}.`,
        );
      });
      download.on("queue", (place) => {
        this.log(
          "STREAM",
          `Soulseek result id=${track.id} is queue position ${place} at ${track.user} ` +
            `(file request ${transfer.requestId ?? "unknown"}).`,
        );
      });
      download.on("progress", (progress = {}) => {
        const now = Date.now();
        const elapsed = transfer.lastProgressAt === null
          ? 0
          : now - transfer.lastProgressAt;
        if (elapsed > 0 && progress.receivedBytes >= transfer.lastProgressBytes) {
          transfer.speedBytesPerSecond =
            ((progress.receivedBytes - transfer.lastProgressBytes) * 1000) /
            elapsed;
        }
        transfer.lastProgressBytes = progress.receivedBytes;
        transfer.lastProgressAt = now;
        if (progress.receivedBytes - (transfer.lastLoggedProgressBytes ?? transfer.writePosition) < 1024 * 1024) return;
        transfer.lastLoggedProgressBytes = progress.receivedBytes;
        const percentage = Number.isFinite(progress.progress)
          ? ` (${Math.round(progress.progress * 100)}%)`
          : "";
        this.log(
          "STREAM",
          `Soulseek result id=${track.id} from ${track.user}: ` +
            `${this.formatBytes(progress.receivedBytes)} received${percentage}.`,
        );
      });
      download.on("data", (chunk) => this.writeChunk(transfer, chunk));
      download.on("complete", (result = {}) => {
        this.log(
          "STREAM",
          `Soulseek result id=${track.id} from ${track.user} peer transfer complete ` +
            `(${this.formatBytes(result.receivedBytes ?? transfer.writePosition)}).`,
        );
      });
      download.on("failed", (error) => {
        if (!transfer.controller.signal.aborted) {
          this.log(
            "ERROR",
            `Soulseek result id=${track.id} from ${track.user}\\${track.file} ` +
              `failed for file request ${transfer.requestId ?? "unknown"}: ${error.message}.`,
          );
        }
        void this.finishTransfer(transfer, error, false);
      });
      download.then(
        () => this.finishTransfer(transfer, null, true),
        (error) => this.finishTransfer(transfer, error, false),
      ).catch((error) => {
        this.log(
          "ERROR",
          `Unexpected transfer finalization failure for result id=${track.id}: ${error.message}`,
        );
      }).finally(() => rm(tempPath, { force: true }).catch((error) => {
        console.error("Could not remove temporary stream file:", error.message);
      }));
    } catch (error) {
      await this.finishTransfer(transfer, error, false);
      throw error;
    }
  }

  writeChunk(transfer, chunk) {
    const position = transfer.writePosition;
    transfer.writePosition += chunk.length;
    if (transfer.writePosition > this.maxStreamBytes) {
      this.log("WARN", `"${transfer.track.title}" exceeded the stream-size limit.`);
      transfer.cancel("Stream exceeded its size limit");
      return;
    }
    transfer.writeQueue = transfer.writeQueue.then(async () => {
      let bytesWritten = 0;
      while (bytesWritten < chunk.length) {
        const result = await transfer.fileHandle.write(
          chunk,
          bytesWritten,
          chunk.length - bytesWritten,
          position + bytesWritten,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Could not write received bytes to the stream cache");
        }
        bytesWritten += result.bytesWritten;
      }
      transfer.entry.receivedBytes = position + chunk.length;
      if (transfer.entry.receivedBytes === chunk.length) {
        this.log("STREAM", `First audio bytes received for "${transfer.track.title}".`);
      }
      this.notify(transfer.entry);
    }).catch((error) => {
      transfer.writeError = error;
      transfer.cancel("Could not write received bytes to the cache");
    });
  }

  async finishTransfer(transfer, error, succeeded) {
    if (transfer.finalizing) return transfer.finalizing;
    transfer.finalizing = (async () => {
      let finalError = null;
      try {
        await transfer.writeQueue;
        finalError = transfer.writeError ?? error ?? null;
        if (succeeded && !finalError) {
          await transfer.fileHandle.sync();
          if (transfer.entry.receivedBytes !== transfer.entry.trackSize) {
            finalError = new Error(
              `Soulseek transfer ended at ${transfer.entry.receivedBytes}/${transfer.entry.trackSize} bytes`,
            );
          } else {
            await transfer.fileHandle.close();
            transfer.fileHandle = null;
            await rename(transfer.entry.partialPath, transfer.entry.completePath);
            transfer.entry.complete = true;
            transfer.entry.dataPath = transfer.entry.completePath;
            transfer.entry.lastAccess = Date.now();
            await this.writeMetadata(transfer.entry);
            this.log(
              "STREAM",
              `"${transfer.track.title}" finished: ${this.formatBytes(transfer.entry.receivedBytes)} cached.`,
            );
          }
        }
      } catch (finalizeError) {
        finalError = finalizeError;
        this.log("ERROR", `Could not finalize "${transfer.track.title}": ${finalizeError.message}`);
      } finally {
        transfer.entry.lastError = transfer.entry.complete ? null : finalError;
        transfer.entry.lastTransferStatus = transfer.entry.complete
          ? "completed"
          : transfer.controller.signal.aborted
            ? "cancelled"
            : finalError
              ? "failed"
              : "partial";
        if (transfer.fileHandle) {
          try {
            await transfer.fileHandle.close();
          } catch (closeError) {
            this.log("ERROR", `Could not close partial cache file: ${closeError.message}`);
          }
          transfer.fileHandle = null;
        }
        clearTimeout(transfer.timer);
        clearTimeout(transfer.entry.idleTimer);
        transfer.entry.idleTimer = null;
        if (transfer.entry.activeTransfer === transfer) {
          transfer.entry.activeTransfer = null;
        }
        if (this.activePeerFiles.get(transfer.peerFileKey) === transfer) {
          this.activePeerFiles.delete(transfer.peerFileKey);
        }
        this.activeStreams--;
        this.notify(transfer.entry);
        transfer.resolveReleased();
        this.log("STREAM", `Stream slot released (${this.activeStreams} active).`);
        await this.sweep();
      }
    })();
    return transfer.finalizing;
  }

  async close() {
    const active = [...this.entries.values()]
      .map((entry) => entry.activeTransfer)
      .filter(Boolean);
    for (const transfer of active) {
      transfer.cancel("BitSeekWin is shutting down");
    }
    await Promise.all(active.map((transfer) => transfer.released));
    await this.sweepQueue;
  }

  async getMonitoringSnapshot() {
    await this.initialize();
    let totalBytes = 0;
    let completedFiles = 0;
    let partialFiles = 0;
    const transfers = [];

    for (const entry of this.entries.values()) {
      let fileSize;
      try {
        fileSize = (await stat(entry.dataPath)).size;
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }

      totalBytes += fileSize;
      if (entry.complete) completedFiles++;
      else partialFiles++;

      if (!entry.trackUser || !entry.trackFile) continue;
      let status;
      if (entry.complete) {
        status = "completed";
      } else if (entry.activeTransfer && entry.consumers > 0) {
        status = "streaming";
      } else if (entry.activeTransfer && entry.idleTimer) {
        status = "reconnecting";
      } else if (entry.activeTransfer) {
        status = "downloading";
      } else if (entry.lastTransferStatus === "cancelled") {
        status = "cancelled";
      } else if (entry.lastTransferStatus === "failed") {
        status = "failed";
      } else if (entry.receivedBytes > 0) {
        status = "partial";
      } else {
        status = "idle";
      }
      transfers.push({
        filename: entry.trackFile,
        peer: entry.trackUser,
        title: entry.trackTitle,
        downloadedBytes: fileSize,
        totalBytes: entry.trackSize,
        progress: entry.trackSize > 0
          ? Math.min(fileSize / entry.trackSize, 1)
          : null,
        speedBytesPerSecond: entry.activeTransfer &&
            entry.activeTransfer.lastProgressAt !== null &&
            Date.now() - entry.activeTransfer.lastProgressAt <= 3000
          ? entry.activeTransfer.speedBytesPerSecond
          : null,
        consumers: entry.consumers,
        status,
        active: Boolean(entry.activeTransfer),
        lastAccess: entry.lastAccess,
      });
    }

    const activeTransfers = transfers.filter((transfer) => transfer.active);
    const recentTransfers = transfers
      .filter((transfer) => !transfer.active)
      .sort((left, right) => right.lastAccess - left.lastAccess)
      .slice(0, Math.max(0, 20 - activeTransfers.length));
    return {
      slots: {
        active: this.activeStreams,
        limit: this.maxActiveStreams,
      },
      cache: {
        completedFiles,
        partialFiles,
        bytes: totalBytes,
      },
      transfers: [...activeTransfers, ...recentTransfers].map(
        ({ active, lastAccess, ...transfer }) => transfer,
      ),
    };
  }

  async *readRange(entry, start, end, response, signal) {
    let position = start;
    const fileHandle = await open(entry.dataPath, "r");
    const stopped = () => response.destroyed || signal.aborted;
    const waitForChange = async () => {
      if (stopped()) return;
      let abort;
      const aborted = new Promise((resolve) => {
        abort = resolve;
        signal.addEventListener("abort", abort, { once: true });
        if (stopped()) abort();
      });
      await Promise.race([entry.changed, aborted]);
      signal.removeEventListener("abort", abort);
    };
    try {
      while (position <= end) {
        if (stopped()) return;
        while (
          position >= entry.receivedBytes &&
          !entry.complete &&
          !entry.lastError &&
          !stopped()
        ) {
          await waitForChange();
        }
        if (stopped()) return;
        if (position >= entry.receivedBytes) {
          throw entry.lastError ??
            new Error("Soulseek transfer ended before the requested bytes arrived");
        }
        const available = Math.min(end + 1, entry.receivedBytes) - position;
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, available));
        const { bytesRead } = await fileHandle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (stopped()) return;
        if (bytesRead === 0) {
          await waitForChange();
          continue;
        }
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
      if (start === 0 && end === entry.trackSize - 1) {
        while (!entry.complete && !entry.lastError && !stopped()) {
          await waitForChange();
        }
        if (!entry.complete && !stopped()) {
          throw entry.lastError ??
            new Error("Soulseek transfer did not complete the requested file");
        }
      }
    } finally {
      await fileHandle.close();
    }
  }

  async removeEntry(entry) {
    if (
      entry.consumers > 0 ||
      entry.activeTransfer ||
      entry.evicting ||
      this.entries.get(entry.key) !== entry
    ) {
      return false;
    }
    entry.evicting = true;
    entry.eviction = (async () => {
      try {
        await rm(entry.dataPath, { force: true });
        await rm(entry.metadataPath, { force: true });
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      } catch (error) {
        entry.evicting = false;
        entry.eviction = null;
        throw error;
      }
    })();
    await entry.eviction;
    return true;
  }

  async sweep() {
    const next = this.sweepQueue.then(async () => {
      const now = Date.now();
      let totalBytes = 0;
      const candidates = [];
      for (const entry of this.entries.values()) {
        let info;
        try {
          info = await stat(entry.dataPath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await rm(entry.metadataPath, { force: true });
          this.entries.delete(entry.key);
          continue;
        }
        totalBytes += info.size;
        if (
          entry.consumers === 0 &&
          !entry.activeTransfer &&
          now - entry.lastAccess >= this.ttlMs
        ) {
          if (await this.removeEntry(entry)) totalBytes -= info.size;
        } else if (entry.consumers === 0 && !entry.activeTransfer) {
          candidates.push({ entry, size: info.size });
        }
      }
      candidates.sort((left, right) =>
        left.entry.lastAccess - right.entry.lastAccess
      );
      for (const candidate of candidates) {
        if (totalBytes <= this.maxBytes) break;
        if (
          candidate.entry.consumers > 0 ||
          candidate.entry.activeTransfer ||
          !this.entries.has(candidate.entry.key)
        ) {
          continue;
        }
        await this.removeEntry(candidate.entry);
        totalBytes -= candidate.size;
        this.log(
          "INFO",
          `Evicted ${this.formatBytes(candidate.size)} from the stream cache (LRU).`,
        );
      }
    });
    this.sweepQueue = next.catch((error) => {
      this.log("ERROR", `Could not maintain the stream cache: ${error.message}`);
    });
    await this.sweepQueue;
  }
}
