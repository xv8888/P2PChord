import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { performance } from "node:perf_hooks";
import { FileAttribute } from "slsk-client";
import {
  createAddonServer,
  generateSourceSecret,
  matchScore,
  normalizeSearchQuery,
} from "./direct_server.mjs";
import { writeBuffersAt } from "./stream_cache.mjs";

const sourceWords = JSON.parse(
  readFileSync(new URL("./source_words.json", import.meta.url), "utf8"),
);
const serverSource = readFileSync(new URL("./direct_server.mjs", import.meta.url), "utf8");
const testSecret = "exquisite-uncle-AAECAwQFBgcICQoLDA0ODw";
const textEncoder = new TextEncoder();

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function createBitChordCredentials(host) {
  const signingPair = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const devicePair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const signingJwk = await webcrypto.subtle.exportKey("jwk", signingPair.publicKey);
  signingJwk.kid = "test-key";
  const deviceJwk = await webcrypto.subtle.exportKey("jwk", devicePair.publicKey);
  const now = Date.now();
  const header = base64Url(JSON.stringify({ alg: "EdDSA", kid: signingJwk.kid }));
  const claims = base64Url(JSON.stringify({
    iss: "https://bitchord-auth.kushagrasingh.in",
    aud: "bitchord-addons",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
    cnf: { jwk: deviceJwk },
  }));
  const signingInput = `${header}.${claims}`;
  const jwtSignature = await webcrypto.subtle.sign(
    "Ed25519",
    signingPair.privateKey,
    textEncoder.encode(signingInput),
  );
  const token = `${signingInput}.${base64Url(jwtSignature)}`;
  const timestamp = String(now);
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  const proofSignature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    devicePair.privateKey,
    textEncoder.encode(
      `bitchord-addon-proof/v1\n${host}\n${timestamp}\n${tokenHash}`,
    ),
  );
  return {
    headers: {
      "X-BitChord-Token": token,
      "X-BitChord-Proof": `v1.${timestamp}.${base64Url(proofSignature)}`,
    },
    bitChordAuthOptions: {
      fetch: async () => Response.json({ keys: [signingJwk] }),
    },
  };
}

class FakeDownload extends EventEmitter {
  constructor(options, chunks, delay = 0) {
    super();
    this.options = options;
    this.stream = new PassThrough();
    this.stream.on("error", () => {});
    this.isSettled = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.promise.catch(() => {});
    this.onAbort = () =>
      this.cancel(options.signal.reason?.message ?? "aborted");
    if (options.signal.aborted) queueMicrotask(this.onAbort);
    else options.signal.addEventListener("abort", this.onAbort, { once: true });
    let elapsed = 0;
    for (const chunk of chunks) {
      elapsed += delay;
      setTimeout(() => {
        if (!this.isSettled) {
          this.stream.write(chunk);
          this.emit("data", chunk);
        }
      }, elapsed);
    }
    setTimeout(() => {
      if (this.isSettled) return;
      this.isSettled = true;
      options.signal.removeEventListener("abort", this.onAbort);
      this.stream.end();
      this.resolve({ receivedBytes: options.offset + chunks.reduce((n, c) => n + c.length, 0) });
      this.emit("status", "complete");
      this.emit("complete");
    }, elapsed + delay);
  }

  cancel(reason) {
    if (this.isSettled) return false;
    this.isSettled = true;
    this.options.signal.removeEventListener("abort", this.onAbort);
    const error = new Error(reason);
    this.stream.destroy(error);
    this.emit("status", "cancelled");
    this.emit("failed", error);
    this.reject(error);
    return true;
  }

  fail(error) {
    if (this.isSettled) return false;
    this.isSettled = true;
    this.options.signal.removeEventListener("abort", this.onAbort);
    this.stream.destroy(error);
    this.emit("status", "failed");
    this.emit("failed", error);
    this.reject(error);
    return true;
  }

  then(...args) {
    return this.promise.then(...args);
  }

  catch(...args) {
    return this.promise.catch(...args);
  }

  finally(...args) {
    return this.promise.finally(...args);
  }
}

const track = {
  user: "sample-owner",
  file: "Drum Kit\\Kick One.flac",
  size: 10,
  slots: true,
  attribs: {},
  speed: 1000,
};

test("source URLs use adjective words followed by a noun and a 128-bit token", () => {
  const entropy = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
  const phraseEntropy = Buffer.from([
    0, 0, 0, 0,
    0, 3, 0, 0,
    0, 6, 0, 0,
    ...Array(20).fill(0),
  ]);
  const secret = generateSourceSecret(entropy, 3, 6, phraseEntropy);
  const parts = secret.split("-");
  assert.deepEqual(parts.slice(0, -1).map((word) => word.length), [3, 6, 9]);
  assert.ok(sourceWords.adjectives["3"].includes(parts[0]));
  assert.ok(sourceWords.adjectives["6"].includes(parts[1]));
  assert.ok(sourceWords.nouns["9"].includes(parts[2]));
  assert.equal(parts.at(-1), "AAECAwQFBgcICQoLDA0ODw");
  assert.equal(generateSourceSecret().split("-").length, 3);
});

test("each word varies by up to three letters from the target", () => {
  const entropy = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
  const phraseEntropy = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  for (let wordCount = 2; wordCount <= 8; wordCount++) {
    for (let wordLength = 3; wordLength <= 9; wordLength++) {
      const parts = generateSourceSecret(
        entropy,
        wordCount,
        wordLength,
        phraseEntropy,
      ).split("-");
      assert.equal(parts.length, wordCount + 1);
      const low = Math.max(3, wordLength - 3);
      const high = Math.min(9, wordLength + 3);
      assert.ok(parts.slice(0, -1).every((word) => word.length >= low && word.length <= high));
      assert.ok(
        parts.slice(0, -2).every((word) =>
          sourceWords.adjectives[String(word.length)].includes(word),
        ),
      );
      assert.ok(sourceWords.nouns[String(parts.at(-2).length)].includes(parts.at(-2)));
      assert.match(parts.at(-1), /^[A-Za-z0-9_~]{22}$/);
    }
  }
});

test("word-length variance clamps to the available dictionary at boundaries", () => {
  const tokenEntropy = Buffer.alloc(16);
  const phraseEntropy = Buffer.alloc(32, 255);
  for (const [target, low, high] of [[3, 3, 6], [9, 6, 9]]) {
    const words = generateSourceSecret(
      tokenEntropy,
      8,
      target,
      phraseEntropy,
    ).split("-").slice(0, -1);
    assert.ok(words.every((word) => word.length >= low && word.length <= high));
  }
});

test("source word dictionaries are expanded tenfold and stay length-consistent", () => {
  assert.equal(
    Object.values(sourceWords.adjectives).flat().length,
    710,
  );
  assert.equal(Object.values(sourceWords.nouns).flat().length, 650);
  for (const [kind, groups] of Object.entries(sourceWords)) {
    for (const [length, words] of Object.entries(groups)) {
      assert.ok(words.every((word) => word.length === Number(length)));
      assert.equal(new Set(words).size, words.length, `${kind} ${length}-letter words`);
    }
  }
});

