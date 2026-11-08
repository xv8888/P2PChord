import base64
import http.client
import ipaddress
import json
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, wait
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_TORRENT_BYTES = 2 * 1024 * 1024
MAX_QUERY_LENGTH = 200
MAX_INDEXER_URL_LENGTH = 2048
MAX_RESULTS = 50
MAX_ARCHIVE_METADATA = 10
_REQUEST_SLOTS = threading.BoundedSemaphore(2)
_RATE_LOCK = threading.Lock()
_LAST_REQUEST = {}


class DiscoveryError(ValueError):
    pass


def _public_addresses(host, port):
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise DiscoveryError("Indexer host could not be resolved.") from exc
    if not addresses:
        raise DiscoveryError("Indexer host could not be resolved.")
    ips = []
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise DiscoveryError("Indexer host must resolve only to public IP addresses.")
        if ip not in ips:
            ips.append(ip)
    return ips


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        address = _public_addresses(self.host, self.port)[0]
        self.sock = socket.create_connection(
            (str(address), self.port), self.timeout, self.source_address
        )
        if self._tunnel_host:
            self._tunnel()
        try:
            self.sock = self._context.wrap_socket(
                self.sock, server_hostname=self._tunnel_host or self.host
            )
        except Exception:
            self.sock.close()
            raise


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        return self.do_open(
            _PinnedHTTPSConnection, request, context=self._context
        )


def _validate_https_url(value, *, archive_only=False):
    if not isinstance(value, str) or len(value) > MAX_INDEXER_URL_LENGTH:
        raise DiscoveryError("Indexer URL is invalid.")
    parts = urlsplit(value)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.fragment
        or any(ord(char) < 33 for char in value)
    ):
        raise DiscoveryError("Indexer URLs must use HTTPS and cannot contain credentials or fragments.")
    host = parts.hostname.lower().rstrip(".")
    try:
        port = parts.port or 443
    except ValueError as exc:
        raise DiscoveryError("Indexer port is invalid.") from exc
    if archive_only and host != "archive.org" and not host.endswith(".archive.org"):
        raise DiscoveryError("Internet Archive links must stay on archive.org.")
    _public_addresses(host, port)
    return parts


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, *, archive_only=False, original_host=None):
        super().__init__()
        self.archive_only = archive_only
        self.original_host = original_host

    def redirect_request(self, request, response, code, message, headers, new_url):
        parts = _validate_https_url(new_url, archive_only=self.archive_only)
        if not self.archive_only and parts.hostname.lower() != self.original_host:
            raise DiscoveryError("Indexer redirect changed hosts.")
        return super().redirect_request(
            request, response, code, message, headers, new_url
        )


