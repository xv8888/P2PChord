import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { FileAttribute } from "slsk-client";
import {
  createAddonServer,
  generateSourceSecret,
  matchScore,
} from "./direct_server.mjs";

const sourceWords = JSON.parse(
  readFileSync(new URL("./source_words.json", import.meta.url), "utf8"),
);

class FakeDownload extends EventEmitter {
  constructor(options, chunks, delay = 0) {
    super();
    this.options = options;
    this.stream = new PassThrough();
    this.isSettled = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.promise.catch(() => {});
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
      this.stream.end();
      this.resolve({ receivedBytes: options.offset + chunks.reduce((n, c) => n + c.length, 0) });
      this.emit("status", "complete");
      this.emit("complete");
    }, elapsed + delay);
  }

  cancel(reason) {
    if (this.isSettled) return false;
    this.isSettled = true;
    const error = new Error(reason);
    this.stream.destroy(error);
    this.emit("status", "cancelled");
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
let base;
let client;
let downloads;
let logEntries;

beforeEach(async () => {
  downloads = [];
  logEntries = [];
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
      const download = new FakeDownload(
        options,
        options.offset
          ? [Buffer.from("2345"), Buffer.from("6789")]
          : [Buffer.from("0123"), Buffer.from("456789")],
        80,
      );
      downloads.push(download);
      return download;
    },
  };
  ({ server } = createAddonServer({
    client,
    secret: "test-secret",
    slug: "bitseekwin",
    publicBaseUrl: "https://music.example.test",
    logger: (level, message) => logEntries.push({ level, message }),
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/bitseekwin/test-secret`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function searchTrack() {
  const response = await fetch(`${base}/search?q=kick`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tracks.length, 1);
  return body.tracks[0].id;
}

test("manifest and search expose only safe FLAC results", async () => {
  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  assert.equal(manifest.version, "alpha-0.4.2");
  assert.match(manifest.description, /directly from Soulseek peers/);
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
  assert.match(logEntries.at(-1).message, /returning 3 ranked candidates/);
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
  const descriptor = await (
    await fetch(`${base}/stream/${id}`)
  ).json();
  assert.equal(
    descriptor.url,
    `https://music.example.test/bitseekwin/test-secret/file/${id}`,
  );
  assert.equal(descriptor.format, "flac");
  assert.equal(descriptor.codec, "flac");
  assert.equal(descriptor.container, "flac");
  assert.equal(descriptor.mimeType, "audio/flac");
  assert.equal(downloads.length, 0);
});

test("audio bytes arrive before the peer transfer completes", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), "0123");
  assert.equal(downloads[0].isSettled, false);
  const second = await reader.read();
  assert.equal(Buffer.from(second.value).toString(), "456789");
  assert.equal((await reader.read()).done, true);
});

test("search and stream lifecycle events are logged for the launcher", async () => {
  const id = await searchTrack();
  await fetch(`${base}/stream/${id}`);
  const response = await fetch(`${base}/file/${id}`);
  await response.arrayBuffer();
  await downloads[0].promise;
  assert.ok(logEntries.some(({ level, message }) =>
    level === "SEARCH" && message.includes("Searching Soulseek"),
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

test("completed transfers release an active-stream slot", async () => {
  const id = await searchTrack();
  for (let index = 0; index < 3; index++) {
    const response = await fetch(`${base}/file/${id}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.equal(downloads.length, 1);
});

test("range requests are served from the beginning of a peer transfer", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await response.text(), "2345");
  assert.equal(downloads[0].options.offset, 0);
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
  assert.equal(secondResponse.headers.get("content-range"), "bytes 2-5/10");
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
  assert.equal(response.headers.get("accept-ranges"), "bytes");
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
