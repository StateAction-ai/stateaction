"""SA-86: fixture store manifest/verify and caption-row rules. Synthetic data only."""

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def load_store():
    sys.path.insert(0, str(TOOLS))
    try:
        import fixture_store

        return fixture_store
    finally:
        sys.path.remove(str(TOOLS))


class FixtureStoreTests(unittest.TestCase):
    def setUp(self):
        self.fs = load_store()
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Path(self.tmp.name)
        # tiny synthetic stand-ins; the pinned HomER sha256 are swapped for the stand-in hashes
        self.orig = self.fs.EPISODES
        self.fs.EPISODES = {}
        for ep in ("ep_a", "ep_b"):
            d = self.store / ep
            (d / "flora").mkdir(parents=True)
            video = f"video {ep}".encode()
            (d / "source.mp4").write_bytes(video)
            (d / "source.mcap").write_bytes(b"mcap " + video)
            sha = hashlib.sha256(video).hexdigest()
            self.fs.EPISODES[ep] = {"sha256": sha, "frames": 1, "duration_s": 1.0}
            (d / "flora/segments.json").write_text(
                json.dumps({"segments": [{"id": 0}, {"id": 1}]})
            )
            (d / "flora/windows.jsonl").write_text("{}\n")
            (d / "flora/env.json").write_text("{}")
            self.write_captions(
                ep, [self.row(0, "complete", "a caption"), self.row(1, "failed")]
            )

    def tearDown(self):
        self.fs.EPISODES = self.orig
        self.tmp.cleanup()

    @staticmethod
    def row(i, status, caption=None):
        r = {"segment_id": i, "start_s": 0.0, "end_s": 1.0, "status": status}
        if caption is not None:
            r["caption"] = caption
        return r

    def write_captions(self, ep, rows):
        doc = {"source_sha256": self.fs.EPISODES[ep]["sha256"], "captions": rows}
        (self.store / ep / "flora/captions.json").write_text(json.dumps(doc))

    def run_cmd(self, *args):
        with (
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            return self.fs.main(["--store", str(self.store), *args])

    def test_manifest_then_verify_passes_and_detects_tampering(self):
        self.assertEqual(self.run_cmd("manifest"), 0)
        doc = json.loads((self.store / "MANIFEST.json").read_text())
        paths = {f["path"] for f in doc["files"]}
        self.assertIn("ep_a/source.mp4", paths)
        self.assertIn("ep_b/flora/captions.json", paths)
        self.assertTrue(
            all(
                {"sha256", "bytes", "source", "provenance"} <= set(f)
                for f in doc["files"]
            )
        )
        self.assertEqual(self.run_cmd("verify"), 0)
        (self.store / "ep_a/source.mcap").write_bytes(b"changed")
        self.assertEqual(self.run_cmd("verify"), 1)

    def test_verify_rejects_unlisted_file_and_missing_manifest(self):
        self.assertEqual(self.run_cmd("verify"), 1)
        self.run_cmd("manifest")
        (self.store / "ep_a/extra.bin").write_bytes(b"x")
        self.assertEqual(self.run_cmd("verify"), 1)

    def test_verify_rejects_a_source_that_is_not_the_pinned_one(self):
        self.run_cmd("manifest")
        self.fs.EPISODES["ep_a"]["sha256"] = "0" * 64
        self.assertEqual(self.run_cmd("verify"), 1)

    def test_caption_rules(self):
        cases = {
            "complete row without text": [
                self.row(0, "complete"),
                self.row(1, "failed"),
            ],
            "failed row carries text": [
                self.row(0, "complete", "t"),
                self.row(1, "failed", ""),
            ],
            "empty complete text": [
                self.row(0, "complete", "  "),
                self.row(1, "failed"),
            ],
            "missing row": [self.row(0, "complete", "t")],
            "row without status": [self.row(0, "complete", "t"), {"segment_id": 1}],
        }
        for name, rows in cases.items():
            with self.subTest(name):
                self.write_captions("ep_a", rows)
                self.assertTrue(self.fs.check_captions(self.store), name)
        self.write_captions(
            "ep_a",
            [self.row(0, "complete", "t"), self.row(1, "unsupported_target_frames")],
        )
        self.assertEqual(self.fs.check_captions(self.store), [])


if __name__ == "__main__":
    unittest.main()
