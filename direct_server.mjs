import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { SlskClient } from "slsk-client";

const APP_NAME = "BitSeekWin - BitChord-Soulseek Integration";
const VERSION = (await readFile(new URL("./version.txt", import.meta.url), "utf8"))
  .trim();
const SLUG = process.env.BITSEEKWIN_SLUG ?? "bitseekwin";
const SECRET = process.env.BITCHORD_SECRET ?? randomUUID().replaceAll("-", "");
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${PORT}`
).replace(/\/+$/, "");
const SEARCH_TIMEOUT = 2000;
const SEARCH_LIMIT = 50;
const MAX_TRACKS = 1000;
const MAX_ACTIVE_STREAMS = 2;
const MAX_STREAM_BYTES = 128 * 1024 * 1024;
const STREAM_TIMEOUT = 15 * 60 * 1000;
const TEMP_DIRECTORY = join(tmpdir(), "BitSeekWin");

function trackId(result) {
  return createHash("sha256")
    .update(`${result.user}\0${result.file}\0${result.size}`)
    .digest("hex")
    .slice(0, 24);
}

function isSafeFlac(filename) {
  const normalized = filename.replaceAll("\\", "/");
  return (
    normalized.toLowerCase().endsWith(".flac") &&
    !normalized.startsWith("/") &&
    !/^[a-z]:/i.test(normalized) &&
    !normalized.split("/").some((part) => part === ".." || part === "." || !part)
  );
}

function parseRange(value, size) {
  if (!value) return [0, size - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new RangeError("Invalid range");

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new RangeError("Invalid range");
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  ) {
    throw new RangeError("Unsatisfiable range");
  }
  return [start, end];
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(response, status, value, headOnly = false) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  if (headOnly) response.end();
  else response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

export function createAddonServer({
  client,
  secret = SECRET,
  slug = SLUG,
  publicBaseUrl = PUBLIC_BASE_URL,
  maxActiveStreams = MAX_ACTIVE_STREAMS,
  maxStreamBytes = MAX_STREAM_BYTES,
}) {
  const tracks = new Map();
  let activeStreams = 0;

  async function handle(request, response) {
    response.on("error", (error) => {
      console.error("HTTP response failed:", error.message);
    });
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
    );
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-Range, Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendError(response, 405, "Method not allowed");
      return;
    }

    let segments;
    let url;
    try {
      url = new URL(request.url, "http://localhost");
      segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
    } catch {
      sendError(response, 400, "Invalid request path");
      return;
    }
    if (
      segments.length < 3 ||
      segments[0] !== slug ||
      !safeEqual(segments[1], secret)
    ) {
      sendError(response, 404, "Not found");
      return;
    }
    const route = segments.slice(2);

    if (route.length === 1 && route[0] === "manifest.json") {
      sendJson(
        response,
        200,
        {
          id: `bitseekwin-addon.${slug}`,
          name: APP_NAME,
          version: VERSION,
          description:
            "Search authorized FLAC files and stream them directly from Soulseek peers to BitChord.",
          resources: ["search", "stream"],
          types: ["track"],
          contentType: "music",
          allowDownloads: false,
        },
        request.method === "HEAD",
      );
      return;
    }

    if (route.length === 1 && route[0] === "search" && request.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) {
        sendJson(response, 200, {
          tracks: [],
          albums: [],
          artists: [],
          playlists: [],
        });
        return;
      }
      try {
        const results = await client.search({ req: query, timeout: SEARCH_TIMEOUT });
        const found = [];
        const seen = new Set();
        for (const result of results) {
          if (
            !result.user ||
            !isSafeFlac(result.file) ||
            !Number.isSafeInteger(result.size) ||
            result.size <= 0
          ) {
            continue;
          }
          const id = trackId(result);
          if (seen.has(id)) continue;
          seen.add(id);
          const title = result.file.replaceAll("\\", "/").split("/").at(-1)
            .replace(/\.flac$/i, "").replaceAll("_", " ");
          const track = { id, user: result.user, file: result.file, size: result.size, title };
          tracks.delete(id);
          tracks.set(id, track);
          found.push(track);
          while (tracks.size > MAX_TRACKS) {
            tracks.delete(tracks.keys().next().value);
          }
          if (found.length === SEARCH_LIMIT) break;
        }
        sendJson(response, 200, {
          tracks: found.map((track) => ({
            id: track.id,
            title: track.title,
            artist: `Shared by ${track.user}`,
            album: "",
            duration: 0,
            format: "flac",
            audioQuality: "LOSSLESS",
          })),
          albums: [],
          artists: [],
          playlists: [],
        });
      } catch (error) {
        console.error("Soulseek search failed:", error.message);
        sendError(response, 502, "Soulseek search failed");
      }
      return;
    }

    if (
      route.length === 2 &&
      route[0] === "stream" &&
      request.method === "GET"
    ) {
      const track = tracks.get(route[1]);
      if (!track) {
        sendError(response, 404, "Track not found; search again");
        return;
      }
      sendJson(response, 200, {
        url: `${publicBaseUrl}/${slug}/${secret}/file/${track.id}`,
        format: "flac",
        quality: "lossless",
        codec: "FLAC",
        container: "flac",
        manifest: "none",
      });
      return;
    }

    if (route.length === 2 && route[0] === "file") {
      const track = tracks.get(route[1]);
      if (!track) {
        sendError(response, 404, "Track not found; search again");
        return;
      }
      if (track.size > maxStreamBytes) {
        sendError(response, 413, "File exceeds the in-memory stream size limit");
        return;
      }

      let start;
      let end;
      try {
        [start, end] = parseRange(request.headers.range, track.size);
      } catch {
        response.writeHead(416, {
          "Access-Control-Allow-Origin": "*",
          "Content-Range": `bytes */${track.size}`,
          "Content-Length": "0",
        });
        response.end();
        return;
      }

      const length = end - start + 1;
      const partial = Boolean(request.headers.range);
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers":
          "Content-Length, Content-Range, Accept-Ranges",
        "Accept-Ranges": "bytes",
        "Content-Type": "audio/flac",
        "Content-Length": length,
        "Cache-Control": "no-store",
      };
      if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${track.size}`;
      if (request.method === "HEAD") {
        response.writeHead(partial ? 206 : 200, headers);
        response.end();
        return;
      }
      if (activeStreams >= maxActiveStreams) {
        sendError(response, 503, "Too many active Soulseek streams");
        return;
      }

      activeStreams++;
      const abortController = new AbortController();
      const timer = setTimeout(
        () => abortController.abort(new Error("Stream timed out")),
        STREAM_TIMEOUT,
      );
      timer.unref();
      const tempPath = join(TEMP_DIRECTORY, `${randomUUID()}.flac`);
      let rangeComplete = false;
      let released = false;
      let download;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        activeStreams--;
      };
      try {
        download = client.download({
          ...track,
          path: tempPath,
          offset: start,
          timeout: STREAM_TIMEOUT,
          signal: abortController.signal,
        });
        let receivedBytes = start;
        download.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxStreamBytes && !download.isSettled) {
            abortController.abort(new Error("Stream exceeded its size limit"));
            download.cancel("Stream exceeded its size limit");
          }
        });
        download.stream.on("error", (error) => {
          if (rangeComplete || response.destroyed) return;
          console.error("Soulseek stream failed:", error.message);
          if (response.headersSent) response.destroy(error);
          else sendError(response, 502, "Soulseek file transfer failed");
        });
        download.then(
          () => rm(tempPath, { force: true }).catch((error) => {
            console.error("Could not remove temporary stream file:", error.message);
          }),
          () => rm(tempPath, { force: true }).catch((error) => {
            console.error("Could not remove temporary stream file:", error.message);
          }),
        );

        response.writeHead(partial ? 206 : 200, headers);
        response.on("close", () => {
          clearTimeout(timer);
          if (!response.writableEnded) {
            abortController.abort(new Error("BitChord disconnected"));
            download.cancel("BitChord disconnected");
          }
        });

        download.finally(release).catch(() => {});

        if (length === track.size - start) {
          download.stream.pipe(response);
          return;
        }

        let remaining = length;
        const limiter = new Transform({
          transform(chunk, _encoding, callback) {
            const output = chunk.subarray(0, remaining);
            remaining -= output.length;
            callback(null, output);
            if (remaining === 0) {
              setImmediate(() => {
                rangeComplete = true;
                download.stream.unpipe(limiter);
                limiter.end();
                abortController.abort(new Error("Requested range complete"));
                download.cancel("Requested range complete");
              });
            }
          },
        });
        limiter.on("error", (error) => {
          if (!response.destroyed) response.destroy(error);
        });
        download.stream.pipe(limiter).pipe(response);
      } catch (error) {
        release();
        await rm(tempPath, { force: true });
        console.error("Could not start Soulseek stream:", error.message);
        if (!response.headersSent) sendError(response, 502, "Could not start Soulseek stream");
        else response.destroy(error);
        return;
      }
      return;
    }

    sendError(response, 404, "Not found");
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      console.error("Request failed:", error.message);
      if (!response.headersSent) sendError(response, 500, "Internal server error");
      else response.destroy(error);
    });
  });
  return { server, tracks };
}

