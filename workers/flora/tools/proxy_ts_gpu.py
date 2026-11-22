#!/usr/bin/env python3
"""SA-95 GPU stage, TempSeg (T3 config: merged adapter, vLLM fp8_per_tensor, greedy). Runs on a Colab G4 VM only.

One vLLM load, then for each variant (full, 1280x720, 960x540) and each episode: FLORA's own windows, frame cache,
prompts and `run_long` assembly, exactly as the SA-86 reference run (`exp-wgo/vm/ts_vllm.py`), only the source video
changes. Grid windows of one episode are submitted as one batch; repair windows run live at batch 1.

    python proxy_ts_gpu.py --videos /content/w/videos --out /content/w/out/ts [--variants full,1280x720,960x540]

Layout expected on the VM (see `colab_bundle` in the SA-95 notes): /content/w/src/flora-hour/flora-patched/tempseg,
/content/w/src/modal-quant/{qlib,vlib,vext}.py, /content/w/models/tempseg (processor files) and
/content/w/models/tempseg-merged. `--videos` holds `<variant>/<ep>.mp4`.
No FLORA vendor file is edited. A window that does not finish cleanly is a failed window, never empty text.
"""

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

W = Path("/content/w")
SRC = W / "src"
TS_ROOT = SRC / "flora-hour/flora-patched/tempseg"
for p in (SRC / "modal-quant", Path(__file__).parent):
    sys.path.insert(0, str(p))
os.environ.setdefault("FLORA_MODEL_CACHE", str(W / "models"))
os.environ.setdefault("HF_HOME", str(W / "hf"))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ["PYTHONPATH"] = ":".join(
    [str(SRC / "modal-quant"), os.environ.get("PYTHONPATH", "")]
)


def log(*a: object) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def dump(obj: object, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, default=str))


class InputErrorForModel(RuntimeError):
    """Same class name as FLORA's, so the TempSeg predictor maps it to 'generation_incomplete'."""


