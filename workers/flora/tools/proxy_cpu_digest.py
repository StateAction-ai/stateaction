#!/usr/bin/env python3
"""SA-95 CPU stage: compare FLORA model inputs from a downscaled proxy with full-resolution input.

No GPU, no model weights. FLORA source (reference copy kept outside Git) is passed as `--flora-src`.
Run each subcommand in its own process: TempSeg and Captioner both ship a package named `batch_utils`.

    proxy_cpu_digest.py ts  --flora-src .../flora-patched/tempseg --store STORE --out OUT.json --work DIR
    proxy_cpu_digest.py cap --flora-src .../flora-ref/captioner --model-dir DIR --store STORE --out OUT.json
    proxy_cpu_digest.py decode --store STORE --out OUT.json

`STORE` is the SA-86 fixture store; proxies are `STORE/proxy-spike/proxies/<ep>_<WxH>.mp4`.

ts:  the exact TempSeg per-frame chain (pyav `to_image().convert('RGB')`, JPEG q98 4:4:4 round trip, `regularize_image`
     at most 512x512, bicubic resize to at most 40,000 px) for every frame the vendor window plan selects, via FLORA's own
     `longvideo.framecache.build_cache`. Per-window sha256 of the cached pixels and mean absolute difference (uint8
     levels, 0-255) of proxy against full resolution.
cap: FLORA's own `caption_single` planning, frame decoding and processor, with generation replaced by a recorder, one
     segment at a time. Per-segment sha256 of the processor `pixel_values_videos` and mean absolute difference (in uint8
     levels: normalised units times 127.5) of proxy against full resolution.
decode: single-thread pyav decode plus RGB conversion, CPU seconds per video-minute.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

EPISODES = ("homer_33", "homer_37")
PROXIES = ("1280x720", "960x540")
VARIANTS = ("full", *PROXIES)


def variant_path(store: Path, ep: str, variant: str) -> Path:
    if variant == "full":
        return store / ep / "source.mp4"
    return store / "proxy-spike" / "proxies" / f"{ep}_{variant}.mp4"


def log(*a: object) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def stats(xs: list[float]) -> dict:
    import numpy as np

    if not xs:
        return {"n": 0}
    a = np.asarray(xs, dtype=float)
    return {
        "n": int(a.size),
        "mean": round(float(a.mean()), 4),
        "median": round(float(np.median(a)), 4),
        "p95": round(float(np.percentile(a, 95)), 4),
        "max": round(float(a.max()), 4),
    }


# --------------------------------------------------------------------------------------------- ts
def cmd_ts(a: argparse.Namespace) -> int:
    import numpy as np

    sys.path.insert(0, str(a.flora_src))
    import batch_utils  # noqa: F401  (verifies the vendor manifest)
    from batch_utils import bootstrap
    from batch_utils.longvideo.framecache import (
        FrameCache,
        build_cache,
        wanted_frames,
    )
    from batch_utils.longvideo.limits import Limits
    from batch_utils.longvideo.probe import fast_probe
    from batch_utils.longvideo.runner import scheduled_windows

    prod = bootstrap.production
    out: dict = {"stage": "cpu_tempseg_input_chain", "episodes": {}}
    for ep in EPISODES:
        videos = {
            v: fast_probe(variant_path(a.store, ep, v), Limits.from_env())
            for v in VARIANTS
        }
        full = videos["full"]
        src = prod.AnnotationSource(
            source_id="upload_" + full.sha256[:24],
            location=str(full.path),
            duration_s=full.duration_s,
            fps=float(full.rate),
        )
        windows = scheduled_windows(src, "human")
        wanted = wanted_frames(windows, full.pts_us)
        plans = [
            list(prod.temporal_frame_plan(w, list(full.pts_us))["source_frame_indices"])
            for w in windows
        ]
        caches: dict = {}
        build: dict = {}
        for v, vid in videos.items():
            same_pts = vid.pts_us == full.pts_us
            build[v] = {
                "size": list(vid.size),
                "frames": len(vid.pts_us),
                "pts_identical_to_full": same_pts,
                "source_sha256": vid.sha256,
            }
            if not same_pts:
                raise SystemExit(f"E_PTS_DIFFER {ep} {v}")
            d = a.work / ep / v
            t0, c0 = time.monotonic(), time.process_time()
            st = build_cache(vid, wanted, d)
            build[v].update(
                cache_build_wall_s=round(time.monotonic() - t0, 3),
                cache_build_process_cpu_s=round(time.process_time() - c0, 3),
                cache=st,
            )
            caches[v] = FrameCache(d)
            log(ep, v, "cache", st)
        per_window = []
        for wi, (w, idx) in enumerate(zip(windows, plans, strict=True)):
            row: dict = {
                "window_index": w.window_index,
                "scope_id": w.scope_id,
                "frames": len(idx),
                "unique_frames": len(set(idx)),
                "digest": {},
                "mad": {},
                "frame_size": {},
            }
            for v in VARIANTS:
                row["digest"][v] = caches[v].pixel_digest(idx)
                row["frame_size"][v] = [caches[v].w, caches[v].h]
            for v in PROXIES:
                if caches[v].row.keys() != caches["full"].row.keys() or (
                    caches[v].w,
                    caches[v].h,
                ) != (caches["full"].w, caches["full"].h):
                    row["mad"][v] = None
                    continue
                diffs = []
                for i in sorted(set(idx)):
                    x = np.frombuffer(caches["full"].raw(i), np.uint8).astype(np.int16)
                    y = np.frombuffer(caches[v].raw(i), np.uint8).astype(np.int16)
                    diffs.append(float(np.abs(x - y).mean()))
                row["mad"][v] = round(float(np.mean(diffs)), 4)
            row["identical_to_full"] = {
                v: row["digest"][v] == row["digest"]["full"] for v in PROXIES
            }
            per_window.append(row)
        for c in caches.values():
            c.close()
        out["episodes"][ep] = {
            "windows": len(windows),
            "wanted_frames": len(wanted),
            "videos": build,
            "per_window": per_window,
            "mad_summary": {
                v: stats([r["mad"][v] for r in per_window if r["mad"][v] is not None])
                for v in PROXIES
            },
        }
    a.out.write_text(json.dumps(out, indent=1) + "\n")
    log("wrote", a.out)
    return 0


# ------------------------------------------------------------------------------------------- cap
def cmd_cap(a: argparse.Namespace) -> int:
    import numpy as np

    sys.path.insert(0, str(a.flora_src))
    import batch_utils  # noqa: F401
    from batch_utils import bootstrap  # noqa: F401

    vendor = str(a.flora_src / "batch_utils/vendor")
    for p in (vendor, vendor + "/support", vendor + "/production_adapter"):
        sys.path.insert(0, p)
    import batch_utils.media as media
    import batch_utils.models as M
    import batch_utils.pipeline as P

    proc = M.processor("captioner", a.model_dir)
    captured: dict = {}

    def record(model: object, proc_: object, inputs: dict, budget: int) -> str:
        captured["pv"] = inputs["pixel_values_videos"].detach().cpu().numpy().copy()
        captured["ids"] = inputs["input_ids"][0].tolist()
        captured["grid"] = inputs["video_grid_thw"].tolist()
        return "x"

    class Stub:
        def load(self, kind: str) -> tuple[None, object]:
            return None, proc

    P.generate = record
    out: dict = {"stage": "cpu_captioner_processor_input", "episodes": {}}
    for ep in EPISODES:
        segs = json.loads((a.store / ep / "flora/segments.json").read_text())[
            "segments"
        ]
        if a.limit:
            segs = segs[: a.limit]
        videos = {v: media.probe(variant_path(a.store, ep, v)) for v in VARIANTS}
        rows = []
        for k, s in enumerate(segs):
            sin = [dict(start_s=s["start_s"], end_s=s["end_s"], metadata={})]
            row: dict = {"segment_id": s["id"], "digest": {}, "shape": {}, "mad": {}}
            pv: dict = {}
            for v in VARIANTS:
                captured.clear()
                t0 = time.monotonic()
                P.caption_single(
                    {"main": videos[v]}, sin, "Human", Stub(), "", lambda *x, **k: None
                )
                if "pv" not in captured:
                    row["error"] = "no_caption_input"
                    break
                pv[v] = captured["pv"]
                row["digest"][v] = hashlib.sha256(pv[v].tobytes()).hexdigest()
                row["shape"][v] = list(pv[v].shape)
                row[f"input_ids_sha256_{v}"] = hashlib.sha256(
                    json.dumps(captured["ids"]).encode()
                ).hexdigest()
                row[f"prep_s_{v}"] = round(time.monotonic() - t0, 2)
            if "error" not in row:
                for v in PROXIES:
                    if pv[v].shape != pv["full"].shape:
                        row["mad"][v] = None
                    else:
                        row["mad"][v] = round(
                            float(np.abs(pv[v] - pv["full"]).mean()) * 127.5, 4
                        )
                row["identical_to_full"] = {
                    v: row["digest"][v] == row["digest"]["full"] for v in PROXIES
                }
            rows.append(row)
            log(ep, k + 1, "/", len(segs), row.get("mad"))
        out["episodes"][ep] = {
            "segments": len(segs),
            "per_segment": rows,
            "mad_summary": {
                v: stats(
                    [r["mad"][v] for r in rows if r.get("mad", {}).get(v) is not None]
                )
                for v in PROXIES
            },
        }
    out["unit"] = "uint8 levels (normalised pixel_values_videos difference x 127.5)"
    a.out.write_text(json.dumps(out, indent=1) + "\n")
    log("wrote", a.out)
    return 0


# ---------------------------------------------------------------------------------------- decode
def cmd_decode(a: argparse.Namespace) -> int:
    import av

    out: dict = {"stage": "decode_time", "repeats": a.repeats, "episodes": {}}
    for ep in EPISODES:
        out["episodes"][ep] = {}
        for v in VARIANTS:
            p = variant_path(a.store, ep, v)
            runs = []
            for _ in range(a.repeats):
                n = 0
                t0, c0 = time.monotonic(), time.process_time()
                with av.open(str(p), options={"err_detect": "explode"}) as c:
                    s = c.streams.video[0]
                    s.codec_context.thread_count = 1
                    last = 0.0
                    for f in c.decode(s):
                        f.to_image().convert("RGB")
                        n += 1
                        last = float(f.pts * s.time_base)
                runs.append(
                    dict(
                        frames=n,
                        wall_s=time.monotonic() - t0,
                        cpu_s=time.process_time() - c0,
                        media_s=last + 1 / 30,
                    )
                )
            med = sorted(runs, key=lambda r: r["cpu_s"])[len(runs) // 2]
            out["episodes"][ep][v] = dict(
                frames=med["frames"],
                cpu_s_median=round(med["cpu_s"], 3),
                cpu_s_per_video_minute=round(med["cpu_s"] / med["media_s"] * 60, 2),
                runs_cpu_s=[round(r["cpu_s"], 3) for r in runs],
            )
            log(ep, v, out["episodes"][ep][v])
    a.out.write_text(json.dumps(out, indent=1) + "\n")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("ts", "cap", "decode"):
        sp = sub.add_parser(name)
        sp.add_argument("--store", type=Path, required=True)
        sp.add_argument("--out", type=Path, required=True)
        if name != "decode":
            sp.add_argument("--flora-src", type=Path, required=True)
        if name == "ts":
            sp.add_argument("--work", type=Path, required=True)
        if name == "cap":
            sp.add_argument("--model-dir", type=Path, required=True)
            sp.add_argument("--limit", type=int, default=None)
        if name == "decode":
            sp.add_argument("--repeats", type=int, default=3)
    a = p.parse_args()
    return {"ts": cmd_ts, "cap": cmd_cap, "decode": cmd_decode}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
