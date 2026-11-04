# BitSeekWin

### BitChord-Soulseek Integration

**Search. Queue. Stream.**

BitSeekWin is a Windows-friendly BitChord HTTP add-on prototype. It searches your configured slskd instance for FLAC files, queues the selected file through slskd, then serves the completed download to BitChord with byte-range seeking.

> **New here?** Follow [Quick start](#quick-start-local-testing). You only need the [HTTPS setup](#remote-access-https) if BitChord cannot reach the server on the same computer or network.

Please read the [public-domain and authorized-use notice](#public-domain-and-authorized-music) and [prototype disclaimer](#vibecoded-prototype-disclaimer).

---

## Quick start (local testing)

### Before you start

- Python 3.10 or newer. No extra Python packages are needed.
- slskd running and connected, with an API key that can search and download.
- The path to slskd's downloads folder.

### 1. Open PowerShell in the project folder

If you downloaded the project, open its folder in File Explorer, click the address bar, type `powershell`, and press **Enter**.

### 2. Configure and start BitSeekWin

Paste this block into PowerShell, replacing the API key and download path with your own:

```powershell
$env:SLSKD_URL = 'http://127.0.0.1:5030'
$env:SLSKD_API_KEY = 'paste-your-slskd-api-key-here'
$env:SLSKD_DOWNLOAD_DIR = 'D:\path\to\slskd\downloads'
# Optional: set a private secret to keep the printed source URL stable on restart
# $env:BITCHORD_SECRET = 'replace-with-a-long-random-secret'
python server.py
```

If slskd runs somewhere other than this computer, replace `SLSKD_URL` with the address reachable from the BitSeekWin computer. The download folder must also be visible to BitSeekWin at the path you set. For Docker, mount the same downloads folder into both containers at the same container path.

### 3. Add the source to BitChord

Copy the **Add this source in BitChord** URL printed in PowerShell. In BitChord, open **Sources → Add addon** and paste the URL.

The default address is local to this computer. Use it only when BitChord can reach BitSeekWin at that address. For another device or internet access, first configure [HTTPS access](#remote-access-https), then set `PUBLIC_BASE_URL` to that public address before starting the server.

If you leave the optional setting commented out, BitSeekWin generates a secret at startup, and the printed source URL changes each time. Treat the URL as a password: anyone who has it can access the add-on.

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

   Then run `python server.py` and add the newly printed source URL to BitChord.

Funnel is currently in beta and has non-configurable bandwidth limits. It is best for personal, light use rather than high-volume streaming. See the [Tailscale Funnel guide](https://tailscale.com/docs/features/tailscale-funnel) and [command reference](https://tailscale.com/docs/reference/tailscale-cli/funnel).

### Option B: Caddy (custom domain)

Caddy can automatically get and renew a free HTTPS certificate. You need a domain (which may cost money), a public IP address, and a computer/network that accepts internet connections.

1. Point your domain's DNS `A` record to your public IP. Configure dynamic DNS if your IP changes.
2. Forward TCP ports **80** and **443** on your router to the BitSeekWin computer, and allow Caddy through Windows Firewall. Do **not** forward ports `8080` or `5030`.
3. [Install Caddy for Windows](https://caddyserver.com/docs/install).
4. In the project folder, create a `Caddyfile`, replacing the example domain:

   ```powershell
   @'
   music.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   '@ | Set-Content -Encoding ascii .\Caddyfile
   ```

5. In one PowerShell window, configure the required slskd settings and public URL, then start BitSeekWin:

   ```powershell
   $env:SLSKD_URL = 'http://127.0.0.1:5030'
   $env:SLSKD_API_KEY = 'paste-your-slskd-api-key-here'
   $env:SLSKD_DOWNLOAD_DIR = 'D:\path\to\slskd\downloads'
   $env:PUBLIC_BASE_URL = 'https://music.example.com'
   python server.py
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
| `SLSKD_API_KEY` | Yes | — | slskd API key with search and download permissions. |
| `SLSKD_DOWNLOAD_DIR` | Yes | — | slskd downloads directory, visible at the same path to this server. |
| `SLSKD_URL` | No | `http://127.0.0.1:5030` | slskd API address reachable by BitSeekWin. |
| `PUBLIC_BASE_URL` | No | `http://127.0.0.1:8080` | Address BitChord uses to reach BitSeekWin. Set this for HTTPS or a non-local address. |
| `BITCHORD_SECRET` | No | Generated at startup | Secret included in the add-on URL. Set it to keep the URL stable across restarts. |
| `BITSEEKWIN_SLUG` | No | `bitseekwin` | URL path for this add-on. Older `BITSEEK_SLUG` and `BITCHORD_SLUG` variables are also accepted. |
| `PORT` | No | `8080` | Local port for the add-on server. |
| `SEARCH_TIMEOUT` | No | `6` seconds | How long to collect search results. |
| `DOWNLOAD_TIMEOUT` | No | `600` seconds | Maximum time to wait for a selected download. |

---

## First test and troubleshooting

1. Start slskd and confirm it is connected.
2. Start BitSeekWin and check that PowerShell shows the add-on URL and a `Listening` log line.
3. Open `<printed-source-url>/manifest.json` in a browser. The JSON should include **BitSeekWin - BitChord-Soulseek Integration**.
4. Add the printed source URL in BitChord under **Sources → Add addon**. Search for a known FLAC result and try playback.

The first play waits while slskd downloads the selected result. If search fails, check that `SLSKD_URL` is reachable and the API key allows searches. If playback fails, check the downloads path, slskd transfer, and that `PUBLIC_BASE_URL` is reachable by BitChord. A `504` response means the download did not finish before `DOWNLOAD_TIMEOUT`.

---

## What to expect

- Search results are limited to FLAC files. Titles come from shared filenames; duration and full music tags are not read from search results.
- On first playback, BitSeekWin asks slskd to download the selected file into a per-track `bitchord-cache` subdirectory, waits for completion, then serves it. Later playback uses the cached file.
- BitSeekWin uses BitChord's **HTTP add-on API**, not its JavaScript module API.
- The source URL contains a bearer secret; keep it private. Do not expose slskd's API key or API endpoint to BitChord.

### Endpoints

- `GET /{slug}/{secret}/manifest.json` — add-on manifest.
- `GET /{slug}/{secret}/search?q=...` — FLAC search.
- `GET /{slug}/{secret}/stream/{id}` — stream descriptor.
- `GET|HEAD /{slug}/{secret}/file/{id}` — cached file delivery with single byte-range support.

### Developer tests

The tests use a stub slskd client and do not connect to Soulseek:

```powershell
python -m unittest -v
```

---

## Public-Domain and Authorized Music

Use BitSeekWin only to search for and stream public-domain music or music you have permission to access and stream. BitSeekWin does not verify copyright status, public-domain status, or streaming permissions; slskd search results are not proof of authorization. You are responsible for confirming that you have the necessary rights before downloading or playing a file.

## Vibecoded Prototype Disclaimer

BitSeekWin is an experimental, AI-assisted prototype. Its code and instructions may contain mistakes and have not been independently audited or tested against every slskd version, network setup, or BitChord release. Review the code and configuration, and test in a controlled environment before exposing it to the internet. Use it at your own risk; the authors provide no warranty or guarantee of availability, security, or fitness for a particular purpose.
