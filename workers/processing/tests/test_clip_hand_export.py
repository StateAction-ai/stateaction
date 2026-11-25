"""Exercise the real CPU exporter over a non-IDR clip boundary."""

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import av
from indexed_fixture import chunked
from stage_helpers import GOLDEN_MCAP, JOB, MANIFEST_SHA, RECORDING, recipe, task_input
from stateaction_contracts import request_sha256
from test_clip_stage_entry import pin_clip
from test_hands import hand, result
from test_inline_qc import FakeEngine

from stateaction_processing import artifact_export, artifact_reader
from stateaction_processing.artifact_seal import plan_from_task
from stateaction_processing.artifact_types import (
    Attestation,
    ExportContext,
    ExportError,
    LocalDirectorySink,
    derived_uuid,
    make_output,
)
from stateaction_processing.review_video import materialize


class ClipHandExportTests(unittest.TestCase):
    def export(self, source, root, *, planned):
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
        task = task_input(recipe())
        if planned:
            bootstrap = root.parent / "bootstrap.json"
            bootstrap.write_text(json.dumps({"taskInput": task}))
            pin_clip(root.parent)
            task = json.loads(bootstrap.read_bytes())["taskInput"]
        for entry in task["recipe"]["stages"][:2]:
            entry["enabled"] = False
        task["recipeSha256"] = request_sha256(task["recipe"])
        plan = plan_from_task(
            task,
            {
                "recipeSha256": task["recipeSha256"],
                "module": "hand_pose_cpu_v1@1",
                "priorStages": [],
            },
            JOB,
        )
        with (
            patch.object(
                FakeEngine, "plan", staticmethod(lambda _index, _frame: result(hand()))
            ),
            patch.object(FakeEngine, "undercount_last", False),
            patch.object(artifact_export, "HandInferencer", FakeEngine),
            patch.object(
                artifact_export.hand_model, "resolve_model", return_value=object()
            ),
        ):
            exported = artifact_export.export_artifacts(
                BytesIO(source), LocalDirectorySink(root), ctx, seal=plan
            )
        return exported, plan, task

    def test_preroll_is_decoded_but_excluded_from_inference_and_outputs(self):
        source = chunked(GOLDEN_MCAP.read_bytes())
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch) / "output"
            exported, plan, clip_task = self.export(source, root, planned=True)
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
            review_video = root / "review-clip.mp4"
            output = next(
                f
                for f in exported.manifest["outputs"]
                if f["relative_path"] == review_video.name
            )
            self.assertEqual(output["role"], "clip_mp4")
            self.assertEqual(
                output["sha256"], hashlib.sha256(review_video.read_bytes()).hexdigest()
            )
            with av.open(str(review_video)) as container:
                self.assertEqual(
                    [stream.type for stream in container.streams], ["video"]
                )
                packets = [p for p in container.demux(video=0) if p.size]
            self.assertTrue(packets[0].is_keyframe)
            self.assertFalse(any(p.is_discard for p in packets))
            self.assertEqual([p.pts for p in packets], [0, 66666])
            self.assertFalse((root / "recording.mp4").exists())

            assert plan.clip is not None
            backfilled = Path(scratch) / "backfilled.mp4"
            materialize(
                BytesIO(source),
                backfilled,
                plan.clip,
                hashlib.sha256(source).hexdigest(),
                "h264_mcap_v1",
            )
            self.assertEqual(backfilled.read_bytes(), review_video.read_bytes())
            with av.open(str(backfilled)) as container:
                self.assertEqual([f.pts for f in container.decode(video=0)], [0, 66666])

            rejected = Path(scratch) / "rejected.mp4"
            with self.assertRaisesRegex(ExportError, "E_SOURCE_SHA_MISMATCH"):
                materialize(
                    BytesIO(source), rejected, plan.clip, "0" * 64, "h264_mcap_v1"
                )
            with self.assertRaisesRegex(ExportError, "E_REVIEW_VIDEO_SOURCE_MISMATCH"):
                materialize(
                    BytesIO(source),
                    rejected,
                    replace(plan.clip, last=("4", "1133333340")),
                    hashlib.sha256(source).hexdigest(),
                    "h264_mcap_v1",
                )
            self.assertFalse(rejected.exists())

    def test_reads_exported_artifacts_and_reused_producer_identity(self):
        source = chunked(GOLDEN_MCAP.read_bytes())
        for planned, version, frames in [(False, 4, 5), (True, 6, 2)]:
            with (
                self.subTest(version=version),
                tempfile.TemporaryDirectory() as scratch,
            ):
                parent = Path(scratch) / "parent"
                self.export(source, parent, planned=planned)
                original = artifact_reader.open_result(parent, require_contracts=True)
                self.assertEqual(
                    original.manifest["schema"],
                    f"stateaction.processing_result.v{version - 1}",
                )
                (original_clip,) = original.clips
                roundtrip = original_clip.verify_roundtrip()
                self.assertEqual(roundtrip["frames"], frames)
                self.assertGreater(roundtrip["scalars_compared"], 0)

                root = Path(scratch) / "rerun"
                child_job = derived_uuid(JOB, "rerun")
                sink = LocalDirectorySink(root, job_id=child_job)
                doc = json.loads((parent / "result-manifest.json").read_bytes())
                files = {}
                for output in doc["outputs"]:
                    slot = output["relative_path"]
                    scratch_file = Path(scratch) / "copy"
                    scratch_file.write_bytes((parent / slot).read_bytes())
                    receipt = sink.put(
                        make_output(output["role"], slot, scratch_file, None)
                    )
                    files[output["file_id"]] = receipt.file_id
                    output["file_id"] = receipt.file_id
                child_clip = derived_uuid(child_job, original_clip.clip_id)
                doc["clips"][0]["clip_id"] = child_clip
                doc["clips"][0]["files"] = {
                    role: files[fid] for role, fid in doc["clips"][0]["files"].items()
                }
                for node in doc["nodes"]:
                    node["outputs"] = [files[fid] for fid in node["outputs"]]
                doc.update(
                    schema=f"stateaction.processing_result.v{version}",
                    job_id=child_job,
                    reused_hand={
                        "job_id": JOB,
                        "manifest_sha256": original.manifest_sha256,
                        "clips": [
                            {
                                "clip_id": child_clip,
                                "original_clip_id": original_clip.clip_id,
                            }
                        ],
                    },
                )
                scratch_manifest = Path(scratch) / "manifest"
                scratch_manifest.write_text(json.dumps(doc))
                sink.seal(
                    make_output(
                        "result_manifest",
                        "result-manifest.json",
                        scratch_manifest,
                        None,
                    )
                )

                reopened = artifact_reader.open_result(root, require_contracts=True)
                self.assertTrue(reopened.contract_validated)
                self.assertEqual(reopened.provenance["reused_hand"], doc["reused_hand"])
                if planned:
                    for key in ("review_clip_id", "clip_plan_sha256"):
                        self.assertEqual(
                            reopened.provenance[key], original.provenance[key]
                        )
                (clip,) = reopened.clips
                self.assertEqual((clip.job_id, clip.clip_id), (child_job, child_clip))
                self.assertEqual(
                    clip.frame_map_document(), original_clip.frame_map_document()
                )
                self.assertEqual(
                    clip.hand_observations(), original_clip.hand_observations()
                )
                self.assertEqual(clip.verify_roundtrip(), roundtrip)
                self.assertEqual(clip.verify_mp4(), original_clip.verify_mp4())

                doc["reused_hand"]["clips"] = []
                (root / "result-manifest.json").write_text(json.dumps(doc))
                with self.assertRaisesRegex(
                    artifact_reader.ArtifactError, "invalid reused hand clip origins"
                ):
                    artifact_reader.open_result(root, require_contracts=True)
