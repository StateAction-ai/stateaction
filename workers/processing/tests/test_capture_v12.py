import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from indexed_fixture import build, chunked, flat_records
from test_jpeg_stream import capture as jpeg_capture
from test_mcap_stream import ForwardOnly

from stateaction_processing.capture_stream import (
    CaptureStream,
    CaptureStreamError,
    StreamLimits,
)
from stateaction_processing.frames import FrameStream
from stateaction_processing.h264_decode import DecodeError
from stateaction_processing.mcap_stream import Limits
from stateaction_processing.stage_media import StageMediaError, remux_source

GOLDEN = Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden"
V12 = GOLDEN / "v1.2"
REV12 = "stateaction.capture.v1.2"


def indexed(name: str, **kwargs):
    return chunked((V12 / f"v12_{name}.mcap").read_bytes(), **kwargs)


class CaptureV12Tests(unittest.TestCase):
    def test_dispatch_and_whole_source_hash(self):
        for data, revision in (
            (chunked((GOLDEN / "valid.mcap").read_bytes()), "stateaction.capture.v1.1"),
            (indexed("valid_calibration_only"), REV12),
        ):
            with self.subTest(revision=revision):
                st = CaptureStream(ForwardOnly(data), expected_profile="h264_mcap_v1")
                units = iter(st)
                first = next(units)
                self.assertFalse(st.accepted)
                self.assertFalse(st.report.auto_admissible)
                self.assertEqual(first.source_frame_id, "0")
                self.assertEqual(first.native_timestamp_ns, "1000000007")
                self.assertEqual(
                    first.clock_mapping_revision, "android_elapsed_to_unix_v1"
                )
                self.assertEqual(first.calibration_id, "rgb_0")
                list(units)
                self.assertTrue(st.report.auto_admissible)
                self.assertEqual(st.report.wire_contract_revision, revision)
                self.assertEqual(
                    st.report.source.sha256, hashlib.sha256(data).hexdigest()
                )
                self.assertEqual(st.report.source.bytes_read, len(data))
                self.assertLessEqual(st.report.source.max_read_bytes, 1024 * 1024)

    def test_complete_golden_corpus(self):
        cases = json.loads((V12 / "cases.json").read_text())
        for name, case in sorted(cases.items()):
            with self.subTest(golden=name):
                data = chunked((V12 / f"{name}.mcap").read_bytes())
                st = CaptureStream(ForwardOnly(data))
                if case["expect"] == "reject":
                    with self.assertRaises(CaptureStreamError):
                        list(st)
                    self.assertFalse(st.accepted)
                else:
                    for _ in st:
                        pass
                    self.assertTrue(st.accepted)
                    facts = json.loads((V12 / "expected" / f"{name}.json").read_text())[
                        "facts"
                    ]
                    self.assertEqual(
                        st.report.auto_admissible, facts["auto_admissible"]
                    )

                    self.assertEqual(
                        st.report.native_evidence_counts,
                        {
                            "calibrations": len(facts["calibrations"]),
                            "camera_metadata": facts["camera_metadata_count"],
                            "depth_raw": facts["depth_streams"]
                            .get("depth_raw", {})
                            .get("events", 0),
                            "depth_dense": facts["depth_streams"]
                            .get("depth_dense", {})
                            .get("events", 0),
                            "depth_raw_confidence": sum(
                                d["confidence_state"] == "separate_image"
                                for d in facts["depth"]
                            ),
                        },
                    )

    def test_shared_declarations_may_precede_profile_channel(self):
        for path in (GOLDEN / "valid.mcap", V12 / "v12_valid_calibration_only.mcap"):
            with self.subTest(golden=path.stem):
                header, records = flat_records(path.read_bytes())
                channels = {
                    body[8 : 8 + int.from_bytes(body[4:8], "little")]: body[:2]
                    for opcode, body in records
                    if opcode == 4
                }
                profile_id = channels[b"/stateaction/capture_profile"]
                inventory_id = channels[b"/stateaction/inventory"]
                profile = [
                    r for r in records if r[0] in (4, 5) and r[1][:2] == profile_id
                ]
                remaining = [r for r in records if r not in profile]
                after_inventory = next(
                    i + 1
                    for i, (opcode, body) in enumerate(remaining)
                    if opcode == 5 and body[:2] == inventory_id
                )
                remaining[after_inventory:after_inventory] = profile
                stream = FrameStream(ForwardOnly(build(header, remaining)))
                self.assertEqual(len(list(stream)), 5)
                self.assertTrue(stream.require_accepted().auto_admissible)

    def test_calibration_raster_must_match_video_without_profile_width(self):
        header, records = flat_records(
            (V12 / "v12_valid_calibration_only.mcap").read_bytes()
        )
        for i, (opcode, body) in enumerate(records):
            if opcode != 5 or body[22:23] != b"{":
                continue
            value = json.loads(body[22:])
            if "encoder" in value:
                del value["encoder"]["width"]
            elif "source_to_saved" in value:
                value["saved_width"] = value["source_to_saved"]["scaled_width"] = 128
                value["source_to_saved"]["matrix"][:3] = [0.2, 0, -0.4]
                value["K"][:3] = value["P"][:3] = [96, 0, 63.6]
            else:
                continue
            records[i] = (opcode, body[:22] + json.dumps(value).encode())
        data = build(header, records)
        with self.assertRaisesRegex(DecodeError, "^E_RASTER_MISMATCH"):
            list(FrameStream(ForwardOnly(data)))
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaisesRegex(StageMediaError, "^calibration_raster_mismatch"),
        ):
            remux_source(ForwardOnly(data), Path(directory) / "video.mp4")

    def test_checked_before_acceptance(self):
        data = indexed("valid_calibration_only")
        for payload, limits, code in (
            (data + b"x", None, "E_STREAM_TRAILING_DATA"),
            (
                data,
                StreamLimits(mcap=Limits(max_source_bytes=len(data) - 1)),
                "E_SOURCE_TOO_LARGE",
            ),
            (
                indexed("valid_calibration_only", compression="zstd"),
                None,
                "E_STREAM_UNSUPPORTED_COMPRESSION",
            ),
            (
                indexed("valid_calibration_only", compression="lz4"),
                None,
                "E_STREAM_UNSUPPORTED_COMPRESSION",
            ),
            (
                indexed("valid_calibration_only", attachment=True),
                None,
                "E_STREAM_UNSUPPORTED_RECORD",
            ),
            (jpeg_capture(profile=""), None, "E_LEGACY_JPEG_UNSUPPORTED"),
            (jpeg_capture(), None, "E_PROFILE_NOT_EMPTY"),
            (data, StreamLimits(mcap=Limits(max_chunks=1)), "E_STREAM_CHUNK_LIMIT"),
            (
                indexed("rawimage_epoch_zero"),
                StreamLimits(max_pending_sensor_events=0),
                "E_SENSOR_BOUND",
            ),
        ):
            with self.subTest(code=code):
                st = CaptureStream(ForwardOnly(payload), limits)
                with self.assertRaisesRegex(CaptureStreamError, f"^{code}\\b"):
                    list(st)
                self.assertFalse(st.accepted)

    def test_frame_mapping_revision_must_match_clocks(self):
        header, records = flat_records(
            (V12 / "v12_valid_calibration_only.mcap").read_bytes()
        )
        changed = []
        for opcode, body in records:
            if opcode == 5 and body[22:23] == b"{" and b'"encoder_pts_us"' in body:
                value = json.loads(body[22:])
                value["clock_mapping_revision"] = "other_revision_v1"
                body = body[:22] + json.dumps(value).encode()
            changed.append((opcode, body))
        stream = CaptureStream(ForwardOnly(build(header, changed)))
        with self.assertRaisesRegex(CaptureStreamError, "^E_CLOCK_MISMATCH"):
            list(stream)
        self.assertFalse(stream.accepted)

    def test_interleaved_written_events_keep_video_order(self):
        header, records = flat_records(
            (V12 / "v12_valid_calibration_only.mcap").read_bytes()
        )
        written = []
        for index, (opcode, body) in enumerate(records):
            if opcode == 5 and body[22:23] == b"{":
                value = json.loads(body[22:])
                if value.get("state") == "written" and "output_sequence" in value:
                    written.append(index)
        first, second = written[:2]
        records.insert(second, records.pop(first))
        stream = FrameStream(ForwardOnly(build(header, records)))
        frames = list(stream)
        stream.require_accepted()
        self.assertEqual(
            [frame.access_unit.sequence for frame in frames], list(range(5))
        )
        self.assertEqual(
            [frame.access_unit.source_frame_id for frame in frames],
            ["0", "1", "2", "4", "5"],
        )

    def test_noncompleted_capture_is_rejected_at_publication_boundary(self):
        for name in ("aborted_low_storage_clean", "failed_encoder_error"):
            with self.subTest(name=name):
                stream = FrameStream(ForwardOnly(indexed(name)))
                for _ in stream:
                    pass
                self.assertTrue(stream.capture.accepted)
                self.assertFalse(stream.accepted)
                with self.assertRaisesRegex(
                    CaptureStreamError, "^E_OUTCOME_NOT_ADMISSIBLE"
                ):
                    stream.require_accepted()

    def test_stage_remux_uses_the_same_publication_rule(self):
        data = indexed("valid_calibration_only")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "video.mp4"
            frames = remux_source(
                ForwardOnly(data), path, expected_profile="h264_mcap_v1"
            )
            self.assertEqual(frames.source_sha256, hashlib.sha256(data).hexdigest())
            self.assertEqual(frames.frame_ids, ["0", "1", "2", "4", "5"])
            self.assertEqual(frames.clock_domain, "android.camera.sensor_timestamp")
            with self.assertRaisesRegex(
                CaptureStreamError, "^E_OUTCOME_NOT_ADMISSIBLE"
            ):
                remux_source(ForwardOnly(indexed("aborted_low_storage_clean")), path)


if __name__ == "__main__":
    unittest.main()
