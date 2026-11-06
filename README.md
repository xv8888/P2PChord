# P2PChord

### Peer-powered music. One streaming bridge.

Connect [BitChord](https://github.com/kushagrasinghx/BitChord) directly to the [Soulseek](https://www.slsknet.org/) peer-to-peer network.

**Search. Connect. Stream.**

P2PChord is a Windows-friendly BitChord HTTP add-on. Soulseek is enabled by default; the experimental BitTorrent provider can be enabled separately or alongside it. Both expose FLAC results through the same range-capable BitChord stream endpoint.

## How it works

1. BitChord sends a music search to P2PChord.
2. Enabled providers return FLAC candidates: Soulseek searches the network; BitTorrent searches only user-configured torrents by filename.
3. BitChord compares candidate titles and reported durations to the requested track, then asks P2PChord to stream its selected match.
4. P2PChord serves verified/cached bytes over HTTP ranges. Playback timing still depends on BitChord buffering and source-switching behavior.

## Architecture overview

P2PChord implements BitChord's HTTP add-on flow with independent bounded providers and a shared transfer limit. Soulseek uses its persistent partial/completed cache; BitTorrent uses a separate WebTorrent piece store. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for provider lifecycle, protocol details, compatibility gaps, and limitations.

See [docs/COMPATIBILITY_AND_ROADMAP.md](./docs/COMPATIBILITY_AND_ROADMAP.md) for the inspected BitChord authentication compatibility findings and planned roadmap.

See [CHANGELOG.md](./CHANGELOG.md) for release history.

> **Version `alpha-0.1.0`.** This is an early alpha prototype; expect bugs, breaking changes, and incomplete behavior.

> **New here?** Follow [Quick start](#quick-start-windows). You only need the [HTTPS setup](#remote-access-https) if BitChord cannot reach the server on the same computer or network.

Please read the [public-domain and authorized-use notice](#public-domain-and-authorized-music) and [prototype disclaimer](#vibecoded-prototype-disclaimer).

---

## Quick start (Windows)

The desktop launcher opens a local dashboard in your default browser—no Tkinter is used. It starts P2PChord and keeps optional Soulseek credentials only in memory and the child process environment.

### Before you start

- A Soulseek account (username and password) if you enable Soulseek. BitTorrent-only mode does not require one.
- Python 3.10 or newer, Node.js 22 or newer, and a modern web browser.
- P2PChord downloaded and extracted.
- Internet access to Soulseek. The launcher installs the Node dependency on first use; alternatively run `npm install` in the project folder.
- Stop any existing slskd or Soulseek client logged in with the same account to prevent duplicate-login disconnects.

### 1. Open the launcher

Double-click `ez-start.bat` in the project folder. The dashboard opens in your browser and listens only on this computer using a temporary session URL. If Windows cannot find Python, open PowerShell in that folder and run:

```powershell
python .\launcher.py
```

### 2. Enter settings and start

1. Choose **Enable Soulseek** (on by default) and/or **Enable BitTorrent** (off by default). Enter a Soulseek username and password only when Soulseek is enabled. For BitTorrent, add one or more magnet URIs or absolute local `.torrent` paths.
2. Keep the detected Tailscale HTTPS URL, or enter your own public base URL. For local-only testing, use `http://127.0.0.1:8080`. To connect from another device on the same LAN, use **Use LAN address** in Source.
3. **Start Tailscale Funnel** is off by default because it exposes the server to the public internet. Enable it only when you intend to use Funnel; P2PChord turns off the Funnel endpoint it configured when stopped.
4. Optionally open **Source URL settings** to adjust the public address, Funnel, and source URL word settings. **Allow downloads in BitChord** and **Require BitChord 1.9.1 signed authentication** are separate opt-ins and off by default. Signed authentication requires HTTPS except on localhost and is incompatible with BitChord clients older than 1.9.1. Each word's length is randomized within 3 letters of the target, limited to supported 3–9 letter words. The word list offers 10 times as many adjective and noun choices as before.
5. Click **Start**. Keep the dashboard and launcher running while using BitChord.

The launcher starts the enabled providers and displays the BitChord source URL in the Activity panel. Click **Copy source URL**, then add it in BitChord under **Sources → Add addon**. Soulseek credentials are sent only to the local launcher and child-process environment; they are not saved to a settings file. Stop with **Stop**, or use **Exit** to stop providers and close the dashboard.

P2PChord uses the `p2pchord-addon` manifest ID, `P2PCHORD_*` environment variables, P2PChord browser settings keys, and `%LOCALAPPDATA%\P2PChord` storage namespace. This rebrand is breaking: previous environment variables, browser settings, and source URLs are not migrated. Existing cache folders are left untouched; the server starts with the new cache location. Re-add the newly printed source URL to BitChord after restarting. The Soulseek client logs in with uploads disabled and does not share local files. The launcher lets you choose 2–8 readable words and a target length of 3–9 letters; each word varies up to 3 letters from that target. The word list is derived in part from WordNet (see [third-party notices](./THIRD_PARTY_NOTICES.md)). Keep the complete source URL private.

### BitTorrent provider (experimental)

The optional BitTorrent provider accepts only user-supplied magnets and local
`.torrent` files; it is not a public torrent search engine. It searches imported
torrent filenames for FLAC candidates and uses WebTorrent's verified piece
reads for HTTP ranges/seeking. It is off by default, has separate storage under
`%LOCALAPPDATA%\P2PChord\torrents`, shares the configured concurrency cap
with Soulseek, and limits each FLAC to the configured per-track size and total
declared torrent size to 4 GiB by default.

UPnP/NAT-PMP mappings, web seeds, and uploads are disabled. This does not hide
your public IP address from trackers or peers, and a local peer listener may still be
opened. No live BitTorrent peer or actual BitChord playback test has yet been
performed; automated coverage uses synthetic streams and provider fixtures.
Do not treat those tests as proof of real-network availability or performance.

### LAN setup for another device

Connect the PC and device to the same trusted private network. In the launcher,
select **Use LAN address** or enable **Connect from another device on this LAN**.
P2PChord detects a private IPv4 address, uses `http://<LAN-IP>:8080` as its
advertised base URL, binds the server only to that private address, and prints
a copyable source URL containing the adjective/noun route phrase. The phrase
is the route credential in this mode and has less entropy than the normal
128-bit token, so use it only on a trusted
LAN and keep the full URL private. If Windows Firewall
asks, allow P2PChord on **Private networks only**; do not expose port 8080 to
Public networks or the internet. If no private address is detected, use the
base-address field or check that the PC is connected to Wi-Fi/Ethernet. If the
PC has multiple network adapters or a VPN, confirm the detected address belongs
to the same network as the other device.

**Android limitation:** the current BitChord Android
[manifest](https://github.com/kushagrasinghx/BitChord/blob/main/app/src/main/AndroidManifest.xml)
sets `android:usesCleartextTraffic="false"`. Android therefore rejects the launcher's
plain-HTTP LAN URL before it reaches P2PChord; the server cannot override an
app's network-security policy. The safe fixes are a BitChord change that
explicitly opts in to cleartext only for a user-approved LAN add-on host, or
using HTTPS with a certificate trusted by Android (for example a Tailscale
HTTPS address when both devices are on that tailnet). Do not globally enable
cleartext traffic or install an untrusted certificate just to use this URL.

For manual Funnel setup, use:

```powershell
tailscale funnel --bg 8080
```

When finished, turn off that manually configured endpoint with:

```powershell
tailscale funnel --bg --https=443 8080 off
```

### Manual setup (without the launcher)

In PowerShell, open the P2PChord project folder and install its dependencies. The following example enables Soulseek:

```powershell
npm install
$env:SOULSEEK_USERNAME = 'YOUR_SOULSEEK_USERNAME'
$env:SOULSEEK_PASSWORD = 'YOUR_SOULSEEK_PASSWORD'
$env:PUBLIC_BASE_URL = 'http://127.0.0.1:8080'
# The server binds to localhost by default. For LAN access, bind to the PC's
# private LAN IPv4 address (the launcher does this automatically in LAN mode).
# $env:P2PCHORD_BIND_ADDRESS = '192.168.1.42'
# Optional: enable BitChord's download action for this source (off by default).
# $env:P2PCHORD_ALLOW_DOWNLOADS = 'true'
# Optional: require BitChord 1.9.1 signed request authentication (off by default).
# Requires HTTPS except for localhost; older clients cannot use this mode.
# $env:P2PCHORD_BITCHORD_AUTH = 'true'
# Optional: torrent-only mode (omit Soulseek credentials in this mode).
# $env:P2PCHORD_SOULSEEK_ENABLED = 'false'
# $env:P2PCHORD_TORRENT_ENABLED = 'true'
# $env:P2PCHORD_TORRENT_SOURCES = '["C:\\Torrents\\album.torrent"]'
node .\direct_server.mjs
```

For HTTPS, set `PUBLIC_BASE_URL` to your public address before running the server. Add the printed source URL to BitChord.

---

## Remote access (HTTPS)

HTTPS is needed when BitChord accesses the add-on from another device or over the internet. Keep the computer running while you use the source.

### Option A: Tailscale Funnel (no domain)

1. Install [Tailscale for Windows](https://tailscale.com/download/windows) and sign in.
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**.
3. In PowerShell, run:

   ```powershell
   tailscale funnel --bg 8080
   ```

4. Copy the `https://...ts.net` address it prints. In the PowerShell window where you start P2PChord, set it as `PUBLIC_BASE_URL` along with the other settings:

   ```powershell
   $env:PUBLIC_BASE_URL = 'https://your-device.your-tailnet.ts.net'
   ```

   Then run `node .\direct_server.mjs` and add the newly printed source URL to BitChord.

Funnel is currently in beta and has non-configurable bandwidth limits. It is best for personal, light use rather than high-volume streaming. See the [Tailscale Funnel guide](https://tailscale.com/docs/features/tailscale-funnel) and [command reference](https://tailscale.com/docs/reference/tailscale-cli/funnel).

### Option B: Caddy (custom domain)

Caddy can automatically get and renew a free HTTPS certificate. You need a domain (which may cost money), a public IP address, and a computer/network that accepts internet connections.

1. Point your domain's DNS `A` record to your public IP. Configure dynamic DNS if your IP changes.
2. Forward TCP ports **80** and **443** on your router to the P2PChord computer, and allow Caddy through Windows Firewall. Do **not** forward port `8080`.
3. [Install Caddy for Windows](https://caddyserver.com/docs/install).
4. In the project folder, create a `Caddyfile`, replacing the example domain:

   ```powershell
   @'
   music.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   '@ | Set-Content -Encoding ascii .\Caddyfile
   ```

5. In one PowerShell window, configure your Soulseek login and public URL, then start P2PChord:

   ```powershell
   npm install
   $env:SOULSEEK_USERNAME = 'your-soulseek-username'
   $env:SOULSEEK_PASSWORD = 'your-soulseek-password'
   $env:PUBLIC_BASE_URL = 'https://music.example.com'
   node .\direct_server.mjs
   ```

6. In a second PowerShell window, start Caddy:

   ```powershell
   caddy run --config .\Caddyfile
   ```

Use the source URL P2PChord prints. `PUBLIC_BASE_URL` must match the domain in the Caddyfile. If a certificate is not issued, check that DNS points to your public IP and that ports 80 and 443 reach this computer. Some ISPs use CGNAT or block these ports, preventing direct hosting.

For regular streaming, Caddy avoids tunnel bandwidth caps, but availability still depends on your computer, home internet, and ISP. Always-on hosting generally requires paid hosting. Cloudflare Quick Tunnels are temporary and have no uptime guarantee; Cloudflare's terms also restrict disproportionate audio delivery through its CDN, so they are not recommended for ongoing music streaming.

---

## Settings

| Environment variable | Required? | Default | Purpose |
| --- | --- | --- | --- |
| `SOULSEEK_USERNAME` | When Soulseek is enabled | — | Soulseek account used to search and request authorized files directly from peers. |
| `SOULSEEK_PASSWORD` | When Soulseek is enabled | — | Soulseek password; keep it private. |
| `P2PCHORD_SOULSEEK_ENABLED` | No | `true` | Enable the Soulseek provider. At least one provider must be enabled. |
| `P2PCHORD_TORRENT_ENABLED` | No | `false` | Enable the experimental BitTorrent provider; requires configured sources. |
| `P2PCHORD_TORRENT_SOURCES` | When BitTorrent is enabled | `[]` | JSON array of at most 8 magnet URIs or absolute local `.torrent` paths. No public torrent search is performed. |
| `P2PCHORD_TORRENT_STORAGE_MAX_BYTES` | No | `4294967296` (4 GiB) | Maximum aggregate declared size of imported torrents. |
| `P2PCHORD_TORRENT_DIRECTORY` | No | `%LOCALAPPDATA%\P2PChord\torrents` on Windows | Separate WebTorrent piece store; does not expose the Soulseek cache. |
| `PUBLIC_BASE_URL` | No | `http://127.0.0.1:8080` | Address BitChord uses to reach P2PChord. Set this for HTTPS or a non-local address. |
| `BITCHORD_SECRET` | No | Generated URL-safe 128-bit token, appended after readable words | Overrides the generated add-on route credential. Launcher LAN mode instead supplies its adjective/noun phrase as the credential. Keep the complete URL private. |
| `P2PCHORD_WORD_COUNT` | No | `3` | Number of readable URL words for direct/manual server launches (2–8); the last word is a noun. |
| `P2PCHORD_WORD_LENGTH` | No | `6` | Target number of letters per readable URL word for direct/manual server launches (3–9); each word varies by up to 3 letters, clamped to 3–9. |
| `P2PCHORD_ALLOW_DOWNLOADS` | No | `false` | Set to `true` to advertise download support to BitChord for this add-on. The launcher exposes the same option and leaves it off by default. |
| `P2PCHORD_SOURCE_SELECTION` | No | `match` | `match` returns up to 50 filename-ranked results; `speed` returns only the peer reporting the highest upload speed. The launcher exposes both modes. |
| `P2PCHORD_SEARCH_LIMIT` | No | `50` | Maximum filename-ranked search results (1–50). Fastest-speed selection always returns one. |
| `P2PCHORD_SEARCH_TIMEOUT_MS` | No | `2000` | Per-query Soulseek search timeout (500–30,000 ms). |
| `P2PCHORD_SEARCH_RECOVERY` | No | `true` | Retry once with likely restored vowels if a search returns no results. |
| `P2PCHORD_MAX_ACTIVE_STREAMS` | No | `2` | Shared concurrent transfer limit across enabled providers (1–2). |
| `P2PCHORD_MAX_STREAM_BYTES` | No | `134217728` (128 MiB) | Maximum size of an individual track; the launcher allows 1–128 MiB. |
| `P2PCHORD_FIRST_BYTE_TIMEOUT_MS` | No | `30000` | Cancel a newly requested peer transfer if no audio chunk arrives within 1–300 seconds; partial data remains cached. |
| `P2PCHORD_PEER_IDLE_TIMEOUT_MS` | No | `30000` | `slsk-client` inactivity timeout for a peer connection (1–300 seconds); does not change the 15-minute overall transfer limit. |
| `P2PCHORD_CACHE_DIRECTORY` | No | `%LOCALAPPDATA%\P2PChord\cache` on Windows; `~/.cache/P2PChord/cache` elsewhere | Directory for persistent FLAC cache data. |
| `P2PCHORD_CACHE_TTL_MS` | No | `1800000` (30 minutes) | Time since last access before an inactive cached file expires. |
| `P2PCHORD_CACHE_MAX_BYTES` | No | `2147483648` (2 GiB) | Maximum cache size; inactive entries are evicted least-recently-used first. |
| `P2PCHORD_IDLE_TRANSFER_TIMEOUT_MS` | No | `30000` | Grace period after the last HTTP consumer disconnects before stopping an unfinished provider transfer. Soulseek partial bytes remain cached for future offset-resume. |
| `P2PCHORD_SLUG` | No | `p2pchord` | URL path for this add-on. |
| `PORT` | No | `8080` | Local port for the add-on server. |

The launcher’s **Search and transfer settings** panel exposes the search result
limit (1–50), timeout (1–30 seconds), spelling-recovery retry, reconnect grace
(1–600 seconds), cache TTL (1–10,080 minutes) and size (16–32,768 MiB), active
transfer slots (1–2), and per-track size limit (1–128 MiB). These choices apply
to that launch only; they are not saved. Defaults preserve the existing
behavior: match-first search, 50 results, a 2-second search timeout, spelling
recovery enabled, 30-second reconnect grace, 30-minute/2-GiB cache, two
transfer slots, and 128 MiB maximum per track. The transfer-slot control is
capped at two.

---

## First test and troubleshooting

1. Start P2PChord and wait for the launcher to report its enabled providers and show the add-on URL.
2. Open `<printed-source-url>/manifest.json` in a browser. The JSON should include **P2PChord**.
3. Add the printed source URL in BitChord under **Sources → Add addon**. Search for a known FLAC result and try playback.

When BitChord requests the file URL, P2PChord streams from the selected enabled provider. For automatic lossless replacement of YouTube audio, keep the P2PChord add-on enabled and ranked above YouTube in BitChord's source settings. If Soulseek login times out, check internet access and credentials and close other Soulseek clients using the same account. If search or playback fails, check the launcher activity log, source availability, and that `PUBLIC_BASE_URL` is reachable from BitChord.

Streaming logs include elapsed time from the HTTP request through transfer-slot
acquisition, `slsk-client` request, peer status and first data, cache write,
cache readability, and the first audio body write queued to the HTTP response.
The last stage measures when Node accepts the body chunk, not when it reaches
BitChord's network interface. A peer that sends no initial chunk is cancelled
after 30 seconds by default; peer connection inactivity also times out after
30 seconds. Both deadlines can be adjusted with the settings above.

---

## What to expect

- By default, the launcher returns up to 50 safe FLAC files, ranked by filename match so BitChord can choose among versions and releases using its own title and duration matching. Set **Source selection** to **Highest reported upload speed** to return only the single candidate whose peer reports the highest speed across all matching FLAC results. Peer speed is self-reported, not measured; this option can choose a less relevant match. **Search and transfer settings** lets you adjust the result limit (1–50), search timeout, and recovery retry. Track numbers are removed from filenames, artist-title filenames expose their artist when the search query supports that split, and duration is included when the Soulseek peer reports it. Peer usernames are not presented as artist credits; full music tags are not read from search results.
- Search terms are normalized for Soulseek by folding common Latin diacritics and treating punctuation (including slashes) as word separators. If enabled and a search finds nothing, a strongly compressed consonant cluster may trigger at most one likely-vowel-restoration retry (for example `bnd dmon` → `bend demon`) to avoid flooding Soulseek with spelling variants.
- Search rows identify the format as `flac` and quality as `LOSSLESS`; stream responses also declare the FLAC codec, container, and `audio/flac` MIME type.
- Downloads are disabled by default. When `allowDownloads` is `false`, BitChord deliberately skips this add-on as a download source, even though playback/search work. Enable **Allow downloads in BitChord** in the launcher (or set `P2PCHORD_ALLOW_DOWNLOADS=true` for a manual launch), restart P2PChord, then refresh or re-add the source in BitChord so it reads the updated manifest. Confirm `/manifest.json` reports `"allowDownloads": true`. Only download files you are authorized to access.
- P2PChord serves Soulseek bytes from disk as they arrive and torrent bytes only after WebTorrent verifies their pieces. Live partial Soulseek responses omit the complete-file size (`Content-Range: .../*`); bounded ranges retain their exact response length, and `HEAD` reports the known file size. Whether BitChord begins playback before transfers complete depends on the player and its buffering/source-switching path.
- Disk-backed streaming and caching do not eliminate `slsk-client`'s in-memory buffering: the installed library retains received chunks in memory and concatenates them when each download completes. The launcher allows a per-track limit of 1–128 MiB and one or two concurrent transfers (never more than two), so concurrent downloads can still use substantial memory, with additional peak usage during completion.
- Soulseek completed FLACs are verified against the search result size, then atomically moved from a `.part` file into the persistent cache. Repeat requests and ranges are served from the completed cache, including after restart. The cache defaults to 30 minutes since last access and 2 GiB, with LRU eviction. The `P2PCHORD_CACHE_*` settings configure its path, TTL, and size.
- The installed `slsk-client` supports resuming at a byte offset. If all HTTP consumers disconnect, P2PChord keeps a Soulseek track's active transfer for the configured grace period (30 seconds by default), then releases its slot while retaining partial bytes. A later request resumes from the contiguous cached byte count. The shared authenticated Soulseek client remains connected for the lifetime of the server.
- P2PChord uses BitChord's **HTTP add-on API**, not its JavaScript module API.
- The source URL has a configurable adjective-and-noun phrase followed by a separate bearer token with 128 bits of randomness; keep the complete URL private. The phrase is descriptive only and does not provide authentication. Soulseek credentials are used by the local client and are never sent to BitChord.

### Endpoints

- `GET /{slug}/{secret}/manifest.json` — add-on manifest.
- `GET /{slug}/{secret}/search?q=...` — FLAC search.
- `GET /{slug}/{secret}/stream/{id}` — stream descriptor.
- `GET|HEAD /{slug}/{secret}/file/{id}` — direct peer-to-BitChord stream with byte-range support.

### Developer tests

The automated tests use a stub peer client and do not connect to Soulseek:

```powershell
npm test
python -m unittest -v
```

### Versioning

The project uses `alpha-MAJOR.MINOR.PATCH` labels while it is experimental. The current development line has been reset to `alpha-0.1.0`. The version is defined once in `version.txt`, read by the Python launcher and Node server, and shown in the launcher and BitChord manifest.

For alpha updates, increment the patch number for small changes and the minor number for larger feature milestones. Reserve `1.0.0` for a stable release; until then, interfaces and behavior may change.

---

## Public-Domain and Authorized Music

Use P2PChord only to search for and stream music you have permission to access and stream. P2PChord does not verify copyright status, public-domain status, or streaming permissions; Soulseek search results and torrent metadata are not proof of authorization. You are responsible for confirming that you have the necessary rights before streaming a file.

## License and third-party software

Copyright (C) 2026 P2PChord contributors. P2PChord is licensed under the GNU General Public License, version 3 only; see [LICENSE](./LICENSE) for the complete terms.

P2PChord is an independent project. It is not affiliated with, endorsed by, or sponsored by BitChord, Soulseek, Tailscale, or Caddy. Their names and marks belong to their respective owners.

The runtime packages and upstream project references are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). These notices do not change the license of P2PChord.

## Vibecoded AI Prototype Disclaimer

P2PChord is an experimental proof-of-concept. Its code and instructions may contain mistakes and have not been independently audited or tested against every Soulseek peer, BitTorrent swarm, network setup, or BitChord release. Review the code and configuration, and test in a controlled environment before exposing it to the internet. Use it at your own risk; the authors provide no warranty or guarantee of availability, security, or fitness for a particular purpose.
