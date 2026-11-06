import base64
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

APP_NAME = "BitSeekWin"
PROJECT_DIR = Path(__file__).resolve().parent
__version__ = (PROJECT_DIR / "version.txt").read_text(encoding="utf-8").strip()
PORT = 8080
MAX_REQUEST_SIZE = 64 * 1024
MAX_LOG_LINES = 250
DEFAULT_SECRET_WORD_COUNT = 3
DEFAULT_SECRET_WORD_LENGTH = 6
DEFAULT_SOURCE_SELECTION = "match"
SOURCE_SELECTION_MODES = ("match", "speed")
DEFAULT_SEARCH_LIMIT = 50
DEFAULT_SEARCH_TIMEOUT_MS = 2000
DEFAULT_SEARCH_RECOVERY = True
DEFAULT_IDLE_TRANSFER_TIMEOUT_SECONDS = 30
DEFAULT_CACHE_TTL_MINUTES = 30
DEFAULT_CACHE_MAX_SIZE_MB = 2048
DEFAULT_MAX_ACTIVE_STREAMS = 2
DEFAULT_MAX_STREAM_SIZE_MB = 128
MIN_SECRET_WORD_COUNT = 2
MAX_SECRET_WORD_COUNT = 8
MIN_SECRET_WORD_LENGTH = 3
MAX_SECRET_WORD_LENGTH = 9
SECRET_WORD_LENGTH_VARIANCE = 3
SOURCE_WORDS = json.loads(
    (PROJECT_DIR / "source_words.json").read_text(encoding="utf-8")
)
INTER_FONT_DATA = (PROJECT_DIR / "fonts" / "InterVariable.woff2").read_bytes()

SEARCH_LIMIT_BOUNDS = (1, 50)
SEARCH_TIMEOUT_BOUNDS = (500, 30000)
IDLE_TRANSFER_TIMEOUT_BOUNDS = (1, 600)
CACHE_TTL_BOUNDS = (1, 10080)
CACHE_MAX_SIZE_BOUNDS = (16, 32768)
ACTIVE_STREAMS_BOUNDS = (1, 2)
MAX_STREAM_SIZE_BOUNDS = (1, 128)


def _validate_integer_setting(value: object, name: str, bounds: tuple[int, int]) -> int:
    minimum, maximum = bounds
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise ValueError(f"{name} must be a whole number between {minimum} and {maximum}.")
    return value


def generate_source_secret(
    word_count: int = DEFAULT_SECRET_WORD_COUNT,
    word_length: int = DEFAULT_SECRET_WORD_LENGTH,
    random_bytes: bytes | None = None,
    phrase_bytes: bytes | None = None,
    include_token: bool = True,
) -> str:
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
    if not isinstance(include_token, bool):
        raise ValueError("Include token must be true or false.")
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
    if not include_token:
        return "-".join(words)
    entropy = random_bytes if random_bytes is not None else secrets.token_bytes(16)
    if not isinstance(entropy, bytes) or len(entropy) != 16:
        raise ValueError("Source URL token entropy must be exactly 16 bytes.")
    token = (
        base64.urlsafe_b64encode(entropy)
        .decode("ascii")
        .rstrip("=")
        .replace("-", "~")
    )
    return "-".join((*words, token))


