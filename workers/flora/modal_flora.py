"""One-time FLORA quantize-and-publish (SA-93, ticket T08). Operator-run, never a job-time cache.

    uv run --project workers/processing modal run workers/flora/modal_flora.py::<entrypoint> ...

Checkpoints live only on the Modal Volume `stateaction-models` (jobs mount it read-only). FLORA source is
NOT in this repository: set FLORA_REF to the directory holding `captioner/` and `tempseg/` (the
flora-patched reference tree). See README.md.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from flora_ext import pins  # noqa: E402

T_IMPORT = time.time()
FLORA_REF = Path(
    os.environ.get("FLORA_REF", "/home/wearaway/flora-work/flora-hour/flora-patched")
)
PROCESSING_TOOLS = HERE.parent / "processing" / "tools"

app = modal.App("stateaction-flora-publish")
vol = modal.Volume.from_name("stateaction-models", create_if_missing=True, version=2)
# Every function: no retries, one container, no warm pool (BUDGET.md rules).
COMMON = dict(retries=0, max_containers=1, min_containers=0, scaledown_window=2)

ENV = {
    "HF_HOME": "/models/_hf",
    "PYTHONUNBUFFERED": "1",
    "HF_XET_HIGH_PERFORMANCE": "1",
    "TOKENIZERS_PARALLELISM": "false",
    "PYTHONPATH": "/root",
}
_ignore = ["**/__pycache__"]


def _flora(img: modal.Image) -> modal.Image:
    return (
        img.add_local_dir(
            str(FLORA_REF / "captioner"), "/flora/captioner", ignore=_ignore
        )
        .add_local_dir(str(FLORA_REF / "tempseg"), "/flora/tempseg", ignore=_ignore)
        .add_local_python_source("flora_ext")
    )


cpu_img = _flora(
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "torch==2.11.0",
        "torchvision==0.26.0",
        index_url="https://download.pytorch.org/whl/cpu",
    )
    .pip_install(
        "huggingface_hub==1.33.0",
        "hf_xet",
        f"transformers=={pins.TRANSFORMERS_VERSION}",
        "peft==0.18.1",
        "accelerate==1.15.0",
        "safetensors==0.8.0",
        "av==16.0.1",
        "numpy<3",
        "Pillow==12.3.0",
        "psutil",
    )
    .env(ENV)
)

BASE = "/models/_base"


def sha256_file(p: str | Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(p, "rb") as f:
        while b := f.read(16 << 20):
            h.update(b)
    return h.hexdigest()


def fix_path(root: str) -> None:
    sys.path.insert(0, root)
    import batch_utils  # noqa: F401  (verifies the FLORA vendor manifest)

    v = root + "/batch_utils/vendor"
    for p in (v, v + "/support", v + "/production_adapter"):
        if p not in sys.path:
            sys.path.insert(0, p)


PATS = [
    "adapter_config.json",
    "adapter_model.safetensors",
    "config.json",
    "generation_config.json",
    "model.safetensors.index.json",
    "model-*.safetensors",
    "processor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "README.md",
    "MODEL_PROVENANCE.json",
    "SOURCE_MANIFEST.sha256",
]


@app.function(
    image=cpu_img, volumes={"/models": vol}, cpu=8, memory=16384, timeout=3000, **COMMON
)
def download(model: str) -> dict:
    """CPU: anonymous revision-pinned download of the FP32 originals into the temporary base area."""
    from huggingface_hub import snapshot_download

    vol.reload()
    out: dict = {"model": model}
    t = time.time()
    if model == "tempseg":
        snapshot_download(
            pins.TEMPSEG_REPO,
            revision=pins.TEMPSEG_REV,
            allow_patterns=PATS,
            local_dir=f"{BASE}/tempseg",
        )
        snapshot_download(
            pins.BASE_REPO,
            revision=pins.BASE_REV,
            allow_patterns=["*.safetensors", "*.json", "*.jinja"],
            local_dir=f"{BASE}/qwen3.5-9b",
        )
        out["adapter_sha256"] = sha256_file(f"{BASE}/tempseg/adapter_model.safetensors")
        assert out["adapter_sha256"] == pins.ADAPTER_SHA256, out["adapter_sha256"]
    else:
        snapshot_download(
            pins.CAPTIONER_REPO,
            revision=pins.CAPTIONER_REV,
            allow_patterns=PATS,
            local_dir=f"{BASE}/captioner",
        )
        from pathlib import Path as P

        out["bytes"] = sum(
            f.stat().st_size for f in P(f"{BASE}/captioner").glob("model-*.safetensors")
        )
        # Stock FLORA integrity check, run once here on CPU instead of in every GPU container.
        fix_path("/flora/captioner")
        import batch_utils.models as M

        t2 = time.time()
        M.validate_manifest(P(f"{BASE}/captioner"))
        out["manifest_validate_s"] = round(time.time() - t2, 1)
    out["source_manifest_sha256"] = sha256_file(
        f"{BASE}/{'tempseg' if model == 'tempseg' else 'captioner'}/SOURCE_MANIFEST.sha256"
    )
    out["download_s"] = round(time.time() - t, 1)
    vol.commit()
    out["container_s"] = round(time.time() - T_IMPORT, 1)
    print("DOWNLOAD", json.dumps(out), flush=True)
    return out


@app.function(
    image=cpu_img, volumes={"/models": vol}, cpu=8, memory=98304, timeout=3000, **COMMON
)
def merge() -> dict:
    """CPU: merge the TempSeg LoRA into the base in FP32, then cast to BF16 (A_log and dt_bias stay FP32).

    This is a numerics change against FLORA's reference (unmerged BF16 base plus FP32 adapter under BF16 autocast);
    the parity receipt measures it.
    """
    import shutil
    from collections import Counter

    import torch
    from flora_ext import manifest as MF
    from peft import PeftModel
    from peft.tuners.lora import LoraLayer
    from transformers import AutoModelForImageTextToText

    vol.reload()
    torch.set_num_threads(8)
    out: dict = {}
    base, adapter, dst = (
        f"{BASE}/qwen3.5-9b",
        f"{BASE}/tempseg",
        Path(f"{BASE}/tempseg-merged"),
    )
    assert sha256_file(f"{adapter}/adapter_model.safetensors") == pins.ADAPTER_SHA256
    t = time.time()
    model = AutoModelForImageTextToText.from_pretrained(
        base,
        local_files_only=True,
        dtype=torch.float32,
        device_map={"": "cpu"},
        attn_implementation="sdpa",
    )
    out["base_load_s"] = round(time.time() - t, 1)
    pm = PeftModel.from_pretrained(
        model, adapter, adapter_name="candidate", autocast_adapter_dtype=True
    )
    out["adapter_param_dtypes"] = dict(
        Counter(str(p.dtype) for n, p in pm.named_parameters() if "lora_" in n)
    )
    st = dict(modules=0, elements=0, delta_sq=0.0, round_sq=0.0, unchanged_by_adapter=0)
    with torch.no_grad():
        for _, mod in pm.named_modules():
            if isinstance(mod, LoraLayer) and "candidate" in getattr(mod, "lora_A", {}):
                w = mod.get_base_layer().weight.data
                d = mod.get_delta_weight("candidate").float()
                wm = w + d
                wb = wm.bfloat16()
                r = wb.float() - wm
                st["modules"] += 1
                st["elements"] += wm.numel()
                st["delta_sq"] += float((d.double() ** 2).sum())
                st["round_sq"] += float((r.double() ** 2).sum())
                st["unchanged_by_adapter"] += int((wb == w.bfloat16()).sum())
    st["round_to_delta_norm_ratio"] = (
        (st["round_sq"] / st["delta_sq"]) ** 0.5 if st["delta_sq"] else None
    )
    out["merge_stats"] = st
    merged = pm.merge_and_unload()
    kept = 0
    for n, p in merged.named_parameters():
        if n.endswith("A_log") or n.endswith("dt_bias"):
            kept += 1
            continue
        p.data = p.data.to(torch.bfloat16)
    out["kept_fp32"] = kept
    out["final_param_dtypes"] = dict(Counter(str(p.dtype) for p in merged.parameters()))
    if dst.exists():
        shutil.rmtree(dst)
    merged.config.dtype = torch.bfloat16
    merged.save_pretrained(dst, safe_serialization=True, max_shard_size="5GB")
    skip = {
        "adapter_model.safetensors",
        "adapter_config.json",
        "README.md",
        "SOURCE_MANIFEST.sha256",
        "MODEL_PROVENANCE.json",
        "config.json",
    }
    for f in Path(adapter).iterdir():  # FLORA processor/tokenizer files
        if f.is_file() and f.name not in skip:
            shutil.copy(f, dst / f.name)
    for f in Path(
        base
    ).iterdir():  # base processor/tokenizer files only where the export lacks them
        if (
            f.suffix in (".json", ".jinja")
            and not (dst / f.name).exists()
            and f.name != "model.safetensors.index.json"
        ):
            shutil.copy(f, dst / f.name)
    weights = {
        k: v for k, v in MF.file_digests(dst).items() if k.endswith(".safetensors")
    }
    out["merge_digest"] = MF.tree_digest(weights)
    out["merged_bytes"] = sum(v["bytes"] for v in weights.values())
    (dst / "merge.json").write_text(json.dumps(out, indent=1))
    vol.commit()
    out["container_s"] = round(time.time() - T_IMPORT, 1)
    print("MERGE", json.dumps(out), flush=True)
    return out


# ---------------------------------------------------------------------------------------------- GPU image
GPU = os.environ.get("FLORA_GPU", "RTX-PRO-6000")
vllm_img = _flora(
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        f"vllm=={pins.VLLM_VERSION}", f"transformers=={pins.TRANSFORMERS_VERSION}"
    )
    .pip_install("av==16.0.1", "Pillow==12.3.0", "huggingface_hub", "hf_xet", "psutil")
    .env({**ENV, "VLLM_LOGGING_LEVEL": "INFO"})
).add_local_file(
    str(PROCESSING_TOOLS / "flora_caption_colab.py"), "/root/flora_caption_colab.py"
)
SCRATCH = "/models/_scratch"
WEIGHTLESS_SKIP = {
    "model.safetensors.index.json",
    "adapter_config.json",
    "README.md",
    "SOURCE_MANIFEST.sha256",
    "MODEL_PROVENANCE.json",
    "merge.json",
}


def src_dir(model: str) -> str:
    return f"{BASE}/tempseg-merged" if model == "tempseg" else f"{BASE}/captioner"


def runtime_info() -> dict:
    import subprocess

    import torch
    import transformers
    import vllm

    smi = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader",
        ],
        capture_output=True,
        text=True,
    ).stdout.strip()
    cap = torch.cuda.get_device_capability(0)
    return dict(
        vllm=vllm.__version__,
        torch=torch.__version__,
        cuda=torch.version.cuda,
        transformers=transformers.__version__,
        gpu_name=smi.split(",")[0].strip(),
        gpu_arch=f"sm_{cap[0]}{cap[1]}",
        nvidia_smi=smi,
    )


def copy_config_files(src: str, dst: str) -> list[str]:
    """Copy config, tokenizer and processor files (no weights) next to a checkpoint so vLLM can load it."""
    import shutil

    done = []
    for f in sorted(Path(src).iterdir()):
        if (
            f.is_file()
            and (f.suffix in (".json", ".jinja", ".txt"))
            and f.name not in WEIGHTLESS_SKIP
            and not f.name.startswith("adapter")
        ):
            shutil.copy(f, Path(dst) / f.name)
            done.append(f.name)
    return done


@app.function(
    image=vllm_img,
    volumes={"/models": vol},
    gpu=GPU,
    cpu=8,
    memory=65536,
    timeout=2400,
    **COMMON,
)
def run_variant(
    model: str,
    mode: str,
    ckpt_dir: str = "",
    tag: str = "",
    save_sharded_to: str = "",
    eps: list | None = None,
) -> str:
    """GPU: load (mode fresh | portable | sharded), run the fixed workload, optionally save vLLM sharded state.

    Records cold-load seconds (LLM() build) and container-import-to-first-token seconds. Returns JSON.
    """
    import traceback

    out: dict = dict(model=model, mode=mode, tag=tag)
    try:
        vol.reload()
        from flora_ext import vlib, workload
        from vllm import SamplingParams

        out["runtime"] = runtime_info()
        mdir = ckpt_dir or src_dir(model)
        t = time.time()
        llm = vlib.build_llm(
            mdir,
            mode,
            videos=4 if model == "captioner" else 1,
            gpu_util=0.88 if model == "captioner" else 0.85,
        )
        out["load_s"] = round(time.time() - t, 1)
        llm.generate(
            ["Hello"], SamplingParams(max_tokens=1, temperature=0.0), use_tqdm=False
        )
        out["first_token_since_import_s"] = round(time.time() - T_IMPORT, 1)
        out["inspect"] = llm.collective_rpc("q_inspect")[0]
        out["layout"] = llm.collective_rpc("q_layout")[0]
        t = time.time()
        if model == "tempseg":
            videos = {
                e: f"{SCRATCH}/in/{e}.mp4" for e in (eps or ["homer_33", "homer_37"])
            }
            out["result"] = workload.run_tempseg(llm, mdir, videos, "/tmp/ts_work")
        else:
            out["result"] = workload.run_captioner(llm, f"{SCRATCH}/cap")
        out["workload_s"] = round(time.time() - t, 1)
        if save_sharded_to:
            shutil_rm(save_sharded_to)
            Path(save_sharded_to).mkdir(parents=True, exist_ok=True)
            t = time.time()
            try:
                llm.collective_rpc(
                    "save_sharded_state",
                    kwargs=dict(path=save_sharded_to, max_size=5 << 30),
                )
            except Exception:  # noqa: BLE001 - API differs across vLLM minors; try the engine-core path
                llm.llm_engine.engine_core.save_sharded_state(
                    path=save_sharded_to, max_size=5 << 30
                )
            out["save_s"] = round(time.time() - t, 1)
            out["copied_config_files"] = copy_config_files(mdir, save_sharded_to)
        os.makedirs(f"{SCRATCH}/out", exist_ok=True)
        Path(f"{SCRATCH}/out/{model}_{tag or mode}.json").write_text(json.dumps(out))
        vol.commit()
    except Exception as e:  # noqa: BLE001 - the failure is the result
        out["error"] = repr(e)[:1500]
        out["tb"] = traceback.format_exc()[-3500:]
    out["container_s"] = round(time.time() - T_IMPORT, 1)
    print(
        "RESULT",
        json.dumps(
            {k: v for k, v in out.items() if k not in ("result", "layout")}, default=str
        )[:4000],
        flush=True,
    )
    return json.dumps(out, default=str)


def shutil_rm(p: str) -> None:
    import shutil

    shutil.rmtree(p, ignore_errors=True)


@app.function(
    image=vllm_img,
    volumes={"/models": vol},
    cpu=8,
    memory=32768,
    timeout=3000,
    **COMMON,
)
def prep_inputs() -> dict:
    """CPU: FLORA's own caption planning, frame decoding and processor for the T3 segments (SA-86 recipe)."""
    import argparse

    import flora_caption_colab as FC

    vol.reload()
    work = Path(f"{SCRATCH}/cap")
    work.mkdir(parents=True, exist_ok=True)
    t = time.time()
    FC.cmd_prep(
        argparse.Namespace(
            flora_src=Path("/flora/captioner"),
            model_dir=Path(f"{BASE}/captioner"),
            videos=Path(f"{SCRATCH}/in"),
            t3=Path(f"{SCRATCH}/t3"),
            work=work,
            limit=None,
        )
    )
    out = {
        "prep_s": round(time.time() - t, 1),
        "records": len(json.loads((work / "inputs.json").read_text())["records"]),
    }
    vol.commit()
    out["container_s"] = round(time.time() - T_IMPORT, 1)
    print("PREP", json.dumps(out), flush=True)
    return out


