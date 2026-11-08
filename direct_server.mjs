import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
  randomBytes,
} from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { FileAttribute, SlskClient } from "slsk-client";
import { createBitChordAuth } from "./bitchord_auth.mjs";
import { StreamCache } from "./stream_cache.mjs";
import { TorrentProvider } from "./torrent_provider.mjs";
import { TransferBudget } from "./transfer_budget.mjs";

const APP_NAME = "P2PChord";
const VERSION = (await readFile(new URL("./version.txt", import.meta.url), "utf8"))
  .trim();
const SOURCE_WORDS = JSON.parse(
  await readFile(new URL("./source_words.json", import.meta.url), "utf8"),
);
const DEFAULT_SECRET_WORD_COUNT = 2;
const DEFAULT_SECRET_WORD_LENGTH = 9;
const ALLOW_DOWNLOADS = readBooleanEnvironmentValue(
  "P2PCHORD_ALLOW_DOWNLOADS",
  false,
);
const BIND_ADDRESS = process.env.P2PCHORD_BIND_ADDRESS ?? "127.0.0.1";
const BITCHORD_AUTH_ENABLED = readBooleanEnvironmentValue(
  "P2PCHORD_BITCHORD_AUTH",
  false,
);
const SECRET_WORD_LENGTH_VARIANCE = 3;
const SECRET_WORD_COUNT = readIntegerEnvironmentValue(
  "P2PCHORD_WORD_COUNT",
  DEFAULT_SECRET_WORD_COUNT,
  2,
  8,
);
const SECRET_WORD_LENGTH = readIntegerEnvironmentValue(
  "P2PCHORD_WORD_LENGTH",
  DEFAULT_SECRET_WORD_LENGTH,
  3,
  9,
);
const SLUG = process.env.P2PCHORD_SLUG ?? "p2pchord";
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const SECRET =
  process.env.BITCHORD_SECRET ??
  generateSourceSecret(randomBytes(16), SECRET_WORD_COUNT, SECRET_WORD_LENGTH);
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${PORT}`
).replace(/\/+$/, "");
const SEARCH_TIMEOUT = readIntegerEnvironmentValue(
  "P2PCHORD_SEARCH_TIMEOUT_MS",
  2000,
  500,
  30000,
);
const LOGIN_TIMEOUT = 30000;
const SEARCH_LIMIT = readIntegerEnvironmentValue(
  "P2PCHORD_SEARCH_LIMIT",
  50,
  1,
  50,
);
const SEARCH_RECOVERY = readBooleanEnvironmentValue(
  "P2PCHORD_SEARCH_RECOVERY",
  true,
);
const MAX_TRACKS = 1000;
const TRACK_RETENTION_MS = 20 * 60 * 1000;
const MAX_TRACK_SEARCH_REQUESTS = 8;
const MAX_ACTIVE_STREAMS = readIntegerEnvironmentValue(
  "P2PCHORD_MAX_ACTIVE_STREAMS",
  2,
  1,
  2,
);
const MAX_STREAM_BYTES = readIntegerEnvironmentValue(
  "P2PCHORD_MAX_STREAM_BYTES",
  128 * 1024 * 1024,
  1,
  128 * 1024 * 1024,
);
const STREAM_TIMEOUT = 15 * 60 * 1000;
const SIGNED_MEDIA_URL_TTL_SECONDS = 15 * 60;
const FIRST_BYTE_TIMEOUT = readIntegerEnvironmentValue(
  "P2PCHORD_FIRST_BYTE_TIMEOUT_MS",
  30 * 1000,
  1000,
  5 * 60 * 1000,
);
const PEER_IDLE_TIMEOUT = readIntegerEnvironmentValue(
  "P2PCHORD_PEER_IDLE_TIMEOUT_MS",
  30 * 1000,
  1000,
  5 * 60 * 1000,
);
const IDLE_TRANSFER_TIMEOUT = readIntegerEnvironmentValue(
  "P2PCHORD_IDLE_TRANSFER_TIMEOUT_MS",
  30 * 1000,
  1,
  Number.MAX_SAFE_INTEGER,
);
const CACHE_TTL_MS = readIntegerEnvironmentValue(
  "P2PCHORD_CACHE_TTL_MS",
  30 * 60 * 1000,
  1,
  Number.MAX_SAFE_INTEGER,
);
const MAX_CACHE_BYTES = readIntegerEnvironmentValue(
  "P2PCHORD_CACHE_MAX_BYTES",
  2 * 1024 * 1024 * 1024,
  1,
  Number.MAX_SAFE_INTEGER,
);
const SOULSEEK_ENABLED = readBooleanEnvironmentValue(
  "P2PCHORD_SOULSEEK_ENABLED",
  true,
);
const TORRENT_ENABLED = readBooleanEnvironmentValue(
  "P2PCHORD_TORRENT_ENABLED",
  false,
);
const TORRENT_DISCOVERY_ENABLED = readBooleanEnvironmentValue(
  "P2PCHORD_TORRENT_DISCOVERY_ENABLED",
  false,
);
const ADMIN_TOKEN = process.env.P2PCHORD_ADMIN_TOKEN ?? "";
const TORRENT_SOURCES = readStringArrayEnvironmentValue(
  "P2PCHORD_TORRENT_SOURCES",
  [],
);
const TORRENT_DIRECTORY = resolve(
  process.env.P2PCHORD_TORRENT_DIRECTORY ??
    join(process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "P2PChord", "torrents"),
);
const MAX_TORRENT_STORAGE_BYTES = readIntegerEnvironmentValue(
  "P2PCHORD_TORRENT_STORAGE_MAX_BYTES",
  4 * 1024 * 1024 * 1024,
  1,
  Number.MAX_SAFE_INTEGER,
);
const CACHE_DIRECTORY = resolve(
  process.env.P2PCHORD_CACHE_DIRECTORY ??
    join(process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "P2PChord", "cache"),
);
const SOURCE_SELECTION = process.env.P2PCHORD_SOURCE_SELECTION ?? "match";
const SOURCE_SELECTION_MODES = new Set(["match", "speed"]);
const SEARCH_LIMIT_MAX = 50;
const SEARCH_RATE_LIMIT_BURST = 10;
const SEARCH_RATE_LIMIT_REFILL_MS = 1000;
if (!SOURCE_SELECTION_MODES.has(SOURCE_SELECTION)) {
  throw new TypeError("P2PCHORD_SOURCE_SELECTION must be 'match' or 'speed'.");
}

function readIntegerEnvironmentValue(name, defaultValue, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  if (!/^\d+$/.test(raw)) {
    throw new TypeError(`${name} must be a whole number.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readBooleanEnvironmentValue(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new TypeError(`${name} must be "true" or "false".`);
}

