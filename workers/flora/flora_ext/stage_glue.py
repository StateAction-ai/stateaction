"""Contract glue of the FLORA stage modules (SA-94): parameters, checkpoint guard, provenance, error mapping.

The registry entries in `stateaction_processing.modules.flora` call `run_segment` / `run_caption` here.
Everything in this file imports without a GPU; the engines live in `stage_runtime` and are imported
only when a stage actually runs. Rules this file enforces:

* a vLLM module loads only the checkpoint pinned in `pins.PUBLISHED` (MANIFEST sha256 and id) and fails
  `checkpoint_missing` / `checkpoint_mismatch`; it never quantizes at job time;
* a failed window or caption is a row with an `error_code`, never an empty result, and a stage that
  cannot produce a truthful document raises `StageError`;
* provenance carries only measured values: the observed GPU is `nvidia-smi`'s, batch size and kernel set
  are what the engine ran with (a batched call that failed and was rerun at batch 1 is recorded as batch 1).
  `weights_sha256` is NOT a hash of the loaded bytes: vLLM modules carry the digest of the file hashes in the
  pinned published MANIFEST; HF TempSeg carries the pinned adapter sha256 constant; HF Captioner carries
  the sha256 of the snapshot's SOURCE_MANIFEST.sha256 file. `decoding_params.weights_hash_kind` names which.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from stateaction_processing.flora_adapter import (
    canonical_bytes,
    code_of,
    segments_from_flora,
)
from stateaction_processing.stage_docs import (
    CaptionOutcome,
    ModuleOutput,
    ProducerFacts,
    StageContext,
    StageError,
    captions_document,
    segments_document,
)

from . import manifest as MF
from . import pins

DEFAULT_BATCH_SIZE = (
    16  # max_num_seqs of the T08 parity receipts; vLLM is not batch-invariant
)
GRID = {"core_s": 12, "view_s": 16, "guard_s": 2, "fps": 4, "profile": "human_16s_4hz"}
SEGMENT_DECODING = {
    "temperature": "0.0",
    "num_beams": 1,
    "max_new_tokens": 1024,
    "max_context_tokens": 32768,
    "frame_max_pixels": 40000,
    "max_pixels": 589824,
    "max_frames": 128,
}
_GPU_NAME = re.compile(r"[^A-Za-z0-9 ._()+-]")


# ---------------------------------------------------------------------------------- parameters


def _int(name: str, value: Any, low: int, high: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not low <= value <= high
    ):
        raise StageError("params_invalid")
    return value


def parse_params(stage: str, engine: str, params: dict[str, Any]) -> dict[str, Any]:
    """Recipe stage params -> effective settings. Unknown keys and out-of-range values fail closed."""
    if stage == "segment":
        allowed = {"grid_profile", "batch_size", "repair_budget"}
    else:
        allowed = {"max_new_tokens", "temperature", "overlap", "batch_size"}
    if set(params) - allowed:
        raise StageError("params_unknown_key")
    out: dict[str, Any] = {}
    # The HF path is the reference: batch 1. A batch size there would be a different engine.
    batch_default = DEFAULT_BATCH_SIZE if engine == "vllm" else 1
    batch = _int("batch_size", params.get("batch_size", batch_default), 1, 64)
    if engine == "hf" and batch != 1:
        raise StageError("params_invalid")
    out["batch_size"] = batch
    if stage == "segment":
        if params.get("grid_profile", GRID["profile"]) != GRID["profile"]:
            raise StageError("params_invalid")
        # 64 is the vendor ceiling; scaling the repair cap for hour-scale input is F01.
        out["repair_budget"] = _int(
            "repair_budget", params.get("repair_budget", 64), 1, 64
        )
    else:
        out["max_new_tokens"] = _int(
            "max_new_tokens", params.get("max_new_tokens", 512), 1, 2048
        )
        if params.get("temperature", "0.0") != "0.0":
            raise StageError("params_invalid")
        overlap = params.get("overlap", True)
        if not isinstance(overlap, bool):
            raise StageError("params_invalid")
        out["overlap"] = overlap
    return out


# ------------------------------------------------------------------------------------ guards


def gpu_matches(requested: str, observed: str | None) -> bool:
    """Does the observed accelerator name denote the requested Modal GPU type?"""
    if not observed:
        return False
    upper = observed.upper()
    squashed = upper.replace("-", " ")
    tokens = [t for t in re.split(r"[-\s]+", requested.upper()) if t]
    return bool(tokens) and all(t in upper or t in squashed for t in tokens)


def observed_gpu_name(raw: str | None) -> str | None:
    if not raw:
        return None
    text = _GPU_NAME.sub(" ", raw).strip()[:128]
    return text if text and text[0].isalnum() else None


def check_gpu(ctx: StageContext, observed: str | None) -> dict[str, Any]:
    """The module runs only on a GPU its manifest qualifies, and it records what it really ran on."""
    supported = ctx.manifest["gpu"]["supported"]
    if ctx.gpu_requested not in supported:
        raise StageError("gpu_unsupported")
    if not observed:
        raise StageError("gpu_missing")
    if not any(gpu_matches(kind, observed) for kind in supported):
        raise StageError("gpu_unsupported")
    return {
        "requested": ctx.gpu_requested,
        "observed": observed,
        "matches_request": gpu_matches(ctx.gpu_requested, observed),
    }


def checkpoint_root() -> Path:
    return Path(os.environ.get("STATEACTION_FLORA_CHECKPOINTS", pins.CHECKPOINT_ROOT))


def resolve_checkpoint(model: str, root: Path | None = None) -> dict[str, Any]:
    """The published checkpoint directory this module is bound to, or a loud failure.

    `checkpoint_missing`: the pinned directory or its MANIFEST.json is absent. `checkpoint_mismatch`:
    MANIFEST.json does not hash to the pinned sha256, names another checkpoint, or the files differ
    from it (set and sizes; content hashes were verified at publish and the directory is immutable).
    """
    pin = pins.PUBLISHED[model]
    directory = (root or checkpoint_root()) / pin["checkpoint_id"]
    manifest_path = directory / MF.MANIFEST_NAME
    if not directory.is_dir() or not manifest_path.is_file():
        raise StageError("checkpoint_missing")
    raw = manifest_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != pin["manifest_sha256"]:
        raise StageError("checkpoint_mismatch")
    try:
        manifest = json.loads(raw)
    except ValueError:
        raise StageError("checkpoint_mismatch") from None
    if (
        manifest.get("checkpoint_id") != pin["checkpoint_id"]
        or manifest.get("model") != model
    ):
        raise StageError("checkpoint_mismatch")
    if MF.verify_checkpoint(directory, deep=False):
        raise StageError("checkpoint_mismatch")
    weights = {k: v for k, v in manifest["files"].items() if k.endswith(".safetensors")}
    return {
        "dir": str(directory),
        "checkpoint_id": pin["checkpoint_id"],
        "manifest_sha256": pin["manifest_sha256"],
        "weights_sha256": MF.tree_digest(weights),
        "format": manifest["format"]["name"],
        "quant": manifest["quant"]["quantization"],
        "model_revision": manifest["hf"]["revision"],
        "published_runtime": manifest["runtime"],
        "verification": "manifest sha256 pinned, file set and sizes checked; content hashes verified at publish",
    }


def map_error(exc: BaseException) -> StageError:
    """A stable stage error code for anything a runner raises. Only failures with no truthful document."""
    if isinstance(exc, StageError):
        return exc
    code = getattr(exc, "code", None)
    if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code):
        return StageError(code)
    name = type(exc).__name__
    if name == "OutOfMemoryError" or "out of memory" in str(exc).lower():
        return StageError("gpu_oom")
    if isinstance(exc, MF.ManifestError):
        return StageError("checkpoint_mismatch")
    if isinstance(exc, ImportError):
        return StageError("flora_runtime_unavailable")
    if isinstance(exc, FileNotFoundError):
        return StageError("flora_input_missing")
    return StageError("engine_failed")


def _runtime() -> Any:
    from . import stage_runtime

    return stage_runtime


# ---------------------------------------------------------------------------------- provenance


def _flat(values: dict[str, Any]) -> dict[str, Any]:
    """Flat scalar decoding params: floats become strings and long strings are cut (paramMap)."""
    out: dict[str, Any] = {}
    for key, item in values.items():
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", key):
            raise ValueError(key)
        if item is None or isinstance(item, (bool, int)):
            out[key] = item
        else:
            out[key] = str(item)[:256]
    if len(out) > 32:
        raise ValueError("too many decoding params")
    return out


def kernel_set_text(kernels: dict[str, Any] | None) -> str:
    if not kernels:
        return "none"
    if kernels.get("engine") == "transformers":
        return "transformers_default"
    methods = ",".join(kernels.get("linear_quant_methods") or []) or "unknown"
    return f"gdn_prefill={kernels.get('gdn_prefill_backend')};linear={methods};attn={kernels.get('attention_backend')}"[
        :256
    ]


def _engine_params(
    engine: str,
    params: dict[str, Any],
    run: dict[str, Any],
    ckpt: dict[str, Any] | None,
    weights_hash_kind: str,
) -> dict[str, Any]:
    fallback = bool(run.get("batch_error"))
    out: dict[str, Any] = {
        # Measured, not requested: after a failed batched call every window or caption ran alone.
        "batch_size": 1 if fallback else params["batch_size"],
        "batch_requested": params["batch_size"],
        "batch_fallback": fallback,
        "weights_hash_kind": weights_hash_kind,
        "kernel_set": kernel_set_text(run.get("kernel_set")),
        "input_mapping": run.get("input_mode"),
        "dtype": "bfloat16",
    }
    if engine == "vllm":
        out.update(
            quant_format=ckpt["format"] if ckpt else None,
            gdn_prefill_backend=pins.ENGINE["gdn_prefill_backend"],
            dt_bias_fp32=(run.get("kernel_set") or {}).get("dt_bias_fp32"),
            prefix_caching=pins.ENGINE["enable_prefix_caching"],
            max_model_len=pins.ENGINE["max_model_len"],
            seed=pins.ENGINE["seed"],
        )
    return out


def quant_block(ckpt: dict[str, Any]) -> dict[str, str]:
    return {
        "method": ckpt["quant"],
        "checkpoint_manifest_sha256": ckpt["manifest_sha256"],
    }


def segment_decoding(
    params: dict[str, Any],
    run: dict[str, Any],
    engine: str,
    ckpt: dict[str, Any] | None,
    covered_dropped: int = 0,
) -> dict[str, Any]:
    values: dict[str, Any] = {
        **SEGMENT_DECODING,
        "covered_dropped": covered_dropped,
        "grid_profile": GRID["profile"],
        "grid_core_s": GRID["core_s"],
        "grid_view_s": GRID["view_s"],
        "grid_guard_s": GRID["guard_s"],
        "fps": GRID["fps"],
        "repair_budget": params["repair_budget"],
        "repair_batch_size": 1,  # repair windows always run at batch 1
        **_engine_params(
            engine,
            params,
            run,
            ckpt,
            "published_manifest_file_hashes"
            if ckpt
            else "pinned_adapter_sha256_constant",
        ),
    }
    return _flat(values)


def caption_decoding(
    params: dict[str, Any],
    run: dict[str, Any],
    engine: str,
    ckpt: dict[str, Any] | None,
    prompts: int,
) -> dict[str, Any]:
    values: dict[str, Any] = {
        "temperature": "0.0",
        "max_new_tokens": params["max_new_tokens"],
        "overlap": params["overlap"],
        "prompt_count": prompts,
        **_engine_params(
            engine,
            params,
            run,
            ckpt,
            "published_manifest_file_hashes" if ckpt else "source_manifest_file_sha256",
        ),
    }
    return _flat(values)


def prompt_set_sha256(prompt_sha256s: list[str]) -> str:
    """Digest of the per-caption prompt digests (sorted), as the T01 fixture pack's env.json defines it."""
    return hashlib.sha256(
        "".join(p + "\n" for p in sorted(prompt_sha256s)).encode()
    ).hexdigest()