@app.function(
    image=vllm_img,
    volumes={"/models": vol},
    gpu=os.environ.get("FLORA_EXPORT_GPU", "L40S"),
    cpu=8,
    memory=65536,
    timeout=2400,
    **COMMON,
)
def export_portable(
    model: str, dst: str, expected_fp8_modules: int, activation_strategy: str = "token"
) -> dict:
    """GPU (vLLM op only, no engine): write the portable compressed-tensors FP8 checkpoint to a staging path."""
    from flora_ext import export

    vol.reload()
    t = time.time()
    out = export.export_checkpoint(
        src_dir(model), dst, expected_fp8_modules, activation_strategy
    )
    out["export_s"] = round(time.time() - t, 1)
    vol.commit()
    out["container_s"] = round(time.time() - T_IMPORT, 1)
    print("EXPORT", json.dumps(out), flush=True)
    return out


CKPT_ROOT = "/models/flora"


def staging_dir(model: str) -> str:
    return f"/models/_staging/{model}-portable"


def final_dir(model: str, fmt: str, version: int = 1) -> str:
    from flora_ext import manifest as MF

    return f"{CKPT_ROOT}/{MF.checkpoint_id(model, pins.MODELS[model]['revision'], fmt, version)}"


@app.function(
    image=cpu_img, volumes={"/models": vol}, cpu=2, memory=4096, timeout=600, **COMMON
)
def status(model: str, fmt: str) -> dict:
    """CPU: what already exists on the Volume (steps are skipped when their output exists; final is never overwritten)."""
    vol.reload()
    P = Path
    out = {
        "final": final_dir(model, fmt),
        "final_exists": P(final_dir(model, fmt)).exists(),
        "base": P(src_dir(model), "model.safetensors.index.json").exists()
        if model == "captioner"
        else P(src_dir(model), "merge.json").exists(),
        "inputs": P(SCRATCH, "in", "homer_33.mp4").exists()
        and P(SCRATCH, "t3", "homer_37", "segments.json").exists(),
        "cap_inputs": P(SCRATCH, "cap", "inputs.json").exists(),
        "fresh": P(SCRATCH, "out", f"{model}_fresh.json").exists(),
        "staging": P(staging_dir(model), "model.safetensors.index.json").exists(),
    }
    return out


