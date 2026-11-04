import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { FileAttribute } from "slsk-client";
import { createAddonServer, matchScore } from "./direct_server.mjs";

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
  assert.equal(manifest.version, "0.4.0-pre-alpha.0");
  assert.match(manifest.description, /directly from Soulseek peers/);
  const response = await fetch(`${base}/search?q=kick`);
  const body = await response.json();
  assert.equal(body.tracks.length, 1);
  assert.equal(body.tracks[0].format, "flac");
  assert.equal(body.tracks[0].artist, "");
  assert.equal("duration" in body.tracks[0], false);
  assert.equal(client.lastSearch.req, "kick");
  assert.equal(client.lastSearch.timeout, 2000);
});

test("search returns only the closest matching FLAC", async () => {
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
  assert.equal(body.tracks.length, 1);
  assert.equal(body.tracks[0].title, "Kick Song");
  assert.equal(body.tracks[0].duration, 214);
  assert.equal(body.tracks[0].artist, "");
  assert.equal(matchScore("kick song", "Album\\Kick Song.flac"), 1);
  assert.ok(
    matchScore("kick song", "Kick Song.flac") >
      matchScore("kick song", "Kick Song Remix.flac"),
  );
  assert.match(logEntries.at(-1).message, /selected "Kick Song"/);
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
  assert.equal(downloads.length, 3);
});

test("range requests start a peer transfer at the requested byte offset", async () => {
  const id = await searchTrack();
  const response = await fetch(`${base}/file/${id}`, {
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await response.text(), "2345");
  assert.equal(downloads[0].options.offset, 2);
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