def tensor_digest(inputs: dict) -> str:
    import torch

    d = {
        k: {
            "dtype": str(v.dtype),
            "shape": list(v.shape),
            "sha256": hashlib.sha256(
                v.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes()
            ).hexdigest(),
        }
        for k, v in inputs.items()
        if torch.is_tensor(v)
    }
    return hashlib.sha256(
        json.dumps(d, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def env_info() -> dict:
    import importlib.metadata as md
    import subprocess

    out: dict = {
        "python": sys.version.split()[0],
        "smi": subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,driver_version",
                "--format=csv,noheader",
            ],
            capture_output=True,
            text=True,
        ).stdout.strip(),
    }
    for n in ("vllm", "torch", "transformers", "av", "numpy", "Pillow", "triton"):
        try:
            out[n] = md.version(n)
        except Exception:
            out[n] = None
    try:
        import torch

        out["cuda"] = torch.version.cuda
    except Exception:
        pass
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--variants", default="full,1280x720,960x540")
    ap.add_argument("--episodes", default="homer_33,homer_37")
    a_ = ap.parse_args()
    variants = a_.variants.split(",")
    eps = a_.episodes.split(",")

    sys.path.insert(0, str(TS_ROOT))
    import batch_utils  # noqa: F401  (verifies the vendor manifest)

    v = str(TS_ROOT) + "/batch_utils/vendor"
    for p in (v, v + "/support", v + "/production_adapter"):
        if p not in sys.path:
            sys.path.insert(0, p)
    import batch_utils.models as M
    import numpy as np
    import qlib
    import vlib as VC
    from batch_utils import bootstrap
    from batch_utils.longvideo.framecache import FrameCache, build_cache, wanted_frames
    from batch_utils.longvideo.limits import Limits
    from batch_utils.longvideo.probe import fast_probe
    from batch_utils.longvideo.runner import run_long, scheduled_windows
    from batch_utils.preprocessing import temporal_inputs
    from vllm import SamplingParams

    prod = bootstrap.production
    a_.out.mkdir(parents=True, exist_ok=True)
    res: dict = dict(
        schema="stateaction.proxy_spike_tempseg.v1",
        ticket="SA-95",
        config="T3: adapter merged in FP32 then cast to BF16 (A_log, dt_bias FP32), vLLM fp8_per_tensor, dt_bias FP32, "
        "gdn_prefill_backend=triton, greedy, max_tokens 1024, seed 0",
        env=env_info(),
        variants={},
    )
    proc = M.processor("tempseg", W / "models/tempseg")
    t = time.monotonic()
    llm = VC.build_llm(
        str(W / "models/tempseg-merged"),
        "fp8_per_tensor",
        True,
        max_num_seqs=16,
        gpu_util=0.85,
        videos=1,
    )
    res["load_s"] = round(time.monotonic() - t, 2)
    res["inspect"] = llm.collective_rpc("q_inspect")[0]
    log("loaded", res["load_s"])
    sp = SamplingParams(
        temperature=0.0, max_tokens=1024, skip_special_tokens=True, seed=0
    )

    def build_rec(window: object, frames: list) -> tuple[dict, list]:
        spy = qlib.ProcSpy(proc)
        inp, _ = temporal_inputs(frames, window, "human", spy, ["main"], "")
        call = spy.calls[-1]
        inp = dict(inp)
        inp.pop("video_metadata", None)
        rec = dict(
            input_digest=tensor_digest(inp),
            input_ids=inp["input_ids"][0].tolist(),
            text_prompt=call["text"][0],
            metadata=[qlib.meta_dict(m) for m in call["video_metadata"]],
        )
        arr = [np.stack([np.asarray(f.convert("RGB")) for f in call["videos"][0]])]
        return rec, arr

    mode = None
    for variant in variants:
        vres: dict = dict(episodes={})
        res["variants"][variant] = vres
        OUT = a_.out / variant
        for ep in eps:
            video_file = a_.videos / variant / f"{ep}.mp4"
            FC = W / "fc" / variant / ep
            t0 = time.monotonic()
            video = fast_probe(video_file, Limits.from_env())
            source = prod.AnnotationSource(
                source_id="upload_" + video.sha256[:24],
                location=str(video.path),
                duration_s=video.duration_s,
                fps=float(video.rate),
            )
            windows = scheduled_windows(source, "human")
            c0, w0 = time.process_time(), time.monotonic()
            cache_stats = build_cache(video, wanted_frames(windows, video.pts_us), FC)
            cache_cpu_s = time.process_time() - c0
            cache_wall_s = time.monotonic() - w0
            cache = FrameCache(FC)
            pts = list(video.pts_us)
            items = []
            for w in windows:
                frames = [
                    cache.get(i)
                    for i in prod.temporal_frame_plan(w, pts)["source_frame_indices"]
                ]
                rec, arr = build_rec(w, frames)
                items.append((w.scope_id, w.window_index, rec, arr))
            cache.close()
            prep_s = time.monotonic() - t0
            log(variant, ep, "prepared", len(items), round(prep_s, 1))
            if mode is None:
                mode, tried = VC.pick_mode(
                    llm, items[0][2], items[0][3], SamplingParams
                )
                res["mode"], res["mode_attempts"] = mode, tried
                if mode is None:
                    dump(res, a_.out / "summary_failed.json")
                    raise SystemExit("E_INPUT_MAPPING: prompt ids not reproduced")
            t1 = time.monotonic()
            outs = llm.generate(
                [VC.make_req(mode, it[2], it[3]) for it in items], sp, use_tqdm=False
            )
            batch_gen_s = time.monotonic() - t1
            pre: dict = {}
            for it, o in zip(items, outs, strict=True):
                c = o.outputs[0]
                txt = c.text.strip()
                pre[it[0]] = dict(
                    input_digest=it[2]["input_digest"],
                    n_in=len(it[2]["input_ids"]),
                    gen_ids=list(c.token_ids),
                    text=txt,
                    complete=c.finish_reason == "stop" and bool(txt),
                    finish=c.finish_reason,
                    prompt_ids_equal=list(o.prompt_token_ids) == it[2]["input_ids"],
                )
            recs: list = []

            def infer(window: object, frames: list) -> str:
                if window.scope_id in pre:
                    r = dict(pre.pop(window.scope_id), source="batch")
                else:
                    rec, arr = build_rec(window, frames)
                    o = llm.generate([VC.make_req(mode, rec, arr)], sp, use_tqdm=False)[
                        0
                    ]
                    c = o.outputs[0]
                    txt = c.text.strip()
                    r = dict(
                        input_digest=rec["input_digest"],
                        n_in=len(rec["input_ids"]),
                        gen_ids=list(c.token_ids),
                        text=txt,
                        complete=c.finish_reason == "stop" and bool(txt),
                        finish=c.finish_reason,
                        prompt_ids_equal=list(o.prompt_token_ids) == rec["input_ids"],
                        source="live",
                    )
                r.update(
                    ep=ep, scope_id=window.scope_id, window_index=window.window_index
                )
                recs.append(r)
                if not r["complete"]:
                    raise InputErrorForModel(
                        "The model did not return a complete output for this input."
                    )
                return r["text"]

            t2 = time.monotonic()
            r = run_long(
                video_file,
                OUT / ep,
                infer,
                limits=Limits.from_env(),
                retry_budget=64,
                retry_failed=True,
                cache_dir=FC,
                progress=log,
            )
            vres["episodes"][ep] = dict(
                source_sha256=video.sha256,
                size=list(video.size),
                windows=r["windows"]["total"],
                failed_windows=len(r["windows"]["failed"]),
                failed_detail=r["windows"]["failed"],
                segments=len(r["segments"]),
                assembly=r["assembly"],
                engine_error=r["engine_error"],
                unresolved=len(r["unresolved_components"]),
                prep_s=round(prep_s, 2),
                cache_build_wall_s=round(cache_wall_s, 3),
                cache_build_process_cpu_s=round(cache_cpu_s, 3),
                cache=cache_stats,
                batch_gen_s=round(batch_gen_s, 2),
                run_long_s=round(time.monotonic() - t2, 2),
                model_calls=len(recs),
                live_calls=sum(x["source"] == "live" for x in recs),
                unconsumed_batch_outputs=len(pre),
                prompt_ids_equal=f"{sum(x['prompt_ids_equal'] for x in recs)}/{len(recs)}",
                duration_s=r["source"]["duration_s"],
            )
            dump(recs, OUT / ep / "records.json")
            log(variant, ep, json.dumps(vres["episodes"][ep]))
        dump(res, a_.out / "summary.json")
    log("DONE")
    dump(res, a_.out / "summary.json")
    try:
        llm.llm_engine.engine_core.shutdown()
    except Exception as e:
        log("shutdown failed", repr(e))
    os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