async function main() {
  const username = process.env.SOULSEEK_USERNAME?.trim();
  const password = process.env.SOULSEEK_PASSWORD;
  if (!username || !password) {
    throw new Error("Set SOULSEEK_USERNAME and SOULSEEK_PASSWORD.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(SLUG)) {
    throw new Error("BITSEEKWIN_SLUG must contain only letters, digits, _ or -.");
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  const client = new SlskClient({
    timeout: 10000,
    transferTimeout: 30000,
    downloadTimeout: STREAM_TIMEOUT,
    uploads: false,
  });
  let server;
  client.on("server-error", (error) => {
    console.error("Soulseek server error:", error.message);
  });
  client.on("server-disconnect", ({ reconnecting }) => {
    console.error(`Soulseek disconnected; reconnecting=${reconnecting}`);
  });
  client.on("server-reconnect", () => console.error("Soulseek reconnected."));
  client.on("relogged", () => {
    console.error("Soulseek session was replaced by another login.");
    client.destroy();
    const stopServer = () => {
      server.closeAllConnections();
      server.close(() => process.exit(1));
    };
    if (server?.listening) stopServer();
    else if (server) server.once("listening", stopServer);
    else process.exitCode = 1;
  });

  try {
    await client.login(username, password);
    ({ server } = createAddonServer({ client }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, "0.0.0.0", resolve);
    });
    console.error(`\n${APP_NAME} v${VERSION}`);
    console.error(`Add this source in BitChord: ${PUBLIC_BASE_URL}/${SLUG}/${SECRET}`);
    console.error(
      `Listening on port ${PORT}; connected to Soulseek as ${username}; direct streaming enabled`,
    );
  } catch (error) {
    client.destroy();
    throw error;
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    client.destroy();
    server.closeAllConnections();
    server.close(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error("BitSeekWin startup failed:", error.message);
    process.exitCode = 1;
  });
}
