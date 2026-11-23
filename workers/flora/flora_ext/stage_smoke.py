"""Operator smoke harness for the FLORA stage modules (SA-94). Not used by jobs or CI runs of the pipeline.

Container side (`run_jobs`): every job runs one stage through the SA-90 `run-stage --io-dir` entrypoint
over a fixture MCAP (`kind: cli`, the contract path: remux, frame map, module, validated document,
receipt), or calls the module function directly over the verbatim `source.mp4` (`kind: direct`). The
direct job exists because the SA-86 `source.mcap` was RE-ENCODED from the MP4 (libx264, no B-frames),
so its pixels differ from the video the T08 restore check ran on; only the verbatim MP4 can prove that
the module code path equals the measured T08 path byte for byte.

Local side (`compare_*`): the comparisons with the T08 restored-checkpoint outputs.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from . import stage_wrapper

JOB = "019a4b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b"
RGB_PROFILE = "h264_mcap_simulation_v1"
MODULE_VERSION = 1
DEFAULT_PARAMS: dict[str, dict[str, Any]] = {"segment": {}, "caption": {}}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def recipe_for(
    stage: str, module: str, gpu: str, params: dict[str, Any], budget_s: int
) -> dict[str, Any]:
    def entry(name: str, mod: str, g: str, p: dict[str, Any], b: int) -> dict[str, Any]:
        return {
            "stage": name,
            "enabled": True,
            "module": mod,
            "params": p,
            "resources": {
                "gpu": g,
                "budgetSeconds": b,
                "maxContainers": 1,
                "retries": 0,
            },
        }

    other = "caption" if stage == "segment" else "segment"
    entries = {
        stage: entry(stage, module, gpu, params, budget_s),
        other: entry(
            other,
            "stub_segmenter@1" if other == "segment" else "stub_captioner@1",
            "none",
            {},
            60,
        ),
        "hand_pose": entry("hand_pose", "hand_pose_cpu_v1@1", "none", {}, 60),
    }
    return {
        "schemaVersion": 1,
        "recipeId": "flora_smoke@1",
        "maxJobCostUsd": "3.00",
        "stages": [entries["segment"], entries["caption"], entries["hand_pose"]],
    }


def limit_segment_rows(segments: bytes, count: int) -> bytes:
    """The first `count` rows of a segments document (a bounded caption smoke); ordinals are unchanged."""
    document = json.loads(segments)
    if count < 1 or count > len(document["rows"]):
        raise ValueError("segments_limit out of range")
    document["rows"] = document["rows"][:count]
    return json.dumps(document, separators=(",", ":")).encode()


def cli_files(
    job: dict[str, Any], mcap: bytes, segments: bytes | None
) -> dict[str, bytes]:
    """`bootstrap.json` (stage bootstrap plus v3 task input), `source.mcap` and for caption `segments.json`."""
    from stateaction_contracts import request_sha256

    stage, module = job["stage"], job["module"]
    rec = recipe_for(
        stage, module, job["gpu"], job.get("params", {}), job.get("budget_s", 1800)
    )
    manifest_sha = sha256_bytes(mcap)
    task = {
        "schemaVersion": 3,
        "jobId": JOB,
        "targetId": "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11",
        "profileRevision": "cpu-mediapipe-1",
        "kind": "process_recording",
        "sourceManifestSha256": manifest_sha,
        "rgbProfile": RGB_PROFILE,
        "recipe": rec,
        "recipeSha256": request_sha256(rec),
    }
    boot: dict[str, Any] = {
        "schemaVersion": 2,
        "jobId": JOB,
        "executionRef": "flora-smoke",
        "stage": stage,
        "module": module,
        "recipeSha256": task["recipeSha256"],
        "taskInput": task,
    }
    files = {"source.mcap": mcap}
    if stage == "caption":
        assert segments is not None
        boot["segmentsSha256"] = sha256_bytes(segments)
        files["segments.json"] = segments
    files["bootstrap.json"] = json.dumps(boot).encode()
    return files


def run_cli_job(
    job: dict[str, Any], fixtures: Path, previous: list[dict[str, Any]]
) -> dict[str, Any]:
    fixture = fixtures / job["fixture"]
    segments = job.get(
        "segments_bytes"
    )  # SA-101: the real segment stage's own document
    if job.get("segments_from") is not None:
        segments = previous[job["segments_from"]]["files"]["segments.json"]
        if job.get("segments_limit") is not None:
            segments = limit_segment_rows(segments, int(job["segments_limit"]))
    files = cli_files(job, (fixture / "source.mcap").read_bytes(), segments)
    extra = {"STATEACTION_REPLAY_DIR": str(fixtures)} if job.get("local") else {}
    if job.get("local"):
        extra["APP_ENV"] = "local"
    result = stage_wrapper.run_io_dir(
        files, deadline_s=job.get("deadline_s", 1500), extra_env=extra
    )
    receipt = result["files"].get("receipt.json")
    return {
        "kind": "cli",
        "job": job,
        "exitCode": result["exitCode"],
        "seconds": result["seconds"],
        "receipt": json.loads(receipt) if receipt else None,
        "files": result["files"],
    }


def _frame_map(mp4: Path) -> Any:
    import av

    from stateaction_processing.stage_media import FrameMap

    frames = FrameMap(
        clock_domain="mp4.container_pts", source_sha256=sha256_bytes(mp4.read_bytes())
    )
    with av.open(str(mp4)) as container:
        stream = container.streams.video[0]
        pts = sorted(
            int(p.pts * stream.time_base * 1_000_000)
            for p in container.demux(stream)
            if p.pts is not None
        )
    first = pts[0]
    for i, value in enumerate(pts):
        frames.frame_ids.append(str(i))
        frames.timestamps_ns.append(str(1_000_000_000 + (value - first) * 1000))
        frames.pts_us.append(value - first)
    return frames


def run_direct_job(
    job: dict[str, Any], fixtures: Path, previous: list[dict[str, Any]]
) -> dict[str, Any]:
    """The module function over the verbatim MP4 (no remux), exactly the call the stage entrypoint makes."""
    from stateaction_contracts import request_sha256

    from stateaction_processing import modules
    from stateaction_processing.flora_adapter import segments_from_flora
    from stateaction_processing.stage_docs import (
        ProducerFacts,
        StageContext,
        segments_document,
    )

    from . import stage_glue

    stage, module = job["stage"], job["module"]
    mp4 = fixtures / job["fixture"] / "source.mp4"
    frames = _frame_map(mp4)
    scratch = Path(tempfile.mkdtemp(prefix="flora-direct-"))
    params = job.get("params", {})
    logs: list[str] = []
    ctx = StageContext(
        stage=stage,
        job_id=JOB,
        recording_id="3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11",
        source_manifest_sha256=frames.source_sha256,
        source_sha256=frames.source_sha256,
        module_id=module.split("@")[0],
        module_version=MODULE_VERSION,
        params=params,
        params_sha256=request_sha256(params),
        gpu_requested=job["gpu"],
        frames=frames,
        scratch=scratch,
        beat=lambda _phase, _n: None,
        log=logs.append,
        mp4_path=mp4,
        manifest=modules.resolve(stage, module),
    )
    if stage == "caption":
        # The T01/T08 captions were made on the T3 segments: build the same segments document the replay
        # module would (same adapter), then caption it.
        native = json.loads(
            (fixtures / job["fixture"] / "flora" / "segments.json").read_text()
        )
        spans, total, failed = segments_from_flora(ctx, native, None)
        seg_ctx = ctx
        doc = segments_document(
            seg_ctx,
            seg_ctx.producer(ProducerFacts(engine_version="replay-1")),
            spans,
            total,
            failed,
        )
        raw = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
        import dataclasses

        ctx = dataclasses.replace(ctx, segments=doc, segments_sha256=sha256_bytes(raw))
    try:
        run = stage_glue.run_segment if stage == "segment" else stage_glue.run_caption
        out = run(ctx, job["engine"])
        error = None
    except Exception as exc:  # noqa: BLE001 - the smoke reports it
        out, error = None, getattr(exc, "code", type(exc).__name__)
    shutil.rmtree(scratch, ignore_errors=True)
    return {
        "kind": "direct",
        "job": job,
        "error": error,
        "log": logs[-30:],
        "document": out.document if out else None,
        "counts": out.counts if out else None,
        "files": {k: v for k, v in (out.extra_diagnostics if out else {}).items()},
    }


def run_jobs(jobs: list[dict[str, Any]], fixtures: str = "/fixtures") -> dict[str, Any]:
    """Run the jobs in order inside one container; later jobs may name an earlier result as input."""
    results: list[dict[str, Any]] = []
    for job in jobs:
        run = run_cli_job if job["kind"] == "cli" else run_direct_job
        results.append(run(job, Path(fixtures), results))
    return {"results": results}


# ------------------------------------------------------------------------------ local compare


def compare_segments(
    native: dict[str, Any], t08: dict[str, Any], episode: str
) -> dict[str, Any]:
    """Exact equality of the segment list with the T08 restored outputs, plus window counts."""
    ref = t08["result"]["episodes"][episode]
    got = [{"start_s": s["start_s"], "end_s": s["end_s"]} for s in native["segments"]]
    return {
        "byte_equal_segments": json.dumps(got, sort_keys=True)
        == json.dumps(ref["segments"], sort_keys=True),
        "segments": [len(got), len(ref["segments"])],
        "windows_total": [native["windows"]["total"], ref["windows_total"]],
        "windows_failed": [
            len(native["windows"]["failed"]),
            len(ref["windows_failed"])
            if isinstance(ref["windows_failed"], list)
            else ref["windows_failed"],
        ],
        "assembly": [native["assembly"], ref["assembly"]],
    }


def segment_f1(
    got: list[dict[str, float]], ref: list[dict[str, float]], iou: float = 0.75
) -> float:
    """Segment agreement F1 at an IoU threshold (greedy one-to-one matching), as the T08 parity gate."""
    used: set[int] = set()
    hits = 0
    for g in got:
        best, best_i = 0.0, -1
        for i, r in enumerate(ref):
            if i in used:
                continue
            inter = max(
                0.0, min(g["end_s"], r["end_s"]) - max(g["start_s"], r["start_s"])
            )
            union = (g["end_s"] - g["start_s"]) + (r["end_s"] - r["start_s"]) - inter
            value = inter / union if union > 0 else 0.0
            if value > best:
                best, best_i = value, i
        if best >= iou:
            used.add(best_i)
            hits += 1
    if not got or not ref:
        return 0.0
    p, r = hits / len(got), hits / len(ref)
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)


def compare_captions(
    document: dict[str, Any], t08: dict[str, Any], episode: str
) -> dict[str, Any]:
    ref = [c for c in t08["result"]["captions"] if c["ep"] == episode]
    ref.sort(key=lambda c: c["event_index"])
    rows = [r for r in document["rows"] if r["status"] != "not_captioned"]
    equal = 0
    for row, expected in zip(rows, ref, strict=False):
        if (
            row["status"] == "complete"
            and expected["status"] == "complete"
            and row["text"] == expected["caption"].strip()
        ):
            equal += 1
    return {
        "captions": [len(rows), len(ref)],
        "text_equal": equal,
        "failed": [
            sum(r["status"] == "failed" for r in rows),
            sum(c["status"] == "failed" for c in ref),
        ],
    }


# ------------------------------------------------------------------------------- CPU dry run


def dry_run(fixtures: str = "/fixtures", episode: str = "homer_33") -> dict[str, Any]:
    """Everything a GPU stage does before and after the engine, on a CPU container.

    Guards the two published checkpoints, runs the stage entrypoint over the fixture MCAP (it must end as a
    failed receipt `gpu_missing`: remux, frame map, registry and glue ran, no engine was built), plans every
    caption of the T3 segments with FLORA's own code and compares the prompt hashes with the T01 captions,
    and runs the TempSeg long-video engine with the stub predictor plus one real processor call.
    """
    import time

    from . import stage_glue
    from .stage_runtime import caption_vllm

    root = Path(fixtures) / episode
    out: dict[str, Any] = {}
    out["checkpoints"] = {}
    for model in ("tempseg", "captioner"):
        info = stage_glue.resolve_checkpoint(model)
        out["checkpoints"][model] = {k: v for k, v in info.items() if k != "dir"}
        out["checkpoints"][model]["dir_listing"] = sorted(
            p.name for p in Path(info["dir"]).iterdir()
        )
    job = {
        "kind": "cli",
        "stage": "segment",
        "module": "flora_tempseg_vllm_fp8@1",
        "gpu": "RTX-PRO-6000",
        "fixture": episode,
    }
    cli = run_cli_job(job, Path(fixtures), [])
    out["cli_without_gpu"] = {
        "exitCode": cli["exitCode"],
        "errorCode": (cli["receipt"] or {}).get("errorCode"),
        "status": (cli["receipt"] or {}).get("status"),
        "seconds": cli["seconds"],
    }
    native = json.loads((root / "flora" / "segments.json").read_text())
    specs = [{"start_s": s["start_s"], "end_s": s["end_s"]} for s in native["segments"]]
    expected = {
        c["segment_id"]: c["prompt_sha256"]
        for c in json.loads((root / "flora" / "captions.json").read_text())["captions"]
    }
    ckpt = stage_glue.resolve_checkpoint("captioner")["dir"]
    t = time.monotonic()
    plan = caption_vllm(
        root / "source.mp4",
        ckpt,
        specs,
        frame_count=native["source"]["frames"],
        batch_size=16,
        max_new_tokens=512,
        log=lambda _m: None,
        plan_only=True,
    )
    got = (
        {
            native["segments"][r["event_index"]]["id"]: r["prompt_sha256"]
            for r in plan["prompt_records"]
        }
        if "prompt_records" in plan
        else {}
    )
    out["caption_plan"] = {
        "planned": len(plan["prompt_sha256s"]),
        "segments": len(specs),
        "seconds": round(time.monotonic() - t, 1),
        "prompt_sha256_equal_to_t01": sum(
            1 for k, v in got.items() if expected.get(k) == v
        ),
        "dispositions": sorted({d["status"] for d in plan["dispositions"]}),
    }
    # FLORA's TempSeg and Captioner trees are both the package `batch_utils`: one per process.
    import subprocess
    import sys

    code = (
        "import json; from flora_ext import stage_smoke, stage_glue, workload; "
        "print('RESULT' + json.dumps(stage_smoke._tempseg_cpu("
        f"__import__('pathlib').Path({str(root / 'source.mp4')!r}), "
        f"stage_glue.resolve_checkpoint('tempseg')['dir'], workload)))"
    )
    proc = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=1200
    )
    line = next((x for x in proc.stdout.splitlines() if x.startswith("RESULT")), None)
    out["tempseg_cpu"] = (
        json.loads(line[6:]) if line else {"error": proc.stderr[-1500:]}
    )
    return out


def _tempseg_cpu(mp4: Path, ckpt: str, workload: Any) -> dict[str, Any]:
    import time

    workload.fix_path("/flora/tempseg")
    import batch_utils.models as M
    from batch_utils import bootstrap
    from batch_utils.longvideo.framecache import FrameCache, build_cache, wanted_frames
    from batch_utils.longvideo.limits import Limits
    from batch_utils.longvideo.probe import fast_probe
    from batch_utils.longvideo.runner import run_long, scheduled_windows
    from batch_utils.longvideo.stub import make_stub
    from batch_utils.preprocessing import temporal_inputs

    a = bootstrap.production
    t = time.monotonic()
    proc = M.processor("tempseg", Path(ckpt))
    video = fast_probe(mp4, Limits.from_env())
    source = a.AnnotationSource(
        source_id="upload_" + video.sha256[:24],
        location=str(video.path),
        duration_s=video.duration_s,
        fps=float(video.rate),
    )
    windows = scheduled_windows(source, "human")
    work = Path(tempfile.mkdtemp(prefix="flora-dry-"))
    build_cache(video, wanted_frames(windows[:1], video.pts_us), work / "fc")
    cache = FrameCache(work / "fc")
    plan = a.temporal_frame_plan(windows[0], list(video.pts_us))
    frames = [cache.get(i) for i in plan["source_frame_indices"]]
    inputs, _ = temporal_inputs(frames, windows[0], "human", proc, ["main"], "")
    cache.close()
    stub = run_long(
        mp4,
        work / "out",
        make_stub(),
        limits=Limits.from_env(),
        retry_budget=64,
        retry_failed=True,
        cache_dir=work / "fc2",
        progress=lambda *_a: None,
    )
    shutil.rmtree(work, ignore_errors=True)
    return {
        "windows": len(windows),
        "input_tokens_first_window": int(inputs["input_ids"].shape[1]),
        "stub_assembly": stub["assembly"],
        "stub_segments": len(stub["segments"]),
        "frames": stub["source"]["frames"],
        "seconds": round(time.monotonic() - t, 1),
    }
