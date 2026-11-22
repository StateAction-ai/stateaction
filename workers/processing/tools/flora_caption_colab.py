#!/usr/bin/env python3
"""Caption the existing TempSeg (T3_r1) segments of the SA-86 episodes with the FLORA Captioner.

Runs on a Colab GPU VM (not in CI, not in the worker image). FLORA source and weights are NOT in this
repository: `--flora-src` is the FLORA `captioner` directory (reference copy kept outside Git) and
`--model-dir` the downloaded `nvidia/Flora-Captioner` snapshot. Needs the vLLM venv (vllm==0.34.0,
transformers==5.22.1, av==16.0.1, Pillow==12.3.0, huggingface_hub).

    python flora_caption_colab.py prep --flora-src S --model-dir M --videos V --t3 T --work W [--limit N]
    python flora_caption_colab.py gen  --model-dir M --videos V --t3 T --work W --out O

`prep` (CPU) runs FLORA's own `caption_single` planning, frame decoding and processor with generation
replaced by a recorder, so the frames, prompt text and token ids are exactly FLORA's. `gen` feeds those
to vLLM (fp8_per_tensor, FP32 dt_bias, greedy, max_tokens 512). A caption that does not stop cleanly with
non-empty text is recorded as `failed` with no caption text; it is never turned into an empty caption.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
EPISODES = ("homer_33", "homer_37")
CAPTIONER_REPO = "nvidia/Flora-Captioner"
CAPTIONER_REV = "fef0bbfe11829ca7f3539d58da7a6a2c2f109dc6"
SOURCE_MANIFEST_IDENTITY = (
    "2ab6cafd286df7f446bfb84fbc4af7c54773d5e890dd277ac5a0453d0d4fb778"
)
MAX_TOKENS = 512
IGNORE = ["re:.*visual\\..*", "re:.*in_proj_ba.*", "re:.*conv1d.*"]
ENGINE = dict(
    dtype="bfloat16",
    gpu_memory_utilization=0.88,
    max_model_len=32768,
    max_num_seqs=16,
    gdn_prefill_backend="triton",
    enable_prefix_caching=True,
    seed=0,
    generation_config="vllm",
)


def log(*a: object) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        while chunk := f.read(16 << 20):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


class ProcSpy:
    """Delegates to the real processor; records the kwargs of each call (frames, metadata, text)."""

    def __init__(self, proc: object):
        object.__setattr__(self, "_p", proc)
        object.__setattr__(self, "calls", [])

    def __getattr__(self, k: str) -> object:
        return getattr(self._p, k)

    def __call__(self, *a: object, **k: object) -> object:
        self.calls.append(k)
        return self._p(*a, **k)


def load_segments(t3: Path, ep: str, limit: int | None) -> tuple[dict, list[dict]]:
    doc = json.loads((t3 / ep / "segments.json").read_text())
    segs = doc["segments"]
    if limit:
        segs = segs[:limit]
    return doc, segs


# ----------------------------------------------------------------------------------------- prep
def cmd_prep(a: argparse.Namespace) -> int:
    import numpy as np

    sys.path.insert(0, str(a.flora_src))
    import batch_utils  # noqa: F401  (verifies the vendor manifest)

    vendor = str(a.flora_src / "batch_utils/vendor")
    for p in (vendor, vendor + "/support", vendor + "/production_adapter"):
        sys.path.insert(0, p)
    import batch_utils.media as media
    import batch_utils.models as M
    import batch_utils.pipeline as P
    import flora_unified.unified_input as UI  # noqa: F401

    proc = ProcSpy(M.processor("captioner", a.model_dir))

    class Stub:
        def load(self, kind: str) -> tuple[None, ProcSpy]:
            return None, proc

    out = a.work / "inputs"
    out.mkdir(parents=True, exist_ok=True)
    CUR: dict = {}
    recs: list[dict] = []

    def record(model: object, proc_: object, inputs: dict, budget: int) -> str:
        call = proc.calls[-1]
        k = CUR["k"]
        CUR["k"] += 1
        meta = [
            dict(
                total_num_frames=int(m.total_num_frames),
                fps=float(m.fps),
                frames_indices=[int(i) for i in m.frames_indices],
            )
            for m in call["video_metadata"]
        ]
        ids = inputs["input_ids"][0].tolist()
        name = f"{CUR['ep']}_{k:03d}"
        np.savez(
            out / f"{name}.npz",
            **{
                f"b{i}": np.stack([np.asarray(f.convert("RGB")) for f in b])
                for i, b in enumerate(call["videos"])
            },
        )
        recs.append(
            dict(
                ep=CUR["ep"],
                plan_k=k,
                event_index=CUR["plans"][k]["event_index"],
                text_prompt=call["text"][0],
                prompt_sha256=sha256_text(call["text"][0]),
                metadata=meta,
                input_ids=ids,
                n_in=len(ids),
                npz=name + ".npz",
            )
        )
        proc.calls.clear()
        return "x"  # placeholder: the real caption comes from vLLM in `gen`

    P.generate = record
    media_dispositions: dict[str, list[dict]] = {}
    for ep in EPISODES:
        doc, segs = load_segments(a.t3, ep, a.limit)
        video = media.probe(a.videos / f"{ep}.mp4")
        if video.sha256 != doc["source"]["sha256"]:
            raise SystemExit(f"E_SOURCE_SHA {ep}")
        sin = [dict(start_s=s["start_s"], end_s=s["end_s"], metadata={}) for s in segs]
        plans, disp = P.single_plans({"main": video}, sin, "Human")
        CUR.update(ep=ep, k=0, plans=plans)
        t = time.monotonic()
        P.caption_single(
            {"main": video}, sin, "Human", Stub(), "", lambda *x, **k: None
        )
        log(
            ep,
            "prepared",
            len(plans),
            "of",
            len(sin),
            "segments",
            round(time.monotonic() - t, 1),
            "s",
        )
        media_dispositions[ep] = [
            dict(segment_id=s["id"], status=d["status"]) for s, d in zip(segs, disp)
        ]
    (a.work / "inputs.json").write_text(
        json.dumps(dict(records=recs, dispositions=media_dispositions))
    )
    return 0


# ------------------------------------------------------------------------------------------- gen
def env_info() -> dict:
    import importlib.metadata as md

    smi = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader",
        ],
        capture_output=True,
        text=True,
    ).stdout.strip()
    out: dict = {
        "python": sys.version.split()[0],
        "nvidia_smi": smi,
        "gpu_name": smi.split(",")[0].strip(),
    }
    for n in (
        "vllm",
        "torch",
        "transformers",
        "av",
        "numpy",
        "Pillow",
        "huggingface_hub",
    ):
        try:
            out[n] = md.version(n)
        except Exception:
            out[n] = None
    try:
        import torch

        out["cuda"] = torch.version.cuda
    except Exception:
        out["cuda"] = None
    return out


def weights_identity(model_dir: Path) -> dict:
    """Weights hash: sha256 over the sorted (name, LFS sha256) list of every weight shard at the pinned
    revision, as published by the Hub (the download is revision-pinned and size/hash-checked by the client)."""
    from huggingface_hub import HfApi

    info = HfApi().model_info(
        CAPTIONER_REPO, revision=CAPTIONER_REV, files_metadata=True
    )
    shards = sorted(
        (s.rfilename, s.lfs.sha256 if s.lfs else None)
        for s in info.siblings
        if s.rfilename.endswith(".safetensors")
    )
    listing = "".join(f"{n} {h}\n" for n, h in shards)
    return {
        "repo": CAPTIONER_REPO,
        "revision": info.sha,
        "pinned_revision": CAPTIONER_REV,
        "weights_files": len(shards),
        "weights_listing_sha256": sha256_text(listing),
        "source_manifest_sha256": sha256_file(model_dir / "SOURCE_MANIFEST.sha256"),
        "source_manifest_identity_pinned_in_flora": SOURCE_MANIFEST_IDENTITY,
        "chat_template_sha256": sha256_file(model_dir / "chat_template.jinja"),
        "weights_integrity": "revision-pinned Hub download; shard LFS sha256 listed; SOURCE_MANIFEST.sha256 payload re-hash not run on the VM",
    }


def make_req(mode: str, rec: dict, arrays: list) -> dict:
    vids = [
        (x, dict(m, do_sample_frames=False))
        for x, m in zip(arrays, rec["metadata"], strict=True)
    ]
    mm = {"video": vids if len(vids) > 1 else vids[0]}
    if mode == "token_ids":
        return {
            "prompt_token_ids": rec["input_ids"],
            "multi_modal_data": mm,
            "mm_processor_kwargs": {"do_sample_frames": False},
        }
    text = rec["text_prompt"]
    if mode == "text_wrapped":
        text = text.replace(
            "<|video_pad|>", "<|vision_start|><|video_pad|><|vision_end|>"
        )
    return {
        "prompt": text,
        "multi_modal_data": mm,
        "mm_processor_kwargs": {"do_sample_frames": False},
    }


def pick_mode(
    llm: object, rec: dict, arrays: list, SP: type
) -> tuple[str | None, list[dict]]:
    tried = []
    for mode in ("token_ids", "text_wrapped", "text_raw"):
        try:
            o = llm.generate(
                [make_req(mode, rec, arrays)], SP(max_tokens=1), use_tqdm=False
            )[0]  # type: ignore[attr-defined]
            ids = list(o.prompt_token_ids)
            tried.append(
                dict(
                    mode=mode,
                    ok=True,
                    equal=ids == rec["input_ids"],
                    n_vllm=len(ids),
                    n_hf=len(rec["input_ids"]),
                )
            )
            if ids == rec["input_ids"]:
                return mode, tried
        except Exception as e:
            tried.append(dict(mode=mode, ok=False, error=repr(e)[:600]))
    return None, tried


def cmd_gen(a: argparse.Namespace) -> int:
    import numpy as np

    os.environ["QUANT_DT_BIAS_FP32"] = "1"
    os.environ["PYTHONPATH"] = ":".join([str(HERE), os.environ.get("PYTHONPATH", "")])
    sys.path.insert(0, str(HERE))
    from vllm import LLM, SamplingParams

    data = json.loads((a.work / "inputs.json").read_text())
    recs = data["records"]
    arrays = []
    for r in recs:
        z = np.load(a.work / "inputs" / r["npz"])
        arrays.append([z[f"b{i}"] for i in range(len(r["metadata"]))])
    quant = {
        "quantization": "fp8_per_tensor",
        "quantization_config": {"ignore": IGNORE},
    }
    t = time.monotonic()
    llm = LLM(
        model=str(a.model_dir),
        limit_mm_per_prompt={
            "image": 0,
            "video": max(len(r["metadata"]) for r in recs),
        },
        mm_processor_kwargs={"do_sample_frames": False},
        worker_extension_cls="flora_vllm_ext.QuantExt",
        **ENGINE,
        **quant,
    )
    load_s = round(time.monotonic() - t, 2)
    inspect = llm.collective_rpc("q_inspect")[0]
    log("loaded", load_s)
    mode, tried = pick_mode(llm, recs[0], arrays[0], SamplingParams)
    if mode is None:
        (a.out).mkdir(parents=True, exist_ok=True)
        (a.out / "failed_input_mapping.json").write_text(json.dumps(tried, indent=1))
        raise SystemExit(
            "E_INPUT_MAPPING: vLLM did not reproduce FLORA's prompt token ids"
        )
    sp = SamplingParams(
        temperature=0.0, max_tokens=MAX_TOKENS, seed=0, skip_special_tokens=True
    )
    t = time.monotonic()
    outs = llm.generate(
        [make_req(mode, r, x) for r, x in zip(recs, arrays, strict=True)],
        sp,
        use_tqdm=False,
    )
    gen_s = round(time.monotonic() - t, 2)
    log("generated", len(outs), gen_s)
    by_key: dict[tuple[str, int], dict] = {}
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
    a.out.mkdir(parents=True, exist_ok=True)
    prompt_shas = sorted(r["prompt_sha256"] for r in recs)
    totals = {}
    for ep in EPISODES:
        doc, segs = load_segments(a.t3, ep, None)
        disp = {d["segment_id"]: d["status"] for d in data["dispositions"][ep]}
        rows = []
        for i, s in enumerate(segs):
            base = dict(segment_id=s["id"], start_s=s["start_s"], end_s=s["end_s"])
            got = by_key.get((ep, i))
            if got is None:
                # no caption input was built for this segment (unsupported target frames, or not prepared)
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
            segments=len(rows), complete=sum(r["status"] == "complete" for r in rows)
        )
        (a.out / ep).mkdir(parents=True, exist_ok=True)
        (a.out / ep / "captions.json").write_text(
            json.dumps(
                dict(
                    schema="stateaction.flora_captions.v1",
                    source_sha256=doc["source"]["sha256"],
                    segments_sha256=sha256_file(a.t3 / ep / "segments.json"),
                    captions=rows,
                ),
                indent=1,
            )
            + "\n"
        )
    env = dict(
        schema="stateaction.flora_caption_env.v1",
        ticket="SA-86",
        run_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **env_info(),
        model=weights_identity(a.model_dir),
        engine=dict(ENGINE, load_s=load_s),
        quant=dict(quant, dt_bias_fp32=True, inspect=inspect),
        prompt=dict(
            captions=len(recs),
            prompt_set_sha256=sha256_text("".join(p + "\n" for p in prompt_shas)),
            instruction="",
            profile="Human",
            input_mode=mode,
            input_mapping_attempts=tried,
            note="per-caption prompt_sha256 is in each captions.json row",
        ),
        decoding=dict(
            temperature=0.0,
            max_tokens=MAX_TOKENS,
            seed=0,
            skip_special_tokens=True,
            batch="all captions in one generate call (max_num_seqs 16); vLLM is not batch-invariant",
        ),
        timing=dict(batch_gen_s=gen_s),
        totals=totals,
        inputs=dict(
            t3_run="T3_r1",
            segments_sha256={
                ep: sha256_file(a.t3 / ep / "segments.json") for ep in EPISODES
            },
            source_sha256={
                ep: json.loads((a.t3 / ep / "segments.json").read_text())["source"][
                    "sha256"
                ]
                for ep in EPISODES
            },
        ),
    )
    (a.out / "env.json").write_text(json.dumps(env, indent=1) + "\n")
    log("DONE", json.dumps(totals))
    try:
        llm.llm_engine.engine_core.shutdown()
    except Exception as e:
        log("shutdown failed", repr(e))
    os._exit(0)


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("prep", "gen"):
        sp = sub.add_parser(name)
        sp.add_argument("--model-dir", type=Path, required=True)
        sp.add_argument(
            "--videos", type=Path, required=True, help="directory with <ep>.mp4"
        )
        sp.add_argument(
            "--t3", type=Path, required=True, help="directory with <ep>/segments.json"
        )
        sp.add_argument("--work", type=Path, required=True)
        if name == "prep":
            sp.add_argument("--flora-src", type=Path, required=True)
            sp.add_argument(
                "--limit",
                type=int,
                default=None,
                help="first N segments per episode (smoke test)",
            )
        else:
            sp.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    return cmd_prep(a) if a.cmd == "prep" else cmd_gen(a)


if __name__ == "__main__":
    raise SystemExit(main())
