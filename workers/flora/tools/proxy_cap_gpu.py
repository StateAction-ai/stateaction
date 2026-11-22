#!/usr/bin/env python3
"""SA-95 GPU stage, Captioner (C3 config: vLLM fp8_per_tensor, FP32 dt_bias, greedy, 512 tokens).

The segments are always the full-resolution T3_r1 segments of the SA-86 fixture store; only the video the frames are
decoded from changes. Reuses the SA-86 driver (`workers/processing/tools/flora_caption_colab.py`): FLORA's own
`caption_single` planning, frame decoding and processor produce the prompts and frames; vLLM generates.

    python proxy_cap_gpu.py prep --variant 1280x720 --flora-src S --model-dir M --videos V --store ST --work W
    python proxy_cap_gpu.py gen  --variants full,1280x720,960x540 --model-dir M --work W --store ST --out O

`--videos` holds `<variant>/<ep>.mp4`; `prep` writes `<work>/<variant>/inputs{,.json}`; `gen` loads the model once and
generates every variant (each variant as one batch, as in SA-86). A caption that does not stop cleanly with non-empty text
is `failed` with no caption text; it is never turned into an empty caption.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
for cand in (HERE, HERE.parent.parent / "processing/tools"):
    sys.path.insert(0, str(cand))
import flora_caption_colab as FC  # noqa: E402

EPISODES = FC.EPISODES


def patched_t3(store: Path, videos: Path, variant: str, dst: Path) -> Path:
    """T3 segment files whose recorded source sha256 is the variant video's, so FLORA prep accepts the proxy."""
    for ep in EPISODES:
        doc = json.loads((store / ep / "flora/segments.json").read_text())
        h = hashlib.sha256((videos / variant / f"{ep}.mp4").read_bytes()).hexdigest()
        doc["source"]["sha256"] = h
        (dst / ep).mkdir(parents=True, exist_ok=True)
        (dst / ep / "segments.json").write_text(json.dumps(doc))
    return dst


def cmd_prep(a: argparse.Namespace) -> int:
    work = a.work / a.variant
    t3 = patched_t3(a.store, a.videos, a.variant, a.work / f"t3_{a.variant}")
    vdir = a.work / f"videos_{a.variant}"
    vdir.mkdir(parents=True, exist_ok=True)
    for ep in EPISODES:
        link = vdir / f"{ep}.mp4"
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to((a.videos / a.variant / f"{ep}.mp4").resolve())
    ns = argparse.Namespace(
        flora_src=a.flora_src,
        model_dir=a.model_dir,
        videos=vdir,
        t3=t3,
        work=work,
        limit=a.limit,
    )
    t = time.monotonic()
    rc = FC.cmd_prep(ns)
    FC.log("prep", a.variant, "rc", rc, "s", round(time.monotonic() - t, 1))
    (work / "prep_time.json").write_text(
        json.dumps({"variant": a.variant, "prep_s": round(time.monotonic() - t, 2)})
    )
    return rc