def provenance_blob(
    ctx: StageContext,
    engine: str,
    ckpt: dict[str, Any] | None,
    gpu: dict[str, Any],
    run: dict[str, Any],
    extra: dict[str, Any],
) -> bytes:
    """`provenance.json`: the full record behind the producer block (no paths, URLs or secrets)."""
    return canonical_bytes(
        {
            "module": ctx.module_ref,
            "engine": engine,
            "engine_version": run.get("engine_version"),
            "checkpoint": ckpt and {k: v for k, v in ckpt.items() if k != "dir"},
            "gpu": gpu,
            "timing": {
                "cold_load_s": run.get("cold_load_s"),
                "gpu_s": run.get("gpu_s"),
                "workload_s": run.get("workload_s"),
                "prep_s": run.get("prep_s"),
            },
            "kernel_set": run.get("kernel_set"),
            "input_mapping": run.get("input_mode"),
            "batch_error": run.get("batch_error"),
            "params": ctx.params,
            **extra,
        }
    )


def _ms(seconds: Any) -> int:
    return int(round(float(seconds or 0.0) * 1000))


# ------------------------------------------------------------------------------------ segment


def _prepare(
    ctx: StageContext, engine: str, model: str, stage: str
) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any]]:
    params = parse_params(stage, engine, ctx.params)
    runtime = _runtime()
    gpu = check_gpu(ctx, observed_gpu_name(runtime.gpu_name()))
    ckpt = resolve_checkpoint(model) if engine == "vllm" else None
    return params, ckpt, gpu


