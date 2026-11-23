"""Stub and replay modules, the FLORA adapter and the registry, on synthetic data only."""

import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from stage_helpers import make_ctx, synthetic_frames
from stateaction_contracts import validate_bytes, validate_value

from stateaction_processing import modules
from stateaction_processing.modules import replay, stub
from stateaction_processing.stage_docs import StageError

NATIVE = Path(__file__).resolve().parent / "fixtures/flora_native"
A = "a" * 64


def segments_ctx(params=None):
    ctx = make_ctx("segment", "stub_segmenter", params)
    return ctx, stub.run_segment(ctx)


def caption_ctx(doc, params=None, module="stub_captioner"):
    raw = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
    return make_ctx(
        "caption",
        module,
        params,
        segments=doc,
        segments_sha256=hashlib.sha256(raw).hexdigest(),
    )


class RegistryTests(unittest.TestCase):
    def test_local_only_modules_need_app_env_local(self):
        with mock.patch.dict(os.environ, {"APP_ENV": "production"}):
            for ref, stage in (
                ("stub_segmenter@1", "segment"),
                ("replay_captioner@1", "caption"),
            ):
                with (
                    self.subTest(ref),
                    self.assertRaises(modules.ModuleRefused) as caught,
                ):
                    modules.resolve(stage, ref)
                self.assertEqual(caught.exception.code, "module_local_only")
        with mock.patch.dict(os.environ, {"APP_ENV": "local"}):
            self.assertEqual(
                modules.resolve("segment", "stub_segmenter@1")["stage"], "segment"
            )

    def test_unknown_wrong_stage_and_unregistered_modules_are_refused(self):
        with mock.patch.dict(os.environ, {"APP_ENV": "local"}):
            for stage, ref, code in (
                ("segment", "nope@1", "module_unknown"),
                ("caption", "stub_segmenter@1", "module_unknown"),
                ("segment", "hand_pose_cpu_v1@1", "module_unknown"),
                ("segment", "stub_segmenter", "module_ref_invalid"),
            ):
                with (
                    self.subTest(ref),
                    self.assertRaises(modules.ModuleRefused) as caught,
                ):
                    modules.resolve(stage, ref)
                self.assertEqual(caught.exception.code, code)

    def test_resolve_imports_no_module_code(self):
        import sys

        for name in list(sys.modules):
            if name.endswith(("modules.stub", "modules.replay")):
                del sys.modules[name]
        with mock.patch.dict(os.environ, {"APP_ENV": "local"}):
            modules.resolve("segment", "stub_segmenter@1")
        self.assertFalse(
            any(n.endswith(("modules.stub", "modules.replay")) for n in sys.modules)
        )
        loaded = modules.load("segment", "stub_segmenter")
        self.assertEqual(
            (loaded.__module__, loaded.__name__),
            ("stateaction_processing.modules.stub", "run_segment"),
        )


