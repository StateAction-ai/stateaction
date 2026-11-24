"""SA-94 FLORA stage modules without a GPU: registry binding, parameters, the checkpoint guard,
provenance building, error mapping and the failure semantics, with a fake runtime in place of vLLM.
"""

import dataclasses
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from stage_helpers import make_ctx, synthetic_frames
from stateaction_contracts import validate_value

from stateaction_processing import modules
from stateaction_processing.stage_docs import StageError

FLORA = Path(__file__).resolve().parents[2] / "flora"
sys.path.insert(0, str(FLORA))

from flora_ext import manifest as MF  # noqa: E402
from flora_ext import pins, stage_glue  # noqa: E402

NATIVE = Path(__file__).resolve().parent / "fixtures/flora_native"
SMI = "NVIDIA RTX PRO 6000 Blackwell Server Edition"
KERNELS = {
    "gdn_prefill_backend": "triton",
    "dt_bias_fp32": True,
    "linear_quant_methods": ["CompressedTensorsLinearMethod"],
    "attention_backend": "vllm_default",
}
CKPT = {
    "dir": "/models/flora/x",
    "checkpoint_id": "tempseg-114a1076-fp8_per_tensor-compressed-tensors-v1",
    "manifest_sha256": "b" * 64,
    "weights_sha256": "c" * 64,
    "format": "compressed-tensors",
    "quant": "fp8_per_tensor",
    "model_revision": pins.TEMPSEG_REV,
    "published_runtime": {"vllm": "0.34.0"},
    "verification": "test",
}


_APP_ENV = os.environ.get("APP_ENV")


def tearDownModule():
    # stage_helpers.make_ctx sets APP_ENV=local for the stub modules; do not leak it into other test files.
    if _APP_ENV is None:
        os.environ.pop("APP_ENV", None)
    else:
        os.environ["APP_ENV"] = _APP_ENV


def native_segments() -> dict:
    return json.loads((NATIVE / "segments.json").read_text())


class FakeRuntime:
    def __init__(
        self, native=None, name=SMI, caption=None, batch_error=None, kernels=None
    ):
        self.native, self.name, self.caption, self.calls = native, name, caption, []
        self.batch_error, self.kernels = batch_error, kernels or KERNELS

    def gpu_name(self):
        return self.name

    def tempseg_vllm(self, mp4, work, ckpt_dir, *, batch_size, repair_budget, log):
        self.calls.append(("tempseg_vllm", ckpt_dir, batch_size, repair_budget))
        return {
            "native": self.native or native_segments(),
            "windows_rows": [{"window_index": 0, "status": "ok", "error_code": None}],
            "input_mode": "text_raw",
            "batch_error": self.batch_error,
            "cold_load_s": 204.0,
            "engine_build_s": 190.0,
            "gpu_s": 31.5,
            "workload_s": 40.0,
            "kernel_set": self.kernels,
            "engine_version": "0.34.0",
        }

    def tempseg_hf(self, mp4, work, *, repair_budget, log):
        self.calls.append(("tempseg_hf", repair_budget))
        out = self.tempseg_vllm(
            mp4, work, "-", batch_size=1, repair_budget=repair_budget, log=log
        )
        out.update(
            kernel_set={"engine": "transformers"},
            engine_version="5.22.1",
            input_mode="hf_stock",
        )
        return out

    def caption_vllm(
        self, mp4, ckpt_dir, specs, *, frame_count, batch_size, max_new_tokens, log
    ):
        self.calls.append(("caption_vllm", specs, batch_size, max_new_tokens))
        return self.caption


def caption_run(n: int, records: list, dispositions: list | None = None) -> dict:
    return {
        "records": records,
        "dispositions": dispositions
        or [{"event_index": i, "status": "caption_input"} for i in range(n)],
        "segments_s": [(float(i), float(i) + 1.0) for i in range(n)],
        "prompt_sha256s": [r["prompt_sha256"] for r in records],
        "input_mode": "text_raw",
        "batch_error": None,
        "cold_load_s": 223.0,
        "gpu_s": 12.0,
        "prep_s": 5.0,
        "kernel_set": KERNELS,
        "engine_version": "0.34.0",
    }


def flora_ctx(stage, module, gpu="RTX-PRO-6000", params=None, **kw):
    ctx = make_ctx(stage, module, params, **kw)
    return dataclasses.replace(ctx, gpu_requested=gpu, mp4_path=Path("rec.mp4"))


