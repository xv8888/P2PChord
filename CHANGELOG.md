# Changelog

Notable changes are recorded here. Historical entries summarize changes
available in the project history and prior session records.

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
