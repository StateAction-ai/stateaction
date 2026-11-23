import hashlib
import tempfile
import unittest
from pathlib import Path

from indexed_fixture import chunked
from test_artifacts import GOLDEN, HAVE_MODEL, context
from test_mcap_stream import ForwardOnly

DEPTH_GOLDEN = "v12_depth_raw_unknown_mapping_reprojected"


def golden(name):
    return chunked((GOLDEN / "v1.2" / f"{name}.mcap").read_bytes())


@unittest.skipUnless(HAVE_MODEL, "pinned MediaPipe model not in local cache")
class CaptureV12ArtifactTests(unittest.TestCase):
    def test_v12_export_preserves_frame_mapping_and_preview_allowlist(self):
        from rerun.chunk import RrdReader

        from stateaction_processing import (
            artifact_export,
            artifact_reader,
            artifact_types,
        )

        data = golden(DEPTH_GOLDEN)
        expected_sha = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "out"
            artifact_export.export_artifacts(
                ForwardOnly(data),
                artifact_types.LocalDirectorySink(root),
                context(expected_source_sha256=expected_sha),
            )

            result = artifact_reader.open_result(root, require_contracts=True)
            self.assertEqual(
                result.provenance["verified_sources"][0]["sha256"], expected_sha
            )
            checks = {check["code"]: check for check in result.manifest["checks"]}
            self.assertEqual(
                checks["capture_native_evidence_counts"]["measurements"],
                {
                    "calibrations": "1",
                    "camera_metadata": "0",
                    "depth_dense": "0",
                    "depth_raw": "4",
                    "depth_raw_confidence": "3",
                },
            )
            self.assertCountEqual(
                [output["role"] for output in result.manifest["outputs"]],
                artifact_types.ROLE_BY_KEY.values(),
            )
            (clip,) = result.clips
            rows = clip.frame_map()
            source_frames = [0, 1, 2, 4, 5]
            self.assertEqual(
                [row["source_frame_id"] for row in rows], list(map(str, source_frames))
            )
            self.assertEqual(
                [row["timestamp_ns"] for row in rows],
                [str(1_000_000_007 + frame * 33_333_333) for frame in source_frames],
            )
            self.assertEqual(
                {row["clock_domain"] for row in rows},
                {"android.camera.sensor_timestamp"},
            )
            self.assertEqual(clip.verify_roundtrip()["frames"], len(source_frames))

            reader = RrdReader(root / "clips/000/viewer.rrd")
            samples = []
            allowed = {
                "/__properties": {"RecordingInfo:start_time"},
                "/rgb": {
                    "VideoStream:codec",
                    "VideoStream:is_keyframe",
                    "VideoStream:sample",
                },
                "/rgb/hands/hand0": {"Clear:is_recursive"},
                "/rgb/hands/hand1": {"Clear:is_recursive"},
                "/model_relative_3d/hand0": {"Clear:is_recursive"},
                "/model_relative_3d/hand1": {"Clear:is_recursive"},
                "/notes/model_relative_3d": {"TextDocument:text"},
            }
            for chunk in reader.stream():
                self.assertIn(chunk.entity_path, allowed)
                batch = chunk.to_record_batch()
                components = set(batch.schema.names).difference(
                    chunk.timeline_names, {"rerun.controls.RowId"}
                )
                self.assertLessEqual(components, allowed[chunk.entity_path])
                if chunk.entity_path == "/rgb" and not chunk.is_static:
                    samples.extend(
                        zip(
                            batch["source_frame"].to_pylist(),
                            batch["clip_time"].cast("int64").to_pylist(),
                            strict=True,
                        )
                    )
            self.assertEqual(
                sorted(samples),
                [(frame, frame * 33_333_000) for frame in source_frames],
            )

    def test_non_publishable_v12_sources_leave_no_result(self):
        from stateaction_processing import artifact_export, artifact_types
        from stateaction_processing.capture_stream import CaptureStreamError

        for name, sha, error, code in (
            (
                DEPTH_GOLDEN,
                "0" * 64,
                artifact_types.ExportError,
                "E_SOURCE_SHA_MISMATCH",
            ),
            (
                "v12_aborted_low_storage_clean",
                None,
                CaptureStreamError,
                "E_OUTCOME_NOT_ADMISSIBLE",
            ),
            (
                "v12_failed_encoder_error",
                None,
                CaptureStreamError,
                "E_OUTCOME_NOT_ADMISSIBLE",
            ),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                data = golden(name)
                root = Path(directory) / "out"
                with self.assertRaises(error) as failure:
                    artifact_export.export_artifacts(
                        ForwardOnly(data),
                        artifact_types.LocalDirectorySink(root),
                        context(
                            expected_source_sha256=sha
                            or hashlib.sha256(data).hexdigest()
                        ),
                    )
                self.assertEqual(failure.exception.code, code)
                self.assertFalse(any(path.is_file() for path in root.rglob("*")))
