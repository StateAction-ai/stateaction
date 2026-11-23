"""Modal GPU stage functions for FLORA TempSeg and Captioner (SA-94, ticket T09).

The ONLY file here that imports `modal` for jobs. `flora_tempseg` and `flora_captioner` each run one
recipe stage in one single-use RTX PRO 6000 container: they add the provider call ID to the controller's
scoped stage bootstrap and pipe it to `python -m stateaction_processing run-stage <call id>` (SA-90).
The stage claim, source read, module run and uploads belong to that entrypoint. Which module runs
(vLLM fp8 or the HF fallback) is chosen only by `recipe.<stage>.module`, never automatically.

The models Volume is mounted read-only; the published checkpoints are restored from it and nothing
quantizes at job time. The spawn side (SA-91, stage runner) calls these functions by app name
`stateaction-flora-stages` with one argument, the stage bootstrap JSON string.

Operator smoke and the CPU dry run live in `modal_stage_smoke.py` (a separate app), so a deploy of this
file exposes only the two production functions. The app name and the module-to-function map are in
`flora_ext/stage_settings.py`, the single source the controller seam (SA-91) is configured from.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import modal

HERE = Path(__file__).resolve().parent
REPO = (
    HERE.parents[1] if len(HERE.parents) > 1 else HERE
)  # in the container the file sits in /root
sys.path.insert(0, str(HERE))
from flora_ext import pins, stage_settings  # noqa: E402

APP_NAME = stage_settings.APP_NAME
app = modal.App(APP_NAME)  # production app: exactly the two stage functions
models = modal.Volume.from_name(stage_settings.MODELS_VOLUME, version=2)

FLORA_SRC = "/opt/flora-src"
APP_ROOT = "/app"
_ignore = ["**/__pycache__", "**/tests/**", "**/.venv*/**"]
ENV = {
    "HF_HOME": "/tmp/hf",
    "FLORA_MODEL_CACHE": "/tmp/flora-models",
    "STATEACTION_FLORA_CHECKPOINTS": pins.CHECKPOINT_ROOT,
    "PYTHONUNBUFFERED": "1",
    "TOKENIZERS_PARALLELISM": "false",
    "HF_XET_HIGH_PERFORMANCE": "1",
    "VLLM_LOGGING_LEVEL": "INFO",
    "PYTHONNOUSERSITE": "1",
    "STATEACTION_CAPTURE_CONTRACT_DIR": f"{APP_ROOT}/packages/contracts/capture",
    "PYTHONPATH": f"/root:{APP_ROOT}/workers/processing/src:{APP_ROOT}/packages/contracts/python/src",
}

# One image for every stage module: vLLM (fp8 restore) and the HF reference stack, FLORA cloned at the
# pinned commit, our long-video wrapper copied into its tempseg tree, and the processing worker code.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ca-certificates")
    .pip_install(
        f"vllm=={pins.VLLM_VERSION}", f"transformers=={pins.TRANSFORMERS_VERSION}"
    )
    .pip_install(
        "av==16.0.1",
        "Pillow==12.3.0",
        "huggingface_hub==2.4.0",
        "hf_xet==1.8.0",
        "psutil==7.2.2",
        "peft==0.18.1",
        "accelerate==1.15.0",
        "jsonschema==4.26.0",
    )
    .run_commands(
        f"git clone --quiet {pins.FLORA_SRC_REPO} {FLORA_SRC}",
        f"git -C {FLORA_SRC} checkout --quiet {pins.FLORA_SRC_REV}",
        f"mkdir -p /flora && cp -r {FLORA_SRC}/tempseg /flora/tempseg && cp -r {FLORA_SRC}/captioner /flora/captioner",
    )
    .env(ENV)
    .add_local_dir(
        str(HERE / "flora_ext" / "longvideo"),
        "/flora/tempseg/batch_utils/longvideo",
        copy=True,
        ignore=_ignore,
    )
    .add_local_python_source("flora_ext", copy=True)
    .add_local_dir(
        str(REPO / "workers/processing/src"),
        f"{APP_ROOT}/workers/processing/src",
        copy=True,
        ignore=_ignore,
    )
    .add_local_dir(
        str(REPO / "packages/contracts/python/src"),
        f"{APP_ROOT}/packages/contracts/python/src",
        copy=True,
        ignore=_ignore,
    )
    .add_local_dir(
        str(REPO / "packages/contracts/api"),
        f"{APP_ROOT}/packages/contracts/api",
        copy=True,
    )
    .add_local_dir(
        str(REPO / "packages/contracts/capture"),
        f"{APP_ROOT}/packages/contracts/capture",
        copy=True,
    )
)


def _options(name: str) -> dict[str, Any]:
    opts = dict(stage_settings.function_options(name))
    mounts: dict[str, Any] = {"/models": models.read_only()}
    return dict(image=image, volumes=mounts, **opts)


def _deadline(name: str) -> float:
    return float(stage_settings.budget_s(name) - stage_settings.WRAPPER_MARGIN_S)


@app.function(**_options("flora_tempseg"))
def flora_tempseg(bootstrap_json: str) -> dict[str, Any]:
    """Run the `segment` stage for one job (production entry; the module comes from the bootstrap)."""
    from flora_ext.stage_wrapper import run_stage_bootstrap

    return run_stage_bootstrap(
        bootstrap_json,
        modal.current_function_call_id(),
        deadline_s=_deadline("flora_tempseg"),
    )


@app.function(**_options("flora_captioner"))
def flora_captioner(bootstrap_json: str) -> dict[str, Any]:
    """Run the `caption` stage for one job (production entry; the module comes from the bootstrap)."""
    from flora_ext.stage_wrapper import run_stage_bootstrap

    return run_stage_bootstrap(
        bootstrap_json,
        modal.current_function_call_id(),
        deadline_s=_deadline("flora_captioner"),
    )
