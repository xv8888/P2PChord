# Changelog

Notable changes are recorded here. Historical entries summarize changes
available in the project history and prior session records.

## alpha-0.5.5

- Added an explicit LAN source mode that detects a private IPv4 address, uses
  that reachable base URL, and authenticates with the readable adjective/noun
  phrase without appending the separate random bearer-token suffix. The
  localhost and custom/Tailscale URL paths retain their existing token.
- Moved the Activity/source URL panel above the Soulseek login controls and
  added a one-click LAN address selector.
- Documented that Android BitChord currently blocks cleartext HTTP and that
  this cannot be changed by the launcher/server; secure options are a scoped
  client-side LAN opt-in or HTTPS trusted by Android.
- Added high-resolution elapsed-time logs from file-request receipt through peer
  data, cache persistence/readability, and the first HTTP response-body write.
- Added search diagnostics for candidate availability, self-reported speed,
  queue length, match score, and whether a candidate was returned to BitChord.
- Added configurable 30-second defaults for the first peer audio byte and peer
  connection inactivity. Nonresponsive/stalled transfers now fail promptly
  while retaining already-persisted partial data; the existing 15-minute
  overall transfer limit and two-transfer maximum are unchanged.
- Clarified that BitChord 1.9.1 introduces optional add-on proof
  authentication; legacy add-ons continue to work but are labeled outdated.
- Added opt-in BitChord signed request verification for search and stream
  resolution. The manifest advertises `bitchordAuth` only when enabled; media
  URLs then use a 15-minute HMAC signature while retaining range support.
  The launcher leaves this mode off by default and requires HTTPS except for
  loopback addresses.
- Hardened peer streaming by validating the FLAC/ID3 signature before serving
  bytes and rejecting data beyond the peer-advertised size. Search endpoints
  now have a bounded per-client request burst.
- Changed the server bind default to loopback; launcher LAN mode binds only to
  the detected private address. Tailscale Funnel now defaults off and is
  disabled when the launcher stops after configuring it.
- The launcher now constructs its source URL from its own secret instead of
  parsing server output, and control characters are removed from logged data.

## alpha-0.5.2

- Added launcher controls for search result selection, result count, query
  timeout, optional spelling recovery, reconnect grace, cache expiration and
  capacity, transfer slots, and maximum track size. Settings apply to the
  current launch only.
- Preserved existing defaults and capped transfer concurrency at two. Fastest
  reported-speed selection remains optional and may choose a less relevant
  result; the peer-reported speed is not measured by BitSeekWin.
- Added Windows CI for the Node and launcher test suites. Tightened the
  stop script to match exact BitSeekWin script arguments rather than arbitrary
  command-line substrings.
- Batched subsequent cache writes while flushing the first audio chunk
  immediately (128 KiB threshold, 1 ms maximum delay). Writes remain
  serialized, HTTP readers wait for persisted bytes, and the HTTP response
  retains independent backpressure. Added a repeatable synthetic HTTP/cache
  benchmark; it does not measure Soulseek or WAN throughput.
- Clarified that BitChord excludes BitSeekWin from download-source selection
  while the manifest's `allowDownloads` flag is false (the intentional
  default), documented how to opt in, and tested the manifest-to-file URL
  handoff without claiming a live BitChord download test.
- Redesigned the launcher with a Windows-app-style sidebar, toolbar, dark
  default theme with a light-mode toggle, responsive settings sections, and
  functional section navigation. Existing controls and server wiring are
  unchanged.
- Bundled Inter Variable under its SIL Open Font License and applied it across
  the launcher with centralized type-scale, line-height, tracking, and weight
  tokens; no Apple font files are bundled.
- Restyled the launcher’s source-phrase sliders with a thin rounded Apple Music
  style track, filled progress, and circular thumb for Chromium and Firefox.
- Emphasized the BitSeek portion of the launcher wordmark with a slightly larger
  bold weight and reduced the superscript Win size.

## alpha-0.5.0

- Added a persistent disk-backed FLAC cache for completed and partial files,
  with byte-range reads, offset-based partial reuse, cache expiry, and bounded
  LRU eviction.
- Kept one authenticated Soulseek client per server session while allowing
  independent per-track transfers, up to two concurrent transfers, and a
  reconnect grace period for HTTP consumers.
- Improved search-to-stream reliability by retaining result IDs across
  searches, correlating search and stream diagnostics, and returning meaningful
  failures when a peer rejects a transfer before audio begins.
- Documented the BitChord add-on protocol, actual architecture, and known
  compatibility limitations.

## alpha-0.4.3

- Improved search handling for Unicode and compressed consonant queries with
  diacritic normalization and a limited missing-vowel retry.
- Added launcher controls for source URL generation and optional BitChord
  download capability; the latter advertises the manifest flag and is off by
  default.
- Refined progressive HTTP streaming behavior and launcher presentation.

## alpha-0.4.2

- Added configurable readable source URL phrases with a separate random
  128-bit token, plus independent per-word length variation.
- Simplified the browser-based launcher and documented source URL generation.

## v0.4.0-pre-alpha.1

- Replaced the slskd-backed prototype with a direct `slsk-client` Soulseek
  integration and progressive HTTP FLAC streaming.
- Added single-byte-range serving and a browser-based launcher that keeps
  credentials in process memory rather than a settings file.

## Earlier prototype work

- Established the BitChord HTTP add-on manifest, search, stream descriptor,
  and ranged media endpoint.
- Iterated on FLAC candidate filtering, range handling, launcher activity
  feedback, and playback streaming behavior.