test("source URL generation rejects unsupported word settings", () => {
  const entropy = Buffer.alloc(16);
  assert.throws(() => generateSourceSecret(entropy, 1, 6), /word count/);
  assert.throws(() => generateSourceSecret(entropy, 9, 6), /word count/);
  assert.throws(() => generateSourceSecret(entropy, 3, 2), /word length/);
  assert.throws(() => generateSourceSecret(entropy, 3, 10), /word length/);
});

let server;
let streamCache;
let base;
let client;
let downloads;
let logEntries;
let idleTransferTimeout;
let cacheDirectory;
let trackADelay;
let transferDelay;
let monitorConnectionStatus;

async function startServer(options = {}) {
  const secret = options.secret ?? "test-secret";
  ({ server, streamCache } = createAddonServer({
    client,
    secret,
    slug: "p2pchord",
    publicBaseUrl: "https://music.example.test",
    getConnectionStatus: () => monitorConnectionStatus,
    logger: (level, message) => logEntries.push({ level, message }),
    idleTransferTimeout,
    cacheDirectory,
    validateFlac: false,
    ...options,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/p2pchord/${secret}`;
}

async function stopServer() {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
}

beforeEach(async () => {
  downloads = [];
  logEntries = [];
  idleTransferTimeout = 30_000;
  monitorConnectionStatus = "connected";
  trackADelay = 200;
  transferDelay = 80;
  cacheDirectory = await mkdtemp(join(tmpdir(), "p2pchord-test-cache-"));
  client = {
    async search(options) {
      this.lastSearch = options;
      return [
        track,
        track,
        { ...track, file: "../unsafe.flac" },
        { ...track, file: "not-lossless.mp3" },
      ];
    },
    download(options) {
      const full = Buffer.from("0123456789");
      const download = new FakeDownload(
        options,
        [
          full.subarray(options.offset, Math.min(4, full.length)),
          full.subarray(Math.max(options.offset, 4)),
        ].filter((chunk) => chunk.length > 0),
        options.file.includes("Track A") ? trackADelay : transferDelay,
      );
      downloads.push(download);
      return download;
    },
  };
  await startServer();
});

afterEach(async () => {
  await stopServer();
  await rm(cacheDirectory, { recursive: true, force: true });
});

async function searchTrack(query = "kick") {
  const tracks = await searchTracks(query);
  assert.equal(tracks.length, 1);
  return tracks[0].id;
}

async function searchTracks(query = "kick") {
  const response = await fetch(`${base}/search?q=${encodeURIComponent(query)}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.tracks;
}

test("manifest and search expose only safe FLAC results", async () => {
  await stopServer();
  await startServer({ secret: testSecret });
  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  assert.equal(manifest.version, "alpha-0.1.2");
  assert.equal(manifest.name, "P2PChord [exquisite-uncle]");
  assert.match(manifest.description, /directly from Soulseek peers/);
  assert.equal(manifest.allowDownloads, false);
  assert.equal("bitchordAuth" in manifest, false);
  const response = await fetch(`${base}/search?q=kick`);
  const body = await response.json();
  assert.equal(body.tracks.length, 1);
  assert.equal(body.tracks[0].format, "flac");
  assert.equal(body.tracks[0].audioQuality, "LOSSLESS");
  assert.equal(body.tracks[0].artist, "");
  assert.equal("duration" in body.tracks[0], false);
  assert.equal(client.lastSearch.req, "kick");
  assert.equal(client.lastSearch.timeout, 2000);
});

test("opt-in BitChord auth protects add-on APIs and signs range-capable media URLs", async () => {
  await stopServer();
  const credentials = await createBitChordCredentials("music.example.test");
  await startServer({
    requireBitChordAuth: true,
    bitChordAuthOptions: credentials.bitChordAuthOptions,
  });

  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  assert.equal(manifest.bitchordAuth, true);

  const denied = await fetch(`${base}/search?q=kick`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /^BitChord realm=/);
  assert.equal((await denied.json()).code, "missing");

  const [proofVersion, proofTimestamp, proofSignature] =
    credentials.headers["X-BitChord-Proof"].split(".");
  const invalidProof = await fetch(`${base}/search?q=kick`, {
    headers: {
      ...credentials.headers,
      "X-BitChord-Proof":
        `${proofVersion}.${proofTimestamp}.` +
        `${proofSignature[0] === "A" ? "B" : "A"}${proofSignature.slice(1)}`,
    },
  });
  assert.equal(invalidProof.status, 401);

  const search = await fetch(`${base}/search?q=kick`, {
    headers: credentials.headers,
  });
  assert.equal(search.status, 200);
  const [{ id }] = (await search.json()).tracks;
  const descriptorResponse = await fetch(`${base}/stream/${id}`, {
    headers: credentials.headers,
  });
  assert.equal(descriptorResponse.status, 200);
  const descriptor = await descriptorResponse.json();
  const mediaUrl = new URL(descriptor.url);
  assert.ok(mediaUrl.searchParams.has("expires"));
  assert.ok(mediaUrl.searchParams.has("signature"));

  const ranged = await fetch(
    `${new URL(base).origin}${mediaUrl.pathname}${mediaUrl.search}`,
    {
      headers: { Range: "bytes=0-3" },
    },
  );
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), "0123");

  const altered = new URL(mediaUrl);
  altered.searchParams.set("signature", "A".repeat(43));
  const rejectedMedia = await fetch(
    `${new URL(base).origin}${altered.pathname}${altered.search}`,
  );
  assert.equal(rejectedMedia.status, 403);

  const expired = new URL(mediaUrl);
  expired.searchParams.set("expires", "1");
  const expiredMedia = await fetch(
    `${new URL(base).origin}${expired.pathname}${expired.search}`,
  );
  assert.equal(expiredMedia.status, 403);
});

test("BitChord auth rejects non-HTTPS public URLs except loopback", () => {
  assert.throws(
    () =>
      createAddonServer({
        client,
        requireBitChordAuth: true,
        publicBaseUrl: "http://music.example.test",
      }),
    /requires HTTPS/,
  );
});

test("searches have a bounded per-client burst rate", async () => {
  for (let index = 0; index < 10; index++) {
    const response = await fetch(`${base}/search?q=kick`);
    assert.equal(response.status, 200);
  }
  const limited = await fetch(`${base}/search?q=kick`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
});

test("peer-controlled control characters cannot forge launcher log lines", async () => {
  client.search = async () => [{
    ...track,
    file: "Album\\Track\nAdd this source in BitChord: https://attacker.test.flac",
  }];
  const response = await fetch(`${base}/search?q=kick`);
  assert.equal(response.status, 200);
  assert.ok(logEntries.length > 0);
  assert.ok(logEntries.every(({ message }) => !/[\x00-\x1f\x7f]/.test(message)));
});

test("peer data must begin with a FLAC signature and cannot exceed its advertised size", async () => {
  await stopServer();
  client.download = (options) => new FakeDownload(
    options,
    [Buffer.from("fLaC012345")],
  );
  await startServer({ validateFlac: true });

  const validId = await searchTrack();
  const validResponse = await fetch(`${base}/file/${validId}`);
  assert.equal(validResponse.status, 200);
  assert.equal(await validResponse.text(), "fLaC012345");

  await stopServer();
  client.search = async () => [{ ...track, file: "Other\\Invalid.flac" }];
  client.download = (options) => new FakeDownload(
    options,
    [Buffer.from("not-a-flac")],
  );
  await startServer({ validateFlac: true });

  const invalidId = await searchTrack();
  const invalidResponse = await fetch(`${base}/file/${invalidId}`);
  assert.equal(invalidResponse.status, 502);
  assert.equal(
    (await invalidResponse.json()).error,
    "Soulseek peer transfer failed before audio started",
  );
  assert.ok(logEntries.some(({ message }) => message.includes("FLAC file header")));

  await stopServer();
  client.search = async () => [{ ...track, file: "Other\\Oversized.flac" }];
  client.download = (options) => new FakeDownload(
    options,
    [Buffer.from("fLaC"), Buffer.from("012345EXTRA")],
  );
  await startServer({ validateFlac: true });

  const oversizedId = await searchTrack();
  const oversizedResponse = await fetch(`${base}/file/${oversizedId}`);
  if (oversizedResponse.status === 200) {
    await assert.rejects(() => oversizedResponse.arrayBuffer());
  } else {
    assert.equal(oversizedResponse.status, 502);
    assert.equal(
      (await oversizedResponse.json()).error,
      "Soulseek peer transfer failed before audio started",
    );
  }
  assert.ok(logEntries.some(({ message }) =>
    message.includes("more data than the advertised file size"),
  ));
  const oversizedCacheKey = createHash("sha256")
    .update(`${track.user}\0Other\\Oversized.flac\0${track.size}`)
    .digest("hex");
  assert.ok(
    streamCache.entries.get(oversizedCacheKey).receivedBytes <= track.size,
  );
});

test("monitoring reports live connection, transfer and cache state without implying playback", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "0123");

  const active = await (await fetch(`${base}/monitoring`)).json();
  assert.equal(active.connection, "connected");
  assert.deepEqual(active.slots, { active: 1, limit: 2 });
  assert.equal(active.cache.completedFiles, 0);
  assert.equal(active.cache.partialFiles, 1);
  assert.ok(active.cache.bytes >= 4);
  assert.equal(active.transfers.length, 1);
  assert.equal(active.transfers[0].filename, track.file);
  assert.equal(active.transfers[0].peer, track.user);
  assert.equal(active.transfers[0].status, "streaming");
  assert.equal(active.transfers[0].consumers, 1);

  await reader.cancel();
  let reconnecting;
  for (let attempt = 0; attempt < 20; attempt++) {
    reconnecting = await (await fetch(`${base}/monitoring`)).json();
    if (reconnecting.transfers[0]?.status === "reconnecting") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(reconnecting.transfers[0].status, "reconnecting");
  assert.equal(reconnecting.transfers[0].consumers, 0);
  assert.equal(reconnecting.slots.active, 1);

  monitorConnectionStatus = "disconnected";
  const disconnected = await (await fetch(`${base}/monitoring`)).json();
  assert.equal(disconnected.connection, "disconnected");
  assert.equal(downloads[0].options.signal.aborted, false);
});

test("manifest-enabled BitChord download handoff reaches the file URL", async () => {
  await stopServer();
  await startServer({ allowDownloads: true });

  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  assert.equal(manifest.allowDownloads, true);

  const id = await searchTrack();
  const descriptor = await (await fetch(`${base}/stream/${id}`)).json();
  assert.equal(descriptor.format, "flac");

  const mediaUrl = new URL(descriptor.url);
  assert.equal(mediaUrl.pathname, new URL(`${base}/file/${id}`).pathname);
  const response = await fetch(`${new URL(base).origin}${mediaUrl.pathname}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/flac");
  assert.equal(await response.text(), "0123456789");
});

test("match-first search ranks the closest FLAC candidates first", async () => {
  client.search = async () => [
    {
      ...track,
      user: "remix-owner",
      file: "Album\\Kick Song Remix.flac",
      speed: 1500,
    },
    {
      ...track,
      user: "matching-owner",
      file: "Album\\Kick Song.flac",
      speed: 1000,
      attribs: { [FileAttribute.Duration]: 214 },
    },
    {
      ...track,
      user: "second-owner",
      file: "Album\\Kick Song.flac",
      speed: 900,
    },
  ];
  const response = await fetch(`${base}/search?q=kick%20song`);
  const body = await response.json();
  assert.equal(body.tracks.length, 3);
  assert.equal(body.tracks[0].title, "Kick Song");
  assert.equal(body.tracks[0].artist, "");
  assert.equal(
    body.tracks.find((candidate) => candidate.duration === 214)?.title,
    "Kick Song",
  );
  assert.equal(matchScore("kick song", "Album\\Kick Song.flac"), 1);
  assert.ok(
    matchScore("kick song", "Kick Song.flac") >
      matchScore("kick song", "Kick Song Remix.flac"),
  );
  assert.ok(logEntries.some(({ message }) =>
    /returning 3 ranked candidates/.test(message),
  ));
});

test("fastest-speed selection streams only from the highest reported-speed peer", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
  await startServer({ sourceSelection: "speed" });
  client.search = async () => [
    {
      ...track,
      user: "fast-owner",
      file: "Album\\Kick Song Remix.flac",
      speed: 9000,
    },
    {
      ...track,
      user: "matching-owner",
      file: "Album\\Kick Song.flac",
      speed: 1000,
    },
  ];

  const response = await fetch(`${base}/search?q=kick%20song`);
  const body = await response.json();
  assert.equal(body.tracks.length, 1);
  assert.equal(body.tracks[0].title, "Kick Song Remix");
  assert.ok(logEntries.some(({ message }) =>
    message.includes('selected the fastest reported uploader "fast-owner" at reported speed 9000'),
  ));
  await fetch(`${base}/stream/${body.tracks[0].id}`);
  const fileResponse = await fetch(`${base}/file/${body.tracks[0].id}`);
  assert.equal(fileResponse.status, 200);
  assert.equal(downloads[0].options.user, "fast-owner");
  await fileResponse.text();
});

test("source selection rejects unsupported modes", () => {
  assert.throws(
    () => createAddonServer({ client, sourceSelection: "unknown" }),
    /sourceSelection must be 'match' or 'speed'/,
  );
});

test("search limits, timeout, and optional spelling recovery are configurable", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
  await startServer({
    searchLimit: 1,
    searchTimeout: 6000,
    searchRecovery: false,
  });
  const searchCalls = [];
  client.search = async ({ req, timeout }) => {
    searchCalls.push({ req, timeout });
    if (req === "kick") {
      return [
        { ...track, file: "Album\\Kick One.flac", speed: 500 },
        { ...track, user: "second-owner", file: "Album\\Kick Two.flac", speed: 100 },
      ];
    }
    return [];
  };

  const matches = await fetch(`${base}/search?q=kick`);
  assert.equal((await matches.json()).tracks.length, 1);
  const empty = await fetch(`${base}/search?q=bnd%20dmon`);
  assert.equal((await empty.json()).tracks.length, 0);
  assert.deepEqual(searchCalls, [
    { req: "kick", timeout: 6000 },
    { req: "bnd dmon", timeout: 6000 },
  ]);
});

test("transfer slot and track-size settings cannot exceed current safety caps", () => {
  assert.throws(
    () => createAddonServer({ client, maxActiveStreams: 3 }),
    /maxActiveStreams must be between 1 and 2/,
  );
  assert.throws(
    () => createAddonServer({ client, maxStreamBytes: 129 * 1024 * 1024 }),
    /maxStreamBytes must be between 1 and 134217728 bytes/,
  );
});

test("stream write batching settings reject invalid values", () => {
  assert.throws(
    () => createAddonServer({ client, writeBatchBytes: 0 }),
    /writeBatchBytes must be a positive whole number/,
  );
  assert.throws(
    () => createAddonServer({ client, writeBatchDelayMs: -1 }),
    /writeBatchDelayMs must be a non-negative whole number/,
  );
});

test("partial writev results resume at the exact next byte", async () => {
  const path = join(cacheDirectory, "partial-writev-test.bin");
  const fileHandle = await open(path, "w+");
  const prototype = Object.getPrototypeOf(fileHandle);
  const originalWritev = prototype.writev;
  let writeCalls = 0;
  let largestWritev = 0;
  prototype.writev = async function (buffers, position) {
    writeCalls++;
    largestWritev = Math.max(largestWritev, buffers.length);
    if (writeCalls === 1) {
      return originalWritev.call(
        this,
        [buffers[0], buffers[1].subarray(0, 2)],
        position,
      );
    }
    return originalWritev.call(this, buffers, position);
  };

  try {
    const chunks = [
      Buffer.from("abc"),
      Buffer.from("defgh"),
      Buffer.from("ijk"),
    ];
    await writeBuffersAt(fileHandle, chunks, 0, 11, () => {});
    const result = Buffer.alloc(11);
    const { bytesRead } = await fileHandle.read(result, 0, result.length, 0);
    assert.equal(bytesRead, 11);
    assert.equal(result.toString(), "abcdefghijk");
    assert.equal(writeCalls, 2);

    const manyChunks = Array.from({ length: 1100 }, () => Buffer.from("x"));
    await writeBuffersAt(fileHandle, manyChunks, 11, manyChunks.length, () => {});
    assert.equal(largestWritev, 1024);
    const manyResult = Buffer.alloc(manyChunks.length);
    const manyRead = await fileHandle.read(
      manyResult,
      0,
      manyResult.length,
      11,
    );
    assert.equal(manyRead.bytesRead, manyChunks.length);
    assert.deepEqual(manyResult, Buffer.alloc(manyChunks.length, "x"));
  } finally {
    prototype.writev = originalWritev;
    await fileHandle.close();
  }
});

test("cache write failures fail the transfer and never promote partial data", async () => {
  const id = await searchTrack();
  const probe = await open(join(cacheDirectory, "write-failure-probe.bin"), "w+");
  const prototype = Object.getPrototypeOf(probe);
  const originalWrite = prototype.write;
  await probe.close();
  prototype.write = async () => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };

  try {
    const response = await fetch(`${base}/file/${id}`);
    assert.equal(response.status, 502);
    await response.arrayBuffer();
  } finally {
    prototype.write = originalWrite;
  }

  const snapshot = await (await fetch(`${base}/monitoring`)).json();
  assert.equal(snapshot.slots.active, 0);
  assert.equal(snapshot.cache.completedFiles, 0);
  assert.equal(snapshot.transfers[0].status, "failed");
  assert.ok(logEntries.some(({ level, message }) =>
    level === "ERROR" &&
      message.includes("Could not persist Soulseek result") &&
      message.includes("disk full"),
  ));
});

test("unicode search queries are folded before searching Soulseek", async () => {
  const response = await fetch(
    `${base}/search?q=${encodeURIComponent("Bad bënd / DëMON by yeat")}`,
  );
  assert.equal(response.status, 200);
  assert.equal(client.lastSearch.req, "bad bend demon by yeat");
  assert.equal(normalizeSearchQuery("Æther, cœur & straße"), "aether coeur strasse");
  assert.equal(matchScore("DëMON", "Demon.flac"), 1);
});

test("search retries likely missing vowels after an accent-stripped query misses", async () => {
  const queries = [];
  client.search = async ({ req, timeout }) => {
    queries.push(req);
    assert.equal(timeout, 2000);
    if (req === "bad bend demon yeat") {
      return [{ ...track, file: "Bad Bend Demon.flac" }];
    }
    return [];
  };
  const response = await fetch(
    `${base}/search?q=${encodeURIComponent("bad bnd dmon yeat")}`,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(queries, ["bad bnd dmon yeat", "bad bend demon yeat"]);
  assert.equal(body.tracks.length, 1);
  assert.equal(body.tracks[0].title, "Bad Bend Demon");
  assert.ok(logEntries.some(({ message }) =>
    message.includes('retrying with likely missing vowels as "bad bend demon yeat"'),
  ));
});

test("ordinary consonant pairs do not trigger spelling-recovery searches", async () => {
  const queries = [];
  client.search = async ({ req }) => {
    queries.push(req);
    return [];
  };
  const response = await fetch(
    `${base}/search?q=${encodeURIComponent("forest yhapojj")}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(queries, ["forest yhapojj"]);
});

test("track-numbered artist-title filenames expose matchable metadata", async () => {
  client.search = async () => [
    { ...track, file: "Nettspend - nite nite.flac", attribs: { 1: 134 } },
    { ...track, file: "06 - Nite Ride.flac", attribs: { 1: 193 } },
    { ...track, file: "05. nite nite.flac", attribs: { 1: 134 } },
  ];
  const response = await fetch(`${base}/search?q=nite%20nite%20nettspend`);
  const body = await response.json();
  assert.equal(body.tracks.length, 3);
  assert.deepEqual(
    body.tracks[0],
    {
      id: body.tracks[0].id,
      title: "nite nite",
      artist: "Nettspend",
      album: "",
      duration: 134,
      format: "flac",
      audioQuality: "LOSSLESS",
    },
  );
  assert.equal(body.tracks[1].title, "nite nite");
  assert.equal(body.tracks[1].duration, 134);
});

test("stream descriptor points to the authenticated direct-stream endpoint", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/stream/${id}`);
  assert.equal(response.status, 200);
  const descriptor = await response.json();
  assert.equal(
    descriptor.url,
    `https://music.example.test/p2pchord/test-secret/file/${id}`,
  );
  assert.equal(descriptor.format, "flac");
  assert.equal(descriptor.codec, "flac");
  assert.equal(descriptor.container, "flac");
  assert.equal(descriptor.mimeType, "audio/flac");
  assert.equal(downloads.length, 0);
  assert.ok(logEntries.some(({ message }) =>
    message.includes(`Stream descriptor request`) &&
      message.includes(`result id=${id} resolvable=true`),
  ));
});

