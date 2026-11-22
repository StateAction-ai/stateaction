"""SA-92 seal on the REAL changed export path: golden MCAP, real decoder/muxer/contracts, fake hand engine.

Covers the three ticket scenarios: a recipe with stub segments and captions, a recipe whose segment
stage failed and whose caption stage was not run, and no recipe (the unchanged v2 path).
"""

import hashlib
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from indexed_fixture import chunked
from stage_helpers import (
    JOB,
    MANIFEST_SHA,
    RECORDING,
    make_ctx,
    recipe,
    synthetic_frames,
    task_input,
)
from test_hands import hand, result
from test_inline_qc import GOLDEN, FakeEngine, RecordingSink
from test_mcap_stream import ForwardOnly

try:
    import av  # noqa: F401
    import numpy  # noqa: F401
    import rerun  # noqa: F401
    from stateaction_contracts import request_sha256, validate_bytes, validate_value

    # isort: split
    from stateaction_processing import (
        artifact_export,
        artifact_seal,
        artifact_types,
        modules,
    )
    from stateaction_processing.artifact_seal import (
        SealError,
        parse_prior_stages,
        plan_from_task,
    )

    HAVE_EXPORT = True
except ImportError:
    HAVE_EXPORT = False

NONCE = "N" * 43
FRAMES = 5
SOURCE_FILE = "44444444-4444-4444-8444-444444444444"


def fid() -> str:
    return str(uuid.uuid4())