function readStringArrayEnvironmentValue(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError(`${name} must be a JSON string array.`);
  }
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some((entry) => typeof entry !== "string" || entry.length > 4096)
  ) {
    throw new TypeError(`${name} must contain at most 8 strings of at most 4096 characters.`);
  }
  return value;
}

export function generateSourceSecret(
  bytes = randomBytes(16),
  wordCount = DEFAULT_SECRET_WORD_COUNT,
  wordLength = DEFAULT_SECRET_WORD_LENGTH,
  phraseBytes = randomBytes(32),
) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    throw new TypeError("Source secret entropy must be exactly 16 bytes.");
  }
  if (!Buffer.isBuffer(phraseBytes) || phraseBytes.length !== 32) {
    throw new TypeError("Source phrase entropy must be exactly 32 bytes.");
  }
  if (!Number.isInteger(wordCount) || wordCount < 2 || wordCount > 8) {
    throw new RangeError("Source URL word count must be between 2 and 8.");
  }
  if (!Number.isInteger(wordLength) || wordLength < 3 || wordLength > 9) {
    throw new RangeError("Source URL word length must be between 3 and 9.");
  }
  const lowerLength = Math.max(3, wordLength - SECRET_WORD_LENGTH_VARIANCE);
  const upperLength = Math.min(9, wordLength + SECRET_WORD_LENGTH_VARIANCE);
  const words = Array.from({ length: wordCount }, (_, index) => {
    const lengthOffset =
      phraseBytes.readUInt16BE(index * 4) % (upperLength - lowerLength + 1);
    const actualLength = lowerLength + lengthOffset;
    const wordLists = index === wordCount - 1
      ? SOURCE_WORDS.nouns
      : SOURCE_WORDS.adjectives;
    const options = wordLists[String(actualLength)];
    if (!options?.length) {
      throw new RangeError(
        `No ${index === wordCount - 1 ? "noun" : "adjective"} words are available with ${actualLength} letters.`,
      );
    }
    return options[phraseBytes.readUInt16BE(index * 4 + 2) % options.length];
  });
  const token = bytes.toString("base64url").replaceAll("-", "~");
  return `${words.join("-")}-${token}`;
}

function sourcePhrase(secret) {
  const words = secret.split("-");
  if (/^[A-Za-z0-9_~]{22}$/.test(words.at(-1) ?? "")) words.pop();
  return words.join("-");
}

function trackId(result) {
  return createHash("sha256")
    .update(`${result.user}\0${result.file}\0${result.size}`)
    .digest("hex")
    .slice(0, 24);
}

function foldDiacritics(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[Ææ]/gu, (character) => character === "Æ" ? "AE" : "ae")
    .replace(/[Œœ]/gu, (character) => character === "Œ" ? "OE" : "oe")
    .replace(/[ßẞ]/gu, "ss")
    .replace(/[Øø]/gu, (character) => character === "Ø" ? "O" : "o")
    .replace(/[Łł]/gu, (character) => character === "Ł" ? "L" : "l")
    .replace(/[ĐđÐð]/gu, (character) => /[ĐÐ]/u.test(character) ? "D" : "d")
    .replace(/[Þþ]/gu, (character) => character === "Þ" ? "TH" : "th");
}

