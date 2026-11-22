"""vLLM worker extension for FLORA checkpoints (imported in every vLLM worker before weights load).

Copied from the SA-86 reference run (`modal-quant/vext.py`); behaviour unchanged.

1. Drops the empty `_extra_state` entries (same logic as FLORA rewarder/batch_utils/vllm_compat.py).
2. If QUANT_DT_BIAS_FP32=1: keeps GDN dt_bias in FP32 (vLLM 0.34 creates it at the default dtype;
   A_log is already FP32). FLORA keeps both FP32 (production_gdn_fix._keep_native_gdn_fp32).
"""

import os
from collections import Counter

import torch
from torch import nn

EMPTY = b"\x80\x04N."


def _drop(weights):
    for name, t in weights:
        if name.endswith("._extra_state"):
            # Captioner: 0-length U8
            if t.dtype == torch.uint8 and (
                t.numel() == 0 or bytes(t.flatten().tolist()) == EMPTY
            ):
                continue
            raise ValueError(f"{name}: _extra_state is not empty")
        yield name, t


def _patch():
    # vLLM 0.34 serves Qwen3.5 from vllm/models/qwen3_5/nvidia/model.py; patch the shared loader instead
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
        dt = Counter()
        by = Counter()
        gdn = Counter()
        quant = Counter()
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
            torch_peak_gib=round(torch.cuda.max_memory_allocated() / 2**30, 3),
        )
