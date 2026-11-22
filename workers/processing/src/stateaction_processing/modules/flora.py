"""FLORA TempSeg and Captioner stage modules (SA-94): thin registry entries over `flora_ext.stage_glue`.

The implementation lives in `workers/flora/flora_ext` (the FLORA GPU image puts it on PYTHONPATH next to
this package); keeping it there lets the processing worker image stay free of vLLM and FLORA. A module
function runs only after the stage claim was won (registry rule), and an image without `flora_ext`
fails the stage with `flora_runtime_unavailable` instead of substituting another engine.
"""

from __future__ import annotations

import importlib
from typing import Any

from ..stage_docs import ModuleOutput, StageContext, StageError


def _glue() -> Any:
    try:
        return importlib.import_module("flora_ext.stage_glue")
    except ImportError:
        raise StageError("flora_runtime_unavailable") from None


def run_segment_vllm(ctx: StageContext) -> ModuleOutput:
    out: ModuleOutput = _glue().run_segment(ctx, "vllm")
    return out


def run_segment_hf(ctx: StageContext) -> ModuleOutput:
    out: ModuleOutput = _glue().run_segment(ctx, "hf")
    return out


def run_caption_vllm(ctx: StageContext) -> ModuleOutput:
    out: ModuleOutput = _glue().run_caption(ctx, "vllm")
    return out


def run_caption_hf(ctx: StageContext) -> ModuleOutput:
    out: ModuleOutput = _glue().run_caption(ctx, "hf")
    return out
