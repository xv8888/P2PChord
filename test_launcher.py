import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import threading
from unittest.mock import patch
from pathlib import Path

from launcher import (
    LauncherController,
    SOURCE_WORDS,
    _page,
    build_bitseekwin_environment,
    find_node_runtime,
    generate_source_secret,
    make_handler,
    normalize_public_url,
)
from http.server import ThreadingHTTPServer


class LauncherConfigurationTests(unittest.TestCase):
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

    def test_bitseekwin_receives_session_credentials_only_in_environment(self):
        env = build_bitseekwin_environment(
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
        self.assertEqual(env["BITSEEKWIN_WORD_COUNT"], "3")
        self.assertEqual(env["BITSEEKWIN_WORD_LENGTH"], "6")
        self.assertEqual(env["BITSEEKWIN_ALLOW_DOWNLOADS"], "false")
        self.assertEqual(env["KEEP"], "yes")
        self.assertNotIn("SLSKD_API_KEY", env)
        self.assertNotIn("SLSKD_SLSK_PASSWORD", env)

    def test_bitseekwin_download_permission_is_opt_in(self):
        env = build_bitseekwin_environment(
            {},
            "user",
            "password",
            "secret",
            "http://127.0.0.1:8080",
            allow_downloads=True,
        )
        self.assertEqual(env["BITSEEKWIN_ALLOW_DOWNLOADS"], "true")
        with self.assertRaisesRegex(ValueError, "Allow downloads"):
            build_bitseekwin_environment(
                {}, "user", "password", "secret", "http://127.0.0.1:8080",
                allow_downloads="true",
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

    def test_dashboard_uses_browser_ui_and_describes_source_security(self):
        page = _page("test-token", "https://device.example.ts.net").decode("utf-8")
        self.assertIn('type="password"', page)
        self.assertIn('id="wordCount" type="range" min="2" max="8" value="3"', page)
        self.assertIn('id="wordLength" type="range" min="3" max="9" value="6"', page)
        self.assertIn("Adjectives come first, then one noun", page)
        self.assertIn("128-bit access security", page)
        self.assertIn("Target letters per word", page)
        self.assertIn('<details class="source-settings">', page)
        self.assertIn("<summary>Source URL settings</summary>", page)
        self.assertIn('id="allowDownloads" type="checkbox"', page)
        self.assertIn('allow_downloads:$("allowDownloads").checked', page)
        self.assertNotIn('id="allowDownloads" type="checkbox" checked', page)
        self.assertIn('<span class="brand-bit">Bit</span>', page)
        self.assertIn('<span class="brand-seek">Seek</span>', page)
        self.assertIn('<span class="brand-win">win</span>', page)
        self.assertIn("zoom:1.5", page)
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
        self.assertIn('localStorage.setItem("bitseekwin.publicBaseUrl",publicUrl)', page)
        self.assertIn('localStorage.getItem("bitseekwin.publicBaseUrl")', page)
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
            with urlopen(f"{base}/{token}", timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(b"BitSeekWin", response.read())
            with self.assertRaises(HTTPError) as error:
                urlopen(f"{base}/wrong-token", timeout=3)
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