test("older search results remain resolvable after a new search, including same-name peers", async () => {
  client.search = async ({ req }) => [{
    ...track,
    user: req === "older selection" ? "first-owner" : "second-owner",
    file: "Shared Album\\Kick One.flac",
  }];
  const oldResult = (await searchTracks("older selection"))[0];
  const newResult = (await searchTracks("new selection"))[0];
  assert.notEqual(oldResult.id, newResult.id);

  const oldDescriptor = await fetch(`${base}/stream/${oldResult.id}`);
  assert.equal(oldDescriptor.status, 200);
  assert.match((await oldDescriptor.json()).url, new RegExp(`/${oldResult.id}$`));
  const oldStream = await fetch(`${base}/file/${oldResult.id}`);
  assert.equal(await oldStream.text(), "0123456789");
  assert.equal(downloads[0].options.user, "first-owner");

  const newStream = await fetch(`${base}/file/${newResult.id}`);
  assert.equal(await newStream.text(), "0123456789");
  assert.equal(downloads[1].options.user, "second-owner");
  assert.ok(logEntries.some(({ message }) =>
    message.includes("searchRequests=") &&
      message.includes(`result id=${oldResult.id}`),
  ));
});

test("a stream request can resolve while a later search is still pending", async () => {
  const oldId = await searchTrack();
  let releaseSearch;
  let signalSearchStarted;
  const searchStarted = new Promise((resolve) => {
    signalSearchStarted = resolve;
  });
  client.search = ({ req }) => req === "slow search"
    ? new Promise((resolve) => {
      releaseSearch = () => resolve([{ ...track, file: "Other\\Slow Search.flac" }]);
      signalSearchStarted();
    })
    : [{ ...track }];

  const pendingSearch = fetch(`${base}/search?q=slow%20search`);
  await searchStarted;
  const descriptor = await fetch(`${base}/stream/${oldId}`);
  assert.equal(descriptor.status, 200);
  releaseSearch();
  assert.equal((await pendingSearch).status, 200);
  assert.equal((await (await fetch(`${base}/stream/${oldId}`)).json()).format, "flac");
});