@app.function(
    image=cpu_img, volumes={"/models": vol}, cpu=4, memory=16384, timeout=3000, **COMMON
)
def finalize(
    model: str,
    fmt: str,
    staging: str,
    receipt_json: str,
    runtime_json: str,
    code_revision: str,
    format_note: str,
    delete_base: bool,
) -> dict:
    """CPU: manifest into staging, deep verify, refuse-overwrite, rename to the final path, commit, drop base weights."""
    import shutil

    from flora_ext import manifest as MF

    vol.reload()
    out: dict = {}
    final = Path(final_dir(model, fmt))
    MF.refuse_existing(final)
    stg = Path(staging)
    t = time.time()
    base = f"{BASE}/{'tempseg' if model == 'tempseg' else 'captioner'}"
    source = {"source_manifest_sha256": sha256_file(f"{base}/SOURCE_MANIFEST.sha256")}
    if model == "tempseg":
        source["adapter_sha256"] = sha256_file(f"{base}/adapter_model.safetensors")
        source["merge_digest"] = json.loads(
            Path(f"{BASE}/tempseg-merged/merge.json").read_text()
        )["merge_digest"]
    files = MF.file_digests(stg)
    m = MF.build_manifest(
        model=model,
        fmt=fmt,
        files=files,
        source=source,
        runtime=json.loads(runtime_json),
        code_revision=code_revision,
        parity_receipt=json.loads(receipt_json),
        format_note=format_note,
    )
    MF.write_manifest(stg, m)
    problems = MF.verify_checkpoint(stg, deep=True)
    if problems:
        raise RuntimeError(f"staging verify failed: {problems[:5]}")
    out["verify_staging_s"] = round(time.time() - t, 1)
    final.parent.mkdir(parents=True, exist_ok=True)
    os.rename(stg, final)
    vol.commit()
    vol.reload()
    problems = MF.verify_checkpoint(final, deep=False)
    if problems:
        raise RuntimeError(f"final verify failed: {problems[:5]}")
    out.update(
        checkpoint_id=m["checkpoint_id"],
        final=str(final),
        files=len(files),
        bytes=sum(f["bytes"] for f in files.values()),
    )
    if delete_base:
        for d in (
            ["tempseg", "qwen3.5-9b", "tempseg-merged"]
            if model == "tempseg"
            else ["captioner"]
        ):
            shutil.rmtree(f"{BASE}/{d}", ignore_errors=True)
        vol.commit()
        out["base_deleted"] = True
    out["container_s"] = round(time.time() - T_IMPORT, 1)
    print("FINALIZE", json.dumps(out), flush=True)
    return out