class StubSegmenterTests(unittest.TestCase):
    def valid(self, doc):
        result = validate_value("artifacts.segments.v1", doc)
        self.assertTrue(result.valid, (result.code, result.errors[:2]))

    def test_fixed_length_segments_cover_the_whole_recording(self):
        ctx, out = segments_ctx({"segment_s": 1})
        self.valid(out.document)
        rows = out.document["rows"]
        self.assertEqual([r["status"] for r in rows], ["ok"] * 4)
        self.assertEqual(rows[0]["start"], ctx.frames.ref(0))
        self.assertEqual(
            rows[-1]["end"], {"source_frame_id": None, "timestamp_ns": None}
        )
        for before, after in zip(rows, rows[1:]):
            self.assertEqual(before["end"], after["start"])  # no gap, no overlap
        self.assertEqual(out.counts["segments"], 4)

    def test_output_is_deterministic(self):
        self.assertEqual(
            segments_ctx({"segment_s": "1.5"})[1].document,
            segments_ctx({"segment_s": "1.5"})[1].document,
        )

    def test_fail_windows_are_failed_rows_never_empty(self):
        _, out = segments_ctx({"segment_s": 1, "fail_windows": "1,2"})
        self.valid(out.document)
        statuses = [r["status"] for r in out.document["rows"]]
        self.assertEqual(
            statuses, ["ok", "failed_window", "ok"]
        )  # adjacent failures merge
        windows = out.document["windows"]
        self.assertEqual((windows["total"], windows["ok"]), (4, 2))
        self.assertEqual(
            {w["error_code"] for w in windows["failed"]}, {"injected_window_failure"}
        )
        self.assertEqual(len(windows["failed_core_spans"]), 1)
        self.assertEqual(out.counts["failed_windows"], 2)
        self.assertEqual(
            [r["status"] for r in out.windows_rows], ["ok", "failed", "failed", "ok"]
        )

    def test_zero_segments_is_a_valid_empty_document(self):
        _, out = segments_ctx({"segment_s": 1, "zero_segments": True})
        self.valid(out.document)
        self.assertEqual(out.document["rows"], [])
        self.assertEqual(
            out.document["windows"]["ok"], out.document["windows"]["total"]
        )

    def test_digest_mismatch_flag_reaches_the_entrypoint(self):
        self.assertTrue(
            segments_ctx({"digest_mismatch": True})[1].tamper_receipt_digest
        )
        self.assertFalse(segments_ctx({})[1].tamper_receipt_digest)

    def test_bad_params_fail_the_stage(self):
        for params in ({"segment_s": "x"}, {"segment_s": 0}, {"fail_windows": "a"}):
            with self.subTest(params), self.assertRaises(StageError):
                segments_ctx(params)

    def test_crash_after_n_exits_the_process(self):
        with mock.patch("os._exit", side_effect=SystemExit(stub.CRASH_EXIT)) as exit_:
            with self.assertRaises(SystemExit):
                segments_ctx({"segment_s": 1, "crash_after_n": 2})
        exit_.assert_called_once_with(stub.CRASH_EXIT)

    def test_hang_heartbeats_until_hang_s(self):
        beats = []
        ctx = make_ctx("segment", "stub_segmenter", {"hang": True, "hang_s": 1})
        ctx = ctx.__class__(**{**ctx.__dict__, "beat": lambda p, f: beats.append(p)})
        stub.run_segment(ctx)
        self.assertIn("segmenting", beats)

    def test_hang_ends_when_the_release_file_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp) / "release"
            params = {"hang": True, "hang_s": 600, "hang_release_file": str(release)}
            beats: list[str] = []
            ctx = make_ctx("segment", "stub_segmenter", params)
            ctx = ctx.__class__(
                **{**ctx.__dict__, "beat": lambda p, f: beats.append(p)}
            )
            release.write_text("")
            stub.run_segment(ctx)  # returns at once instead of sleeping 600 s
            self.assertIn("segmenting", beats)


