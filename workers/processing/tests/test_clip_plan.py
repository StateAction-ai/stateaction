"""Prepare a passthrough plan from the committed capture with a dropped frame."""

import hashlib
import io
import tempfile
import unittest
from pathlib import Path

import av
from indexed_fixture import chunked
from stage_helpers import GOLDEN_MCAP, MANIFEST_SHA, RECORDING
from stateaction_contracts import validate_value

from stateaction_processing.clip_plan import prepare_passthrough
from stateaction_processing.frames import FrameStream
from stateaction_processing.source_range import SourceRange
from stateaction_processing.stage_media import StageMediaError, remux_source


class ClipPlanTests(unittest.TestCase):
    def test_whole_recording_preserves_native_identity(self):
        source = chunked(GOLDEN_MCAP.read_bytes())
        with tempfile.TemporaryDirectory() as scratch, io.BytesIO(source) as raw:
            mp4 = Path(scratch) / "recording.mp4"
            plan = prepare_passthrough(
                raw,
                mp4,
                recording_id=RECORDING,
                plan_version=1,
                source_manifest_sha256=MANIFEST_SHA,
                expected_source_sha256=hashlib.sha256(source).hexdigest(),
            )
            self.assertTrue(validate_value("artifacts.clip-plan.v1", plan).valid)
            self.assertEqual(plan["frame_count"], 5)
            self.assertEqual(plan["mode"], "passthrough")
            (span,) = plan["spans"]
            self.assertEqual((span["start_ordinal"], span["end_ordinal"]), (0, 5))
            self.assertEqual(
                (span["first_source_frame_id"], span["last_source_frame_id"]),
                ("0", "5"),
            )
            self.assertEqual(span["start_ts_ns"], plan["origin_ts_ns"])
            self.assertGreater(int(plan["origin_ts_ns"]), 0)
            with av.open(str(mp4)) as container:
                self.assertEqual(len(list(container.decode(video=0))), 5)

    def test_mismatched_source_digest_publishes_no_mp4(self):
        source = chunked(GOLDEN_MCAP.read_bytes())
        with tempfile.TemporaryDirectory() as scratch, io.BytesIO(source) as raw:
            mp4 = Path(scratch) / "recording.mp4"
            with self.assertRaisesRegex(StageMediaError, "source_digest_mismatch"):
                prepare_passthrough(
                    raw,
                    mp4,
                    recording_id=RECORDING,
                    plan_version=1,
                    source_manifest_sha256=MANIFEST_SHA,
                    expected_source_sha256="0" * 64,
                )
            self.assertFalse(mp4.exists())

    def test_native_slice_decodes_preroll_without_exposing_it(self):
        source = chunked(GOLDEN_MCAP.read_bytes())
        with tempfile.TemporaryDirectory() as scratch:
            full_path = Path(scratch) / "full.mp4"
            clip_path = Path(scratch) / "clip.mp4"
            full = remux_source(io.BytesIO(source), full_path)
            clip = remux_source(
                io.BytesIO(source), clip_path, source_range=SourceRange(2, 4)
            )
            self.assertEqual(clip.frame_ids, ["2", "4"])
            self.assertEqual(clip.timestamps_ns, full.timestamps_ns[2:4])
            self.assertEqual(clip.pts_us, [0, full.pts_us[3] - full.pts_us[2]])
            self.assertEqual(clip.source_sha256, full.source_sha256)
            with av.open(str(clip_path)) as container:
                self.assertEqual(
                    [
                        packet.is_discard
                        for packet in container.demux(video=0)
                        if packet.size
                    ],
                    [True, True, False, False],
                )
            with av.open(str(clip_path)) as container:
                actual = [
                    frame.to_ndarray().tobytes() for frame in container.decode(video=0)
                ]
            with av.open(str(full_path)) as container:
                expected = [
                    frame.to_ndarray().tobytes() for frame in container.decode(video=0)
                ]
            self.assertEqual(actual, expected[2:4])

    def test_native_slice_rejects_an_end_beyond_the_source(self):
        source = chunked(GOLDEN_MCAP.read_bytes())
        with tempfile.TemporaryDirectory() as scratch:
            with self.assertRaisesRegex(StageMediaError, "clip_range_not_in_source"):
                remux_source(
                    io.BytesIO(source),
                    Path(scratch) / "clip.mp4",
                    source_range=SourceRange(2, 6),
                )

    def test_hand_reader_decodes_only_clip_and_required_context(self):
        source = chunked(GOLDEN_MCAP.read_bytes())
        expected = list(FrameStream(io.BytesIO(source)))[2:4]
        stream = FrameStream(io.BytesIO(source), source_range=SourceRange(2, 4))
        actual = list(stream)
        report = stream.require_accepted()
        self.assertEqual(report.video_messages, 5)
        self.assertEqual(stream.decode_stats.frames_out, 4)
        self.assertEqual([f.access_unit.source_frame_id for f in actual], ["2", "4"])
        self.assertEqual(
            [f.rgb.tobytes() for f in actual], [f.rgb.tobytes() for f in expected]
        )