@app.function(
    image=cpu_img, volumes={"/models": vol}, cpu=4, memory=16384, timeout=3000, **COMMON
)
def verify_checkpoint_fn(model: str, fmt: str, deep: bool) -> dict:
    """CPU: MANIFEST.json against the files of the published checkpoint. A missing checkpoint fails loudly."""
    from flora_ext import manifest as MF

    vol.reload()
    final = Path(final_dir(model, fmt))
    m = MF.require_published(final)
    t = time.time()
    problems = MF.verify_checkpoint(final, deep=deep)
    return dict(
        checkpoint_id=m["checkpoint_id"],
        problems=problems,
        deep=deep,
        verify_s=round(time.time() - t, 1),
        container_s=round(time.time() - T_IMPORT, 1),
        format=m["format"],
        runtime=m["runtime"],
        parity=m["parity_receipt"].get("checks"),
        files=len(m["files"]),
        bytes=sum(f["bytes"] for f in m["files"].values()),
    )


@app.function(
    image=cpu_img, volumes={"/models": vol}, cpu=2, memory=4096, timeout=900, **COMMON
)
def cleanup(scratch: bool, staging: bool) -> dict:
    """CPU: drop temporary scratch inputs/outputs and abandoned staging directories."""
    import shutil

    vol.reload()
    for flag, d in (
        (scratch, SCRATCH),
        (scratch, "/models/_hf"),
        (staging, "/models/_staging"),
    ):
        if flag:
            shutil.rmtree(d, ignore_errors=True)
    vol.commit()
    return {"scratch_removed": scratch, "staging_removed": staging}