class RegistryBindingTests(unittest.TestCase):
    def test_every_flora_manifest_module_is_registered_and_pinned(self):
        manifest = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "packages/contracts/api/modules.json"
            ).read_text()
        )
        flora = {
            m["moduleId"]: m
            for m in manifest["modules"]
            if m["moduleId"].startswith("flora_")
        }
        self.assertEqual(set(flora), set(pins.MODULES))
        with mock.patch.dict(os.environ, {"APP_ENV": ""}):
            for module_id, (model, engine) in pins.MODULES.items():
                stage = flora[module_id]["stage"]
                self.assertEqual(stage, "segment" if model == "tempseg" else "caption")
                entry = modules.resolve(stage, f"{module_id}@1")
                self.assertFalse(entry["localOnly"])
                self.assertEqual(
                    entry["provenance"]["engine"],
                    "vllm" if engine == "vllm" else "transformers",
                )
                fn = modules.load(stage, module_id)
                self.assertTrue(callable(fn), module_id)

    def test_loading_a_module_imports_no_gpu_stack(self):
        modules.load("segment", "flora_tempseg_vllm_fp8")
        for name in ("torch", "vllm", "transformers"):
            self.assertNotIn(name, sys.modules)

    def test_an_image_without_flora_ext_fails_with_a_stable_code(self):
        from stateaction_processing.modules import flora

        ctx = flora_ctx("segment", "flora_tempseg_vllm_fp8")
        with mock.patch.dict(
            sys.modules, {"flora_ext": None, "flora_ext.stage_glue": None}
        ):
            with self.assertRaises(StageError) as caught:
                flora.run_segment_vllm(ctx)
        self.assertEqual(caught.exception.code, "flora_runtime_unavailable")


class ParamTests(unittest.TestCase):
    def test_defaults_match_the_measured_configuration(self):
        self.assertEqual(
            stage_glue.parse_params("segment", "vllm", {}),
            {"batch_size": 16, "repair_budget": 64},
        )
        self.assertEqual(
            stage_glue.parse_params("caption", "vllm", {}),
            {"batch_size": 16, "max_new_tokens": 512, "overlap": True},
        )

    def test_fixture_recipe_params_are_accepted(self):
        self.assertEqual(
            stage_glue.parse_params(
                "segment",
                "vllm",
                {"grid_profile": "human_16s_4hz", "batch_size": 8, "repair_budget": 64},
            )["batch_size"],
            8,
        )
        out = stage_glue.parse_params(
            "caption",
            "vllm",
            {"max_new_tokens": 256, "temperature": "0.0", "overlap": True},
        )
        self.assertEqual(out["max_new_tokens"], 256)

    def test_unknown_and_invalid_params_fail_closed(self):
        bad = [
            ("segment", "vllm", {"surprise": 1}, "params_unknown_key"),
            ("segment", "vllm", {"repair_budget": 65}, "params_invalid"),
            ("segment", "vllm", {"batch_size": True}, "params_invalid"),
            ("segment", "vllm", {"grid_profile": "other"}, "params_invalid"),
            ("segment", "hf", {"batch_size": 8}, "params_invalid"),
            ("caption", "vllm", {"temperature": "0.7"}, "params_invalid"),
            ("caption", "vllm", {"overlap": "yes"}, "params_invalid"),
            ("caption", "vllm", {"max_new_tokens": 0}, "params_invalid"),
        ]
        for stage, engine, params, code in bad:
            with self.subTest(params), self.assertRaises(StageError) as caught:
                stage_glue.parse_params(stage, engine, params)
            self.assertEqual(caught.exception.code, code)


