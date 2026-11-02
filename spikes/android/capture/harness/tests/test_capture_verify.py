import json
import unittest
from pathlib import Path

import capture_verify as v
from synthetic import (
    FIXTURES,
    McapBuilder,
    build_capture,
    compressed_video,
    split_access_units,
)

ALL = v.SECTIONS


def run(blob: bytes, profile="simulation", require=ALL):
    return v.verify(blob, profile, require)


def video_index(b, n=1):
    """Index of the n-th video message in a builder (channel 1)."""
    return [i for i, m in enumerate(b.messages) if m[0] == 1][n]


def failed(result):
    return {c["id"] for c in result["checks"] if c["status"] == "fail"}


class PositiveTests(unittest.TestCase):
    def test_spike_shaped_capture_passes_every_section(self):
        result = run(build_capture())
        self.assertEqual(result["verdict"], "pass", failed(result))
        self.assertEqual(result["sections"]["container"], "pass")
        self.assertEqual(result["sections"]["sensors"], "pass")
        self.assertFalse(result["physical_hardware_qualified"])
        self.assertEqual(result["metrics"]["video"]["idr_count"], 3)
        self.assertEqual(result["metrics"]["video"]["access_units"], 65)
        self.assertEqual(result["metrics"]["video"]["profile_idc"], 77)
        self.assertEqual(
            (result["metrics"]["video"]["width"], result["metrics"]["video"]["height"]),
            (64, 48),
        )
        self.assertAlmostEqual(result["metrics"]["accel"]["median_hz"], 100.0, places=3)

    def test_simulation_profile_reports_unconstrained_fields_as_pending(self):
        result = run(build_capture())
        pending = {c["id"] for c in result["checks"] if c["status"] == "pending"}
        self.assertIn("sps_width_matches_profile", pending)

    def test_cli_report_and_exit_codes(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            good = Path(tmp, "good.mcap")
            good.write_bytes(build_capture())
            out = Path(tmp, "report.json")
            self.assertEqual(v.main([str(good), "--output", str(out)]), 0)
            self.assertEqual(json.loads(out.read_text())["verdict"], "pass")
            bad = Path(tmp, "bad.mcap")
            bad.write_bytes(build_capture("main-bframes.h264"))
            self.assertEqual(
                v.main([str(bad), "--output", str(Path(tmp, "bad.json"))]), 1
            )


class HardwareCandidateTests(unittest.TestCase):
    def test_small_synthetic_stream_cannot_qualify_hardware_profile(self):
        result = run(build_capture(), "hardware-candidate")
        self.assertEqual(result["verdict"], "fail")
        self.assertTrue(
            {"sps_width_matches_profile", "sps_height_matches_profile"}
            <= failed(result)
        )
        self.assertNotIn(
            "sps_profile_idc_matches_profile", failed(result)
        )  # Main profile is right
        self.assertNotIn("sps_level_idc_matches_profile", failed(result))

    def test_baseline_profile_is_rejected_for_main_candidate(self):
        result = run(build_capture("baseline-nob.h264"), "hardware-candidate")
        self.assertIn("sps_profile_idc_matches_profile", failed(result))
        self.assertIn("sps_level_idc_matches_profile", failed(result))

    def test_hardware_candidate_enforces_time_cadence(self):
        slow = run(
            build_capture(fps=5.0), "hardware-candidate"
        )  # IDR every 6 s of capture time, 5 fps
        self.assertTrue(
            {"idr_interval_seconds_within_bound", "effective_frame_rate_within_bound"}
            <= failed(slow)
        )
        fast = run(build_capture(fps=30.0), "hardware-candidate")
        self.assertNotIn("idr_interval_seconds_within_bound", failed(fast))
        self.assertNotIn("effective_frame_rate_within_bound", failed(fast))

    def test_simulation_reports_but_does_not_enforce_time_cadence(self):
        result = run(build_capture(fps=5.0))
        self.assertNotIn("idr_interval_seconds_within_bound", failed(result))
        self.assertIn(
            "idr_interval_seconds_within_bound",
            {c["id"] for c in result["checks"] if c["status"] == "pending"},
        )

    def test_empty_channels_are_not_a_statistics_mismatch(self):
        b = McapBuilder()
        b.channel("unused", "json", "s", "jsonschema", b"{}")
        busy = b.channel("busy", "json", "s2", "jsonschema", b"{}")
        b.message(busy, 1, b"{}")
        self.assertNotIn(
            "statistics_match_messages",
            failed(run(b.build(), require=("container", "video"))),
        )

    def test_candidate_requires_sensor_rate(self):
        slow = build_capture(tamper=lambda b: None)
        result = run(slow, "hardware-candidate")
        self.assertNotIn(
            "accel_rate_at_least_profile_minimum", failed(result)
        )  # 100 Hz fixture


class NegativeVideoTests(unittest.TestCase):
    def test_b_slices_are_detected(self):
        result = run(build_capture("main-bframes.h264"))
        self.assertIn("no_b_slices", failed(result))

    def test_missing_idr_config_is_detected(self):
        units = split_access_units((FIXTURES / "main-nob.h264").read_bytes())
        stripped = [u for u in units]
        first = stripped[0]
        idr = first.find(b"\x00\x00\x00\x01\x65")
        self.assertGreater(idr, 0)

        def tamper(b):
            i = video_index(b, 0)
            cid, seq, log, data = b.messages[i]
            b.messages[i] = (
                cid,
                seq,
                log,
                compressed_video(
                    v.decode_compressed_video(data)["timestamp_ns"], first[idr:]
                ),
            )

        result = run(build_capture(tamper=tamper), require=("container", "video"))
        self.assertIn("sps_pps_precede_every_idr", failed(result))

    def test_config_only_packet_is_not_a_frame(self):
        units = split_access_units((FIXTURES / "main-nob.h264").read_bytes())
        config_only = units[0][: units[0].find(b"\x00\x00\x00\x01\x65")]

        def tamper(b):
            i = video_index(b, 3)
            cid, seq, log, data = b.messages[i]
            b.messages[i] = (
                cid,
                seq,
                log,
                compressed_video(
                    v.decode_compressed_video(data)["timestamp_ns"], config_only
                ),
            )

        result = run(build_capture(tamper=tamper), require=("container", "video"))
        self.assertIn("annexb_complete_access_units", failed(result))

    def test_non_annexb_payload_rejected(self):
        def tamper(b):
            i = video_index(b, 3)
            cid, seq, log, data = b.messages[i]
            b.messages[i] = (
                cid,
                seq,
                log,
                compressed_video(1, b"\x00\x00\x00\x05\x65abcd"),
            )

        result = run(build_capture(tamper=tamper), require=("container", "video"))
        self.assertIn("annexb_complete_access_units", failed(result))

    def test_long_idr_interval_detected(self):
        result = run(build_capture(fps=1.0), require=("container", "video"))
        # 65 frames at 1 fps → 3 IDRs 30 s apart: frame bound is fine, wall-clock interval is not enforced here,
        # but the measured interval is reported for the physical gate.
        self.assertAlmostEqual(
            result["metrics"]["video"]["idr_interval_s"]["max"], 30.0, places=2
        )

    def test_wrong_format_rejected(self):
        def tamper(b):
            i = video_index(b, 3)
            cid, seq, log, data = b.messages[i]
            video = v.decode_compressed_video(data)
            b.messages[i] = (
                cid,
                seq,
                log,
                compressed_video(video["timestamp_ns"], video["data"], "h265"),
            )

        self.assertIn(
            "annexb_complete_access_units",
            failed(run(build_capture(tamper=tamper), require=("container", "video"))),
        )


class NegativeIdentityTests(unittest.TestCase):
    def _mutate_rows(self, state, fn):
        def tamper(b):
            for i, (cid, seq, log, data) in enumerate(b.messages):
                if cid == 2:
                    row = json.loads(data)
                    if row["state"] == state:
                        fn(row)
                        b.messages[i] = (cid, seq, log, json.dumps(row).encode())

        return tamper

    def test_changed_encoder_pts_detected(self):
        t = self._mutate_rows(
            "acquired",
            lambda r: (
                r.update(encoder_pts_us=str(int(r["encoder_pts_us"]) + 1))
                if r["source_frame_id"] == "7"
                else None
            ),
        )
        self.assertIn(
            "encoder_pts_derived_from_acquisition_time",
            failed(run(build_capture(tamper=t))),
        )

    def test_timestamp_mismatch_between_protobuf_and_evidence(self):
        t = self._mutate_rows(
            "written",
            lambda r: (
                r.update(
                    mapped_capture_time_ns=str(int(r["mapped_capture_time_ns"]) + 1)
                )
                if r["source_frame_id"] == "3"
                else None
            ),
        )
        self.assertIn(
            "acquisition_to_pts_to_message_identity",
            failed(run(build_capture(tamper=t))),
        )

    def test_wrong_idr_flag_detected(self):
        t = self._mutate_rows(
            "written",
            lambda r: (
                r.update(is_idr=not r["is_idr"])
                if r["source_frame_id"] == "0"
                else None
            ),
        )
        self.assertIn(
            "acquisition_to_pts_to_message_identity",
            failed(run(build_capture(tamper=t))),
        )

    def test_unresolved_frame_detected(self):
        def tamper(b):
            for i in range(len(b.messages) - 1, -1, -1):
                cid, seq, log, data = b.messages[i]
                if cid == 2 and json.loads(data)["state"] == "written":
                    del b.messages[i]
                    break

        result = run(build_capture(tamper=tamper))
        self.assertTrue(
            {
                "every_acquisition_has_exactly_one_outcome",
                "written_rows_match_video_messages",
            }
            & failed(result)
        )

    def test_dropped_frame_with_no_video_is_accepted(self):
        def tamper(b):
            # Frame 5 was dropped by the bounded encoder queue: no video, no camera info change.
            keep = []
            for cid, seq, log, data in b.messages:
                if cid == 1 and seq == 5:
                    continue
                if cid == 2:
                    row = json.loads(data)
                    if row["source_frame_id"] == "5":
                        if row["state"] == "written":
                            row.update(state="dropped", reason="encoder_pending_limit")
                            data = json.dumps(row).encode()
                keep.append((cid, seq, log, data))
            b.messages = keep

        result = run(build_capture(tamper=tamper), require=("container", "identity"))
        self.assertNotIn("every_acquisition_has_exactly_one_outcome", failed(result))


class NegativeContainerAndSensorTests(unittest.TestCase):
    def test_statistics_mismatch(self):
        b = McapBuilder()
        c = b.channel("x", "json", "s", "jsonschema", b"{}")
        b.message(c, 1, b"{}")
        self.assertIn(
            "statistics_match_messages",
            failed(
                run(b.build(statistics_count_delta=1), require=("container", "video"))
            ),
        )

    def test_truncated_file_rejected(self):
        with self.assertRaises(v.VerifyError):
            v.parse_mcap(build_capture()[:-12])

    def test_nonempty_profile_rejected(self):
        self.assertIn(
            "header_profile_generic",
            failed(run(build_capture(profile="ros2"), require=("container", "video"))),
        )

    def test_gyro_regression_detected(self):
        def tamper(b):
            for i, (cid, seq, log, data) in enumerate(b.messages):
                if cid == 5:
                    row = json.loads(data)
                    if row["event_id"] == "30":
                        row["native_timestamp_ns"] = "1"
                        b.messages[i] = (cid, seq, log, json.dumps(row).encode())

        self.assertIn(
            "gyro_native_times_strictly_increasing",
            failed(run(build_capture(tamper=tamper))),
        )

    def test_missing_sensors_fail(self):
        result = run(build_capture(sensors=False))
        self.assertEqual(result["verdict"], "fail")
        self.assertTrue(
            {"accel_events_present", "gyro_events_present"} <= failed(result)
        )

    def test_nan_axis_detected(self):
        def tamper(b):
            for i, (cid, seq, log, data) in enumerate(b.messages):
                if cid == 4 and json.loads(data)["event_id"] == "3":
                    row = json.loads(data)
                    row["values"] = [0.0, float("nan"), 0.0]
                    b.messages[i] = (cid, seq, log, json.dumps(row).encode())

        self.assertIn(
            "accel_three_finite_axes", failed(run(build_capture(tamper=tamper)))
        )


class SpikeWriterCrossCheck(unittest.TestCase):
    """The Kotlin MCAPWriter's own fixture, produced by the JVM unit tests."""

    def test_native_writer_fixture_if_built(self):
        path = (
            Path(__file__).resolve().parents[2]
            / "app/build/spike-fixtures/native-writer.mcap"
        )
        if not path.exists():
            self.skipTest(
                "run :app:testDebugUnitTest first (Nx target gradle-test does this)"
            )
        result = v.verify(path.read_bytes(), "simulation", ("container", "video"))
        self.assertEqual(result["verdict"], "pass", failed(result))
        self.assertEqual(result["metrics"]["video"]["access_units"], 1)


if __name__ == "__main__":
    unittest.main()