class StubCaptionerTests(unittest.TestCase):
    def setUp(self):
        self.segments = segments_ctx({"segment_s": 1, "fail_windows": "2"})[1].document

    def test_deterministic_text_and_failed_rows_never_empty(self):
        out = stub.run_caption(caption_ctx(self.segments, {"fail_captions": "0"}))
        self.assertTrue(validate_value("artifacts.captions.v1", out.document).valid)
        rows = out.document["rows"]
        self.assertEqual(
            [(r["status"], r["error_code"]) for r in rows],
            [
                ("failed", "injected_caption_failure"),
                ("complete", None),
                ("not_captioned", "segment_failed_window"),
                ("complete", None),
            ],
        )
        self.assertTrue(all("text" not in r for r in rows if r["status"] != "complete"))
        again = stub.run_caption(caption_ctx(self.segments, {"fail_captions": "0"}))
        self.assertEqual(out.document, again.document)
        self.assertEqual(
            out.counts, {"captions": 2, "failed_captions": 1, "not_captioned": 1}
        )

    def test_zero_segments_gives_zero_captions(self):
        empty = segments_ctx({"zero_segments": True})[1].document
        out = stub.run_caption(caption_ctx(empty))
        self.assertEqual(out.document["rows"], [])

    def test_segments_are_required(self):
        with self.assertRaises(StageError):
            stub.run_caption(make_ctx("caption", "stub_captioner"))


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.flora = self.root / A / "flora"
        self.flora.mkdir(parents=True)
        for name in ("segments.json", "captions.json", "env.json", "windows.jsonl"):
            shutil.copy(NATIVE / name, self.flora / name)
        env = mock.patch.dict(
            os.environ, {"APP_ENV": "local", replay.ENV: str(self.root)}
        )
        env.start()
        self.addCleanup(env.stop)

    def segment(self, frames=None):
        ctx = make_ctx("segment", "replay_segmenter", frames=frames)
        return ctx, replay.run_segment(ctx)

    def test_replay_segments_pass_the_adapter_and_are_labelled(self):
        ctx, out = self.segment()
        self.assertTrue(validate_value("artifacts.segments.v1", out.document).valid)
        producer = out.document["producer"]
        self.assertEqual(
            (producer["module_id"], producer["engine"]["name"]),
            ("replay_segmenter", "replay"),
        )
        self.assertEqual(
            producer["model_revision"], "114a1076f70eb53f4a58ac045505db3087e79347"
        )
        rows = out.document["rows"]
        self.assertEqual(
            [(r["start"]["source_frame_id"], r["ext"]["flora"]["id"]) for r in rows],
            [("0", 0), ("60", 1), ("120", 2)],
        )
        self.assertEqual(
            rows[-1]["end"], {"source_frame_id": None, "timestamp_ns": None}
        )
        self.assertEqual(rows[0]["ext"]["replayed_from"]["gpu_name"], "Synthetic GPU")
        self.assertIn("replayed_from.json", out.extra_diagnostics)
        self.assertEqual(
            json.loads(out.extra_diagnostics["replayed_from.json"])["env"]["vllm"],
            "0.0",
        )

    def test_failed_flora_window_becomes_a_failed_row(self):
        shutil.copy(
            NATIVE / "segments_failed_window.json", self.flora / "segments.json"
        )
        _, out = self.segment()
        self.assertTrue(validate_value("artifacts.segments.v1", out.document).valid)
        self.assertEqual(
            [r["status"] for r in out.document["rows"]], ["ok", "failed_window", "ok"]
        )
        self.assertEqual(
            out.document["windows"]["failed"][0]["error_code"], "unexpected_error"
        )

    def test_overlapping_flora_segments_are_trimmed_and_the_native_span_is_kept(self):
        doc = json.loads((self.flora / "segments.json").read_text())
        doc["segments"][1]["start_frame"] = 25  # overlaps segment 0 (0-30)
        (self.flora / "segments.json").write_text(json.dumps(doc))
        _, out = self.segment()
        self.assertTrue(validate_value("artifacts.segments.v1", out.document).valid)
        flora = out.document["rows"][1]["ext"]["flora"]
        self.assertEqual(
            (flora["trimmed_start"], flora["native_start_frame"]), (True, 25)
        )
        self.assertEqual(
            out.document["rows"][1]["start"], out.document["rows"][0]["end"]
        )
        doc["segments"][1]["end_frame_exclusive"] = 28  # now fully inside segment 0
        (self.flora / "segments.json").write_text(json.dumps(doc))
        with self.assertRaises(StageError) as caught:
            self.segment()
        self.assertEqual(caught.exception.code, "replay_segment_overlap_unresolvable")

    def test_source_sha256_mismatch_is_refused(self):
        doc = json.loads((self.flora / "segments.json").read_text())
        doc["source"]["sha256"] = "b" * 64
        (self.flora / "segments.json").write_text(json.dumps(doc))
        with self.assertRaises(StageError) as caught:
            self.segment()
        self.assertEqual(caught.exception.code, "replay_source_mismatch")

    def test_unknown_recording_frame_count_and_unset_dir_are_refused(self):
        with self.assertRaises(StageError) as caught:
            replay.run_segment(
                make_ctx("segment", "replay_segmenter", source_sha="c" * 64)
            )
        self.assertEqual(caught.exception.code, "replay_not_found")
        with self.assertRaises(StageError) as caught:
            self.segment(frames=synthetic_frames(99))
        self.assertEqual(caught.exception.code, "replay_frame_count_mismatch")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(replay.ENV)
            with self.assertRaises(StageError) as caught:
                self.segment()
        self.assertEqual(caught.exception.code, "replay_dir_unset")

    def test_episode_layout_resolves_through_the_conversion_record(self):
        episode = self.root / "homer_x"
        shutil.move(str(self.root / A), str(episode))
        (episode / "source.conversion.json").write_text(
            json.dumps({"mcap_sha256": A, "source_sha256": A})
        )
        self.assertEqual(self.segment()[1].counts["segments"], 3)

    def captions(self, segments_doc):
        ctx = caption_ctx(segments_doc, module="replay_captioner")
        return replay.run_caption(ctx)

    def test_replay_captions_map_status_and_derive_labels(self):
        segments = self.segment()[1].document
        out = self.captions(segments)
        self.assertTrue(validate_value("artifacts.captions.v1", out.document).valid)
        rows = out.document["rows"]
        self.assertEqual(
            [r["status"] for r in rows], ["complete", "failed", "complete"]
        )
        self.assertEqual(rows[1]["error_code"], "failed")  # FLORA status, no text
        self.assertNotIn("text", rows[1])
        self.assertEqual(rows[0]["derived"]["short_label"], "pick up knife")
        self.assertEqual(out.document["producer"]["module_id"], "replay_captioner")
        self.assertEqual(
            out.document["producer"]["model_revision"],
            "fef0bbfe11829ca7f3539d58da7a6a2c2f109dc6",
        )

    def test_caption_for_a_failed_window_row_is_not_captioned(self):
        shutil.copy(
            NATIVE / "segments_failed_window.json", self.flora / "segments.json"
        )
        shutil.copy(
            NATIVE / "captions_failed_window.json", self.flora / "captions.json"
        )
        out = self.captions(self.segment()[1].document)
        self.assertEqual(
            [r["status"] for r in out.document["rows"]],
            ["complete", "not_captioned", "failed"],
        )
        self.assertEqual(
            out.document["rows"][2]["error_code"], "replay_caption_missing"
        )

    def test_captions_for_segments_that_are_not_flora_are_refused(self):
        with self.assertRaises(StageError) as caught:
            self.captions(segments_ctx({"segment_s": 1})[1].document)
        self.assertEqual(caught.exception.code, "replay_segments_not_flora")

    def test_captions_pinned_to_other_flora_segments_are_refused(self):
        doc = json.loads((self.flora / "captions.json").read_text())
        doc["segments_sha256"] = "0" * 64
        (self.flora / "captions.json").write_text(json.dumps(doc))
        with self.assertRaises(StageError) as caught:
            self.captions(self.segment()[1].document)
        self.assertEqual(caught.exception.code, "replay_flora_inconsistent")


class ContractGuardTests(unittest.TestCase):
    def test_empty_caption_text_cannot_be_stored_as_complete(self):
        from stateaction_processing.stage_docs import CaptionOutcome, captions_document

        segments = segments_ctx({"segment_s": 1})[1].document
        ctx = caption_ctx(segments)
        sid = segments["rows"][0]["segment_id"]
        for text in ("", "   ", "a\nb"):
            with self.subTest(text):
                doc = captions_document(
                    ctx,
                    ctx.producer(stub._FACTS),
                    [CaptionOutcome(sid, "complete", text=text)],
                )
                row = doc["rows"][0]
                self.assertEqual(row["status"], "failed")
                self.assertNotIn("text", row)
                self.assertTrue(
                    validate_bytes(
                        "artifacts.captions.v1", json.dumps(doc).encode()
                    ).valid
                )


if __name__ == "__main__":
    unittest.main()
