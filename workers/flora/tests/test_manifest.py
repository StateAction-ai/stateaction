import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flora_ext import manifest as M  # noqa: E402
from flora_ext import parity as P  # noqa: E402
from flora_ext import pins, stage_settings  # noqa: E402

H = "a" * 64
RUNTIME = {
    "vllm": "0.34.0",
    "torch": "2.14.0",
    "cuda": "13.0",
    "transformers": "5.22.1",
    "gpu_name": "RTX PRO 6000",
    "gpu_arch": "sm_120",
}
PARITY = {"passed": True, "checks": {}}


def make(root: Path, model: str = "captioner", fmt: str = "vllm-sharded-state", **over):
    (root / "w").mkdir(parents=True, exist_ok=True)
    (root / "w/a.bin").write_bytes(b"abc")
    (root / "config.json").write_text("{}")
    source = {"source_manifest_sha256": H}
    if model == "tempseg":
        source |= {"adapter_sha256": pins.ADAPTER_SHA256, "merge_digest": H}
    kw = dict(
        model=model,
        fmt=fmt,
        files=M.file_digests(root),
        source=source,
        runtime=RUNTIME,
        code_revision="deadbeef",
        parity_receipt=PARITY,
    )
    kw.update(over)
    return M.build_manifest(**kw)


