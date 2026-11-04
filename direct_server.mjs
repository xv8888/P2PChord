import { createHash, timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { FileAttribute, SlskClient } from "slsk-client";

const APP_NAME = "BitSeekWin - BitChord-Soulseek Integration";
const VERSION = (await readFile(new URL("./version.txt", import.meta.url), "utf8"))
  .trim();
const SLUG = process.env.BITSEEKWIN_SLUG ?? "bitseekwin";
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const SECRET_ONSETS = [
  "b", "br", "d", "dr", "f", "g", "gr", "h",
  "k", "kr", "l", "m", "n", "p", "pr", "s",
];
const SECRET_RIMES = [
  "a", "e", "i", "o", "u", "an", "en", "in",
  "on", "un", "ar", "er", "ir", "or", "ur", "y",
];
const SECRET = process.env.BITCHORD_SECRET ?? generateSourceSecret();
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

export function generateSourceSecret(bytes = randomBytes(16)) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    throw new TypeError("Source secret entropy must be exactly 16 bytes.");
  }
  const words = [];
  for (let offset = 0; offset < bytes.length; offset += 2) {
    const first = bytes[offset];
    const second = bytes[offset + 1];
    words.push(
      SECRET_ONSETS[first >> 4] +
        SECRET_RIMES[first & 15] +
        SECRET_ONSETS[second >> 4] +
        SECRET_RIMES[second & 15],
    );
  }
  return words.join("-");
}

function trackId(result) {
  return createHash("sha256")
    .update(`${result.user}\0${result.file}\0${result.size}`)
    .digest("hex")
    .slice(0, 24);
}

function normalizeName(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\.flac$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function editSimilarity(left, right) {
  if (!left || !right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

export function matchScore(query, filename) {
  const normalizedQuery = normalizeName(query);
  const normalizedName = normalizeName(
    filename.replaceAll("\\", "/").split("/").at(-1),
  );
  if (!normalizedQuery || !normalizedName) return 0;

  const queryTokens = new Set(normalizedQuery.split(" "));
  const nameTokens = new Set(normalizedName.split(" "));
  let overlap = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) overlap++;
  }
  const tokenRecall = overlap / queryTokens.size;
  const tokenPrecision = overlap / nameTokens.size;
  const tokenScore =
    tokenPrecision + tokenRecall === 0
      ? 0
      : (2 * tokenPrecision * tokenRecall) / (tokenPrecision + tokenRecall);
  const phraseScore =
    normalizedName.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedName)
      ? 1
      : 0;
  return (
    0.65 * tokenScore +
    0.25 * editSimilarity(normalizedQuery, normalizedName) +
    0.1 * phraseScore
  );
}

function trackMetadata(query, filename) {
  const basename = filename.replaceAll("\\", "/").split("/").at(-1)
    .replace(/\.flac$/i, "")
    .replaceAll("_", " ")
    .replace(/^\s*(?:\d{1,3}[\s._-]+)+/, "")
    .trim();
  const parts = basename.split(/\s+[-–—]\s+/, 2).map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { title: basename, artist: "" };
  }

  const queryCounts = countTokens(normalizeName(query).split(" "));
  const overlap = (value) => {
    const partCounts = countTokens(normalizeName(value).split(" "));
    return [...partCounts].reduce(
      (total, [token, count]) => total + Math.min(count, queryCounts.get(token) ?? 0),
      0,
    );
  };
  const leftOverlap = overlap(parts[0]);
  const rightOverlap = overlap(parts[1]);
  if (leftOverlap === rightOverlap) return { title: basename, artist: "" };

  const titleIndex = leftOverlap > rightOverlap ? 0 : 1;
  const artist = parts[1 - titleIndex];
  const artistTokens = normalizeName(artist).split(" ");
  const artistIsInQuery = artistTokens.length > 0 &&
    artistTokens.every((token) => queryCounts.has(token));
  return {
    title: parts[titleIndex],
    artist: artistIsInQuery ? artist : "",
  };
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    if (token) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
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