def _adapter_error(exc: StageError) -> StageError:
    return StageError(exc.code.replace("replay_", "flora_", 1))


def run_segment(ctx: StageContext, engine: str) -> ModuleOutput:
    runtime = _runtime()
    params, ckpt, gpu = _prepare(ctx, engine, "tempseg", "segment")
    work = ctx.scratch / "tempseg"
    shutil.rmtree(work, ignore_errors=True)
    try:
        if engine == "vllm":
            assert ckpt is not None
            run = runtime.tempseg_vllm(
                ctx.mp4_path,
                work,
                ckpt["dir"],
                batch_size=params["batch_size"],
                repair_budget=params["repair_budget"],
                log=ctx.log,
            )
        else:
            run = runtime.tempseg_hf(
                ctx.mp4_path, work, repair_budget=params["repair_budget"], log=ctx.log
            )
    except Exception as exc:  # noqa: BLE001 - mapped to a stable code; the stage fails, nothing is invented
        ctx.log(f"tempseg {engine} failed: {type(exc).__name__}")
        raise map_error(exc) from None
    finally:
        shutil.rmtree(work / "fc", ignore_errors=True)
    native = run["native"]
    if native["source"]["frames"] != len(ctx.frames):
        raise StageError("frame_count_mismatch")
    covered: list[dict[str, Any]] = []
    try:
        spans, total, failed = segments_from_flora(ctx, native, None, covered)
    except StageError as exc:
        raise _adapter_error(exc) from None
    prov = native["provenance"]
    revision = ckpt["model_revision"] if ckpt else pins.TEMPSEG_REV
    weights = ckpt["weights_sha256"] if ckpt else pins.ADAPTER_SHA256
    facts = ProducerFacts(
        engine_version=str(run["engine_version"]),
        model_revision=revision,
        weights_sha256=weights,
        prompt_sha256=prov["prompt_sha256"],
        quant=quant_block(ckpt) if ckpt else None,
        decoding_params=segment_decoding(params, run, engine, ckpt, len(covered)),
        observed_gpu=gpu["observed"],
    )
    document = segments_document(ctx, ctx.producer(facts), spans, total, failed)
    blob = provenance_blob(
        ctx,
        engine,
        ckpt,
        gpu,
        run,
        {
            "assembly": native.get("assembly"),
            "engine_error": native.get("engine_error"),
            "stats": native.get("stats"),
            "weights_note": "vllm: digest of the loaded checkpoint weight files; hf: sha256 of the pinned adapter",
            "overlap_rule": "later segment starts where the previous ended; native span kept in ext.flora (SA-90)",
            "covered_segments_dropped": covered,
        },
    )
    counts = {
        "frames": len(ctx.frames),
        "windows": total,
        "failed_windows": len(failed),
        "segments": len(spans),
        "dropped_covered_segments": len(covered),
        "cold_load_ms": _ms(run.get("cold_load_s")),
        "gpu_ms": _ms(run.get("gpu_s")),
    }
    return ModuleOutput(
        document=document,
        counts=counts,
        windows_rows=run["windows_rows"],
        observed_gpu=gpu["observed"],
        extra_diagnostics={
            "provenance.json": blob,
            "native_segments.json": canonical_bytes(native),
        },
    )