def cmd_gen(a: argparse.Namespace) -> int:
    import numpy as np

    os.environ["QUANT_DT_BIAS_FP32"] = "1"
    os.environ["PYTHONPATH"] = ":".join([str(HERE), os.environ.get("PYTHONPATH", "")])
    from vllm import LLM, SamplingParams

    variants = a.variants.split(",")
    data: dict = {}
    for v in variants:
        d = json.loads((a.work / v / "inputs.json").read_text())
        arrays = []
        for r in d["records"]:
            z = np.load(a.work / v / "inputs" / r["npz"])
            arrays.append([z[f"b{i}"] for i in range(len(r["metadata"]))])
        data[v] = (d, arrays)
    max_videos = max(len(r["metadata"]) for d, _ in data.values() for r in d["records"])
    quant = {
        "quantization": "fp8_per_tensor",
        "quantization_config": {"ignore": FC.IGNORE},
    }
    t = time.monotonic()
    llm = LLM(
        model=str(a.model_dir),
        limit_mm_per_prompt={"image": 0, "video": max_videos},
        mm_processor_kwargs={"do_sample_frames": False},
        worker_extension_cls="flora_vllm_ext.QuantExt",
        **FC.ENGINE,
        **quant,
    )
    load_s = round(time.monotonic() - t, 2)
    FC.log("loaded", load_s)
    d0, arr0 = data[variants[0]]
    mode, tried = FC.pick_mode(llm, d0["records"][0], arr0[0], SamplingParams)
    if mode is None:
        a.out.mkdir(parents=True, exist_ok=True)
        (a.out / "failed_input_mapping.json").write_text(json.dumps(tried, indent=1))
        raise SystemExit("E_INPUT_MAPPING")
    sp = SamplingParams(
        temperature=0.0, max_tokens=FC.MAX_TOKENS, seed=0, skip_special_tokens=True
    )
    summary: dict = dict(
        schema="stateaction.proxy_spike_captioner.v1",
        ticket="SA-95",
        env=FC.env_info(),
        model=FC.weights_identity(a.model_dir),
        engine=dict(FC.ENGINE, load_s=load_s),
        quant=quant,
        input_mode=mode,
        input_mapping_attempts=tried,
        decoding=dict(
            temperature=0.0, max_tokens=FC.MAX_TOKENS, seed=0, skip_special_tokens=True
        ),
        variants={},
    )
    for v in variants:
        d, arrays = data[v]
        recs = d["records"]
        t = time.monotonic()
        outs = llm.generate(
            [FC.make_req(mode, r, x) for r, x in zip(recs, arrays, strict=True)],
            sp,
            use_tqdm=False,
        )
        gen_s = round(time.monotonic() - t, 2)
        by_key: dict = {}
        for r, o in zip(recs, outs, strict=True):
            c = o.outputs[0]
            text = c.text.strip()
            ok = (
                c.finish_reason == "stop"
                and bool(text)
                and list(o.prompt_token_ids) == r["input_ids"]
            )
            row = dict(
                status="complete" if ok else "failed",
                prompt_sha256=r["prompt_sha256"],
                input_tokens=r["n_in"],
                generated_tokens=len(c.token_ids),
                finish_reason=c.finish_reason,
            )
            if ok:
                row["caption"] = text
            else:
                row["error"] = (
                    "empty_text"
                    if c.finish_reason == "stop" and not text
                    else (
                        "prompt_ids_differ"
                        if list(o.prompt_token_ids) != r["input_ids"]
                        else f"finish_reason_{c.finish_reason}"
                    )
                )
            by_key[(r["ep"], r["event_index"])] = row
        totals = {}
        for ep in EPISODES:
            segs = json.loads((a.store / ep / "flora/segments.json").read_text())[
                "segments"
            ]
            disp = {x["segment_id"]: x["status"] for x in d["dispositions"][ep]}
            rows = []
            for i, s in enumerate(segs):
                base = dict(segment_id=s["id"], start_s=s["start_s"], end_s=s["end_s"])
                got = by_key.get((ep, i))
                if got is None:
                    st = disp.get(s["id"], "not_prepared")
                    rows.append(
                        dict(
                            base,
                            status="failed" if st == "caption_input" else st,
                            error="no_caption_input",
                        )
                    )
                else:
                    rows.append(dict(base, **got))
            totals[ep] = dict(
                segments=len(rows),
                complete=sum(r["status"] == "complete" for r in rows),
            )
            (a.out / v / ep).mkdir(parents=True, exist_ok=True)
            (a.out / v / ep / "captions.json").write_text(
                json.dumps(dict(variant=v, captions=rows), indent=1) + "\n"
            )
        summary["variants"][v] = dict(batch_gen_s=gen_s, totals=totals)
        FC.log("generated", v, gen_s, json.dumps(totals))
        (a.out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    FC.log("DONE")
    try:
        llm.llm_engine.engine_core.shutdown()
    except Exception as e:
        FC.log("shutdown failed", repr(e))
    os._exit(0)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("prep")
    sp.add_argument("--variant", required=True)
    sp.add_argument("--flora-src", type=Path, required=True)
    sp.add_argument("--model-dir", type=Path, required=True)
    sp.add_argument("--videos", type=Path, required=True)
    sp.add_argument("--store", type=Path, required=True)
    sp.add_argument("--work", type=Path, required=True)
    sp.add_argument("--limit", type=int, default=None)
    sg = sub.add_parser("gen")
    sg.add_argument("--variants", default="full,1280x720,960x540")
    sg.add_argument("--model-dir", type=Path, required=True)
    sg.add_argument("--store", type=Path, required=True)
    sg.add_argument("--work", type=Path, required=True)
    sg.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    return cmd_prep(a) if a.cmd == "prep" else cmd_gen(a)


if __name__ == "__main__":
    raise SystemExit(main())
