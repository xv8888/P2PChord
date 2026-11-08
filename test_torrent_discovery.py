import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import torrent_discovery as discovery

FIXTURES = Path(__file__).parent / "tests" / "fixtures"


class TorrentDiscoveryTests(unittest.TestCase):
    def test_torznab_fixture_normalises_metadata_and_skips_malformed_items(self):
        body = (FIXTURES / "torznab.xml").read_bytes()
        with patch.object(discovery, "_validate_https_url"):
            results = discovery.parse_torznab_feed(body, "fixture indexer")

        self.assertEqual(len(results), 2)
        first = results[0]
        self.assertEqual(first["info_hash"], "0123456789012345678901234567890123456789")
        self.assertEqual(first["artist"], "Artist Name")
        self.assertEqual(first["album"], "Album Name")
        self.assertEqual(first["format"], "FLAC")
        self.assertEqual(first["size"], 123456789)
        self.assertEqual(first["seeders"], 12)
        self.assertEqual(first["leechers"], 3)
        self.assertEqual(first["source"], "fixture indexer")
        self.assertTrue(first["magnet_url"].startswith("magnet:"))

    def test_torznab_rejects_malformed_or_entity_expanding_xml(self):
        for body in (
            b"<rss><channel>",
            b"<!DOCTYPE x [<!ENTITY e 'x'>]><rss>&e;</rss>",
            b"<rss xmlns:t='http://torznab.com/schemas/2015/feed'><channel><t:error code='100' description='API error'/></channel></rss>",
        ):
            with self.subTest(body=body), self.assertRaises(discovery.DiscoveryError):
                discovery.parse_torznab_feed(body)

    def test_lossless_title_is_not_mislabeled_as_flac(self):
        body = b"""<rss><channel><item>
          <title>Artist - Album [Lossless]</title>
          <link>magnet:?xt=urn:btih:0123456789012345678901234567890123456789</link>
        </item></channel></rss>"""
        with patch.object(discovery, "_validate_https_url"):
            result = discovery.parse_torznab_feed(body)[0]
        self.assertEqual(result["format"], "Unknown")

    def test_archive_metadata_search_timeout_does_not_wait_for_workers(self):
        response = b'{"response":{"docs":[{"identifier":"first"},{"identifier":"second"}]}}'
        release_workers = threading.Event()
        try:
            with (
                patch.object(discovery, "_fetch", return_value=response),
                patch.object(
                    discovery,
                    "_archive_item",
                    side_effect=lambda *_args: release_workers.wait(),
                ),
            ):
                started = discovery.time.monotonic()
                with self.assertRaisesRegex(discovery.DiscoveryError, "exceeded its timeout"):
                    discovery._archive_search("album", 2, 0.05)
                self.assertLess(discovery.time.monotonic() - started, 0.5)
        finally:
            release_workers.set()

    def test_archive_fixture_extracts_flac_size_hash_and_download_link(self):
        fixture = (FIXTURES / "archive_item.json").read_bytes()
        with patch.object(discovery, "_fetch", return_value=fixture):
            result = discovery._archive_item("music-example", 5)

        self.assertEqual(result["title"], "Example Album")
        self.assertEqual(result["artist"], "Example Artist")
        self.assertEqual(result["format"], "FLAC")
        self.assertEqual(result["size"], 3500)
        self.assertEqual(result["info_hash"], "0123456789012345678901234567890123456789")
        self.assertTrue(result["download_url"].startswith("https://archive.org/download/"))

    def test_search_deduplicates_by_info_hash_and_ranks_flac_then_seeders(self):
        result = {
            "title": "Artist - Release",
            "artist": "Artist",
            "album": "Release",
            "size": 1,
            "seeders": 2,
            "leechers": 0,
            "source": "fixture",
            "info_hash": "1" * 40,
            "magnet_url": "magnet:?xt=urn:btih:" + "1" * 40,
            "download_url": None,
            "import_source": "magnet:?xt=urn:btih:" + "1" * 40,
            "format": "Unknown",
        }
        flac = {**result, "format": "FLAC", "seeders": 1, "source": "better"}
        other = {**result, "info_hash": "2" * 40, "seeders": 100}
        indexer = discovery.TorrentDiscovery()
        with (
            patch.object(discovery, "_validate_https_url"),
            patch.object(discovery, "_archive_search", return_value=[result, other]),
            patch.object(discovery, "_torznab_search", return_value=[flac]),
        ):
            results, errors = indexer.search(
                "Artist Release",
                ["archive", "torznab"],
                torznab_url="https://indexer.example/api",
            )

        self.assertEqual(errors, [])
        self.assertEqual([item["info_hash"] for item in results], ["1" * 40, "2" * 40])
        self.assertEqual(results[0]["source"], "better")

    def test_search_validates_inputs_and_cancellation(self):
        with self.assertRaisesRegex(discovery.DiscoveryError, "search query"):
            discovery.TorrentDiscovery().search("", ["archive"])
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaisesRegex(InterruptedError, "cancelled"):
            discovery.TorrentDiscovery().search(
                "album", ["archive"], cancel_event=cancelled
            )
        cancelled.clear()
        with patch.object(
            discovery,
            "_archive_search",
            side_effect=lambda *_args: (cancelled.set() or []),
        ):
            with self.assertRaisesRegex(InterruptedError, "cancelled"):
                discovery.TorrentDiscovery().search(
                    "album", ["archive"], cancel_event=cancelled
                )

    def test_search_returns_indexer_failures_without_fake_results(self):
        indexer = discovery.TorrentDiscovery()
        with patch.object(
            discovery, "_archive_search", side_effect=discovery.DiscoveryError("offline")
        ):
            results, errors = indexer.search("album", ["archive"])
        self.assertEqual(results, [])
        self.assertEqual(errors, ["Internet Archive: offline"])

    def test_url_validation_rejects_private_addresses_and_redirect_host_changes(self):
        with patch.object(
            discovery.socket,
            "getaddrinfo",
            return_value=[(None, None, None, None, ("10.0.0.2", 443))],
        ):
            with self.assertRaisesRegex(discovery.DiscoveryError, "public IP"):
                discovery._validate_https_url("https://indexer.example/api")

        handler = discovery._SafeRedirectHandler(original_host="indexer.example")
        response = type("Response", (), {})()
        with (
            patch.object(discovery, "_validate_https_url", return_value=type(
                "Parts", (), {"hostname": "other.example"}
            )()),
            self.assertRaisesRegex(discovery.DiscoveryError, "changed hosts"),
        ):
            handler.redirect_request(
                None, response, 302, "Found", {}, "https://other.example/redirect"
            )

    def test_https_connection_uses_a_validated_ip_and_hostname_for_tls(self):
        address = (2, 1, 6, "", ("8.8.8.8", 443))
        sock = object()
        tls_sock = object()
        context = Mock()
        context.wrap_socket.return_value = tls_sock
        with (
            patch.object(discovery.socket, "getaddrinfo", return_value=[address]),
            patch.object(discovery.socket, "create_connection", return_value=sock) as connect,
        ):
            connection = discovery._PinnedHTTPSConnection(
                "indexer.example", timeout=5, context=context
            )
            connection.connect()

        connect.assert_called_once_with(("8.8.8.8", 443), 5, None)
        context.wrap_socket.assert_called_once_with(
            sock, server_hostname="indexer.example"
        )
        self.assertIs(connection.sock, tls_sock)

    def test_https_connection_rejects_dns_rebinding_to_a_private_address(self):
        public = (2, 1, 6, "", ("8.8.8.8", 443))
        private = (2, 1, 6, "", ("10.0.0.2", 443))
        with (
            patch.object(
                discovery.socket, "getaddrinfo", side_effect=[[public], [private]]
            ),
            patch.object(discovery.socket, "create_connection") as connect,
        ):
            discovery._validate_https_url("https://indexer.example/api")
            connection = discovery._PinnedHTTPSConnection(
                "indexer.example", timeout=5, context=Mock()
            )
            with self.assertRaisesRegex(discovery.DiscoveryError, "public IP"):
                connection.connect()

        connect.assert_not_called()

    def test_selected_torrent_fetch_accepts_magnet_and_bounds_download(self):
        magnet = "magnet:?xt=urn:btih:" + "a" * 40
        self.assertEqual(discovery.fetch_torrent(magnet), magnet)
        with (
            patch.object(discovery, "_validate_https_url"),
            patch.object(discovery, "_fetch", return_value=b"metadata") as fetch,
        ):
            result = discovery.fetch_torrent("https://indexer.example/album.torrent")
        self.assertEqual(result, b"metadata")
        self.assertEqual(fetch.call_args.kwargs["limit"], discovery.MAX_TORRENT_BYTES)
        with self.assertRaises(discovery.DiscoveryError):
            discovery.fetch_torrent("magnet:?xt=urn:btih:invalid")


if __name__ == "__main__":
    unittest.main()