def detect_lan_ip() -> str | None:
    candidates: list[str] = []

    def add_candidate(value: str) -> None:
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            return
        if (
            isinstance(address, ipaddress.IPv4Address)
            and address.is_private
            and not address.is_loopback
            and not address.is_link_local
            and not address.is_unspecified
            and value not in candidates
        ):
            candidates.append(value)

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
            route.connect(("192.0.2.1", 9))
            add_candidate(route.getsockname()[0])
    except OSError:
        pass

    try:
        for result in socket.getaddrinfo(
            socket.gethostname(), None, socket.AF_INET, socket.SOCK_DGRAM
        ):
            add_candidate(result[4][0])
    except OSError:
        pass

    return candidates[0] if candidates else None


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
    source_selection: str = DEFAULT_SOURCE_SELECTION,
    search_limit: int = DEFAULT_SEARCH_LIMIT,
    search_timeout_ms: int = DEFAULT_SEARCH_TIMEOUT_MS,
    search_recovery: bool = DEFAULT_SEARCH_RECOVERY,
    idle_transfer_timeout_seconds: int = DEFAULT_IDLE_TRANSFER_TIMEOUT_SECONDS,
    cache_ttl_minutes: int = DEFAULT_CACHE_TTL_MINUTES,
    cache_max_size_mb: int = DEFAULT_CACHE_MAX_SIZE_MB,
    max_active_streams: int = DEFAULT_MAX_ACTIVE_STREAMS,
    max_stream_size_mb: int = DEFAULT_MAX_STREAM_SIZE_MB,
    bitchord_auth: bool = False,
) -> dict[str, str]:
    if not isinstance(allow_downloads, bool):
        raise ValueError("Allow downloads must be true or false.")
    if not isinstance(bitchord_auth, bool):
        raise ValueError("BitChord authentication must be true or false.")
    if source_selection not in SOURCE_SELECTION_MODES:
        raise ValueError("Source selection must be 'match' or 'speed'.")
    if not isinstance(search_recovery, bool):
        raise ValueError("Search recovery must be true or false.")
    search_limit = _validate_integer_setting(
        search_limit, "Maximum search results", SEARCH_LIMIT_BOUNDS
    )
    search_timeout_ms = _validate_integer_setting(
        search_timeout_ms, "Search timeout", SEARCH_TIMEOUT_BOUNDS
    )
    idle_transfer_timeout_seconds = _validate_integer_setting(
        idle_transfer_timeout_seconds, "Reconnect grace period", IDLE_TRANSFER_TIMEOUT_BOUNDS
    )
    cache_ttl_minutes = _validate_integer_setting(
        cache_ttl_minutes, "Cache expiration", CACHE_TTL_BOUNDS
    )
    cache_max_size_mb = _validate_integer_setting(
        cache_max_size_mb, "Cache size", CACHE_MAX_SIZE_BOUNDS
    )
    max_active_streams = _validate_integer_setting(
        max_active_streams, "Concurrent transfers", ACTIVE_STREAMS_BOUNDS
    )
    max_stream_size_mb = _validate_integer_setting(
        max_stream_size_mb, "Maximum track size", MAX_STREAM_SIZE_BOUNDS
    )
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
            "BITSEEKWIN_BITCHORD_AUTH": str(bitchord_auth).lower(),
            "BITSEEKWIN_SOURCE_SELECTION": source_selection,
            "BITSEEKWIN_SEARCH_LIMIT": str(search_limit),
            "BITSEEKWIN_SEARCH_TIMEOUT_MS": str(search_timeout_ms),
            "BITSEEKWIN_SEARCH_RECOVERY": str(search_recovery).lower(),
            "BITSEEKWIN_IDLE_TRANSFER_TIMEOUT_MS": str(
                idle_transfer_timeout_seconds * 1000
            ),
            "BITSEEKWIN_CACHE_TTL_MS": str(cache_ttl_minutes * 60 * 1000),
            "BITSEEKWIN_CACHE_MAX_BYTES": str(cache_max_size_mb * 1024 * 1024),
            "BITSEEKWIN_MAX_ACTIVE_STREAMS": str(max_active_streams),
            "BITSEEKWIN_MAX_STREAM_BYTES": str(max_stream_size_mb * 1024 * 1024),
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
        lan_access = config.get("lan_access", False)
        allow_downloads = config.get("allow_downloads", False)
        bitchord_auth = config.get("bitchord_auth", False)
        source_selection = config.get("source_selection", DEFAULT_SOURCE_SELECTION)
        search_limit = _validate_integer_setting(
            config.get("search_limit", DEFAULT_SEARCH_LIMIT),
            "Maximum search results",
            SEARCH_LIMIT_BOUNDS,
        )
        search_timeout_ms = _validate_integer_setting(
            config.get("search_timeout_ms", DEFAULT_SEARCH_TIMEOUT_MS),
            "Search timeout",
            SEARCH_TIMEOUT_BOUNDS,
        )
        search_recovery = config.get("search_recovery", DEFAULT_SEARCH_RECOVERY)
        idle_transfer_timeout_seconds = _validate_integer_setting(
            config.get(
                "idle_transfer_timeout_seconds",
                DEFAULT_IDLE_TRANSFER_TIMEOUT_SECONDS,
            ),
            "Reconnect grace period",
            IDLE_TRANSFER_TIMEOUT_BOUNDS,
        )
        cache_ttl_minutes = _validate_integer_setting(
            config.get("cache_ttl_minutes", DEFAULT_CACHE_TTL_MINUTES),
            "Cache expiration",
            CACHE_TTL_BOUNDS,
        )
        cache_max_size_mb = _validate_integer_setting(
            config.get("cache_max_size_mb", DEFAULT_CACHE_MAX_SIZE_MB),
            "Cache size",
            CACHE_MAX_SIZE_BOUNDS,
        )
        max_active_streams = _validate_integer_setting(
            config.get("max_active_streams", DEFAULT_MAX_ACTIVE_STREAMS),
            "Concurrent transfers",
            ACTIVE_STREAMS_BOUNDS,
        )
        max_stream_size_mb = _validate_integer_setting(
            config.get("max_stream_size_mb", DEFAULT_MAX_STREAM_SIZE_MB),
            "Maximum track size",
            MAX_STREAM_SIZE_BOUNDS,
        )
        word_count = config.get("word_count", DEFAULT_SECRET_WORD_COUNT)
        word_length = config.get("word_length", DEFAULT_SECRET_WORD_LENGTH)

        if not username or not password:
            raise ValueError("Enter your Soulseek username and password.")
        if not isinstance(lan_access, bool):
            raise ValueError("LAN access must be true or false.")
        if not isinstance(allow_downloads, bool):
            raise ValueError("Allow downloads must be true or false.")
        if not isinstance(bitchord_auth, bool):
            raise ValueError("BitChord authentication must be true or false.")
        if source_selection not in SOURCE_SELECTION_MODES:
            raise ValueError("Source selection must be 'match' or 'speed'.")
        if not isinstance(search_recovery, bool):
            raise ValueError("Search recovery must be true or false.")
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
        if lan_access:
            lan_ip = detect_lan_ip()
            if not lan_ip:
                raise ValueError("No private LAN IPv4 address was detected.")
            if use_funnel:
                raise ValueError("Turn off Tailscale Funnel when using the LAN address.")
            public_url = f"http://{lan_ip}:{PORT}"
        else:
            public_url = normalize_public_url(public_text)
        if bitchord_auth:
            parsed_url = urlsplit(public_url)
            host = parsed_url.hostname or ""
            try:
                loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
            except ValueError:
                loopback = host.endswith(".localhost")
            if parsed_url.scheme != "https" and not (
                parsed_url.scheme == "http" and loopback
            ):
                raise ValueError(
                    "BitChord authentication requires HTTPS, except for localhost."
                )
        if use_funnel and not public_url.startswith("https://"):
            raise ValueError("Tailscale Funnel requires an https:// public URL.")
        if use_funnel and not self.tailscale:
            raise ValueError("Tailscale was not found. Install it or turn off Funnel.")
        node = find_node_runtime()

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
        server_settings = {
            "allow_downloads": allow_downloads,
            "bitchord_auth": bitchord_auth,
            "source_selection": source_selection,
            "search_limit": search_limit,
            "search_timeout_ms": search_timeout_ms,
            "search_recovery": search_recovery,
            "idle_transfer_timeout_seconds": idle_transfer_timeout_seconds,
            "cache_ttl_minutes": cache_ttl_minutes,
            "cache_max_size_mb": cache_max_size_mb,
            "max_active_streams": max_active_streams,
            "max_stream_size_mb": max_stream_size_mb,
        }
        threading.Thread(
            target=self._start_worker,
            args=(
                node,
                username,
                password,
                public_url,
                use_funnel,
                server_settings,
                word_count,
                word_length,
                lan_access,
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
        server_settings: dict[str, bool | str | int],
        word_count: int,
        word_length: int,
        lan_access: bool = False,
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
                generate_source_secret(
                    word_count, word_length, include_token=not lan_access
                ),
                public_url,
                word_count,
                word_length,
                **server_settings,
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


def _page(token: str, public_url: str, lan_ip: str | None = None) -> bytes:
    html = (
        _HTML.replace("__TOKEN_JSON__", json.dumps(token))
        .replace("__VERSION__", __version__)
        .replace("__PUBLIC_URL_JSON__", json.dumps(public_url))
        .replace("__LAN_IP_JSON__", json.dumps(lan_ip or ""))
        .replace(
            "__FONT_URL__",
            json.dumps(f"/{token}/assets/inter-variable.woff2"),
        )
    )
    return html.encode("utf-8")


_HTML = r"""<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>BitSeekWin • Setup</title>
<style>
@font-face{
  font-family:"Inter";
  src:url(__FONT_URL__) format("woff2");
  font-style:normal;
  font-weight:100 900;
  font-display:swap;
}
:root{
  color-scheme:dark;
  font-family:var(--font-ui);
  font-size:var(--text-body);
  font-weight:var(--weight-regular);
  color:var(--text);
  background:var(--surface);
  font-synthesis:none;
  font-optical-sizing:auto;
  --font-ui:"Inter",sans-serif;
  --weight-regular:400;
  --weight-medium:500;
  --weight-semibold:600;
  --weight-bold:700;
  --text-display:28px;
  --text-section:16px;
  --text-body:14px;
  --text-nav:13px;
  --text-label:12px;
  --text-caption:11px;
  --text-micro:10px;
  --text-brand:19px;
  --text-brand-primary:1.08em;
  --text-brand-win:.48em;
  --text-mobile-display:25px;
  --text-mobile-brand:18px;
  --leading-tight:1.2;
  --leading-normal:1.45;
  --leading-relaxed:1.55;
  --leading-label:1.35;
  --leading-log:1.65;
  --tracking-display:-.55px;
  --tracking-heading:-.15px;
  --tracking-brand:-.45px;
  --tracking-brand-win:-.2px;
  --tracking-label:.04em;
  --tracking-micro:.035em;
  --surface:#1c1c1e;
  --sidebar:#171719;
  --line:#39393d;
  --muted:#a1a1a8;
  --subtle:#8b8b92;
  --text:#f5f5f7;
  --text-secondary:#c7c7cc;
  --control-surface:#29292d;
  --control-border:#4a4a50;
  --slider-track:#55555b;
  --inset-surface:#222225;
  --hover-surface:#303034;
  --selected-surface:#39393e;
  --placeholder:#96969d;
  --url-color:#63c69a;
  --error:#ff6b73;
  --success:#5bd18b;
  --log-blue:#55b9f1;
  --log-green:#68d39b;
  --log-warning:#f2bd61;
  --accent:#fa2d48;
  --focus:#0a84ff;
}
:root[data-theme="light"]{
  color-scheme:light;
  --surface:#fff;
  --sidebar:#f5f5f7;
  --line:#e5e5e8;
  --muted:#77777f;
  --subtle:#8b8b92;
  --text:#1d1d1f;
  --text-secondary:#48484d;
  --control-surface:#fff;
  --control-border:#d4d4d9;
  --slider-track:#d1d1d6;
  --inset-surface:#f7f7f8;
  --hover-surface:#e9e9ed;
  --selected-surface:#e5e5e9;
  --placeholder:#96969d;
  --url-color:#27795a;
  --error:#c62836;
  --success:#248a52;
  --log-blue:#147bb7;
  --log-green:#21845b;
  --log-warning:#a76b00;
  --focus:#007aff;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:20px}
body{margin:0;min-width:320px;min-height:100vh;background:var(--surface)}
button,input,select{font:inherit}
button{cursor:pointer}
.app{display:grid;grid-template-columns:224px minmax(0,1fr);height:100vh;min-height:540px;background:var(--surface)}
.sidebar{display:flex;flex-direction:column;min-width:0;padding:24px 12px 14px;background:var(--sidebar);border-right:1px solid var(--line)}
.brand{display:flex;align-items:baseline;padding:0 12px;font-size:var(--text-brand);font-weight:var(--weight-semibold);letter-spacing:var(--tracking-brand);line-height:var(--leading-tight);white-space:nowrap}
.brand-bit,.brand-seek{font-size:var(--text-brand-primary);font-weight:var(--weight-bold)}
.brand-bit{background:linear-gradient(115deg,#fa233b 8%,#fb5c74 48%,#fb8c55 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.brand-seek{background:linear-gradient(110deg,#49d5e8,#2996d6 56%,#254eb7);-webkit-background-clip:text;background-clip:text;color:transparent}
.brand-win{margin-left:1px;font-size:var(--text-brand-win);letter-spacing:var(--tracking-brand-win);vertical-align:super}
.nav{flex:1;min-height:0;margin-top:30px;overflow-y:auto}
.nav-group+.nav-group{margin-top:23px}
.nav-label{margin:0 12px 8px;color:var(--subtle);font-size:var(--text-caption);font-weight:var(--weight-semibold);letter-spacing:var(--tracking-label)}
.nav-link{display:flex;align-items:center;gap:11px;min-height:36px;margin:2px 0;padding:0 11px;border-radius:7px;color:var(--text-secondary);text-decoration:none;font-size:var(--text-nav);font-weight:var(--weight-medium);transition:background .12s,color .12s}
.nav-link svg{width:17px;height:17px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nav-link:hover{background:var(--hover-surface)}
.nav-link.current{background:var(--selected-surface);color:var(--text);font-weight:var(--weight-semibold)}
.sidebar-footer{padding:13px 12px 1px;border-top:1px solid var(--line);color:var(--muted);font-size:var(--text-caption);line-height:var(--leading-relaxed)}
.workspace{display:grid;grid-template-rows:56px minmax(0,1fr);min-width:0;min-height:0}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 30px;background:var(--surface);border-bottom:1px solid var(--line)}
.toolbar-title{color:var(--text);font-size:var(--text-nav);font-weight:var(--weight-semibold)}
.toolbar-actions{display:flex;align-items:center;gap:16px}
.toolbar-status{display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:var(--text-label)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--subtle)}
.dot.success{background:var(--success)}
.dot.error{background:var(--error)}
.content-scroll{min-height:0;overflow:auto;overscroll-behavior:contain}
.page-content{width:min(1080px,100%);margin:0 auto;padding:34px 40px 48px}
.page-heading{margin:0 0 7px;font-size:var(--text-display);font-weight:var(--weight-bold);letter-spacing:var(--tracking-display);line-height:var(--leading-tight)}
.page-description{max-width:720px;margin:0;color:var(--muted);font-size:var(--text-body);line-height:var(--leading-relaxed)}
.section-card{margin-top:22px;padding:22px 24px;background:var(--surface);border:1px solid var(--line);border-radius:10px;scroll-margin-top:18px}
.section-heading{margin:0 0 3px;font-size:var(--text-section);font-weight:var(--weight-semibold);letter-spacing:var(--tracking-heading);line-height:var(--leading-label)}
.section-description{margin:0;color:var(--muted);font-size:var(--text-label);line-height:var(--leading-relaxed)}
.fields-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:22px;row-gap:15px;margin-top:16px}
.field{min-width:0}
.field.full{grid-column:1/-1}
.field label,.slider-label{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:7px;color:var(--text);font-size:var(--text-label);font-weight:var(--weight-semibold);line-height:var(--leading-label)}
.field input:not([type=range]):not([type=checkbox]),.field select{width:100%;min-width:0;height:39px;padding:0 11px;border:1px solid var(--control-border);border-radius:7px;background:var(--control-surface);color:var(--text);outline:none;font-size:var(--text-nav)}
.field input:focus,.field select:focus{border-color:var(--focus);box-shadow:0 0 0 3px #007aff26}
.field input:focus-visible,.field select:focus-visible,button:focus-visible,.nav-link:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.field input::placeholder{color:var(--placeholder)}
.field select{color-scheme:inherit}
.hint{margin:6px 0 0;color:var(--muted);font-size:var(--text-caption);line-height:var(--leading-relaxed)}
.check{display:flex;align-items:flex-start;gap:9px;color:var(--text);font-size:var(--text-label);line-height:var(--leading-normal)}
.check input{flex:none;width:15px;height:15px;margin:0;accent-color:var(--accent)}
.field label.check{justify-content:flex-start;margin:0;font-size:var(--text-label);font-weight:var(--weight-medium)}
.check-field{padding-top:2px}
.slider{display:block;width:100%;height:18px;margin:12px 0 2px;padding:0;background:transparent;appearance:none;-webkit-appearance:none;cursor:pointer}
.slider::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--accent) 0%,var(--accent) var(--range-progress,0%),var(--slider-track) var(--range-progress,0%),var(--slider-track) 100%)}
.slider::-webkit-slider-thumb{width:14px;height:14px;margin-top:-5px;border:0;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0005;appearance:none;-webkit-appearance:none}
.slider::-moz-range-track{height:4px;border-radius:999px;background:var(--slider-track)}
.slider::-moz-range-progress{height:4px;border-radius:999px;background:var(--accent)}
.slider::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0005}
.slider:focus-visible{outline:2px solid var(--focus);outline-offset:3px;border-radius:5px}
.slider-value{color:var(--text-secondary);font-variant-numeric:tabular-nums}
.phrase-preview{font-size:var(--text-caption);line-height:var(--leading-relaxed);overflow-wrap:anywhere}
.actions{display:flex;align-items:center;gap:9px;margin-top:19px}
.button{min-height:34px;padding:0 14px;border:1px solid var(--control-border);border-radius:7px;background:var(--control-surface);color:var(--text);font-size:var(--text-label);font-weight:var(--weight-medium);white-space:nowrap;transition:background .12s,border-color .12s}
.button:hover:not(:disabled){background:var(--hover-surface)}
.button:disabled{opacity:.45;cursor:not-allowed}
.button.primary{border-color:var(--accent);background:var(--accent);color:#fff;font-weight:var(--weight-semibold)}
.button.primary:hover:not(:disabled){background:#e92340;border-color:#e92340}
.privacy{max-width:750px;margin:13px 2px 0;color:var(--muted);font-size:var(--text-caption);line-height:var(--leading-relaxed)}
.activity-head{display:flex;align-items:center;gap:10px}
.activity-state{color:var(--text-secondary);font-size:var(--text-label)}
.copy{margin-left:auto}
.address-row{display:flex;gap:8px}
.address-row input{min-width:0;flex:1}
.address-row .button{flex:none}
.url{min-height:39px;margin-top:14px;padding:10px 11px;border:1px solid var(--line);border-radius:7px;background:var(--inset-surface);color:var(--url-color);font-size:var(--text-caption);line-height:var(--leading-relaxed);overflow-wrap:anywhere}
.url.empty{color:var(--subtle)}
.console-meta{display:flex;justify-content:space-between;gap:12px;margin:17px 1px 7px;color:var(--subtle);font-size:var(--text-micro);font-weight:var(--weight-semibold);letter-spacing:var(--tracking-micro)}
.logs{height:220px;overflow:auto;padding:10px 11px;border:1px solid var(--line);border-radius:7px;background:var(--inset-surface);color:var(--text);font-size:var(--text-caption);line-height:var(--leading-log);scrollbar-color:#77777f transparent;scrollbar-width:thin}
.log-line{display:grid;grid-template-columns:62px 52px minmax(0,1fr);gap:8px;padding:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.log-time{color:var(--muted)}
.log-kind{font-size:var(--text-micro);font-weight:var(--weight-bold);color:var(--muted)}
.log-message{color:var(--text-secondary)}
.log-line.search .log-kind{color:var(--log-blue)}
.log-line.stream .log-kind{color:var(--log-green)}
.log-line.warn .log-kind{color:var(--log-warning)}
.log-line.error .log-kind,.error{color:var(--error)}
.success{color:var(--success)}
.exit-screen{max-width:620px;margin:18vh auto;padding:32px;color:var(--text);font-size:var(--text-body)}
.exit-screen h1{font-size:var(--text-mobile-display);font-weight:var(--weight-bold)}
@media(max-width:980px){.app{grid-template-columns:196px minmax(0,1fr)}.toolbar{padding:0 24px}.page-content{padding:30px 28px 42px}}
@media(max-width:720px){
  .app{display:block;height:auto;min-height:100vh}
  .sidebar{padding:13px 14px 8px;border-right:0;border-bottom:1px solid var(--line)}
  .brand{padding:0 5px;font-size:var(--text-mobile-brand)}
  .nav{display:flex;gap:7px;margin-top:12px;overflow-x:auto;overflow-y:hidden}
  .nav-group{display:flex;flex:none;gap:4px}
  .nav-group+.nav-group{margin-top:0}
  .nav-label,.sidebar-footer{display:none}
  .nav-link{min-height:34px;padding:0 10px;white-space:nowrap}
  .workspace{display:block;min-height:calc(100vh - 106px)}
  .toolbar{height:48px;padding:0 16px}
  .toolbar-actions{gap:11px}
  .content-scroll{overflow:visible}
  .page-content{padding:24px 16px 36px}
  .page-heading{font-size:var(--text-mobile-display)}
  .section-card{margin-top:16px;padding:18px}
}
@media(max-width:500px){
  .fields-grid{grid-template-columns:minmax(0,1fr);row-gap:13px}
  .field.full{grid-column:auto}
  .toolbar{padding:0 12px}
  .toolbar-actions{gap:8px}
  .toolbar-status{font-size:var(--text-caption)}
  .page-content{padding-right:12px;padding-left:12px}
  .section-card{padding:16px}
  .address-row{align-items:stretch;flex-direction:column}
  .logs{height:200px}
  .log-line{grid-template-columns:48px 43px minmax(0,1fr);gap:5px}
}
</style>
</head>
<body>
<div class="app">
<aside class="sidebar">
  <div class="brand" aria-label="BitSeekWin"><span class="brand-bit">Bit</span><span class="brand-seek">Seek</span><span class="brand-win">Win</span></div>
  <nav class="nav" aria-label="Launcher sections">
    <div class="nav-group">
      <p class="nav-label">SERVER</p>
      <a class="nav-link current" href="#connection">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h14M10 3v14"/><circle cx="10" cy="10" r="7"/></svg>
        Connection
      </a>
      <a class="nav-link" href="#activity">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14v12H3zM6 8h8M6 11h5"/></svg>
        Activity
      </a>
    </div>
    <div class="nav-group">
      <p class="nav-label">SETTINGS</p>
      <a class="nav-link" href="#source-settings">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>
        Source
      </a>
      <a class="nav-link" href="#search-settings">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
        Search
      </a>
      <a class="nav-link" href="#transfer-settings">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14"/><circle cx="7" cy="6" r="1.5"/><circle cx="12" cy="10" r="1.5"/><circle cx="9" cy="14" r="1.5"/></svg>
        Transfers
      </a>
      <a class="nav-link" href="#cache-settings">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Z"/><path d="M3 6v8c0 1.7 3.1 3 7 3s7-1.3 7-3V6M3 10c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>
        Cache
      </a>
    </div>
  </nav>
  <div class="sidebar-footer">BitSeekWin<br>Connect Soulseek to BitChord</div>
</aside>
<div class="workspace">
  <header class="toolbar">
    <span class="toolbar-title">Setup</span>
    <div class="toolbar-actions">
      <span class="toolbar-status"><span id="dot" class="dot"></span><span id="state">Ready</span></span>
      <button class="button" id="themeToggle" type="button" aria-label="Switch to light mode" aria-pressed="true">Light mode</button>
      <button class="button" id="exit" type="button">Exit</button>
    </div>
  </header>
  <div class="content-scroll">
    <main class="page-content">
      <h1 class="page-heading">Connect to Soulseek</h1>
      <p class="page-description">Sign in to start the BitSeekWin server and make your BitChord source available.</p>

      <section class="section-card" id="activity" aria-labelledby="activityTitle">
        <div class="activity-head"><div><h2 class="section-heading" id="activityTitle">Activity</h2><p class="section-description">Server events and the source URL for BitChord.</p></div><button class="button copy" id="copy" type="button" disabled>Copy source URL</button></div>
        <div id="url" class="url empty">Your BitChord source URL will appear here after startup.</div>
        <div class="console-meta"><span>SOULSEEK / BITCHORD</span><span id="log-count">0 EVENTS</span></div>
        <div id="logs" class="logs" role="log" aria-live="polite" aria-relevant="additions">Ready when you are.</div>
      </section>

      <section class="section-card" id="connection" aria-labelledby="connectionTitle">
        <h2 class="section-heading" id="connectionTitle">Soulseek account</h2>
        <p class="section-description">Your credentials are used for this launch only.</p>
        <div class="fields-grid">
          <div class="field"><label for="username">Username</label><input id="username" type="text" autocomplete="username" placeholder="Your Soulseek username"></div>
          <div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" placeholder="Only used for this session"></div>
        </div>
        <div class="actions"><button class="button primary" id="start" type="button">Start listening</button><button class="button" id="stop" type="button" disabled>Stop</button></div>
        <p class="privacy">Keep the printed BitChord source URL private. Stop the service before closing the launcher.</p>
      </section>

      <section class="section-card" id="source-settings" aria-labelledby="sourceTitle">
        <h2 class="section-heading" id="sourceTitle">Source</h2>
        <p class="section-description">Set the address and selection behavior BitChord uses to reach your server.</p>
        <div class="fields-grid">
          <div class="field full"><label for="publicUrl">Base address</label><div class="address-row"><input id="publicUrl" type="url" autocomplete="url" aria-describedby="publicUrlHint lanAddressHint publicUrlState" placeholder="https://device.tailnet.ts.net"><button class="button" id="useLan" type="button">Use LAN address</button></div><p class="hint" id="publicUrlHint">Enter the base address only. A valid address is saved on this device when startup is accepted.</p><p class="hint" id="lanAddressHint"></p><p class="hint" id="publicUrlState" aria-live="polite"></p></div>
          <div class="field full"><label class="check"><input id="lanAccess" type="checkbox">Connect from another device on this LAN</label><p class="hint">Uses the detected private IP and a word-only adjective/noun access phrase. Keep the full source URL private. Android BitChord currently blocks plain HTTP; see the LAN setup note.</p></div>
          <div class="field full"><label class="check"><input id="funnel" type="checkbox">Start Tailscale Funnel on port 8080</label><p class="hint">Use Funnel only when you want to share over a public HTTPS .ts.net address.</p></div>
          <div class="field"><label class="slider-label" for="wordCount">Words in source URL <output id="wordCountValue" class="slider-value">3</output></label><input class="slider" id="wordCount" type="range" min="2" max="8" value="3"></div>
          <div class="field"><label class="slider-label" for="wordLength">Target letters per word <output id="wordLengthValue" class="slider-value">6</output></label><input class="slider" id="wordLength" type="range" min="3" max="9" value="6"></div>
          <div class="field full"><p class="hint">Each word varies by up to 3 letters from the target (within 3–9). Adjectives come first, then one noun. Non-LAN source URLs also include a separate random 128-bit bearer token.</p><p class="hint phrase-preview" id="phrasePreview" aria-live="polite"></p></div>
          <div class="field full"><label class="check"><input id="allowDownloads" type="checkbox">Allow downloads in BitChord</label><p class="hint">Off by default. When enabled, BitChord may offer downloads from this source.</p></div>
          <div class="field full"><label class="check"><input id="bitchordAuth" type="checkbox">Require BitChord 1.9.1 signed authentication</label><p class="hint">Optional and off by default. Requires HTTPS except on localhost; older BitChord clients cannot use this mode.</p></div>
          <div class="field full"><label for="sourceSelection">Source selection</label><select id="sourceSelection"><option value="match">Best filename match (recommended)</option><option value="speed">Highest reported upload speed</option></select><p class="hint">Fastest-speed mode returns only the peer reporting the highest upload speed, even when another result may be a closer match. Peer speeds are self-reported.</p></div>
        </div>
      </section>

      <section class="section-card" id="search-settings" aria-labelledby="searchTitle">
        <h2 class="section-heading" id="searchTitle">Search</h2>
        <p class="section-description">Tune how Soulseek results are requested and ranked.</p>
        <div class="fields-grid">
          <div class="field"><label for="searchLimit">Maximum search results</label><input id="searchLimit" type="number" min="1" max="50" step="1" value="50" required><p class="hint">Applies to best-match mode. Fastest-speed mode always returns one result.</p></div>
          <div class="field"><label for="searchTimeout">Soulseek search timeout (seconds)</label><input id="searchTimeout" type="number" min="1" max="30" step="1" value="2" required></div>
          <div class="field full"><label class="check"><input id="searchRecovery" type="checkbox" checked>Retry likely missing vowels when no results are found</label></div>
        </div>
      </section>

      <section class="section-card" id="transfer-settings" aria-labelledby="transferTitle">
        <h2 class="section-heading" id="transferTitle">Transfers</h2>
        <p class="section-description">Manage concurrent transfers, reconnect behavior, and file-size limits.</p>
        <div class="fields-grid">
          <div class="field"><label for="reconnectGrace">Reconnect grace period (seconds)</label><input id="reconnectGrace" type="number" min="1" max="600" step="1" value="30" required><p class="hint">How long an unfinished transfer stays open after all HTTP consumers disconnect.</p></div>
          <div class="field"><label for="transferSlots">Concurrent Soulseek transfers</label><select id="transferSlots"><option value="1">1 transfer</option><option value="2" selected>2 transfers (maximum)</option></select></div>
          <div class="field"><label for="maxTrackSize">Maximum size per track (MiB)</label><input id="maxTrackSize" type="number" min="1" max="128" step="1" value="128" required></div>
        </div>
      </section>

      <section class="section-card" id="cache-settings" aria-labelledby="cacheTitle">
        <h2 class="section-heading" id="cacheTitle">Cache</h2>
        <p class="section-description">Choose how long cached files stay available and the maximum disk space to use.</p>
        <div class="fields-grid">
          <div class="field"><label for="cacheTtl">Cache expiration (minutes)</label><input id="cacheTtl" type="number" min="1" max="10080" step="1" value="30" required></div>
          <div class="field"><label for="cacheMaxSize">Maximum cache size (MiB)</label><input id="cacheMaxSize" type="number" min="16" max="32768" step="1" value="2048" required></div>
        </div>
      </section>

    </main>
  </div>
</div>
<script>
const token=__TOKEN_JSON__, api="/"+token+"/api/", lanIp=__LAN_IP_JSON__;
const $=id=>document.getElementById(id);
let sourceUrl="";
function applyTheme(theme,persist=false){const dark=theme==="dark";document.documentElement.dataset.theme=dark?"dark":"light";$("themeToggle").textContent=dark?"Light mode":"Dark mode";$("themeToggle").setAttribute("aria-label",dark?"Switch to light mode":"Switch to dark mode");$("themeToggle").setAttribute("aria-pressed",String(dark));if(persist){try{localStorage.setItem("bitseekwin.theme",dark?"dark":"light");}catch(e){console.warn("Could not save the appearance preference.",e);}}}
let savedTheme="dark";try{const storedTheme=localStorage.getItem("bitseekwin.theme");if(storedTheme==="dark"||storedTheme==="light")savedTheme=storedTheme;}catch(e){console.warn("Could not load the appearance preference.",e);}
applyTheme(savedTheme);
$("themeToggle").addEventListener("click",()=>applyTheme(document.documentElement.dataset.theme==="dark"?"light":"dark",true));
$("publicUrl").value=__PUBLIC_URL_JSON__;
try{const savedPublicUrl=localStorage.getItem("bitseekwin.publicBaseUrl");if(savedPublicUrl&&normalizePublicUrl(savedPublicUrl))$("publicUrl").value=savedPublicUrl;}catch(e){$("publicUrlState").textContent="Saved address could not be loaded from this browser.";}
$("funnel").checked=$("publicUrl").value.endsWith(".ts.net");
const lanBaseUrl=lanIp?"http://"+lanIp+":8080":"";
$("lanAddressHint").textContent=lanIp?"Detected LAN address: "+lanBaseUrl+". Android BitChord does not currently allow this HTTP URL.":"No private LAN IPv4 address was detected.";
$("useLan").disabled=!lanIp;
function setLanAccess(enabled){$("lanAccess").checked=enabled;if(enabled){if(!lanBaseUrl){$("lanAccess").checked=false;return;} $("publicUrl").value=lanBaseUrl;$("publicUrl").disabled=true;$("funnel").checked=false;$("funnel").disabled=true;}else{$("publicUrl").disabled=false;$("funnel").disabled=false;}validatePublicUrl();}
$("useLan").addEventListener("click",()=>setLanAccess(true));
$("lanAccess").addEventListener("change",()=>setLanAccess($("lanAccess").checked));
function normalizePublicUrl(value){const url=value.trim().replace(/\/+$/,"");if(!url||/[\u0000-\u0020]/.test(url))return null;let parsed;try{parsed=new URL(url);}catch(e){return null;}if(!["http:","https:"].includes(parsed.protocol)||!parsed.host||parsed.username||parsed.password||parsed.search||parsed.hash||!["","/"].includes(parsed.pathname))return null;return url;}
function validatePublicUrl(){const input=$("publicUrl"),normalized=normalizePublicUrl(input.value);input.setCustomValidity(input.value.trim()&&!normalized?"Enter a valid base URL without credentials, path, query, or fragment.":"");return normalized;}
$("publicUrl").addEventListener("input",()=>{validatePublicUrl();$("publicUrlState").textContent="";});
function updateSlider(slider){const min=Number(slider.min),max=Number(slider.max),value=Number(slider.value);slider.style.setProperty("--range-progress",((value-min)/(max-min)*100)+"%");}
for(const id of ["wordCount","wordLength"]){const slider=$(id);slider.addEventListener("input",()=>{updateSlider(slider);updatePhrasePreview();});updateSlider(slider);}
function updatePhrasePreview(){const count=Number($("wordCount").value),length=Number($("wordLength").value);const low=Math.max(3,length-3),high=Math.min(9,length+3);$("wordCountValue").textContent=count;$("wordLengthValue").textContent=length;$("phrasePreview").textContent="Word lengths: "+low+"–"+high+" letters.";}
updatePhrasePreview();
update();
document.querySelectorAll(".nav-link").forEach(link=>link.addEventListener("click",()=>{document.querySelectorAll(".nav-link").forEach(item=>item.classList.remove("current"));link.classList.add("current");}));
$("start").addEventListener("click",async()=>{
  const publicUrl=validatePublicUrl();if(!publicUrl){$("publicUrl").reportValidity();return;}
  const numericSettings=["searchLimit","searchTimeout","reconnectGrace","cacheTtl","cacheMaxSize","maxTrackSize"];
  const invalidSetting=numericSettings.map(id=>$(id)).find(input=>!input.checkValidity());
  if(invalidSetting){invalidSetting.reportValidity();return;}
  const config={username:$("username").value,password:$("password").value,public_url:publicUrl,lan_access:$("lanAccess").checked,start_funnel:$("funnel").checked,allow_downloads:$("allowDownloads").checked,bitchord_auth:$("bitchordAuth").checked,source_selection:$("sourceSelection").value,search_limit:Number($("searchLimit").value),search_timeout_ms:Number($("searchTimeout").value)*1000,search_recovery:$("searchRecovery").checked,idle_transfer_timeout_seconds:Number($("reconnectGrace").value),cache_ttl_minutes:Number($("cacheTtl").value),cache_max_size_mb:Number($("cacheMaxSize").value),max_active_streams:Number($("transferSlots").value),max_stream_size_mb:Number($("maxTrackSize").value),word_count:Number($("wordCount").value),word_length:Number($("wordLength").value)};
  $("start").disabled=true;$("state").textContent="Starting";$("dot").className="dot";
  try{const r=await fetch(api+"start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(config)});const d=await r.json();if(!r.ok)throw Error(d.error||"Could not start.");try{localStorage.setItem("bitseekwin.publicBaseUrl",publicUrl);$("publicUrlState").textContent="Address saved on this device.";}catch(e){$("publicUrlState").textContent="Startup accepted, but this browser could not save the address.";}$("password").value="";$("logs").textContent="Connecting directly to Soulseek…";}
  catch(e){$("start").disabled=false;alert(e.message);}
  await update();
});
$("stop").addEventListener("click",async()=>{try{await fetch(api+"stop",{method:"POST"});}catch(e){}await update();});
$("copy").addEventListener("click",async()=>{if(sourceUrl){await navigator.clipboard.writeText(sourceUrl);$("state").textContent="URL copied";}});
$("exit").addEventListener("click",async()=>{if(!confirm("Exit BitSeekWin and disconnect from Soulseek?"))return;try{await fetch(api+"exit",{method:"POST"});}catch(e){}document.body.innerHTML="<main class='exit-screen'><h1>BitSeekWin stopped.</h1><p>You can close this browser tab.</p></main>";});
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
                "font-src 'self'; "
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
                body = _page(token, public_url, detect_lan_ip())
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self._security_headers()
                self.end_headers()
                self.wfile.write(body)
            elif path == f"/{token}/assets/inter-variable.woff2":
                self.send_response(200)
                self.send_header("Content-Type", "font/woff2")
                self.send_header("Content-Length", str(len(INTER_FONT_DATA)))
                self._security_headers()
                self.end_headers()
                self.wfile.write(INTER_FONT_DATA)
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
