import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createAddonServer } from "./direct_server.mjs";

const KIB = 1024;
const MIB = 1024 * KIB;
const CHUNK_SIZES = [64, 128, 256, 512].map((size) => size * KIB);
const BATCH_SIZES = [64, 128, 256, 512].map((size) => size * KIB);
const BATCH_DELAY_MS = 1;
const DATA_BYTES = Number(process.env.BITSEEKWIN_BENCH_MIB ?? 4) * MIB;
const REPEATS = Number(process.env.BITSEEKWIN_BENCH_REPEATS ?? 3);
const TARGETED = process.env.BITSEEKWIN_BENCH_TARGETED === "true";
if (!Number.isSafeInteger(DATA_BYTES) || DATA_BYTES < MIB || DATA_BYTES > 128 * MIB) {
  throw new RangeError("BITSEEKWIN_BENCH_MIB must be a whole number from 1 to 128.");
}
if (!Number.isSafeInteger(REPEATS) || REPEATS < 1 || REPEATS > 10) {
  throw new RangeError("BITSEEKWIN_BENCH_REPEATS must be a whole number from 1 to 10.");
}
const DATA = Buffer.alloc(DATA_BYTES, 0x53);
const DATA_HASH = createHash("sha256").update(DATA).digest("hex");

function get(url) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });
}

class BenchmarkDownload extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.chunks = [];
    this.settled = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.promise.catch(() => {});
    this.onAbort = () => this.fail(new Error("Benchmark transfer cancelled"));
    options.signal.addEventListener("abort", this.onAbort, { once: true });
    setImmediate(() => this.pump(options.offset ?? 0));
  }

  emitChunk(position) {
    const end = Math.min(position + this.options.chunkBytes, DATA.length);
    const chunk = Buffer.from(DATA.subarray(position, end));
    this.chunks.push(chunk);
    this.emit("data", chunk);
    return end;
  }

  finish() {
    if (this.settled) return;
    this.settled = true;
    this.options.signal.removeEventListener("abort", this.onAbort);
    const buffer = Buffer.concat(this.chunks);
    this.resolve({
      buffer,
      path: this.options.path,
      receivedBytes: this.options.offset + buffer.length,
      size: DATA.length,
    });
    this.emit("status", "complete");
    this.emit("complete", { receivedBytes: this.options.offset + buffer.length });
  }

  pump(position) {
    if (this.settled) return;
    if (this.options.chunkIntervalMs > 0) {
      if (position >= DATA.length) {
        this.finish();
        return;
      }
      const next = this.emitChunk(position);
      setTimeout(
        () => this.pump(next),
        this.options.chunkIntervalMs,
      );
      return;
    }

    let emitted = 0;
    while (position < DATA.length && emitted < 16) {
      position = this.emitChunk(position);
      emitted++;
    }

    if (position < DATA.length) {
      setImmediate(() => this.pump(position));
      return;
    }

    this.finish();
  }

  fail(error) {
    if (this.settled) return;
    this.settled = true;
    this.options.signal.removeEventListener("abort", this.onAbort);
    this.emit("failed", error);
    this.reject(error);
  }

  then(onFulfilled, onRejected) {
    return this.promise.then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.promise.catch(onRejected);
  }

  finally(onFinally) {
    return this.promise.finally(onFinally);
  }
}

async function requestTrack(base, query) {
  const response = await get(`${base}/search?q=${encodeURIComponent(query)}`);
  assert.equal(response.statusCode, 200);
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const { tracks } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(tracks.length, 1);
  return tracks[0].id;
}

async function readTrack(base, id, startedAt) {
  const response = await get(`${base}/file/${id}`);
  assert.equal(response.statusCode, 200);
  const hash = createHash("sha256");
  let firstByteMs = null;
  let bytes = 0;

  for await (const value of response) {
    firstByteMs ??= performance.now() - startedAt;
    bytes += value.byteLength;
    hash.update(value);
  }

  assert.equal(bytes, DATA_BYTES);
  assert.equal(hash.digest("hex"), DATA_HASH);
  return { firstByteMs, bytes };
}

