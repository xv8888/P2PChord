<p align="center">
  <img src="./assets/p2pchord-icon.png" alt="P2PChord project icon" width="160">
</p>

# P2PChord

P2PChord connects [BitChord](https://github.com/kushagrasinghx/BitChord) to
Soulseek and, optionally, BitTorrent. It searches enabled sources for FLAC
files and streams selected tracks through BitChord's HTTP add-on API.

> **Alpha software:** expect bugs and breaking changes. Soulseek is enabled by
> default; BitTorrent and torrent discovery are opt-in.

## Quick start (Windows)

You need Python 3.10+, Node.js 22+, and a Soulseek account if using Soulseek.

1. Run `ez-start.bat` from the project folder. If Windows cannot find Python,
   run `python .\launcher.py` in PowerShell.
2. In the browser dashboard, enter your Soulseek credentials if needed. Enable
   BitTorrent or torrent discovery only if you intend to use them.
3. Click **Start**, copy the source URL from Activity, and add it in BitChord
   under **Sources → Add addon**.

The launcher keeps credentials and any Torznab API key in memory for the
session; they are not saved to a settings file. Keep the full source URL
private. Stop the service from the dashboard when finished. The source URL
defaults to two words with a nine-letter target length; both settings remain
adjustable in the launcher. BitChord shows those readable words in the add-on
name, without the bearer token.

## Torrent discovery (experimental)

Discovery is off by default. It can search the Internet Archive public API
and/or a Torznab-compatible HTTPS endpoint that you provide. Torznab is a
protocol, not a bundled indexer service; use only endpoints that permit
automated queries.

Search only displays metadata. Select **Import selected torrent** to add an
individual result to the existing WebTorrent provider. Its FLAC files then
appear in BitChord search alongside Soulseek results. Searches never
automatically import or download results.

Requests have time, size, rate, concurrency, and public-address limits.
P2PChord does not bypass authentication, CAPTCHA, or other access controls.
Torrent peers and trackers can see your IP address even though router port
mapping and uploads are disabled.

Fixture tests cover parsing and import handoff. Live Torznab compatibility,
peer availability, and end-to-end BitChord playback have not been verified.
See [Architecture](./docs/ARCHITECTURE.md) for implementation details and
limitations.

## Other important notes

- **LAN access:** The launcher can bind to a private LAN address. Keep it on a
  trusted network. The inspected Android BitChord build blocks plain-HTTP LAN
  URLs; use a trusted HTTPS endpoint or see
  [Compatibility and roadmap](./docs/COMPATIBILITY_AND_ROADMAP.md).
- **Remote access:** Use HTTPS when accessing P2PChord over the internet.
  The launcher can configure Tailscale Funnel; for other deployments, set up
  a trusted HTTPS reverse proxy. Do not expose port 8080 directly.
- **Authorized media:** Use P2PChord only for music you have permission to
  access and stream. Search results and torrent metadata do not establish
  authorization; you are responsible for confirming your rights.
- **Storage:** Soulseek cache and WebTorrent piece storage are separate under
  `%LOCALAPPDATA%\P2PChord` on Windows. The torrent provider defaults to a
  4-GiB storage limit.

## Manual server start

For a direct Soulseek-only launch, install dependencies and set credentials in
PowerShell:

```powershell
npm install
$env:SOULSEEK_USERNAME = 'YOUR_SOULSEEK_USERNAME'
$env:SOULSEEK_PASSWORD = 'YOUR_SOULSEEK_PASSWORD'
$env:PUBLIC_BASE_URL = 'http://127.0.0.1:8080'
node .\direct_server.mjs
```

By default, the server binds to localhost. For other settings, including
manual BitTorrent configuration, see [Settings and architecture](./docs/ARCHITECTURE.md).

## Development

```powershell
npm test
python -m unittest -v
```

Automated tests use fixtures and synthetic streams; they do not prove live
network or device playback behavior.

## Project information

- [Architecture and limitations](./docs/ARCHITECTURE.md)
- [BitChord compatibility and roadmap](./docs/COMPATIBILITY_AND_ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

P2PChord is independent and is not affiliated with BitChord or Soulseek.
Copyright (C) 2026 P2PChord contributors. Licensed under GPL-3.0-only; see
[LICENSE](./LICENSE).
