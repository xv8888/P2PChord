# Compatibility and roadmap

This document records inspected BitChord compatibility facts and future work.
The findings describe the specific source snapshot and published documentation
cited here; they do not establish the protocol used by every installed
BitChord client.

## Current compatibility findings

### Inspected sources

- The inspected BitChord source was version **1.9.0**, version code **36**, at
  commit [`b690dc146009d4815825fa4a20815ef2e4ee8898`](https://github.com/kushagrasinghx/BitChord/blob/b690dc146009d4815825fa4a20815ef2e4ee8898/build.gradle.kts).
- That source snapshot did not contain the newer signed add-on request-proof
  mechanism.
- BitChord **1.9.1**, version code **39**, was released at commit
  [`acf219a7e4a7f52f026d4336d5c7ac5cf7bfafcc`](https://github.com/kushagrasinghx/BitChord/blob/acf219a7e4a7f52f026d4336d5c7ac5cf7bfafcc/build.gradle.kts).
- The [published BitChord add-on documentation](https://bitchord.kushagrasingh.in/docs)
  describes the new authentication as **optional** in 1.9.1, not mandatory for
  every add-on. An add-on opts in with `bitchordAuth: true`; add-ons that do not
  opt in continue to work, though BitChord displays an “Outdated addon” notice.
- The inspected [1.9.1 add-on client](https://github.com/kushagrasinghx/BitChord/blob/acf219a7e4a7f52f026d4336d5c7ac5cf7bfafcc/app/src/main/java/com/music/bitchord/data/sources/addon/AddonClient.kt)
  enables proof requests when the manifest declares `bitchordAuth`, or when a
  server challenges with `401` and `WWW-Authenticate: BitChord`.
- BitChord publishes a [Node request verifier](https://bitchord.kushagrasingh.in/addon-auth/bitchord-addon-auth.mjs)
  for that mechanism.

These are source/documentation findings, not a report of the version installed
by any particular user. Installed versions and release behavior must be
confirmed separately, and live add-on testing is still needed.

### BitSeekWin today

BitSeekWin serves a JSON manifest with `resources: ["search", "stream"]` and
the optional `allowDownloads` flag. Signed request authentication is now an
explicit, default-off setting. When enabled, the manifest declares
`bitchordAuth: true`; `/search` and `/stream` validate `X-BitChord-Token` and
`X-BitChord-Proof` against BitChord's published protocol. The manifest remains
accessible without a proof, while the existing secret URL path remains
required in both modes.

In signed-auth mode, stream descriptors return `/file/{id}` URLs protected by
a 15-minute HMAC signature as well as the existing path secret. File requests
do not require BitChord proof headers and continue to support byte ranges and
the existing persistent cache and transfer lifecycle. The launcher permits
signed auth only over HTTPS, except for loopback development addresses. The
server itself does not provide TLS.

### Compatibility implications

- **Inspected 1.9.0 source:** It did not implement the newer proof mechanism,
  so the newer proof requirement is not indicated by that source snapshot.
  Whether a particular 1.9.0 build can reach a BitSeekWin URL still depends on
  network reachability, URL configuration, and Android cleartext policy.
- **Inspected 1.9.1 behavior:** The legacy mode remains compatible with the
  documented behavior for non-opted-in add-ons, which work without proof
  headers but receive an “Outdated addon” notice. Opt-in mode is intended for
  1.9.1+ clients; older clients cannot provide the required proof.
- **HTTPS:** When an add-on opts into proof authentication, BitChord sends
  proof headers only over HTTPS, except for loopback development addresses.
  BitSeekWin's plain-HTTP LAN URL cannot use that opt-in mode. Independently,
  the inspected Android release manifest sets
  `android:usesCleartextTraffic="false"`, so a plain-HTTP LAN URL may be blocked
  client-side even when the add-on stays in legacy mode. An HTTPS
  `PUBLIC_BASE_URL` requires a reachable TLS endpoint and a certificate trusted
  by the device.
- **Media requests:** Opt-in mode uses expiring HMAC-signed media URLs because
  the player fetches media without proof headers. Legacy mode keeps the
  existing path-secret-only URLs.

### Verified versus unverified

**Verified by source inspection:** the cited BitChord version values, absence
of the new proof mechanism in 1.9.0, the optional-auth behavior and request
challenge handling in the inspected 1.9.1 source, and the cited Android
cleartext setting.

**Verified by automated tests:** BitSeekWin's legacy and opt-in paths,
generated-token/proof verification, signed media URL checks, and ranged
`/file` delivery.

**Requires release/device testing:** which protocol a user's installed
BitChord build enforces; whether it can register, search, resolve, play,
download, and seek against the current BitSeekWin deployment; and whether a
given HTTPS/LAN setup is reachable and trusted. Do not infer universal client
compatibility from synthetic protocol tests or the inspected source version
and published documentation alone. The official verifier artifact is not
vendored; BitSeekWin implements its published protocol independently.

## Known Limitations

- BitChord signed request authentication is optional and disabled by default.
  Legacy mode continues to receive an “Outdated addon” notice in the inspected
  BitChord 1.9.1 client. Opt-in mode has not yet been validated against a live
  BitChord release/device.
- The existing URL-path secret and the newer BitChord proof are separate
  mechanisms. The path secret does not establish that a request came from the
  official BitChord app.
- The Node server does not terminate TLS. Proof-authenticated add-ons require
  HTTPS for non-loopback URLs, and LAN HTTP may independently be blocked by
  the inspected Android release cleartext policy.
- In opt-in mode media URLs expire after 15 minutes. Resolve the stream again
  to obtain a new URL after expiry. Legacy URLs continue to use only the path
  secret.
- Compatibility with installed BitChord versions, including actual playback,
  download, and range-seek behavior, has not been validated end to end across
  old and new clients.
- Optional SMB export is only a proposal. BitSeekWin does not currently expose
  completed cache files through SMB.

## Compatibility and Migration Risks

1. **Opt-in carefully.** BitSeekWin advertises `bitchordAuth: true` only when
   proof verification is enabled. This mode is a security choice; BitChord
   1.9.1 does not require every add-on to opt in.
2. **Preserve the current path-secret mechanism during migration.** Removing
   it outright could break existing URLs, launcher workflows, and clients
   using current behavior. Since the new feature is opt-in, BitSeekWin can
   remain in legacy mode while its value and migration are evaluated.
3. **Opt-in changes client compatibility.** BitChord 1.9.0 and older clients
   do not implement this proof protocol. If BitSeekWin starts requiring proof
   on its existing endpoint, those clients will not be able to use it. Do not
   assume a protected and legacy mode can safely share one endpoint until
   tested.
4. **Media authorization is a separate boundary.** Opt-in mode uses
   15-minute signed media URLs and preserves repeated range requests while the
   URL is valid. Test long playback and seeking with actual clients; after the
   URL expires, BitChord must resolve the stream again.
5. **Transport changes apply when opting in.** Proof-authenticated requests
   require HTTPS outside loopback according to the inspected 1.9.1 client. LAN
   users need a reachable TLS endpoint with a device-trusted certificate, or
   a separately reviewed BitChord-side, narrowly scoped cleartext exception
   for legacy mode.
6. **Streaming behavior must remain stable.** Authentication changes must
   preserve existing HTTP range handling, seeking, persistent caching,
   resumable transfers, and independent cancellation for concurrent tracks.
7. **No live compatibility claim is established.** The 1.9.1 source indicates
   legacy add-ons remain usable, but test the current path and any opt-in
   protected mode with real supported BitChord versions before documenting
   them as interoperable.

## Optional authentication implementation status

The launcher and server now provide a default-off opt-in. The server verifies
the published JWT and device-signed proof format for `/search` and `/stream`,
returns BitChord-compatible `WWW-Authenticate` errors, and only advertises
`bitchordAuth: true` when enabled. The existing path secret remains required.
Opt-in media URLs carry an expiring HMAC signature; range handling and the
existing transfer/cache lifecycle are unchanged. The launcher blocks opt-in
for non-loopback HTTP addresses. Protocol tests use generated test keys and a
mock JWKS endpoint; they do not prove live BitChord interoperability.

Remaining work:

1. Test source registration, search, stream resolution, playback, downloads,
   and repeated/ranged requests on BitChord 1.9.0 and 1.9.1+ clients.
2. Verify JWKS key rotation and authentication behavior against the live
   published service, and document any unavoidable migration limitations.
3. Keep the existing path-secret mode as the default. Clients older than
   1.9.1 cannot use the opt-in protected endpoint.

## Android LAN transport

The inspected BitChord 1.9.1 Android release manifest sets
[`android:usesCleartextTraffic="false"`](https://github.com/kushagrasinghx/BitChord/blob/acf219a7e4a7f52f026d4336d5c7ac5cf7bfafcc/app/src/main/AndroidManifest.xml).
Advertising the Windows PC's reachable LAN IP instead of `127.0.0.1` is
necessary for another device to reach the server, but it does not independently
permit HTTP in BitChord. This restriction is separate from opting into add-on
proof authentication.

Plain-HTTP LAN access may require a narrowly scoped BitChord-side security
configuration for a user-approved LAN destination. Do not globally disable
cleartext protections. The preferred long-term approach is HTTPS with a
certificate trusted by the Android device. SMB is a separate protocol and is
not affected by Android's HTTP cleartext policy in the same way.

## Optional SMB export (planned, lower priority)

If there is a clear use case, investigate an opt-in export of completed,
size-verified FLAC files into a dedicated human-readable directory:

- Export only completed files, never `.part` files.
- Use stable, collision-safe filenames.
- Keep exported files synchronized with cache eviction and expiration.
- Do not expose the raw cache directory, which contains partial data and
  cache-specific names and metadata.
- Do not automatically change Windows sharing or firewall settings.
- Prefer Windows built-in SMB sharing with a dedicated read-only account.
- Never expose SMB port 445 to the public internet.

SMB export would provide access to **completed files only**. It would not
provide live Soulseek search, partial-download playback, or live streaming,
and it would remain separate from the existing Soulseek add-on and streaming
engine.

## Prioritized roadmap

### Priority 1 — Compatibility

- Confirm the exact BitChord versions currently used by existing users.
- Test BitSeekWin's current legacy mode with BitChord 1.9.0 and 1.9.1+.
- Keep authentication opt-in and test both legacy mode and the protected mode
  against the exact BitChord versions in use.
- Preserve existing working clients and streaming behavior during migration.

### Priority 2 — Reliability and performance

- Continue investigating first-byte latency and peer transfer startup.
- Test cache batching and transfer timeouts with real Soulseek peers.
- Preserve byte-range integrity, cancellation isolation, and resumability.
- Do not claim performance improvements based solely on synthetic benchmarks.

### Priority 3 — LAN usability

- Improve LAN address discovery and source configuration.
- Establish a secure, Android-compatible HTTPS approach.
- Document any BitChord-side changes required for LAN access.

### Priority 4 — Optional SMB export

- Implement only if there is a clear use case.
- Keep it separate from the existing Soulseek add-on and streaming engine.