export function normalizeSearchQuery(value) {
  return foldDiacritics(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function insertMissingVowels(word) {
  const vowels = ["e", "a", "i", "o", "u"];
  for (let index = 0; index < word.length - 1; index++) {
    if (!/[bcdfghjklmnpqrstvwxyz]/i.test(word[index]) ||
        !/[bcdfghjklmnpqrstvwxyz]/i.test(word[index + 1])) {
      continue;
    }
    for (const vowel of vowels) {
      return `${word.slice(0, index + 1)}${vowel}${word.slice(index + 1)}`;
    }
  }
  return null;
}

function searchRecoveryQuery(query) {
  const words = query.split(" ");
  const hasCompressedWord = words.some((word) =>
    /[bcdfghjklmnpqrstvwxyz]{3}/i.test(word),
  );
  if (!hasCompressedWord) return null;

  const recovered = words.map((word) => {
    const likelyCompressed = /[bcdfghjklmnpqrstvwxyz]{3}/i.test(word) ||
      /^[bcdfghjklmnpqrstvwxyz]{2}[aeiou][bcdfghjklmnpqrstvwxyz]$/i.test(word);
    return likelyCompressed ? insertMissingVowels(word) ?? word : word;
  }).join(" ");
  return recovered === query ? null : recovered;
}

function normalizeName(value) {
  return foldDiacritics(value)
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
  torrentProvider = null,
  transferBudget,
  logger = defaultLogger,
  secret = SECRET,
  slug = SLUG,
  publicBaseUrl = PUBLIC_BASE_URL,
  requireBitChordAuth = BITCHORD_AUTH_ENABLED,
  bitChordAuthOptions,
  adminToken = ADMIN_TOKEN,
  torrentDiscoveryEnabled = TORRENT_DISCOVERY_ENABLED,
  allowDownloads = ALLOW_DOWNLOADS,
  sourceSelection = SOURCE_SELECTION,
  searchLimit = SEARCH_LIMIT,
  searchTimeout = SEARCH_TIMEOUT,
  searchRecovery = SEARCH_RECOVERY,
  getConnectionStatus = () => "unknown",
  maxTrackRecords = MAX_TRACKS,
  trackRetentionMs = TRACK_RETENTION_MS,
  maxActiveStreams = MAX_ACTIVE_STREAMS,
  maxStreamBytes = MAX_STREAM_BYTES,
  firstByteTimeout = FIRST_BYTE_TIMEOUT,
  peerIdleTimeout = PEER_IDLE_TIMEOUT,
  idleTransferTimeout = IDLE_TRANSFER_TIMEOUT,
  cacheDirectory = CACHE_DIRECTORY,
  cacheTtlMs = CACHE_TTL_MS,
  maxCacheBytes = MAX_CACHE_BYTES,
  validateFlac = true,
  writeBatchBytes,
  writeBatchDelayMs,
}) {
  if (typeof requireBitChordAuth !== "boolean") {
    throw new TypeError("requireBitChordAuth must be true or false.");
  }
  if (!client && !torrentProvider) {
    throw new TypeError("At least one audio source provider must be enabled.");
  }
  if (typeof validateFlac !== "boolean") {
    throw new TypeError("validateFlac must be true or false.");
  }
  const parsedPublicBaseUrl = new URL(publicBaseUrl);
  const publicHost = parsedPublicBaseUrl.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const loopback =
    publicHost === "localhost" ||
    publicHost.endsWith(".localhost") ||
    publicHost === "::1" ||
    (isIP(publicHost) === 4 && publicHost.split(".")[0] === "127");
  if (
    requireBitChordAuth &&
    parsedPublicBaseUrl.protocol !== "https:" &&
    !(parsedPublicBaseUrl.protocol === "http:" && loopback)
  ) {
    throw new TypeError(
      "BitChord authentication requires HTTPS, except for loopback development URLs.",
    );
  }
  const bitChordAuth = requireBitChordAuth
    ? createBitChordAuth({
        hosts: [publicHost],
        ...bitChordAuthOptions,
      })
    : null;
  const mediaSigningKey = randomBytes(32);
  if (typeof allowDownloads !== "boolean") {
    throw new TypeError("allowDownloads must be true or false.");
  }
  if (!SOURCE_SELECTION_MODES.has(sourceSelection)) {
    throw new TypeError("sourceSelection must be 'match' or 'speed'.");
  }
  if (
    !Number.isSafeInteger(searchLimit) ||
    searchLimit < 1 ||
    searchLimit > SEARCH_LIMIT_MAX
  ) {
    throw new RangeError(`searchLimit must be between 1 and ${SEARCH_LIMIT_MAX}.`);
  }
  if (
    !Number.isSafeInteger(searchTimeout) ||
    searchTimeout < 500 ||
    searchTimeout > 30000
  ) {
    throw new RangeError("searchTimeout must be between 500 and 30000 milliseconds.");
  }
  if (typeof searchRecovery !== "boolean") {
    throw new TypeError("searchRecovery must be true or false.");
  }
  if (
    !Number.isSafeInteger(maxActiveStreams) ||
    maxActiveStreams < 1 ||
    maxActiveStreams > 2
  ) {
    throw new RangeError("maxActiveStreams must be between 1 and 2.");
  }
  if (
    !Number.isSafeInteger(maxStreamBytes) ||
    maxStreamBytes < 1 ||
    maxStreamBytes > 128 * 1024 * 1024
  ) {
    throw new RangeError("maxStreamBytes must be between 1 and 134217728 bytes.");
  }
  if (!Number.isSafeInteger(firstByteTimeout) || firstByteTimeout < 1) {
    throw new RangeError("firstByteTimeout must be a positive whole number.");
  }
  if (!Number.isSafeInteger(peerIdleTimeout) || peerIdleTimeout < 1) {
    throw new RangeError("peerIdleTimeout must be a positive whole number.");
  }
  if (!Number.isSafeInteger(idleTransferTimeout) || idleTransferTimeout < 1) {
    throw new RangeError("idleTransferTimeout must be a positive whole number.");
  }
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 1) {
    throw new RangeError("cacheTtlMs must be a positive whole number.");
  }
  if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1) {
    throw new RangeError("maxCacheBytes must be a positive whole number.");
  }
  if (
    writeBatchBytes !== undefined &&
    (!Number.isSafeInteger(writeBatchBytes) || writeBatchBytes < 1)
  ) {
    throw new RangeError("writeBatchBytes must be a positive whole number.");
  }
  if (
    writeBatchDelayMs !== undefined &&
    (!Number.isSafeInteger(writeBatchDelayMs) || writeBatchDelayMs < 0)
  ) {
    throw new RangeError("writeBatchDelayMs must be a non-negative whole number.");
  }
  if (!Number.isSafeInteger(maxTrackRecords) || maxTrackRecords < 1) {
    throw new RangeError("maxTrackRecords must be a positive whole number.");
  }
  if (!Number.isSafeInteger(trackRetentionMs) || trackRetentionMs < 1) {
    throw new RangeError("trackRetentionMs must be a positive whole number.");
  }
  const tracks = new Map();
  const trackState = new Map();
  const searchRateLimits = new Map();
  const sharedTransferBudget = transferBudget ?? new TransferBudget(maxActiveStreams);

  function log(level, message) {
    logger(level, sanitizeLogMessage(message));
  }

  function searchRateLimitDelay(address, now = Date.now()) {
    for (const [key, state] of searchRateLimits) {
      if (now - state.updatedAt > SEARCH_RATE_LIMIT_BURST * SEARCH_RATE_LIMIT_REFILL_MS) {
        searchRateLimits.delete(key);
      }
    }
    if (!searchRateLimits.has(address) && searchRateLimits.size >= 1024) {
      searchRateLimits.delete(searchRateLimits.keys().next().value);
    }
    const state = searchRateLimits.get(address) ?? {
      tokens: SEARCH_RATE_LIMIT_BURST,
      updatedAt: now,
    };
    state.tokens = Math.min(
      SEARCH_RATE_LIMIT_BURST,
      state.tokens + (now - state.updatedAt) / SEARCH_RATE_LIMIT_REFILL_MS,
    );
    state.updatedAt = now;
    if (state.tokens < 1) {
      searchRateLimits.set(address, state);
      return Math.ceil(1 - state.tokens);
    }
    state.tokens--;
    searchRateLimits.set(address, state);
    return 0;
  }

  function pruneTrackRecords(now = Date.now()) {
    for (const [id, state] of trackState) {
      if (now - state.lastUsedAt >= trackRetentionMs) {
        const track = tracks.get(id);
        if (track && isTrackActive(track)) {
          state.lastUsedAt = now;
          continue;
        }
        tracks.delete(id);
        trackState.delete(id);
        log("INFO", `Expired stream result id=${id} after ${trackRetentionMs}ms without use.`);
      }
    }
  }

  function rememberTrack(track, searchRequestId, now = Date.now()) {
    const state = trackState.get(track.id) ?? {
      lastUsedAt: now,
      searchRequestIds: [],
    };
    state.lastUsedAt = now;
    state.searchRequestIds.push(searchRequestId);
    if (state.searchRequestIds.length > MAX_TRACK_SEARCH_REQUESTS) {
      state.searchRequestIds.shift();
    }
    tracks.set(track.id, track);
    trackState.set(track.id, state);
  }

  function resolveTrack(id, requestId, action) {
    const track = tracks.get(id);
    const state = trackState.get(id);
    const now = Date.now();
    const expired = state && now - state.lastUsedAt >= trackRetentionMs;
    if (!track || !state || (expired && !isTrackActive(track))) {
      tracks.delete(id);
      trackState.delete(id);
      log(
        "WARN",
        `${action} request ${requestId}: result id=${id} resolvable=false (unknown or expired).`,
      );
      return null;
    }
    state.lastUsedAt = now;
    log(
      "INFO",
      `${action} request ${requestId}: result id=${id} resolvable=true; ` +
        `searchRequests=${state.searchRequestIds.join(",")}; ` +
        `file="${track.file}" peer=${track.user}.`,
    );
    return { track, searchRequestIds: [...state.searchRequestIds] };
  }

  function isTrackActive(track) {
    return Boolean(
      sourceProviders.get(track.provider)?.hasActiveTrackUse(track),
    );
  }

  function signMediaUrl(trackId) {
    const expires = Math.floor(Date.now() / 1000) + SIGNED_MEDIA_URL_TTL_SECONDS;
    const signature = createHmac("sha256", mediaSigningKey)
      .update(`${trackId}.${expires}`)
      .digest("base64url");
    return `?expires=${expires}&signature=${signature}`;
  }

  function validMediaSignature(trackId, url) {
    if (!requireBitChordAuth) return true;
    const expires = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("signature") ?? "";
    if (
      !Number.isSafeInteger(expires) ||
      expires < Math.floor(Date.now() / 1000) ||
      expires > Math.floor(Date.now() / 1000) + SIGNED_MEDIA_URL_TTL_SECONDS ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    ) {
      return false;
    }
    const expected = createHmac("sha256", mediaSigningKey)
      .update(`${trackId}.${expires}`)
      .digest();
    const received = Buffer.from(signature, "base64url");
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  const streamCache = new StreamCache({
    client,
    logger: log,
    directory: cacheDirectory,
    ttlMs: cacheTtlMs,
    maxBytes: maxCacheBytes,
    maxActiveStreams,
    transferBudget: sharedTransferBudget,
    maxStreamBytes,
    validateFlac,
    streamTimeout: STREAM_TIMEOUT,
    firstByteTimeout,
    peerIdleTimeout,
    idleTransferTimeout,
    formatBytes,
    ...(writeBatchBytes !== undefined ? { writeBatchBytes } : {}),
    ...(writeBatchDelayMs !== undefined ? { writeBatchDelayMs } : {}),
  });
  const sourceProviders = new Map([
    ["soulseek", streamCache],
    ...(torrentProvider ? [["torrent", torrentProvider]] : []),
  ]);

  async function handle(request, response) {
    const requestStartedAt = performance.now();
    response.on("error", (error) => {
      console.error("HTTP response failed:", sanitizeLogMessage(error.message));
    });
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
    );
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Range, If-Range, Content-Type, X-BitChord-Token, X-BitChord-Proof, X-P2PChord-Admin-Token",
        "Access-Control-Max-Age": "86400",
      });
      response.end();
      return;
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "POST"
    ) {
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

    if (
      request.method === "POST" &&
      !(
        route.length === 3 &&
        route[0] === "admin" &&
        route[1] === "torrents" &&
        route[2] === "import"
      )
    ) {
      sendError(response, 405, "Method not allowed");
      return;
    }

    if (
      route.length === 3 &&
      route[0] === "admin" &&
      route[1] === "torrents" &&
      route[2] === "import" &&
      request.method === "POST"
    ) {
      if (
        !torrentDiscoveryEnabled ||
        !adminToken ||
        !safeEqual(request.headers["x-p2pchord-admin-token"] ?? "", adminToken)
      ) {
        sendError(response, 403, "Not authorized");
        return;
      }
      if (!torrentProvider) {
        sendError(response, 503, "BitTorrent provider is disabled");
        return;
      }
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
        sendError(response, 415, "Expected a JSON request");
        return;
      }
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 3 * 1024 * 1024) {
            throw new RangeError("Torrent import request exceeds the size limit.");
          }
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let source;
        if (typeof payload.magnet === "string" && payload.magnet.length <= 4096) {
          source = payload.magnet;
        } else if (
          typeof payload.torrentBase64 === "string" &&
          payload.torrentBase64.length <= 2 * 1024 * 1024 * 4 / 3 + 4
        ) {
          source = Buffer.from(payload.torrentBase64, "base64");
          if (source.toString("base64") !== payload.torrentBase64) {
            throw new TypeError("Invalid torrent metadata encoding.");
          }
        } else {
          throw new TypeError("Import requires a magnet URI or torrent metadata.");
        }
        await torrentProvider.addSource(source);
        sendJson(response, 202, { status: "Import started" });
      } catch (error) {
        sendError(response, 400, error.message);
      }
      return;
    }

    if (
      bitChordAuth &&
      request.method === "GET" &&
      (route[0] === "search" || route[0] === "stream")
    ) {
      const result = await bitChordAuth.verifyRequest(request);
      if (!result.ok) {
        const denied = bitChordAuth.rejection(result);
        response.writeHead(denied.status, denied.headers);
        response.end(denied.body);
        return;
      }
    }

    if (route.length === 1 && route[0] === "monitoring" && request.method === "GET") {
      try {
        const providerStatus = {};
        if (client) {
          Object.assign(providerStatus, await streamCache.getMonitoringSnapshot());
        }
        if (torrentProvider) {
          providerStatus.torrent = torrentProvider.getMonitoringSnapshot();
        }
        sendJson(response, 200, {
          connection: getConnectionStatus(),
          ...providerStatus,
        });
      } catch (error) {
        log("ERROR", `Could not read monitoring status: ${error.message}`);
        sendError(response, 500, "Could not read monitoring status");
      }
      return;
    }

    if (route.length === 1 && route[0] === "manifest.json") {
      sendJson(
        response,
        200,
        {
          id: `p2pchord-addon.${slug}`,
          name: `${APP_NAME} [${sourcePhrase(secret)}]`,
          version: VERSION,
          description:
            "Search and stream FLAC files directly from Soulseek peers and configured torrents to BitChord.",
          resources: ["search", "stream"],
          types: ["track"],
          contentType: "music",
          allowDownloads,
          ...(requireBitChordAuth ? { bitchordAuth: true } : {}),
        },
        request.method === "HEAD",
      );
      return;
    }

    if (route.length === 1 && route[0] === "search" && request.method === "GET") {
      const retryAfter = searchRateLimitDelay(
        request.socket.remoteAddress ?? "unknown",
      );
      if (retryAfter) {
        response.setHeader("Retry-After", String(retryAfter));
        sendError(response, 429, "Search rate limit exceeded; retry shortly");
        return;
      }
      const searchRequestId = randomUUID();
      const query = normalizeSearchQuery(url.searchParams.get("q") ?? "");
      if (!query) {
        log("SEARCH", `Search request ${searchRequestId} received an empty query; HTTP 200 with no results.`);
        sendJson(response, 200, {
          tracks: [],
          albums: [],
          artists: [],
          playlists: [],
        });
        return;
      }
      try {
        const candidates = [];
        if (client) {
          log("SEARCH", `Search request ${searchRequestId}: searching Soulseek for "${query}".`);
          let results = await client.search({ req: query, timeout: searchTimeout });
          if (searchRecovery && results.length === 0) {
            const recoveryQuery = searchRecoveryQuery(query);
            if (recoveryQuery) {
              log(
                "SEARCH",
                `Search request ${searchRequestId}: no exact results; retrying with likely missing vowels as "${recoveryQuery}".`,
              );
              results = await client.search({
                req: recoveryQuery,
                timeout: searchTimeout,
              });
            }
          }
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
            const { title, artist } = trackMetadata(query, result.file);
            const track = {
              id,
              provider: "soulseek",
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
        }
        if (torrentProvider) {
          for (const result of torrentProvider.search(query)) {
            if (!isSafeFlac(result.file) || result.size > maxStreamBytes) continue;
            const { title, artist } = trackMetadata(query, result.file);
            const track = { ...result, title, artist };
            candidates.push({
              track,
              score: matchScore(query, `${title} ${artist}`),
              slots: result.slots,
              speed: result.speed,
              queueLength: result.queueLength,
            });
          }
        }
        const seen = new Set();
        const uniqueCandidates = candidates.filter(({ track }) => {
          if (seen.has(track.id)) return false;
          seen.add(track.id);
          return true;
        });
        uniqueCandidates.sort((left, right) => {
          const speedOrder = right.speed - left.speed;
          const matchOrder = right.score - left.score;
          const slotOrder = Number(right.slots) - Number(left.slots);
          const preferenceOrder = sourceSelection === "speed"
            ? speedOrder || matchOrder || slotOrder
            : matchOrder || slotOrder || speedOrder;
          return (
            preferenceOrder ||
            left.queueLength - right.queueLength ||
            left.track.id.localeCompare(right.track.id)
          );
        });
        const selectedCandidates = uniqueCandidates.slice(
          0,
          sourceSelection === "speed" ? 1 : searchLimit,
        );
        const found = selectedCandidates.map(({ track }) => track);
        pruneTrackRecords();
        const newResultCount = found.filter((track) => !tracks.has(track.id)).length;
        if (tracks.size + newResultCount > maxTrackRecords) {
          log(
            "ERROR",
            `Search request ${searchRequestId} could not retain ${newResultCount} new results; ` +
              `result registry is full (${tracks.size}/${maxTrackRecords}); HTTP 503.`,
          );
          sendError(response, 503, "Track result registry is full; retry after existing results expire");
          return;
        }
        if (found.length) {
          const bestDescription = sourceSelection === "speed"
            ? found[0].provider === "soulseek"
              ? `selected the fastest reported uploader "${found[0].user}" at reported speed ${uniqueCandidates[0].speed}: `
              : `selected the fastest ${found[0].provider} source "${found[0].user}" at reported/observed speed ${uniqueCandidates[0].speed}: `
            : `best match: `;
          const resultLabel = found.length === 1 ? "candidate" : "candidates";
          log(
            "SEARCH",
            `Search request ${searchRequestId}: found ${uniqueCandidates.length} FLAC matches; returning ${found.length} ${
              sourceSelection === "speed" ? "fastest-speed" : "ranked"
            } ${resultLabel}. ${bestDescription}"${found[0].title}"${found[0].artist ? ` by ${found[0].artist}` : ""}${found[0].duration ? ` (${found[0].duration}s)` : ""}.`,
          );
          const selectedCandidateSet = new Set(selectedCandidates);
          for (const candidate of uniqueCandidates.slice(0, SEARCH_LIMIT_MAX)) {
            const { track } = candidate;
            const selected = selectedCandidateSet.has(candidate);
            if (selected) rememberTrack(track, searchRequestId);
            log(
              "SEARCH",
              `Search request ${searchRequestId}: provider=${track.provider} result id=${track.id} file="${track.file}" source=${track.user}; ` +
                `selectedForBitChord=${selected} ` +
                `slotsAvailable=${candidate.slots} reportedSpeed=${candidate.speed} ` +
                `queueLength=${candidate.queueLength === Number.MAX_SAFE_INTEGER ? "unknown" : candidate.queueLength} ` +
                `matchScore=${candidate.score.toFixed(3)}.`,
            );
          }
        } else {
          log("SEARCH", `Search request ${searchRequestId}: no FLAC matches found for "${query}".`);
        }
        log(
          "SEARCH",
          `Search request ${searchRequestId} completed with ${found.length} results; HTTP 200.`,
        );
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
        log("ERROR", `Search request ${searchRequestId} failed for "${query}": ${error.message}; HTTP 502.`);
        console.error("Source search failed:", sanitizeLogMessage(error.message));
        sendError(response, 502, "Source search failed");
      }
      return;
    }

    if (
      route.length === 2 &&
      route[0] === "stream" &&
      request.method === "GET"
    ) {
      const requestId = randomUUID();
      const resultId = route[1];
      log("STREAM", `Stream descriptor request ${requestId} received for result id=${resultId}.`);
      const resolved = resolveTrack(resultId, requestId, "Stream descriptor");
      if (!resolved) {
        log("WARN", `Stream descriptor request ${requestId} failed: result id=${resultId} was not resolvable; HTTP 404.`);
        sendError(response, 404, "Track not found or expired; search again");
        return;
      }
      const { track, searchRequestIds } = resolved;
      log("STREAM", `BitChord requested the stream URL for "${track.title}".`);
      log(
        "STREAM",
        `Stream descriptor request ${requestId} resolved result id=${track.id}; ` +
          `searchRequests=${searchRequestIds.join(",")}; file="${track.file}" peer=${track.user}; HTTP 200.`,
      );
      sendJson(response, 200, {
        url:
          `${publicBaseUrl}/${slug}/${secret}/file/${encodeURIComponent(track.id)}` +
          (requireBitChordAuth ? signMediaUrl(track.id) : ""),
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
      const requestId = randomUUID();
      const resultId = route[1];
      if (!validMediaSignature(resultId, url)) {
        sendError(response, 403, "Media URL is invalid or expired; resolve the stream again");
        return;
      }
      const rangeHeader = request.headers.range ?? "";
      log(
        "STREAM",
        `File request ${requestId} received for result id=${resultId}; range="${rangeHeader || "full"}" (+0.0ms).`,
      );
      const resolved = resolveTrack(resultId, requestId, "File");
      if (!resolved) {
        log("WARN", `File request ${requestId} failed: result id=${resultId} was not resolvable; HTTP 404.`);
        sendError(response, 404, "Track not found or expired; search again");
        return;
      }
      const { track, searchRequestIds } = resolved;
      if (track.size > maxStreamBytes) {
        log("WARN", `File request ${requestId} rejected result id=${track.id} file="${track.file}" peer=${track.user}; size limit exceeded; HTTP 413.`);
        sendError(response, 413, "File exceeds the in-memory stream size limit");
        return;
      }

      let start;
      let end;
      try {
        [start, end] = parseRange(request.headers.range, track.size);
      } catch {
        log(
          "WARN",
          `File request ${requestId} rejected result id=${track.id}; invalid or unsatisfiable range="${rangeHeader}"; HTTP 416.`,
        );
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
      const openEndedRange = /^bytes=\d+-$/.test(request.headers.range ?? "");
      const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers":
          "Content-Length, Content-Range, Accept-Ranges",
        "Accept-Ranges": "bytes",
        "Content-Type": "audio/flac",
        "Cache-Control": "no-store, no-transform",
      };
      if (request.method === "HEAD" || (partial && !openEndedRange)) {
        headers["Content-Length"] = length;
      }
      if (partial) {
        // Do not advertise the complete length while bytes are still arriving:
        // progressive FLAC readers may otherwise seek to the tail before play.
        headers["Content-Range"] = request.method === "HEAD"
          ? `bytes ${start}-${end}/${track.size}`
          : `bytes ${start}-${end}/*`;
      }
      if (request.method === "HEAD") {
        log(
          "STREAM",
          `File request ${requestId} resolved result id=${track.id}; ` +
            `searchRequests=${searchRequestIds.join(",")}; file="${track.file}" peer=${track.user}; ` +
            `range="${rangeHeader || "full"}"; HTTP ${partial ? 206 : 200} (HEAD).`,
        );
        response.writeHead(partial ? 206 : 200, headers);
        response.end();
        return;
      }

      log(
        "STREAM",
        `BitChord requested "${track.title}" from ${track.provider} source ${track.user} (${track.size} bytes${request.headers.range ? `, ${request.headers.range}` : ""}).`,
      );
      const provider = sourceProviders.get(track.provider);
      if (!provider) {
        sendError(response, 502, "Audio source provider is unavailable");
        return;
      }
      let entry;
      try {
        entry = await provider.getEntry(track);
        await provider.touch(entry);
        log(
          "STREAM",
          `File request ${requestId} cache entry ready (+${(performance.now() - requestStartedAt).toFixed(1)}ms).`,
        );
      } catch (error) {
        if (entry) provider.removeConsumer(entry);
        log("ERROR", `File request ${requestId} could not open result id=${track.id} file="${track.file}" peer=${track.user}: ${error.message}; HTTP 500.`);
        sendError(response, 500, "Could not open stream cache");
        return;
      }

      try {
        const complete = entry.complete ?? entry.done ?? false;
        const needsTransfer = track.provider === "torrent"
          ? !complete
          : !entry.complete && entry.receivedBytes <= end;
        if (needsTransfer) {
          await provider.ensureTransfer(entry, track, {
            requestId,
            searchRequestIds,
            requestStartedAt,
          });
        } else if (entry.activeTransfer || entry.releaseSlot) {
          log(
            "STREAM",
            `File request ${requestId} reuses existing transfer for result id=${track.id}; ` +
              `searchRequests=${searchRequestIds.join(",")}; file="${track.file}" peer=${track.user}.`,
          );
        } else {
          log(
            "STREAM",
            `File request ${requestId} uses ${entry.complete ? "completed cache" : "partial cache"} ` +
              `for result id=${track.id}; file="${track.file}" peer=${track.user}.`,
          );
        }
        await provider.sweep();
      } catch (error) {
        provider.removeConsumer(entry);
        if (error.statusCode === 503 || error.message === "Too many active Soulseek streams") {
          log(
            "WARN",
            `File request ${requestId} could not start result id=${track.id} file="${track.file}" peer=${track.user}; ` +
              `transfer slots unavailable; HTTP 503.`,
          );
          sendError(response, 503, error.message);
        } else if (error.statusCode === 409) {
          log("WARN", `File request ${requestId} rejected result id=${track.id} file="${track.file}" peer=${track.user}: ${error.message}; HTTP 409.`);
          sendError(response, 409, error.message);
        } else {
          log("ERROR", `File request ${requestId} could not start result id=${track.id} file="${track.file}" peer=${track.user}: ${error.message}; HTTP 502.`);
          sendError(response, 502, "Could not start source stream");
        }
        return;
      }

      if (partial) {
        headers["Content-Range"] = (entry.complete ?? entry.done)
          ? `bytes ${start}-${end}/${track.size}`
          : `bytes ${start}-${end}/*`;
      }
      const streamAbort = new AbortController();
      const range = Readable.from(
        provider.readRange(
          entry,
          start,
          end,
          response,
          streamAbort.signal,
          () => log(
            "STREAM",
            `File request ${requestId} first cache bytes became readable (+${(performance.now() - requestStartedAt).toFixed(1)}ms).`,
          ),
        ),
      );
      range.on("error", (error) => {
        if (response.destroyed) return;
        log(
          "ERROR",
          `File request ${requestId} streaming result id=${track.id} file="${track.file}" ` +
            `peer=${track.user} failed${response.headersSent ? ` after HTTP ${response.statusCode} began` : " before audio started"}: ${error.message}` +
            `${response.headersSent ? "." : "; HTTP 502."}`,
        );
        console.error("Source stream failed:", sanitizeLogMessage(error.message));
        if (response.headersSent) {
          response.destroy(error);
        } else {
          sendError(
            response,
            502,
            track.provider === "soulseek"
              ? "Soulseek peer transfer failed before audio started"
              : "Torrent transfer failed before audio started",
          );
        }
      });
      let firstReadableAt = null;
      range.once("data", () => {
        firstReadableAt = performance.now();
        log(
          "STREAM",
          `File request ${requestId} first HTTP-readable audio chunk (+${(firstReadableAt - requestStartedAt).toFixed(1)}ms).`,
        );
        if (!response.headersSent) {
          response.writeHead(partial ? 206 : 200, headers);
        }
      });
      const responseWrite = response.write.bind(response);
      let firstResponseBodyWrite = false;
      response.write = (...args) => {
        const result = responseWrite(...args);
        const chunk = args[0];
        if (
          firstReadableAt !== null &&
          !firstResponseBodyWrite &&
          typeof chunk !== "undefined" &&
          chunk !== null &&
          typeof chunk.length === "number" &&
          chunk.length > 0
        ) {
          firstResponseBodyWrite = true;
          log(
            "STREAM",
            `File request ${requestId} first audio byte queued to HTTP response (+${(performance.now() - requestStartedAt).toFixed(1)}ms).`,
          );
        }
        return result;
      };
      response.on("close", () => {
        if (!response.writableEnded) {
          log("WARN", `BitChord disconnected while streaming "${track.title}".`);
        }
        range.destroy();
        streamAbort.abort();
        provider.removeConsumer(entry);
      });
      log(
        "STREAM",
        `File request ${requestId} waiting for audio to start result id=${track.id}; ` +
          `searchRequests=${searchRequestIds.join(",")}; file="${track.file}" peer=${track.user}; ` +
          `range="${rangeHeader || "full"}"; transfer=${entry.complete ? "cached" : entry.activeTransfer ? "active" : "partial"}; ` +
          `elapsed=+${(performance.now() - requestStartedAt).toFixed(1)}ms.`,
      );
      range.pipe(response);
      return;
    }

    sendError(response, 404, "Not found");
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      logger("ERROR", `HTTP request failed: ${error.message}`);
      console.error("Request failed:", sanitizeLogMessage(error.message));
      if (!response.headersSent) sendError(response, 500, "Internal server error");
      else response.destroy(error);
    });
  });
  return { server, tracks, streamCache };
}