def _fetch(
    url, timeout, *, limit=MAX_RESPONSE_BYTES, archive_only=False, cancel_event=None
):
    if cancel_event and cancel_event.is_set():
        raise InterruptedError("Torrent discovery was cancelled.")
    _validate_https_url(url, archive_only=archive_only)
    host = urlsplit(url).hostname.lower()
    with _RATE_LOCK:
        now = time.monotonic()
        next_request = _LAST_REQUEST.get(host, now)
        _LAST_REQUEST[host] = max(now, next_request) + 1
        delay = max(0, next_request - now)
    if delay:
        if cancel_event:
            if cancel_event.wait(delay):
                raise InterruptedError("Torrent discovery was cancelled.")
        else:
            time.sleep(delay)
    if cancel_event and cancel_event.is_set():
        raise InterruptedError("Torrent discovery was cancelled.")
    if not _REQUEST_SLOTS.acquire(timeout=timeout):
        raise DiscoveryError("Torrent indexer concurrency limit reached.")
    try:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _SafeRedirectHandler(
                archive_only=archive_only,
                original_host=host,
            ),
            _PinnedHTTPSHandler(context=ssl.create_default_context()),
        )
        request = urllib.request.Request(
            url,
            headers={"Accept": "application/json, application/rss+xml, application/xml"},
        )
        with opener.open(request, timeout=timeout) as response:
            body = response.read(limit + 1)
            if cancel_event and cancel_event.is_set():
                raise InterruptedError("Torrent discovery was cancelled.")
            if len(body) > limit:
                raise DiscoveryError("Indexer response exceeds the size limit.")
            return body
    except urllib.error.HTTPError as exc:
        raise DiscoveryError(f"Indexer returned HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise DiscoveryError("Indexer request failed.") from exc
    finally:
        _REQUEST_SLOTS.release()


def _normalise_hash(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if re.fullmatch(r"[a-fA-F0-9]{40}", value):
        return value.lower()
    if re.fullmatch(r"[A-Z2-7a-z2-7]{32}", value):
        try:
            decoded = base64.b32decode(value.upper())
        except ValueError:
            return None
        return decoded.hex() if len(decoded) == 20 else None
    return None


def _magnet_hash(value):
    if not isinstance(value, str) or len(value) > 4096:
        return None
    try:
        parts = urlsplit(value)
        if parts.scheme.lower() != "magnet":
            return None
        for token in parse_qs(parts.query).get("xt", []):
            match = re.fullmatch(r"urn:btih:(.+)", token, re.I)
            if match:
                return _normalise_hash(match.group(1))
    except ValueError:
        return None
    return None


def _torznab_fields(item):
    fields = {}
    for element in item.iter():
        if element.tag.rsplit("}", 1)[-1].lower() == "attr":
            name = element.attrib.get("name", "").lower()
            if name in {"infohash", "size", "seeders", "peers", "leechers", "category"}:
                fields[name] = element.attrib.get("value", "")
    return fields


def parse_torznab_feed(body, source_name="Torznab"):
    if not isinstance(body, bytes) or len(body) > MAX_RESPONSE_BYTES:
        raise DiscoveryError("Indexer response exceeds the size limit.")
    if b"<!doctype" in body.lower() or b"<!entity" in body.lower():
        raise DiscoveryError("Indexer response contains unsupported XML declarations.")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise DiscoveryError("Indexer returned malformed RSS/XML.") from exc
    if any(element.tag.rsplit("}", 1)[-1].lower() == "error" for element in root.iter()):
        raise DiscoveryError("Indexer reported an API error.")

    results = []
    for item in root.iter():
        if item.tag.rsplit("}", 1)[-1].lower() != "item":
            continue
        values = {}
        for element in item:
            name = element.tag.rsplit("}", 1)[-1].lower()
            if name in {"title", "link", "guid", "description"}:
                values[name] = (element.text or "").strip()
            elif name == "enclosure":
                values["enclosure"] = element.attrib.get("url", "")
        title = values.get("title", "")[:512]
        fields = _torznab_fields(item)
        magnet = next(
            (
                value
                for value in (
                    values.get("link", ""),
                    values.get("guid", ""),
                    values.get("enclosure", ""),
                )
                if _magnet_hash(value)
            ),
            "",
        )
        info_hash = _magnet_hash(magnet) or _normalise_hash(fields.get("infohash"))
        if not title or not info_hash:
            continue
        download_url = values.get("enclosure", "")
        if not download_url and values.get("link", "").lower().endswith(".torrent"):
            download_url = values["link"]
        if download_url.lower().startswith("magnet:"):
            download_url = ""
        if download_url:
            try:
                _validate_https_url(download_url)
            except DiscoveryError:
                download_url = ""
        source_url = values.get("link", "")
        if source_url.lower().startswith("magnet:"):
            source_url = ""
        if source_url:
            try:
                _validate_https_url(source_url)
            except DiscoveryError:
                source_url = ""
        if not magnet and not download_url:
            continue
        size = _positive_int(fields.get("size"))
        if size is None:
            size = _positive_int(next(
                (child.text for child in item if child.tag.rsplit("}", 1)[-1].lower() == "size"),
                None,
            ))
        fmt = "FLAC" if re.search(r"\bflac\b", title, re.I) else "Unknown"
        artist, album = _split_release(title)
        results.append({
            "title": title,
            "artist": artist,
            "album": album,
            "format": fmt,
            "size": size,
            "seeders": _positive_int(fields.get("seeders")),
            "leechers": _positive_int(fields.get("leechers") or fields.get("peers")),
            "source": source_name,
            "info_hash": info_hash,
            "magnet_url": magnet or None,
            "download_url": download_url or None,
            "source_url": source_url or download_url or magnet or None,
            "import_source": magnet or download_url or None,
        })
    return results


def _positive_int(value):
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if 0 <= result <= 2**53 - 1 else None


def _split_release(title):
    match = re.match(r"^(.+?)\s+-\s+(.+?)(?:\s+\[(?:FLAC|LOSSLESS)[^\]]*\])?$", title, re.I)
    return (match.group(1).strip(), match.group(2).strip()) if match else ("", "")


def _archive_query(query):
    phrase = query.replace("\\", "\\\\").replace('"', '\\"')
    return f'mediatype:audio AND (title:"{phrase}" OR creator:"{phrase}")'


def _archive_search(query, limit, timeout, cancel_event=None):
    deadline = time.monotonic() + timeout
    url = "https://archive.org/advancedsearch.php?" + urlencode({
        "q": _archive_query(query),
        "fl[]": ["identifier", "title", "creator"],
        "rows": str(min(limit * 2, MAX_ARCHIVE_METADATA)),
        "output": "json",
    }, doseq=True)
    payload = json.loads(_fetch(
        url, timeout, archive_only=True, cancel_event=cancel_event
    ))
    if not isinstance(payload, dict) or not isinstance(payload.get("response"), dict):
        raise DiscoveryError("Internet Archive returned malformed search results.")
    docs = payload["response"].get("docs", [])
    if not isinstance(docs, list):
        raise DiscoveryError("Internet Archive returned malformed search results.")
    identifiers = [
        item.get("identifier")
        for item in docs
        if isinstance(item, dict) and isinstance(item.get("identifier"), str)
        and re.fullmatch(r"[A-Za-z0-9._-]{1,128}", item["identifier"])
    ][:MAX_ARCHIVE_METADATA]
    remaining = deadline - time.monotonic()
    if not identifiers:
        return []
    if remaining <= 0:
        raise DiscoveryError("Internet Archive search exceeded its timeout.")
    results = []
    executor = ThreadPoolExecutor(max_workers=2)
    try:
        pending = {
            executor.submit(_archive_item, item_id, remaining, cancel_event): item_id
            for item_id in identifiers
        }
        completed, unfinished = wait(pending, timeout=remaining)
        for future in completed:
            try:
                result = future.result()
            except (DiscoveryError, json.JSONDecodeError, OSError):
                continue
            if result:
                results.append(result)
        if unfinished:
            raise DiscoveryError("Internet Archive item metadata exceeded its timeout.")
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=False, cancel_futures=True)
    return results[:limit]


def _archive_item(identifier, timeout, cancel_event=None):
    url = f"https://archive.org/metadata/{urllib.parse.quote(identifier)}"
    payload = json.loads(_fetch(
        url, timeout, archive_only=True, cancel_event=cancel_event
    ))
    if not isinstance(payload, dict):
        raise DiscoveryError("Internet Archive returned malformed item metadata.")
    metadata = payload.get("metadata", {})
    files = payload.get("files", [])
    if not isinstance(metadata, dict) or not isinstance(files, list):
        return None
    audio_files = [
        item for item in files
        if isinstance(item, dict)
        and (
            str(item.get("name", "")).lower().endswith(".flac")
            or str(item.get("format", "")).lower() == "flac"
        )
    ]
    torrent = next(
        (
            item for item in files
            if isinstance(item, dict)
            and item.get("name") == f"{identifier}_archive.torrent"
            and _normalise_hash(item.get("btih"))
        ),
        None,
    )
    if not audio_files or not torrent:
        return None
    title = str(metadata.get("title") or identifier)[:512]
    artist = str(metadata.get("creator") or "")[:256]
    info_hash = _normalise_hash(torrent["btih"])
    download_url = (
        "https://archive.org/download/"
        + urllib.parse.quote(identifier, safe="")
        + "/"
        + urllib.parse.quote(torrent["name"], safe="")
    )
    return {
        "title": title,
        "artist": artist,
        "album": title,
        "format": "FLAC",
        "size": sum(_positive_int(item.get("size")) or 0 for item in audio_files),
        "seeders": None,
        "leechers": None,
        "source": "Internet Archive",
        "info_hash": info_hash,
        "magnet_url": None,
        "download_url": download_url,
        "source_url": (
            "https://archive.org/details/"
            + urllib.parse.quote(identifier, safe="")
        ),
        "import_source": download_url,
    }


def _torznab_search(endpoint, api_key, query, limit, timeout, cancel_event=None):
    parts = _validate_https_url(endpoint)
    if api_key and (not isinstance(api_key, str) or len(api_key) > 256 or any(ord(c) < 33 for c in api_key)):
        raise DiscoveryError("Torznab API key is invalid.")
    params = dict(parse_qs(parts.query, keep_blank_values=True))
    params.update({"t": ["search"], "q": [query], "cat": ["3000"], "limit": [str(limit)]})
    if api_key:
        params["apikey"] = [api_key]
    url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params, doseq=True), ""))
    body = _fetch(url, timeout, cancel_event=cancel_event)
    return parse_torznab_feed(body, parts.hostname)


