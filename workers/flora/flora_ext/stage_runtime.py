"""GPU-side runners of the FLORA stage modules (SA-94). Heavy imports happen only inside the functions.

Four runners, two engines. The vLLM runners restore the published fp8 checkpoint and reuse the SA-93
workloads, so a stage run takes exactly the code path the T08 parity receipts measured (one batched
generate for the grid windows or the caption prompts, repair windows at batch 1, greedy). The HF
runners are the stock FLORA reference path at batch 1 and download the FP32 originals into the
container's ephemeral disk. None of them turns a failed window or caption into an empty result:
failures come back as data (`status` and `error_code`) and the contract glue stores them as failed.

Everything here runs inside a stage container; the pure mapping, provenance and guard logic lives
in `stage_glue` (importable without a GPU).
"""

from __future__ import annotations

import importlib.metadata as md
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

from . import pins, vlib, workload

TEMPSEG_ROOT = "/flora/tempseg"
CAPTIONER_ROOT = "/flora/captioner"
SEGMENT_MAX_TOKENS = 1024
GPU_UTIL = {
    "tempseg": 0.85,
    "captioner": 0.88,
}  # the values the T08 parity receipts used


def now() -> float:
    return time.monotonic()


def gpu_name() -> str | None:
    """The accelerator `nvidia-smi` reports inside the container; never the requested type."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    first = out.splitlines()[0].strip() if out else ""
    return first or None


def versions(*names: str) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for name in names:
        try:
            out[name] = md.version(name)
        except md.PackageNotFoundError:
            out[name] = None
    return out


class TimedLLM:
    """Delegates to the vLLM engine and sums the seconds spent inside `generate` (the GPU seconds)."""

    def __init__(self, llm: Any):
        self._llm = llm
        self.gpu_s = 0.0
        self.calls = 0

    def generate(self, *a: Any, **k: Any) -> Any:
        t = now()
        try:
            return self._llm.generate(*a, **k)
        finally:
            self.gpu_s += now() - t
            self.calls += 1

    def __getattr__(self, name: str) -> Any:
        return getattr(self._llm, name)


def build_vllm(
    ckpt_dir: str, model: str, batch_size: int
) -> tuple[TimedLLM, dict[str, Any]]:
    """Restore the published checkpoint (portable compressed-tensors); returns the engine and load facts."""
    from vllm import SamplingParams

    t = now()
    llm = vlib.build_llm(
        ckpt_dir,
        "portable",
        max_num_seqs=batch_size,
        videos=4 if model == "captioner" else 1,
        gpu_util=GPU_UTIL[model],
    )
    load_s = round(now() - t, 2)
    llm.generate(
        ["Hello"], SamplingParams(max_tokens=1, temperature=0.0), use_tqdm=False
    )
    first_s = round(now() - t, 2)
    inspect = llm.collective_rpc("q_inspect")[0]
    facts = {
        "engine_build_s": load_s,
        "cold_load_s": first_s,  # LLM() build plus the first token: what a single-use container pays
        "inspect": inspect,
        "vllm": md.version("vllm"),
    }
    return TimedLLM(llm), facts


def kernel_set(inspect: dict[str, Any]) -> dict[str, Any]:
    """The kernel-selecting settings of a vLLM run: configured pins plus what the engine reports."""
    methods = sorted((inspect.get("quant_methods") or {}).keys())
    dtypes = inspect.get("gdn_param_dtypes") or {}
    dt_bias = [k for k in dtypes if k.startswith("dt_bias:")]
    return {
        "gdn_prefill_backend": pins.ENGINE["gdn_prefill_backend"],
        # measured from the engine's own parameter dtypes (`q_inspect`), not assumed
        "dt_bias_fp32": bool(dt_bias) and all(k.endswith("float32") for k in dt_bias),
        "linear_quant_methods": methods,
        "attention_backend": os.environ.get("VLLM_ATTENTION_BACKEND") or "vllm_default",
        "gdn_param_dtypes": inspect.get("gdn_param_dtypes"),
        "libraries": versions(
            "vllm", "torch", "transformers", "triton", "flashinfer-python"
        ),
    }


def windows_rows(out_dir: Path) -> list[dict[str, Any]]:
    """Projection of the per-window checkpoint (`windows.jsonl`): index, status, error code, seconds."""
    path = out_dir / "windows.jsonl"
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    for line in path.read_text().splitlines()[1:]:  # the first line is the run config
        try:
            item = json.loads(line)
        except ValueError:
            continue
        rows.append(
            {
                "window_index": item.get("window_index"),
                "status": item.get("status"),
                "error_code": item.get("error_code"),
                "elapsed_s": item.get("elapsed_s"),
            }
        )
    return sorted(rows, key=lambda r: (r["window_index"] is None, r["window_index"]))


# ------------------------------------------------------------------------------------ TempSeg


def tempseg_vllm(
    mp4: Path,
    work: Path,
    ckpt_dir: str,
    *,
    batch_size: int,
    repair_budget: int,
    log: Callable[[str], None],
) -> dict[str, Any]:
    """Whole recording, one run: grid windows in one batched generate, repair windows at batch 1."""
    llm, facts = build_vllm(ckpt_dir, "tempseg", batch_size)
    log(f"vllm restored cold_load_s={facts['cold_load_s']}")
    t = now()
    res = workload.run_tempseg(
        llm,
        ckpt_dir,
        {"rec": str(mp4)},
        str(work),
        keep_native=True,
        isolate_batch_errors=True,
        retry_budget=repair_budget,
    )
    ep = res["episodes"]["rec"]
    return {
        "native": ep["native"],
        "windows_rows": windows_rows(work / "out" / "rec"),
        "input_mode": res["input_mode"],
        "batch_error": res.get("batch_error"),
        "window_records": len(res["windows"]),
        "cold_load_s": facts["cold_load_s"],
        "engine_build_s": facts["engine_build_s"],
        "gpu_s": round(llm.gpu_s, 2),
        "workload_s": round(now() - t, 2),
        "kernel_set": kernel_set(facts["inspect"]),
        "engine_version": facts["vllm"],
    }


def tempseg_hf(
    mp4: Path, work: Path, *, repair_budget: int, log: Callable[[str], None]
) -> dict[str, Any]:
    """Stock FLORA TempSeg (HF BF16 adapter on FP32 base, batch 1) through the same long-video engine."""
    os.environ.setdefault("FLORA_MODEL_CACHE", "/tmp/flora-models")
    workload.fix_path(TEMPSEG_ROOT)
    from batch_utils.longvideo.limits import Limits
    from batch_utils.longvideo.model_infer import ModelInfer
    from batch_utils.longvideo.runner import run_long

    t = now()
    infer = ModelInfer()
    log(f"hf loaded load_s={infer.load_s:.1f}")
    out_dir = work / "out" / "rec"
    native = run_long(
        mp4,
        out_dir,
        infer,
        limits=Limits.from_env(),
        retry_budget=repair_budget,
        retry_failed=True,
        cache_dir=work / "fc",
        progress=log,
    )
    return {
        "native": native,
        "windows_rows": windows_rows(out_dir),
        "input_mode": "hf_stock",
        "batch_error": None,
        "cold_load_s": round(infer.load_s, 2),
        "gpu_s": round(infer.gpu_s, 2),
        "workload_s": round(now() - t, 2),
        "kernel_set": {
            "engine": "transformers",
            "libraries": versions("torch", "transformers", "peft", "accelerate"),
        },
        "engine_version": md.version("transformers"),
        "model_cache": os.environ["FLORA_MODEL_CACHE"],
    }


# ---------------------------------------------------------------------------------- Captioner


def _captioner_modules() -> tuple[Any, Any, Any]:
    workload.fix_path(CAPTIONER_ROOT)
    import batch_utils.media as media
    import batch_utils.models as M
    import batch_utils.pipeline as P

    from .longvideo.limits import Limits

    limits = Limits.from_env()
    # FLORA's stock probe limits (120 s, 7200 frames) are for interactive upload; long recordings
    # use the same relaxed limits as the TempSeg wrapper. Nothing else about the probe changes.
    media.MAX_DURATION_S = limits.max_duration_s
    media.MAX_FRAME_COUNT = limits.max_frame_count
    media.MAX_DIMENSION = limits.max_dimension
    return media, M, P


class _ProcSpy:
    """Delegates to the real processor and records the kwargs of each call (frames, metadata, text)."""

    def __init__(self, proc: Any):
        object.__setattr__(self, "_p", proc)
        object.__setattr__(self, "calls", [])

    def __getattr__(self, k: str) -> Any:
        return getattr(self._p, k)

    def __call__(self, *a: Any, **k: Any) -> Any:
        self.calls.append(k)
        return self._p(*a, **k)


def _spans_to_seconds(specs: list[dict[str, Any]], video: Any) -> list[dict[str, Any]]:
    """`{start_s,end_s}` as given, or frame indices converted with the probed timestamps."""
    out = []
    pts = list(video.pts_us)
    for spec in specs:
        if "start_s" in spec:
            start, end = float(spec["start_s"]), float(spec["end_s"])
        else:
            start = pts[spec["start_frame"]] / 1e6
            end = (
                video.duration_s
                if spec["end_frame"] >= len(pts)
                else pts[spec["end_frame"]] / 1e6
            )
        out.append({"start_s": start, "end_s": end, "metadata": {}})
    return out


def probe_video(mp4: Path, frame_count: int) -> Any:
    """FLORA's probe of the remuxed MP4; its frame count must equal the contract frame map's."""
    media, _M, _P = _captioner_modules()
    video = media.probe(mp4)
    if len(video.pts_us) != frame_count:
        from stateaction_processing.stage_docs import StageError

        raise StageError("frame_count_mismatch")
    return video


def caption_plan(
    video: Any,
    specs: list[dict[str, Any]],
    *,
    session: Any,
    make_generate: Callable[[list[dict[str, Any]]], Callable[..., Any]],
    log: Callable[[str], None],
) -> dict[str, Any]:
    """FLORA's own caption planning and frame decoding with generation replaced by a hook.

    Runs `caption_single` (stock planning, decoding, PNG round trip and processor) so the frames, prompt
    text and token ids are exactly FLORA's. `make_generate(plans)` returns the `generate(model, proc,
    inputs, budget)` hook, called once per planned caption in plan order; its return value is ignored
    by the caller.
    """
    _media, _M, P = _captioner_modules()
    sin = _spans_to_seconds(specs, video)
    plans, disp = P.single_plans({"main": video}, sin, "Human")
    original = P.generate
    P.generate = make_generate(plans)
    try:
        P.caption_single(
            {"main": video}, sin, "Human", session, "", lambda *a, **k: None
        )
    finally:
        P.generate = original
    log(f"caption planned {len(plans)} of {len(sin)} segments")
    return {
        "dispositions": [
            {"event_index": i, "status": d["status"]} for i, d in enumerate(disp)
        ],
        "segments_s": [(s["start_s"], s["end_s"]) for s in sin],
    }


def caption_vllm(
    mp4: Path,
    ckpt_dir: str,
    specs: list[dict[str, Any]],
    *,
    frame_count: int,
    batch_size: int,
    max_new_tokens: int,
    log: Callable[[str], None],
    plan_only: bool = False,
) -> dict[str, Any]:
    """Prepare every caption input on the CPU first, then one batched generate (the T08 workload).

    Returns `records` (one per planned caption: event_index, status, text or error_code, prompt sha256),
    `dispositions` (one per input segment) and timings. When no caption could be planned the engine is
    never loaded: nothing to generate is a result, not a reason to pay a cold start.
    """
    import hashlib

    import numpy as np

    _media, M, _P = _captioner_modules()
    spy = _ProcSpy(M.processor("captioner", Path(ckpt_dir)))

    class Session:
        def load(self, kind: str) -> tuple[None, _ProcSpy]:
            return None, spy

    pending: list[dict[str, Any]] = []

    def make_generate(plans: list[dict[str, Any]]) -> Callable[..., str]:
        cur = {"k": 0}

        def record(model: Any, proc: Any, inputs: dict[str, Any], budget: int) -> str:
            call = spy.calls[-1]
            k = cur["k"]
            cur["k"] += 1
            text = call["text"][0]
            pending.append(
                {
                    "event_index": plans[k]["event_index"],
                    "text_prompt": text,
                    "prompt_sha256": hashlib.sha256(text.encode()).hexdigest(),
                    "metadata": [workload.meta_dict(m) for m in call["video_metadata"]],
                    "input_ids": inputs["input_ids"][0].tolist(),
                    "arrays": [
                        np.stack([np.asarray(f.convert("RGB")) for f in b])
                        for b in call["videos"]
                    ],
                }
            )
            spy.calls.clear()
            return "x"  # placeholder; the real text comes from the batched generate

        return record

    t = now()
    video = probe_video(mp4, frame_count)
    info = caption_plan(
        video, specs, session=Session(), make_generate=make_generate, log=log
    )
    del video
    prep_s = round(now() - t, 2)
    out: dict[str, Any] = {
        "dispositions": info["dispositions"],
        "segments_s": info["segments_s"],
        "prep_s": prep_s,
        "records": [],
        "input_mode": None,
        "batch_error": None,
        "cold_load_s": 0.0,
        "gpu_s": 0.0,
        "kernel_set": None,
        "engine_version": md.version("vllm"),
        "prompt_sha256s": [p["prompt_sha256"] for p in pending],
        "prompt_records": [
            {"event_index": p["event_index"], "prompt_sha256": p["prompt_sha256"]}
            for p in pending
        ],
    }
    if (
        not pending or plan_only
    ):  # plan_only: the CPU dry run stops before any engine is built
        return out
    from vllm import SamplingParams

    llm, facts = build_vllm(ckpt_dir, "captioner", batch_size)
    out["cold_load_s"], out["kernel_set"] = (
        facts["cold_load_s"],
        kernel_set(facts["inspect"]),
    )
    out["engine_version"] = facts["vllm"]
    log(f"vllm restored cold_load_s={facts['cold_load_s']}")
    arrays = [p["arrays"] for p in pending]
    mode, tried = vlib.pick_mode(llm, pending[0], arrays[0], SamplingParams)
    out["input_mode"] = mode
    if mode is None:
        raise _Failure("input_mapping_failed", json.dumps(tried)[:600])
    sp = SamplingParams(
        temperature=0.0, max_tokens=max_new_tokens, seed=0, skip_special_tokens=True
    )
    reqs = [vlib.make_req(mode, p, a) for p, a in zip(pending, arrays, strict=True)]
    try:
        gens: list[Any] = list(llm.generate(reqs, sp, use_tqdm=False))
    except Exception as exc:  # noqa: BLE001 - recorded; every caption is retried alone
        out["batch_error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
        gens = []
        for req in reqs:
            try:
                gens.append(llm.generate([req], sp, use_tqdm=False)[0])
            except Exception as one:  # noqa: BLE001
                gens.append(one)
    for p, g in zip(pending, gens, strict=True):
        row: dict[str, Any] = {
            "event_index": p["event_index"],
            "prompt_sha256": p["prompt_sha256"],
        }
        if isinstance(g, Exception):
            row.update(
                status="failed", error_code="generation_error", error=type(g).__name__
            )
        else:
            c = g.outputs[0]
            text = c.text.strip()
            if list(g.prompt_token_ids) != p["input_ids"]:
                row.update(status="failed", error_code="prompt_ids_differ")
            elif c.finish_reason != "stop":
                row.update(
                    status="failed", error_code=f"finish_reason_{c.finish_reason}"
                )
            elif not text:
                row.update(status="failed", error_code="empty_text")
            else:
                row.update(status="complete", text=text)
            row["generated_tokens"] = len(c.token_ids)
        out["records"].append(row)
    out["gpu_s"] = round(llm.gpu_s, 2)
    return out


def caption_hf(
    mp4: Path,
    specs: list[dict[str, Any]],
    *,
    frame_count: int,
    max_new_tokens: int,
    log: Callable[[str], None],
) -> dict[str, Any]:
    """Stock FLORA Captioner (HF BF16, batch 1); a caption that fails is recorded, not raised."""
    import hashlib

    os.environ.setdefault("FLORA_MODEL_CACHE", "/tmp/flora-models")
    _media, M, _P = _captioner_modules()
    session = M.Session()
    t = now()
    model, proc = session.load("captioner")
    cold = round(now() - t, 2)
    spy = _ProcSpy(proc)
    session.load = lambda kind: (
        model,
        spy,
    )  # the stock pipeline asks for the model again
    log(f"hf loaded load_s={cold}")
    records: list[dict[str, Any]] = []
    gpu_s = [0.0]

    def make_generate(plans: list[dict[str, Any]]) -> Callable[..., str]:
        cur = {"k": 0}

        def generate(
            model_: Any, proc_: Any, inputs: dict[str, Any], budget: int
        ) -> str:
            k = cur["k"]
            cur["k"] += 1
            text = spy.calls[-1]["text"][0] if spy.calls else ""
            spy.calls.clear()
            row: dict[str, Any] = {
                "event_index": plans[k]["event_index"],
                "prompt_sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
            started = now()
            try:
                row.update(
                    status="complete",
                    text=M.generate(model_, proc_, inputs, max_new_tokens),
                )
            except Exception as exc:  # noqa: BLE001 - recorded as failed, never an empty caption
                name = type(exc).__name__
                row.update(
                    status="failed",
                    error_code="empty_text"
                    if name == "InputErrorForModel"
                    else "generation_error",
                    error=name,
                )
            gpu_s[0] += now() - started
            records.append(row)
            return str(row.get("text", ""))

        return generate

    video = probe_video(mp4, frame_count)
    info = caption_plan(
        video, specs, session=session, make_generate=make_generate, log=log
    )
    return {
        "dispositions": info["dispositions"],
        "segments_s": info["segments_s"],
        "records": records,
        "input_mode": "hf_stock",
        "batch_error": None,
        "cold_load_s": cold,
        "gpu_s": round(gpu_s[0], 2),
        "prep_s": None,
        "kernel_set": {
            "engine": "transformers",
            "libraries": versions("torch", "transformers", "accelerate"),
        },
        "engine_version": md.version("transformers"),
        "prompt_sha256s": [r["prompt_sha256"] for r in records],
        "model_cache": os.environ["FLORA_MODEL_CACHE"],
    }


class _Failure(RuntimeError):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code = code


def ensure_path() -> None:
    """Make `flora_ext` importable when this file is executed from a worker subprocess."""
    here = str(Path(__file__).resolve().parents[1])
    if here not in sys.path:
        sys.path.insert(0, here)