function defaultLogger(level, message) {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const safeMessage = sanitizeLogMessage(message);
  console.log(`[${time}] [${level}] ${safeMessage}`);
}

function sanitizeLogMessage(message) {
  return String(message).replace(/[\x00-\x1f\x7f]/g, " ");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const username = process.env.SOULSEEK_USERNAME?.trim();
  const password = process.env.SOULSEEK_PASSWORD;
  if (SOULSEEK_ENABLED && (!username || !password)) {
    throw new Error("Set SOULSEEK_USERNAME and SOULSEEK_PASSWORD.");
  }
  if (!SOULSEEK_ENABLED && !TORRENT_ENABLED) {
    throw new Error("Enable at least one source with P2PCHORD_SOULSEEK_ENABLED or P2PCHORD_TORRENT_ENABLED.");
  }
  if (
    TORRENT_ENABLED &&
    TORRENT_SOURCES.length === 0 &&
    !TORRENT_DISCOVERY_ENABLED
  ) {
    throw new Error("Set P2PCHORD_TORRENT_SOURCES when BitTorrent is enabled.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(SLUG)) {
    throw new Error("P2PCHORD_SLUG must contain only letters, digits, _ or -.");
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  if (!isIP(BIND_ADDRESS)) {
    throw new Error("P2PCHORD_BIND_ADDRESS must be an IP address.");
  }

  const transferBudget = new TransferBudget(MAX_ACTIVE_STREAMS);
  const client = SOULSEEK_ENABLED
    ? new SlskClient({
      timeout: LOGIN_TIMEOUT,
      transferTimeout: 30000,
      downloadTimeout: STREAM_TIMEOUT,
      uploads: false,
    })
    : null;
  const torrentProvider = TORRENT_ENABLED
    ? new TorrentProvider({
      logger: defaultLogger,
      directory: TORRENT_DIRECTORY,
      sources: TORRENT_SOURCES,
      maxFileBytes: MAX_STREAM_BYTES,
      maxStorageBytes: MAX_TORRENT_STORAGE_BYTES,
      idleTransferTimeout: IDLE_TRANSFER_TIMEOUT,
      transferBudget,
    })
    : null;
  let server;
  let streamCache;
  let connectionStatus = client ? "connecting" : "disabled";
  let stopping = false;
  const shutdown = (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    let serverClosed = Promise.resolve(null);
    if (server?.listening) {
      server.closeAllConnections();
      serverClosed = new Promise((resolve) => {
        server.close((error) => {
          if (error) {
            defaultLogger("ERROR", `Could not close HTTP server: ${error.message}`);
          }
          resolve(error ?? null);
        });
      });
    }
    const cacheClosed = (streamCache?.close() ?? Promise.resolve()).then(
      () => null,
      (error) => {
        defaultLogger("ERROR", `Could not stop stream cache cleanly: ${error.message}`);
        return error;
      },
    );
    const torrentClosed = (torrentProvider?.close() ?? Promise.resolve()).then(
      () => null,
      (error) => {
        defaultLogger("ERROR", `Could not stop BitTorrent provider cleanly: ${error.message}`);
        return error;
      },
    );
    void Promise.all([serverClosed, cacheClosed, torrentClosed]).then(
      ([serverError, cacheError, torrentError]) => {
        client?.destroy();
        process.exit(serverError || cacheError || torrentError ? 1 : exitCode);
      },
    );
  };
  if (client) {
    client.on("server-error", (error) => {
      connectionStatus = "error";
      defaultLogger("ERROR", `Soulseek server error: ${error.message}`);
    });
    client.on("server-disconnect", ({ reconnecting }) => {
      connectionStatus = reconnecting ? "connecting" : "disconnected";
      defaultLogger("WARN", `Soulseek disconnected; reconnecting=${reconnecting}.`);
    });
    client.on("server-reconnect", () => {
      connectionStatus = "connected";
      defaultLogger("INFO", "Soulseek reconnected.");
    });
    client.on("relogged", () => {
      connectionStatus = "error";
      defaultLogger("ERROR", "Soulseek session was replaced by another login.");
      shutdown(1);
    });
  }

  try {
    if (client) {
      await client.login(username, password);
      connectionStatus = "connected";
      defaultLogger("INFO", "Connected to Soulseek.");
    }
    await torrentProvider?.initialize();
    ({ server, streamCache } = createAddonServer({
      client,
      torrentProvider,
      adminToken: ADMIN_TOKEN,
      transferBudget,
      allowDownloads: ALLOW_DOWNLOADS,
      sourceSelection: SOURCE_SELECTION,
      searchLimit: SEARCH_LIMIT,
      searchTimeout: SEARCH_TIMEOUT,
      searchRecovery: SEARCH_RECOVERY,
      maxActiveStreams: MAX_ACTIVE_STREAMS,
      maxStreamBytes: MAX_STREAM_BYTES,
      firstByteTimeout: FIRST_BYTE_TIMEOUT,
      peerIdleTimeout: PEER_IDLE_TIMEOUT,
      idleTransferTimeout: IDLE_TRANSFER_TIMEOUT,
      cacheTtlMs: CACHE_TTL_MS,
      maxCacheBytes: MAX_CACHE_BYTES,
      getConnectionStatus: () => connectionStatus,
    }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, BIND_ADDRESS, resolve);
    });
    defaultLogger("INFO", `${APP_NAME} v${VERSION}.`);
    defaultLogger("INFO", "BitChord source endpoint is ready.");
    defaultLogger("INFO", `Listening on port ${PORT}; direct streaming enabled.`);
  } catch (error) {
    client?.destroy();
    await torrentProvider?.close();
    throw error;
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    defaultLogger("ERROR", `P2PChord startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
