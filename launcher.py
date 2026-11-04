import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from version import __version__

APP_NAME = "BitSeekWin"
PROJECT_DIR = Path(__file__).resolve().parent
PORT = 8080
MAX_REQUEST_SIZE = 64 * 1024
MAX_LOG_LINES = 250


def normalize_public_url(value: str) -> str:
    url = value.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("Enter a full URL, such as https://device.tailnet.ts.net.")
    if (
        parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or parts.path not in ("", "/")
    ):
        raise ValueError(
            "Enter only the base URL; do not include credentials, a path, or query."
        )
    if any(ord(char) < 33 for char in url):
        raise ValueError("The URL cannot contain spaces or control characters.")
    return url


def build_bitseekwin_environment(
    base: dict[str, str],
    username: str,
    password: str,
    secret: str,
    public_url: str,
) -> dict[str, str]:
    env = base.copy()
    for key in ("SLSKD_API_KEY", "SLSKD_SLSK_USERNAME", "SLSKD_SLSK_PASSWORD"):
        env.pop(key, None)
    env.update(
        {
            "SOULSEEK_USERNAME": username,
            "SOULSEEK_PASSWORD": password,
            "BITCHORD_SECRET": secret,
            "PUBLIC_BASE_URL": public_url,
            "PORT": str(PORT),
        }
    )
    return env


def find_node_runtime() -> str:
    executable = shutil.which("node")
    if not executable:
        raise ValueError("Install Node.js 22 or newer, then restart the launcher.")
    try:
        result = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            check=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("Could not check the installed Node.js version.") from error
    version = re.fullmatch(r"v(\d+)\.\d+\.\d+", result.stdout.strip())
    if version is None or int(version.group(1)) < 22:
        raise ValueError("Node.js 22 or newer is required.")
    return executable


def find_tailscale() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    for candidate in (
        Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        / "Tailscale"
        / "tailscale.exe",
        Path(r"C:\Program Files (x86)\Tailscale IPN\tailscale.exe"),
    ):
        if candidate.is_file():
            return str(candidate)
    return None


def detect_tailscale_url(tailscale: str | None = None) -> str:
    executable = tailscale or find_tailscale()
    if not executable:
        return ""
    try:
        result = subprocess.run(
            [executable, "status", "--json"],
            capture_output=True,
            check=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        dns_name = (
            json.loads(result.stdout).get("Self", {}).get("DNSName", "").rstrip(".")
        )
        return f"https://{dns_name}" if dns_name else ""
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return ""


def _terminate_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=8)
    except OSError:
        return
    except subprocess.TimeoutExpired:
        try:
            process.kill()
            process.wait(timeout=5)
        except OSError:
            return


