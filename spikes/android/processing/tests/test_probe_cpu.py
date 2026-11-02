"""Real CPU probe test on the published golden fixture (needs the locked `cpu` group + pinned model)."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
MODEL = Path.home() / ".cache/mediapipe/hand_landmarker.task"
HAVE = (
    all(importlib.util.find_spec(m) for m in ("av", "mediapipe", "rerun", "numpy"))
    and MODEL.is_file()
)


@unittest.skipUnless(
    HAVE,
    "locked cpu group and pinned model required (uv sync --group cpu; ./fetch_model.sh)",
)
class ProbeCpuTest(unittest.TestCase):
    def test_golden_decodes_once_infers_every_frame_and_masks_absent_hands(self):
        import numpy as np
        import probe
        import strict_capture as sc

        src = sc.REPO / "packages/contracts/capture/golden/valid.mcap"
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "run"
            r = probe.process(src, out, model=MODEL, max_clip_seconds=2.0, expected_sha256=None,
                              max_source_bytes=sc.DEFAULT_MAX_SOURCE_BYTES, input_class="published_golden_fixture")  # fmt: skip
            self.assertEqual(r["status"], "passed")
            self.assertEqual(
                r["decode"]["decoded_source_frame_ids"], ["0", "1", "2", "4", "5"]
            )
            self.assertEqual(r["inference"]["frames"], 5)
            self.assertEqual(
                r["inference"]["hand_observations"], 0
            )  # colour-bar codec fixture, no hands
            self.assertFalse(r["inference"]["metric_accuracy_validated"])
            (clip,) = r["clips"]
            self.assertTrue(all(clip["mp4_independent_decode"].values()))
            z = np.load(out / "clip-000/hands.npz")
            self.assertEqual(z["image_landmarks_px"].shape, (5, 2, 21, 2))
            self.assertEqual(z["model_relative_landmarks_m"].shape, (5, 2, 21, 3))
            self.assertFalse(z["landmark_mask"].any())
            self.assertTrue(np.isnan(z["image_landmarks_px"]).all())
            rows = [
                json.loads(s)
                for s in (out / "clip-000/frame-map.jsonl").read_text().splitlines()
            ]
            self.assertEqual(
                [r["clip_pts"] for r in rows],
                ["0", "33333", "66666", "133332", "166665"],
            )
            self.assertLess(
                (out / "clip-000/viewer.rrd").stat().st_size, probe.MAX_RRD_BYTES
            )

    def test_rejected_source_writes_no_partial_success(self):
        import probe
        import strict_capture as sc

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "run"
            with self.assertRaises(sc.CaptureRejected):
                probe.process(sc.REPO / "packages/contracts/capture/golden/b_frame.mcap", out, model=MODEL,
                              max_clip_seconds=2.0, expected_sha256=None, max_source_bytes=sc.DEFAULT_MAX_SOURCE_BYTES,
                              input_class="published_golden_fixture")  # fmt: skip
            self.assertFalse((out / "receipt.json").exists())


if __name__ == "__main__":
    unittest.main()
