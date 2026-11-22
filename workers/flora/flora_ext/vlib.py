"""vLLM engine and request helpers for the FLORA publish and restore check (SA-93)."""

from __future__ import annotations

import os
from typing import Any

from . import pins

IGNORE = pins.IGNORE


def build_llm(
    model_dir: str,
    mode: str,
    *,
    max_num_seqs: int = 16,
    gpu_util: float = 0.88,
    videos: int = 4,
) -> Any:
    """mode: fresh (load-time fp8_per_tensor), portable (compressed-tensors checkpoint), sharded (vLLM sharded state)."""
    os.environ["QUANT_DT_BIAS_FP32"] = "1"
    from vllm import LLM

    kw: dict[str, Any] = {}
    if mode in ("fresh", "sharded"):
        kw["quantization"] = "fp8_per_tensor"
        kw["quantization_config"] = {"ignore": IGNORE}
    if mode == "portable":
        kw["quantization"] = "compressed-tensors"
    if mode == "sharded":
        kw["load_format"] = "sharded_state"
    elif mode not in ("fresh", "portable", "bf16"):
        raise ValueError(mode)
    return LLM(
        model=model_dir,
        gpu_memory_utilization=gpu_util,
        max_num_seqs=max_num_seqs,
        limit_mm_per_prompt={"image": 0, "video": videos},
        mm_processor_kwargs={"do_sample_frames": False},
        worker_extension_cls="flora_ext.vext.QuantExt",
        **pins.ENGINE,
        **kw,
    )


def make_req(
    mode: str, rec: dict, arrays: list, video_token: str = "<|video_pad|>"
) -> dict:
    vids = [
        (a, dict(m, do_sample_frames=False))
        for a, m in zip(arrays, rec["metadata"], strict=True)
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
            video_token, "<|vision_start|>" + video_token + "<|vision_end|>"
        )
    return {
        "prompt": text,
        "multi_modal_data": mm,
        "mm_processor_kwargs": {"do_sample_frames": False},
    }


def pick_mode(
    llm: Any, rec: dict, arrays: list, sampling_params: Any
) -> tuple[str | None, list[dict]]:
    """First input mapping whose vLLM prompt token ids equal FLORA's (token_ids, text_wrapped, text_raw)."""
    tried: list[dict] = []
    for mode in ("token_ids", "text_wrapped", "text_raw"):
        try:
            o = llm.generate(
                [make_req(mode, rec, arrays)],
                sampling_params(max_tokens=1),
                use_tqdm=False,
            )[0]
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
        except Exception as e:  # noqa: BLE001 - recorded, not swallowed
            tried.append(dict(mode=mode, ok=False, error=repr(e)[:600]))
    return None, tried