test("repeated requests for one result reuse its single transfer", async () => {
  const id = await searchTrack();
  const [first, second] = await Promise.all([
    fetch(`${base}/file/${id}`),
    fetch(`${base}/file/${id}`, { headers: { Range: "bytes=0-" } }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 206);
  assert.equal(await first.text(), "0123456789");
  assert.equal(await second.text(), "0123456789");
  assert.equal(downloads.length, 1);
  assert.ok(logEntries.some(({ message }) => message.includes("reuses transfer")));
});

test("invalid and expired result ids return a logged 404", async () => {
  const invalid = await fetch(`${base}/stream/not-a-result`);
  assert.equal(invalid.status, 404);
  assert.match((await invalid.json()).error, /expired|not found/i);
  assert.ok(logEntries.some(({ message }) =>
    message.includes("resolvable=false") && message.includes("not-a-result"),
  ));

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
  await startServer({ trackRetentionMs: 20 });
  const id = await searchTrack();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const expired = await fetch(`${base}/stream/${id}`);
  assert.equal(expired.status, 404);
  assert.ok(logEntries.some(({ message }) =>
    message.includes(`result id=${id} resolvable=false`),
  ));
});

test("an active HTTP consumer pins its result ID beyond the idle retention period", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
  await startServer({ trackRetentionMs: 20 });
  trackADelay = 300;
  client.search = async ({ req }) => [{
    ...track,
    file: req === "new search" ? "Other\\New Search.flac" : "Other\\Track A.flac",
  }];

  const id = await searchTrack("active result");
  const response = await fetch(`${base}/file/${id}`);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "0123");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await searchTrack("new search");

  const range = await fetch(`${base}/file/${id}`, {
    headers: { Range: "bytes=0-3" },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "0123");
  await reader.cancel();
});

test("result capacity does not evict IDs that BitChord may still have cached", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
  await startServer({ maxTrackRecords: 1 });
  client.search = async ({ req }) => [{ ...track, user: req }];

  const originalId = await searchTrack("first-owner");
  const full = await fetch(`${base}/search?q=second-owner`);
  assert.equal(full.status, 503);
  assert.match((await full.json()).error, /registry is full/i);
  const oldDescriptor = await fetch(`${base}/stream/${originalId}`);
  assert.equal(oldDescriptor.status, 200);
  assert.ok(logEntries.some(({ message }) => message.includes("result registry is full")));
});

