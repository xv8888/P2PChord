import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import Request, urlopen

from version import __version__

APP_NAME = "BitSeekWin - BitChord-Soulseek Integration"
LOG = logging.getLogger("bitseekwin")
SLUG = os.environ.get(
    "BITSEEKWIN_SLUG",
    os.environ.get("BITSEEK_SLUG", os.environ.get("BITCHORD_SLUG", "bitseekwin")),
)
SECRET = os.environ.get("BITCHORD_SECRET") or secrets.token_urlsafe(32)
PORT = int(os.environ.get("PORT", "8080"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", f"http://127.0.0.1:{PORT}").rstrip(
    "/"
)
SLSKD_URL = os.environ.get("SLSKD_URL", "http://127.0.0.1:5030").rstrip("/")
SLSKD_API_KEY = os.environ.get("SLSKD_API_KEY", "")
SLSKD_DOWNLOAD_DIR = Path(os.environ.get("SLSKD_DOWNLOAD_DIR", ""))
SEARCH_TIMEOUT = float(os.environ.get("SEARCH_TIMEOUT", "2"))
DOWNLOAD_TIMEOUT = float(os.environ.get("DOWNLOAD_TIMEOUT", "600"))
VERSION = __version__
SEARCH_LIMIT = 50
API_ROOT = "/api/v0"


@dataclass(frozen=True)
class RemoteTrack:
    id: str
    username: str
    filename: str
    size: int
    title: str


def _value(obj: dict, key: str, default=None):
    return obj.get(key, obj.get(key[0].upper() + key[1:], default))


def _safe_relative_filename(filename: str) -> PurePosixPath | None:
    normalized = filename.replace("\\", "/")
    path = PurePosixPath(normalized)
    if (
        path.is_absolute()
        or not path.parts
        or any(part in ("", ".", "..") for part in path.parts)
    ):
        return None
    if re.match(r"^[A-Za-z]:", path.parts[0]):
        return None
    return path


def _is_flac(filename: str) -> bool:
    path = _safe_relative_filename(filename)
    return path is not None and path.suffix.casefold() == ".flac"


def _file_id(username: str, filename: str, size: int) -> str:
    value = f"{username}\0{filename}\0{size}".encode("utf-8")
    return hashlib.sha256(value).hexdigest()[:24]


def _parse_byte_range(value: str, size: int) -> tuple[int, int]:
    if not value.startswith("bytes=") or "," in value:
        raise ValueError("Only one byte range is supported")
    start_text, separator, end_text = value[6:].partition("-")
    if not separator:
        raise ValueError("Malformed byte range")
    if not start_text:
        suffix_length = int(end_text)
        if suffix_length <= 0:
            raise ValueError("Invalid byte range")
        start = max(0, size - suffix_length)
        end = size - 1
    else:
        start = int(start_text)
        end = min(int(end_text), size - 1) if end_text else size - 1
    if size == 0 or start < 0 or start >= size or end < start:
        raise ValueError("Unsatisfiable byte range")
    return start, end


class SlskdClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        download_dir: Path,
        search_timeout: float = SEARCH_TIMEOUT,
        download_timeout: float = DOWNLOAD_TIMEOUT,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.download_dir = download_dir.resolve()
        self.search_timeout = search_timeout
        self.download_timeout = download_timeout
        self._pending_batches: dict[str, str] = {}
        self._download_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _request(
        self, method: str, path: str, body: dict | None = None, timeout: float = 15
    ) -> dict | list:
        if not self.api_key:
            raise RuntimeError("Set SLSKD_API_KEY to a slskd API key.")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = Request(
            f"{self.base_url}{API_ROOT}{path}",
            data=data,
            method=method,
            headers={
                "X-API-Key": self.api_key,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = response.read()
        except HTTPError as error:
            detail = error.read(2048).decode("utf-8", errors="replace")
            raise RuntimeError(
                f"slskd API returned HTTP {error.code}: {detail}"
            ) from error
        except URLError as error:
            raise RuntimeError(
                f"Could not reach slskd at {self.base_url}: {error.reason}"
            ) from error
        if not payload:
            return {}
        try:
            return json.loads(payload)
        except json.JSONDecodeError as error:
            raise RuntimeError("slskd API returned invalid JSON") from error

    def search(self, query: str) -> list[RemoteTrack]:
        search_id = str(uuid.uuid4())
        self._request("POST", "/searches", {"id": search_id, "searchText": query})
        deadline = time.monotonic() + self.search_timeout
        try:
            while True:
                search = self._request("GET", f"/searches/{search_id}")
                if _value(search, "isComplete", False) or time.monotonic() >= deadline:
                    break
                time.sleep(0.1)
        except Exception:
            try:
                self._request("PUT", f"/searches/{search_id}")
            except RuntimeError as stop_error:
                LOG.warning(
                    "Could not stop failed slskd search %s: %s", search_id, stop_error
                )
            raise
        if not _value(search, "isComplete", False):
            try:
                self._request("PUT", f"/searches/{search_id}")
            except RuntimeError as error:
                LOG.warning(
                    "Could not stop timed-out slskd search %s: %s", search_id, error
                )
        responses = self._request("GET", f"/searches/{search_id}/responses")
        return self._tracks_from_responses(responses)[:SEARCH_LIMIT]

    @staticmethod
    def _tracks_from_responses(responses: list | dict) -> list[RemoteTrack]:
        if isinstance(responses, dict):
            responses = _value(responses, "responses", [])
        found = []
        seen = set()
        for response in responses if isinstance(responses, list) else []:
            username = _value(response, "username", "")
            files = _value(response, "files", [])
            for file in files if isinstance(files, list) else []:
                filename = _value(file, "filename", "")
                if not username or not filename or not _is_flac(filename):
                    continue
                relative = _safe_relative_filename(filename)
                if relative is None:
                    continue
                try:
                    size = max(0, int(_value(file, "size", 0)))
                except (TypeError, ValueError):
                    continue
                track_id = _file_id(username, filename, size)
                if track_id in seen:
                    continue
                seen.add(track_id)
                found.append(
                    RemoteTrack(
                        id=track_id,
                        username=username,
                        filename=filename,
                        size=size,
                        title=relative.stem.replace("_", " "),
                    )
                )
        return found

    def prepare_download(self, track: RemoteTrack) -> tuple[Path | None, str | None]:
        if not self.api_key:
            raise RuntimeError("Set SLSKD_API_KEY to a slskd API key.")
        with self._locks_guard:
            lock = self._download_locks.setdefault(track.id, threading.Lock())

        with lock:
            target = self._download_path(track)
            if target.is_file() and (
                track.size == 0 or target.stat().st_size == track.size
            ):
                return target, None
            pending_batch = self._pending_batches.get(track.id)
            if pending_batch:
                return None, pending_batch

            batch_id = str(uuid.uuid4())
            destination = f"bitchord-cache/{track.id}"
            response = self._request(
                "POST",
                "/transfers/downloads/batches",
                {
                    "id": batch_id,
                    "username": track.username,
                    "files": [{"filename": track.filename, "size": track.size}],
                    "options": {"destination": destination},
                },
            )
            failures = _value(response, "failures", [])
            if failures:
                raise RuntimeError(f"slskd could not queue this file: {failures}")
            self._pending_batches[track.id] = batch_id
            return None, batch_id

    def download(self, track: RemoteTrack) -> Path:
        target, batch_id = self.prepare_download(track)
        if target is not None:
            return target
        if batch_id is None:
            raise RuntimeError("Could not queue or locate the selected file.")
        target = self._download_path(track)

        with self._locks_guard:
            lock = self._download_locks.setdefault(track.id, threading.Lock())
        with lock:
            deadline = time.monotonic() + self.download_timeout
            while time.monotonic() < deadline:
                try:
                    batch = self._request(
                        "GET", f"/transfers/downloads/batches/{batch_id}"
                    )
                except RuntimeError as error:
                    if "HTTP 404" not in str(error):
                        raise
                    time.sleep(0.2)
                    continue
                transfers = _value(batch, "transfers", [])
                for transfer in transfers if isinstance(transfers, list) else []:
                    if _value(transfer, "filename") != track.filename:
                        continue
                    state = str(_value(transfer, "state", "")).casefold()
                    if "succeeded" in state:
                        if target.is_file():
                            if track.size and target.stat().st_size != track.size:
                                raise RuntimeError(
                                    "slskd marked the transfer complete, but its file size is unexpected."
                                )
                            self._pending_batches.pop(track.id, None)
                            return target
                        raise RuntimeError(
                            f"slskd completed the transfer but the file is missing at {target}."
                        )
                    if "completed" in state or "failed" in state or "errored" in state:
                        self._pending_batches.pop(track.id, None)
                        raise RuntimeError(
                            f"slskd transfer did not complete successfully ({state})."
                        )
                time.sleep(0.2)
            raise TimeoutError(
                "Timed out waiting for slskd to download the selected FLAC."
            )

    def _download_path(self, track: RemoteTrack) -> Path:
        relative = _safe_relative_filename(track.filename)
        if relative is None:
            raise RuntimeError("slskd result contains an unsafe filename.")
        root = (self.download_dir / "bitchord-cache" / track.id).resolve()
        target = (root.joinpath(*relative.parts)).resolve()
        if not target.is_relative_to(root):
            raise RuntimeError(
                "Resolved download path escaped the slskd download directory."
            )
        return target


class AddonHandler(BaseHTTPRequestHandler):
    tracks: dict[str, RemoteTrack] = {}
    slskd: SlskdClient | None = None

    def log_message(self, _format: str, *_args) -> None:
        return

    def _headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges",
        )

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._headers()
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Range, If-Range, Content-Type"
        )
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def _route(self) -> tuple[list[str], dict[str, list[str]]] | None:
        parsed = urlsplit(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        if (
            len(parts) < 3
            or parts[0] != SLUG
            or not hmac.compare_digest(parts[1], SECRET)
        ):
            return None
        return parts[2:], parse_qs(parsed.query)

    def _json(self, value: dict) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    def _dispatch(self) -> None:
        route = self._route()
        if route is None:
            self.send_error(404)
            return
        parts, query = route

        if parts == ["manifest.json"]:
            self._json(
                {
                    "id": f"bitseekwin-addon.{SLUG}",
                    "name": APP_NAME,
                    "version": VERSION,
                    "description": "BitSeekWin prototype for searching FLAC results through slskd and streaming them to BitChord",
                    "resources": ["search", "stream"],
                    "types": ["track"],
                    "contentType": "music",
                    "allowDownloads": False,
                }
            )
        elif parts == ["search"] and self.command == "GET":
            search_text = query.get("q", [""])[0].strip()
            if not search_text:
                self._json({"tracks": [], "albums": [], "artists": [], "playlists": []})
                return
            try:
                tracks = self.slskd.search(search_text) if self.slskd else []
            except Exception as error:
                LOG.exception("slskd search failed")
                self.send_error(502, f"slskd search failed: {error}")
                return
            self.tracks.update((track.id, track) for track in tracks)
            self._json(
                {
                    "tracks": [
                        {
                            "id": track.id,
                            "title": track.title,
                            "artist": f"Shared by {track.username}",
                            "album": "",
                            "duration": 0,
                            "format": "flac",
                            "audioQuality": "LOSSLESS",
                        }
                        for track in tracks
                    ],
                    "albums": [],
                    "artists": [],
                    "playlists": [],
                }
            )
        elif len(parts) == 2 and parts[0] == "stream" and self.command == "GET":
            track = self.tracks.get(parts[1])
            if track is None:
                self.send_error(404)
                return
            try:
                if self.slskd is None:
                    raise RuntimeError("slskd client is not available.")
                self.slskd.prepare_download(track)
            except (OSError, RuntimeError) as error:
                LOG.exception("Could not queue selected slskd file")
                self.send_error(502, f"Could not queue selected file: {error}")
                return
            self._json(
                {
                    "url": f"{PUBLIC_BASE_URL}/{SLUG}/{SECRET}/file/{track.id}",
                    "format": "flac",
                    "quality": "lossless",
                    "codec": "FLAC",
                    "container": "flac",
                    "manifest": "none",
                }
            )
        elif len(parts) == 2 and parts[0] == "file":
            self._file(parts[1])
        else:
            self.send_error(404)

    def _file(self, track_id: str) -> None:
        track = self.tracks.get(track_id)
        if track is None or self.slskd is None:
            self.send_error(404)
            return
        try:
            path = self.slskd.download(track)
            size = path.stat().st_size
        except TimeoutError as error:
            LOG.warning("slskd download timed out: %s", error)
            self.send_error(504, str(error))
            return
        except (OSError, RuntimeError) as error:
            LOG.exception("Could not prepare slskd file for streaming")
            self.send_error(502, f"Could not prepare file for streaming: {error}")
            return

        range_header = self.headers.get("Range")
        status = 200
        start, end = 0, size - 1
        if range_header:
            try:
                start, end = _parse_byte_range(range_header, size)
                status = 206
            except (ValueError, OverflowError):
                self.send_response(416)
                self._headers()
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        length = max(0, end - start + 1)
        self.send_response(status)
        self._headers()
        self.send_header("Content-Type", "audio/flac")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        if self.command == "HEAD":
            return
        try:
            with path.open("rb") as audio_file:
                audio_file.seek(start)
                remaining = length
                while remaining:
                    chunk = audio_file.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    if not os.environ.get("SLSKD_DOWNLOAD_DIR"):
        raise SystemExit(
            "Set SLSKD_DOWNLOAD_DIR to slskd's downloads directory, visible to this server."
        )
    if not SLSKD_API_KEY:
        raise SystemExit(
            "Set SLSKD_API_KEY to an API key from your slskd configuration."
        )
    if not SLSKD_DOWNLOAD_DIR.is_dir():
        raise SystemExit(
            "Set SLSKD_DOWNLOAD_DIR to slskd's downloads directory, visible to this server."
        )
    if not re.fullmatch(r"[A-Za-z0-9_-]+", SLUG):
        raise SystemExit(
            "BITSEEKWIN_SLUG must contain only letters, digits, underscores, or hyphens."
        )

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    AddonHandler.slskd = SlskdClient(SLSKD_URL, SLSKD_API_KEY, SLSKD_DOWNLOAD_DIR)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), AddonHandler)
    print(f"\n{APP_NAME} v{VERSION}", file=sys.stderr)
    print(
        f"Add this source in BitChord: {PUBLIC_BASE_URL}/{SLUG}/{SECRET}",
        file=sys.stderr,
    )
    LOG.info(
        "Listening on port %d; slskd=%s; downloads=%s",
        PORT,
        SLSKD_URL,
        SLSKD_DOWNLOAD_DIR.resolve(),
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
