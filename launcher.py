import base64
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

APP_NAME = "BitSeekWin"
PROJECT_DIR = Path(__file__).resolve().parent
__version__ = (PROJECT_DIR / "version.txt").read_text(encoding="utf-8").strip()
PORT = 8080
MAX_REQUEST_SIZE = 64 * 1024
MAX_LOG_LINES = 250
DEFAULT_SECRET_WORD_COUNT = 3
DEFAULT_SECRET_WORD_LENGTH = 6
MIN_SECRET_WORD_COUNT = 2
MAX_SECRET_WORD_COUNT = 8
MIN_SECRET_WORD_LENGTH = 3
MAX_SECRET_WORD_LENGTH = 9
SECRET_WORD_LENGTH_VARIANCE = 3
SOURCE_WORDS = json.loads(
    (PROJECT_DIR / "source_words.json").read_text(encoding="utf-8")
)


def _validate_source_word_settings(word_count: int, word_length: int) -> None:
    if (
        isinstance(word_count, bool)
        or not isinstance(word_count, int)
        or not MIN_SECRET_WORD_COUNT <= word_count <= MAX_SECRET_WORD_COUNT
    ):
        raise ValueError(
            f"Word count must be between {MIN_SECRET_WORD_COUNT} and "
            f"{MAX_SECRET_WORD_COUNT}."
        )
    if (
        isinstance(word_length, bool)
        or not isinstance(word_length, int)
        or not MIN_SECRET_WORD_LENGTH <= word_length <= MAX_SECRET_WORD_LENGTH
    ):
        raise ValueError(
            f"Word length must be between {MIN_SECRET_WORD_LENGTH} and "
            f"{MAX_SECRET_WORD_LENGTH}."
        )