async function runCase({
  chunkBytes,
  batchBytes,
  delayMs,
  chunkIntervalMs,
  concurrency,
}) {
  global.gc?.();
  const cacheDirectory = await mkdtemp(join(tmpdir(), "bitseekwin-bench-"));
  const client = {
    async search({ req }) {
      return [{
        user: `benchmark-${req}`,
        file: `Benchmark\\${req}.flac`,
        size: DATA_BYTES,
        speed: 1_000_000,
        slots: 2,
        queueLength: 0,
        attribs: {},
      }];
    },
    download(options) {
      return new BenchmarkDownload({
        ...options,
        chunkBytes,
        chunkIntervalMs,
      });
    },
  };
  const { server, streamCache } = createAddonServer({
    client,
    secret: "benchmark-secret",
    slug: "bitseekwin",
    publicBaseUrl: "http://127.0.0.1",
    cacheDirectory,
    maxStreamBytes: DATA_BYTES,
    maxActiveStreams: 2,
    writeBatchBytes: batchBytes,
    writeBatchDelayMs: delayMs,
    logger: () => {},
  });

  let sampler;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object" && address.port > 0);
    const base =
      `http://127.0.0.1:${address.port}/bitseekwin/benchmark-secret`;
    const ids = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        requestTrack(base, `track-${index}`),
      ),
    );
    const cpuStart = process.cpuUsage();
    const memoryStart = process.memoryUsage();
    let peakRss = memoryStart.rss;
    let peakExternal = memoryStart.external;
    sampler = setInterval(() => {
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakExternal = Math.max(peakExternal, memory.external);
    }, 2);

    const startedAt = performance.now();
    const streams = await Promise.all(
      ids.map((id) => readTrack(base, id, startedAt)),
    );
    const elapsedMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuStart);
    clearInterval(sampler);
    sampler = null;

    return {
      chunkKiB: chunkBytes / KIB,
      batchKiB: batchBytes === 1 ? 0 : batchBytes / KIB,
      delayMs,
      peerIntervalMs: chunkIntervalMs,
      concurrency,
      firstByteMs: streams.reduce((sum, stream) => sum + stream.firstByteMs, 0) /
        streams.length,
      throughputMiBps: (DATA_BYTES * concurrency / MIB) / (elapsedMs / 1000),
      writeOperations: streamCache.diskWriteOperations,
      peakRssMiB: (peakRss - memoryStart.rss) / MIB,
      peakExternalMiB: (peakExternal - memoryStart.external) / MIB,
      cpuPercent: ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100,
      httpLatencyMs: elapsedMs,
    };
  } finally {
    clearInterval(sampler);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await streamCache.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

function formatRow(row) {
  return [
    row.chunkKiB,
    row.batchKiB === 0 ? "per chunk" : row.batchKiB,
    row.delayMs,
    row.peerIntervalMs,
    row.concurrency,
    row.firstByteMs.toFixed(1),
    row.throughputMiBps.toFixed(1),
    row.writeOperations,
    row.peakRssMiB.toFixed(1),
    row.peakExternalMiB.toFixed(1),
    row.cpuPercent.toFixed(1),
    row.httpLatencyMs.toFixed(1),
  ].join("\t");
}

const cases = [];
if (TARGETED) {
  for (const chunkBytes of CHUNK_SIZES) {
    cases.push({
      chunkBytes,
      batchBytes: 1,
      delayMs: 0,
      chunkIntervalMs: 0,
    });
    cases.push({
      chunkBytes,
      batchBytes: 128 * KIB,
      delayMs: BATCH_DELAY_MS,
      chunkIntervalMs: 0,
    });
  }
} else {
  for (const chunkBytes of CHUNK_SIZES) {
    cases.push({
      chunkBytes,
      batchBytes: 1,
      delayMs: 0,
      chunkIntervalMs: 0,
    });
    for (const batchBytes of BATCH_SIZES) {
      cases.push({
        chunkBytes,
        batchBytes,
        delayMs: BATCH_DELAY_MS,
        chunkIntervalMs: 0,
      });
    }
  }
  cases.push({
    chunkBytes: 64 * KIB,
    batchBytes: 1,
    delayMs: 0,
    chunkIntervalMs: 1,
  });
  for (const delayMs of [1, 4, 8]) {
    for (const batchBytes of [128, 256, 512].map((size) => size * KIB)) {
      cases.push({
        chunkBytes: 64 * KIB,
        batchBytes,
        delayMs,
        chunkIntervalMs: 1,
      });
    }
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

console.log(
  `Test file size: ${DATA_BYTES / MIB} MiB; repeats: ${REPEATS}; ` +
  "fixed byte pattern; verified SHA-256.",
);
console.log("Synthetic local peer; measurements cover the HTTP/cache path, not Soulseek or WAN speed.");
console.log(
  "chunkKiB\tbatchKiB\tdelayMs\tpeerIntervalMs\ttransfers\tTTFBms\tMiB/s\twriteOps\tpeakRSS+MiB\tpeakExternal+MiB\tCPU%\tHTTPms",
);
for (const testCase of cases) {
  for (const concurrency of [1, 2]) {
    const results = [];
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      results.push(await runCase({ ...testCase, concurrency }));
    }
    const summary = Object.fromEntries(
      Object.keys(results[0]).map((key) => [
        key,
        typeof results[0][key] === "number"
          ? median(results.map((result) => result[key]))
          : results[0][key],
      ]),
    );
    console.log(formatRow(summary));
  }
}