# ---------------------------------------------------------------------------------------------- local side
PRICE = dict(gpu_h=3.03, cpu_core_h=0.0472, gib_h=0.0080)
LEDGER = Path(os.environ.get("FLORA_LEDGER", "artifacts/flora-publish/ledger.jsonl"))
FIXTURES = Path(os.environ.get("FLORA_FIXTURES", "artifacts/fixtures/flora-homer"))
EPS = ("homer_33", "homer_37")


def ledger(
    step: str,
    container_s: float,
    *,
    gpu: bool | float = False,
    cpu: int = 8,
    mem_gib: int = 16,
) -> float:
    """Append one Modal call to the ledger: list-price estimate = (container seconds + 15 s start) x price."""
    sec = container_s + 15
    usd = (
        sec
        / 3600
        * (
            cpu * PRICE["cpu_core_h"]
            + mem_gib * PRICE["gib_h"]
            + (PRICE["gpu_h"] if gpu is True else float(gpu or 0.0))
        )
    )
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as f:
        f.write(
            json.dumps(
                dict(
                    utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    step=step,
                    seconds=round(sec, 1),
                    usd=round(usd, 4),
                    gpu=bool(gpu),
                )
            )
            + "\n"
        )
    total = sum(json.loads(x)["usd"] for x in LEDGER.read_text().splitlines())
    print(f"LEDGER {step}: {sec:.0f} s, ${usd:.3f}, running ${total:.3f}", flush=True)
    return usd


