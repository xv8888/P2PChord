import unittest
from pathlib import Path

from launcher import (
    build_bitseekwin_environment,
    build_slskd_environment,
    normalize_public_url,
)


class LauncherConfigurationTests(unittest.TestCase):
    def test_normalizes_public_url(self):
        self.assertEqual(
            normalize_public_url(" https://device.example.ts.net/ "),
            "https://device.example.ts.net",
        )

    def test_rejects_non_base_public_urls(self):
        for value in ("device.example.ts.net", "ftp://device.example", "https://user@device.example/path"):
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


if __name__ == "__main__":
    unittest.main()
