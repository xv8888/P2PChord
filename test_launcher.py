import json
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import threading

from launcher import (
    LauncherController,
    _page,
    browse_for_slskd,
    build_bitseekwin_environment,
    build_slskd_environment,
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

    def test_slskd_credentials_and_api_key_are_process_environment_only(self):
        env = build_slskd_environment(
            {"KEEP": "yes", "SLSKD_CONFIG": r"C:\existing\slskd.yml"},
            "soulseek-user",
            "soulseek-password",
            "generated-api-key",
            Path(r"C:\music\downloads"),
            Path(r"C:\appdata\bitseekwin\slskd"),
        )
        self.assertEqual(env["SLSKD_SLSK_USERNAME"], "soulseek-user")
        self.assertEqual(env["SLSKD_SLSK_PASSWORD"], "soulseek-password")
        self.assertEqual(env["SLSKD_DOWNLOADS_DIR"], r"C:\music\downloads")
        self.assertEqual(env["SLSKD_API_KEY"], "role=ReadWrite;generated-api-key")
        self.assertEqual(env["SLSKD_HTTP_IP_ADDRESS"], "127.0.0.1")
        self.assertEqual(env["SLSKD_HTTP_PORT"], "5030")
        self.assertEqual(env["KEEP"], "yes")
        self.assertNotIn("SLSKD_CONFIG", env)

    def test_bitseekwin_receives_same_api_key_and_download_path(self):
        env = build_bitseekwin_environment(
            {},
            "generated-api-key",
            Path(r"C:\music\downloads"),
            "https://device.example.ts.net",
        )
        self.assertEqual(env["SLSKD_API_KEY"], "generated-api-key")
        self.assertEqual(env["SLSKD_DOWNLOAD_DIR"], r"C:\music\downloads")
        self.assertEqual(env["PUBLIC_BASE_URL"], "https://device.example.ts.net")

    def test_dashboard_uses_browser_ui_and_escapes_default_windows_path(self):
        page = _page("test-token", "https://device.example.ts.net").decode("utf-8")
        self.assertIn('type="password"', page)
        self.assertIn('id="browse"', page)
        self.assertIn('fetch(api+"browse-slskd"', page)
        self.assertIn("device.example.ts.net", page)
        self.assertIn("downloads", page)
        self.assertNotIn("__TOKEN_JSON__", page)
        self.assertNotIn("tkinter", page.casefold())

    def test_slskd_picker_is_available_only_on_windows(self):
        with patch("launcher.sys.platform", "linux"):
            with self.assertRaisesRegex(RuntimeError, "only on Windows"):
                browse_for_slskd()

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
                f"{base}/{token}/api/browse-slskd",
                headers={"Origin": base},
                method="POST",
            )
            with patch("launcher.browse_for_slskd", return_value=r"C:\slskd\slskd.exe"):
                with urlopen(request, timeout=3) as response:
                    self.assertEqual(
                        json.loads(response.read()), {"path": r"C:\slskd\slskd.exe"}
                    )
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_partial_service_state_keeps_stop_available(self):
        class RunningProcess:
            @staticmethod
            def poll():
                return None

        controller = LauncherController()
        controller.slskd_process = RunningProcess()
        state = controller.snapshot()
        self.assertTrue(state["active"])
        self.assertFalse(state["running"])

    def test_start_rejects_while_a_previous_start_is_stopping(self):
        controller = LauncherController()
        controller.starting = True
        with self.assertRaisesRegex(ValueError, "already starting or running"):
            controller.start({})


if __name__ == "__main__":
    unittest.main()
