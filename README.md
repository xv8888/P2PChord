# BitSeekWin

### BitChord-Soulseek Integration

Connect [BitChord](https://github.com/kushagrasinghx/BitChord) directly to the [Soulseek](https://www.slsknet.org/) peer-to-peer network.

**Search. Connect. Stream.**

BitSeekWin is a Windows-friendly BitChord HTTP add-on prototype. It searches Soulseek peers for FLAC files and streams the selected peer transfer to BitChord as the bytes arrive.

## How it works

1. BitChord sends a music search to BitSeekWin.
2. BitSeekWin searches Soulseek directly and returns up to 50 safe FLAC candidates ranked by filename match.
3. BitChord compares candidate titles and reported durations to the requested track, then asks BitSeekWin to stream its selected match.
4. BitSeekWin forwards received FLAC bytes to BitChord as they arrive. Whether playback starts before the full peer transfer completes also depends on BitChord's buffering and source-switching behavior.

> **Version `alpha-0.4.3`.** This is an early alpha prototype; expect bugs, breaking changes, and incomplete behavior.

> **New here?** Follow [Quick start](#quick-start-windows). You only need the [HTTPS setup](#remote-access-https) if BitChord cannot reach the server on the same computer or network.

Please read the [public-domain and authorized-use notice](#public-domain-and-authorized-music) and [prototype disclaimer](#vibecoded-prototype-disclaimer).

---

## Quick start (Windows)

The desktop launcher opens a local dashboard in your default browser—no Tkinter is used. It starts BitSeekWin, connects directly to Soulseek, and keeps your login only in memory and the child process environment.

### Before you start

- A Soulseek account (username and password).
- Python 3.10 or newer, Node.js 22 or newer, and a modern web browser.
- BitSeekWin downloaded and extracted.
- Internet access to Soulseek. The launcher installs the Node dependency on first use; alternatively run `npm install` in the project folder.
- Stop any existing slskd or Soulseek client logged in with the same account to prevent duplicate-login disconnects.

### 1. Open the launcher

Double-click `ez-start.bat` in the project folder. The dashboard opens in your browser and listens only on this computer using a temporary session URL. If Windows cannot find Python, open PowerShell in that folder and run:

```powershell
python .\launcher.py
```

### 2. Enter settings and start

1. Enter your Soulseek username and password. The password field is masked.
2. Keep the detected Tailscale HTTPS URL, or enter your own public base URL. For local-only testing, use `http://127.0.0.1:8080`.
3. Leave **Start Tailscale Funnel** checked if you want to use the `.ts.net` URL and Funnel is enabled for your Tailscale account.
4. Optionally open **Source URL settings** to adjust the public address, Funnel, and source URL word settings. The **Allow downloads in BitChord** option is separate and off by default. Each word's length is randomized within 3 letters of the target, limited to supported 3–9 letter words. The word list offers 10 times as many adjective and noun choices as before.
5. Click **Start**. Keep the dashboard and launcher running while using BitChord.

The launcher starts BitSeekWin, logs in to Soulseek, and displays the BitChord source URL in its status panel. The live activity console shows searches, peer transfer status, and streaming progress. If it shows repeated searches but no stream activity, BitChord is still checking candidates and has not accepted a FLAC match yet. Click **Copy source URL**, then add it in BitChord under **Sources → Add addon**. Credentials are sent only to the local launcher and child-process environment; they are not saved to a settings file. Stop with **Stop**, or use **Exit launcher** to disconnect and close the dashboard.

BitSeekWin no longer starts slskd, creates an slskd API key, or requires a downloads folder. It connects with uploads disabled and does not share local files. The launcher lets you choose 2–8 readable words and a target length of 3–9 letters; each word independently varies up to 3 letters from that target, clamped to available 3–9 letter word lists. Each URL uses one or more adjectives followed by a noun. The lexicon has 10 times as many word choices as before, derived in part from WordNet (see [third-party notices](./THIRD_PARTY_NOTICES.md)). The final URL segment is a separate 128-bit random bearer token, so changing the readable words does not weaken access security. Keep the complete URL private. After restarting, add the newly printed URL to BitChord again.

If the launcher cannot find Tailscale, enter the URL manually and start Funnel separately:

```powershell
tailscale funnel --bg 8080
```

### Manual setup (without the launcher)

In PowerShell, open the BitSeekWin project folder, install its dependencies, and set your credentials:

```powershell
npm install
$env:SOULSEEK_USERNAME = 'YOUR_SOULSEEK_USERNAME'
$env:SOULSEEK_PASSWORD = 'YOUR_SOULSEEK_PASSWORD'
$env:PUBLIC_BASE_URL = 'http://127.0.0.1:8080'
# Optional: enable BitChord's download action for this source (off by default).
# $env:BITSEEKWIN_ALLOW_DOWNLOADS = 'true'
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

4. Copy the `https://...ts.net` address it prints. In the PowerShell window where you start BitSeekWin, set it as `PUBLIC_BASE_URL` along with the other settings:

   ```powershell
   $env:PUBLIC_BASE_URL = 'https://your-device.your-tailnet.ts.net'
   ```

   Then run `node .\direct_server.mjs` and add the newly printed source URL to BitChord.

Funnel is currently in beta and has non-configurable bandwidth limits. It is best for personal, light use rather than high-volume streaming. See the [Tailscale Funnel guide](https://tailscale.com/docs/features/tailscale-funnel) and [command reference](https://tailscale.com/docs/reference/tailscale-cli/funnel).

### Option B: Caddy (custom domain)

Caddy can automatically get and renew a free HTTPS certificate. You need a domain (which may cost money), a public IP address, and a computer/network that accepts internet connections.

1. Point your domain's DNS `A` record to your public IP. Configure dynamic DNS if your IP changes.
2. Forward TCP ports **80** and **443** on your router to the BitSeekWin computer, and allow Caddy through Windows Firewall. Do **not** forward port `8080`.
3. [Install Caddy for Windows](https://caddyserver.com/docs/install).
4. In the project folder, create a `Caddyfile`, replacing the example domain:

   ```powershell
   @'
   music.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   '@ | Set-Content -Encoding ascii .\Caddyfile
   ```

5. In one PowerShell window, configure your Soulseek login and public URL, then start BitSeekWin:

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

Use the source URL BitSeekWin prints. `PUBLIC_BASE_URL` must match the domain in the Caddyfile. If a certificate is not issued, check that DNS points to your public IP and that ports 80 and 443 reach this computer. Some ISPs use CGNAT or block these ports, preventing direct hosting.

For regular streaming, Caddy avoids tunnel bandwidth caps, but availability still depends on your computer, home internet, and ISP. Always-on hosting generally requires paid hosting. Cloudflare Quick Tunnels are temporary and have no uptime guarantee; Cloudflare's terms also restrict disproportionate audio delivery through its CDN, so they are not recommended for ongoing music streaming.

---

## Settings

| Environment variable | Required? | Default | Purpose |
| --- | --- | --- | --- |
| `SOULSEEK_USERNAME` | Yes | — | Soulseek account used to search and request authorized files directly from peers. |
| `SOULSEEK_PASSWORD` | Yes | — | Soulseek password; keep it private. |
| `PUBLIC_BASE_URL` | No | `http://127.0.0.1:8080` | Address BitChord uses to reach BitSeekWin. Set this for HTTPS or a non-local address. |
| `BITCHORD_SECRET` | No | Generated URL-safe 128-bit token, appended after the readable words | Overrides the generated add-on URL secret. Treat it as a bearer token and keep it private. |
| `BITSEEKWIN_WORD_COUNT` | No | `3` | Number of readable URL words for direct/manual server launches (2–8); the last word is a noun. |
| `BITSEEKWIN_WORD_LENGTH` | No | `6` | Target number of letters per readable URL word for direct/manual server launches (3–9); each word varies by up to 3 letters, clamped to 3–9. |
| `BITSEEKWIN_ALLOW_DOWNLOADS` | No | `false` | Set to `true` to advertise download support to BitChord for this add-on. The launcher exposes the same option and leaves it off by default. |
| `BITSEEKWIN_SLUG` | No | `bitseekwin` | URL path for this add-on. |
| `PORT` | No | `8080` | Local port for the add-on server. |

---

## First test and troubleshooting

1. Start BitSeekWin and wait for the launcher to report its Soulseek connection and show the add-on URL.
2. Open `<printed-source-url>/manifest.json` in a browser. The JSON should include **BitSeekWin - BitChord-Soulseek Integration**.
3. Add the printed source URL in BitChord under **Sources → Add addon**. Search for a known FLAC result and try playback.

When BitChord requests the file URL, BitSeekWin requests the file from its Soulseek peer and forwards data as it arrives. For automatic lossless replacement of YouTube audio, keep the BitSeekWin add-on enabled and ranked above YouTube in BitChord's source settings. If startup reports `timeout login`, the Soulseek server did not answer the login request within 30 seconds; searches happen only after a successful login and do not block startup. Check internet access, confirm the username/password, and close other Soulseek clients using the same account before restarting. If search fails, check the launcher activity log and Soulseek connection. For playback failures, check that the peer is online and serving the file and that `PUBLIC_BASE_URL` is reachable from BitChord.

---

## What to expect

- Search results include up to 50 safe FLAC files, ranked by filename match so BitChord can choose among versions and releases using its own title and duration matching. Track numbers are removed from filenames, artist-title filenames expose their artist when the search query supports that split, and duration is included when the Soulseek peer reports it. Peer usernames are not presented as artist credits; full music tags are not read from search results.
- Search terms are normalized for Soulseek by folding common Latin diacritics and treating punctuation (including slashes) as word separators. If a search finds nothing and the incoming query contains a strongly compressed consonant cluster, BitSeekWin makes at most one likely-vowel-restoration retry (for example `bnd dmon` → `bend demon`) to avoid flooding Soulseek with spelling variants.
- Search rows identify the format as `flac` and quality as `LOSSLESS`; stream responses also declare the FLAC codec, container, and `audio/flac` MIME type.
- Downloads are disabled by default. Enable **Allow downloads in BitChord** in the launcher (or set `BITSEEKWIN_ALLOW_DOWNLOADS=true` for a manual launch) to advertise download support. Only download files you are authorized to access.
- BitSeekWin serves bytes received directly from a Soulseek peer without waiting for the peer transfer to finish. Live partial responses omit the complete-file size (`Content-Range: .../*`) so progressive players do not treat it as a reason to seek to the still-arriving tail; bounded ranges retain their exact response length, and `HEAD` reports the known file size. Whether BitChord begins playback before the peer transfer completes still depends on the player and its buffering/source-switching path. To support BitChord's follow-up byte-range requests without replacing an active Soulseek transfer, one peer transfer stays open and its incoming bytes are shared with each HTTP range request. The client library also buffers the active file in memory and temporarily writes a completed copy before BitSeekWin removes it. To limit memory use, files over 128 MiB are rejected and at most two peer transfers run at once.
- A new non-empty search stops any active peer-to-BitChord transfer first, so skipping to another track releases the old transfer and stream slot before the next selection starts.
- BitSeekWin uses BitChord's **HTTP add-on API**, not its JavaScript module API.
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

The project uses `alpha-MAJOR.MINOR.PATCH` labels while it is experimental. The version is defined once in `version.txt`, read by the Python launcher and Node server, and shown in the launcher and BitChord manifest.

For alpha updates, increment the patch number for small changes and the minor number for larger feature milestones. Reserve `1.0.0` for a stable release; until then, interfaces and behavior may change.

---

## Public-Domain and Authorized Music

Use BitSeekWin only to search for and stream public-domain music or music you have permission to access and stream. BitSeekWin does not verify copyright status, public-domain status, or streaming permissions; Soulseek search results are not proof of authorization. You are responsible for confirming that you have the necessary rights before streaming a file.

## License and third-party software

Copyright (C) 2026 BitSeekWin contributors. BitSeekWin is licensed under the GNU General Public License, version 3 only; see [LICENSE](./LICENSE) for the complete terms.

BitSeekWin is an independent project. It is not affiliated with, endorsed by, or sponsored by BitChord, Soulseek, Tailscale, or Caddy. Their names and marks belong to their respective owners.

The runtime packages and upstream project references are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). These notices do not change the license of BitSeekWin.

## Vibecoded AI Prototype Disclaimer

BitSeekWin is an experimental proof-of-concept, AI-assisted prototype. Its code and instructions may contain mistakes and have not been independently audited or tested against every Soulseek peer, network setup, or BitChord release. Review the code and configuration, and test in a controlled environment before exposing it to the internet. Use it at your own risk; the authors provide no warranty or guarantee of availability, security, or fitness for a particular purpose.
