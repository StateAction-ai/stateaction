"""End-to-end long-video TempSeg: probe -> cache -> global grid -> checkpointed windows -> stitch -> segments.json."""

import asyncio
import json
import platform
import resource
import time
from bisect import bisect_left
from pathlib import Path

from .. import bootstrap
from ..config import MODELS
from .checkpoint import Checkpoint, sha256_json
from .engine import RETRY_BUDGET_VENDOR_MAX, build_engine, make_binding, stitch_runs
from .framecache import FrameCache, build_cache, wanted_frames
from .limits import Limits
from .predictor import CachedPredictor
from .probe import fast_probe

a = bootstrap.production
FLORA_COMMIT = "d8b755e"
TEMPSEG_HEAD = "b6fa34c285da54b9c3e6550d93796a705e6faaf2"
DECODING = dict(
    do_sample=False,
    num_beams=1,
    max_new_tokens=1024,
    max_time_s=300,
    use_cache=True,
    max_context_tokens=32768,
    processor=dict(fps=4, max_frames=128, min_pixels=1024, max_pixels=589824),
    frame_max_pixels=40000,
    jpeg="q98 4:4:4 round trip",
)


def peak_rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def scheduled_windows(source, pool):
    from flora_runtime.video_segmentation.fine_temporal import window_from_scope
    from flora_runtime.video_segmentation.scope_scheduler import schedule_fine_scopes

    scopes = schedule_fine_scopes(
        source_id=source.source_id,
        duration_s=source.duration_s,
        coarse_proposals=(),
        arm="no_prior_global_scan",
        window_profile_id=a.PROFILES[pool],
    )
    return [
        a.window_from_payload(window_from_scope(s).worker_payload(), source)
        for s in scopes
    ]


def _spans(windows, rows):
    out = []
    for w, r in zip(windows, rows, strict=True):
        if r["status"] == "ok":
            continue
        item = dict(
            window_index=w.window_index,
            window_id=w.scope_id,
            start_s=w.core_start_us / 1e6,
            end_s=w.core_end_us / 1e6,
            error_code=r["error_code"],
            error_detail=r["error_detail"],
        )
        out.append(item)
    return out


def merge_spans(failed):
    merged = []
    for f in failed:
        if merged and abs(merged[-1]["end_s"] - f["start_s"]) < 1e-9:
            merged[-1]["end_s"] = f["end_s"]
            merged[-1]["window_indices"].append(f["window_index"])
        else:
            merged.append(
                dict(
                    start_s=f["start_s"],
                    end_s=f["end_s"],
                    window_indices=[f["window_index"]],
                )
            )
    return merged


def provenance(extra=None):
    info = dict(
        flora_commit=FLORA_COMMIT,
        tempseg_weights_revision_pinned_in_models_json=MODELS["tempseg"]["revision"],
        tempseg_adapter_sha256=MODELS["tempseg"]["sha256"],
        tempseg_hf_head_revision_requested=TEMPSEG_HEAD,
        tempseg_note="adapter_model.safetensors is byte-identical (same LFS sha256) at the pinned revision and at the head revision",
        base_model=MODELS["tempseg_base"],
        prompt_sha256=a.TEMPLATES["human"]["prompt_sha256"],
        decoding=DECODING,
        deterministic=False,
        python=platform.python_version(),
        platform=platform.platform(),
    )
    for name in ("torch", "transformers", "peft", "accelerate", "av", "numpy", "PIL"):
        try:
            mod = __import__(name)
            info.setdefault("libraries", {})[name] = getattr(mod, "__version__", "?")
        except Exception:
            pass
    try:
        import torch

        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
            info["gpu_total_gib"] = round(
                torch.cuda.get_device_properties(0).total_memory / 1024**3, 2
            )
            info["cuda"] = torch.version.cuda
    except Exception:
        pass
    info.update(extra or {})
    return info