def _rank(result, query):
    title = result["title"].casefold()
    terms = [term.casefold() for term in re.findall(r"[\w]+", query)]
    overlap = sum(term in title for term in terms)
    return (result["format"] == "FLAC", overlap, result["seeders"] or 0)


class TorrentDiscovery:
    def __init__(self):
        self._lock = threading.Lock()
        self._cache = {}

    def search(
        self,
        query,
        indexers,
        *,
        torznab_url="",
        torznab_api_key="",
        timeout=10,
        limit=20,
        cancel_event=None,
    ):
        if cancel_event and cancel_event.is_set():
            raise InterruptedError("Torrent discovery was cancelled.")
        if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY_LENGTH or any(ord(c) < 32 for c in query):
            raise DiscoveryError("Enter a search query of 1–200 characters.")
        if (
            not isinstance(indexers, list)
            or not indexers
            or any(not isinstance(item, str) or item not in ("archive", "torznab") for item in indexers)
            or len(set(indexers)) != len(indexers)
        ):
            raise DiscoveryError("Select at least one supported torrent indexer.")
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, int)
            or not 1 <= timeout <= 30
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= MAX_RESULTS
        ):
            raise DiscoveryError("Torrent search timeout or result limit is out of range.")
        if "torznab" in indexers:
            _validate_https_url(torznab_url)
            if (
                not isinstance(torznab_api_key, str)
                or len(torznab_api_key) > 256
                or any(ord(char) < 33 for char in torznab_api_key)
            ):
                raise DiscoveryError("Torznab API key is invalid.")
        key = (query.strip().casefold(), tuple(sorted(indexers)), torznab_url, torznab_api_key, timeout, limit)
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(key)
            if cached and now - cached[0] < 60:
                return cached[1]

        results = []
        errors = []
        for indexer in indexers:
            if cancel_event and cancel_event.is_set():
                raise InterruptedError("Torrent discovery was cancelled.")
            try:
                if indexer == "archive":
                    indexer_results = _archive_search(
                        query.strip(), limit, timeout, cancel_event
                    )
                else:
                    indexer_results = _torznab_search(
                        torznab_url,
                        torznab_api_key,
                        query.strip(),
                        limit,
                        timeout,
                        cancel_event,
                    )
                if cancel_event and cancel_event.is_set():
                    raise InterruptedError("Torrent discovery was cancelled.")
                results.extend(indexer_results)
            except (DiscoveryError, json.JSONDecodeError, TimeoutError) as exc:
                errors.append(f"{'Internet Archive' if indexer == 'archive' else 'Torznab'}: {exc}")

        unique = {}
        for result in results:
            current = unique.get(result["info_hash"])
            if current is None or _rank(result, query) > _rank(current, query):
                unique[result["info_hash"]] = result
        ranked = sorted(unique.values(), key=lambda result: _rank(result, query), reverse=True)[:limit]
        with self._lock:
            now = time.monotonic()
            self._cache = {
                cache_key: value
                for cache_key, value in self._cache.items()
                if now - value[0] < 60
            }
            if len(self._cache) >= 100:
                oldest = min(self._cache, key=lambda cache_key: self._cache[cache_key][0])
                del self._cache[oldest]
            self._cache[key] = (now, (ranked, errors))
        return ranked, errors


def fetch_torrent(source, timeout=10):
    if isinstance(source, str) and source.lower().startswith("magnet:"):
        if not _magnet_hash(source):
            raise DiscoveryError("Magnet URI must contain a valid info hash.")
        return source
    parts = _validate_https_url(source, archive_only=source.startswith("https://archive.org/"))
    archive_only = (
        parts.hostname == "archive.org"
        or parts.hostname.endswith(".archive.org")
    )
    body = _fetch(
        source,
        timeout,
        limit=MAX_TORRENT_BYTES,
        archive_only=archive_only,
    )
    if not body or len(body) > MAX_TORRENT_BYTES:
        raise DiscoveryError("Torrent metadata must be between 1 byte and 2 MiB.")
    return body