function validDuration(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
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
  logger = defaultLogger,
  secret = SECRET,
  slug = SLUG,
  publicBaseUrl = PUBLIC_BASE_URL,
  maxActiveStreams = MAX_ACTIVE_STREAMS,
  maxStreamBytes = MAX_STREAM_BYTES,
}) {
  const tracks = new Map();
  const peerTransfers = new Map();
  let activeStreams = 0;

  function log(level, message) {
    logger(level, message);
  }

  function notifyTransfer(state) {
    const resolve = state.resolveChange;
    state.changed = new Promise((next) => {
      state.resolveChange = next;
    });
    resolve();
  }

  function createPeerTransfer(track, transferKey) {
    const state = {
      trackSize: track.size,
      chunks: [],
      chunkEnds: [],
      receivedBytes: 0,
      finished: false,
      error: null,
      changed: null,
      resolveChange: null,
    };
    state.changed = new Promise((resolve) => {
      state.resolveChange = resolve;
    });

    activeStreams++;
    log("STREAM", `Opening one Soulseek transfer for "${track.title}" from ${track.user}.`);
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(new Error("Stream timed out")),
      STREAM_TIMEOUT,
    );
    timer.unref();
    const tempPath = join(TEMP_DIRECTORY, `${randomUUID()}.flac`);
    let download;
    let released = false;
    const finish = (error = null) => {
      if (state.finished) return;
      state.finished = true;
      state.error = error;
      notifyTransfer(state);
    };
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      activeStreams--;
      if (peerTransfers.get(transferKey) === state) {
        peerTransfers.delete(transferKey);
      }
      log("STREAM", `Stream slot released (${activeStreams} active).`);
    };

    try {
      download = client.download({
        ...track,
        path: tempPath,
        offset: 0,
        timeout: STREAM_TIMEOUT,
        signal: abortController.signal,
      });
    } catch (error) {
      release();
      throw error;
    }

    state.download = download;
    peerTransfers.set(transferKey, state);
    download.on("status", (status) => {
      const label = {
        requested: "Waiting for peer response",
        queued: "Queued by peer",
        connected: "Connected to peer",
        downloading: "Receiving audio bytes",
        interrupted: "Transfer interrupted; retrying",
        complete: "Peer transfer complete",
        failed: "Peer transfer failed",
        cancelled: "Transfer cancelled",
      }[status] ?? status;
      log("STREAM", `"${track.title}": ${label}.`);
    });
    download.on("queue", (place) => {
      log("STREAM", `"${track.title}" is queue position ${place} at ${track.user}.`);
    });
    let lastProgressBytes = 0;
    download.on("progress", (progress = {}) => {
      if (progress.receivedBytes - lastProgressBytes < 1024 * 1024) return;
      lastProgressBytes = progress.receivedBytes;
      const percentage = Number.isFinite(progress.progress)
        ? ` (${Math.round(progress.progress * 100)}%)`
        : "";
      log(
        "STREAM",
        `"${track.title}": ${formatBytes(progress.receivedBytes)} received${percentage}.`,
      );
    });
    download.on("data", (chunk) => {
      state.chunks.push(chunk);
      state.receivedBytes += chunk.length;
      state.chunkEnds.push(state.receivedBytes);
      if (state.receivedBytes === chunk.length) {
        log("STREAM", `First audio bytes received for "${track.title}".`);
      }
      notifyTransfer(state);
      if (state.receivedBytes > maxStreamBytes && !download.isSettled) {
        log("WARN", `"${track.title}" exceeded the stream-size limit.`);
        abortController.abort(new Error("Stream exceeded its size limit"));
      }
    });
    download.on("complete", (result = {}) => {
      log(
        "STREAM",
        `"${track.title}" finished: ${formatBytes(result.receivedBytes ?? track.size)} received.`,
      );
      finish();
    });
    download.on("failed", (error) => {
      log("ERROR", `"${track.title}" failed: ${error.message}`);
      finish(error);
    });
    download.then(
      () => rm(tempPath, { force: true }).catch((error) => {
        console.error("Could not remove temporary stream file:", error.message);
      }),
      (error) => {
        finish(error);
        return rm(tempPath, { force: true }).catch((cleanupError) => {
          console.error("Could not remove temporary stream file:", cleanupError.message);
        });
      },
    ).finally(release).catch(() => {});
    return state;
  }

  async function* readTransferRange(state, start, end, response) {
    let position = start;
    let chunkIndex = 0;
    while (position <= end) {
      if (response.destroyed) return;
      while (
        position >= state.receivedBytes &&
        !state.finished &&
        !response.destroyed
      ) {
        await state.changed;
      }
      if (response.destroyed) return;
      if (position >= state.receivedBytes) {
        throw state.error ?? new Error("Soulseek transfer ended before the requested range arrived");
      }
      while (
        chunkIndex < state.chunkEnds.length &&
        state.chunkEnds[chunkIndex] <= position
      ) {
        chunkIndex++;
      }
      const chunk = state.chunks[chunkIndex];
      if (!chunk) {
        throw new Error("Soulseek transfer bytes are unavailable");
      }
      const chunkStart = chunkIndex === 0 ? 0 : state.chunkEnds[chunkIndex - 1];
      const sliceEnd = Math.min(end + 1, state.chunkEnds[chunkIndex]);
      yield chunk.subarray(position - chunkStart, sliceEnd - chunkStart);
      position = sliceEnd;
    }
  }

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
        log("SEARCH", `Searching Soulseek for "${query}".`);
        const results = await client.search({ req: query, timeout: SEARCH_TIMEOUT });
        const candidates = [];
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
          const { title, artist } = trackMetadata(query, result.file);
          const track = {
            id,
            user: result.user,
            file: result.file,
            size: result.size,
            title,
            artist,
            duration: validDuration(result.attribs?.[FileAttribute.Duration]),
          };
          candidates.push({
            track,
            score: matchScore(query, `${title} ${artist}`),
            slots: result.slots === true,
            speed: Number.isFinite(result.speed) ? result.speed : 0,
            queueLength: Number.isFinite(result.queueLength)
              ? result.queueLength
              : Number.MAX_SAFE_INTEGER,
          });
        }
        candidates.sort((left, right) =>
          right.score - left.score ||
          Number(right.slots) - Number(left.slots) ||
          right.speed - left.speed ||
          left.queueLength - right.queueLength ||
          left.track.id.localeCompare(right.track.id)
        );
        const found = candidates.slice(0, SEARCH_LIMIT).map(({ track }) => track);
        if (found.length) {
          log(
            "SEARCH",
            `Found ${candidates.length} FLAC matches; returning ${found.length} ranked candidates. Best: "${found[0].title}"${found[0].artist ? ` by ${found[0].artist}` : ""}${found[0].duration ? ` (${found[0].duration}s)` : ""} (${Math.round(candidates[0].score * 100)}% name match).`,
          );
          for (const track of found) {
            tracks.delete(track.id);
            tracks.set(track.id, track);
            while (tracks.size > MAX_TRACKS) {
              tracks.delete(tracks.keys().next().value);
            }
          }
        } else {
          log("SEARCH", `No FLAC matches found for "${query}".`);
        }
        sendJson(response, 200, {
          tracks: found.map((track) => ({
            id: track.id,
            title: track.title,
            artist: track.artist,
            album: "",
            ...(track.duration ? { duration: track.duration } : {}),
            format: "flac",
            audioQuality: "LOSSLESS",
          })),
          albums: [],
          artists: [],
          playlists: [],
        });
      } catch (error) {
        log("ERROR", `Search failed for "${query}": ${error.message}`);
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
      log("STREAM", `BitChord requested the stream URL for "${track.title}".`);
      sendJson(response, 200, {
        url: `${publicBaseUrl}/${slug}/${secret}/file/${track.id}`,
        format: "flac",
        quality: "lossless",
        audioQuality: "LOSSLESS",
        codec: "flac",
        container: "flac",
        manifest: "none",
        mimeType: "audio/flac",
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
        log("WARN", `Rejected "${track.title}": file exceeds the stream-size limit.`);
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

      const transferKey = `${track.user}\0${track.file}`;
      log(
        "STREAM",
        `BitChord requested "${track.title}" from ${track.user} (${track.size} bytes${request.headers.range ? `, ${request.headers.range}` : ""}).`,
      );
      let transfer = peerTransfers.get(transferKey);
      if (transfer && transfer.trackSize !== track.size) {
        sendError(response, 409, "A different version of this peer file is already streaming");
        return;
      }
      if (!transfer && activeStreams >= maxActiveStreams) {
        log("WARN", `Rejected "${track.title}": stream limit reached.`);
        sendError(response, 503, "Too many active Soulseek streams");
        return;
      }
      try {
        if (!transfer) {
          transfer = createPeerTransfer(track, transferKey);
        } else {
          log(
            "STREAM",
            `Serving "${track.title}" from the active Soulseek transfer (${formatBytes(transfer.receivedBytes)} buffered).`,
          );
        }
      } catch (error) {
        console.error("Could not start Soulseek stream:", error.message);
        log("ERROR", `Could not start "${track.title}": ${error.message}`);
        if (!response.headersSent) sendError(response, 502, "Could not start Soulseek stream");
        return;
      }

      const range = Readable.from(readTransferRange(transfer, start, end, response));
      range.on("error", (error) => {
        if (response.destroyed) return;
        log("ERROR", `Audio stream for "${track.title}" failed: ${error.message}`);
        console.error("Soulseek stream failed:", error.message);
        response.destroy(error);
      });
      response.on("close", () => {
        if (!response.writableEnded) {
          log("WARN", `BitChord disconnected while streaming "${track.title}".`);
          notifyTransfer(transfer);
        }
      });
      response.writeHead(partial ? 206 : 200, headers);
      range.pipe(response);
      return;
    }

    sendError(response, 404, "Not found");
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      logger("ERROR", `HTTP request failed: ${error.message}`);
      console.error("Request failed:", error.message);
      if (!response.headersSent) sendError(response, 500, "Internal server error");
      else response.destroy(error);
    });
  });
  return { server, tracks };
}

function defaultLogger(level, message) {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`[${time}] [${level}] ${message}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    defaultLogger("ERROR", `Soulseek server error: ${error.message}`);
  });
  client.on("server-disconnect", ({ reconnecting }) => {
    defaultLogger("WARN", `Soulseek disconnected; reconnecting=${reconnecting}.`);
  });
  client.on("server-reconnect", () => defaultLogger("INFO", "Soulseek reconnected."));
  client.on("relogged", () => {
    defaultLogger("ERROR", "Soulseek session was replaced by another login.");
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
    defaultLogger("INFO", "Connected to Soulseek.");
    ({ server } = createAddonServer({ client }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, "0.0.0.0", resolve);
    });
    defaultLogger("INFO", `${APP_NAME} v${VERSION}.`);
    defaultLogger(
      "INFO",
      `Add this source in BitChord: ${PUBLIC_BASE_URL}/${SLUG}/${SECRET}`,
    );
    defaultLogger("INFO", `Listening on port ${PORT}; direct streaming enabled.`);
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
    defaultLogger("ERROR", `BitSeekWin startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