@app.local_entrypoint()
def dl(model: str = "tempseg"):
    r = download.remote(model)
    ledger(f"download {model}", r["container_s"], cpu=8, mem_gib=16)
    print(json.dumps(r, indent=1))


@app.local_entrypoint()
def mrg():
    r = merge.remote()
    ledger("merge tempseg", r["container_s"], cpu=8, mem_gib=96)
    print(json.dumps({k: v for k, v in r.items()}, indent=1))


def _stage() -> None:
    with vol.batch_upload(force=True) as b:
        for ep in EPS:
            b.put_file(str(FIXTURES / ep / "source.mp4"), f"_scratch/in/{ep}.mp4")
            b.put_file(
                str(FIXTURES / ep / "flora" / "segments.json"),
                f"_scratch/t3/{ep}/segments.json",
            )
    print("staged", EPS)


@app.local_entrypoint()
def stage():
    """Upload the T01 fixtures (videos, T3 segments) to the scratch area of the Volume."""
    _stage()


@app.local_entrypoint()
def prep():
    r = prep_inputs.remote()
    ledger("prep captioner inputs", r["container_s"], cpu=8, mem_gib=32)
    print(r)


OUT_DIR = Path(os.environ.get("FLORA_OUT", "artifacts/flora-publish"))


@app.local_entrypoint()
def run(model: str, mode: str, ckpt: str = "", tag: str = "", save_to: str = ""):
    """One GPU load plus the fixed workload; result JSON goes to artifacts/flora-publish/<model>_<tag>.json."""
    tag = tag or mode
    r = json.loads(run_variant.remote(model, mode, ckpt, tag, save_to))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{model}_{tag}.json").write_text(json.dumps(r))
    ledger(f"gpu {model} {mode} {tag}", r["container_s"], gpu=True, cpu=8, mem_gib=64)
    print(
        json.dumps(
            {k: v for k, v in r.items() if k not in ("result", "layout", "tb")},
            indent=1,
            default=str,
        )
    )
    if "error" in r:
        print(r.get("tb", ""))


