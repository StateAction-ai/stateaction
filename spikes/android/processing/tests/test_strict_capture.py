"""Stdlib-only tests for the SA-61 strict gate/timeline adapter against the published SA-50 corpus."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import strict_capture as sc  # noqa: E402

GOLDEN = sc.REPO / "packages/contracts/capture/golden"
CASES = json.loads((GOLDEN / "cases.json").read_text())


class StrictGateTest(unittest.TestCase):
    def test_valid_golden_joins_reader_facts_exactly(self):
        cap = sc.load(GOLDEN / "valid.mcap", expected_sha256=CASES["valid"]["sha256"])
        facts = json.loads((GOLDEN / "expected/valid.json").read_text())["facts"][
            "video"
        ]
        self.assertEqual(len(cap.access_units), 5)
        for unit, fact in zip(cap.access_units, facts, strict=True):
            self.assertEqual(unit.source_frame_id, fact["source_frame_id"])
            self.assertEqual(str(unit.encoder_pts_us), fact["encoder_pts_us"])
            self.assertEqual(unit.sha256, fact["sha256"])
            self.assertEqual(unit.sequence, fact["sequence"])
            self.assertEqual(unit.capture_time_ns, fact["capture_time_ns"])
        # The dropped acquisition (source frame 3) is not invented: ids skip it.
        self.assertEqual(
            [u.source_frame_id for u in cap.access_units], ["0", "1", "2", "4", "5"]
        )
        self.assertEqual(cap.access_units[0].nal_types[:2], [7, 8])

    def test_every_accepted_golden_case_passes_and_every_other_is_rejected(self):
        for name, case in CASES.items():
            with self.subTest(case=name):
                path = GOLDEN / f"{name}.mcap"
                if case["expect"] == "accept":
                    self.assertTrue(sc.load(path).access_units)
                else:
                    with self.assertRaises(sc.CaptureRejected) as err:
                        sc.load(path)
                    self.assertEqual(err.exception.code, "E_CAPTURE_NOT_ACCEPTED")
                    self.assertEqual(
                        sorted(err.exception.detail["errors"]),
                        sorted(case["expected_errors"]),
                    )

    def test_source_bound_and_hash_are_enforced(self):
        with self.assertRaises(sc.CaptureRejected) as err:
            sc.load(GOLDEN / "valid.mcap", max_bytes=1024)
        self.assertEqual(err.exception.code, "E_SOURCE_TOO_LARGE")
        with self.assertRaises(sc.CaptureRejected) as err:
            sc.load(GOLDEN / "valid.mcap", expected_sha256="0" * 64)
        self.assertEqual(err.exception.code, "E_SOURCE_HASH_MISMATCH")

    def test_truncated_copy_is_rejected(self):
        data = (GOLDEN / "valid.mcap").read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.mcap"
            path.write_bytes(data[:-40])
            with self.assertRaises(sc.CaptureRejected) as err:
                sc.load(path)
            self.assertIn("E_TRUNCATED", err.exception.detail["errors"])


class ClipPlanTest(unittest.TestCase):
    def units(self, pts_idr):
        base = sc.load(GOLDEN / "valid.mcap").access_units[0]
        return [
            replace(base, index=i, encoder_pts_us=p, idr=idr, source_frame_id=str(i))
            for i, (p, idr) in enumerate(pts_idr)
        ]

    def test_clips_start_only_on_idr_and_keep_exact_relative_pts(self):
        units = self.units(
            [
                (1000, True),
                (34333, False),
                (1_001_000, True),
                (1_034_333, False),
                (2_500_000, True),
            ]
        )
        clips = sc.plan_clips(units, 1_000_000)
        self.assertEqual(
            [[u.source_frame_id for u in c] for c in clips],
            [["0", "1"], ["2", "3"], ["4"]],
        )
        self.assertEqual([sc.clip_pts(u, clips[1]) for u in clips[1]], [0, 33_333])

    def test_long_gop_is_never_cut_mid_gop(self):
        units = self.units(
            [(0, True), (900_000, False), (1_800_000, False), (2_000_000, True)]
        )
        clips = sc.plan_clips(units, 1_000_000)
        self.assertEqual([len(c) for c in clips], [3, 1])

    def test_first_non_idr_is_rejected(self):
        with self.assertRaises(sc.CaptureRejected):
            sc.plan_clips(self.units([(0, False), (1, True)]), 1_000_000)


if __name__ == "__main__":
    unittest.main()