class CheckpointGuardTests(unittest.TestCase):
    def publish(self, root: Path, model="tempseg") -> dict:
        spec = pins.MODELS[model]
        cid = MF.checkpoint_id(model, spec["revision"], "compressed-tensors")
        directory = root / cid
        directory.mkdir(parents=True)
        (directory / "model-00001-of-00001.safetensors").write_bytes(b"weights")
        (directory / "config.json").write_text("{}")
        source = {"source_manifest_sha256": "a" * 64}
        if model == "tempseg":
            source.update(adapter_sha256=pins.ADAPTER_SHA256, merge_digest="d" * 64)
        manifest = MF.build_manifest(
            model=model,
            fmt="compressed-tensors",
            files=MF.file_digests(directory),
            source=source,
            runtime={
                "vllm": "0.34.0",
                "torch": "2.14.0",
                "cuda": "13.0",
                "transformers": "5.22.1",
                "gpu_name": SMI,
                "gpu_arch": "sm_120",
            },
            code_revision="test",
            parity_receipt={"passed": True},
        )
        MF.write_manifest(directory, manifest)
        sha = hashlib.sha256((directory / MF.MANIFEST_NAME).read_bytes()).hexdigest()
        return {"checkpoint_id": cid, "manifest_sha256": sha}

    def test_missing_checkpoint_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(StageError) as caught:
                stage_glue.resolve_checkpoint("tempseg", Path(tmp))
        self.assertEqual(caught.exception.code, "checkpoint_missing")

    def test_published_checkpoint_resolves_with_a_weights_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            pin = self.publish(Path(tmp))
            with mock.patch.dict(pins.PUBLISHED, {"tempseg": pin}):
                info = stage_glue.resolve_checkpoint("tempseg", Path(tmp))
        self.assertEqual(info["manifest_sha256"], pin["manifest_sha256"])
        self.assertRegex(info["weights_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            (info["format"], info["quant"]), ("compressed-tensors", "fp8_per_tensor")
        )

    def test_any_other_manifest_or_file_set_is_a_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pin = self.publish(root)
            directory = root / pin["checkpoint_id"]
            weights = directory / "model-00001-of-00001.safetensors"

            def other_hash():
                return {**pin, "manifest_sha256": "e" * 64}

            def extra_file():
                (directory / "extra.bin").write_bytes(b"x")
                return pin

            def size_changed():
                (directory / "extra.bin").unlink()
                weights.write_bytes(b"other length!")
                return pin

            for name, mutate in (
                ("other manifest hash", other_hash),
                ("extra file", extra_file),
                ("size changed", size_changed),
            ):
                with self.subTest(name):
                    chosen = mutate()
                    with (
                        mock.patch.dict(pins.PUBLISHED, {"tempseg": chosen}),
                        self.assertRaises(StageError) as caught,
                    ):
                        stage_glue.resolve_checkpoint("tempseg", root)
                    self.assertEqual(caught.exception.code, "checkpoint_mismatch")

    def test_pinned_ids_name_the_published_sa93_checkpoints(self):
        self.assertEqual(
            pins.PUBLISHED["tempseg"]["checkpoint_id"],
            MF.checkpoint_id("tempseg", pins.TEMPSEG_REV, "compressed-tensors"),
        )
        self.assertEqual(
            pins.PUBLISHED["captioner"]["checkpoint_id"],
            MF.checkpoint_id("captioner", pins.CAPTIONER_REV, "compressed-tensors"),
        )

    def test_stage_never_loads_an_engine_without_the_checkpoint(self):
        runtime = FakeRuntime()
        ctx = flora_ctx("segment", "flora_tempseg_vllm_fp8")
        with (
            mock.patch.object(stage_glue, "_runtime", return_value=runtime),
            mock.patch.dict(
                os.environ, {"STATEACTION_FLORA_CHECKPOINTS": "/nonexistent"}
            ),
            self.assertRaises(StageError) as caught,
        ):
            stage_glue.run_segment(ctx, "vllm")
        self.assertEqual(caught.exception.code, "checkpoint_missing")
        self.assertEqual(runtime.calls, [])


class GpuAndErrorTests(unittest.TestCase):
    def test_gpu_matching(self):
        self.assertTrue(stage_glue.gpu_matches("RTX-PRO-6000", SMI))
        self.assertTrue(stage_glue.gpu_matches("H100", "NVIDIA H100 80GB HBM3"))
        self.assertTrue(stage_glue.gpu_matches("A100-40GB", "NVIDIA A100-SXM4-40GB"))
        self.assertFalse(stage_glue.gpu_matches("H100", "NVIDIA H200"))
        self.assertFalse(stage_glue.gpu_matches("H100", None))

    def test_unsupported_missing_and_foreign_gpus_fail_the_stage(self):
        ctx = flora_ctx("segment", "flora_tempseg_vllm_fp8")
        for gpu, observed, code in (
            ("L4", SMI, "gpu_unsupported"),
            ("RTX-PRO-6000", None, "gpu_missing"),
            ("RTX-PRO-6000", "NVIDIA L4", "gpu_unsupported"),
        ):
            with (
                self.subTest(f"{gpu} {observed}"),
                self.assertRaises(StageError) as caught,
            ):
                stage_glue.check_gpu(
                    dataclasses.replace(ctx, gpu_requested=gpu), observed
                )
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(
            stage_glue.check_gpu(ctx, SMI),
            {"requested": "RTX-PRO-6000", "observed": SMI, "matches_request": True},
        )

    def test_error_mapping_is_stable_and_never_leaks_messages(self):
        class OutOfMemoryError(RuntimeError):
            pass

        class Coded(RuntimeError):
            code = "input_mapping_failed"

        cases = [
            (StageError("checkpoint_missing"), "checkpoint_missing"),
            (Coded("x"), "input_mapping_failed"),
            (OutOfMemoryError("CUDA out of memory /secret/path"), "gpu_oom"),
            (MF.ManifestError("x"), "checkpoint_mismatch"),
            (ImportError("vllm"), "flora_runtime_unavailable"),
            (FileNotFoundError("/etc/passwd"), "flora_input_missing"),
            (ValueError("anything else"), "engine_failed"),
        ]
        for error, code in cases:
            with self.subTest(code):
                self.assertEqual(stage_glue.map_error(error).code, code)


class SegmentModuleTests(unittest.TestCase):
    def run_segment(self, native=None, engine="vllm", params=None, frames=None, **fake):
        runtime = FakeRuntime(native, **fake)
        module = "flora_tempseg_vllm_fp8" if engine == "vllm" else "flora_tempseg_hf"
        scratch = Path(self.enterContext(tempfile.TemporaryDirectory()))
        ctx = dataclasses.replace(
            flora_ctx("segment", module, params=params, frames=frames), scratch=scratch
        )
        patches = [mock.patch.object(stage_glue, "_runtime", return_value=runtime)]
        if engine == "vllm":
            patches.append(
                mock.patch.object(stage_glue, "resolve_checkpoint", return_value=CKPT)
            )
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return ctx, runtime, stage_glue.run_segment(ctx, engine)

    def test_vllm_segments_carry_the_full_provenance(self):
        ctx, runtime, out = self.run_segment(params={"batch_size": 8})
        self.assertTrue(validate_value("artifacts.segments.v1", out.document).valid)
        producer = out.document["producer"]
        self.assertEqual(producer["engine"], {"name": "vllm", "version": "0.34.0"})
        self.assertEqual(producer["model_name"], "nvidia/Flora-TempSeg")
        self.assertEqual(producer["model_revision"], pins.TEMPSEG_REV)
        self.assertEqual(producer["weights_sha256"], CKPT["weights_sha256"])
        self.assertEqual(
            producer["quant"],
            {
                "method": "fp8_per_tensor",
                "checkpoint_manifest_sha256": CKPT["manifest_sha256"],
            },
        )
        self.assertEqual(
            producer["prompt_sha256"], native_segments()["provenance"]["prompt_sha256"]
        )
        self.assertEqual(
            producer["gpu"], {"requested_type": "RTX-PRO-6000", "observed_type": SMI}
        )
        decoding = producer["decoding_params"]
        self.assertEqual(
            (
                decoding["batch_size"],
                decoding["repair_batch_size"],
                decoding["repair_budget"],
            ),
            (8, 1, 1),
        )
        self.assertEqual(decoding["quant_format"], "compressed-tensors")
        self.assertIn("gdn_prefill=triton", decoding["kernel_set"])
        self.assertEqual(runtime.calls, [("tempseg_vllm", CKPT["dir"], 8, 1)])
        self.assertEqual(out.observed_gpu, SMI)
        self.assertEqual(
            (out.counts["cold_load_ms"], out.counts["gpu_ms"]), (204000, 31500)
        )
        blob = json.loads(out.extra_diagnostics["provenance.json"])
        self.assertEqual(blob["checkpoint"]["manifest_sha256"], CKPT["manifest_sha256"])
        self.assertNotIn("dir", blob["checkpoint"])
        self.assertEqual(blob["timing"]["cold_load_s"], 204.0)
        self.assertIn("native_segments.json", out.extra_diagnostics)

    def test_repair_cap_uses_the_full_frame_timeline_and_configured_ceiling(self):
        for duration_s, configured, expected in (
            (12, 64, 1),
            (13, 64, 2),
            (299, 64, 25),
            (600, 64, 50),
            (600, 10, 10),
            (1697, 64, 64),
        ):
            for engine in ("vllm", "hf"):
                with self.subTest(
                    duration_s=duration_s, configured=configured, engine=engine
                ):
                    frames = synthetic_frames(count=duration_s * 10, step_us=100_000)
                    native = native_segments()
                    native["source"]["frames"] = len(frames)
                    native["source"]["duration_s"] = duration_s
                    _, runtime, out = self.run_segment(
                        native=native,
                        engine=engine,
                        params={"repair_budget": configured},
                        frames=frames,
                    )
                    self.assertEqual(runtime.calls[0][-1], expected)
                    self.assertEqual(
                        out.document["producer"]["decoding_params"]["repair_budget"],
                        expected,
                    )

    def test_native_seconds_are_kept_so_captions_can_use_the_native_span(self):
        _ctx, _rt, out = self.run_segment()
        flora = out.document["rows"][1]["ext"]["flora"]
        self.assertEqual(
            (flora["native_start_s"], flora["native_end_s"]), ("1.0", "2.0")
        )
        self.assertNotIn("replayed_from", out.document["rows"][1]["ext"])

    def test_failed_windows_are_failed_rows_not_gaps(self):
        native = json.loads((NATIVE / "segments_failed_window.json").read_text())
        _ctx, _rt, out = self.run_segment(native)
        self.assertTrue(validate_value("artifacts.segments.v1", out.document).valid)
        self.assertEqual(
            [r["status"] for r in out.document["rows"]], ["ok", "failed_window", "ok"]
        )
        self.assertEqual(out.counts["failed_windows"], 1)

    def test_a_recording_with_other_frame_count_is_refused(self):
        native = native_segments()
        native["source"]["frames"] = 99
        with self.assertRaises(StageError) as caught:
            self.run_segment(native)
        self.assertEqual(caught.exception.code, "frame_count_mismatch")

    def test_a_segment_covered_by_its_predecessor_is_dropped_and_recorded(self):
        native = native_segments()
        native["segments"][1].update(start_frame=25, end_frame_exclusive=28)
        _ctx, _rt, out = self.run_segment(native)
        self.assertTrue(validate_value("artifacts.segments.v1", out.document).valid)
        self.assertEqual(len(out.document["rows"]), 2)
        self.assertEqual(out.counts["dropped_covered_segments"], 1)
        blob = json.loads(out.extra_diagnostics["provenance.json"])
        self.assertEqual(blob["covered_segments_dropped"][0]["id"], 1)
        # and it is recorded in segments.json itself, on the covering row, never only in diagnostics
        mark = out.document["rows"][0]["ext"]["flora_dropped"]
        self.assertEqual(
            (mark["reason"], mark["count"], mark["ids"], mark["spans"]),
            ("dropped_covered_by_predecessor", 1, "1", "25-28"),
        )
        self.assertNotIn("flora_dropped", out.document["rows"][1]["ext"])
        self.assertEqual(
            out.document["producer"]["decoding_params"]["covered_dropped"], 1
        )

    def test_no_drop_means_no_marker(self):
        _ctx, _rt, out = self.run_segment()
        self.assertTrue(
            all("flora_dropped" not in r["ext"] for r in out.document["rows"])
        )
        self.assertEqual(
            out.document["producer"]["decoding_params"]["covered_dropped"], 0
        )

    def test_header_batch_size_is_the_measured_one_after_a_failed_batched_call(self):
        _ctx, _rt, out = self.run_segment(
            params={"batch_size": 8}, batch_error="OutOfMemoryError: CUDA"
        )
        d = out.document["producer"]["decoding_params"]
        self.assertEqual(
            (d["batch_size"], d["batch_requested"], d["batch_fallback"]), (1, 8, True)
        )
        _ctx, _rt, ok = self.run_segment(params={"batch_size": 8})
        d = ok.document["producer"]["decoding_params"]
        self.assertEqual(
            (d["batch_size"], d["batch_requested"], d["batch_fallback"]), (8, 8, False)
        )

    def test_dt_bias_flag_is_what_the_engine_reported(self):
        wrong = {**KERNELS, "dt_bias_fp32": False}
        _ctx, _rt, out = self.run_segment(kernels=wrong)
        self.assertIs(
            out.document["producer"]["decoding_params"]["dt_bias_fp32"], False
        )

    def test_weights_hash_kind_says_what_the_hash_is(self):
        _ctx, _rt, vllm = self.run_segment()
        _ctx, _rt, hf = self.run_segment(engine="hf")
        self.assertEqual(
            vllm.document["producer"]["decoding_params"]["weights_hash_kind"],
            "published_manifest_file_hashes",
        )
        self.assertEqual(
            hf.document["producer"]["decoding_params"]["weights_hash_kind"],
            "pinned_adapter_sha256_constant",
        )

    def test_kernel_set_derives_dt_bias_from_engine_dtypes(self):
        from flora_ext import stage_runtime

        def inspect(dtype):
            return {
                "quant_methods": {},
                "gdn_param_dtypes": {f"dt_bias:{dtype}": 24, "A_log:torch.float32": 24},
            }

        self.assertTrue(
            stage_runtime.kernel_set(inspect("torch.float32"))["dt_bias_fp32"]
        )
        self.assertFalse(
            stage_runtime.kernel_set(inspect("torch.bfloat16"))["dt_bias_fp32"]
        )
        self.assertFalse(
            stage_runtime.kernel_set({"quant_methods": {}})["dt_bias_fp32"]
        )

    def test_adapter_refusals_are_not_named_replay(self):
        native = native_segments()
        native["segments"][1].update(start_frame=50, end_frame_exclusive=500)
        with self.assertRaises(StageError) as caught:
            self.run_segment(native)
        self.assertEqual(caught.exception.code, "flora_segment_out_of_range")

    def test_hf_fallback_runs_the_reference_path_with_no_quant(self):
        _ctx, runtime, out = self.run_segment(engine="hf")
        producer = out.document["producer"]
        self.assertEqual(producer["engine"]["name"], "transformers")
        self.assertIsNone(producer["quant"])
        self.assertEqual(producer["weights_sha256"], pins.ADAPTER_SHA256)
        self.assertEqual(producer["decoding_params"]["batch_size"], 1)
        self.assertEqual(runtime.calls[0][0], "tempseg_hf")

    def test_an_engine_crash_is_a_stage_failure_with_a_code(self):
        runtime = FakeRuntime()
        runtime.tempseg_vllm = mock.Mock(side_effect=RuntimeError("secret detail"))
        ctx = flora_ctx("segment", "flora_tempseg_vllm_fp8")
        with (
            mock.patch.object(stage_glue, "_runtime", return_value=runtime),
            mock.patch.object(stage_glue, "resolve_checkpoint", return_value=CKPT),
            self.assertRaises(StageError) as caught,
        ):
            stage_glue.run_segment(ctx, "vllm")
        self.assertEqual(caught.exception.code, "engine_failed")
        self.assertNotIn("secret", str(caught.exception))


class CaptionModuleTests(unittest.TestCase):
    def segments_doc(self, native=None):
        ctx = flora_ctx("segment", "flora_tempseg_vllm_fp8")
        with (
            mock.patch.object(stage_glue, "_runtime", return_value=FakeRuntime(native)),
            mock.patch.object(stage_glue, "resolve_checkpoint", return_value=CKPT),
        ):
            return stage_glue.run_segment(ctx, "vllm").document

    def caption(self, doc, run, params=None):
        raw = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
        ctx = flora_ctx(
            "caption",
            "flora_captioner_vllm_fp8",
            params=params,
            segments=doc,
            segments_sha256=hashlib.sha256(raw).hexdigest(),
        )
        runtime = FakeRuntime(caption=run)
        ck = {
            **CKPT,
            "checkpoint_id": "captioner-x",
            "model_revision": pins.CAPTIONER_REV,
        }
        with (
            mock.patch.object(stage_glue, "_runtime", return_value=runtime),
            mock.patch.object(stage_glue, "resolve_checkpoint", return_value=ck),
        ):
            return ctx, runtime, stage_glue.run_caption(ctx, "vllm")

    def test_one_caption_per_segment_and_failures_keep_the_status_as_code(self):
        doc = self.segments_doc()
        p = "1" * 64
        run = caption_run(
            3,
            [
                {
                    "event_index": 0,
                    "status": "complete",
                    "text": "Pick up cup, place on table",
                    "prompt_sha256": p,
                },
                {
                    "event_index": 1,
                    "status": "failed",
                    "error_code": "finish_reason_length",
                    "prompt_sha256": "2" * 64,
                },
            ],
            [
                {"event_index": 0, "status": "caption_input"},
                {"event_index": 1, "status": "caption_input"},
                {"event_index": 2, "status": "unsupported_target_frames"},
            ],
        )
        ctx, runtime, out = self.caption(doc, run)
        self.assertTrue(validate_value("artifacts.captions.v1", out.document).valid)
        rows = out.document["rows"]
        self.assertEqual(len(rows), 3)
        self.assertEqual(
            [(r["status"], r.get("error_code")) for r in rows],
            [
                ("complete", None),
                ("failed", "finish_reason_length"),
                ("failed", "unsupported_target_frames"),
            ],
        )
        self.assertTrue(all("text" not in r for r in rows if r["status"] == "failed"))
        self.assertEqual(out.counts["failed_captions"], 2)
        producer = out.document["producer"]
        self.assertEqual(producer["engine"], {"name": "vllm", "version": "0.34.0"})
        self.assertEqual(producer["decoding_params"]["max_new_tokens"], 512)
        self.assertEqual(producer["decoding_params"]["prompt_count"], 2)
        self.assertEqual(
            producer["prompt_sha256"],
            hashlib.sha256((p + "\n" + "2" * 64 + "\n").encode()).hexdigest(),
        )
        self.assertEqual(runtime.calls[0][2:], (16, 512))

    def test_captions_use_the_native_span_unless_overlap_is_off(self):
        doc = self.segments_doc()
        run = caption_run(3, [])
        _ctx, runtime, _out = self.caption(doc, run)
        self.assertEqual(
            [(s["start_s"], s["end_s"]) for s in runtime.calls[0][1]],
            [(0.0, 1.0), (1.0, 2.0), (2.0, 3.3)],
        )
        _ctx, runtime, _out = self.caption(doc, run, {"overlap": False})
        self.assertEqual(
            [sorted(s) for s in runtime.calls[0][1]], [["end_frame", "start_frame"]] * 3
        )

    def test_a_failed_window_row_is_not_captioned_and_not_sent_to_the_model(self):
        native = json.loads((NATIVE / "segments_failed_window.json").read_text())
        doc = self.segments_doc(native)
        run = caption_run(
            2,
            [
                {
                    "event_index": 0,
                    "status": "complete",
                    "text": "Reach, grasp",
                    "prompt_sha256": "3" * 64,
                }
            ],
            [
                {"event_index": 0, "status": "caption_input"},
                {"event_index": 1, "status": "caption_input"},
            ],
        )
        _ctx, runtime, out = self.caption(doc, run)
        self.assertEqual(len(runtime.calls[0][1]), 2)  # only the two ok rows
        statuses = [(r["status"], r.get("error_code")) for r in out.document["rows"]]
        self.assertEqual(statuses[1], ("not_captioned", "segment_failed_window"))
        self.assertEqual(statuses[2], ("failed", "caption_missing"))

    def test_caption_header_batch_size_after_a_failed_batched_call(self):
        doc = self.segments_doc()
        run = {**caption_run(3, []), "batch_error": "OutOfMemoryError: x"}
        _ctx, _rt, out = self.caption(doc, run)
        d = out.document["producer"]["decoding_params"]
        self.assertEqual(
            (d["batch_size"], d["batch_requested"], d["batch_fallback"]), (1, 16, True)
        )
        self.assertEqual(d["weights_hash_kind"], "published_manifest_file_hashes")

    def test_nothing_planned_is_a_truthful_all_failed_document(self):
        doc = self.segments_doc()
        run = caption_run(
            3,
            [],
            [
                {"event_index": i, "status": "unsupported_target_frames"}
                for i in range(3)
            ],
        )
        _ctx, _rt, out = self.caption(doc, run)
        self.assertTrue(validate_value("artifacts.captions.v1", out.document).valid)
        self.assertEqual(out.counts["failed_captions"], 3)
        self.assertEqual(out.document["producer"]["decoding_params"]["prompt_count"], 0)


if __name__ == "__main__":
    unittest.main()
