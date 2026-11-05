# Compatibility and roadmap

This document records inspected BitChord compatibility facts and proposes
future work. Proposed features below are not implemented. The findings describe
the specific source snapshot and published documentation cited here; they do
not establish the protocol used by every installed BitChord client.

## Current compatibility findings

### Inspected sources

- The inspected BitChord source was version **1.9.0**, version code **36**, at
  commit [`b690dc146009d4815825fa4a20815ef2e4ee8898`](https://github.com/kushagrasinghx/BitChord/blob/b690dc146009d4815825fa4a20815ef2e4ee8898/build.gradle.kts).
- That source snapshot did not contain the newer signed add-on request-proof
  mechanism.
- The [published BitChord add-on documentation](https://bitchord.kushagrasingh.in/docs)
  describes mandatory add-on authentication beginning with BitChord **1.9.1**.
- BitChord publishes a [Node request verifier](https://bitchord.kushagrasingh.in/addon-auth/bitchord-addon-auth.mjs)
  for that mechanism.

These are source/documentation findings, not a report of the version installed
by any particular user. Installed versions and release behavior must be
confirmed separately, and live add-on testing is still needed.

### BitSeekWin today

BitSeekWin serves a JSON manifest with `resources: ["search", "stream"]` and
the optional `allowDownloads` flag. It does **not** declare
`bitchordAuth: true`. Its HTTP handler checks a secret in the URL path before
dispatching the manifest, search, stream-descriptor, file, and monitoring
routes. That path secret is BitSeekWin's own bearer-style credential; it is
not BitChord's signed request proof. The server does not validate
`X-BitChord-Token` or `X-BitChord-Proof`.

The stream descriptor returns a direct `/file/{id}` URL carrying the same
path-secret credential. The file route supports byte ranges and feeds the
existing persistent cache and transfer lifecycle. `PUBLIC_BASE_URL` can name
an HTTPS address when deployed behind HTTPS termination, but the server itself
does not provide TLS.

### Compatibility implications

- **Inspected 1.9.0 source:** It did not implement the newer proof mechanism,
  so the newer proof requirement is not indicated by that source snapshot.
  Whether a particular 1.9.0 build can reach a BitSeekWin URL still depends on
  network reachability, URL configuration, and Android cleartext policy.
- **Documented 1.9.1+ behavior:** The current BitChord documentation says a
  manifest without `bitchordAuth: true` is out of date and cannot be used for
  search, streaming, or downloads. BitSeekWin does not currently meet that
  documented requirement. A client following it can therefore accept or
  display a source but refuse to use it; this must be verified against actual
  releases.
- **HTTPS:** The published proof protocol is documented for HTTPS. BitSeekWin's
  plain-HTTP LAN URL cannot satisfy that transport requirement. The inspected
  Android release manifest also sets `android:usesCleartextTraffic="false"`,
  so plain HTTP may be blocked client-side even before add-on proof validation.
  An HTTPS `PUBLIC_BASE_URL` requires a reachable TLS endpoint and a certificate
  trusted by the device.
- **Media requests:** BitSeekWin's current media URL uses its path secret,
  not a short-lived signature. The published verifier is for add-on API
  requests. The BitChord auth documentation recommends a separate signed,
  expiring media URL for media fetches rather than requiring proof headers on
  those requests.

### Verified versus unverified

**Verified by source inspection:** the cited BitChord version values, absence
of the new proof mechanism in that snapshot, current BitSeekWin manifest and
path-secret checks, lack of request-proof verification, ranged `/file` route,
and the cited Android cleartext setting.

**Requires release/device testing:** which protocol a user's installed
BitChord build enforces; whether it can register, search, resolve, play,
download, and seek against the current BitSeekWin deployment; and whether a
given HTTPS/LAN setup is reachable and trusted. Do not infer universal client
compatibility from the inspected source version or published documentation
alone.

## Known Limitations

- BitSeekWin has no BitChord signed request-proof verification and does not
  advertise `bitchordAuth`.
- The existing URL-path secret and the newer BitChord proof are separate
  mechanisms. The path secret does not establish that a request came from the
  official BitChord app.
- The Node server does not terminate TLS. LAN HTTP is not an Android-compatible
  substitute for HTTPS under the inspected release configuration.
- Stream and file URLs currently use the stable path secret; they are not
  short-lived signed media URLs.
- Compatibility with installed BitChord versions, including actual playback,
  download, and range-seek behavior, has not been validated end to end across
  old and new clients.
- Optional SMB export is only a proposal. BitSeekWin does not currently expose
  completed cache files through SMB.

## Compatibility and Migration Risks

1. **Do not advertise support prematurely.** Add `bitchordAuth: true` only
   after request-proof validation is implemented and tested. Advertising it
   without verification would claim a security property BitSeekWin does not
   provide.
2. **Preserve the current path-secret mechanism during migration.** Removing
   it outright could break existing URLs, launcher workflows, and clients
   using current behavior. A staged, opt-in mode and log-only validation phase
   are safer than an immediate enforcement change.
3. **Older clients may not send proof.** Investigate whether a narrowly scoped
   compatibility mode can serve older clients without weakening the strict
   mode. Do not assume old and new clients can safely share one strict endpoint
   until tested.
4. **Media authorization is a separate boundary.** If the API routes require
   signed proof but the returned file URL does not, the media route still needs
   an intentional authorization scheme. Short-lived signatures must permit
   the multiple range requests used for seeking, without expiring mid-playback
   or disrupting an active transfer.
5. **Transport migration changes deployment requirements.** New proof requests
   require HTTPS according to the published documentation. LAN users need a
   reachable TLS endpoint with a device-trusted certificate, or a separately
   reviewed BitChord-side, narrowly scoped transport change.
6. **Streaming behavior must remain stable.** Authentication changes must
   preserve existing HTTP range handling, seeking, persistent caching,
   resumable transfers, and independent cancellation for concurrent tracks.
7. **No universal backward-compatibility claim is established.** Test the
   current legacy path and any proposed strict/compatibility modes with real
   supported BitChord versions before documenting them as interoperable.

## Future authentication migration (planned)

1. Inspect and integrate BitChord's
   [published Node authentication verifier](https://bitchord.kushagrasingh.in/addon-auth/bitchord-addon-auth.mjs),
   following its current specification rather than reimplementing from memory.
2. Verify signed request proofs on the appropriate add-on API routes. Keep the
   manifest's proof handling consistent with BitChord's current published
   instructions.
3. Do not advertise `bitchordAuth: true` until verification is implemented,
   covered by tests, and validated with a current BitChord client.
4. Retain the existing path-secret authentication during a carefully managed
   migration; avoid breaking current working clients without a tested rollout.
5. Investigate a compatibility mode for older BitChord clients. Define its
   trust and exposure boundaries before implementation.
6. Introduce short-lived signed media URLs for stream/file delivery, with
   explicit expiry and signature validation.
7. Preserve byte-range requests, seeking, cache behavior, partial-download
   resume, and independent transfer cancellation.
8. Test source registration, search, stream resolution, playback, downloads,
   and repeated/ranged requests on both older and newer BitChord clients.
9. Document any unavoidable backward-compatibility limitations and migration
   steps for users.

This plan does not assume old and new clients can share one strict
authentication endpoint; that design must be tested before it is promised.

## Android LAN transport

The inspected BitChord Android release manifest sets
`android:usesCleartextTraffic="false"`. Advertising the Windows PC's reachable
LAN IP instead of `127.0.0.1` is necessary for another device to reach the
server, but it does not independently permit HTTP in BitChord.

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
- Test current BitSeekWin against those versions.
- Implement the newer authentication protocol when necessary.
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
