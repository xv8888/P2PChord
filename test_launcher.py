import unittest
from io import StringIO
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import threading
from unittest.mock import patch
from pathlib import Path

from launcher import (
    LauncherController,
    SOURCE_WORDS,
    _page,
    build_p2pchord_environment,
    detect_lan_ip,
    find_node_runtime,
    generate_source_secret,
    make_handler,
    normalize_public_url,
)
from http.server import ThreadingHTTPServer


class LauncherConfigurationTests(unittest.TestCase):
    def test_detect_lan_ip_prefers_private_route_address(self):
        route = type(
            "Route",
            (),
            {
                "__enter__": lambda self: self,
                "__exit__": lambda self, *_args: None,
                "connect": lambda self, _address: None,
                "getsockname": lambda self: ("192.168.1.42", 0),
            },
        )()
        with patch("launcher.socket.socket", return_value=route), patch(
            "launcher.socket.getaddrinfo", return_value=[]
        ):
            self.assertEqual(detect_lan_ip(), "192.168.1.42")

    def test_detect_lan_ip_filters_loopback_and_link_local_addresses(self):
        entries = [
            (None, None, None, None, ("127.0.0.1", 0)),
            (None, None, None, None, ("169.254.4.3", 0)),
            (None, None, None, None, ("10.0.0.8", 0)),
        ]
        route = type(
            "Route",
            (),
            {
                "__enter__": lambda self: self,
                "__exit__": lambda self, *_args: None,
                "connect": lambda self, _address: None,
                "getsockname": lambda self: ("0.0.0.0", 0),
            },
        )()
        with patch("launcher.socket.socket", return_value=route), patch(
            "launcher.socket.getaddrinfo", return_value=entries
        ):
            self.assertEqual(detect_lan_ip(), "10.0.0.8")

    def test_normalizes_public_url(self):
        self.assertEqual(
            normalize_public_url(" https://device.example.ts.net/ "),
            "https://device.example.ts.net",
        )

    def test_rejects_non_base_public_urls(self):
        for value in (
            "device.example.ts.net",
            "ftp://device.example",
            "https://user@device.example/path",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_public_url(value)

    def test_requires_node_22_or_newer(self):
        with patch("launcher.shutil.which", return_value="node"), patch(
            "launcher.subprocess.run",
            return_value=type("Result", (), {"stdout": "v20.12.0"})(),
        ):
            with self.assertRaisesRegex(ValueError, "Node.js 22 or newer"):
                find_node_runtime()

    def test_p2pchord_receives_session_credentials_only_in_environment(self):
        env = build_p2pchord_environment(
            {
                "KEEP": "yes",
                "SLSKD_API_KEY": "stale-key",
                "SLSKD_SLSK_PASSWORD": "stale-password",
            },
            "soulseek-user",
            "soulseek-password",
            "generated-source-secret",
            "https://device.example.ts.net",
        )
        self.assertEqual(env["SOULSEEK_USERNAME"], "soulseek-user")
        self.assertEqual(env["SOULSEEK_PASSWORD"], "soulseek-password")
        self.assertEqual(env["BITCHORD_SECRET"], "generated-source-secret")
        self.assertEqual(env["PUBLIC_BASE_URL"], "https://device.example.ts.net")
        self.assertEqual(env["PORT"], "8080")
        self.assertEqual(env["P2PCHORD_WORD_COUNT"], "3")
        self.assertEqual(env["P2PCHORD_WORD_LENGTH"], "6")
        self.assertEqual(env["P2PCHORD_ALLOW_DOWNLOADS"], "false")
        self.assertEqual(env["P2PCHORD_BITCHORD_AUTH"], "false")
        self.assertEqual(env["P2PCHORD_BIND_ADDRESS"], "127.0.0.1")
        self.assertEqual(env["P2PCHORD_SOURCE_SELECTION"], "match")
        self.assertEqual(env["P2PCHORD_SEARCH_LIMIT"], "50")
        self.assertEqual(env["P2PCHORD_SEARCH_TIMEOUT_MS"], "2000")
        self.assertEqual(env["P2PCHORD_SEARCH_RECOVERY"], "true")
        self.assertEqual(env["P2PCHORD_IDLE_TRANSFER_TIMEOUT_MS"], "30000")
        self.assertEqual(env["P2PCHORD_CACHE_TTL_MS"], "1800000")
        self.assertEqual(env["P2PCHORD_CACHE_MAX_BYTES"], str(2 * 1024 * 1024 * 1024))
        self.assertEqual(env["P2PCHORD_MAX_ACTIVE_STREAMS"], "2")
        self.assertEqual(env["P2PCHORD_MAX_STREAM_BYTES"], str(128 * 1024 * 1024))
        self.assertEqual(env["P2PCHORD_SOULSEEK_ENABLED"], "true")
        self.assertEqual(env["P2PCHORD_TORRENT_ENABLED"], "false")
        self.assertEqual(env["P2PCHORD_TORRENT_SOURCES"], "[]")
        self.assertEqual(env["P2PCHORD_TORRENT_STORAGE_MAX_BYTES"], str(4 * 1024 * 1024 * 1024))
        self.assertEqual(env["KEEP"], "yes")
        self.assertNotIn("SLSKD_API_KEY", env)
        self.assertNotIn("SLSKD_SLSK_PASSWORD", env)

    def test_torrent_only_environment_does_not_inherit_soulseek_credentials(self):
        env = build_p2pchord_environment(
            {"SOULSEEK_USERNAME": "stale", "SOULSEEK_PASSWORD": "stale"},
            "",
            "",
            "secret",
            "https://device.example.test",
            soulseek_enabled=False,
            torrent_enabled=True,
            torrent_sources=["magnet:?xt=urn:btih:0123456789012345678901234567890123456789"],
        )
        self.assertEqual(env["P2PCHORD_SOULSEEK_ENABLED"], "false")
        self.assertEqual(env["P2PCHORD_TORRENT_ENABLED"], "true")
        self.assertEqual(
            env["P2PCHORD_TORRENT_SOURCES"],
            '["magnet:?xt=urn:btih:0123456789012345678901234567890123456789"]',
        )
        self.assertNotIn("SOULSEEK_USERNAME", env)
        self.assertNotIn("SOULSEEK_PASSWORD", env)
        with self.assertRaisesRegex(ValueError, "Enable Soulseek"):
            build_p2pchord_environment(
                {}, "", "", "secret", "http://127.0.0.1:8080",
                soulseek_enabled=False,
                torrent_enabled=False,
            )
        with self.assertRaisesRegex(ValueError, "valid BitTorrent info hash"):
            build_p2pchord_environment(
                {}, "", "", "secret", "http://127.0.0.1:8080",
                soulseek_enabled=False,
                torrent_enabled=True,
                torrent_sources=["magnet:?xt=urn:btih:invalid"],
            )

    def test_p2pchord_download_permission_is_opt_in(self):
        env = build_p2pchord_environment(
            {},
            "user",
            "password",
            "secret",
            "http://127.0.0.1:8080",
            allow_downloads=True,
        )
        self.assertEqual(env["P2PCHORD_ALLOW_DOWNLOADS"], "true")
        with self.assertRaisesRegex(ValueError, "Allow downloads"):
            build_p2pchord_environment(
                {}, "user", "password", "secret", "http://127.0.0.1:8080",
                allow_downloads="true",
            )

    def test_bitchord_auth_is_opt_in_and_requires_https_except_loopback(self):
        env = build_p2pchord_environment(
            {},
            "user",
            "password",
            "secret",
            "https://device.example.test",
            bitchord_auth=True,
        )
        self.assertEqual(env["P2PCHORD_BITCHORD_AUTH"], "true")
        with self.assertRaisesRegex(ValueError, "BitChord authentication"):
            build_p2pchord_environment(
                {}, "user", "password", "secret", "https://device.example.test",
                bitchord_auth="true",
            )
        with self.assertRaisesRegex(ValueError, "BitChord authentication"):
            LauncherController().start(
                {
                    "username": "user",
                    "password": "password",
                    "public_url": "http://192.168.1.42:8080",
                    "bitchord_auth": True,
                }
            )

    def test_server_bind_address_defaults_to_loopback_and_accepts_explicit_ip(self):
        env = build_p2pchord_environment(
            {}, "user", "password", "secret", "http://127.0.0.1:8080",
            bind_address="192.168.1.42",
        )
        self.assertEqual(env["P2PCHORD_BIND_ADDRESS"], "192.168.1.42")
        with self.assertRaisesRegex(ValueError, "Bind address"):
            build_p2pchord_environment(
                {}, "user", "password", "secret", "http://127.0.0.1:8080",
                bind_address="0.0.0.0; malicious",
            )

    def test_launcher_ignores_stdout_source_url_and_sanitizes_control_characters(self):
        controller = LauncherController()
        controller.source_url = "https://trusted.example/p2pchord/secret"
        process = type(
            "Process",
            (),
            {
                "stdout": StringIO(
                    "Add this source in BitChord: https://attacker.test\n"
                ),
            },
        )()
        controller._read_output("P2PChord", process, ())
        self.assertEqual(
            controller.source_url,
            "https://trusted.example/p2pchord/secret",
        )
        self.assertFalse(any("\n" in line for line in controller.logs))

    def test_stop_disables_only_its_configured_funnel(self):
        controller = LauncherController()
        controller.tailscale = "tailscale"
        controller.funnel_configured = True
        with patch(
            "launcher.subprocess.run",
            return_value=type("Result", (), {"returncode": 0})(),
        ) as run:
            controller.stop()
        self.assertFalse(controller.funnel_configured)
        self.assertEqual(
            run.call_args.args[0],
            ["tailscale", "funnel", "--bg", "--https=443", "8080", "off"],
        )

    def test_launcher_passes_bitchord_auth_setting_to_worker(self):
        settings = {
            "username": "user",
            "password": "password",
            "public_url": "https://device.example.test",
            "bitchord_auth": True,
        }
        with patch("launcher.find_node_runtime", return_value="node"), patch(
            "launcher.threading.Thread"
        ) as worker_thread:
            LauncherController().start(settings)

        self.assertTrue(worker_thread.call_args.kwargs["args"][5]["bitchord_auth"])

    def test_source_selection_is_configurable_and_validated(self):
        env = build_p2pchord_environment(
            {},
            "user",
            "password",
            "secret",
            "http://127.0.0.1:8080",
            source_selection="speed",
        )
        self.assertEqual(env["P2PCHORD_SOURCE_SELECTION"], "speed")
        with self.assertRaisesRegex(ValueError, "Source selection"):
            build_p2pchord_environment(
                {}, "user", "password", "secret", "http://127.0.0.1:8080",
                source_selection="unrecognized",
            )

    def test_search_and_fetch_options_map_to_server_environment(self):
        env = build_p2pchord_environment(
            {},
            "user",
            "password",
            "secret",
            "http://127.0.0.1:8080",
            search_limit=12,
            search_timeout_ms=5000,
            search_recovery=False,
            idle_transfer_timeout_seconds=45,
            cache_ttl_minutes=90,
            cache_max_size_mb=512,
            max_active_streams=1,
            max_stream_size_mb=64,
        )
        self.assertEqual(env["P2PCHORD_SEARCH_LIMIT"], "12")
        self.assertEqual(env["P2PCHORD_SEARCH_TIMEOUT_MS"], "5000")
        self.assertEqual(env["P2PCHORD_SEARCH_RECOVERY"], "false")
        self.assertEqual(env["P2PCHORD_IDLE_TRANSFER_TIMEOUT_MS"], "45000")
        self.assertEqual(env["P2PCHORD_CACHE_TTL_MS"], "5400000")
        self.assertEqual(env["P2PCHORD_CACHE_MAX_BYTES"], str(512 * 1024 * 1024))
        self.assertEqual(env["P2PCHORD_MAX_ACTIVE_STREAMS"], "1")
        self.assertEqual(env["P2PCHORD_MAX_STREAM_BYTES"], str(64 * 1024 * 1024))

    def test_search_and_fetch_options_reject_values_outside_supported_limits(self):
        for option, value in (
            ("search_limit", 51),
            ("search_timeout_ms", 499),
            ("idle_transfer_timeout_seconds", 601),
            ("cache_ttl_minutes", 0),
            ("cache_max_size_mb", 15),
            ("max_active_streams", 3),
            ("max_stream_size_mb", 129),
        ):
            with self.subTest(option=option), self.assertRaises(ValueError):
                build_p2pchord_environment(
                    {}, "user", "password", "secret", "http://127.0.0.1:8080",
                    **{option: value},
                )
        with self.assertRaisesRegex(ValueError, "Search recovery"):
            build_p2pchord_environment(
                {}, "user", "password", "secret", "http://127.0.0.1:8080",
                search_recovery="false",
            )

    def test_start_passes_search_and_transfer_settings_together(self):
        settings = {
            "username": "user",
            "password": "password",
            "public_url": "http://127.0.0.1:8080",
            "allow_downloads": True,
            "bitchord_auth": True,
            "source_selection": "speed",
            "search_limit": 12,
            "search_timeout_ms": 5000,
            "search_recovery": False,
            "idle_transfer_timeout_seconds": 45,
            "cache_ttl_minutes": 90,
            "cache_max_size_mb": 512,
            "max_active_streams": 1,
            "max_stream_size_mb": 64,
        }
        with patch("launcher.find_node_runtime", return_value="node"), patch(
            "launcher.threading.Thread"
        ) as worker_thread:
            LauncherController().start(settings)

        worker_settings = worker_thread.call_args.kwargs["args"][5]
        self.assertEqual(
            worker_settings,
            {
                key: value
                for key, value in settings.items()
                if key not in {"username", "password", "public_url"}
            }
            | {
                "soulseek_enabled": True,
                "torrent_enabled": False,
                "torrent_sources": [],
                "torrent_storage_max_size_gb": 4,
            },
        )

    def test_start_uses_detected_lan_address_and_word_only_secret_mode(self):
        settings = {
            "username": "user",
            "password": "password",
            "public_url": "http://127.0.0.1:8080",
            "lan_access": True,
        }
        with patch("launcher.detect_lan_ip", return_value="192.168.1.42"), patch(
            "launcher.find_node_runtime", return_value="node"
        ), patch("launcher.threading.Thread") as worker_thread:
            LauncherController().start(settings)

        args = worker_thread.call_args.kwargs["args"]
        self.assertEqual(args[3], "http://192.168.1.42:8080")
        self.assertFalse(args[4])
        self.assertTrue(args[8])
        self.assertEqual(args[9], "192.168.1.42")

    def test_start_rejects_lan_mode_without_a_private_address(self):
        with patch("launcher.detect_lan_ip", return_value=None), patch(
            "launcher.find_node_runtime", return_value="node"
        ):
            with self.assertRaisesRegex(ValueError, "No private LAN IPv4"):
                LauncherController().start(
                    {
                        "username": "user",
                        "password": "password",
                        "public_url": "http://127.0.0.1:8080",
                        "lan_access": True,
                    }
                )

    def test_source_secret_words_follow_selected_count_and_length(self):
        entropy = bytes(range(16))
        phrase_entropy = bytes((0, 0, 0, 0, 0, 3, 0, 0, 0, 6, 0, 0) + (0,) * 20)
        secret = generate_source_secret(3, 6, entropy, phrase_entropy)
        parts = secret.split("-")
        words = parts[:-1]
        self.assertEqual([len(word) for word in words], [3, 6, 9])
        self.assertTrue(all(word in SOURCE_WORDS["adjectives"]["3"] for word in words[:1]))
        self.assertTrue(all(word in SOURCE_WORDS["adjectives"]["6"] for word in words[1:2]))
        self.assertIn(words[-1], SOURCE_WORDS["nouns"]["9"])
        self.assertEqual(parts[-1], "AAECAwQFBgcICQoLDA0ODw")

    def test_lan_source_secret_omits_the_random_token_but_keeps_phrase_auth(self):
        with patch(
            "launcher.secrets.token_bytes",
            side_effect=AssertionError("LAN mode should not generate a token"),
        ):
            phrase = generate_source_secret(
                3,
                6,
                phrase_bytes=bytes(
                    (0, 0, 0, 0, 0, 3, 0, 0, 0, 6, 0, 0) + (0,) * 20
                ),
                include_token=False,
            )
        words = phrase.split("-")
        self.assertEqual(len(words), 3)
        self.assertTrue(all(word.isalpha() for word in words))
        self.assertIn(words[-1], SOURCE_WORDS["nouns"][str(len(words[-1]))])

    def test_source_secret_varies_each_word_within_three_letters(self):
        for word_count in range(2, 9):
            for word_length in range(3, 10):
                with self.subTest(word_count=word_count, word_length=word_length):
                    secret = generate_source_secret(
                        word_count,
                        word_length,
                        bytes(range(16)),
                        bytes(range(32)),
                    )
                    words = secret.split("-")
                    self.assertEqual(len(words), word_count + 1)
                    low = max(3, word_length - 3)
                    high = min(9, word_length + 3)
                    self.assertTrue(
                        all(low <= len(word) <= high for word in words[:-1])
                    )
                    self.assertRegex(words[-1], r"^[A-Za-z0-9_~]{22}$")
                    for word in words[:-2]:
                        length = len(word)
                        self.assertIn(word, SOURCE_WORDS["adjectives"][str(length)])
                    self.assertIn(
                        words[-2],
                        SOURCE_WORDS["nouns"][str(len(words[-2]))],
                    )

    def test_word_length_limits_clamp_variation_to_available_lists(self):
        phrase_entropy = bytes((255, 255, 0, 0)) * 8
        for target, low, high in ((3, 3, 6), (9, 6, 9)):
            with self.subTest(target=target):
                words = generate_source_secret(
                    8, target, bytes(range(16)), phrase_entropy
                ).split("-")[:-1]
                self.assertTrue(all(low <= len(word) <= high for word in words))

    def test_source_secret_rejects_out_of_range_settings(self):
        for word_count, word_length in ((1, 6), (9, 6), (3, 2), (3, 10)):
            with self.subTest(word_count=word_count, word_length=word_length):
                with self.assertRaises(ValueError):
                    generate_source_secret(word_count, word_length)

    def test_source_word_dictionaries_are_expanded_tenfold(self):
        self.assertEqual(sum(map(len, SOURCE_WORDS["adjectives"].values())), 710)
        self.assertEqual(sum(map(len, SOURCE_WORDS["nouns"].values())), 650)
        for kind, groups in SOURCE_WORDS.items():
            for length, words in groups.items():
                with self.subTest(kind=kind, length=length):
                    self.assertTrue(all(len(word) == int(length) for word in words))
                    self.assertEqual(len(words), len(set(words)))

    def test_start_rejects_invalid_source_word_settings(self):
        for values in (
            {"word_count": 1, "word_length": 6},
            {"word_count": 3, "word_length": 10},
            {"word_count": True, "word_length": 6},
        ):
            with self.subTest(values=values), self.assertRaisesRegex(
                ValueError, "Word"
            ):
                LauncherController().start(
                    {
                        "username": "user",
                        "password": "password",
                        "public_url": "http://127.0.0.1:8080",
                        **values,
                    }
                )

    def test_start_rejects_non_boolean_download_option(self):
        with self.assertRaisesRegex(ValueError, "Allow downloads"):
            LauncherController().start(
                {
                    "username": "user",
                    "password": "password",
                    "public_url": "http://127.0.0.1:8080",
                    "allow_downloads": "true",
                }
            )

    def test_start_rejects_invalid_source_selection(self):
        with self.assertRaisesRegex(ValueError, "Source selection"):
            LauncherController().start(
                {
                    "username": "user",
                    "password": "password",
                    "public_url": "http://127.0.0.1:8080",
                    "source_selection": "unrecognized",
                }
            )

    def test_start_rejects_out_of_range_search_and_transfer_settings(self):
        for setting, value in (
            ("search_limit", 51),
            ("search_timeout_ms", 499),
            ("idle_transfer_timeout_seconds", 601),
            ("cache_ttl_minutes", 0),
            ("cache_max_size_mb", 15),
            ("max_active_streams", 3),
            ("max_stream_size_mb", 129),
        ):
            with self.subTest(setting=setting), self.assertRaises(ValueError):
                LauncherController().start(
                    {
                        "username": "user",
                        "password": "password",
                        "public_url": "http://127.0.0.1:8080",
                        setting: value,
                    }
                )

    def test_dashboard_preserves_controls_in_responsive_music_app_layout(self):
        page = _page("test-token", "https://device.example.ts.net").decode("utf-8")
        self.assertIn('type="password"', page)
        self.assertIn('id="wordCount" type="range" min="2" max="8" value="3"', page)
        self.assertIn('id="wordLength" type="range" min="3" max="9" value="6"', page)
        self.assertIn("Adjectives come first, then one noun", page)
        self.assertIn("random 128-bit bearer token", page)
        self.assertIn("another device on this LAN", page)
        self.assertIn('id="bitchordAuth" type="checkbox"', page)
        self.assertNotIn(
            '$("funnel").checked=$("publicUrl").value.endsWith(".ts.net")',
            page,
        )
        self.assertIn("192.168.1.42", _page(
            "test-token", "https://device.example.ts.net", "192.168.1.42"
        ).decode("utf-8"))
        self.assertIn("Target letters per word", page)
        self.assertIn('aria-label="Launcher sections"', page)
        self.assertIn(".content-scroll{min-height:0}", page)
        self.assertNotIn("overscroll-behavior:contain", page)
        for section in (
            "connection",
            "source-settings",
            "search-settings",
            "transfer-settings",
            "cache-settings",
            "activity",
            "providers",
        ):
            self.assertIn(f'id="{section}"', page)
        for target in ("activity", "providers", "transfer-settings", "cache-settings", "source-settings"):
            self.assertIn(f'href="#{target}"', page)
        self.assertIn('class="titlebar"', page)
        self.assertIn('class="app-footer"><span>P2PChord | alpha-0.1.0</span>', page)
        self.assertNotIn('class="sidebar"', page)
        self.assertNotIn('class="player"', page)
        self.assertLess(page.index('id="activity"'), page.index('id="connection"'))
        for control in (
            "username",
            "password",
            "publicUrl",
            "lanAccess",
            "useLan",
            "funnel",
            "allowDownloads",
            "sourceSelection",
            "searchLimit",
            "searchTimeout",
            "searchRecovery",
            "reconnectGrace",
            "transferSlots",
            "maxTrackSize",
            "cacheTtl",
            "cacheMaxSize",
            "start",
            "stop",
            "copy",
            "exit",
            "themeToggle",
            "logs",
        ):
            self.assertIn(f'id="{control}"', page)
        self.assertIn('id="allowDownloads" type="checkbox"', page)
        self.assertIn('lan_access:$("lanAccess").checked', page)
        self.assertIn('allow_downloads:$("allowDownloads").checked', page)
        self.assertIn('$("password").value="";$("logs").textContent="Starting enabled P2P sources…";', page)
        self.assertNotIn('$("username").value=""', page)
        self.assertIn('id="sourceSelection"', page)
        self.assertIn('source_selection:$("sourceSelection").value', page)
        self.assertIn('id="searchLimit" type="number" min="1" max="50"', page)
        self.assertIn('id="searchTimeout" type="number" min="1" max="30"', page)
        self.assertIn('id="searchRecovery" type="checkbox" checked', page)
        self.assertIn('id="reconnectGrace" type="number" min="1" max="600"', page)
        self.assertIn('id="cacheTtl" type="number" min="1" max="10080"', page)
        self.assertIn('id="cacheMaxSize" type="number" min="16" max="32768"', page)
        self.assertIn('id="transferSlots"', page)
        self.assertIn('<option value="2" selected>2 transfers (maximum)</option>', page)
        self.assertIn('id="maxTrackSize" type="number" min="1" max="128"', page)
        self.assertIn('search_timeout_ms:Number($("searchTimeout").value)*1000', page)
        self.assertIn('max_active_streams:Number($("transferSlots").value)', page)
        self.assertIn("if(invalidSetting){invalidSetting.reportValidity();return;}", page)
        self.assertNotIn('id="allowDownloads" type="checkbox" checked', page)
        self.assertIn('<span class="brand-bit">P2P</span>', page)
        self.assertIn('<span class="brand-seek">Chord</span>', page)
        self.assertIn(".brand-bit{background:linear-gradient(110deg,#49d5e8,#2996d6 56%,#254eb7)", page)
        self.assertIn(".brand-seek{background:linear-gradient(115deg,#fa233b 8%,#fb5c74 48%,#fb8c55 100%)", page)
        self.assertIn("--text-brand-primary:1.08em", page)
        self.assertIn("--text-brand-win:.48em", page)
        self.assertIn(".brand-bit,.brand-seek{font-size:var(--text-brand-primary);font-weight:var(--weight-bold)}", page)
        self.assertIn('font-family:var(--font-ui)', page)
        self.assertIn('font-weight:100 900', page)
        self.assertIn("--text-display:28px", page)
        self.assertIn("--weight-semibold:600", page)
        self.assertIn('<html lang="en" data-theme="dark">', page)
        self.assertIn('aria-label="Switch to light mode" aria-pressed="true"', page)
        self.assertIn('let savedTheme="dark"', page)
        self.assertIn('localStorage.getItem("p2pchord.theme")', page)
        self.assertIn('localStorage.setItem("p2pchord.theme"', page)
        self.assertIn("applyTheme(savedTheme)", page)
        self.assertIn(':root[data-theme="light"]', page)
        self.assertIn('addEventListener("click",()=>applyTheme(', page)
        self.assertIn('src:url("/test-token/assets/inter-variable.woff2") format("woff2")', page)
        self.assertIn('href="/test-token/assets/p2pchord-icon.png"', page)
        self.assertIn('class="brand-icon" src="/test-token/assets/p2pchord-icon.png"', page)
        self.assertNotIn("Segoe UI", page)
        self.assertIn(".slider::-webkit-slider-runnable-track", page)
        self.assertIn(".slider::-webkit-slider-thumb", page)
        self.assertIn(".slider::-moz-range-progress", page)
        self.assertIn('function updateSlider(slider)', page)
        self.assertIn('slider.addEventListener("input",()=>{updateSlider(slider);updatePhrasePreview();});', page)
        self.assertIn("@media(max-width:720px)", page)
        self.assertNotIn("zoom:1.5", page)
        self.assertIn("Math.max(3,length-3)", page)
        self.assertIn("Word lengths: \"+low+\"–\"+high+\" letters.", page)
        self.assertNotIn("sourceWords", page)
        self.assertNotIn('"adjectives"', page)
        self.assertIn('role="log"', page)
        self.assertIn("match=/^", page)
        self.assertNotIn("slskd", page.casefold())
        self.assertIn("device.example.ts.net", page)
        self.assertNotIn("__TOKEN_JSON__", page)
        self.assertNotIn("tkinter", page.casefold())

    def test_dashboard_omits_monitoring_panel_and_status_footer(self):
        page = _page("test-token", "https://device.example.ts.net").decode("utf-8")
        self.assertNotIn("Live monitoring", page)
        self.assertNotIn('class="monitoring"', page)
        self.assertNotIn('aria-label="Operational status"', page)
        self.assertNotIn("barConnection", page)
        self.assertNotIn('+"/monitoring"', page)

    def test_dashboard_persists_and_validates_source_address(self):
        page = _page("test-token", "https://device.example.ts.net").decode("utf-8")
        self.assertIn('localStorage.setItem("p2pchord.publicBaseUrl",publicUrl)', page)
        self.assertIn('localStorage.getItem("p2pchord.publicBaseUrl")', page)
        self.assertIn("function validatePublicUrl()", page)

    def test_ez_start_launches_the_browser_launcher(self):
        script = Path(__file__).with_name("ez-start.bat").read_text(encoding="utf-8")
        self.assertIn('cd /d "%~dp0"', script)
        self.assertIn('pythonw.exe "%~dp0launcher.py"', script)
        self.assertIn('python "%~dp0launcher.py"', script)
        self.assertNotIn("server.py", script)

    def test_dashboard_requires_loopback_host_and_session_token(self):
        token = "test-session-token"
        httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0), make_handler(LauncherController(), token)
        )
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{httpd.server_port}"
        try:
            with patch("launcher.detect_tailscale_url", return_value=""):
                with urlopen(f"{base}/{token}", timeout=3) as response:
                    self.assertEqual(response.status, 200)
                    page = response.read()
                    self.assertIn(b"P2PChord", page)
                    self.assertIn(
                        "font-src 'self'", response.headers["Content-Security-Policy"]
                    )
            with urlopen(
                f"{base}/{token}/assets/inter-variable.woff2", timeout=3
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], "font/woff2")
                self.assertEqual(response.read(4), b"wOF2")
            with urlopen(
                f"{base}/{token}/assets/p2pchord-icon.png", timeout=3
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Content-Type"], "image/png")
                self.assertEqual(response.read(8), b"\x89PNG\r\n\x1a\n")
            with self.assertRaises(HTTPError) as error:
                urlopen(f"{base}/wrong-token", timeout=3)
            self.assertEqual(error.exception.code, 403)
            with self.assertRaises(HTTPError) as error:
                urlopen(f"{base}/wrong-token/assets/inter-variable.woff2", timeout=3)
            self.assertEqual(error.exception.code, 403)
            with self.assertRaises(HTTPError) as error:
                urlopen(f"{base}/wrong-token/assets/p2pchord-icon.png", timeout=3)
            self.assertEqual(error.exception.code, 403)
            request = Request(
                f"{base}/{token}/api/start",
                data=b"{}",
                headers={"Content-Type": "application/json", "Origin": base},
                method="POST",
            )
            with self.assertRaises(HTTPError) as error:
                urlopen(request, timeout=3)
            self.assertEqual(error.exception.code, 400)
            request = Request(
                f"{base}/{token}/api/status",
                headers={"Origin": "http://attacker.example"},
                method="POST",
            )
            with self.assertRaises(HTTPError) as error:
                urlopen(request, timeout=3)
            self.assertEqual(error.exception.code, 403)
            request = Request(
                f"{base}/{token}/api/not-found",
                headers={"Origin": base},
                method="POST",
            )
            with self.assertRaises(HTTPError) as error:
                with urlopen(request, timeout=3) as response:
                    response.read()
            self.assertEqual(error.exception.code, 404)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_active_direct_service_reports_running(self):
        class RunningProcess:
            @staticmethod
            def poll():
                return None

        controller = LauncherController()
        controller.server_process = RunningProcess()
        state = controller.snapshot()
        self.assertTrue(state["active"])
        self.assertTrue(state["running"])

    def test_start_rejects_while_a_previous_start_is_stopping(self):
        controller = LauncherController()
        controller.starting = True
        with self.assertRaisesRegex(ValueError, "already starting or running"):
            controller.start({})


if __name__ == "__main__":
    unittest.main()