class ManifestTests(unittest.TestCase):
    def test_roundtrip_verifies(self):
        for model in ("captioner", "tempseg"):
            with tempfile.TemporaryDirectory() as d:
                root = Path(d)
                M.write_manifest(root, make(root, model))
                self.assertEqual(M.verify_checkpoint(root), [])

    def test_checkpoint_id_and_pins(self):
        with tempfile.TemporaryDirectory() as d:
            m = make(Path(d), "tempseg")
        self.assertEqual(
            m["checkpoint_id"], "tempseg-114a1076-fp8_per_tensor-vllm-sharded-state-v1"
        )
        self.assertEqual(m["hf"]["revision"], pins.TEMPSEG_REV)
        self.assertEqual(m["base"]["revision"], pins.BASE_REV)
        self.assertEqual(pins.CAPTIONER_REV[:8], "fef0bbfe")
        self.assertEqual(pins.BASE_REV[:8], "c2022362")

    def test_controller_checkpoint_manifest_identity_matches_worker_pins(self):
        root = Path(__file__).resolve().parents[3]
        release = json.loads(
            (root / "packages/contracts/api/flora-checkpoints.v1.json").read_text()
        )
        self.assertEqual(release["volumeName"], stage_settings.MODELS_VOLUME)
        self.assertEqual(release["volumeVersion"], 2)
        self.assertEqual(release["checkpoints"].keys(), pins.PUBLISHED.keys())
        for model, pin in pins.PUBLISHED.items():
            self.assertEqual(
                release["checkpoints"][model],
                {
                    "checkpointId": pin["checkpoint_id"],
                    "manifestSha256": pin["manifest_sha256"],
                    "modelRevision": pins.MODELS[model]["revision"],
                },
            )

    def test_detects_tamper_missing_extra_and_size(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            M.write_manifest(root, make(root))
            (root / "w/a.bin").write_bytes(b"abd")  # same size, other content
            self.assertEqual(M.verify_checkpoint(root), ["sha256 mismatch w/a.bin"])
            self.assertEqual(M.verify_checkpoint(root, deep=False), [])
            (root / "w/a.bin").write_bytes(b"abcd")
            self.assertEqual(
                M.verify_checkpoint(root, deep=False), ["size mismatch w/a.bin"]
            )
            (root / "w/a.bin").unlink()
            (root / "extra").write_text("x")
            self.assertEqual(
                M.verify_checkpoint(root),
                ["unlisted file extra", "missing file w/a.bin"],
            )

    def test_missing_manifest_and_invalid_json(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            self.assertEqual(M.verify_checkpoint(root), ["missing MANIFEST.json"])
            (root / "MANIFEST.json").write_text("{")
            self.assertTrue(
                M.verify_checkpoint(root)[0].startswith("manifest is not JSON")
            )

    def test_rejects_failed_parity_and_unpinned_identity(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(M.ManifestError):
                make(Path(d), parity_receipt={"passed": False})
            with self.assertRaises(M.ManifestError):
                make(
                    Path(d),
                    "tempseg",
                    source={
                        "source_manifest_sha256": H,
                        "adapter_sha256": "0" * 64,
                        "merge_digest": H,
                    },
                )
            with self.assertRaises(M.ManifestError):
                make(Path(d), runtime={**RUNTIME, "gpu_arch": ""})
            with self.assertRaises(M.ManifestError):
                make(Path(d), quant={"quantization": "fp8_per_tensor", "ignore": []})

    def test_validate_catches_edited_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            m = make(Path(d))
        m["hf"]["revision"] = "0" * 40
        self.assertIn("hf repo/revision is not the pinned one", M.validate_manifest(m))
        m["checkpoint_id"] = "other"
        self.assertIn(
            "checkpoint_id does not match model, revision and format",
            M.validate_manifest(m),
        )

    def test_publish_refuses_to_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            final = Path(d) / "captioner-x"
            M.refuse_existing(final)
            final.mkdir()
            with self.assertRaises(M.ManifestError):
                M.refuse_existing(final)

    def test_job_side_guard_fails_loudly_when_missing(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "absent"
            with self.assertRaises(M.ManifestError):
                M.require_published(root)
            root.mkdir()
            M.write_manifest(root, make(root))
            self.assertEqual(M.require_published(root)["model"], "captioner")

    def test_tree_digest_order_independent(self):
        a = {"x": {"sha256": H, "bytes": 1}, "y": {"sha256": "b" * 64, "bytes": 2}}
        self.assertEqual(
            M.tree_digest(a), M.tree_digest(dict(reversed(list(a.items()))))
        )
        self.assertNotEqual(M.tree_digest(a), M.tree_digest({"x": a["x"]}))

    def test_manifest_json_is_stable(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            m = make(root)
            M.write_manifest(root, m)
            self.assertEqual(json.loads((root / "MANIFEST.json").read_text()), m)


class ParityTests(unittest.TestCase):
    def test_iou_and_matching(self):
        self.assertEqual(P.tiou((0, 2), (1, 3)), 1 / 3)
        self.assertEqual(P.match_count([(0, 4), (4, 8)], [(0, 4), (4, 8)]), (2, 2, 2))
        # one-to-one: two predictions cannot claim one reference
        self.assertEqual(P.match_count([(0, 4), (0, 4.1)], [(0, 4)]), (1, 2, 1))
        self.assertEqual(P.match_count([(0, 1)], [(5, 6)]), (0, 1, 1))

    def test_pooled_f1(self):
        r = P.pooled_f1([([(0, 4)], [(0, 4)]), ([(0, 1), (2, 3)], [(0, 1)])])
        self.assertEqual((r["tp"], r["n_pred"], r["n_ref"]), (2, 3, 2))
        self.assertAlmostEqual(r["f1"], 4 / 5)
        self.assertEqual(P.pooled_f1([([], [])])["f1"], 0.0)

    def test_snap(self):
        self.assertEqual(
            P.snap_to_reference([(1, 4), (4, 9)], [(0, 5), (5, 10)]),
            [(0.0, 4.0), (4.0, 10.0)],
        )

    def test_exact_rate(self):
        self.assertEqual(P.exact_rate(["a", "b"], ["a", "c"]), 0.5)
        with self.assertRaises(ValueError):
            P.exact_rate([], [])

    def test_verdicts(self):
        ok = P.tempseg_verdict(
            restored_vs_t3_f1=0.98,
            restored_gold_f1=0.6,
            t3_gold_f1=0.61,
            byte_equal=True,
            new_failed_windows=0,
        )
        self.assertTrue(ok["passed"])
        for kw in (
            {"restored_vs_t3_f1": 0.97},
            {"restored_gold_f1": 0.5},
            {"byte_equal": False},
            {"new_failed_windows": 1},
        ):
            args = (
                dict(
                    restored_vs_t3_f1=0.99,
                    restored_gold_f1=0.6,
                    t3_gold_f1=0.6,
                    byte_equal=True,
                    new_failed_windows=0,
                )
                | kw
            )
            self.assertFalse(P.tempseg_verdict(**args)["passed"], kw)
        self.assertTrue(
            P.captioner_verdict(exact_vs_t01=0.9, byte_equal=True, new_failed=0)[
                "passed"
            ]
        )
        self.assertFalse(
            P.captioner_verdict(exact_vs_t01=0.89, byte_equal=True, new_failed=0)[
                "passed"
            ]
        )
        self.assertFalse(
            P.captioner_verdict(exact_vs_t01=1.0, byte_equal=False, new_failed=0)[
                "passed"
            ]
        )


if __name__ == "__main__":
    unittest.main()
