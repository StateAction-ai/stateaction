"""Portable FP8 export: compressed-tensors safetensors reproducing vLLM's load-time `fp8_per_tensor` (SA-93).

vLLM's online quantizer takes ONE per-tensor scale per fused module (qkv_proj, gate_up_proj, in_proj_qkvz):
scale = max|w_bf16| / 448 over the whole concatenated weight, then qweight = scaled_fp8_quant(w, scale). The export
does exactly that with vLLM's own op, then writes each member of a fused module with the shared scale, so vLLM's
compressed-tensors loader (requantize_with_max_scale) is an identity and the restored engine matches the fresh one.
`group_modules` and `quantization_config` are pure and unit-tested; `export_checkpoint` needs torch, safetensors and vLLM.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from . import pins

# Fused modules in vLLM, in packed order (matches `packed_modules_mapping`).
FUSED = {
    "self_attn": [("q_proj", "k_proj", "v_proj")],
    "linear_attn": [("in_proj_qkv", "in_proj_z")],
    "mlp": [("gate_proj", "up_proj")],
}
SINGLE = {"self_attn": ("o_proj",), "linear_attn": ("out_proj",), "mlp": ("down_proj",)}
WEIGHT_RE = re.compile(
    r"^(?P<prefix>model\.language_model\.layers\.\d+\.(?P<kind>self_attn|linear_attn|mlp))\.(?P<leaf>[a-z_]+)\.weight$"
)
KEEP_FP32_SUFFIX = ("A_log", "dt_bias")
SHARD_BYTES = 5 << 30


def group_modules(names: list[str]) -> list[tuple[str, list[str]]]:
    """Quantized weight groups: [(group_key, [weight names in packed order])]. Everything else stays BF16."""
    have = set(names)
    groups: list[tuple[str, list[str]]] = []
    seen: set[str] = set()
    for n in sorted(names):
        m = WEIGHT_RE.match(n)
        if not m or n in seen:
            continue
        prefix, kind, leaf = m["prefix"], m["kind"], m["leaf"]
        fused = next((g for g in FUSED[kind] if leaf in g), None)
        if fused:
            members = [f"{prefix}.{x}.weight" for x in fused]
            if not all(x in have for x in members):
                raise ValueError(f"incomplete fused group for {n}: {members}")
            seen.update(members)
            groups.append((f"{prefix}.{'+'.join(fused)}", members))
        elif leaf in SINGLE[kind]:
            seen.add(n)
            groups.append((f"{prefix}.{leaf}", [n]))
    return groups


def quantization_config(activation_strategy: str = "token") -> dict[str, Any]:
    """compressed-tensors config: static per-tensor FP8 weights, dynamic FP8 activations, vLLM's IGNORE plus lm_head."""
    return {
        "quant_method": "compressed-tensors",
        "format": "float-quantized",
        "quantization_status": "compressed",
        "config_groups": {
            "group_0": {
                "targets": ["Linear"],
                "weights": {
                    "num_bits": 8,
                    "type": "float",
                    "strategy": "tensor",
                    "symmetric": True,
                    "dynamic": False,
                    "observer": "minmax",
                },
                "input_activations": {
                    "num_bits": 8,
                    "type": "float",
                    "strategy": activation_strategy,
                    "symmetric": True,
                    "dynamic": True,
                },
            }
        },
        "ignore": [*pins.IGNORE, "lm_head", "re:.*lm_head.*"],
    }


def keep_dtype(name: str, dtype: Any, torch: Any) -> Any:
    """Non-quantized tensors: A_log and dt_bias keep FP32; other FP32 is cast to BF16 exactly as vLLM's loader does."""
    if name.endswith(KEEP_FP32_SUFFIX):
        return dtype
    return torch.bfloat16 if dtype == torch.float32 else dtype


