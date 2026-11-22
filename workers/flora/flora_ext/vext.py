"""vLLM worker extension for FLORA checkpoints (imported in every worker before weights load).

1. Drops the empty `_extra_state` entries (Captioner stores 0-length U8 tensors; same logic as FLORA
   rewarder/batch_utils/vllm_compat.py).
2. If QUANT_DT_BIAS_FP32=1, keeps GDN `dt_bias` in FP32 (vLLM 0.34 creates it at the default dtype; `A_log` is
   already FP32). FLORA keeps both FP32.
"""

from __future__ import annotations

import os
from collections import Counter

import torch
from torch import nn

EMPTY = b"\x80\x04N."


def _drop(weights):
    for name, t in weights:
        if name.endswith("._extra_state"):
            if t.dtype == torch.uint8 and (
                t.numel() == 0 or bytes(t.flatten().tolist()) == EMPTY
            ):
                continue
            raise ValueError(f"{name}: _extra_state is not empty")
        yield name, t


def _patch() -> None:
    # vLLM 0.34 serves Qwen3.5 from vllm/models/qwen3_5/nvidia/model.py; patch the shared loader.
    from vllm.model_executor.models.utils import AutoWeightsLoader as L

    if not getattr(L.load_weights, "_q", False):
        orig = L.load_weights

        def load_weights(self, weights, *a, **k):
            return orig(self, _drop(weights), *a, **k)

        load_weights._q = True
        L.load_weights = load_weights
    if os.environ.get("QUANT_DT_BIAS_FP32") == "1":
        from vllm.model_executor.layers.mamba.gdn import qwen_gdn_linear_attn as g
        from vllm.model_executor.utils import set_weight_attrs

        G = g.QwenGatedDeltaNetAttention
        if not getattr(G.__init__, "_q", False):
            oinit = G.__init__

            def __init__(self, *a, **k):
                oinit(self, *a, **k)
                if self.dt_bias.dtype != torch.float32:
                    loader = self.dt_bias.weight_loader
                    self.dt_bias = nn.Parameter(
                        self.dt_bias.data.float(), requires_grad=False
                    )
                    set_weight_attrs(self.dt_bias, {"weight_loader": loader})

            __init__._q = True
            G.__init__ = __init__


_patch()


class QuantExt:
    def q_inspect(self):
        m = self.model_runner.model
        dt, by, gdn, quant = Counter(), Counter(), Counter(), Counter()
        for n, p in m.named_parameters():
            dt[str(p.dtype)] += p.numel()
            by[str(p.dtype)] += p.numel() * p.element_size()
            if n.endswith("dt_bias") or n.endswith("A_log"):
                gdn[n.rsplit(".", 1)[1] + ":" + str(p.dtype)] += 1
        for n, mod in m.named_modules():
            qm = getattr(mod, "quant_method", None)
            if qm is not None:
                quant[("visual:" if "visual" in n else "lm:") + type(qm).__name__] += 1
        return dict(
            param_numel_by_dtype=dict(dt),
            param_bytes_by_dtype=dict(by),
            param_gib=round(sum(by.values()) / 2**30, 3),
            gdn_param_dtypes=dict(gdn),
            quant_methods=dict(quant),
            torch_alloc_gib=round(torch.cuda.memory_allocated() / 2**30, 3),
        )

    def q_layout(self):
        """Names of FP8-quantized modules, the model's fused-module mapping and each fused module's partition sizes."""
        m = self.model_runner.model
        fp8 = {}
        for n, mod in m.named_modules():
            qm = getattr(mod, "quant_method", None)
            if qm is not None and "Fp8" in type(qm).__name__:
                fp8[n] = list(getattr(mod, "output_partition_sizes", []) or [])
        return dict(
            fp8_modules=fp8,
            packed_modules_mapping=dict(getattr(m, "packed_modules_mapping", {}) or {}),
        )
