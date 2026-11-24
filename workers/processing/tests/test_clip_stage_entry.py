"""The segment and caption entry points use the admitted clip range."""

import json
import tempfile
import unittest
from pathlib import Path

from stage_helpers import recipe, write_io_dir
from test_stage_entry import run_dir


def pin_clip(directory: Path, *, first_id: str = "2") -> None:
    path = directory / "bootstrap.json"
    boot = json.loads(path.read_bytes())
    boot["taskInput"].update(
        schemaVersion=4,
        clip={
            "id": "ad30fea5-011b-4cb1-9820-f076c0401e6a",
            "planVersion": 1,
            "planSha256": "a" * 64,
            "sourceRange": {
                "kind": "clip",
                "start_ordinal": 2,
                "end_ordinal": 4,
                "first_source_frame_id": first_id,
                "last_source_frame_id": "4",
                "start_ts_ns": "1066666673",
                "end_ts_ns": "1133333339",
            },
        },
    )
    path.write_text(json.dumps(boot))


class ClipStageEntryTests(unittest.TestCase):
    def test_segment_and_caption_keep_source_indices(self):
        rec = recipe(segment_params={"segment_s": "0.07"})
        with (
            tempfile.TemporaryDirectory() as segment,
            tempfile.TemporaryDirectory() as caption,
        ):
            segment_dir, caption_dir = Path(segment), Path(caption)
            write_io_dir(segment_dir, "segment", rec)
            pin_clip(segment_dir)
            code, receipt = run_dir(segment_dir)
            self.assertEqual(code, 0, receipt)
            self.assertEqual(receipt["counts"]["frames"], 2)
            segments = (segment_dir / "segments.json").read_bytes()
            segment_doc = json.loads(segments)
            self.assertEqual(segment_doc["rows"][0]["start"]["source_frame_id"], "2")
            write_io_dir(caption_dir, "caption", rec, segments_bytes=segments)
            pin_clip(caption_dir)
            code, receipt = run_dir(caption_dir)
            self.assertEqual(code, 0, receipt)
            self.assertIn("remux done frames=2", (caption_dir / "log.txt").read_text())
            captions = json.loads((caption_dir / "captions.json").read_bytes())
            self.assertEqual(
                captions["rows"][0]["segment_id"], segment_doc["rows"][0]["segment_id"]
            )

    def test_reject_clip_whose_edge_does_not_match_the_source(self):
        with tempfile.TemporaryDirectory() as path:
            directory = Path(path)
            write_io_dir(directory, "segment", recipe())
            pin_clip(directory, first_id="1")
            code, receipt = run_dir(directory)
            self.assertNotEqual(code, 0)
            self.assertEqual(receipt["errorCode"], "clip_source_mismatch")
            self.assertFalse((directory / "segments.json").exists())