def stored(role, slot, data: bytes) -> dict:
    return {
        "fileId": fid(),
        "role": role,
        "slot": slot,
        "sizeBytes": str(len(data)),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def jbytes(doc) -> bytes:
    return json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()


@mock.patch.dict(os.environ, {"APP_ENV": "local"})
def stub_documents():
    """Real stub-module segments.json and captions.json (bytes) for the 5-frame fixture."""
    frames = synthetic_frames(FRAMES, sha="a" * 64)
    ctx = make_ctx("segment", "stub_segmenter", {"segment_s": "0.07"}, frames=frames)
    seg_doc = modules.load("segment", "stub_segmenter")(ctx).document
    seg = jbytes(seg_doc)
    cctx = make_ctx(
        "caption",
        "stub_captioner",
        {},
        frames=frames,
        segments=seg_doc,
        segments_sha256=hashlib.sha256(seg).hexdigest(),
    )
    cap_doc = modules.load("caption", "stub_captioner")(cctx).document
    return seg_doc, seg, cap_doc, jbytes(cap_doc)


@unittest.skipUnless(HAVE_EXPORT, "decode, cpu and export groups not installed")
class SealExportTests(unittest.TestCase):
    def setUp(self):
        FakeEngine.plan = staticmethod(lambda i, frame: result())
        FakeEngine.undercount_last = False
        FakeEngine.instances = []
        self._orig = (
            artifact_export.HandInferencer,
            artifact_export.hand_model.resolve_model,
        )
        artifact_export.HandInferencer = FakeEngine
        artifact_export.hand_model.resolve_model = lambda _m=None: object()

        def restore():
            artifact_export.HandInferencer, artifact_export.hand_model.resolve_model = (
                self._orig
            )

        self.addCleanup(restore)
        self.data = chunked((GOLDEN / "valid.mcap").read_bytes())
        self.rec = recipe(segment_params={"segment_s": "0.07"})

    def context(self):
        return artifact_types.ExportContext(
            job_id=JOB,
            source_manifest_sha256=MANIFEST_SHA,
            code_revision="test",
            image_spec_sha256="a" * 64,
            profile_revision="cpu-mediapipe-1",
            recording_id=RECORDING,
            source_file_id=SOURCE_FILE,
            expected_source_sha256=hashlib.sha256(self.data).hexdigest(),
            attestation=artifact_types.Attestation(NONCE, "h264_mcap_v1"),
        )

    def stage_ctx(self, prior):
        return {
            "stage": "hand_pose",
            "module": "hand_pose_cpu_v1@1",
            "recipeSha256": request_sha256(self.rec),
            "priorStages": prior,
        }

    def plan(self, prior, documents=None):
        read = None
        if documents is not None:
            read = lambda out: documents.get(out.file_id)  # noqa: E731
        return plan_from_task(
            task_input(self.rec), self.stage_ctx(prior), JOB, read_document=read
        )

    def export(self, plan):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = Path(d.name) / "out"
        sink = RecordingSink(artifact_types.LocalDirectorySink(root))
        res = artifact_export.export_artifacts(
            ForwardOnly(self.data), sink, self.context(), seal=plan
        )
        return res, sink, root

    # ------------------------------------------------------------------ scenario 1
    def test_recipe_with_stub_segments_and_captions_seals_v3(self):
        _, seg, _, cap = stub_documents()
        seg_file = stored("segments_json", "segments.json", seg)
        seg_log = stored("diagnostic_blob", "diagnostics/segment/log.txt", b"log\n")
        cap_file = stored("captions_json", "captions.json", cap)
        prior = [
            {
                "stage": "segment",
                "state": "succeeded",
                "errorCode": None,
                "counts": {"segments": 3, "failed_windows": 0},
                "outputs": [seg_file, seg_log],
            },
            {
                "stage": "caption",
                "state": "succeeded",
                "errorCode": None,
                "counts": {"captions": 3},
                "outputs": [cap_file],
            },
        ]
        docs = {seg_file["fileId"]: seg, cap_file["fileId"]: cap}
        res, sink, root = self.export(self.plan(prior, docs))
        m = res.manifest
        self.assertEqual(m["schema"], "stateaction.processing_result.v3")
        self.assertEqual(
            validate_bytes("artifacts.processing-result.v3", jbytes(m)).valid, True
        )
        self.assertEqual(m["recipe_id"], "local_stub@1")
        self.assertEqual(m["recipe_sha256"], request_sha256(self.rec))
        # Every completed job output is listed: earlier stages and this stage, once.
        slots = {o["relative_path"]: o for o in m["outputs"]}
        self.assertEqual(
            {"segments.json", "captions.json", "diagnostics/segment/log.txt"}
            | {"recording.mp4", "hand-presence.json"},
            {s for s in slots if not s.startswith("clips/")},
        )
        self.assertEqual(slots["recording.mp4"]["role"], "recording_mp4")
        self.assertEqual(slots["hand-presence.json"]["role"], "hand_presence_json")
        self.assertEqual(slots["segments.json"]["file_id"], seg_file["fileId"])
        nodes = {n["stage"]: n for n in m["nodes"]}
        self.assertEqual(
            [n["stage"] for n in m["nodes"]], ["segment", "caption", "hand_pose"]
        )
        self.assertEqual(nodes["segment"]["module"], "stub_segmenter@1")
        self.assertEqual(
            nodes["segment"]["outputs"], [seg_file["fileId"], seg_log["fileId"]]
        )
        self.assertEqual(
            nodes["segment"]["counts"], {"segments": 3, "failed_windows": 0}
        )
        self.assertEqual(nodes["caption"]["outputs"], [cap_file["fileId"]])
        hp = nodes["hand_pose"]
        self.assertEqual(hp["status"], "succeeded")
        self.assertEqual(hp["counts"]["frames"], FRAMES)
        self.assertEqual(hp["counts"]["clips"], 1)
        self.assertIn(slots["recording.mp4"]["file_id"], hp["outputs"])
        self.assertIn(slots["clips/000/rgb.mp4"]["file_id"], hp["outputs"])
        # SA-32 checks are all still there, plus the new consistency check.
        codes = [c["code"] for c in m["checks"]]
        for code in ("source_accepted", "decode_and_inference_once", "native_mp4_remux",
                     "clip_bounds", "proxy_rrd_bounds", "capture_counts",
                     "hand_detection_summary"):  # fmt: skip
            self.assertIn(code, codes)
        check = next(
            c for c in m["checks"] if c["code"] == "annotation_files_consistent"
        )
        self.assertEqual(check["status"], "pass")
        self.assertEqual(check["measurements"]["unknown_segments"], "0")
        # The review video is a native remux of every access unit.
        import av

        with av.open(str(root / "recording.mp4")) as src:
            packets = [p for p in src.demux(src.streams.video[0]) if p.size]
        self.assertEqual(len(packets), FRAMES)
        # hand-presence.json: no hand is an explicit state, never an empty lane.
        presence = json.loads((root / "hand-presence.json").read_text())
        self.assertEqual(presence["frame_count"], FRAMES)
        for side in ("left", "right"):
            lane = presence["lanes"][side]
            self.assertEqual(
                [(s["state"], s["frames"]) for s in lane], [("no_hand", FRAMES)]
            )
            self.assertEqual(
                lane[-1]["end"], {"source_frame_id": None, "timestamp_ns": None}
            )
        self.assertEqual(presence["producer"]["stage"], "hand_pose")
        self.assertEqual(
            presence["producer"]["weights_sha256"],
            artifact_export.hand_model.PINS["sha256"],
        )
        # Single pass: the new files are put before the manifest, which is sealed last.
        self.assertEqual(sink.kinds()[-1], "seal")

    def test_hand_presence_lanes_separate_present_no_hand_and_failed(self):
        FakeEngine.plan = staticmethod(
            lambda i, f: result(hand()) if i in (2, 3) else result()
        )
        prior = [
            {"stage": "segment", "state": "succeeded", "errorCode": None, "counts": {},
             "outputs": [stored("segments_json", "segments.json", b"{}")]},
            {"stage": "caption", "state": "not_run", "errorCode": "not_spawned",
             "counts": {}, "outputs": []},
        ]  # fmt: skip
        _, _, root = self.export(self.plan(prior))
        presence = json.loads((root / "hand-presence.json").read_text())
        runs = {
            side: [(s["state"], s["frames"]) for s in presence["lanes"][side]]
            for side in ("left", "right")
        }
        hand_side = next(s for s in runs if len(runs[s]) == 3)
        other = "right" if hand_side == "left" else "left"
        self.assertEqual(
            runs[hand_side], [("no_hand", 2), ("present", 2), ("no_hand", 1)]
        )
        self.assertEqual(runs[other], [("no_hand", FRAMES)])
        # `failed` is its own state and is never folded into `no_hand`.
        lane = artifact_seal.LaneBuilder()
        ref = lambda n: {"source_frame_id": str(n), "timestamp_ns": str(n * 10)}  # noqa: E731
        for n, state in enumerate(("no_hand", "failed", "failed", "present")):
            lane.add(ref(n), state)
        self.assertEqual(
            [(s["state"], s["frames"]) for s in lane.spans()],
            [("no_hand", 1), ("failed", 2), ("present", 1)],
        )
        with self.assertRaises(artifact_types.ExportError):
            lane.add(ref(9), "unknown")

    # ------------------------------------------------------------------ scenario 2
    def test_failed_segment_and_not_run_caption_appear_as_such(self):
        err = stored(
            "diagnostic_blob", "diagnostics/segment/windows.jsonl", b'{"w":0}\n'
        )
        log = stored("diagnostic_blob", "diagnostics/segment/log.txt", b"log\n")
        prior = [
            {"stage": "segment", "state": "failed", "errorCode": "window_failed",
             "counts": {"failed_windows": 2}, "outputs": [err, log]},
            {"stage": "caption", "state": "not_run", "errorCode": "segment_failed",
             "counts": {}, "outputs": []},
        ]  # fmt: skip
        res, _, root = self.export(self.plan(prior, {}))
        m = res.manifest
        self.assertEqual(
            validate_bytes("artifacts.processing-result.v3", jbytes(m)).valid, True
        )
        seg, cap, hp = m["nodes"]
        self.assertEqual(
            (seg["status"], seg["error_code"]), ("failed", "window_failed")
        )
        self.assertEqual(
            seg["outputs"], [err["fileId"], log["fileId"]]
        )  # evidence kept
        self.assertEqual(
            (cap["status"], cap["error_code"], cap["outputs"]),
            ("not_run", "segment_failed", []),
        )
        self.assertEqual(hp["status"], "succeeded")
        slots = {o["relative_path"] for o in m["outputs"]}
        self.assertNotIn("segments.json", slots)  # absent, never an empty file
        self.assertNotIn("captions.json", slots)
        self.assertTrue((root / "recording.mp4").is_file())
        check = next(
            c for c in m["checks"] if c["code"] == "annotation_files_consistent"
        )
        self.assertEqual(check["status"], "not_evaluated")

    def test_check_fails_when_a_caption_names_an_unknown_segment(self):
        seg_doc, seg, cap_doc, _ = stub_documents()
        cap_doc["rows"][0]["segment_id"] = str(
            uuid.uuid5(uuid.NAMESPACE_URL, "unknown")
        )
        cap = jbytes(cap_doc)
        sf = stored("segments_json", "segments.json", seg)
        cf = stored("captions_json", "captions.json", cap)
        prior = [
            {"stage": "segment", "state": "succeeded", "errorCode": None, "counts": {}, "outputs": [sf]},
            {"stage": "caption", "state": "succeeded", "errorCode": None, "counts": {}, "outputs": [cf]},
        ]  # fmt: skip
        plan = self.plan(prior, {sf["fileId"]: seg, cf["fileId"]: cap})
        check = artifact_seal.annotation_check(plan)
        self.assertEqual(check["status"], "fail")
        self.assertEqual(check["measurements"]["unknown_segments"], "1")
        # An unreadable document is never a pass.
        unreadable = self.plan(prior, {})
        self.assertEqual(
            artifact_seal.annotation_check(unreadable)["status"], "not_evaluated"
        )

    # ------------------------------------------------------------------ scenario 3
    def test_without_a_recipe_the_v2_path_is_unchanged(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = Path(d.name) / "out"
        res = artifact_export.export_artifacts(
            ForwardOnly(self.data),
            artifact_types.LocalDirectorySink(root),
            self.context(),
        )
        self.assertEqual(res.manifest["schema"], "stateaction.processing_result.v2")
        for key in ("nodes", "recipe_id", "recipe_sha256"):
            self.assertNotIn(key, res.manifest)
        self.assertFalse((root / "recording.mp4").exists())
        self.assertFalse((root / "hand-presence.json").exists())
        self.assertEqual(
            [c["code"] for c in res.manifest["checks"]],
            ["source_accepted", "decode_and_inference_once", "native_mp4_remux",
             "clip_bounds", "proxy_rrd_bounds", "capture_counts",
             "hand_detection_summary"],
        )  # fmt: skip
        self.assertEqual(len(res.manifest["outputs"]), 6)

    def test_a_seal_needs_the_claim_attestation(self):
        plan = self.plan(
            [
                {
                    "stage": "segment",
                    "state": "failed",
                    "errorCode": "x",
                    "counts": {},
                    "outputs": [],
                },
                {
                    "stage": "caption",
                    "state": "not_run",
                    "errorCode": "x",
                    "counts": {},
                    "outputs": [],
                },
            ]  # fmt: skip
        )
        ctx = artifact_types.ExportContext(
            job_id=JOB,
            source_manifest_sha256=MANIFEST_SHA,
            code_revision="test",
            image_spec_sha256="a" * 64,
            profile_revision="p",
            fixture_identities=True,
        )
        with self.assertRaises(artifact_types.ExportError) as caught:
            artifact_export.export_artifacts(
                ForwardOnly(self.data),
                artifact_types.LocalDirectorySink(Path(tempfile.mkdtemp()) / "o"),
                ctx,
                seal=plan,
            )
        self.assertEqual(caught.exception.code, "E_SEAL_NEEDS_ATTESTATION")


@unittest.skipUnless(HAVE_EXPORT, "contracts not installed")
class PriorStageTests(unittest.TestCase):
    def setUp(self):
        self.rec = recipe()

    def bad(self, raw, code):
        with self.assertRaises(SealError) as caught:
            parse_prior_stages(raw, self.rec)
        self.assertEqual(caught.exception.code, code)

    def test_an_enabled_stage_must_be_present_and_settled(self):
        self.bad([], "prior_stage_missing")
        self.bad(
            [
                {"stage": "segment", "state": "running", "errorCode": None},
                {"stage": "caption", "state": "not_run", "errorCode": "x"},
            ],
            "prior_stage_unsettled",
        )

    def test_a_disabled_stage_may_be_absent_and_is_not_run(self):
        rec = recipe()
        rec["stages"][1]["enabled"] = False
        rows = parse_prior_stages(
            [{"stage": "segment", "state": "succeeded", "errorCode": None,
              "outputs": [stored("segments_json", "segments.json", b"{}")]}],
            rec,
        )  # fmt: skip
        self.assertEqual(
            (rows[1].status, rows[1].error_code, rows[1].module),
            ("not_run", "stage_disabled", "stub_captioner@1"),
        )

    def test_cancelled_is_recorded_as_failed_and_codes_follow_the_state(self):
        rows = parse_prior_stages(
            [
                {"stage": "segment", "state": "cancelled", "errorCode": "cancelled"},
                {"stage": "caption", "state": "not_run", "errorCode": "segment_failed"},
            ],
            self.rec,
        )
        self.assertEqual([r.status for r in rows], ["failed", "not_run"])
        self.bad(
            [
                {"stage": "segment", "state": "succeeded", "errorCode": "oops"},
                {"stage": "caption", "state": "not_run", "errorCode": "x"},
            ],
            "prior_stage_invalid",
        )
        self.bad(
            [
                {"stage": "segment", "state": "failed", "errorCode": None},
                {"stage": "caption", "state": "not_run", "errorCode": "x"},
            ],
            "prior_stage_invalid",
        )

    def test_outputs_need_a_stage_role_a_safe_slot_and_exact_facts(self):
        good = stored("segments_json", "segments.json", b"{}")
        for mutate in (
            {"role": "captions_json"},  # a role of another stage
            {"slot": "../segments.json"},
            {"sizeBytes": "0"},
            {"sha256": "z" * 64},
            {"fileId": "not-a-uuid"},
        ):
            self.bad(
                [
                    {
                        "stage": "segment",
                        "state": "succeeded",
                        "errorCode": None,
                        "outputs": [{**good, **mutate}],
                    },
                    {"stage": "caption", "state": "not_run", "errorCode": "x"},
                ],  # fmt: skip
                "prior_output_invalid",
            )

    def test_recipe_digest_and_stage_module_must_match(self):
        prior = [
            {"stage": "segment", "state": "failed", "errorCode": "x"},
            {"stage": "caption", "state": "not_run", "errorCode": "x"},
        ]
        ctx = {
            "stage": "hand_pose",
            "module": "hand_pose_cpu_v1@1",
            "recipeSha256": "0" * 64,
            "priorStages": prior,
        }
        with self.assertRaises(SealError) as caught:
            plan_from_task(task_input(self.rec), ctx, JOB)
        self.assertEqual(caught.exception.code, "recipe_digest_mismatch")
        ctx["recipeSha256"] = request_sha256(self.rec)
        ctx["module"] = "other@1"
        with self.assertRaises(SealError) as caught:
            plan_from_task(task_input(self.rec), ctx, JOB)
        self.assertEqual(caught.exception.code, "recipe_stage_mismatch")
        v2 = dict(task_input(self.rec), schemaVersion=2)
        ctx["module"] = "hand_pose_cpu_v1@1"
        with self.assertRaises(SealError) as caught:
            plan_from_task(v2, ctx, JOB)
        self.assertEqual(caught.exception.code, "task_input_invalid")


@unittest.skipUnless(HAVE_EXPORT, "contracts not installed")
class StageReceiptTests(unittest.TestCase):
    """The last stdout line of a hand_pose stage is a valid jobs.stage-receipt.v1."""

    def printed(self, outcome):
        import contextlib
        import io

        from stateaction_processing import hand_pose_cpu_v1

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            hand_pose_cpu_v1._print_stage_receipt(
                {"jobId": JOB},
                {"module": "hand_pose_cpu_v1@1"},
                outcome,
                "2026-01-01T00:00:00Z",
            )
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        return json.loads(lines[-1])

    def test_success_lists_only_the_two_review_files(self):
        files = [
            {
                "fileId": fid(),
                "role": "recording_mp4",
                "sizeBytes": "5",
                "sha256": "a" * 64,
            },
            {
                "fileId": fid(),
                "role": "hand_presence_json",
                "sizeBytes": "7",
                "sha256": "b" * 64,
            },
        ]
        receipt = self.printed(
            {
                "status": "succeeded",
                "code": None,
                "outputs": files,
                "counts": {"frames": 5, "clips": 1},
            }
        )
        self.assertEqual(receipt["outputs"], files)
        self.assertEqual((receipt["status"], receipt["errorCode"]), ("succeeded", None))
        self.assertTrue(validate_value("jobs.stage-receipt.v1", receipt).valid)

    def test_failure_prints_a_failed_receipt_without_outputs(self):
        receipt = self.printed({"status": "failed", "code": "prior_stage_missing"})
        self.assertEqual(
            (receipt["status"], receipt["errorCode"], receipt["outputs"]),
            ("failed", "prior_stage_missing", []),
        )
        self.assertTrue(validate_value("jobs.stage-receipt.v1", receipt).valid)


class BootstrapTests(unittest.TestCase):
    """The stage bootstrap keys of the hand_pose claim (parsed before any claim)."""

    REF = "local-seal-ref"

    def parse(self, **extra):
        import io
        from unittest import mock

        from stateaction_processing import run_job

        boot = {
            "schemaVersion": 1,
            "apiUrl": "http://127.0.0.1:1",
            "jobId": JOB,
            "bootstrapToken": "sa_svc_" + "A" * 43,
            "executionRef": self.REF,
            "pipeline": "hand_pose_cpu_v1",
            **extra,
        }
        stdin = mock.Mock(buffer=io.BytesIO(json.dumps(boot).encode()))
        with mock.patch.object(run_job.sys, "stdin", stdin):
            return run_job._read_bootstrap(self.REF)

    def stage(self, **over):
        return {
            "stage": "hand_pose",
            "module": "hand_pose_cpu_v1@1",
            "recipeSha256": "a" * 64,
            "priorStages": [],
            **over,
        }

    def test_without_stage_keys_the_single_claim_bootstrap_is_unchanged(self):
        boot = self.parse()
        self.assertNotIn("stage", boot)

    def test_a_recipe_bootstrap_carries_all_four_stage_keys(self):
        self.assertEqual(self.parse(**self.stage())["stage"], "hand_pose")
        from stateaction_processing.run_job import WorkerExit

        partial = self.stage()
        del partial["priorStages"]
        for extra in (
            partial,
            self.stage(stage="segment"),
            self.stage(module="nope"),
            self.stage(recipeSha256="x"),
            self.stage(priorStages={}),
        ):
            with self.subTest(extra), self.assertRaises(WorkerExit):
                self.parse(**extra)


if __name__ == "__main__":
    unittest.main()
