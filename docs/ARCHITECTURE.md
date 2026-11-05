# BitSeekWin architecture

This document describes the architecture implemented in the current source,
not a proposed design. The BitChord protocol summary follows the
[official BitChord add-on documentation](https://bitchord.kushagrasingh.in/docs).
Implementation details were checked against `direct_server.mjs`,
`stream_cache.mjs`, `launcher.py`, and the installed `slsk-client` 2.0.2
download implementation.

## System overview

```mermaid
flowchart LR
    BC[BitChord] -->|GET manifest, search, stream| HTTP[BitSeekWin HTTP server]
    BC -->|GET or ranged GET audio URL| HTTP
    subgraph BitSeekWin process
        HTTP -->|search / download requests| SC[One authenticated SlskClient]
        HTTP --> TM[Track map and StreamCache]
        TM -->|independent downloads, max 2 active| SC
        TM -->|partial and completed files| DISK[(Persistent cache directory)]
        SC -->|connection status and reconnect events| LIFE[Lifecycle and logs]
    end
    SC <-->|one login session; search/control| SS[Soulseek server]
    SC <-->|peer file-transfer connections| PEERS[Soulseek peers]
    PEERS -->|FLAC chunks| SC
    PY[Python launcher] -->|starts Node process; passes environment| HTTP
    PY -->|stop / exit| LIFE
```

BitSeekWin is an HTTP add-on bridge. It does not expose a JavaScript add-on
module inside BitChord. A source URL contains a path slug and a route
credential; all add-on routes are under that prefix. Localhost and custom
non-LAN URLs use a separate random 128-bit bearer token. Launcher LAN mode
uses only the randomly generated adjective/noun phrase as that route
credential. The Node HTTP server listens on `0.0.0.0` and uses
`PUBLIC_BASE_URL` when constructing the playable audio URL.

## BitChord add-on protocol

The official protocol uses three JSON-over-HTTP GET endpoints:

1. **Manifest — `GET /manifest.json`**
   - Provide a stable, unique non-empty `id`; a human-readable `name` and
     `version` are recommended.
   - Advertise `resources: ["search", "stream"]` for this endpoint-based flow.
   - `allowDownloads` is optional in BitChord and defaults to allowed when
     omitted. BitSeekWin explicitly reports a boolean, defaulting to `false`;
     the launcher has the same default. BitChord deliberately omits an add-on
     from download-source selection when this value is false, while playback
     can still use it. Enabling the launcher option or setting
     `BITSEEKWIN_ALLOW_DOWNLOADS=true` makes BitChord eligible to use the
     existing stream URL for a download; refresh or re-add the source after
     changing the manifest setting.
   - Optional `settings` can define a quality picker using
     `{ "key": "quality", "type": "select", "options": [...] }`; BitChord sends
     the selected option on search and stream requests. The official protocol
     also defines the optional `checkValidLossless` gate. BitSeekWin does not
     currently implement these features.

2. **Search — `GET /search?q=...`**
   - Return a JSON object with a `tracks` array. Track `id` and `title` are
     required by BitChord; `artist`, `album`, `duration`, `format`,
     `audioQuality`, artwork, and a direct `streamURL` are optional or
     recommended according to the official contract.
   - BitChord may send a `quality` parameter and other hints such as `atmos`.
     Search responses should be focused and fast; the official protocol does
     not define a result-count parameter.
   - BitSeekWin returns the standard `tracks`, `albums`, `artists`, and
     `playlists` arrays. It filters to safe `.flac` Soulseek results and, by
     default, ranks candidates by filename match and returns at most 50 tracks.
     The launcher can instead select a fastest-speed mode that returns only
     the peer reporting the highest speed. It reports an empty set of arrays
     for an empty query or no usable match.

3. **Stream — `GET /stream/{id}`**
   - Return JSON with an absolute, directly playable media or manifest `url`.
     Codec, container, manifest kind, encryption, and audio-quality metadata
     are recommended when known.
   - BitChord may send the selected `quality` and other hints to this route.
   - BitSeekWin returns a URL to its own `/file/{id}` route and declares FLAC
     format, codec, container, MIME type, and lossless quality. Unknown or
     expired track IDs return 404.

The separate `/file/{id}` route is BitSeekWin's media transport endpoint, not
a fourth add-on resource. It returns FLAC bytes and supports byte ranges for
playback, seeking, and follow-up requests. BitSeekWin also accepts `HEAD` and
`OPTIONS` on the HTTP server; these do not replace the three GET protocol
routes.

## Search and track identity

The server normalizes query punctuation and common Latin diacritics before
searching Soulseek. When enabled, it makes one missing-vowel recovery search
only when an initial search returns no results and the query contains a likely
compressed consonant cluster. The launcher exposes this retry as a checkbox.
Each Soulseek query has a configurable timeout, defaulting to two seconds.
The launcher exposes integer seconds from 1 to 30; the server also accepts
direct settings from 500 to 30,000 milliseconds.

Only safe, positive-size FLAC results with a peer username are considered.
Candidate titles and artist names are inferred from filenames and the query;
full file tags are not read. The launcher defaults to match-first selection:
results are ordered by filename match, available peer slots, reported speed,
queue length, and stable ID, and up to 50 are returned for BitChord to select.
The launcher can lower the result limit to 1.
The launcher can be set to fastest-speed mode, which returns only the result
from the peer reporting the highest upload speed across all matching FLAC
results. The speed is self-reported, not measured by BitSeekWin; fastest-speed
mode can return a less relevant result than a slower match. A track ID is a
truncated SHA-256 digest of peer username, remote filename, and size. Track
records remain resolvable for 20 minutes after their latest search, stream, or
file request, covering BitChord's documented 10-minute search and 5-minute stream
caches. Expired records are pruned on search. The server does not evict still
valid IDs or IDs used by active HTTP consumers/transfers to make room: if the
1,000-record registry is full, a new search receives HTTP 503 rather than
results that cannot be streamed. Repeated searches do not clear prior results.

Searches and stream/file requests receive diagnostic correlation IDs. Logs
include result IDs, peer and filename resolution, byte ranges, transfer reuse
or slot availability, peer transfer status, and HTTP outcomes. Streaming
milestones report elapsed time from HTTP request receipt through slot
acquisition, `slsk-client.download()`, peer status/data, first cache write,
cache readability, and the first body write queued to Node's HTTP response.
That final milestone is not a measurement of delivery over the network to
BitChord. Stream requests refer back to the most recent search-request IDs
associated with that result.

## Soulseek client and transfer lifecycle

The Node server creates one `SlskClient` during startup and calls its login
once. Searches and all per-track downloads use that client. The client
maintains the authenticated Soulseek session and centrally reports server
disconnect, reconnect, and replacement-login events. File transfers still
require peer connections; “one client” does not mean every track shares one
peer socket.

Each cache entry has its own transfer state: peer/file identity, received-byte
position, partial-file path, active download, HTTP consumer count, errors, and
cleanup timers. Searching for another track does not cancel a transfer.
Different tracks may download concurrently, with a default of two active
transfers. The launcher can lower this to one, and neither the launcher nor
the server accepts a limit above two. Searches and completed cache reads do
not consume those download slots. The launcher can lower the per-track stream
size limit from its 128 MiB default, but cannot raise it. A simultaneous
transfer for the same peer/path with conflicting size metadata is rejected
rather than replacing the library's download for that peer/path.

An HTTP request adds a consumer for its track. If a response closes, its
readable is destroyed and only that consumer is removed. The transfer remains
available to other consumers. Once the last consumer disconnects, an active
transfer gets a configurable grace period (30 seconds by default, adjustable
from 1 to 600 seconds in the launcher). If nobody reconnects, that transfer is
canceled and releases its slot; its partial bytes are retained.
Transfers also have a 15-minute overall timeout. By default, a new transfer is
cancelled if no peer audio chunk arrives within 30 seconds; peer-connection
inactivity also times out after 30 seconds. These deadlines are separately
configurable with `BITSEEKWIN_FIRST_BYTE_TIMEOUT_MS` and
`BITSEEKWIN_PEER_IDLE_TIMEOUT_MS` (1–300 seconds). A server shutdown cancels
outstanding transfers and waits for them to release before destroying the
client.

## Streaming, byte ranges, and partial data

The HTTP handler resolves the track ID, parses a single byte range, and
connects the response to a `Readable` backed by `StreamCache.readRange()`.
That generator reads available bytes from disk in bounded chunks and waits for
more bytes when the requested region has not arrived yet. Multiple HTTP range
requests for the same track read the same transfer's contiguous bytes; a new
track has a separate entry and download.

Received chunks are written to the cache in order through one serialized
write queue per file. The first chunk is flushed immediately; subsequent
chunks are grouped up to 128 KiB or flushed after at most 1 ms. Batches use
`FileHandle.writev()` when there are multiple chunks and continue at the exact
byte offset if the OS reports a partial write. The cache's readable byte
position advances only after the batch is written, so HTTP readers never see
unpersisted bytes. `Readable.pipe(response)` maintains HTTP backpressure
independently of disk batching.

`HEAD` reports known file metadata without opening a Soulseek transfer. Invalid
or unsatisfiable ranges receive 416. Responses use `audio/flac` and
`Accept-Ranges: bytes`. While data is incomplete, a ranged GET does not claim
the complete representation size in `Content-Range`; a completed cached file
reports the actual total size. For GET requests, response headers are sent only
when the first audio bytes are available. A peer failure before the first byte
can therefore return HTTP 502; a failure after streaming starts is logged and
the already-started response is terminated.

Partial files are retained in the cache directory. The installed
`slsk-client` supports an `offset` download option, and BitSeekWin starts a
subsequent transfer at the contiguous partial-file length. The library itself
also retries interrupted downloads at its received offset. A partial entry is
never treated as completed merely because it has bytes: completion requires a
successful peer download and an exact match to the expected file size. The
partial file is then atomically renamed to the completed `.flac` cache file.

## Persistent FLAC cache

Cache identity is SHA-256 over peer username, remote filename, and file size,
so a new BitChord track ID can reuse an existing entry when those fields are
the same. The default cache location is `%LOCALAPPDATA%\\BitSeekWin\\cache` on
Windows and `~/.cache/BitSeekWin/cache` elsewhere.

Completed files and partial files have metadata persisted beside them and
survive process restarts. Defaults are a 30-minute expiration since last
access and a 2 GiB maximum. The launcher can adjust both values for the
current launch only (TTL: 1–10,080 minutes; size: 16–32,768 MiB). Inactive
entries are removed by expiry or least-recently-used eviction; entries with
active HTTP consumers or transfers
are protected. The directory, TTL, and maximum size can be changed through
`BITSEEKWIN_CACHE_DIRECTORY`, `BITSEEKWIN_CACHE_TTL_MS`, and
`BITSEEKWIN_CACHE_MAX_BYTES`. The launcher exposes the TTL, size, and idle
transfer grace period; all launcher settings are per launch and default to
the current behavior when not provided.

## Memory and size limits

Disk-backed streaming and caching do **not** make Soulseek downloads
memory-free. In the installed `slsk-client` 2.0.2 implementation, each download
retains received chunks in memory and concatenates them when the download
completes. BitSeekWin rejects files larger than its configurable per-track
limit (128 MiB by default, not configurable above 128 MiB) and allows one or
two active transfers, but two near-limit downloads can still consume substantial
memory, including extra peak use during concatenation. The disk cache is for
stream delivery and reuse; it does not replace the library's buffers.

## Launcher lifecycle

The Python launcher starts `direct_server.mjs` as a child Node process. It
passes the Soulseek username and password, the generated source secret, public
URL, word settings, source-selection mode, search controls, cache limits, and
transfer limits through the child process environment. These are validated
for each launch and are not persisted by the launcher. Defaults preserve the
existing search, cache, and transfer behavior, including the two-transfer
ceiling and 128 MiB per-track cap. The password is not written to the launcher
settings file. The launcher reads the server's combined output for status and
diagnostics.

The launcher can detect a private IPv4 address and advertise
`http://<LAN-IP>:8080` for another device on the same network. This mode uses
the randomized adjective/noun route phrase without the separate random token;
the phrase remains the URL's route credential, with less entropy than the
normal 128-bit token. Localhost and custom/Tailscale URLs retain the 128-bit
token. The server still binds on all interfaces, so LAN access should be
limited by Windows Firewall to Private networks.

The browser dashboard shows setup controls, the generated source URL, and the
activity log. It polls the launcher's loopback-only `/api/status` endpoint for
launcher state and logs. It does not show a live-monitoring panel or operational
status footer, and it does not poll the add-on server's monitoring endpoint.
That authenticated endpoint remains implemented by the Node server and exposes
connection, transfer-slot, cache, and transfer snapshots; removing the
dashboard panel did not remove the backend endpoint or monitoring data source.
The existing public-address input is saved in browser `localStorage` after a
successful start request and restored when the dashboard is reopened.

The Node process authenticates before opening the HTTP listener and printing
the source URL. The Node process installs `SIGINT` and `SIGTERM` handlers; when
one is delivered, its shutdown path closes HTTP connections, cancels and
drains active cache transfers, destroys the Soulseek client, and exits. The
launcher Stop action calls `Popen.terminate()` for the child process. On
Windows, this can terminate the process without delivering a JavaScript
shutdown signal, so graceful cache/transfer cleanup is not guaranteed by that
launcher action. A configured Tailscale Funnel remains configured when the
launcher stops BitSeekWin.

## Implemented behavior versus known limitations

### Implemented

- One authenticated Soulseek client per server process, shared by searches and
  independent peer-file transfers.
- Two active transfer slots by default, per-track consumers, disconnect grace
  period, per-transfer timeout, and transfer cleanup.
- FLAC candidate filtering and ranking, direct HTTP audio streaming, range
  requests, partial-file offset reuse, and persistent completed-file caching.
- Cache expiry and LRU size management with active-entry protection.
- Download permission advertised in the manifest, off by default. When enabled,
  BitChord's direct-download request follows the regular `/stream/{id}` URL to
  `/file/{id}`; no separate server-side download subsystem is needed.

### Known compatibility gaps and limitations

- **Android cleartext policy blocks the plain-HTTP LAN URL.** The current
  BitChord Android manifest sets `android:usesCleartextTraffic="false"`.
  BitSeekWin cannot override that client-side policy. BitChord would need a
  user-approved, host-scoped LAN cleartext exception, or the connection must
  use HTTPS trusted by Android (for example, Tailscale HTTPS on both devices).
  Do not disable cleartext protection globally.
- **Quality tiers are ignored.** BitChord documents sending `quality` on both
  search and stream requests. BitSeekWin currently reads only the search `q`
  parameter and always searches/returns FLAC lossless results, regardless of
  a requested tier such as `HIGH` or `LOW`. The stream handler likewise
  returns FLAC without negotiating the query parameter.
- **Manifest IDs may collide.** The current ID is
  `bitseekwin-addon.${slug}`; with the default slug, independent installations
  report the same ID. The official docs require a stable, unique ID. Setting
  a distinct slug also changes this ID, but there is no generated per-install
  identity mechanism.
- The server caps each search response at 50 tracks; BitChord's protocol does
  not define a result limit parameter.
- Soulseek peers may be offline, queue or refuse transfers, disconnect, or
  provide data that differs from the search result. Actual playback and
  offset-resume behavior depends on the peer, network, library, and BitChord
  client and needs live testing. BitSeekWin does not automatically switch a
  failed stream to another peer: cache entries are bound to peer/file/size,
  and transparent switching would need to prove that alternate bytes represent
  the same recording before continuing a range or partial transfer. BitChord
  can select another returned result, or the user can retry after changing the
  source result.
- `stream_cache.bench.mjs` compares per-chunk writes with multiple batch
  thresholds, peer chunk sizes, flush delays, and one or two local transfers.
  It uses a synthetic local peer and measures the cache/HTTP path only; results
  do not predict Soulseek peer throughput or WAN performance. Run it with
  `node --expose-gc stream_cache.bench.mjs`; `BITSEEKWIN_BENCH_MIB` and
  `BITSEEKWIN_BENCH_REPEATS` control the synthetic file size and repetitions.
  Set `BITSEEKWIN_BENCH_TARGETED=true` to compare per-chunk writes with the
  selected 128 KiB batch across 64/128/256/512 KiB peer chunks.
- The library's in-memory buffering and the 128 MiB/two-transfer limits mean
  peak memory can still be high. Disk caching does not remove this limitation.
- The server-side manifest/stream/file handoff is covered by tests, but a
  download in the actual BitChord app has not been validated end to end. That
  requires running the app with a reachable BitSeekWin instance and a peer
  that serves the selected file; any app-version-specific download behavior
  would need to be diagnosed there.
- On Windows, stopping the child through the launcher may bypass Node's
  graceful shutdown handlers; partial files remain on disk, but active
  transfers may not be drained before process termination.

### Future improvements (not implemented)

- Honor or explicitly negotiate BitChord quality tiers, while accurately
  describing the formats BitSeekWin can actually provide.
- Provide a unique, stable manifest ID per configured installation, if the
  product is intended to support multiple instances in one BitChord install.
- Reduce or eliminate library-level in-memory buffering if the Soulseek
  library or a future supported implementation permits safe disk streaming.
- Test transfer resume, repeated ranges, and playback/disconnect behavior with
  live Soulseek peers and BitChord devices.