class LauncherController:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.server_process: subprocess.Popen | None = None
        self.starting = False
        self.status = "Ready"
        self.detail = "Enter your Soulseek login to get started."
        self.source_url = ""
        self.logs: deque[str] = deque(maxlen=MAX_LOG_LINES)
        self.stop_requested = threading.Event()
        self.tailscale = find_tailscale()

    def log(self, message: str) -> None:
        with self.lock:
            self.logs.append(message)

    def snapshot(self) -> dict:
        with self.lock:
            running = (
                self.server_process is not None and self.server_process.poll() is None
            )
            if not self.starting and self.server_process is not None and not running:
                self.status = "Stopped unexpectedly"
                self.detail = (
                    "Check the activity log. Select Stop before starting again."
                )
            return {
                "status": self.status,
                "detail": self.detail,
                "starting": self.starting,
                "running": running,
                "active": running,
                "source_url": self.source_url,
                "logs": list(self.logs),
            }

    def start(self, config: dict) -> None:
        with self.lock:
            if self.starting or self._any_process_running():
                raise ValueError(
                    "Services are already starting or running. Stop them before restarting."
                )

        username = str(config.get("username", "")).strip()
        password = str(config.get("password", ""))
        public_text = str(config.get("public_url", ""))
        use_funnel = config.get("start_funnel") is True

        if not username or not password:
            raise ValueError("Enter your Soulseek username and password.")
        node = find_node_runtime()
        public_url = normalize_public_url(public_text)
        if use_funnel and not public_url.startswith("https://"):
            raise ValueError("Tailscale Funnel requires an https:// public URL.")
        if use_funnel and not self.tailscale:
            raise ValueError("Tailscale was not found. Install it or turn off Funnel.")

        with self.lock:
            if self.starting or self._any_process_running():
                raise ValueError(
                    "Services are already starting or running. Stop them before restarting."
                )
            self.starting = True
            self.status = "Starting"
            self.detail = "Connecting directly to Soulseek…"
            self.source_url = ""
            self.stop_requested.clear()
            self.logs.clear()
        threading.Thread(
            target=self._start_worker,
            args=(node, username, password, public_url, use_funnel),
            daemon=True,
        ).start()

    def _any_process_running(self) -> bool:
        return self.server_process is not None and self.server_process.poll() is None

    def _port_in_use(self, port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return True
        except OSError:
            return False

    def _read_output(
        self, name: str, process: subprocess.Popen, sensitive: tuple[str, ...]
    ) -> None:
        if process.stdout is None:
            return
        for line in process.stdout:
            message = line.rstrip()
            marker = "Add this source in BitChord: "
            if marker in message:
                source_url = message.split(marker, 1)[1].strip()
                with self.lock:
                    self.source_url = source_url
            for secret in sensitive:
                if secret:
                    message = message.replace(secret, "[redacted]")
            self.log(f"[{name}] {message}")

    def _start_worker(
        self,
        node: str,
        username: str,
        password: str,
        public_url: str,
        use_funnel: bool,
    ) -> None:
        server_process: subprocess.Popen | None = None
        try:
            if not (PROJECT_DIR / "node_modules" / "slsk-client").is_dir():
                npm = shutil.which("npm.cmd") or shutil.which("npm")
                if not npm:
                    raise RuntimeError(
                        "npm was not found. Install Node.js 22 or newer and restart."
                    )
                self.log("Installing the direct Soulseek client dependency…")
                install = subprocess.run(
                    [npm, "install", "--no-audit", "--no-fund"],
                    cwd=str(PROJECT_DIR),
                    capture_output=True,
                    text=True,
                    timeout=300,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if install.returncode:
                    detail = (install.stderr or install.stdout).strip()
                    raise RuntimeError(
                        f"npm install failed: {detail[-2000:] or 'unknown error'}"
                    )
            if self._port_in_use(PORT):
                raise RuntimeError(
                    f"Port {PORT} is already in use; close the existing BitSeekWin first."
                )
            if self.stop_requested.is_set():
                raise RuntimeError("Startup was cancelled.")

            base_env = os.environ.copy()
            server_env = build_bitseekwin_environment(
                base_env,
                username,
                password,
                secrets.token_urlsafe(32),
                public_url,
            )

            if use_funnel:
                result = subprocess.run(
                    [self.tailscale, "funnel", "--bg", str(PORT)],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if result.returncode:
                    raise RuntimeError(
                        result.stderr.strip()
                        or result.stdout.strip()
                        or "Tailscale Funnel failed."
                    )
                self.log("Tailscale Funnel configured for local port 8080.")

            if self.stop_requested.is_set():
                raise RuntimeError("Startup was cancelled.")
            server_process = subprocess.Popen(
                [node, str(PROJECT_DIR / "direct_server.mjs")],
                cwd=str(PROJECT_DIR),
                env=server_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            with self.lock:
                self.server_process = server_process
            if self.stop_requested.is_set():
                raise RuntimeError("Startup was cancelled.")
            threading.Thread(
                target=self._read_output,
                args=("BitSeekWin", server_process, (username, password)),
                daemon=True,
            ).start()
            self.log("Connecting directly to Soulseek…")

            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if self.stop_requested.is_set():
                    raise RuntimeError("Startup was cancelled.")
                if server_process.poll() is not None:
                    raise RuntimeError(
                        f"BitSeekWin exited with code {server_process.returncode}. Check the activity log."
                    )
                if self._port_in_use(PORT):
                    break
                time.sleep(0.5)
            else:
                raise RuntimeError(
                    "BitSeekWin could not connect to Soulseek and open port 8080 within 90 seconds."
                )
            with self.lock:
                self.status = "Listening"
                self.detail = "Connected to Soulseek; direct streaming is ready."
            self.log("BitSeekWin started. Add the source URL below in BitChord.")
        except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as exc:
            self.log(f"Startup failed: {exc}")
            self.stop_requested.set()
            _terminate_process(server_process)
            with self.lock:
                if self.server_process is server_process:
                    self.server_process = None
                if self.status != "Stopped":
                    self.status = "Startup failed"
                    self.detail = str(exc)
        finally:
            with self.lock:
                self.starting = False

    def stop(self) -> None:
        self.stop_requested.set()
        with self.lock:
            server_process = self.server_process
            self.server_process = None
            self.status = "Stopped"
            self.detail = "BitSeekWin has been stopped."
            self.source_url = ""
        self.log("Stopping BitSeekWin and the Soulseek connection…")
        _terminate_process(server_process)
        self.log(
            "BitSeekWin stopped. Tailscale Funnel, if enabled, remains configured in Tailscale."
        )


def _page(token: str, public_url: str) -> bytes:
    html = (
        _HTML.replace("__TOKEN_JSON__", json.dumps(token))
        .replace("__VERSION__", __version__)
        .replace("__PUBLIC_URL_JSON__", json.dumps(public_url))
    )
    return html.encode("utf-8")


_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>BitSeekWin • Setup</title>
<style>
:root{font-family:Inter,"Segoe UI",system-ui,sans-serif;color:#f6f4f6;background:#101014;font-synthesis:none;text-rendering:optimizeLegibility;--bg:#101014;--panel:#1b1b22;--field:#25252e;--line:#33333e;--muted:#a5a2ad;--subtle:#777480;--pink:#fa315c;--green:#57d998}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 78% -10%,#63213e 0,transparent 35%),var(--bg)}button,input{font:inherit}button{cursor:pointer}
.app{min-height:100vh;display:grid;grid-template-columns:224px minmax(0,1fr)}aside{background:#17171d;border-right:1px solid #282830;padding:26px 17px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:11px;padding:2px 6px 36px}.mark{width:39px;height:39px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(145deg,#ff7187,#d60e43);font-size:25px;font-weight:800;box-shadow:0 6px 22px #fa315c44}.brand-name{font-size:16px;font-weight:750;letter-spacing:-.4px}.brand-name small{display:block;color:var(--muted);font-size:9px;letter-spacing:1.3px;margin-top:3px}.nav-label{font-size:10px;font-weight:750;letter-spacing:1.2px;color:var(--subtle);padding:0 11px 9px}.nav-item{border-radius:8px;padding:11px 12px;color:#ff7791;background:#38202b;font-weight:650;font-size:13px}.side-foot{margin-top:auto;border-top:1px solid var(--line);padding:18px 9px 0;color:var(--muted);font-size:10px;line-height:1.7}.side-foot small{color:var(--subtle)}
main{width:min(1120px,100%);margin:0 auto;padding:29px 38px 35px}.topline{display:flex;justify-content:space-between;align-items:center;margin-bottom:17px;font-size:10px;font-weight:750;letter-spacing:1.3px;color:var(--muted)}.badge{background:#3a202a;color:#ff9daf;padding:7px 10px;border-radius:999px;font-size:9px;letter-spacing:.7px}.hero{height:166px;border-radius:13px;overflow:hidden;padding:24px 28px;background:linear-gradient(108deg,#f1325a 0,#bb245f 49%,#61245c 100%);position:relative;margin-bottom:21px;box-shadow:0 16px 42px #bd20552c}.hero:after{content:"";position:absolute;width:214px;height:214px;right:35px;top:-112px;border-radius:50%;border:1px solid #ffffff55;box-shadow:0 0 0 25px #ffffff12,0 0 0 52px #ffffff0a}.hero:before{content:"";position:absolute;width:58px;height:58px;right:113px;top:14px;border:2px solid #ffffff66;border-radius:50%;background:#ffcad344}.eyebrow{font-size:9px;letter-spacing:1.4px;color:#ffe0e8;font-weight:750}.hero h1{font-size:29px;letter-spacing:-1px;margin:9px 0 1px;line-height:1.08}.hero p{font-size:11px;color:#ffe3e9;margin:8px 0 0}.section-title{display:flex;align-items:center;justify-content:space-between;margin:0 1px 9px;font-size:10px;font-weight:750;letter-spacing:1.15px;color:var(--muted)}.section-title span:last-child{font-size:10px;font-weight:450;letter-spacing:0;color:var(--subtle)}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:13px}.card{background:linear-gradient(150deg,#1d1d24,#19191f);border:1px solid #30303a;border-radius:11px;padding:17px 18px}.card-title{display:flex;align-items:center;gap:9px;font-size:11px;font-weight:750;letter-spacing:.7px}.step{color:var(--pink);font-size:12px}.field{margin-top:13px}.field label{display:block;margin-bottom:6px;color:var(--muted);font-size:9px;font-weight:750;letter-spacing:.8px;text-transform:uppercase}.control{display:flex;gap:7px}.control input,.field input{width:100%;min-width:0;background:var(--field);border:1px solid #393944;border-radius:6px;padding:9px 10px;color:#f7f5f8;outline:none;font-size:11px;transition:border-color .15s,box-shadow .15s}.control input:focus,.field input:focus{border-color:#ed3a62;box-shadow:0 0 0 3px #fa315c24}.control input::placeholder,.field input::placeholder{color:#777480}.hint{font-size:9px;color:var(--subtle);margin:7px 0 0}.button{border:0;border-radius:6px;padding:9px 12px;background:#30303a;color:#f2eff3;font-size:10px;font-weight:700;white-space:nowrap;transition:filter .15s,transform .15s}.button:hover{filter:brightness(1.15)}.button:active{transform:translateY(1px)}.button.primary{background:linear-gradient(100deg,#fa315c,#df2458);color:white;box-shadow:0 5px 16px #fa315c30}.button:disabled{opacity:.45;cursor:not-allowed}.check{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:10px;color:#d4d1da}.check input{accent-color:var(--pink);width:14px;height:14px}.actions{display:flex;gap:8px;margin-top:15px}.actions .primary{flex:1}
.privacy{font-size:9px;line-height:1.5;color:var(--subtle);margin:12px 2px 13px}.activity{background:#1b1b22;border:1px solid #30303a;border-radius:10px;padding:12px 14px;min-height:152px}.activity-head{display:flex;align-items:center;gap:8px;font-size:9px;font-weight:750;letter-spacing:.9px;color:var(--muted)}.dot{width:7px;height:7px;border-radius:50%;background:#777480}.activity-state{margin-left:auto;font-size:10px;letter-spacing:0;color:#d9d6de}.copy{margin-left:7px}.url{margin-top:9px;padding:8px 9px;border-radius:5px;background:#141419;color:#ff8098;font:10px Consolas,monospace;overflow-wrap:anywhere;min-height:28px}.url.empty{color:#686671}.logs{height:82px;overflow:auto;margin-top:8px;color:#b8b5be;font:9px/1.6 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#ff849a}.success{color:var(--green)}
@media(max-width:850px){.app{grid-template-columns:1fr}aside{display:none}main{padding:21px 18px}.hero{height:152px}.cards{grid-template-columns:1fr}.activity{min-height:145px}}
</style>
</head>
<body>
<div class="app">
<aside><div class="brand"><div class="mark">♪</div><div class="brand-name">BitSeekWin<small>FOR BITCHORD</small></div></div><div class="nav-label">WORKSPACE</div><div class="nav-item">♫ &nbsp; Player setup</div><div class="side-foot">SOULSEEK &nbsp;•&nbsp; BITCHORD<br><small>Build __VERSION__</small></div></aside>
<main>
<div class="topline"><span>YOUR PERSONAL MUSIC BRIDGE</span><span class="badge">VERY EARLY PRE-ALPHA</span></div>
<section class="hero"><div class="eyebrow">BITSEEKWIN &nbsp;/&nbsp; BITCHORD</div><h1>Your music, connected.</h1><p>Search Soulseek &nbsp;·&nbsp; Stream FLAC bytes live &nbsp;·&nbsp; Listen in BitChord</p></section>
<div class="section-title"><span>CONNECT YOUR SOURCES</span><span>Your login stays on this device</span></div>
<section class="cards">
<article class="card"><div class="card-title"><span class="step">01</span> DIRECT SOULSEEK CONNECTION</div>
<div class="field"><label for="username">Soulseek username</label><input id="username" type="text" autocomplete="username" placeholder="Your Soulseek username"></div>
<div class="field"><label for="password">Soulseek password</label><input id="password" type="password" autocomplete="current-password" placeholder="Only used for this session"></div>
<p class="hint">Password is masked and cleared after starting. Credentials are not saved.</p>
</article>
<article class="card"><div class="card-title"><span class="step">02</span> DIRECT STREAM</div>
<div class="field"><label for="publicUrl">Public address</label><input id="publicUrl" type="url" autocomplete="url" placeholder="https://device.tailnet.ts.net"></div>
<label class="check"><input id="funnel" type="checkbox"> Start Tailscale Funnel on port 8080</label>
<p class="hint">Use Funnel only when you want to share over a public HTTPS .ts.net address.</p>
<div class="actions"><button class="button primary" id="start">▶ &nbsp; Start listening</button><button class="button" id="stop" disabled>Stop</button></div>
</article>
</section>
<p class="privacy">Credentials are used for this launch only and are not written to a settings file. BitSeekWin connects directly to Soulseek and streams incoming file data to BitChord without waiting for a completed download. The printed source URL is a secret; keep it private.</p>
<section class="activity"><div class="activity-head"><span>ACTIVITY</span><span id="dot" class="dot"></span><span id="state" class="activity-state">Ready</span><button class="button copy" id="copy" disabled>Copy source URL</button><button class="button" id="exit">Exit launcher</button></div><div id="url" class="url empty">Your BitChord source URL will appear here after startup.</div><div id="logs" class="logs">Ready when you are.</div></section>
</main></div>
<script>
const token=__TOKEN_JSON__, api="/"+token+"/api/";
const $=id=>document.getElementById(id);
let sourceUrl="";
$("publicUrl").value=__PUBLIC_URL_JSON__;
$("funnel").checked=$("publicUrl").value.endsWith(".ts.net");
update();
$("start").addEventListener("click",async()=>{
  const config={username:$("username").value,password:$("password").value,public_url:$("publicUrl").value.trim(),start_funnel:$("funnel").checked};
  $("start").disabled=true;$("state").textContent="Starting";$("dot").className="dot";
  try{const r=await fetch(api+"start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(config)});const d=await r.json();if(!r.ok)throw Error(d.error||"Could not start.");$("password").value="";$("username").value="";$("logs").textContent="Connecting directly to Soulseek…";}
  catch(e){$("start").disabled=false;alert(e.message);}
  await update();
});
$("stop").addEventListener("click",async()=>{try{await fetch(api+"stop",{method:"POST"});}catch(e){}await update();});
$("copy").addEventListener("click",async()=>{if(sourceUrl){await navigator.clipboard.writeText(sourceUrl);$("state").textContent="URL copied";}});
$("exit").addEventListener("click",async()=>{if(!confirm("Exit BitSeekWin and disconnect from Soulseek?"))return;try{await fetch(api+"exit",{method:"POST"});}catch(e){}document.body.innerHTML="<main><section class='hero'><h1>BitSeekWin stopped.</h1><p>You can close this browser tab.</p></section></main>";});
async function update(){try{const r=await fetch(api+"status",{cache:"no-store"});renderStatus(await r.json());}catch(e){}}
function renderStatus(s){sourceUrl=s.source_url||"";$("url").textContent=sourceUrl||"Your BitChord source URL will appear here after startup.";$("url").classList.toggle("empty",!sourceUrl);$("copy").disabled=!sourceUrl;$("logs").textContent=(s.logs||[]).join("\n")||s.detail||"";$("state").textContent=s.status||"Ready";$("dot").className="dot"+(s.running?" success":s.status==="Startup failed"?" error":"");$("start").disabled=!!s.starting||!!s.active;$("stop").disabled=!s.starting&&!s.active;}
setInterval(update,1000);
</script>
</body>
</html>"""


def make_handler(controller: LauncherController, token: str):
    class LauncherHandler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args) -> None:
            return

        def _is_local(self) -> bool:
            try:
                return ipaddress.ip_address(self.client_address[0]).is_loopback
            except ValueError:
                return False

        def _authorized(self) -> bool:
            host = self.headers.get("Host", "")
            try:
                parsed_host = urlsplit(f"http://{host}")
                address = parsed_host.hostname
                origin = self.headers.get("Origin")
                if address not in ("127.0.0.1", "localhost", "::1"):
                    return False
                if origin:
                    parsed_origin = urlsplit(origin)
                    if parsed_origin.scheme != "http" or parsed_origin.netloc != host:
                        return False
                elif self.command == "POST":
                    return False
            except ValueError:
                return False
            prefix = f"/{token}"
            path = urlsplit(self.path).path
            return (
                self._is_local()
                and (path == prefix or path.startswith(prefix + "/"))
                and hmac.compare_digest(path[: len(prefix)], prefix)
            )

        def _send_json(self, value: dict, status: int = 200) -> None:
            payload = json.dumps(value).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self._security_headers()
            self.end_headers()
            self.wfile.write(payload)

        def _security_headers(self) -> None:
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            )

        def do_GET(self) -> None:
            if not self._authorized():
                self.send_error(403)
                return
            path = urlsplit(self.path).path
            if path == f"/{token}":
                public_url = (
                    detect_tailscale_url(controller.tailscale)
                    or "http://127.0.0.1:8080"
                )
                body = _page(token, public_url)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self._security_headers()
                self.end_headers()
                self.wfile.write(body)
            elif path == f"/{token}/api/status":
                self._send_json(controller.snapshot())
            else:
                self.send_error(404)

        def do_POST(self) -> None:
            if not self._authorized():
                self.send_error(403)
                return
            path = urlsplit(self.path).path
            if path == f"/{token}/api/start":
                if self.headers.get_content_type() != "application/json":
                    self._send_json({"error": "Expected a JSON request."}, 415)
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0 or length > MAX_REQUEST_SIZE:
                        raise ValueError(
                            "Request body must be between 1 byte and 64 KB."
                        )
                    payload = json.loads(self.rfile.read(length))
                    if not isinstance(payload, dict):
                        raise ValueError("Invalid launcher settings.")
                    controller.start(payload)
                except (ValueError, json.JSONDecodeError) as exc:
                    self._send_json({"error": str(exc)}, 400)
                    return
                self._send_json(controller.snapshot(), 202)
            elif path == f"/{token}/api/stop":
                threading.Thread(target=controller.stop, daemon=True).start()
                self._send_json({"status": "Stopping"})
            elif path == f"/{token}/api/exit":
                self._send_json({"status": "Exiting"})
                threading.Thread(target=controller.stop, daemon=True).start()
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self.send_error(404)

    return LauncherHandler


def main() -> None:
    token = secrets.token_urlsafe(32)
    controller = LauncherController()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(controller, token))
    server.daemon_threads = True
    host, port = server.server_address
    dashboard = f"http://{host}:{port}/{token}"
    webbrowser.open(dashboard, new=1, autoraise=True)
    print(f"{APP_NAME} v{__version__} dashboard: {dashboard}")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        controller.stop()
        server.server_close()


if __name__ == "__main__":
    main()
