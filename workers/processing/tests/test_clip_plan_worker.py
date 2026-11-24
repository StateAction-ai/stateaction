"""Test planner output through the claimed worker's upload and report calls."""

import hashlib
import io
import json
import unittest
from unittest.mock import patch

from indexed_fixture import chunked
from stage_helpers import GOLDEN_MCAP, JOB, MANIFEST_SHA, RECORDING

from stateaction_processing import clip_plan
from stateaction_processing.artifact_types import LocalDirectorySink


class ClipPlanWorkerTests(unittest.TestCase):
    def test_native_original_and_plan_are_submitted_as_one_candidate(self):
        self._run_plan(False)

    def test_remux_failure_preserves_the_verified_whole_clip(self):
        self._run_plan(True)

    def _run_plan(self, fail_remux: bool):
        import tempfile
        from pathlib import Path

        source = chunked(GOLDEN_MCAP.read_bytes())
        task = {
            "schemaVersion": 5,
            "kind": "clip_plan",
            "jobId": JOB,
            "targetId": RECORDING,
            "profileRevision": "test",
            "sourceManifestSha256": MANIFEST_SHA,
            "rgbProfile": "h264_mcap_v1",
            "planVersion": 1,
            "clipFilter": {
                "mode": "passthrough",
                "module": "clip_filter@0",
                "params": {},
            },
        }
        grant = {
            "jobId": JOB,
            "digests": {"sourceManifestSha256": MANIFEST_SHA},
            "inputs": [
                {
                    "role": "source_mcap",
                    "sha256": hashlib.sha256(source).hexdigest(),
                    "readUrl": "http://127.0.0.1:9/source",
                }
            ],
        }
        context = {
            "jobId": JOB,
            "nonce": "N" * 43,
            "apiUrl": "http://127.0.0.1:9",
            "capability": "sa_svc_" + "S" * 43,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "job-outputs"
            sink = LocalDirectorySink(root)
            with (
                patch.object(clip_plan, "Api") as api_cls,
                patch.object(clip_plan, "ServerOutputSink", return_value=sink),
                patch.object(
                    clip_plan._OPENER,
                    "open",
                    side_effect=lambda *a, **kw: io.BytesIO(source),
                ),
                patch.object(
                    clip_plan,
                    "remux_source",
                    wraps=clip_plan.remux_source,
                    side_effect=clip_plan.StageMediaError("native_remux_failed")
                    if fail_remux
                    else None,
                ),
            ):
                api = api_cls.return_value
                api.job_id = JOB
                api.nonce = context["nonce"]
                api.call.return_value = task
                self.assertEqual(clip_plan.run(grant, context), 0)
                requests = [entry.args for entry in api.call.call_args_list]
            self.assertEqual(
                [req[1] for req in requests], ["task-input", "outputs/close", "result"]
            )
            plan = json.loads((root / "result-manifest.json").read_bytes())
            self.assertEqual(plan["frame_count"], 5)
            self.assertEqual(plan["spans"][0]["last_source_frame_id"], "5")
            if fail_remux:
                self.assertFalse((root / "recording.mp4").exists())
                self.assertEqual(plan["state"], "failed")
                self.assertEqual(plan["error_code"], "native_remux_failed")
            else:
                self.assertTrue((root / "recording.mp4").stat().st_size > 0)
                self.assertEqual(plan["state"], "succeeded")
            self.assertEqual(
                requests[-1][2]["manifestSha256"],
                hashlib.sha256(
                    (root / "result-manifest.json").read_bytes()
                ).hexdigest(),
            )
            self.assertEqual(requests[-1][2]["summary"]["clipCount"], 0)