def export_checkpoint(
    src: str, dst: str, expected_fp8_modules: int, activation_strategy: str = "token"
) -> dict[str, Any]:
    import shutil

    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file
    from vllm import _custom_ops as ops

    sp, dp = Path(src), Path(dst)
    shutil.rmtree(dp, ignore_errors=True)
    dp.mkdir(parents=True)
    weight_map: dict[str, str] = json.loads(
        (sp / "model.safetensors.index.json").read_text()
    )["weight_map"]
    groups = group_modules(list(weight_map))
    if len(groups) != expected_fp8_modules:
        raise RuntimeError(
            f"export would quantize {len(groups)} modules, vLLM quantizes {expected_fp8_modules}"
        )
    files: dict[str, Any] = {}

    def get(name: str) -> torch.Tensor:
        f = files.get(weight_map[name])
        if f is None:
            f = files[weight_map[name]] = safe_open(
                str(sp / weight_map[name]), framework="pt", device="cpu"
            )
        return f.get_tensor(name)

    quant_members = {m for _, ms in groups for m in ms}
    fp8_max = torch.tensor(
        448.0, device="cuda", dtype=torch.float32
    )  # same 0-d divisor as vLLM's _fp8_scale
    out: dict[str, torch.Tensor] = {}
    shards: list[dict[str, torch.Tensor]] = []
    cur_bytes = 0
    stats = {
        "quantized_modules": len(groups),
        "dropped_extra_state": 0,
        "scale_min": None,
        "scale_max": None,
    }

    def put(k: str, t: torch.Tensor) -> None:
        nonlocal out, cur_bytes
        n = t.numel() * t.element_size()
        if out and cur_bytes + n > SHARD_BYTES:
            shards.append(out)
            out, cur_bytes = {}, 0
        out[k] = t.contiguous().cpu()
        cur_bytes += n

    for key, members in groups:
        ws = [get(m).to("cuda").to(torch.bfloat16) for m in members]
        cat = torch.cat(ws, dim=0)
        amax = (
            torch.maximum(*[x.abs() for x in cat.aminmax()])
            .reshape(1)
            .to(torch.float32)
        )
        scale = amax / fp8_max
        q, _ = ops.scaled_fp8_quant(cat, scale=scale)
        rows = [w.shape[0] for w in ws]
        for m, part in zip(members, q.split(rows, dim=0), strict=True):
            put(m, part)
            put(m[: -len(".weight")] + ".weight_scale", scale.clone())
        s = float(scale.item())
        stats["scale_min"] = (
            s if stats["scale_min"] is None else min(stats["scale_min"], s)
        )
        stats["scale_max"] = (
            s if stats["scale_max"] is None else max(stats["scale_max"], s)
        )
        del ws, cat, q
    for name in sorted(weight_map):
        if name in quant_members:
            continue
        t = get(name)
        if name.endswith("._extra_state"):
            if t.dtype == torch.uint8 and t.numel() == 0:
                stats["dropped_extra_state"] += 1
                continue
            raise ValueError(f"{name}: _extra_state is not empty")
        put(name, t.to(keep_dtype(name, t.dtype, torch)))
    if out:
        shards.append(out)
    index: dict[str, str] = {}
    for i, sh in enumerate(shards, 1):
        fn = f"model-{i:05d}-of-{len(shards):05d}.safetensors"
        save_file(sh, str(dp / fn), metadata={"format": "pt"})
        index.update({k: fn for k in sh})
    (dp / "model.safetensors.index.json").write_text(
        json.dumps({"metadata": {}, "weight_map": index}, indent=1)
    )
    cfg = json.loads((sp / "config.json").read_text())
    cfg["quantization_config"] = quantization_config(activation_strategy)
    (dp / "config.json").write_text(json.dumps(cfg, indent=1))
    for f in sorted(sp.iterdir()):
        if (
            f.is_file()
            and f.suffix in (".json", ".jinja", ".txt")
            and f.name
            not in {
                "config.json",
                "model.safetensors.index.json",
                "merge.json",
                "adapter_config.json",
                "SOURCE_MANIFEST.sha256",
            }
        ):
            shutil.copy(f, dp / f.name)
    stats["shards"] = len(shards)
    stats["tensors"] = len(index)
    return stats