@app.local_entrypoint()
def export(
    model: str, dst: str, expected_fp8_modules: int, activation_strategy: str = "token"
):
    r = export_portable.remote(model, dst, expected_fp8_modules, activation_strategy)
    ledger(
        f"export portable {model}", r["container_s"], gpu=1.95, cpu=8, mem_gib=64
    )  # L40S list price
    print(json.dumps(r, indent=1))


GOLD = Path(os.environ.get("FLORA_GOLD", "artifacts/fixtures/wgo-gold"))
FORMAT_NOTE = (
    "Portable compressed-tensors FP8 (static per-tensor weights, dynamic activations). Written by flora_ext.export with vLLM's own "
    "scaled_fp8_quant and one shared scale per fused module, so vLLM's load-time fp8_per_tensor and this checkpoint give identical outputs. "
    "vLLM sharded state was rejected: save_sharded_state fails on vLLM 0.34 online-FP8 weights (transposed, non-contiguous: 'view size is not compatible')."
)


def _sha_json(o: object) -> str:
    import hashlib

    return hashlib.sha256(
        json.dumps(o, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _code_revision() -> str:
    import hashlib
    import subprocess

    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, text=True
    ).stdout.strip()
    h = hashlib.sha256()
    for f in sorted(HERE.rglob("*.py")):
        if "__pycache__" not in f.parts:
            h.update(f.relative_to(HERE).as_posix().encode() + b"\0" + f.read_bytes())
    return f"git:{head}+workers/flora:{h.hexdigest()[:16]}"


def _load(model: str, tag: str) -> dict | None:
    f = OUT_DIR / f"{model}_{tag}.json"
    return json.loads(f.read_text()) if f.exists() else None


def _gpu(model: str, mode: str, tag: str, ckpt: str = "", reuse: bool = False) -> dict:
    r = _load(model, tag) if reuse else None
    if r is None:
        r = json.loads(run_variant.remote(model, mode, ckpt, tag, ""))
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{model}_{tag}.json").write_text(json.dumps(r))
        ledger(
            f"gpu {model} {mode} {tag}", r["container_s"], gpu=True, cpu=8, mem_gib=64
        )
    if "error" in r:
        raise SystemExit(f"{model} {tag} failed: {r['error']}\n{r.get('tb', '')}")
    return r


def _outputs(result: dict) -> dict:
    """The comparable part of a workload result (no timings)."""
    return {k: v for k, v in result.items() if k != "gen_s"}


def _receipt(model: str, fresh: dict, restored: dict) -> dict:
    from flora_ext import parity as P

    if model == "tempseg":
        t3, gold, t3_failed = {}, {}, 0
        for ep in EPS:
            d = json.loads((FIXTURES / ep / "flora" / "segments.json").read_text())
            t3[ep] = [(x["start_s"], x["end_s"]) for x in d["segments"]]
            t3_failed += len(d["windows"]["failed"])
            gold[ep] = [
                (x["start_s"], x["end_s"])
                for x in json.loads((GOLD / f"{ep}.gold.json").read_text())["segments"]
            ]
        verdict = P.compare_tempseg(fresh, restored, t3, gold, t3_failed)
    else:
        t01 = {
            ep: json.loads((FIXTURES / ep / "flora" / "captions.json").read_text())[
                "captions"
            ]
            for ep in EPS
        }
        verdict = P.compare_captioner(fresh, restored, t01)

    def cold(r: dict) -> dict:
        return dict(
            load_s=r["load_s"],
            first_token_since_container_import_s=r["first_token_since_import_s"],
            container_s=r["container_s"],
        )

    return dict(
        passed=verdict["passed"],
        verdict=verdict,
        episodes=list(EPS),
        reference="T3 (TempSeg) / C3 (Captioner): vLLM fp8_per_tensor, RTX PRO 6000",
        cold_load={
            "fresh_quantization": cold(fresh),
            "restore": cold(restored),
            "note": "load_s is the vLLM LLM() build; first_token_since_container_import_s runs from Python import to the first generated token and excludes Modal container scheduling",
        },
        outputs_sha256={
            "fresh": _sha_json(_outputs(fresh["result"])),
            "restored": _sha_json(_outputs(restored["result"])),
        },
        runtime_fresh=fresh["runtime"],
        runtime_restore=restored["runtime"],
        inspect_restore=restored["inspect"],
        fixtures={
            ep: {
                "source_sha256": __import__("hashlib")
                .sha256((FIXTURES / ep / "source.mp4").read_bytes())
                .hexdigest()
            }
            for ep in EPS
        }
        if model == "tempseg"
        else {},
        created_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )


@app.local_entrypoint()
def publish(
    model: str,
    reuse: bool = False,
    delete_base: bool = True,
    activation_strategy: str = "token",
):
    """Operator-run, once per checkpoint id: fresh quantization, portable export, restore, parity, manifest, publish.

    Refuses to overwrite a published checkpoint id. `--reuse` reuses fresh/restore results already in artifacts/flora-publish.
    """
    fmt = "compressed-tensors"
    st = status.remote(model, fmt)
    if st["final_exists"]:
        raise SystemExit(f"already published, refusing to overwrite: {st['final']}")
    if not st["inputs"]:
        _stage()
    if not st["base"]:
        download.remote(model)
        if model == "tempseg":
            merge.remote()
    if model == "captioner" and not st["cap_inputs"]:
        prep_inputs.remote()
    fresh = _gpu(model, "fresh", "fresh", reuse=reuse)
    n_fp8 = len(fresh["layout"]["fp8_modules"])
    stg = staging_dir(model)
    if not (reuse and st["staging"]):
        r = export_portable.remote(model, stg, n_fp8, activation_strategy)
        ledger(
            f"export portable {model}", r["container_s"], gpu=1.95, cpu=8, mem_gib=64
        )
    restored = _gpu(model, "portable", "restore", ckpt=stg, reuse=reuse)
    receipt = _receipt(model, fresh, restored)
    receipt["format_spike"] = {
        "chosen": fmt,
        "note": FORMAT_NOTE,
        "activation_strategy": activation_strategy,
    }
    receipt["modal_spend_usd_at_this_point"] = round(
        sum(json.loads(x)["usd"] for x in LEDGER.read_text().splitlines()), 3
    )
    (OUT_DIR / f"{model}_receipt.json").write_text(json.dumps(receipt, indent=1))
    print(json.dumps(receipt["verdict"], indent=1))
    if not receipt["passed"]:
        raise SystemExit(
            "PARITY FAILED: not publishing. Load-time fp8_per_tensor quantization stays the documented fallback."
        )
    runtime = {
        k: restored["runtime"][k]
        for k in ("vllm", "torch", "cuda", "transformers", "gpu_name", "gpu_arch")
    }
    out = finalize.remote(
        model,
        fmt,
        stg,
        json.dumps(receipt),
        json.dumps(runtime),
        _code_revision(),
        FORMAT_NOTE,
        delete_base,
    )
    ledger(f"finalize {model}", out["container_s"], cpu=4, mem_gib=16)
    print(json.dumps(out, indent=1))


@app.local_entrypoint()
def verify_checkpoint(model: str, deep: bool = True):
    r = verify_checkpoint_fn.remote(
        "tempseg" if model == "tempseg" else model, "compressed-tensors", deep
    )
    ledger(f"verify {model}", r["container_s"], cpu=4, mem_gib=16)
    print(json.dumps(r, indent=1))
    if r["problems"]:
        raise SystemExit("VERIFY FAILED")


@app.local_entrypoint()
def clean(scratch: bool = True, staging: bool = True):
    print(cleanup.remote(scratch, staging))


@app.local_entrypoint()
def smoke(
    fixture: str = "homer_33",
    only: str = "tempseg,captioner",
    t08: str = os.environ.get("FLORA_T08_DIR", "/home/wearaway/flora-work/sa93-art"),
    out: str = "artifacts/flora-stage",
    hf_fixture: str = "homer_37",
    hf_segments: int = 3,
    hf_deadline_s: int = 1200,
):
    """SA-94 smoke of the FLORA stage modules through the SA-90 `--io-dir` harness (billable, operator-run).

    The stage functions live in `modal_stage.py` (their own app) and the smoke functions in
    `modal_stage_smoke.py` (another app, never deployed); this entrypoint runs that app and compares with the T08 restored outputs.
    Upload the fixtures first (see README): `modal volume put stateaction-flora-smoke <store>/<ep> /<ep>`.
    """
    import modal_stage_smoke

    with modal_stage_smoke.app.run():
        modal_stage_smoke.run_smoke(
            fixture, only, t08, out, hf_fixture, hf_segments, hf_deadline_s
        )