def run_long(
    video_path,
    out_dir,
    infer,
    *,
    limits=None,
    pool="human",
    instruction="",
    retry_budget=RETRY_BUDGET_VENDOR_MAX,
    retry_failed=True,
    cache_dir=None,
    progress=print,
    provenance_extra=None,
    use_engine=True,
):
    limits = limits or Limits()
    if not 1 <= retry_budget <= RETRY_BUDGET_VENDOR_MAX:
        raise ValueError("retry_budget must be 1..64 (vendor ceiling)")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    timing = {}
    t = time.monotonic()
    video = fast_probe(video_path, limits)
    timing["probe_s"] = round(time.monotonic() - t, 3)
    source = a.AnnotationSource(
        source_id="upload_" + video.sha256[:24],
        location=str(video.path),
        duration_s=video.duration_s,
        fps=float(video.rate),
    )
    bound = make_binding(pool)
    windows = scheduled_windows(source, pool)
    t = time.monotonic()
    wanted = wanted_frames(windows, video.pts_us)
    cache_dir = Path(cache_dir or out_dir / "framecache")
    cache_stats = build_cache(video, wanted, cache_dir)
    timing["cache_build_s"] = round(time.monotonic() - t, 3)
    cache = FrameCache(cache_dir)
    config = dict(
        pool=pool,
        decoding=DECODING,
        models=dict(MODELS),
        prompt_sha256=a.TEMPLATES[pool]["prompt_sha256"],
        instruction=instruction,
        cache_version=1,
    )
    ckpt = Checkpoint(
        out_dir / "windows.jsonl",
        dict(
            source_sha256=video.sha256,
            run_config_sha256=sha256_json(config),
            config=config,
        ),
    )
    pred = CachedPredictor(
        video, source, pool, bound, cache, ckpt, infer, instruction, retry_failed
    )
    t_all = time.monotonic()
    rows = []
    for k, w in enumerate(windows):
        rows.append(pred.window_row(w))
        if k % 10 == 0 or k == len(windows) - 1:
            progress(
                f"window {k + 1}/{len(windows)} ok={sum(r['status'] == 'ok' for r in rows)} failed={sum(r['status'] != 'ok' for r in rows)} elapsed={time.monotonic() - t_all:.1f}s"
            )
    timing["windows_s"] = round(time.monotonic() - t_all, 3)
    failed = _spans(windows, rows)
    assembly, engine_error, unresolved = None, None, []
    segs = []
    t = time.monotonic()
    if not failed and use_engine:
        engine = build_engine(pred, bound, pool, retry_budget)
        try:
            out = asyncio.run(engine.segment_async(source))
            assembly = "vendor_engine"
            for s in out:
                segs.append(
                    dict(
                        start_s=s.span.start_s,
                        end_s=s.span.end_s,
                        scope_ids=list(s.metadata.get("source_scope_ids", [])),
                        provenance=s.metadata.get("segmentation_provenance", "fine"),
                    )
                )
        except Exception as exc:
            engine_error = f"{type(exc).__name__}: {str(exc)[:300]}"
    if assembly is None:
        segs, unresolved = stitch_runs(windows, rows, video.duration_s)
        assembly = "run_stitch"
    timing["assemble_s"] = round(time.monotonic() - t, 3)
    pts = list(video.pts_us)
    index_of_window = {w.scope_id: w.window_index for w in windows}
    out_segments = []
    for n, s in enumerate(segs):
        ids = s["scope_ids"]
        start_us, end_us = round(s["start_s"] * 1e6), round(s["end_s"] * 1e6)
        sf = bisect_left(pts, start_us)
        ef = bisect_left(pts, end_us)
        core = 12.0
        out_segments.append(
            dict(
                id=n,
                start_s=s["start_s"],
                end_s=s["end_s"],
                start_frame=min(sf, len(pts) - 1),
                end_frame_exclusive=min(ef, len(pts)),
                window_ids=ids,
                window_indices=[index_of_window.get(i) for i in ids],
                stitched=len(ids) > 1,
                crosses_core_boundary=int(s["start_s"] // core)
                != int((s["end_s"] - 1e-6) // core),
                provenance=s["provenance"],
            )
        )
    result = dict(
        schema_version="flora_tempseg_long_v1",
        source=dict(
            path_name=video.path.name,
            sha256=video.sha256,
            duration_s=video.duration_s,
            frames=len(pts),
            size=list(video.size),
            fps=str(video.rate),
            constant_frame_rate=video.cfr,
        ),
        clock="seconds relative to the first source presentation timestamp; start_frame/end_frame_exclusive index decoded source frames (first frame at/after the time)",
        segments=out_segments,
        windows=dict(
            total=len(windows),
            ok=len(windows) - len(failed),
            failed=failed,
            failed_core_spans=merge_spans(failed),
            grid=dict(core_s=12, view_s=16, guard_s=2, profile=a.PROFILES[pool]),
        ),
        assembly=assembly,
        engine_error=engine_error,
        unresolved_components=unresolved,
        retry_budget=retry_budget,
        limits=limits.__dict__,
        stats=dict(
            timing,
            model_s=round(pred.stats["model_s"], 3),
            checkpoint_read_s=round(pred.stats["read_s"], 3),
            windows_reused=pred.stats["reused"],
            windows_computed=pred.stats["computed"],
            windows_failed_now=pred.stats["failed"],
            engine_window_calls=pred.calls,
            cache=cache_stats,
            peak_rss_mb=round(peak_rss_mb(), 1),
            windows_per_min=round(
                len(windows) / max(timing["windows_s"], 1e-9) * 60, 2
            ),
            segments=len(out_segments),
            stitched_segments=sum(x["stitched"] for x in out_segments),
            seam_crossing_segments=sum(
                x["crosses_core_boundary"] for x in out_segments
            ),
        ),
        provenance=provenance(provenance_extra),
    )
    cache.close()
    ckpt.close()
    (out_dir / "segments.json").write_text(
        json.dumps(result, indent=1, allow_nan=False) + "\n"
    )
    return result
