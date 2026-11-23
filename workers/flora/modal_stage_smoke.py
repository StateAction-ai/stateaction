"""Operator smoke and CPU dry run for the FLORA stage functions (SA-94). Billable, never deployed.

A separate app from `modal_stage.py` on purpose: it reuses that file's image and function options (the
same GPU, image and settings as production) but adds the fixtures Volume and the `--io-dir` harness,
which must not be part of a production deploy.

    uv run --project workers/processing modal run workers/flora/modal_flora.py::smoke --fixture homer_33
    uv run --project workers/processing modal run workers/flora/modal_stage_smoke.py::dry_run   (CPU only)
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import modal_stage  # noqa: E402
from flora_ext import stage_settings  # noqa: E402

app = modal.App(stage_settings.APP_NAME + "-smoke")
SMOKE_VOLUME = "stateaction-flora-smoke"  # fixtures for the operator smoke only; removed afterwards
fixtures = modal.Volume.from_name(SMOKE_VOLUME, create_if_missing=False, version=2)
# The container imports this file, which imports `modal_stage`: mount both (not in the production image).
image = modal_stage.image.add_local_python_source("modal_stage", "modal_stage_smoke")
models = modal_stage.models
PRICE = {"gpu_h": 3.03, "cpu_core_h": 0.0472, "gib_h": 0.0080}


def _options(name: str) -> dict[str, Any]:
    opts = modal_stage._options(name)
    opts["image"] = image
    opts["volumes"] = {**opts["volumes"], "/fixtures": fixtures.read_only()}
    return opts


def _smoke(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    from flora_ext import stage_smoke

    started = time.time()
    out = stage_smoke.run_jobs(jobs)
    out["container_s"] = round(time.time() - started, 1)
    for item in out[
        "results"
    ]:  # bytes are returned base64-free: the caller pickles them
        item.pop("job", None)
    return out


# Operator smoke: the same image, GPU and settings as the production functions, with the SA-90
# `--io-dir` harness enabled (STATEACTION_IO_DIR_HARNESS is set only inside `run_io_dir`).
@app.function(**_options("flora_tempseg"))
def smoke_tempseg(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    return _smoke(jobs)


@app.function(**_options("flora_captioner"))
def smoke_captioner(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    return _smoke(jobs)


@app.function(
    image=image,
    volumes={"/models": models.read_only(), "/fixtures": fixtures.read_only()},
    cpu=8,
    memory=32768,
    ephemeral_disk=stage_settings.EPHEMERAL_DISK_MIB,
    timeout=1800,
    retries=0,
    max_containers=1,
    min_containers=0,
    single_use_containers=True,
    restrict_modal_access=True,
    secrets=[],
)
def dry_run_cpu(episode: str) -> dict[str, Any]:
    """No GPU: checkpoint guard on the real Volume, remux plus registry plus glue, caption planning, TempSeg stub."""
    from flora_ext import stage_smoke

    started = time.time()
    out = stage_smoke.dry_run("/fixtures", episode)
    out["container_s"] = round(time.time() - started, 1)
    return out


def ledger_line(
    step: str, seconds: float, *, gpu: bool, cpu: int, mem_gib: int
) -> float:
    """List-price estimate for one call (container seconds plus 15 s start); printed for SPEND-LOG.md."""
    sec = seconds + 15
    usd = (
        sec
        / 3600
        * (
            cpu * PRICE["cpu_core_h"]
            + mem_gib * PRICE["gib_h"]
            + (PRICE["gpu_h"] if gpu else 0.0)
        )
    )
    print(f"LEDGER {step}: {sec:.0f} s, ${usd:.3f}", flush=True)
    return usd


@app.local_entrypoint()
def dry_run(episode: str = "homer_33", out: str = "artifacts/flora-stage/dry_run.json"):
    """CPU-only check of everything around the engines. Upload the fixtures first: see `upload_fixtures`."""
    t = time.time()
    result = dry_run_cpu.remote(episode)
    ledger_line("dry_run_cpu", time.time() - t, gpu=False, cpu=8, mem_gib=32)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(result, indent=1, default=str))
    print(json.dumps(result, indent=1, default=str)[:6000])


def _write(out_dir: Path, name: str, data: bytes | str) -> None:
    path = out_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())


def _save_results(out_dir: Path, tag: str, result: dict[str, Any]) -> None:
    """Keep the returned files (documents, diagnostics, receipt, log) next to the summary for review."""
    for n, item in enumerate(result["results"]):
        for rel, data in (item.get("files") or {}).items():
            _write(out_dir, f"{tag}/{n}/{rel}", data)
        if item.get("document") is not None:
            _write(
                out_dir,
                f"{tag}/{n}/document.json",
                json.dumps(item["document"], indent=1),
            )


def _cli_receipt(item: dict[str, Any]) -> dict[str, Any]:
    receipt = item.get("receipt") or {}
    return {
        "exit": item.get("exitCode"),
        "status": receipt.get("status"),
        "errorCode": receipt.get("errorCode"),
        "counts": receipt.get("counts"),
        "gpu": receipt.get("gpu"),
        "seconds": item.get("seconds"),
    }


def run_smoke(
    fixture: str,
    only: str,
    t08_dir: str,
    out_dir: str,
    hf_fixture: str = "homer_37",
    hf_segments: int = 3,
    hf_deadline_s: int = 1200,
) -> dict[str, Any]:
    """Run the smoke jobs on Modal (inside an active app) and compare with the T08 restored outputs.

    only: comma list of `tempseg`, `captioner`, `hf` (HF TempSeg fallback on `hf_fixture`),
    `hf_captioner` (HF Captioner fallback on `fixture`, first `hf_segments` segments, bounded by `hf_deadline_s`).
    """
    from flora_ext import stage_smoke as S

    t08 = Path(t08_dir)
    t08_ts = json.loads((t08 / "tempseg_restore.json").read_text())
    t08_cap = json.loads((t08 / "captioner_restore.json").read_text())
    out = Path(out_dir)
    gpu = stage_settings.GPU
    summary: dict[str, Any] = {"fixture": fixture, "t08_dir": str(t08)}
    wanted = set(only.split(","))
    if wanted & {"tempseg", "tempseg_cli"}:
        jobs = [
            {
                "kind": "cli",
                "stage": "segment",
                "module": "flora_tempseg_vllm_fp8@1",
                "gpu": gpu,
                "fixture": fixture,
            },
            {
                "kind": "direct",
                "stage": "segment",
                "module": "flora_tempseg_vllm_fp8@1",
                "engine": "vllm",
                "gpu": gpu,
                "fixture": fixture,
            },
        ]
        t = time.time()
        res = smoke_tempseg.remote(jobs)
        ledger_line(
            f"smoke_tempseg {fixture}", time.time() - t, gpu=True, cpu=8, mem_gib=64
        )
        _save_results(out, f"tempseg_{fixture}", res)
        cli, direct = res["results"]
        entry: dict[str, Any] = {
            "cli_receipt": _cli_receipt(cli),
            "direct_error": direct["error"],
            "container_s": res["container_s"],
        }
        native_cli = cli["files"].get("diagnostics/segment/native_segments.json")
        if native_cli:
            native = json.loads(native_cli)
            entry["via_mcap_vs_t08"] = {
                **S.compare_segments(native, t08_ts, fixture),
                "f1_iou075": S.segment_f1(
                    native["segments"],
                    t08_ts["result"]["episodes"][fixture]["segments"],
                ),
            }
        native_direct = direct["files"].get("native_segments.json")
        if native_direct:
            entry["direct_mp4_vs_t08"] = S.compare_segments(
                json.loads(native_direct), t08_ts, fixture
            )
        summary["tempseg"] = entry
    if wanted & {"captioner", "captioner_direct"}:
        jobs = [
            {
                "kind": "cli",
                "stage": "segment",
                "module": "replay_segmenter@1",
                "gpu": "none",
                "fixture": fixture,
                "local": True,
            },
            {
                "kind": "cli",
                "stage": "caption",
                "module": "flora_captioner_vllm_fp8@1",
                "gpu": gpu,
                "fixture": fixture,
                "segments_from": 0,
                "budget_s": 3600,
                "deadline_s": 3000,
            },
            {
                "kind": "direct",
                "stage": "caption",
                "module": "flora_captioner_vllm_fp8@1",
                "engine": "vllm",
                "gpu": gpu,
                "fixture": fixture,
            },
        ]
        if "captioner" not in wanted:
            jobs = jobs[2:]  # captioner_direct: the module over the verbatim MP4 only
        t = time.time()
        res = smoke_captioner.remote(jobs)
        ledger_line(
            f"smoke_captioner {fixture}", time.time() - t, gpu=True, cpu=8, mem_gib=64
        )
        _save_results(out, f"captioner_{fixture}", res)
        if (
            len(res["results"]) == 1
        ):  # captioner_direct: no replay and no contract-path job
            replay = cli = {"files": {}}
            (direct,) = res["results"]
        else:
            replay, cli, direct = res["results"]
        entry = {
            "replay_receipt": _cli_receipt(replay),
            "cli_receipt": _cli_receipt(cli),
            "direct_error": direct["error"],
            "container_s": res["container_s"],
        }
        if cli["files"].get("captions.json"):
            entry["via_mcap_vs_t08"] = S.compare_captions(
                json.loads(cli["files"]["captions.json"]), t08_cap, fixture
            )
        if direct["document"]:
            entry["direct_mp4_vs_t08"] = S.compare_captions(
                direct["document"], t08_cap, fixture
            )
        summary["captioner"] = entry
    if "hf" in wanted:
        jobs = [
            {
                "kind": "cli",
                "stage": "segment",
                "module": "flora_tempseg_hf@1",
                "gpu": gpu,
                "fixture": hf_fixture,
                "budget_s": 3600,
                "deadline_s": 900,
            }
        ]
        t = time.time()
        res = smoke_tempseg.remote(jobs)
        ledger_line(
            f"smoke_hf_tempseg {hf_fixture}",
            time.time() - t,
            gpu=True,
            cpu=8,
            mem_gib=64,
        )
        _save_results(out, f"hf_tempseg_{hf_fixture}", res)
        (cli,) = res["results"]
        entry = {"cli_receipt": _cli_receipt(cli), "container_s": res["container_s"]}
        native_hf = cli["files"].get("diagnostics/segment/native_segments.json")
        if native_hf:
            native = json.loads(native_hf)
            entry["vs_t08"] = {
                **S.compare_segments(native, t08_ts, hf_fixture),
                "f1_iou075": S.segment_f1(
                    native["segments"],
                    t08_ts["result"]["episodes"][hf_fixture]["segments"],
                ),
            }
        summary["hf_tempseg"] = entry
    if "hf_captioner" in wanted:
        jobs = [
            {
                "kind": "cli",
                "stage": "segment",
                "module": "replay_segmenter@1",
                "gpu": "none",
                "fixture": fixture,
                "local": True,
            },
            {
                "kind": "cli",
                "stage": "caption",
                "module": "flora_captioner_hf@1",
                "gpu": gpu,
                "fixture": fixture,
                "segments_from": 0,
                "segments_limit": hf_segments,
                "budget_s": 3600,
                "deadline_s": hf_deadline_s,
            },
        ]
        t = time.time()
        res = smoke_captioner.remote(jobs)
        ledger_line(
            f"smoke_hf_captioner {fixture}",
            time.time() - t,
            gpu=True,
            cpu=8,
            mem_gib=64,
        )
        _save_results(out, f"hf_captioner_{fixture}", res)
        _, cli = res["results"]
        entry = {"cli_receipt": _cli_receipt(cli), "container_s": res["container_s"]}
        if cli["files"].get("captions.json"):
            entry["captions_vs_t08"] = S.compare_captions(
                json.loads(cli["files"]["captions.json"]), t08_cap, fixture
            )
        summary["hf_captioner"] = entry
    _write(
        out,
        f"summary_{fixture}_{only.replace(',', '+')}.json",
        json.dumps(summary, indent=1, default=str),
    )
    print(json.dumps(summary, indent=1, default=str))
    return summary


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
    run_smoke(fixture, only, t08, out, hf_fixture, hf_segments, hf_deadline_s)
