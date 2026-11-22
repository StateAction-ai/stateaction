import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flora_ext import export as E  # noqa: E402
from flora_ext import parity as P  # noqa: E402
from flora_ext import pins  # noqa: E402

L = "model.language_model.layers"


def names(n_linear: int = 1, n_attn: int = 1) -> list[str]:
    out = [
        "lm_head.weight",
        "model.language_model.embed_tokens.weight",
        "model.visual.blocks.0.attn.qkv.weight",
        "model.visual.blocks.0.mlp.linear_fc1.weight",
    ]
    for i in range(n_linear):
        p = f"{L}.{i}"
        out += [
            f"{p}.linear_attn.{x}"
            for x in (
                "in_proj_qkv.weight",
                "in_proj_z.weight",
                "in_proj_a.weight",
                "in_proj_b.weight",
                "out_proj.weight",
                "conv1d.weight",
                "A_log",
                "dt_bias",
                "norm.weight",
            )
        ]
        out += [
            f"{p}.mlp.{x}.weight" for x in ("gate_proj", "up_proj", "down_proj")
        ] + [f"{p}.input_layernorm.weight"]
    for i in range(n_linear, n_linear + n_attn):
        p = f"{L}.{i}"
        out += [
            f"{p}.self_attn.{x}.weight"
            for x in ("q_proj", "k_proj", "v_proj", "o_proj", "q_norm", "k_norm")
        ]
        out += [f"{p}.mlp.{x}.weight" for x in ("gate_proj", "up_proj", "down_proj")]
    return out


class ExportTests(unittest.TestCase):
    def test_groups_follow_vllm_fusion(self):
        g = dict(E.group_modules(names()))
        self.assertEqual(
            len(g), 4 + 4
        )  # GDN: qkvz, out_proj, gate_up, down; attention: qkv, o_proj, gate_up, down
        self.assertEqual(
            g[f"{L}.0.linear_attn.in_proj_qkv+in_proj_z"],
            [
                f"{L}.0.linear_attn.in_proj_qkv.weight",
                f"{L}.0.linear_attn.in_proj_z.weight",
            ],
        )
        self.assertEqual(
            g[f"{L}.1.self_attn.q_proj+k_proj+v_proj"][2],
            f"{L}.1.self_attn.v_proj.weight",
        )
        self.assertEqual(
            g[f"{L}.0.mlp.gate_proj+up_proj"],
            [f"{L}.0.mlp.gate_proj.weight", f"{L}.0.mlp.up_proj.weight"],
        )

    def test_caveats_stay_bf16(self):
        quantized = {m for _, ms in E.group_modules(names()) for m in ms}
        for n in names():
            if any(
                t in n
                for t in (
                    "visual",
                    "in_proj_a",
                    "in_proj_b",
                    "conv1d",
                    "embed_tokens",
                    "lm_head",
                    "norm",
                    "A_log",
                    "dt_bias",
                )
            ):
                self.assertNotIn(n, quantized, n)

    def test_incomplete_fused_group_is_an_error(self):
        with self.assertRaises(ValueError):
            E.group_modules([n for n in names() if not n.endswith("v_proj.weight")])

    def test_counts_match_reference_inspections(self):
        # TempSeg: 24 GDN + 8 attention layers = 128 FP8 modules; Captioner: 48 + 16 = 256 (measured with q_inspect)
        self.assertEqual(len(E.group_modules(names(24, 8))), 128)
        self.assertEqual(len(E.group_modules(names(48, 16))), 256)

    def test_quantization_config_keeps_ignore_list(self):
        q = E.quantization_config()
        self.assertEqual(q["quant_method"], "compressed-tensors")
        self.assertEqual(q["config_groups"]["group_0"]["weights"]["strategy"], "tensor")
        self.assertTrue(q["config_groups"]["group_0"]["input_activations"]["dynamic"])
        for pat in pins.IGNORE:
            self.assertIn(pat, q["ignore"])
        self.assertIn("lm_head", q["ignore"])

    def test_engine_pins(self):
        self.assertEqual(pins.ENGINE["gdn_prefill_backend"], "triton")
        self.assertEqual(pins.QUANT_CONFIG["quantization"], "fp8_per_tensor")


class CompareTests(unittest.TestCase):
    def _ts(self, segs, texts=("a",)):
        return {
            "result": {
                "episodes": {
                    "e": {
                        "segments": [dict(start_s=a, end_s=b) for a, b in segs],
                        "windows_failed": [],
                        "windows_total": 1,
                    }
                },
                "windows": [
                    dict(
                        ep="e",
                        scope_id=str(i),
                        source="batch",
                        input_digest="d",
                        text=t,
                        gen_ids=[i],
                        complete=True,
                    )
                    for i, t in enumerate(texts)
                ],
            }
        }

    def test_tempseg_equal_runs_pass(self):
        segs = [(0, 4), (4, 8)]
        v = P.compare_tempseg(self._ts(segs), self._ts(segs), {"e": segs}, {"e": segs})
        self.assertTrue(v["passed"], v)

    def test_tempseg_changed_text_is_not_byte_equal(self):
        segs = [(0, 4), (4, 8)]
        v = P.compare_tempseg(
            self._ts(segs, ("a",)), self._ts(segs, ("b",)), {"e": segs}, {"e": segs}
        )
        self.assertFalse(v["passed"])
        self.assertFalse(v["checks"]["restore_byte_equal_to_fresh"])

    def test_tempseg_new_failed_window_fails(self):
        segs = [(0, 4)]
        r = self._ts(segs)
        r["result"]["episodes"]["e"]["windows_failed"] = [{"window": 1}]
        self.assertFalse(
            P.compare_tempseg(self._ts(segs), r, {"e": segs}, {"e": segs})["checks"][
                "no_new_failed_windows"
            ]
        )

    def _cap(self, texts, status="complete"):
        rows = [
            dict(ep="e", event_index=i, status=status, gen_ids=[i], caption=t)
            for i, t in enumerate(texts)
        ]
        return {"result": {"captions": rows}}

    def test_captioner(self):
        t01 = {"e": [dict(status="complete", caption=t) for t in ("x", "y")]}
        self.assertTrue(
            P.compare_captioner(self._cap(["x", "y"]), self._cap(["x", "y"]), t01)[
                "passed"
            ]
        )
        low = P.compare_captioner(self._cap(["x", "z"]), self._cap(["x", "z"]), t01)
        self.assertFalse(low["passed"])  # 0.5 exact < 0.9
        failed = P.compare_captioner(
            self._cap(["x", "y"]), self._cap(["x", "y"], "failed"), t01
        )
        self.assertFalse(failed["passed"])


if __name__ == "__main__":
    unittest.main()