# ------------------------------------------------------------------------------------ caption


def caption_specs(
    ctx: StageContext, overlap: bool
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """One span spec per `ok` segment row, in row order, plus the rows themselves.

    `overlap` true (default) captions the span FLORA reported (`ext.flora.native_*`), the span the T01/T08
    captions were made on; the row's own start may have been trimmed to keep rows non-overlapping.
    Without a native span (segments not from FLORA) or with `overlap` false, the stored row span is used.
    """
    assert ctx.segments is not None
    index = {fid: i for i, fid in enumerate(ctx.frames.frame_ids)}
    specs: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    for row in ctx.segments["rows"]:
        if row["status"] != "ok":
            continue
        flora = row["ext"].get("flora") if isinstance(row.get("ext"), dict) else None
        if (
            overlap
            and isinstance(flora, dict)
            and "native_start_s" in flora
            and "native_end_s" in flora
        ):
            specs.append(
                {
                    "start_s": float(flora["native_start_s"]),
                    "end_s": float(flora["native_end_s"]),
                }
            )
        else:
            start = index.get(row["start"]["source_frame_id"])
            end_id = row["end"]["source_frame_id"]
            end = len(ctx.frames) if end_id is None else index.get(end_id)
            if start is None or end is None:
                raise StageError("segments_frame_unknown")
            specs.append({"start_frame": start, "end_frame": end})
        rows.append(row)
    return specs, rows


def caption_outcomes(
    ctx: StageContext, rows: list[dict[str, Any]], run: dict[str, Any]
) -> list[CaptionOutcome]:
    """One outcome per segment row of the captioned document; failures keep a code and never a text."""
    assert ctx.segments is not None
    by_event = {r["event_index"]: r for r in run["records"]}
    disposition = {d["event_index"]: d["status"] for d in run["dispositions"]}
    position = {row["segment_id"]: n for n, row in enumerate(rows)}
    outcomes: list[CaptionOutcome] = []
    for row in ctx.segments["rows"]:
        seg = row["segment_id"]
        if row["status"] != "ok":
            outcomes.append(
                CaptionOutcome(seg, "not_captioned", "segment_failed_window")
            )
            continue
        n = position[seg]
        status = disposition.get(n)
        if status != "caption_input":
            outcomes.append(
                CaptionOutcome(seg, "failed", code_of(status or "caption_not_planned"))
            )
            continue
        record = by_event.get(n)
        if record is None:
            outcomes.append(CaptionOutcome(seg, "failed", "caption_missing"))
        elif record["status"] == "complete":
            outcomes.append(CaptionOutcome(seg, "complete", text=record["text"]))
        else:
            outcomes.append(
                CaptionOutcome(
                    seg, "failed", code_of(record.get("error_code") or "caption_failed")
                )
            )
    return outcomes


def run_caption(ctx: StageContext, engine: str) -> ModuleOutput:
    runtime = _runtime()
    params, ckpt, gpu = _prepare(ctx, engine, "captioner", "caption")
    specs, rows = caption_specs(ctx, params["overlap"])
    try:
        if engine == "vllm":
            assert ckpt is not None
            run = runtime.caption_vllm(
                ctx.mp4_path,
                ckpt["dir"],
                specs,
                frame_count=len(ctx.frames),
                batch_size=params["batch_size"],
                max_new_tokens=params["max_new_tokens"],
                log=ctx.log,
            )
        else:
            run = runtime.caption_hf(
                ctx.mp4_path,
                specs,
                frame_count=len(ctx.frames),
                max_new_tokens=params["max_new_tokens"],
                log=ctx.log,
            )
    except Exception as exc:  # noqa: BLE001 - mapped to a stable code
        ctx.log(f"captioner {engine} failed: {type(exc).__name__}")
        raise map_error(exc) from None
    try:
        outcomes = caption_outcomes(ctx, rows, run)
    except StageError as exc:
        raise _adapter_error(exc) from None
    prompts = run["prompt_sha256s"]
    facts = ProducerFacts(
        engine_version=str(run["engine_version"]),
        model_revision=ckpt["model_revision"] if ckpt else pins.CAPTIONER_REV,
        weights_sha256=ckpt["weights_sha256"]
        if ckpt
        else _hf_weights_sha(runtime, run),
        prompt_sha256=prompt_set_sha256(prompts),
        quant=quant_block(ckpt) if ckpt else None,
        decoding_params=caption_decoding(params, run, engine, ckpt, len(prompts)),
        observed_gpu=gpu["observed"],
    )
    document = captions_document(ctx, ctx.producer(facts), outcomes)
    statuses = [r["status"] for r in document["rows"]]
    segments_by_pos = {n: row["segment_id"] for n, row in enumerate(rows)}
    inputs_blob = canonical_bytes(
        {
            "overlap": params["overlap"],
            "inputs": [
                {
                    "segment_id": segments_by_pos[d["event_index"]],
                    "event_index": d["event_index"],
                    "disposition": d["status"],
                    "span_s": list(run["segments_s"][d["event_index"]]),
                    "trimmed_row": bool(
                        (rows[d["event_index"]]["ext"].get("flora") or {}).get(
                            "trimmed_start", False
                        )
                    ),
                }
                for d in run["dispositions"]
            ],
            "prompt_sha256s": prompts,
        }
    )
    blob = provenance_blob(
        ctx,
        engine,
        ckpt,
        gpu,
        run,
        {
            "overlap_rule": "captions describe the native FLORA span; a row trimmed for non-overlap keeps its native span in ext.flora (SA-90)",
        },
    )
    return ModuleOutput(
        document=document,
        counts={
            "captions": statuses.count("complete"),
            "failed_captions": statuses.count("failed"),
            "not_captioned": statuses.count("not_captioned"),
            "cold_load_ms": _ms(run.get("cold_load_s")),
            "gpu_ms": _ms(run.get("gpu_s")),
        },
        observed_gpu=gpu["observed"],
        extra_diagnostics={"provenance.json": blob, "caption_inputs.json": inputs_blob},
    )


def _hf_weights_sha(runtime: Any, run: dict[str, Any]) -> str:
    """sha256 of the downloaded snapshot's SOURCE_MANIFEST.sha256, which lists every weight file's sha256."""
    path = Path(run["model_cache"]) / "captioner" / "SOURCE_MANIFEST.sha256"
    if not path.is_file():
        raise StageError("weights_identity_unavailable")
    return MF.sha256_file(path)
