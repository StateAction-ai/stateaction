"""Exercise the real recipe compiler, sandbox and local authoring commands."""

import errno
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from catalog import ROOT, bindings, modules, pretty
from compiler import compile_recipe
from local_run import run_local
from recipe import compiled_path, main, source_paths, sync
from sandbox import CompileError, canonical_json, run_sandbox
from types_codegen import SCHEMA


class RecipesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = modules(ROOT, check=True)
        cls.default = ROOT / "recipes/egocentric_default.py"
        cls.generated = bindings(cls.catalog).encode("utf-8")

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(ROOT / "core/recipe.py"), *args],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )

    def test_committed_examples_and_stubs(self):
        sync(ROOT, check=True)
        for path in source_paths(ROOT):
            with self.subTest(recipe=path.name):
                graph = json.loads(compiled_path(path).read_text())
                result = run_local(graph, ROOT, seconds=3)
                self.assertEqual(result["status"], "passed")
                self.assertTrue(
                    all(row["provenance"]["synthetic"] for row in result["runs"])
                )
                self.assertEqual(
                    {row["node"] for row in result["runs"]}, graph["nodes"].keys()
                )
        detailed = json.loads(
            (ROOT / "examples/compiled/caption_detailed.json").read_text()
        )
        self.assertEqual(
            detailed["nodes"]["caption"]["params"]["prompt"], "flora_detailed@1"
        )
        self.assertFalse(detailed["license"]["commercialUse"])
        motion = json.loads(
            (ROOT / "examples/compiled/with_motion_energy.json").read_text()
        )
        self.assertEqual(
            motion["nodes"]["motion"]["outputs"], {"energy": "motion_energy@1"}
        )

    def test_cli_graph_check_and_failed_window(self):
        path = "examples/caption_detailed.py"
        check = self.run_cli("check", path)
        self.assertEqual(check.returncode, 0, check.stderr)
        self.assertEqual(
            json.loads(check.stdout), json.loads(compiled_path(ROOT / path).read_text())
        )
        dot = self.run_cli("graph", path)
        self.assertEqual(dot.returncode, 0, dot.stderr)
        self.assertIn(
            "caption [clip, flora_captioner_vllm_fp8@1] <- clips, segment", dot.stdout
        )
        failed = self.run_cli(
            "run-local", path, "--fail-node", "segment", "--fail-window", "1"
        )
        self.assertEqual(failed.returncode, 1, failed.stderr)
        run = json.loads(failed.stdout)
        self.assertEqual(run["status"], "failed")
        self.assertEqual(
            {
                (row["node"], row["window"]["index"], row["status"])
                for row in run["runs"]
                if row["status"] != "stubbed"
            },
            {("segment", 1, "failed"), ("caption", 1, "blocked")},
        )
        for row in run["runs"]:
            self.assertEqual("outputs" in row, row["status"] == "stubbed")

    def test_friendly_diagnostics_from_the_compiler(self):
        original = self.default.read_text()
        cases = [
            ("wrong_edge", "segments=segment.segments", "segments=c.video", "Pass"),
            (
                "wrong_scope",
                'c.node(\n            "segment"',
                'r.node(\n            "segment"',
                "Call",
            ),
            ("invalid_gpu", 'gpu="RTX-PRO-6000"', 'gpu="unknown"', "Use"),
            (
                "invalid_parameter",
                "segments=segment.segments",
                'segments=segment.segments, prompt="missing@1"',
                "Check",
            ),
            (
                "invalid_budget",
                "budget.linear(240, 0.15)",
                "budget.linear(1000, 1)",
                "Keep",
            ),
            ("clip_cost_cap", 'usd("3.00")', 'usd("0.00")', "Reduce"),
        ]
        with tempfile.TemporaryDirectory(prefix="sa151-diagnostics-") as scratch:
            root = Path(scratch)
            schema = root / SCHEMA
            schema.parent.mkdir(parents=True)
            shutil.copy(ROOT / SCHEMA, schema)
            source = root / self.default.name
            for code, before, after, hint in cases:
                with self.subTest(code=code):
                    self.assertIn(before, original)
                    source.write_text(original.replace(before, after, 1))
                    with self.assertRaises(CompileError) as failure:
                        compile_recipe(source, root, self.catalog)
                    self.assertEqual(failure.exception.code, code)
                    self.assertGreater(failure.exception.line, 1)
                    self.assertIn(hint, failure.exception.fix)

    def test_whole_number_parameters_and_fractional_budget(self):
        with tempfile.TemporaryDirectory(prefix="sa151-params-") as scratch:
            root = Path(scratch)
            schema = root / SCHEMA
            schema.parent.mkdir(parents=True)
            shutil.copy(ROOT / SCHEMA, schema)
            source = root / "with_motion_energy.py"
            example = (ROOT / "examples/with_motion_energy.py").read_text()
            source.write_text(example.replace("scale=2", "scale=2.0"))
            with self.assertRaises(CompileError) as failure:
                compile_recipe(source, root, self.catalog)
            self.assertEqual(failure.exception.code, "invalid_parameter")
            self.assertIn("integer", failure.exception.fix)
            self.assertGreater(failure.exception.line, 1)
            source.write_text(
                example.replace("budget.fixed(10)", "budget.linear(10, 1e-6)")
            )
            graph = compile_recipe(source, root, self.catalog)
            self.assertEqual(
                graph["nodes"]["motion"]["resources"]["budget"]["perSourceSecond"],
                "0.000001",
            )

    def test_sandbox_denies_io_and_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="sa151-probes-") as scratch:
            path = Path(scratch) / "canary"
            path.write_text("synthetic")
            info = json.loads(
                run_sandbox(str(path).encode(), self.generated, policy_probe=True)
            )
            self.assertEqual(info["network_interfaces"], ["lo"])
            self.assertEqual(info["inherited_descriptors"], [])
            self.assertEqual(info["cpu"], [5, 5])
            self.assertEqual(info["address_space"], [536870912, 536870912])
            self.assertTrue(all(info["python_flags"]))
            self.assertEqual(info["before_hooks"]["read_host_canary"], errno.ENOENT)
            for name in ("create_at_root", "write_recipe"):
                self.assertIn(info["before_hooks"][name], (errno.EROFS, errno.EACCES))
            self.assertEqual(
                info["after_hooks"],
                {
                    "open": "nondeterministic_api:open",
                    "socket": "nondeterministic_api:socket.__new__",
                    "subprocess": "nondeterministic_api:subprocess.Popen",
                    "os_system": "nondeterministic_api:os.system",
                    "cached_import": "import_not_allowed",
                    "finder": "import_not_allowed",
                },
            )
            with self.assertRaisesRegex(CompileError, "sandbox_unavailable"):
                run_sandbox(b"pass", self.generated, bwrap=Path(scratch) / "no-bwrap")
            with self.assertRaisesRegex(CompileError, "import_not_allowed"):
                run_sandbox(b"import os", self.generated)
            with self.assertRaisesRegex(CompileError, "nondeterministic_api:open"):
                run_sandbox(b"open('/tmp/synthetic', 'w')", self.generated)

    def test_folder_local_authoring_and_stale_artifacts(self):
        with tempfile.TemporaryDirectory(prefix="sa151-folder-") as scratch:
            root = Path(scratch)
            schema = root / SCHEMA
            schema.parent.mkdir(parents=True)
            shutil.copy(ROOT / SCHEMA, schema)
            shutil.copytree(
                ROOT / "modules",
                root / "modules",
                ignore=shutil.ignore_patterns("__pycache__"),
            )
            (root / "recipes").mkdir()
            new_recipe = root / "recipes/contributed.py"
            new_recipe.write_text(
                (ROOT / "examples/with_motion_energy.py")
                .read_text()
                .replace("frame_motion_energy", "contributed_module")
                .replace("with_motion_energy", "contributed")
            )
            module = root / "modules/contributed_module"
            module.mkdir()
            original = ROOT / "modules/frame_motion_energy"
            manifest = json.loads((original / "manifest.json").read_text())
            manifest["id"] = "contributed_module"
            manifest["outputs"]["energy"] = "contributed_energy@1"
            (module / "manifest.json").write_text(pretty(manifest))
            shutil.copy(original / "impl.py", module)
            sync(root, check=False)
            sync(root, check=True)
            graph = json.loads(compiled_path(new_recipe).read_text())
            self.assertEqual(
                graph["nodes"]["motion"]["outputs"]["energy"], "contributed_energy@1"
            )
            compiled_path(new_recipe).write_text("{}\n")
            with self.assertRaisesRegex(
                ValueError, "stale.*contributed|contributed.*stale"
            ):
                sync(root, check=True)
            compiled_path(new_recipe).write_bytes(canonical_json(graph) + b"\n")
            generated = root / "packages/contracts/src/compiled-graph.generated.ts"
            generated.write_text("// stale\n")
            with self.assertRaisesRegex(
                ValueError, "compiled-graph.generated.ts.*stale"
            ):
                sync(root, check=True)

    def test_stubs_consume_upstream_artifacts_and_require_a_valid_plan(self):
        from runpy import run_path

        graph = json.loads(
            (ROOT / "examples/compiled/caption_detailed.json").read_text()
        )
        run = run_local(graph, ROOT, seconds=3)
        captions = [row for row in run["runs"] if row["node"] == "caption"]
        self.assertEqual(
            [
                row["outputs"]["captions"]["syntheticValue"]["segmentWindowIndex"]
                for row in captions
            ],
            [0, 1, 2],
        )

        def corrupt_plan(path):
            if Path(path).parent.name == "clip_filter_passthrough":
                return {
                    "run_stub": lambda *_: {
                        "plan": {"mode": "passthrough", "excludedSpans": []}
                    }
                }
            return run_path(path)

        with patch("local_run.run_path", side_effect=corrupt_plan):
            run = run_local(graph, ROOT, seconds=3)
        self.assertEqual(run["status"], "failed")
        self.assertTrue(
            all(
                row["status"] == "blocked"
                for row in run["runs"]
                if row["scope"] == "clip"
            )
        )

    def test_compiler_warnings_do_not_block_readiness(self):
        warning_recipe = b"if 1 is 2: pass\n" * 1800 + self.default.read_bytes()
        result = json.loads(run_sandbox(warning_recipe, self.generated))
        self.assertEqual(result["recipe"], "egocentric_default@1")

    def test_nondeterminism_is_rejected(self):
        original = run_sandbox(self.default.read_bytes(), self.generated)
        different = json.loads(original)
        different["meta"]["title"] = "Different output"
        with patch(
            "compiler.run_sandbox", side_effect=[original, canonical_json(different)]
        ):
            with self.assertRaisesRegex(CompileError, "nondeterministic_recipe"):
                compile_recipe(self.default, ROOT, self.catalog)

    def test_source_symlinks_and_unsupported_constraints_are_refused(self):
        with tempfile.TemporaryDirectory(prefix="sa151-paths-") as scratch:
            root = Path(scratch)
            source = root / "linked.py"
            source.symlink_to(self.default)
            with self.assertRaisesRegex(CompileError, "invalid_source_path"):
                compile_recipe(source, root, self.catalog)

            folder = root / "modules/frame_motion_energy"
            shutil.copytree(ROOT / "modules/frame_motion_energy", folder)
            manifest_path = folder / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["params"]["scale"]["$ref"] = "urn:stateaction:test"
            manifest_path.write_text(pretty(manifest))
            with self.assertRaisesRegex(
                ValueError, "unsupported constraint on parameter scale"
            ):
                modules(root, check=False)

    def test_scaffold_refuses_to_overwrite(self):
        with tempfile.TemporaryDirectory(prefix="sa151-scaffold-") as scratch:
            root = Path(scratch)
            (root / "recipes").mkdir()
            with patch("recipe.ROOT", root):
                self.assertEqual(main(["new", "custom"]), 0)
                path = root / "recipes/custom.py"
                contents = path.read_text()
                self.assertIn('id="custom"', contents)
                self.assertEqual(main(["new", "custom"]), 1)
                self.assertEqual(path.read_text(), contents)

    def test_diff_lists_current_graphs(self):
        from recipe import diff

        with tempfile.TemporaryDirectory(prefix="sa151-diff-") as scratch:
            root = Path(scratch)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "user.name=Fixture",
                    "commit",
                    "-qm",
                    "empty",
                    "--allow-empty",
                ],
                cwd=root,
                check=True,
            )
            shutil.copytree(
                ROOT / "recipes",
                root / "recipes",
                ignore=shutil.ignore_patterns("__pycache__"),
            )
            with patch("sys.stdout") as stdout:
                diff(root, "HEAD")
            lines = stdout.writelines.call_args.args[0]
            self.assertIn("+++ recipes/compiled/egocentric_default.json\n", lines)

    def test_each_module_fixture(self):
        from runpy import run_path

        for folder in sorted((ROOT / "modules").iterdir()):
            with self.subTest(module=folder.name):
                test = run_path(str(folder / "test_module.py"))
                implementation = run_path(str(folder / "impl.py"))
                test["test_stub"](implementation["run_stub"])
