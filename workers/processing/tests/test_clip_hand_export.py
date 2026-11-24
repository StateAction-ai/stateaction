"""Exercise the real CPU exporter over a non-IDR clip boundary."""

import hashlib
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import av
from indexed_fixture import chunked
from stage_helpers import GOLDEN_MCAP, JOB, MANIFEST_SHA, RECORDING, recipe, task_input
from test_clip_stage_entry import pin_clip
from test_hands import result
from test_inline_qc import FakeEngine

from stateaction_processing import artifact_export
from stateaction_processing.artifact_seal import plan_from_task
from stateaction_processing.artifact_types import (
    Attestation,
    ExportContext,
    LocalDirectorySink,
)


class ClipHandExportTests(unittest.TestCase):
    def test_preroll_is_decoded_but_excluded_from_inference_and_outputs(self):
        source = chunked(GOLDEN_MCAP.read_bytes())
        ctx = ExportContext(
            job_id=JOB,
            recording_id=RECORDING,
            source_file_id="44444444-4444-4444-8444-444444444444",
            source_manifest_sha256=MANIFEST_SHA,
            expected_source_sha256=hashlib.sha256(source).hexdigest(),
            code_revision="test",
            image_spec_sha256="a" * 64,
            profile_revision="cpu-mediapipe-1",
            attestation=Attestation("N" * 43, "h264_mcap_v1"),
        )
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch) / "output"
            clip_task = task_input(recipe())
            bootstrap = Path(scratch) / "bootstrap.json"
            bootstrap.write_text(json.dumps({"taskInput": clip_task}))
            pin_clip(Path(scratch))
            clip_task = json.loads(bootstrap.read_bytes())["taskInput"]
            for entry in clip_task["recipe"]["stages"][:2]:
                entry["enabled"] = False
            from stateaction_contracts import request_sha256

            clip_task["recipeSha256"] = request_sha256(clip_task["recipe"])
            plan = plan_from_task(
                clip_task,
                {
                    "recipeSha256": clip_task["recipeSha256"],
                    "module": "hand_pose_cpu_v1@1",
                    "priorStages": [],
                },
                JOB,
            )
            with (
                patch.object(
                    FakeEngine, "plan", staticmethod(lambda _index, _frame: result())
                ),
                patch.object(FakeEngine, "undercount_last", False),
                patch.object(artifact_export, "HandInferencer", FakeEngine),
                patch.object(
                    artifact_export.hand_model, "resolve_model", return_value=object()
                ),
            ):
                exported = artifact_export.export_artifacts(
                    BytesIO(source),
                    LocalDirectorySink(root),
                    ctx,
                    seal=plan,
                )
            self.assertEqual(exported.frames, 2)
            self.assertEqual(
                exported.manifest["schema"], "stateaction.processing_result.v5"
            )
            self.assertEqual(
                exported.manifest["review_clip_id"], clip_task["clip"]["id"]
            )
            self.assertEqual(
                exported.manifest["clip_plan_sha256"], clip_task["clip"]["planSha256"]
            )
            presence = json.loads((root / "hand-presence.json").read_bytes())
            self.assertEqual(presence["frame_count"], 2)
            viewer = exported.manifest["clips"][0]
            self.assertEqual(viewer["frame_count"], 2)
            roles = {item["file_id"]: item for item in exported.manifest["outputs"]}
            frame_map = root / roles[viewer["files"]["frame_map_json"]]["relative_path"]
            frames = json.loads(frame_map.read_bytes())["rows"]
            self.assertEqual([frame["source_frame_id"] for frame in frames], ["2", "4"])
            self.assertEqual(
                [frame["timestamp_ns"] for frame in frames],
                ["1066666673", "1133333339"],
            )
            video = root / roles[viewer["files"]["rgb_mp4"]]["relative_path"]
            with av.open(str(video)) as container:
                self.assertEqual(sum(1 for _ in container.decode(video=0)), 2)
            self.assertFalse((root / "recording.mp4").exists())