test("requests are rejected with a clear error when both transfer slots are occupied", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
  await startServer({ maxActiveStreams: 2 });
  trackADelay = 1000;
  client.search = async ({ req }) => [{
    ...track,
    user: req,
    file: "Shared Album\\Track A.flac",
  }];

  const firstId = await searchTrack("first-peer");
  const secondId = await searchTrack("second-peer");
  const [first, second] = await Promise.all([
    fetch(`${base}/file/${firstId}`),
    fetch(`${base}/file/${secondId}`),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const thirdId = await searchTrack("third-peer");
  const third = await fetch(`${base}/file/${thirdId}`);
  assert.equal(third.status, 503);
  assert.match((await third.json()).error, /Too many active Soulseek streams/);
  assert.ok(logEntries.some(({ message }) =>
    message.includes("transfer slots unavailable") && message.includes("HTTP 503"),
  ));
  await Promise.all([first.body?.cancel(), second.body?.cancel()]);
});

test("peer rejection is logged, releases its slot, and a later request can recover", async () => {
  const id = await searchTrack();
  const originalDownload = client.download.bind(client);
  client.download = (options) => {
    const download = new FakeDownload(options, [], 300);
    downloads.push(download);
    setTimeout(() => download.fail(new Error("peer refused the file request")), 10);
    return download;
  };

  const failedResponse = await fetch(`${base}/file/${id}`);
  assert.equal(failedResponse.status, 502);
  assert.match((await failedResponse.json()).error, /failed before audio started/i);
  for (let attempt = 0; attempt < 30 && streamCache.activeStreams > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(streamCache.activeStreams, 0);
  assert.ok(logEntries.some(({ level, message }) =>
    level === "ERROR" &&
      message.includes(`result id=${id}`) &&
      message.includes("peer refused the file request"),
  ));
  assert.ok(logEntries.some(({ level, message }) =>
    level === "ERROR" &&
      message.includes(`result id=${id}`) &&
      message.includes("failed before audio started") &&
      message.includes("HTTP 502"),
  ));
  assert.ok(logEntries.some(({ message }) =>
    message.includes("Peer rejected or failed transfer"),
  ));

  client.download = originalDownload;
  const recovered = await fetch(`${base}/file/${id}`);
  assert.equal(await recovered.text(), "0123456789");
  assert.equal(downloads.length, 2);
});

test("audio bytes arrive before the peer transfer completes", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), null);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), "0123");
  assert.equal(downloads[0].isSettled, false);
  const second = await reader.read();
  assert.equal(Buffer.from(second.value).toString(), "456789");
  assert.equal((await reader.read()).done, true);
});

