import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import threading
from unittest.mock import patch

from launcher import (
    LauncherController,
    _page,
    build_bitseekwin_environment,
    find_node_runtime,
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
        self.assertEqual(env["KEEP"], "yes")
        self.assertNotIn("SLSKD_API_KEY", env)
        self.assertNotIn("SLSKD_SLSK_PASSWORD", env)

    def test_dashboard_uses_browser_ui_and_describes_direct_streaming(self):
        page = _page("test-token", "https://device.example.ts.net").decode("utf-8")
        self.assertIn('type="password"', page)
        self.assertIn("Stream FLAC bytes live", page)
        self.assertNotIn("slskd", page.casefold())
        self.assertIn("device.example.ts.net", page)
        self.assertNotIn("__TOKEN_JSON__", page)
        self.assertNotIn("tkinter", page.casefold())

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
