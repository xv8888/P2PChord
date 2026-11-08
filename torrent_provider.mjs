import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import WebTorrent from "webtorrent";

const MAX_SOURCE_COUNT = 8;
const MAX_TORRENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TORRENT_FILES = 10000;
const MAX_PEER_CONNECTIONS = 20;

export class TorrentProvider {
  constructor({
    logger,
    directory,
    sources = [],
    maxFileBytes,
    maxStorageBytes,
    idleTransferTimeout,
    transferBudget,
    client,
  }) {
    if (!Array.isArray(sources) || sources.length > MAX_SOURCE_COUNT) {
      throw new RangeError(`At most ${MAX_SOURCE_COUNT} torrent sources are allowed.`);
    }
    for (const [name, value] of Object.entries({
      maxFileBytes,
      maxStorageBytes,
      idleTransferTimeout,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive whole number.`);
      }
    }
    if (!transferBudget || typeof transferBudget.acquire !== "function") {
      throw new TypeError("A shared transfer budget is required.");
    }
    this.logger = logger;
    this.directory = resolve(directory);
    this.sources = sources;
    this.maxFileBytes = maxFileBytes;
    this.maxStorageBytes = maxStorageBytes;
    this.idleTransferTimeout = idleTransferTimeout;
    this.transferBudget = transferBudget;
    this.client = client ?? new WebTorrent({
      natUpnp: false,
      natPmp: false,
      uploadLimit: 0,
      webSeeds: false,
      maxConns: MAX_PEER_CONNECTIONS,
      seedOutgoingConnections: false,
      lsd: false,
    });
    this.torrents = new Map();
    this.filesById = new Map();
    this.sourceCount = 0;
    this.totalDeclaredBytes = 0;
    this.initialized = false;
    this.closed = false;
  }

  log(level, message) {
    this.logger(level, String(message).replace(/[\x00-\x1f\x7f]/g, " "));
  }

  async initialize() {
    if (this.initialized) return;
    if (this.closed) throw new Error("Torrent provider is closed.");
    await mkdir(this.directory, { recursive: true });
    this.initialized = true;
    for (const source of this.sources) {
      try {
        await this.addSource(source);
      } catch (error) {
        this.log("WARN", `Could not add configured torrent source: ${error.message}`);
      }
    }
  }

  async addSource(source) {
    if (
      !Buffer.isBuffer(source) &&
      (typeof source !== "string" || !source.trim())
    ) {
      throw new TypeError(
        "Torrent source must be a non-empty magnet URI, .torrent path, or metadata buffer.",
      );
    }
    if (this.sourceCount >= MAX_SOURCE_COUNT) {
      throw new RangeError(`At most ${MAX_SOURCE_COUNT} torrent sources are allowed.`);
    }
    this.sourceCount++;
    try {
      const input = await this.readSource(
        typeof source === "string" ? source.trim() : source,
      );
      const options = {
        path: this.directory,
        addUID: true,
        deselect: true,
        skipVerify: false,
        destroyStoreOnDestroy: false,
        storeCacheSlots: 8,
        uploads: 0,
      };
      const torrent = this.client.add(input, options);
      torrent.once("ready", () => this.registerTorrent(torrent));
      torrent.on("error", (error) => {
        this.log("WARN", `Torrent ${torrent.infoHash || "metadata"} failed: ${error.message}`);
      });
      torrent.on("warning", (error) => {
        this.log("WARN", `Torrent ${torrent.infoHash || "metadata"}: ${error.message}`);
      });
      this.log("INFO", "Added BitTorrent source; waiting for metadata.");
    } catch (error) {
      this.sourceCount--;
      throw error;
    }
  }

  async readSource(source) {
    if (Buffer.isBuffer(source)) {
      if (source.length < 1 || source.length > MAX_TORRENT_FILE_BYTES) {
        throw new RangeError("Torrent metadata must be a file between 1 byte and 2 MiB.");
      }
      return source;
    }
    if (source.toLowerCase().startsWith("magnet:")) {
      let magnet;
      try {
        magnet = new URL(source);
      } catch {
        throw new TypeError("Invalid magnet URI.");
      }
      if (
        magnet.protocol !== "magnet:" ||
        !magnet.searchParams.getAll("xt").some((value) =>
          /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(value),
        )
      ) {
        throw new TypeError("Magnet URI must contain a valid BitTorrent info hash.");
      }
      return source;
    }
    if (!isAbsolute(source) || !source.toLowerCase().endsWith(".torrent")) {
      throw new TypeError("Torrent files must be specified by an absolute .torrent path.");
    }
    const path = resolve(source);
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX_TORRENT_FILE_BYTES) {
      throw new RangeError("Torrent metadata must be a file between 1 byte and 2 MiB.");
    }
    return readFile(path);
  }

  registerTorrent(torrent) {
    if (this.closed) {
      void this.client.remove(torrent, { destroyStore: false });
      return;
    }
    if (this.torrents.has(torrent.infoHash)) return;
    if (
      !Number.isSafeInteger(torrent.length) ||
      torrent.length < 1 ||
      torrent.length > this.maxStorageBytes ||
      this.totalDeclaredBytes + torrent.length > this.maxStorageBytes ||
      torrent.files.length > MAX_TORRENT_FILES
    ) {
      this.log("WARN", `Rejected torrent ${torrent.infoHash}: torrent size or file-count limit exceeded.`);
      void this.client.remove(torrent, { destroyStore: false });
      return;
    }
    const state = {
      torrent,
      files: new Map(),
      bytes: torrent.length,
    };
    this.torrents.set(torrent.infoHash, state);
    this.totalDeclaredBytes += torrent.length;
    for (const [index, file] of torrent.files.entries()) {
      if (
        !Number.isSafeInteger(file.length) ||
        file.length < 4 ||
        file.length > this.maxFileBytes ||
        !isSafeTorrentPath(file.path)
      ) {
        continue;
      }
      const id = createHash("sha256")
        .update(`torrent\0${torrent.infoHash}\0${index}`)
        .digest("hex")
        .slice(0, 24);
      const trackId = `bt-${id}`;
      const entry = {
        id: trackId,
        torrent,
        file,
        index,
        consumers: 0,
        readers: new Set(),
        idleTimer: null,
        releaseSlot: null,
        done: file.done,
        headerValidated: false,
      };
      file.on("done", () => {
        entry.done = true;
        this.releaseTransfer(entry);
      });
      state.files.set(index, entry);
      this.filesById.set(trackId, entry);
    }
    this.log(
      "INFO",
      `Torrent metadata ready for ${safeDisplayName(torrent.name)} ` +
        `(${torrent.infoHash.slice(0, 12)}); ${state.files.size} eligible FLAC files.`,
    );
  }

  search(query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const state of this.torrents.values()) {
      for (const entry of state.files.values()) {
        const file = entry.file.path;
        const normalizedFile = file.toLowerCase();
        if (!terms.every((term) => normalizedFile.includes(term))) continue;
        results.push({
          id: entry.id,
          provider: "torrent",
          infoHash: entry.torrent.infoHash,
          fileIndex: entry.index,
          user: `torrent:${entry.torrent.infoHash.slice(0, 12)}`,
          file,
          size: entry.file.length,
          speed: Number.isFinite(entry.torrent.downloadSpeed)
            ? Math.max(0, entry.torrent.downloadSpeed)
            : 0,
          slots: true,
          queueLength: 0,
          duration: undefined,
        });
      }
    }
    return results;
  }

  hasActiveTrackUse(track) {
    const entry = this.filesById.get(track.id);
    return Boolean(entry && (entry.consumers > 0 || entry.releaseSlot));
  }

  async getEntry(track) {
    const entry = this.filesById.get(track.id);
    if (!entry || entry.torrent.infoHash !== track.infoHash) {
      throw new Error("Torrent result is no longer available.");
    }
    entry.consumers++;
    return entry;
  }

  async touch() {}

  removeConsumer(entry) {
    entry.consumers = Math.max(0, entry.consumers - 1);
  }

  async sweep() {}

  async ensureTransfer(entry) {
    if (entry.done || entry.releaseSlot) return entry;
    entry.releaseSlot = this.transferBudget.acquire();
    entry.file.select(1);
    return entry;
  }

  async *readRange(entry, start, end, response, signal) {
    await this.ensureTransfer(entry);
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    let received = 0;
    try {
      if (!entry.headerValidated) {
        const header = await this.readHeader(entry, signal);
        if (
          header.length !== 4 ||
          (!header.equals(Buffer.from("fLaC")) &&
            !header.subarray(0, 3).equals(Buffer.from("ID3")))
        ) {
          throw new Error("Torrent file does not have a FLAC header.");
        }
        entry.headerValidated = true;
      }
      const reader = Readable.from(entry.file.createReadStream({ start, end }));
      entry.readers.add(reader);
      const abort = () => reader.destroy(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      try {
      for await (const chunk of reader) {
        if (signal?.aborted) return;
        received += chunk.length;
        yield Buffer.from(chunk);
      }
      if (!signal?.aborted && received !== end - start + 1) {
        throw new Error(`Verified torrent range ended at ${received}/${end - start + 1} bytes.`);
      }
      } finally {
        signal?.removeEventListener("abort", abort);
        reader.destroy();
        entry.readers.delete(reader);
      }
    } finally {
      if (!entry.readers.size && !entry.done && entry.releaseSlot) {
        entry.idleTimer = setTimeout(
          () => this.releaseTransfer(entry),
          this.idleTransferTimeout,
        );
        entry.idleTimer.unref();
      }
    }
  }

  async readHeader(entry, signal) {
    const reader = Readable.from(entry.file.createReadStream({ start: 0, end: 3 }));
    entry.readers.add(reader);
    const abort = () => reader.destroy(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of reader) {
        const part = Buffer.from(chunk).subarray(0, 4 - length);
        chunks.push(part);
        length += part.length;
        if (length === 4) break;
      }
      return Buffer.concat(chunks, length);
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.destroy();
      entry.readers.delete(reader);
    }
  }

  releaseTransfer(entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    entry.file.deselect();
    entry.releaseSlot?.();
    entry.releaseSlot = null;
  }

  getMonitoringSnapshot() {
    return {
      enabled: true,
      transferSlots: this.transferBudget.getSnapshot(),
      torrents: [...this.torrents.values()].map(({ torrent, files }) => ({
        name: safeDisplayName(torrent.name),
        infoHash: torrent.infoHash.slice(0, 12),
        peers: torrent.numPeers,
        downloadedBytes: torrent.downloaded,
        totalBytes: torrent.length,
        files: files.size,
      })),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.torrents.values()) {
      for (const entry of state.files.values()) {
        clearTimeout(entry.idleTimer);
        for (const reader of entry.readers) reader.destroy();
        entry.readers.clear();
        this.releaseTransfer(entry);
      }
    }
    await new Promise((resolve, reject) => {
      this.client.destroy((error) => error ? reject(error) : resolve());
    });
  }
}

function isSafeTorrentPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /[\x00-\x1f\x7f]/.test(value) ||
    /^[\\/]|^[a-z]:/i.test(value)
  ) {
    return false;
  }
  const segments = value.replaceAll("\\", "/").split("/");
  return (
    segments.every((segment) => segment && segment !== "." && segment !== "..") &&
    /\.flac$/i.test(segments.at(-1))
  );
}

function safeDisplayName(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120);
}