test("stream timing logs trace the first byte through the HTTP response", async () => {
  const id = await searchTrack();
  const startedAt = performance.now();
  const response = await fetch(`${base}/file/${id}`);
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstByteMs = performance.now() - startedAt;

  assert.equal(Buffer.from(first.value).toString(), "0123");
  assert.ok(firstByteMs >= transferDelay - 50, `first byte arrived in ${firstByteMs}ms`);
  assert.ok(firstByteMs < 2000, `first byte arrived in ${firstByteMs}ms`);
  for (const stage of [
    "cache entry ready",
    "has a transfer slot",
    "download() invoked",
    "First Soulseek data chunk",
    "First cache write started",
    "First cache write completed",
    "first cache bytes became readable",
    "first HTTP-readable audio chunk",
    "first audio byte queued to HTTP response",
  ]) {
    assert.ok(logEntries.some(({ message }) => message.includes(stage)), stage);
  }
  assert.equal((await reader.read()).done, false);
  assert.equal((await reader.read()).done, true);
});

test("a peer that never sends its first chunk is cancelled within the configured deadline", async () => {
  await stopServer();
  await startServer({ firstByteTimeout: 80, peerIdleTimeout: 500 });
  const id = await searchTrack();
  client.download = (options) => {
    const download = new FakeDownload(options, [], 500);
    downloads.push(download);
    return download;
  };

  const startedAt = performance.now();
  const response = await fetch(`${base}/file/${id}`);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /failed before audio started/i);
  assert.ok(elapsedMs >= 50 && elapsedMs < 1000, `failed after ${elapsedMs}ms`);
  assert.ok(logEntries.some(({ message }) =>
    message.includes("No peer audio bytes received within 80ms"),
  ));
  for (let attempt = 0; attempt < 30 && streamCache.activeStreams > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(streamCache.activeStreams, 0);
});

test("a peer that stalls after its first chunk fails under the peer idle timeout", async () => {
  await stopServer();
  await startServer({ firstByteTimeout: 500, peerIdleTimeout: 80 });
  const id = await searchTrack();
  client.download = (options) => {
    const download = new FakeDownload(
      options,
      [Buffer.from("0123"), Buffer.from("456789")],
      100,
    );
    downloads.push(download);
    let idleTimer;
    download.once("data", () => {
      idleTimer = setTimeout(
        () => download.fail(new Error("peer inactivity timeout")),
        options.timeout,
      );
    });
    download.once("complete", () => clearTimeout(idleTimer));
    download.once("failed", () => clearTimeout(idleTimer));
    return download;
  };

  const response = await fetch(`${base}/file/${id}`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "0123");
  await assert.rejects(reader.read());
  for (let attempt = 0; attempt < 30 && streamCache.activeStreams > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(streamCache.activeStreams, 0);
  const snapshot = await streamCache.getMonitoringSnapshot();
  assert.equal(
    snapshot.transfers.find((item) => item.filename === track.file)?.status,
    "failed",
  );
  assert.ok(logEntries.some(({ message }) =>
    message.includes("peer inactivity timeout"),
  ));
});

test("a peer disconnect during playback leaves resumable persisted bytes", async () => {
  const id = await searchTrack();
  const originalDownload = client.download.bind(client);
  client.download = (options) => {
    const download = new FakeDownload(
      options,
      [Buffer.from("0123"), Buffer.from("456789")],
      250,
    );
    downloads.push(download);
    download.once("data", () => {
      setTimeout(
        () => download.fail(new Error("peer disconnected during playback")),
        50,
      );
    });
    return download;
  };

  const response = await fetch(`${base}/file/${id}`);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "0123");
  await assert.rejects(reader.read());
  for (let attempt = 0; attempt < 30 && streamCache.activeStreams > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snapshot = await streamCache.getMonitoringSnapshot();
  const failedTransfer = snapshot.transfers.find(
    (item) => item.filename === track.file,
  );
  assert.equal(failedTransfer?.status, "failed");
  assert.equal(failedTransfer?.downloadedBytes, 4);

  client.download = originalDownload;
  const resumed = await fetch(`${base}/file/${id}`);
  assert.equal(await resumed.text(), "0123456789");
  assert.equal(downloads[1].options.offset, 4);
});

test("batched cache writes preserve bytes while delivering the first chunk immediately", async () => {
  const content = Buffer.alloc(96 * 1024);
  for (let index = 0; index < content.length; index++) {
    content[index] = index % 251;
  }
  const chunks = Array.from({ length: 96 }, (_, index) =>
    content.subarray(index * 1024, (index + 1) * 1024),
  );
  client.search = async () => [{ ...track, size: content.length }];
  client.download = (options) => {
    const download = new FakeDownload(options, chunks, 0);
    downloads.push(download);
    return download;
  };
  await stopServer();
  await startServer({ writeBatchBytes: 16 * 1024, writeBatchDelayMs: 8 });

  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  assert.ok(streamCache.diskWriteOperations < chunks.length);
});

test("searching for another track leaves the active transfer delivering bytes", async () => {
  client.search = async ({ req }) => [{
    ...track,
    file: req === "next track" ? "Other\\Next Track.flac" : track.file,
  }];
  const firstId = await searchTrack();
  const firstResponse = await fetch(`${base}/file/${firstId}`);
  const firstReader = firstResponse.body.getReader();
  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "0123");
  assert.equal(downloads[0].isSettled, false);

  const searchResponse = await fetch(`${base}/search?q=next%20track`);
  assert.equal(searchResponse.status, 200);
  assert.equal(downloads[0].options.signal.aborted, false);
  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "456789");
  assert.equal(downloads[0].options.signal.aborted, false);
});

test("reconnecting during the grace period reuses the active Soulseek transfer", async () => {
  const id = await searchTrack();
  const firstResponse = await fetch(`${base}/file/${id}`);
  const firstReader = firstResponse.body.getReader();
  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "0123");
  await firstReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const reconnected = await fetch(`${base}/file/${id}`);
  assert.equal(await reconnected.text(), "0123456789");
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].options.signal.aborted, false);
  assert.ok(logEntries.some(({ message }) =>
    message.includes("reuses transfer") && message.includes(`result id=${id}`),
  ));
});

