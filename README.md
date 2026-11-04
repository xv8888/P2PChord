# BitSeekWin - BitChord-Soulseek Integration

A Windows-friendly BitChord add-on prototype that searches a configured slskd instance for FLAC files, queues a selected result through slskd, then streams the downloaded file to BitChord with byte-range seeking.

BitSeekWin uses BitChord's HTTP add-on API, not its JavaScript module API. Add the source URL printed at startup under **Sources → Add addon**.

See the [public-domain and authorized-use notice](#public-domain-and-authorized-music).

## Requirements

- Python 3.10 or newer (no Python packages required).
- slskd running and connected to Soulseek, with an API key that has search and download permissions.
- The slskd downloads directory mounted/visible to this server at the same path. This is necessary when using Docker.
- For the Caddy setup: a domain name and a computer that can stay on and accept internet connections.

## Recommended: free HTTPS with Caddy (Windows)

This keeps the server on your own computer, while Caddy automatically gets and renews a free HTTPS certificate. The certificate is free; a domain name may cost money. Your computer and internet connection must stay on for BitChord to reach the server.

1. Get a domain and point its DNS `A` record to your public IP address. If your IP changes, configure dynamic DNS with your domain or router.
2. In your router, forward TCP ports **80** and **443** to the Windows computer that will run this project. Allow Caddy through Windows Firewall. Do not forward port `8080` or slskd's port `5030`.
3. [Install Caddy for Windows](https://caddyserver.com/docs/install) and make sure `caddy` works in PowerShell.
4. In the project folder, create a file named `Caddyfile` with your domain:

```powershell
@'
music.example.com {
    reverse_proxy 127.0.0.1:8080
}
'@ | Set-Content -Encoding ascii .\Caddyfile
```

Replace `music.example.com` with your domain.

5. Start slskd and make sure it is connected. Create an API key in slskd with search and download permissions.
6. In one PowerShell window, open the project folder and start the add-on. Replace the API key, downloads path, and domain:

```powershell
$env:SLSKD_URL = 'http://127.0.0.1:5030'
$env:SLSKD_API_KEY = 'paste-your-slskd-api-key-here'
$env:SLSKD_DOWNLOAD_DIR = 'D:\path\to\slskd\downloads'
$env:PUBLIC_BASE_URL = 'https://music.example.com'
$env:BITCHORD_SECRET = 'paste-a-long-random-secret-here'
python server.py
```

7. In a second PowerShell window, from the project folder, start Caddy:

```powershell
caddy run --config .\Caddyfile
```

Keep both windows and the computer running. The add-on prints a URL; in BitChord, open **Sources → Add addon** and paste it. If the certificate does not appear, check that the domain resolves to your public IP and that ports 80 and 443 reach this computer. Some ISPs use CGNAT or block these ports; in that case, direct hosting may not work.

`SLSKD_DOWNLOAD_DIR` must point to the downloads folder slskd uses. `PUBLIC_BASE_URL` must exactly match the public HTTPS address in your Caddyfile. Choose a long random `BITCHORD_SECRET` and keep it private; it is included in the add-on URL. Do not expose slskd's API key or API endpoint to BitChord.

**Docker:** Mount the same downloads folder into both containers at the same container path, then set `SLSKD_DOWNLOAD_DIR` to that path (for example, `/downloads`).

Optional: set `$env:BITSEEKWIN_SLUG = 'bitseekwin'` before startup to choose the URL path. The default is `bitseekwin`; older `BITSEEK_SLUG` and `BITCHORD_SLUG` variables are still accepted if `BITSEEKWIN_SLUG` is unset.

### Free HTTPS without a domain: Tailscale Funnel

For a quick setup without a custom domain or router port forwarding, install [Tailscale](https://tailscale.com/download/windows) and sign in. Enable **MagicDNS** and **HTTPS certificates** in the Tailscale admin console. In PowerShell, run:

```powershell
tailscale funnel --bg 8080
```

The first run may ask you to approve Funnel in a browser. Copy the `https://...ts.net` address it prints, then set it as `PUBLIC_BASE_URL` in the PowerShell window where you start `server.py`, for example:

```powershell
$env:PUBLIC_BASE_URL = 'https://your-device.your-tailnet.ts.net'
python server.py
```

Set the other required slskd environment variables in that same window before `python server.py`. Funnel provides HTTPS and a stable Tailscale hostname without a custom domain. It is currently in beta and has non-configurable bandwidth limits, so use it for personal/light use rather than relying on it for high-volume streaming. See the [Tailscale Funnel guide](https://tailscale.com/docs/features/tailscale-funnel) and [Funnel command reference](https://tailscale.com/docs/reference/tailscale-cli/funnel).

For regular streaming, prefer the direct Caddy setup above: you avoid tunnel bandwidth caps, but availability still depends on your computer, home internet, and ISP. A truly always-on hosted server generally requires paid hosting. Cloudflare Quick Tunnels are temporary and have no uptime guarantee; Cloudflare's terms also restrict disproportionate audio delivery through its CDN, so they are not recommended for ongoing music streaming.

The server searches for FLAC results only. Display titles are taken from the shared filename; duration and full music tags are not currently read from the remote search result. When BitChord requests a file, the server asks slskd to download that result into a per-track `bitchord-cache` subdirectory, waits for completion, then serves the completed FLAC. The first play can therefore take as long as the peer's queue and transfer. Subsequent plays use the cached file. Set `DOWNLOAD_TIMEOUT` to change the maximum wait (default 600 seconds); set `SEARCH_TIMEOUT` to change the search collection window (default 6 seconds).

## BitChord endpoints

- `GET /{slug}/{secret}/manifest.json` — declares `search` and `stream`.
- `GET /{slug}/{secret}/search?q=...` — searches slskd and returns FLAC results.
- `GET /{slug}/{secret}/stream/{id}` — returns the add-on stream descriptor.
- `GET|HEAD /{slug}/{secret}/file/{id}` — downloads on first use and streams the cached file; supports single byte ranges.

The source URL contains a bearer secret; keep it private. Do not expose slskd's API key or API endpoint to the player.

## First-test checklist

1. Start slskd and confirm it is connected.
2. Start BitSeekWin and check that it prints the add-on URL and a `Listening` log line.
3. Open `<printed-source-url>/manifest.json` in a browser. You should see a JSON manifest named **BitSeekWin - BitChord-Soulseek Integration**.
4. In BitChord, add the printed source URL under **Sources → Add addon**, search for a known FLAC result, and try playback. The first play waits while slskd downloads the selected result.
5. To test the API without BitChord, open `<printed-source-url>/search?q=your%20query` in a browser. Use the exact source URL printed at startup.

If a search fails, confirm that `SLSKD_URL` is reachable from this machine and that the API key allows searches. If playback fails, confirm that the slskd download path is shared with BitSeekWin, slskd can download the result, and `PUBLIC_BASE_URL` reaches this server over HTTPS. A `504` means the download did not finish before `DOWNLOAD_TIMEOUT`.

## Developer test suite

These tests use a stub slskd client and do not connect to Soulseek:

```powershell
python -m unittest -v
```

## Public-Domain and Authorized Music

Use BitSeekWin only to search for and stream public-domain music or music you have permission to access and stream. BitSeekWin does not verify copyright status, public-domain status, or streaming permissions; slskd search results are not proof of authorization. You are responsible for confirming that you have the necessary rights before downloading or playing a file.