def generate_source_secret(
    word_count: int = DEFAULT_SECRET_WORD_COUNT,
    word_length: int = DEFAULT_SECRET_WORD_LENGTH,
    random_bytes: bytes | None = None,
    phrase_bytes: bytes | None = None,
) -> str:
    _validate_source_word_settings(word_count, word_length)
    entropy = random_bytes if random_bytes is not None else secrets.token_bytes(16)
    if not isinstance(entropy, bytes) or len(entropy) != 16:
        raise ValueError("Source URL token entropy must be exactly 16 bytes.")
    phrase_entropy = (
        phrase_bytes if phrase_bytes is not None else secrets.token_bytes(32)
    )
    if not isinstance(phrase_entropy, bytes) or len(phrase_entropy) != 32:
        raise ValueError("Source phrase entropy must be exactly 32 bytes.")

    lower_length = max(
        MIN_SECRET_WORD_LENGTH, word_length - SECRET_WORD_LENGTH_VARIANCE
    )
    upper_length = min(
        MAX_SECRET_WORD_LENGTH, word_length + SECRET_WORD_LENGTH_VARIANCE
    )
    words = []
    for index in range(word_count):
        length_entropy = int.from_bytes(
            phrase_entropy[index * 4 : index * 4 + 2], "big"
        )
        actual_length = lower_length + length_entropy % (
            upper_length - lower_length + 1
        )
        word_list = SOURCE_WORDS[
            "nouns" if index == word_count - 1 else "adjectives"
        ][str(actual_length)]
        word_entropy = int.from_bytes(
            phrase_entropy[index * 4 + 2 : index * 4 + 4], "big"
        )
        words.append(word_list[word_entropy % len(word_list)])
    token = (
        base64.urlsafe_b64encode(entropy)
        .decode("ascii")
        .rstrip("=")
        .replace("-", "~")
    )
    return "-".join((*words, token))


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
    word_count: int = DEFAULT_SECRET_WORD_COUNT,
    word_length: int = DEFAULT_SECRET_WORD_LENGTH,
    allow_downloads: bool = False,
) -> dict[str, str]:
    if not isinstance(allow_downloads, bool):
        raise ValueError("Allow downloads must be true or false.")
    _validate_source_word_settings(word_count, word_length)
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
            "BITSEEKWIN_WORD_COUNT": str(word_count),
            "BITSEEKWIN_WORD_LENGTH": str(word_length),
            "BITSEEKWIN_ALLOW_DOWNLOADS": str(allow_downloads).lower(),
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
        self.funnel_started = False

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
        allow_downloads = config.get("allow_downloads", False)
        word_count = config.get("word_count", DEFAULT_SECRET_WORD_COUNT)
        word_length = config.get("word_length", DEFAULT_SECRET_WORD_LENGTH)

        if not username or not password:
            raise ValueError("Enter your Soulseek username and password.")
        if not isinstance(allow_downloads, bool):
            raise ValueError("Allow downloads must be true or false.")
        _validate_source_word_settings(word_count, word_length)
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
            args=(
                node,
                username,
                password,
                public_url,
                use_funnel,
                allow_downloads,
                word_count,
                word_length,
            ),
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
                if len(secret) >= 4:
                    message = message.replace(secret, "[redacted]")
            self.log(f"[{name}] {message}")

    def _start_worker(
        self,
        node: str,
        username: str,
        password: str,
        public_url: str,
        use_funnel: bool,
        allow_downloads: bool,
        word_count: int,
        word_length: int,
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
                    [npm, "ci", "--no-audit", "--no-fund"],
                    cwd=str(PROJECT_DIR),
                    capture_output=True,
                    text=True,
                    timeout=300,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if install.returncode:
                    detail = (install.stderr or install.stdout).strip()
                    raise RuntimeError(
                        f"npm ci failed: {detail[-2000:] or 'unknown error'}"
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
                generate_source_secret(word_count, word_length),
                public_url,
                word_count,
                word_length,
                allow_downloads,
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
                self.funnel_started = True
                self.log("Tailscale Funnel configured for local port 8080.")

            if self.stop_requested.is_set():
                raise RuntimeError("Startup was cancelled.")
            server_process = subprocess.Popen(
                [node, str(PROJECT_DIR / "direct_server.mjs")],
                cwd=str(PROJECT_DIR),
                env=server_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.PIPE,
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
                args=("BitSeekWin", server_process, (password,)),
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
            self._stop_funnel()
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
        self._stop_funnel()
        self.log("BitSeekWin stopped.")

    def _stop_funnel(self) -> None:
        if not self.funnel_started:
            return
        try:
            result = subprocess.run(
                [self.tailscale, "funnel", "--bg", str(PORT), "off"],
                capture_output=True,
                text=True,
                timeout=20,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if result.returncode:
                detail = result.stderr.strip() or result.stdout.strip()
                self.log(
                    f"Could not turn off Tailscale Funnel: {detail or 'command failed.'}"
                )
                return
            self.funnel_started = False
            self.log("Tailscale Funnel stopped.")
        except (OSError, subprocess.SubprocessError) as exc:
            self.log(f"Could not turn off Tailscale Funnel: {exc}")


def _page(token: str, public_url: str) -> bytes:
    html = (
        _HTML.replace(
            "__TOKEN_JSON__", json.dumps(token).replace("<", "\\u003c")
        )
        .replace("__VERSION__", __version__)
        .replace(
            "__PUBLIC_URL_JSON__", json.dumps(public_url).replace("<", "\\u003c")
        )
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
:root{font-family:"Segoe UI",system-ui,sans-serif;color:#e8e9eb;background:#111315;font-synthesis:none;--panel:#191c1f;--field:#101214;--line:#30353a;--muted:#a2a8ad;--subtle:#7f878d;--accent:#70c8a0;--green:#70c8a0}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#111315;zoom:1.5}
button,input{font:inherit}
button{cursor:pointer}
.app{min-height:100vh}
main{width:min(760px,100%);padding:38px 24px;margin:0 auto}
.simple-header{margin-bottom:22px}
.simple-header h1{font-size:23px;letter-spacing:-.8px;margin:0 0 5px;line-height:1}
.brand-bit{background:linear-gradient(115deg,#fa233b 8%,#fb5c74 48%,#fb8c55 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.brand-seek{background:linear-gradient(110deg,#9b8cff,#5148ff 60%,#3429e8);-webkit-background-clip:text;background-clip:text;color:transparent}
.brand-win{font-size:.62em;letter-spacing:-.6px;vertical-align:baseline}
.simple-header p{margin:0;color:var(--muted);font-size:13px}
.cards{display:block}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:20px;margin-bottom:14px}
.card-title{font-size:13px;letter-spacing:0;margin-bottom:12px}
.field{margin-top:14px}
.field label,.slider-label{display:flex;justify-content:space-between;margin-bottom:7px;color:#c5cacf;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none}
.field input:not([type=range]){width:100%;min-width:0;background:var(--field);border:1px solid var(--line);border-radius:5px;padding:10px 11px;color:#e8e9eb;outline:none;font-size:13px}
.field input:focus{border-color:var(--accent)}
.field input::placeholder{color:#747b81}
.slider{width:100%;accent-color:var(--accent)}
.slider-value{color:#e8e9eb;font-variant-numeric:tabular-nums}
.hint{font-size:11px;color:var(--subtle);line-height:1.5;margin:8px 0 0}
.phrase-preview{font:12px Consolas,monospace;color:#c6d6ce;overflow-wrap:anywhere}
details.source-settings{margin-top:16px;border:1px solid var(--line);border-radius:6px;background:#151719}
details.source-settings summary{padding:10px 12px;color:#c5cacf;font-size:12px;font-weight:600;cursor:pointer;list-style:none}
details.source-settings summary::-webkit-details-marker{display:none}
details.source-settings summary::after{content:"+";float:right;color:var(--accent);font-size:15px;line-height:12px}
details.source-settings[open] summary::after{content:"−"}
.source-settings-content{padding:0 12px 12px}
.source-settings-content .field:first-child{margin-top:4px}
.check{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:12px;color:#c5cacf}
.check input{accent-color:var(--accent);width:14px;height:14px}
.button{border:1px solid var(--line);border-radius:5px;padding:9px 12px;background:#24282b;color:#e8e9eb;font-size:12px;white-space:nowrap}
.button:hover{filter:brightness(1.12)}
.button:disabled{opacity:.45;cursor:not-allowed}
.button.primary{background:var(--accent);border-color:var(--accent);color:#101613;font-weight:700}
.actions{display:flex;gap:8px;margin-top:16px}
.privacy{font-size:11px;line-height:1.55;color:var(--subtle);margin:12px 2px 18px}
.activity{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
.activity-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:31px}
.console-title{margin-right:4px}
.console-title strong{font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;background:#777480}
.dot.success{background:var(--green)}
.dot.error{background:#ff617b}
.activity-state{font-size:12px;color:#d9d6de}
.copy{margin-left:auto}
.url{margin-top:10px;padding:9px 10px;border:1px solid var(--line);border-radius:5px;background:var(--field);color:#85d2ad;font:11px Consolas,monospace;overflow-wrap:anywhere}
.url.empty{color:var(--subtle)}
.console-meta{display:flex;justify-content:space-between;margin:13px 2px 6px;color:var(--subtle);font-size:9px;font-weight:700;letter-spacing:.5px}
.logs{height:210px;overflow:auto;padding:8px 9px;border:1px solid #292e32;border-radius:5px;background:#101214;color:#c6c7cf;font:11px/1.65 Consolas,"Cascadia Mono",monospace}
.log-line{display:grid;grid-template-columns:58px 52px minmax(0,1fr);gap:7px;padding:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.log-time{color:#696c78}
.log-kind{font-size:9px;font-weight:800;color:#8f93a0}
.log-message{color:#d0d1d8}
.log-line.search .log-kind{color:#8fb4d0}
.log-line.stream .log-kind{color:#83d6ae}
.log-line.warn .log-kind{color:#d7b87d}
.log-line.error .log-kind,.error{color:#ff849a}
.success{color:var(--green)}
@media(max-width:600px){main{padding:24px 14px}.card{padding:16px}.activity-head{align-items:flex-start}.copy{margin-left:0}.logs{height:190px}.log-line{grid-template-columns:48px 45px minmax(0,1fr);gap:5px}}
</style>
</head>
<body>
<div class="app">
<main>
<header class="simple-header"><h1><span class="brand-bit">Bit</span><span class="brand-seek">Seek</span><span class="brand-win">win</span></h1><p>Connect Soulseek to BitChord · Build __VERSION__</p></header>
<section class="cards">
<article class="card"><div class="card-title">DIRECT SOULSEEK CONNECTION</div>
<div class="field"><label for="username">Soulseek username</label><input id="username" type="text" autocomplete="username" placeholder="Your Soulseek username"></div>
<div class="field"><label for="password">Soulseek password</label><input id="password" type="password" autocomplete="current-password" placeholder="Only used for this session"></div>
<details class="source-settings">
<summary>Source URL settings</summary>
<div class="source-settings-content">
<div class="field"><label for="publicUrl">Public address</label><input id="publicUrl" type="url" autocomplete="url" placeholder="https://device.tailnet.ts.net"></div>
<label class="check"><input id="funnel" type="checkbox"> Start Tailscale Funnel on port 8080</label>
<p class="hint">Use Funnel only when you want to share over a public HTTPS .ts.net address.</p>
<div class="field">
<label class="slider-label" for="wordCount">Words in source URL <output id="wordCountValue" class="slider-value">3</output></label>
<input class="slider" id="wordCount" type="range" min="2" max="8" value="3">
</div>
<div class="field">
<label class="slider-label" for="wordLength">Target letters per word <output id="wordLengthValue" class="slider-value">6</output></label>
<input class="slider" id="wordLength" type="range" min="3" max="9" value="6">
</div>
<p class="hint">Each word varies by up to 3 letters from the target (within 3–9). Adjectives come first, then one noun. A separate random token provides 128-bit access security.</p>
<p class="hint phrase-preview" id="phrasePreview" aria-live="polite"></p>
</div>
</details>
<label class="check download-option"><input id="allowDownloads" type="checkbox"> Allow downloads in BitChord</label>
<p class="hint">Off by default. When enabled, BitChord may offer downloads from this source.</p>
<div class="actions"><button class="button primary" id="start">▶ &nbsp; Start listening</button><button class="button" id="stop" disabled>Stop</button></div>
</article>
</section>
<p class="privacy">Your login is used only for this launch. Keep the printed BitChord source URL private. Stop the service before closing the launcher.</p>
<section class="activity"><div class="activity-head"><div class="console-title"><strong>Activity</strong></div><span id="dot" class="dot"></span><span id="state" class="activity-state">Ready</span><button class="button copy" id="copy" disabled>Copy source URL</button><button class="button" id="exit">Exit</button></div><div id="url" class="url empty">Your BitChord source URL will appear here after startup.</div><div class="console-meta"><span>SOULSEEK / BITCHORD</span><span id="log-count">0 EVENTS</span></div><div id="logs" class="logs" role="log" aria-live="polite" aria-relevant="additions">Ready when you are.</div></section>
</main></div>
<script>
const token=__TOKEN_JSON__, api="/"+token+"/api/";
const $=id=>document.getElementById(id);
let sourceUrl="";
$("publicUrl").value=__PUBLIC_URL_JSON__;
$("funnel").checked=$("publicUrl").value.endsWith(".ts.net");
for(const id of ["wordCount","wordLength"])$(id).addEventListener("input",updatePhrasePreview);
function updatePhrasePreview(){const count=Number($("wordCount").value),length=Number($("wordLength").value);const low=Math.max(3,length-3),high=Math.min(9,length+3);$("wordCountValue").textContent=count;$("wordLengthValue").textContent=length;$("phrasePreview").textContent="Word lengths: "+low+"–"+high+" letters.";}
updatePhrasePreview();
update();
$("start").addEventListener("click",async()=>{
  const config={username:$("username").value,password:$("password").value,public_url:$("publicUrl").value.trim(),start_funnel:$("funnel").checked,allow_downloads:$("allowDownloads").checked,word_count:Number($("wordCount").value),word_length:Number($("wordLength").value)};
  $("start").disabled=true;$("state").textContent="Starting";$("dot").className="dot";
  try{const r=await fetch(api+"start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(config)});const d=await r.json();if(!r.ok)throw Error(d.error||"Could not start.");$("password").value="";$("username").value="";$("logs").textContent="Connecting directly to Soulseek…";}
  catch(e){$("start").disabled=false;alert(e.message);}
  await update();
});
$("stop").addEventListener("click",async()=>{try{await fetch(api+"stop",{method:"POST"});}catch(e){}await update();});
$("copy").addEventListener("click",async()=>{if(sourceUrl){await navigator.clipboard.writeText(sourceUrl);$("state").textContent="URL copied";}});
$("exit").addEventListener("click",async()=>{if(!confirm("Exit BitSeekWin and disconnect from Soulseek?"))return;try{await fetch(api+"exit",{method:"POST"});}catch(e){}document.body.innerHTML="<main><section class='exit-page'><h1>BitSeekWin stopped.</h1><p>You can close this browser tab.</p></section></main>";});
async function update(){try{const r=await fetch(api+"status",{cache:"no-store"});renderStatus(await r.json());}catch(e){}}
function renderStatus(s){sourceUrl=s.source_url||"";$("url").textContent=sourceUrl||"Your BitChord source URL will appear here after startup.";$("url").classList.toggle("empty",!sourceUrl);$("copy").disabled=!sourceUrl;renderLogs(s.logs||[],s.detail||"");$("state").textContent=s.status||"Ready";$("dot").className="dot"+(s.running?" success":s.status==="Startup failed"?" error":"");$("start").disabled=!!s.starting||!!s.active;$("stop").disabled=!s.starting&&!s.active;}
function renderLogs(entries,fallback){const box=$("logs"),follow=box.scrollHeight-box.scrollTop-box.clientHeight<24,lines=entries.length?entries:[fallback||"Waiting for activity…"];box.replaceChildren();for(const line of lines){const row=document.createElement("div"),time=document.createElement("span"),kind=document.createElement("span"),message=document.createElement("span"),match=/^(?:\[[^\]]+\]\s*)?\[(\d{2}:\d{2}:\d{2})\]\s+\[(SEARCH|STREAM|WARN|ERROR|INFO)\]\s*(.*)$/i.exec(line);const level=match?match[2].toLowerCase():"info";row.className="log-line "+level;time.className="log-time";time.textContent=match?match[1]:"";kind.className="log-kind";kind.textContent=level.toUpperCase();message.className="log-message";message.textContent=match?match[3]:line;row.append(time,kind,message);box.append(row);}$("log-count").textContent=entries.length+" EVENT"+(entries.length===1?"":"S");if(follow)box.scrollTop=box.scrollHeight;}
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
