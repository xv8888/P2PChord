import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { FileAttribute } from "slsk-client";
import {
  createAddonServer,
  generateSourceSecret,
  matchScore,
  normalizeSearchQuery,
} from "./direct_server.mjs";

const sourceWords = JSON.parse(
  readFileSync(new URL("./source_words.json", import.meta.url), "utf8"),
);
const serverSource = readFileSync(new URL("./direct_server.mjs", import.meta.url), "utf8");

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
  assert.equal(generateSourceSecret().split("-").length, 4);
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
  ({ server, streamCache } = createAddonServer({
    client,
    secret: "test-secret",
    slug: "bitseekwin",
    publicBaseUrl: "https://music.example.test",
    getConnectionStatus: () => monitorConnectionStatus,
    logger: (level, message) => logEntries.push({ level, message }),
    idleTransferTimeout,
    cacheDirectory,
    ...options,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/bitseekwin/test-secret`;
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
  cacheDirectory = await mkdtemp(join(tmpdir(), "bitseekwin-test-cache-"));
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
  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  assert.equal(manifest.version, "alpha-0.5.0");
  assert.match(manifest.description, /directly from Soulseek peers/);
  assert.equal(manifest.allowDownloads, false);
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

test("downloads can be explicitly enabled in the addon manifest", async () => {
  const enabled = createAddonServer({
    client,
    secret: "test-secret",
    slug: "bitseekwin",
    publicBaseUrl: "https://music.example.test",
    allowDownloads: true,
  });
  await new Promise((resolve) => enabled.server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${enabled.server.address().port}/bitseekwin/test-secret/manifest.json`,
    );
    const manifest = await response.json();
    assert.equal(manifest.allowDownloads, true);
  } finally {
    enabled.server.closeAllConnections();
    await new Promise((resolve) => enabled.server.close(resolve));
  }
});

test("search ranks the closest FLAC candidates first", async () => {
  client.search = async () => [
    { ...track, file: "Album\\Kick Song Remix.flac" },
    {
      ...track,
      file: "Album\\Kick Song.flac",
      attribs: { [FileAttribute.Duration]: 214 },
    },
    { ...track, file: "Album\\Kick Song.flac", user: "second-owner" },
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
    `https://music.example.test/bitseekwin/test-secret/file/${id}`,
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
    slug: "bitseekwin",
    publicBaseUrl: "https://music.example.test",
    maxStreamBytes: 5,
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/bitseekwin/test-secret`;
  const search = await (await fetch(`${base}/search?q=kick`)).json();
  const id = search.tracks[0].id;
  const response = await fetch(`${base}/file/${id}`);
  assert.equal(response.status, 413);
  assert.equal(downloads.length, 0);
});
