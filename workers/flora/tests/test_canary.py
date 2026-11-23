"""SA-101 canary store: real-shaped live outputs round-trip through the replay modules (no GPU, no Modal)."""

import dataclasses
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parents[2] / "processing/tests"))
from flora_ext import canary  # noqa: E402
from stage_helpers import MANIFEST_SHA, make_ctx, synthetic_frames  # noqa: E402

from stateaction_processing.flora_adapter import (  # noqa: E402
    canonical_bytes,
    segments_from_flora,
)
from stateaction_processing.modules import replay  # noqa: E402
from stateaction_processing.stage_docs import (  # noqa: E402
    CaptionOutcome,
    ProducerFacts,
    captions_document,
    segments_document,
)

MCAP_SHA = MANIFEST_SHA  # the stage task names the MCAP by this digest
FLORA_SHA = "b" * 64  # what the live module saw: the MP4 remuxed from the MCAP
FRAMES = 100


def seg(i, start, end):
    return {
        "id": i,
        "start_s": start / 30,
        "end_s": end / 30,
        "start_frame": start,
        "end_frame_exclusive": end,
        "provenance": "fine",
        "stitched": False,
        "crosses_core_boundary": False,
    }


def native_doc():
    # segment 2 lies fully inside segment 1: a live module drops it and records it
    return {
        "schema_version": "flora_tempseg_long_v1",
        "source": {"sha256": FLORA_SHA, "frames": FRAMES},
        "segments": [seg(0, 0, 30), seg(1, 25, 70), seg(2, 40, 60), seg(3, 70, 100)],
        "windows": {"total": 3, "ok": 3, "failed": []},
        "provenance": {
            "tempseg_weights_revision_pinned_in_models_json": "r" * 40,
            "tempseg_adapter_sha256": "a" * 64,
            "prompt_sha256": "d" * 64,
            "decoding": {"do_sample": False},
        },
    }


class CanaryStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Path(self.tmp.name)
        env = mock.patch.dict(
            os.environ, {"APP_ENV": "local", replay.ENV: str(self.store)}
        )
        env.start()
        self.addCleanup(env.stop)
        self.frames = synthetic_frames(FRAMES, sha=MCAP_SHA)
        self.native = native_doc()
        self.live_seg, self.live_cap = self.live_outputs()

    def live_outputs(self):
        ctx = make_ctx(
            "segment",
            "flora_tempseg_vllm_fp8",
            frames=self.frames,
            source_sha=MCAP_SHA,
        )
        covered = []
        spans, total, failed = segments_from_flora(ctx, self.native, None, covered)
        facts = ProducerFacts(
            engine_version="0.34.0",
            model_revision="r" * 40,
            weights_sha256="a" * 64,
            prompt_sha256="d" * 64,
            quant={"method": "fp8_per_tensor", "format": "compressed-tensors"},
            decoding_params={"batch_size": 16},
            observed_gpu="Observed GPU",
        )
        doc = segments_document(ctx, ctx.producer(facts), spans, total, failed)
        raw = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
        import hashlib

        cctx = dataclasses.replace(
            make_ctx(
                "caption",
                "flora_captioner_vllm_fp8",
                frames=self.frames,
                source_sha=MCAP_SHA,
            ),
            segments=doc,
            segments_sha256=hashlib.sha256(raw).hexdigest(),
        )
        outcomes = [
            CaptionOutcome(
                doc["rows"][0]["segment_id"], "complete", text="pick up knife"
            ),
            CaptionOutcome(
                doc["rows"][1]["segment_id"], "failed", "finish_reason_length"
            ),
            CaptionOutcome(doc["rows"][2]["segment_id"], "complete", text="cut onion"),
        ]
        cap = captions_document(
            cctx,
            cctx.producer(dataclasses.replace(facts, prompt_sha256="e" * 64)),
            outcomes,
        )
        self.covered = covered
        return doc, cap

    def files(self):
        rows = self.live_seg["rows"]
        seg_files = {
            "segments.json": json.dumps(self.live_seg).encode(),
            canary.SEG_DIAG + "native_segments.json": canonical_bytes(self.native),
            canary.SEG_DIAG + "provenance.json": canonical_bytes(
                {
                    "covered_segments_dropped": self.covered,
                    "checkpoint": {"checkpoint_id": "tempseg"},
                    "timing": {"cold_load_s": 1.5, "gpu_s": 2.5},
                }
            ),
            canary.SEG_DIAG + "windows.jsonl": b'{"status":"ok","window_index":0}\n',
        }
        cap_files = {
            "captions.json": json.dumps(self.live_cap).encode(),
            canary.CAP_DIAG + "provenance.json": canonical_bytes(
                {"checkpoint": {"checkpoint_id": "captioner"}, "timing": {"gpu_s": 4}}
            ),
            canary.CAP_DIAG + "caption_inputs.json": canonical_bytes(
                {
                    "inputs": [
                        {"segment_id": r["segment_id"], "disposition": "caption_input"}
                        for r in rows
                    ],
                    "prompt_sha256s": ["1" * 64, "2" * 64, "3" * 64],
                }
            ),
        }
        return seg_files, cap_files

    def build(self):
        seg_files, cap_files = self.files()
        return canary.build_store(
            self.store,
            "homer_33",
            MCAP_SHA,
            seg_files,
            cap_files,
            {"run_utc": "2026-11-23T00:00:00Z"},
        )

    def test_the_dropped_covered_segment_is_recorded_not_lost(self):
        report = self.build()
        self.assertEqual((report["segments"], report["dropped_covered"]), (3, 1))
        native = json.loads((self.store / "homer_33/flora/segments.json").read_text())
        self.assertEqual([s["id"] for s in native["segments"]], [0, 1, 3])
        self.assertEqual(native["canary"]["dropped_covered"][0]["id"], 2)

    def test_the_store_replays_to_the_same_rows_with_real_provenance(self):
        report = self.build()
        ctx = make_ctx(
            "segment", "replay_segmenter", frames=self.frames, source_sha=MCAP_SHA
        )
        out = replay.run_segment(ctx)
        live = self.live_seg["rows"]
        self.assertEqual(len(out.document["rows"]), len(live))
        for got, want in zip(out.document["rows"], live, strict=True):
            # segment ids derive from the module id, so only the native identity is comparable
            self.assertEqual((got["start"], got["end"]), (want["start"], want["end"]))
            self.assertEqual(got["ext"]["flora"], want["ext"]["flora"])
        replayed = out.document["rows"][0]["ext"]["replayed_from"]
        self.assertEqual(replayed["gpu_name"], "Observed GPU")
        self.assertEqual(replayed["run_utc"], "2026-11-23T00:00:00Z")
        self.assertEqual(replayed["native_sha256"], report["segments_sha256"])
        cctx = dataclasses.replace(
            make_ctx(
                "caption", "replay_captioner", frames=self.frames, source_sha=MCAP_SHA
            ),
            segments=out.document,
            segments_sha256="0" * 64,
        )
        cap = replay.run_caption(cctx)
        self.assertEqual(
            [
                (r["status"], r.get("error_code"), r.get("text"))
                for r in cap.document["rows"]
            ],
            [
                (r["status"], r.get("error_code"), r.get("text"))
                for r in self.live_cap["rows"]
            ],
        )
        self.assertEqual(cap.counts["failed_captions"], 1)

    def test_a_failed_caption_keeps_its_error_code_and_never_text(self):
        self.build()
        captions = json.loads((self.store / "homer_33/flora/captions.json").read_text())
        failed = [c for c in captions["captions"] if c["status"] != "complete"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["status"], "finish_reason_length")
        self.assertNotIn("caption", failed[0])
        self.assertEqual(captions["source_sha256"], FLORA_SHA)

    def test_a_dropped_id_that_is_not_native_is_refused(self):
        seg_files, cap_files = self.files()
        bad = json.loads(seg_files[canary.SEG_DIAG + "provenance.json"])
        bad["covered_segments_dropped"] = [{"id": 99}]
        seg_files[canary.SEG_DIAG + "provenance.json"] = canonical_bytes(bad)
        with self.assertRaises(ValueError):
            canary.build_store(
                self.store, "homer_33", MCAP_SHA, seg_files, cap_files, {"run_utc": "x"}
            )

    def test_a_stage_that_ran_on_another_mcap_is_refused(self):
        seg_files, cap_files = self.files()
        with self.assertRaises(ValueError):
            canary.build_store(
                self.store, "homer_33", "0" * 64, seg_files, cap_files, {"run_utc": "x"}
            )

    def test_env_json_hashes_every_returned_file_and_keeps_the_live_producer(self):
        self.build()
        env = json.loads((self.store / "homer_33/flora/env.json").read_text())
        seg_files, _ = self.files()
        self.assertEqual(
            env["modal"]["returned_sha256"]["segments.json"],
            canary.sha256_bytes(seg_files["segments.json"]),
        )
        self.assertEqual(env["modal"]["segment_producer"]["weights_sha256"], "a" * 64)

    def test_a_prompt_list_that_does_not_match_the_plan_is_refused(self):
        seg_files, cap_files = self.files()
        inputs = json.loads(cap_files[canary.CAP_DIAG + "caption_inputs.json"])
        inputs["prompt_sha256s"] = inputs["prompt_sha256s"][:2]
        cap_files[canary.CAP_DIAG + "caption_inputs.json"] = canonical_bytes(inputs)
        with self.assertRaises(ValueError):
            canary.build_store(
                self.store, "homer_33", MCAP_SHA, seg_files, cap_files, {"run_utc": "x"}
            )


if __name__ == "__main__":
    unittest.main()
