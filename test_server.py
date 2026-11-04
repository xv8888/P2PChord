import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class StubSlskd:
    def __init__(self, root: Path, tracks: list[server.RemoteTrack]) -> None:
        self.download_dir = root
        self.tracks = tracks
        self.last_query = None
        self.download_calls = 0
        self.prepare_calls = 0

    def search(self, query: str) -> list[server.RemoteTrack]:
        self.last_query = query
        return self.tracks

    def prepare_download(
        self, track: server.RemoteTrack
    ) -> tuple[Path | None, str | None]:
        self.prepare_calls += 1
        return None, "pending-batch"

    def download(self, track: server.RemoteTrack) -> Path:
        self.download_calls += 1
        return self.download_dir / "bitchord-cache" / track.id / track.filename


class FakeResponse:
    def __init__(self, value: dict | list) -> None:
        self.payload = json.dumps(value).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self) -> bytes:
        return self.payload


class AddonServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.track = server.RemoteTrack(
            id="0123456789abcdef01234567",
            username="sample-owner",
            filename="Drum Kit/Kick One.flac",
            size=10,
            title="Kick One",
        )
        self.audio_path = (
            self.root / "bitchord-cache" / self.track.id / self.track.filename
        )
        self.audio_path.parent.mkdir(parents=True)
        self.audio_path.write_bytes(b"0123456789")

        self.patches = patch.multiple(
            server,
            SLUG="bitseekwin",
            SECRET="test-secret",
            PUBLIC_BASE_URL="https://music.example.test",
        )
        self.patches.start()
        self.handler_patches = patch.object(server.AddonHandler, "tracks", {})
        self.handler_patches.start()
        self.client = StubSlskd(self.root, [self.track])
        self.client_patch = patch.object(server.AddonHandler, "slskd", self.client)
        self.client_patch.start()
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.AddonHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_port}/bitseekwin/test-secret"

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.client_patch.stop()
        self.handler_patches.stop()
        self.patches.stop()
        self.temp_dir.cleanup()

    def get_json(self, path: str) -> dict:
        with urlopen(self.base + path) as response:
            return json.loads(response.read())

    def test_manifest_and_search_call_slskd(self) -> None:
        manifest = self.get_json("/manifest.json")
        results = self.get_json("/search?q=drum%20kick")
        self.assertIn("search", manifest["resources"])
        self.assertEqual(manifest["id"], "bitseekwin-addon.bitseekwin")
        self.assertEqual(manifest["name"], "BitSeekWin - BitChord-Soulseek Integration")
        self.assertRegex(server.VERSION, r"^\d+\.\d+\.\d+-pre-alpha\.\d+$")
        self.assertEqual(manifest["version"], server.VERSION)
        self.assertEqual(self.client.last_query, "drum kick")
        self.assertEqual(results["tracks"][0]["id"], self.track.id)
        self.assertEqual(results["tracks"][0]["audioQuality"], "LOSSLESS")

    def test_stream_returns_bitchord_file_url(self) -> None:
        self.get_json("/search?q=kick")
        descriptor = self.get_json(f"/stream/{self.track.id}")
        self.assertEqual(
            descriptor["url"],
            f"https://music.example.test/bitseekwin/test-secret/file/{self.track.id}",
        )
        self.assertEqual(descriptor["manifest"], "none")
        self.assertEqual(self.client.prepare_calls, 1)

    def test_file_supports_byte_ranges_and_head(self) -> None:
        self.get_json("/search?q=kick")
        request = Request(
            self.base + f"/file/{self.track.id}", headers={"Range": "bytes=2-5"}
        )
        with urlopen(request) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers["Content-Range"], "bytes 2-5/10")
            self.assertEqual(response.read(), b"2345")

        request = Request(self.base + f"/file/{self.track.id}", method="HEAD")
        with urlopen(request) as response:
            self.assertEqual(response.headers["Content-Length"], "10")
            self.assertEqual(response.read(), b"")

    def test_rejects_bad_ranges_and_unknown_track_ids(self) -> None:
        self.get_json("/search?q=kick")
        request = Request(
            self.base + f"/file/{self.track.id}", headers={"Range": "bytes=20-"}
        )
        with self.assertRaises(HTTPError) as error:
            urlopen(request)
        self.assertEqual(error.exception.code, 416)

        with self.assertRaises(HTTPError) as error:
            urlopen(self.base + "/stream/not-found")
        self.assertEqual(error.exception.code, 404)

    def test_filters_non_flac_and_unsafe_search_results(self) -> None:
        responses = [
            {
                "username": "sample-owner",
                "files": [
                    {"filename": "Drums/Kick.flac", "size": 20},
                    {"filename": "Drums/Kick.wav", "size": 20},
                    {"filename": "../outside.flac", "size": 20},
                ],
            }
        ]
        tracks = server.SlskdClient._tracks_from_responses(responses)
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0].filename, "Drums/Kick.flac")

    def test_slskd_search_uses_v0_api_and_api_key(self) -> None:
        search_id = str(uuid.uuid4())
        call_count = 0

        def fake_urlopen(request, timeout):
            nonlocal call_count
            call_count += 1
            self.assertEqual(request.headers["X-api-key"], "test-api-key")
            if request.get_method() == "POST":
                self.assertEqual(request.full_url, "http://slskd.test/api/v0/searches")
                body = json.loads(request.data)
                self.assertEqual(body["searchText"], "drum break")
                return FakeResponse({"id": search_id})
            if request.full_url.endswith(f"/searches/{search_id}"):
                return FakeResponse({"isComplete": True})
            return FakeResponse(
                [
                    {
                        "username": "sample-owner",
                        "files": [{"filename": "Drum Kit/Break.flac", "size": 42}],
                    }
                ]
            )

        client = server.SlskdClient(
            "http://slskd.test",
            "test-api-key",
            self.root,
            search_timeout=0,
        )
        with patch.object(server, "uuid") as uuid_mock:
            uuid_mock.uuid4.return_value = uuid.UUID(search_id)
            with patch.object(server, "urlopen", side_effect=fake_urlopen):
                results = client.search("drum break")
        self.assertEqual(call_count, 3)
        self.assertEqual(results[0].filename, "Drum Kit/Break.flac")

    def test_slskd_download_queues_one_file_and_waits_for_completion(self) -> None:
        batch_id = str(uuid.uuid4())
        self.audio_path.unlink()
        client = server.SlskdClient(
            "http://slskd.test",
            "test-api-key",
            self.root,
            download_timeout=1,
        )
        requests = []

        def fake_urlopen(request, timeout):
            requests.append(request)
            if request.get_method() == "POST":
                body = json.loads(request.data)
                self.assertEqual(body["username"], self.track.username)
                self.assertEqual(
                    body["files"], [{"filename": self.track.filename, "size": 10}]
                )
                self.assertEqual(
                    body["options"]["destination"], f"bitchord-cache/{self.track.id}"
                )
                return FakeResponse({"failures": []})
            path = client._download_path(self.track)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"0123456789")
            return FakeResponse(
                {
                    "transfers": [
                        {
                            "filename": self.track.filename,
                            "state": "Completed, Succeeded",
                        }
                    ]
                }
            )

        with patch.object(server.uuid, "uuid4", return_value=uuid.UUID(batch_id)):
            with patch.object(server, "urlopen", side_effect=fake_urlopen):
                prepared_path, prepared_batch = client.prepare_download(self.track)
                self.assertIsNone(prepared_path)
                self.assertEqual(prepared_batch, batch_id)
                path = client.download(self.track)
        self.assertTrue(path.is_file())
        self.assertEqual(len(requests), 2)

    def test_completed_cached_file_skips_slskd_queue(self) -> None:
        client = server.SlskdClient("http://slskd.test", "test-api-key", self.root)
        with patch.object(server, "urlopen") as request:
            path, batch_id = client.prepare_download(self.track)
        self.assertEqual(path, self.audio_path)
        self.assertIsNone(batch_id)
        request.assert_not_called()

    def test_faster_default_search_timeout(self) -> None:
        self.assertLessEqual(server.SEARCH_TIMEOUT, 2)


if __name__ == "__main__":
    unittest.main()