test("disconnecting one HTTP stream closes its reader without affecting another consumer", async () => {
  transferDelay = 1000;
  const id = await searchTrack();
  const originalReadRange = streamCache.readRange.bind(streamCache);
  let firstReaderClosed;
  const firstReaderCleanup = new Promise((resolve) => {
    firstReaderClosed = resolve;
  });
  let readerCount = 0;
  streamCache.readRange = async function* (...args) {
    const readerIndex = readerCount++;
    try {
      yield* originalReadRange(...args);
    } finally {
      if (readerIndex === 0) firstReaderClosed();
    }
  };

  const firstResponse = await fetch(`${base}/file/${id}`);
  const firstReader = firstResponse.body.getReader();
  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "0123");
  const secondResponse = await fetch(`${base}/file/${id}`);
  const secondReader = secondResponse.body.getReader();
  assert.equal(Buffer.from((await secondReader.read()).value).toString(), "0123");

  await firstReader.cancel();
  const cleanedUp = await Promise.race([
    firstReaderCleanup.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  assert.equal(cleanedUp, true, "disconnected reader should close its file handle");
  assert.equal(downloads[0].options.signal.aborted, false);
  assert.equal(Buffer.from((await secondReader.read()).value).toString(), "456789");
  assert.equal((await secondReader.read()).done, true);
  assert.equal(downloads[0].options.signal.aborted, false);
});

test("two tracks can stream concurrently without sharing transfer data", async () => {
  client.search = async ({ req }) => [{
    ...track,
    file: req === "track b" ? "Other\\Track B.flac" : track.file,
  }];
  const firstId = await searchTrack("track a");
  const firstResponse = await fetch(`${base}/file/${firstId}`);
  const firstReader = firstResponse.body.getReader();
  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "0123");

  const secondId = await searchTrack("track b");
  const secondResponse = await fetch(`${base}/file/${secondId}`);
  const secondReader = secondResponse.body.getReader();
  assert.equal(secondResponse.status, 200);
  assert.equal(downloads.length, 2);
  assert.equal(Buffer.from((await secondReader.read()).value).toString(), "0123");
  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "456789");
  assert.equal(Buffer.from((await secondReader.read()).value).toString(), "456789");
  assert.equal((await firstReader.read()).done, true);
  assert.equal((await secondReader.read()).done, true);
  assert.equal(downloads[0].options.signal.aborted, false);
  assert.equal(downloads[1].options.signal.aborted, false);
});

test("the same peer file cannot replace an active transfer with different metadata", async () => {
  trackADelay = 300;
  client.search = async ({ req }) => [{
    ...track,
    file: "Other\\Track A.flac",
    size: req === "track b" ? track.size + 1 : track.size,
  }];
  const firstId = await searchTrack("track a");
  const firstResponse = await fetch(`${base}/file/${firstId}`);
  const secondId = await searchTrack("track b");
  const conflictingResponse = await fetch(`${base}/file/${secondId}`);

  assert.equal(conflictingResponse.status, 409);
  assert.equal(downloads.length, 1);
  assert.equal(await firstResponse.text(), "0123456789");
  assert.equal(downloads[0].options.signal.aborted, false);
});

test("disconnecting one track preserves shared consumers and expires abandoned transfers", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
  trackADelay = 1000;
  transferDelay = 1000;
  await startServer({ idleTransferTimeout: 25 });
  client.search = async ({ req }) => [{
    ...track,
    file: req === "track a"
      ? "Other\\Track A.flac"
      : req === "track b"
        ? "Other\\Track B.flac"
        : req === "track c"
          ? "Other\\Track C.flac"
          : track.file,
  }];

  const firstId = await searchTrack("track a");
  const firstResponse = await fetch(`${base}/file/${firstId}`);
  const firstReader = firstResponse.body.getReader();
  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "0123");
  const sharedResponse = await fetch(`${base}/file/${firstId}`);
  const sharedReader = sharedResponse.body.getReader();
  assert.equal(Buffer.from((await sharedReader.read()).value).toString(), "0123");
  await firstReader.cancel();
  assert.equal(downloads[0].options.signal.aborted, false);

  const secondId = await searchTrack("track b");
  const secondResponse = await fetch(`${base}/file/${secondId}`);
  const secondReader = secondResponse.body.getReader();
  assert.equal(Buffer.from((await secondReader.read()).value).toString(), "0123");
  await secondReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(downloads[1].options.signal.aborted, true);
  assert.equal(downloads[0].options.signal.aborted, false);

  const thirdId = await searchTrack("track c");
  const thirdResponse = await fetch(`${base}/file/${thirdId}`);
  assert.equal(thirdResponse.status, 200);
  assert.equal(downloads.length, 3);
  assert.equal(downloads[2].options.signal.aborted, false);
  assert.equal(Buffer.from((await sharedReader.read()).value).toString(), "456789");
  await thirdResponse.arrayBuffer();
});

test("completed transfers release their slot for another track", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await streamCache.close();
  await startServer({ maxActiveStreams: 1 });
  client.search = async ({ req }) => [{
    ...track,
    file: req === "next track" ? "Other\\Next Track.flac" : track.file,
  }];
  const firstId = await searchTrack();
  const firstResponse = await fetch(`${base}/file/${firstId}`);
  assert.equal(firstResponse.status, 200);
  await firstResponse.arrayBuffer();
  await downloads[0].promise;

  const secondId = await searchTrack("next track");
  const secondResponse = await fetch(`${base}/file/${secondId}`);
  assert.equal(secondResponse.status, 200);
  assert.equal(downloads.length, 2);
  await secondResponse.arrayBuffer();
});

test("completed files persist on disk and serve later byte ranges without redownloading", async () => {
  const firstId = await searchTrack();
  const firstResponse = await fetch(`${base}/file/${firstId}`);
  assert.equal(await firstResponse.text(), "0123456789");
  assert.equal(downloads.length, 1);
  assert.ok(logEntries.some(({ message }) => message.includes("cached.")));

  const range = await fetch(`${base}/file/${firstId}`, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await range.text(), "2345");
  assert.equal(downloads.length, 1);

  await stopServer();
  await startServer();
  const afterRestartId = await searchTrack();
  const afterRestart = await fetch(`${base}/file/${afterRestartId}`);
  assert.equal(await afterRestart.text(), "0123456789");
  assert.equal(downloads.length, 1);
  assert.ok(logEntries.some(({ message }) =>
    message.includes('Stream cache hit for "Kick One" (complete)'),
  ));
});

test("expired completed cache entries are downloaded again", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`);
  assert.equal(await response.text(), "0123456789");
  assert.equal(downloads.length, 1);

  await stopServer();
  const metadataName = (await readdir(cacheDirectory)).find((name) =>
    name.endsWith(".json"),
  );
  const metadataPath = join(cacheDirectory, metadataName);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.lastAccess = Date.now() - 10_000;
  await writeFile(metadataPath, JSON.stringify(metadata));

  await startServer({ cacheTtlMs: 1000 });
  const expiredId = await searchTrack();
  const redownloaded = await fetch(`${base}/file/${expiredId}`);
  assert.equal(await redownloaded.text(), "0123456789");
  assert.equal(downloads.length, 2);
});

test("partial data survives cancellation and resumes from its exact offset after restart", async () => {
  idleTransferTimeout = 25;
  await stopServer();
  await startServer({ idleTransferTimeout: 25 });

  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`);
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "0123");
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(downloads[0].options.signal.aborted, true);

  await stopServer();
  await startServer({ idleTransferTimeout: 25 });
  const resumedId = await searchTrack();
  const cachedRange = await fetch(`${base}/file/${resumedId}`, {
    headers: { Range: "bytes=0-3" },
  });
  assert.equal(cachedRange.headers.get("content-range"), "bytes 0-3/*");
  assert.equal(await cachedRange.text(), "0123");
  assert.equal(downloads.length, 1);

  const resumed = await fetch(`${base}/file/${resumedId}`);
  assert.equal(await resumed.text(), "0123456789");
  assert.equal(downloads.length, 2);
  assert.equal(downloads[1].options.offset, 4);
  assert.ok(logEntries.some(({ message }) => message.includes("Resuming")));
});

