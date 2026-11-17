import hashlib
import json
import unittest
from pathlib import Path

from indexed_fixture import chunked
from test_mcap_stream import ForwardOnly

from stateaction_processing.capture_stream import (
    CaptureStream,
    CaptureStreamError,
    StreamLimits,
)
from stateaction_processing.mcap_stream import Limits

GOLDEN = Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden"
CASES = json.loads((GOLDEN / "cases.json").read_text())


def run(data: bytes, limits: StreamLimits | None = None):
    st = CaptureStream(ForwardOnly(data), limits)
    units = list(st)
    return st, units


def try_chunked(name: str, **kw):
    flat = (GOLDEN / f"{name}.mcap").read_bytes()
    return chunked(flat, **kw)


class CaptureStreamTests(unittest.TestCase):
    def test_valid_golden_identity_and_provisional_acceptance(self):
        data = chunked((GOLDEN / "valid.mcap").read_bytes())
        st = CaptureStream(ForwardOnly(data))
        self.assertFalse(st.accepted)
        units = list(st)
        self.assertTrue(st.accepted)
        self.assertEqual(st.report.source.sha256, hashlib.sha256(data).hexdigest())
        self.assertEqual(st.report.source.bytes_read, len(data))
        self.assertEqual(len(units), 5)
        self.assertEqual([u.sequence for u in units], [0, 1, 2, 3, 4])
        self.assertTrue(units[0].is_idr)
        # original identities and native clocks are preserved, never renumbered
        self.assertEqual(units[0].source_frame_id, "0")
        self.assertEqual(units[0].encoder_pts_us, 0)
        self.assertEqual(units[0].native_clock_id, "android.camera.sensor_timestamp")
        self.assertEqual(
            units[0].native_timestamps["metadata_sensor_timestamp_ns"], "1000000007"
        )
        self.assertEqual(units[0].capture_time_ns, "1800000000000000007")
        self.assertEqual(len(units[0].sensor_events), 1)
        self.assertEqual(units[0].sensor_events[0]["source_kind"], "arcore_pose")
        self.assertLessEqual(st.report.peak_pending_video, 2)
        self.assertEqual(st.report.frame_counts["dropped"], 1)

    def test_native_recorder_order_inventory_at_stop_is_accepted(self):
        import struct

        from indexed_fixture import build, flat_records

        header, recs = flat_records((GOLDEN / "valid.mcap").read_bytes())
        topics = {}
        for op, body in recs:
            if op == 4:
                n = struct.unpack_from("<I", body, 4)[0]
                topics[struct.unpack_from("<H", body)[0]] = body[8 : 8 + n].decode()
        inv = [
            r
            for r in recs
            if r[0] == 5
            and topics[struct.unpack_from("<H", r[1])[0]].endswith("inventory")
        ]
        rest = [r for r in recs if r not in inv]
        close_at = next(
            i
            for i, r in enumerate(rest)
            if r[0] == 5 and topics[struct.unpack_from("<H", r[1])[0]].endswith("close")
        )
        reordered = rest[:close_at] + inv + rest[close_at:]
        # Message log times are not required to be monotonic across topics; chunk index stays valid.
        data = build(header, reordered)
        st, units = run(data)
        self.assertTrue(st.accepted)
        self.assertEqual(len(units), 5)

    def test_unknown_calibration_is_rejected_at_inventory_resolution(self):
        from indexed_fixture import build, flat_records

        header, recs = flat_records((GOLDEN / "valid.mcap").read_bytes())
        out = []
        for op, body in recs:
            if op == 5 and b'"calibrations":[' in body:
                body = body.replace(
                    b'"calibration_id":"rgb_0"', b'"calibration_id":"rgb_7"', 1
                )
            out.append((op, body))
        with self.assertRaises(CaptureStreamError) as e:
            run(build(header, out))
        self.assertEqual(e.exception.code, "E_CALIBRATION_UNKNOWN")

    def test_corrupt_stream_never_reports_accepted(self):
        data = bytearray(chunked((GOLDEN / "valid.mcap").read_bytes()))
        data[-30] ^= 1
        st = CaptureStream(ForwardOnly(bytes(data)))
        with self.assertRaises(CaptureStreamError):
            list(st)
        self.assertFalse(st.accepted)

    def test_join_window_is_bounded(self):
        data = chunked((GOLDEN / "valid.mcap").read_bytes())
        with self.assertRaises(CaptureStreamError) as e:
            run(data, StreamLimits(max_join_window_ns=1))
        self.assertEqual(e.exception.code, "E_JOIN_WINDOW")
        with self.assertRaises(CaptureStreamError) as e:
            run(data, StreamLimits(max_inflight_frames=0))
        self.assertEqual(e.exception.code, "E_INFLIGHT_BOUND")
        with self.assertRaises(CaptureStreamError) as e:
            run(data, StreamLimits(max_pending_video=0))
        self.assertEqual(e.exception.code, "E_JOIN_WINDOW")

    def test_late_sensor_association_is_rejected(self):
        data = chunked((GOLDEN / "valid.mcap").read_bytes())
        with self.assertRaises(CaptureStreamError) as e:
            run(data, StreamLimits(sensor_hold_videos=0))
        self.assertEqual(e.exception.code, "E_SENSOR_ASSOCIATION_LATE")

    def test_oversized_access_unit_is_rejected(self):
        data = chunked((GOLDEN / "valid.mcap").read_bytes())
        with self.assertRaises(CaptureStreamError) as e:
            run(data, StreamLimits(max_access_unit_bytes=10))
        self.assertEqual(e.exception.code, "E_ACCESS_UNIT_BOUND")
        with self.assertRaises(CaptureStreamError) as e:
            run(data, StreamLimits(mcap=Limits(max_message_bytes=100)))
        self.assertEqual(e.exception.code, "E_STREAM_MESSAGE_BOUND")

    def test_published_golden_corpus_agrees_with_reference_outcome(self):
        """Every flat golden case, re-framed as indexed MCAP, gets the reference accept/reject."""
        # Container-level corruptions of the flat framing vanish when re-framed; the streaming
        # container tests cover those rules (CRC/footer/truncation) on chunked bytes directly.
        flat_only = {
            "data_crc_header_corrupt",
            "data_crc_payload_corrupt",
            "data_crc_zero",
            "footer_summary_offset",
            "truncated_before_footer",
            "truncated_mid_record",
        }
        checked, mismatches = 0, []
        for name, case in sorted(CASES.items()):
            path = GOLDEN / f"{name}.mcap"
            if not path.exists() or name in flat_only:
                continue
            try:
                data = chunked(path.read_bytes())
            except (
                ValueError,
                IndexError,
                KeyError,
                Exception,
            ):  # not a flat re-framable file
                continue
            checked += 1
            try:
                run(data)
                got = "accept"
            except CaptureStreamError as e:
                got = f"reject:{e.code}"
            want = case["expect"]
            if want == "accept":
                ok = got == "accept"
            elif want == "legacy_jpeg":
                ok = got == "reject:E_LEGACY_JPEG_UNSUPPORTED"
            else:
                ok = got.startswith("reject:")
            if not ok:
                mismatches.append((name, want, got))
        print(f"golden corpus: checked={checked} mismatches={len(mismatches)}")
        for m in mismatches:
            print("  MISMATCH", m)
        self.assertGreater(checked, 40)
        self.assertEqual(mismatches, [])


if __name__ == "__main__":
    unittest.main()
