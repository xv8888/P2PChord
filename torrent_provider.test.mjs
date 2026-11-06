import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createAddonServer } from "./direct_server.mjs";
import { TorrentProvider } from "./torrent_provider.mjs";
import { TransferBudget } from "./transfer_budget.mjs";

const audio = Buffer.from("fLaC-synthetic-verified-audio");

class FakeClient {
  destroy(callback) {
    callback();
  }
}

function createFile(path, bytes) {
  const file = new EventEmitter();
  file.path = path;
  file.length = bytes.length;
  file.done = false;
  file.selections = 0;
  file.select = () => file.selections++;
  file.deselect = () => file.selections--;
  file.createReadStream = ({ start, end }) =>
    Readable.from([bytes.subarray(start, end + 1)]);
  return file;
}

async function createProvider(directory, options = {}) {
  return new TorrentProvider({
    logger: () => {},
    directory,
    maxFileBytes: 1024,
    maxStorageBytes: 4096,
    idleTransferTimeout: 10000,
    transferBudget: new TransferBudget(2),
    client: new FakeClient(),
    ...options,
  });
}

test("configured torrent sources validate magnet hashes and bounded local metadata files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2pchord-torrent-test-"));
  const provider = await createProvider(directory);
  const magnet =
    "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
  assert.equal(await provider.readSource(magnet), magnet);
  await assert.rejects(
    provider.readSource("magnet:?xt=urn:btih:not-an-info-hash"),
    /valid BitTorrent info hash/,
  );
  await assert.rejects(provider.readSource("relative.torrent"), /absolute/);

  const metadataPath = join(directory, "fixture.torrent");
  await writeFile(metadataPath, Buffer.from("fixture metadata"));
  assert.deepEqual(await provider.readSource(metadataPath), Buffer.from("fixture metadata"));
  await provider.close();
  await rm(directory, { recursive: true, force: true });
});

test("torrent search filters unsafe/non-FLAC paths and serves synthetic byte ranges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2pchord-torrent-test-"));
  const provider = await createProvider(directory);
  const safeFile = createFile("Artist/Example Song.flac", audio);
  const invalidFlac = createFile("Artist/Bad Bits.flac", Buffer.from("not-a-flac-file"));
  const torrent = {
    infoHash: "0123456789012345678901234567890123456789",
    length: audio.length * 4,
    name: "Synthetic fixture",
    files: [
      safeFile,
      invalidFlac,
      createFile("../outside.flac", audio),
      createFile("cover.jpg", audio),
    ],
    downloadSpeed: 32,
    numPeers: 1,
    downloaded: 0,
  };
  provider.registerTorrent(torrent);

  const [track] = provider.search("example song");
  assert.equal(track.provider, "torrent");
  assert.match(track.id, /^bt-/);
  assert.equal(provider.search("missing").length, 0);

  const entry = await provider.getEntry(track);
  await provider.ensureTransfer(entry);
  const chunks = [];
  for await (const chunk of provider.readRange(entry, 6, 13, null, new AbortController().signal)) {
    chunks.push(chunk);
  }
  assert.deepEqual(Buffer.concat(chunks), audio.subarray(6, 14));
  assert.equal(entry.readers.size, 0);
  assert.equal(provider.getMonitoringSnapshot().transferSlots.active, 1);
  provider.removeConsumer(entry);
  const badEntry = await provider.getEntry(provider.search("bad bits")[0]);
  await assert.rejects(async () => {
    for await (const _chunk of provider.readRange(
      badEntry,
      0,
      invalidFlac.length - 1,
      null,
      new AbortController().signal,
    )) {
      // The invalid header must be rejected before yielding file data.
    }
  }, /FLAC header/);
  provider.removeConsumer(badEntry);
  await provider.close();
  await rm(directory, { recursive: true, force: true });
});

test("shared transfer budget rejects excess provider transfers and releases slots once", () => {
  const budget = new TransferBudget(1);
  const release = budget.acquire();
  assert.throws(() => budget.acquire(), /Too many active source transfers/);
  release();
  release();
  assert.deepEqual(budget.getSnapshot(), { active: 0, limit: 1 });
});

test("HTTP search, stream resolution, and ranges dispatch to a torrent provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2pchord-torrent-test-"));
  const transferBudget = new TransferBudget(2);
  const provider = await createProvider(directory, { transferBudget });
  const file = createFile("Artist/Example Song.flac", audio);
  provider.registerTorrent({
    infoHash: "0123456789012345678901234567890123456789",
    length: audio.length,
    name: "Synthetic fixture",
    files: [file],
    downloadSpeed: 0,
    numPeers: 1,
    downloaded: 0,
  });
  const { server, streamCache } = createAddonServer({
    client: null,
    torrentProvider: provider,
    secret: "test-secret",
    slug: "p2pchord",
    publicBaseUrl: "http://127.0.0.1",
    transferBudget,
    cacheDirectory: join(directory, "soulseek-cache"),
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base =
      `http://127.0.0.1:${server.address().port}/p2pchord/test-secret`;
    const searchResponse = await fetch(`${base}/search?q=example%20song`);
    const search = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.equal(search.tracks.length, 1);
    const descriptorResponse = await fetch(
      `${base}/stream/${search.tracks[0].id}`,
    );
    const descriptor = await descriptorResponse.json();
    const mediaUrl = new URL(descriptor.url);
    mediaUrl.host = new URL(base).host;
    const ranged = await fetch(mediaUrl, {
      headers: { Range: "bytes=6-13" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 6-13/*`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), audio.subarray(6, 14));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await streamCache.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