test("batched writes resume from the last fully persisted offset", async () => {
  const content = Buffer.alloc(48 * 1024);
  for (let index = 0; index < content.length; index++) {
    content[index] = index % 251;
  }
  const chunkSize = 4 * 1024;
  client.search = async () => [{ ...track, size: content.length }];
  client.download = (options) => {
    const start = options.offset;
    const end = downloads.length === 0 ? 4 * chunkSize : content.length;
    const chunks = [];
    for (let position = start; position < end; position += chunkSize) {
      chunks.push(content.subarray(position, Math.min(position + chunkSize, end)));
    }
    const download = new FakeDownload(options, chunks, 0);
    downloads.push(download);
    return download;
  };
  await stopServer();
  await startServer({
    writeBatchBytes: 8 * 1024,
    writeBatchDelayMs: 8,
  });

  const id = await searchTrack();
  const firstResponse = await fetch(`${base}/file/${id}`);
  const reader = firstResponse.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  const firstBytes = Buffer.from(firstChunk.value);
  assert.ok(firstBytes.length > 0);
  assert.deepEqual(firstBytes, content.subarray(0, firstBytes.length));
  await reader.cancel();
  for (let attempt = 0; attempt < 100 && streamCache.activeStreams > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(downloads[0].isSettled, true);
  assert.equal(streamCache.activeStreams, 0);
  assert.equal(
    logEntries.some(({ level, message }) =>
      level === "ERROR" && message.includes("Could not persist Soulseek result"),
    ),
    false,
  );
  const partialName = (await readdir(cacheDirectory)).find((name) =>
    name.endsWith(".part"),
  );
  const partialBytes = (await stat(join(cacheDirectory, partialName))).size;
  assert.ok(partialBytes > 0 && partialBytes < content.length);

  const resumed = await fetch(`${base}/file/${id}`);
  assert.equal(resumed.status, 200);
  assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), content);
  assert.equal(downloads[1].options.offset, partialBytes);
});

test("cache eviction never removes a file while its HTTP consumer is active", async () => {
  trackADelay = 1000;
  await stopServer();
  await startServer({ maxCacheBytes: 10 });
  client.search = async ({ req }) => [{
    ...track,
    file: req === "track a"
      ? "Other\\Track A.flac"
      : "Other\\Track B.flac",
  }];
  const firstId = await searchTrack("track a");
  const firstResponse = await fetch(`${base}/file/${firstId}`);
  const firstReader = firstResponse.body.getReader();
  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "0123");

  const secondId = await searchTrack("track b");
  const secondResponse = await fetch(`${base}/file/${secondId}`);
  assert.equal(await secondResponse.text(), "0123456789");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(logEntries.some(({ message }) => message.includes("Evicted")));

  assert.equal(Buffer.from((await firstReader.read()).value).toString(), "456789");
  assert.equal((await firstReader.read()).done, true);
  const cachedFirst = await fetch(`${base}/file/${firstId}`);
  assert.equal(await cachedFirst.text(), "0123456789");
  assert.equal(downloads.length, 2);
});

test("one persistent authenticated Soulseek client serves all track requests", () => {
  assert.equal((serverSource.match(/new SlskClient\(/g) ?? []).length, 1);
  assert.match(serverSource, /await client\.login\(username, password\)/);
  assert.match(serverSource, /createAddonServer\(\{\s*client,/);
  assert.match(serverSource, /server\.listen\(PORT, BIND_ADDRESS/);
});

test("search and stream lifecycle events are logged for the launcher", async () => {
  const id = await searchTrack();
  await fetch(`${base}/stream/${id}`);
  const response = await fetch(`${base}/file/${id}`);
  await response.arrayBuffer();
  await downloads[0].promise;
  assert.ok(logEntries.some(({ level, message }) =>
    level === "SEARCH" && message.includes("searching Soulseek"),
  ));
  assert.ok(logEntries.some(({ level, message }) =>
    level === "STREAM" && message.includes("BitChord requested"),
  ));
  assert.ok(logEntries.some(({ level, message }) =>
    level === "STREAM" && message.includes("First audio bytes received"),
  ));
  assert.ok(logEntries.some(({ level, message }) =>
    level === "STREAM" && message.includes("Peer transfer complete"),
  ));
});

test("range requests are served from the beginning of a peer transfer", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("content-range"), "bytes 2-5/*");
  assert.equal(await response.text(), "2345");
  assert.equal(downloads[0].options.offset, 0);
});

test("open-ended range requests stream without declaring the full length", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`, {
    headers: { Range: "bytes=0-" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("content-range"), "bytes 0-9/*");
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), "0123");
  assert.equal(downloads[0].isSettled, false);
  assert.equal(
    Buffer.from((await reader.read()).value).toString(),
    "456789",
  );
  assert.equal((await reader.read()).done, true);
});

test("successive range requests share one active peer transfer", async () => {
  const id = await searchTrack();
  const firstResponse = await fetch(`${base}/file/${id}`);
  assert.equal(firstResponse.status, 200);
  assert.equal(downloads.length, 1);
  const firstReader = firstResponse.body.getReader();
  assert.equal(
    Buffer.from((await firstReader.read()).value).toString(),
    "0123",
  );
  await firstReader.cancel();

  const secondResponse = await fetch(`${base}/file/${id}`, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(secondResponse.status, 206);
  assert.equal(secondResponse.headers.get("content-range"), "bytes 2-5/*");
  assert.equal(await secondResponse.text(), "2345");
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].options.offset, 0);
  await downloads[0].promise;
  assert.equal(
    logEntries.some(({ level }) => level === "ERROR"),
    false,
  );
});

test("HEAD reports file metadata without opening a peer transfer", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`, { method: "HEAD" });
  assert.equal(response.headers.get("content-length"), "10");
  assert.equal(response.headers.get("content-range"), null);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  const rangeResponse = await fetch(`${base}/file/${id}`, {
    method: "HEAD",
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(rangeResponse.headers.get("content-length"), "4");
  assert.equal(rangeResponse.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(downloads.length, 0);
});

test("unknown routes and unsatisfiable ranges are rejected", async () => {
  const id = await searchTrack();
  assert.equal((await fetch(`${base}/bad/route`)).status, 404);
  const response = await fetch(`${base}/file/${id}`, {
    headers: { Range: "bytes=25-" },
  });
  assert.equal(response.status, 416);
});

test("files above the configured in-memory limit are rejected", async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  ({ server } = createAddonServer({
    client,
    secret: "test-secret",
    slug: "p2pchord",
    publicBaseUrl: "https://music.example.test",
    maxStreamBytes: 5,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/p2pchord/test-secret`;
  const search = await (await fetch(`${base}/search?q=kick`)).json();
  const id = search.tracks[0].id;
  const response = await fetch(`${base}/file/${id}`);
  assert.equal(response.status, 413);
  assert.equal(downloads.length, 0);
});
