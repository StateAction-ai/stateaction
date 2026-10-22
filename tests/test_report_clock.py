"""Native timestamp preservation and honest missing-wall-clock presentation."""

import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from report_clock import apply_report_clock, clock_provenance


class ReportClockTests(unittest.TestCase):
    def setUp(self):
        self.recording = {
            "start_time": 1453679.687118988, "end_time": 1453696.70243114,
            "start_iso": "1970-01-17T14:47:59", "end_iso": "1970-01-17T14:48:16",
            "weekday": "Saturday", "duration_s": 17.015312152,
        }
        self.metadata = {
            "android_version": "17 (API 37)",
            "session_start_timestamp_ns": 1453679687118988,
            "rgb_end_ns": 1453696519852215,
            "imu_end_ns": 1453696702431140,
            "storage": {"path": "/ar_sessions/session_20261021_210417"},
        }

    def test_1970_alone_does_not_classify_clock(self):
        self.assertIsNone(clock_provenance(self.recording, {}))

    def test_mismatched_native_bounds_fail_closed(self):
        self.metadata["imu_end_ns"] += 1_000_000_000
        with self.assertRaisesRegex(ValueError, "end_time"):
            clock_provenance(self.recording, self.metadata)

    def test_preserves_originals_all_sensor_values_and_repeat_output(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)
            metrics = {"recording": copy.deepcopy(self.recording), "health": {"score": 97},
                       "imu": {"timestamps": [1453679.862077649, 1453696.70243114]}}
            original_json = json.dumps(metrics).encode()
            original_html = (
                "<html><p class='filesub'>1970-01-17T14:47:59</p><table>"
                "<tr><th>Start (ISO)</th><td>1970-01-17T14:47:59</td></tr>"
                "<tr><th>End (ISO)</th><td>1970-01-17T14:48:16</td></tr>"
                "<tr><th>Weekday</th><td>Saturday</td></tr></table></html>"
            ).encode()
            (out / "evaluation_metrics.json").write_bytes(original_json)
            (out / "evaluation.html").write_bytes(original_html)
            meta = out / "metadata.json"
            meta.write_text(json.dumps(self.metadata))
            first = apply_report_clock(out, meta)
            second = apply_report_clock(out, meta)
            self.assertEqual(first, second)
            self.assertEqual((out / "evaluation_metrics.upstream.json").read_bytes(), original_json)
            self.assertEqual((out / "evaluation.upstream.html").read_bytes(), original_html)
            new = json.loads((out / "evaluation_metrics.json").read_text())
            self.assertEqual(new["imu"], metrics["imu"])
            self.assertEqual(new["health"], metrics["health"])
            for key in ("start_time", "end_time", "duration_s"):
                self.assertEqual(new["recording"][key], self.recording[key])
            self.assertIsNone(new["recording"]["start_iso"])
            clock = new["recording"]["clock"]
            self.assertIsNone(clock["wallclock_anchor"])
            self.assertIsNone(clock["utc_offset"])
            self.assertEqual(clock["session_name_local_clock_hint"], "2026-10-21T21:04:17")
            self.assertEqual(clock["elapsed_s"], 17.015312152)
            report = (out / "evaluation.html").read_text()
            self.assertNotIn("1970", report)
            self.assertIn("Not recorded — device uptime", report)
            self.assertIn("1453679687118988", report)
            self.assertIn("local hint", report)


if __name__ == "__main__":
    unittest.main()
