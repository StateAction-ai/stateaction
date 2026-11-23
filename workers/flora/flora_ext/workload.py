"""Fixed GPU workloads for the FP8 restore check (SA-93): TempSeg on short videos and Captioner on the T3 segments.

The same workload runs once against the freshly load-time-quantized engine and once against the restored
checkpoint, with the same batch configuration, so outputs can be compared byte for byte. Imports FLORA lazily.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

from . import vlib


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


class ProcSpy:
    def __init__(self, proc: Any):
        object.__setattr__(self, "_p", proc)
        object.__setattr__(self, "calls", [])

    def __getattr__(self, k: str) -> Any:
        return getattr(self._p, k)

    def __call__(self, *a: Any, **k: Any) -> Any:
        self.calls.append(k)
        return self._p(*a, **k)


def meta_dict(m: Any) -> dict:
    return dict(
        total_num_frames=int(m.total_num_frames),
        fps=float(m.fps),
        frames_indices=[int(i) for i in m.frames_indices],
    )


def fix_path(root: str) -> None:
    sys.path.insert(0, root)
    import batch_utils  # noqa: F401

    v = root + "/batch_utils/vendor"
    for p in (v, v + "/support", v + "/production_adapter"):
        if p not in sys.path:
            sys.path.insert(0, p)


def run_tempseg(
    llm: Any,
    model_dir: str,
    videos: dict[str, str],
    work: str,
    *,
    keep_native: bool = False,
    isolate_batch_errors: bool = False,
    retry_budget: int = 64,
) -> dict[str, Any]:
    """T3 config of the measured reference: grid windows batched (max_num_seqs 16), repair windows batch 1, greedy.

    Stage use (SA-94): `keep_native` adds each episode's full `run_long` result under `native` (what the contract
    adapter consumes), and `isolate_batch_errors` turns an exception of the one batched `generate` call into
    `batch_error` plus batch-1 live inference of every window, never a crash or an empty result.
    """
    import numpy as np
    from vllm import SamplingParams

    fix_path("/flora/tempseg")
    import batch_utils.models as M
    from batch_utils import bootstrap
    from batch_utils.longvideo.framecache import FrameCache, build_cache, wanted_frames
    from batch_utils.longvideo.limits import Limits
    from batch_utils.longvideo.probe import fast_probe
    from batch_utils.longvideo.runner import run_long, scheduled_windows
    from batch_utils.preprocessing import temporal_inputs

    a = bootstrap.production
    proc = M.processor("tempseg", Path(model_dir))
    sp = SamplingParams(
        temperature=0.0, max_tokens=1024, skip_special_tokens=True, seed=0
    )

    def build_rec(window: Any, frames: Any) -> tuple[dict, list]:
        spy = ProcSpy(proc)
        inp, _ = temporal_inputs(frames, window, "human", spy, ["main"], "")
        call = spy.calls[-1]
        inp = dict(inp)
        inp.pop("video_metadata", None)
        rec = dict(
            input_digest=tensor_digest(inp),
            input_ids=inp["input_ids"][0].tolist(),
            text_prompt=call["text"][0],
            metadata=[meta_dict(m) for m in call["video_metadata"]],
        )
        arr = [np.stack([np.asarray(f.convert("RGB")) for f in call["videos"][0]])]
        return rec, arr

    shutil.rmtree(work, ignore_errors=True)
    fc = Path(work) / "fc"
    items = []
    for ep, path in videos.items():
        video = fast_probe(Path(path), Limits.from_env())
        source = a.AnnotationSource(
            source_id="upload_" + video.sha256[:24],
            location=str(video.path),
            duration_s=video.duration_s,
            fps=float(video.rate),
        )
        windows = scheduled_windows(source, "human")
        build_cache(video, wanted_frames(windows, video.pts_us), fc / ep)
        cache = FrameCache(fc / ep)
        pts = list(video.pts_us)
        for w in windows:
            frames = [
                cache.get(i)
                for i in a.temporal_frame_plan(w, pts)["source_frame_indices"]
            ]
            rec, arr = build_rec(w, frames)
            items.append((ep, w.scope_id, w.window_index, rec, arr))
        cache.close()
    mode, tried = vlib.pick_mode(llm, items[0][3], items[0][4], SamplingParams)
    if mode is None:
        raise RuntimeError(f"E_INPUT_MAPPING {tried}")
    batch_error: str | None = None
    try:
        outs = llm.generate(
            [vlib.make_req(mode, it[3], it[4]) for it in items], sp, use_tqdm=False
        )
    except Exception as exc:  # noqa: BLE001 - recorded; windows then run live at batch 1
        if not isolate_batch_errors:
            raise
        outs, batch_error = [], f"{type(exc).__name__}: {str(exc)[:300]}"
        items_done: list = []
    else:
        items_done = items
    pre: dict = {}
    for it, o in zip(items_done, outs, strict=True):
        c = o.outputs[0]
        txt = c.text.strip()
        pre[(it[0], it[1])] = dict(
            input_digest=it[3]["input_digest"],
            gen_ids=list(c.token_ids),
            text=txt,
            complete=c.finish_reason == "stop" and bool(txt),
            prompt_ids_equal=list(o.prompt_token_ids) == it[3]["input_ids"],
        )
    recs: list[dict] = []

    def make_infer(ep: str) -> Any:
        def infer(window: Any, frames: Any) -> str:
            key = (ep, window.scope_id)
            if key in pre:
                r = dict(pre.pop(key), source="batch")
            else:
                rec, arr = build_rec(window, frames)
                o = llm.generate([vlib.make_req(mode, rec, arr)], sp, use_tqdm=False)[0]
                c = o.outputs[0]
                txt = c.text.strip()
                r = dict(
                    input_digest=rec["input_digest"],
                    gen_ids=list(c.token_ids),
                    text=txt,
                    complete=c.finish_reason == "stop" and bool(txt),
                    prompt_ids_equal=list(o.prompt_token_ids) == rec["input_ids"],
                    source="live",
                )
            r.update(ep=ep, scope_id=window.scope_id, window_index=window.window_index)
            recs.append(r)
            if not r["complete"]:
                raise InputErrorForModel(
                    "The model did not return a complete output for this input."
                )
            return r["text"]

        return infer

    eps: dict[str, Any] = {}
    for ep, path in videos.items():
        r = run_long(
            Path(path),
            Path(work) / "out" / ep,
            make_infer(ep),
            limits=Limits.from_env(),
            retry_budget=retry_budget,
            retry_failed=True,
            cache_dir=fc / ep,
        )
        eps[ep] = dict(
            segments=[
                dict(start_s=s["start_s"], end_s=s["end_s"]) for s in r["segments"]
            ],
            windows_total=r["windows"]["total"],
            windows_failed=r["windows"]["failed"],
            engine_error=r["engine_error"],
            assembly=r["assembly"],
        )
        if keep_native:
            eps[ep]["native"] = r
    out: dict[str, Any] = dict(input_mode=mode, episodes=eps, windows=recs)
    if batch_error is not None:
        out["batch_error"] = batch_error
    return out


def run_captioner(llm: Any, inputs_dir: str) -> dict[str, Any]:
    """All SA-86 caption inputs in one generate call (max_num_seqs 16), greedy, 512 tokens. Failures stay failed."""
    import numpy as np
    from vllm import SamplingParams

    data = json.loads((Path(inputs_dir) / "inputs.json").read_text())
    recs = data["records"]
    arrays = []
    for r in recs:
        z = np.load(Path(inputs_dir) / "inputs" / r["npz"])
        arrays.append([z[f"b{i}"] for i in range(len(r["metadata"]))])
    mode, tried = vlib.pick_mode(llm, recs[0], arrays[0], SamplingParams)
    if mode is None:
        raise RuntimeError(f"E_INPUT_MAPPING {tried}")
    sp = SamplingParams(
        temperature=0.0, max_tokens=512, seed=0, skip_special_tokens=True
    )
    t = time.monotonic()
    outs = llm.generate(
        [vlib.make_req(mode, r, x) for r, x in zip(recs, arrays, strict=True)],
        sp,
        use_tqdm=False,
    )
    gen_s = round(time.monotonic() - t, 2)
    rows = []
    for r, o in zip(recs, outs, strict=True):
        c = o.outputs[0]
        text = c.text.strip()
        ok = (
            c.finish_reason == "stop"
            and bool(text)
            and list(o.prompt_token_ids) == r["input_ids"]
        )
        row = dict(
            ep=r["ep"],
            event_index=r["event_index"],
            status="complete" if ok else "failed",
            finish_reason=c.finish_reason,
            gen_ids=list(c.token_ids),
            prompt_sha256=r["prompt_sha256"],
        )
        if ok:
            row["caption"] = text
        rows.append(row)
    return dict(
        input_mode=mode, gen_s=gen_s, captions=rows, dispositions=data["dispositions"]
    )
