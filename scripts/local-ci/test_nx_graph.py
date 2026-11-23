"""Assertions about the Nx graph the gate relies on (SA-105).

Runs the real Nx CLI against this workspace with a private workspace-data directory,
so it never touches the runner's shared Nx database. `tooling:test-local-ci` runs it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NX = ROOT / "node_modules" / ".bin" / "nx"

MOBILE_PROJECTS = {
    "mobile",
    "stera-recorder",
    "contracts-dart",
    "capture-conformance-mobile",
    "android-capture-spike",
    "android-capture-spike-native",
    "android-upload-spike",
    "android-upload-spike-native",
    "mobile-auth-backend-e2e",
    "mobile-backend-e2e",
}
# (project, target) pairs that need fixtures or a device and must never replay from cache.
UNCACHED = [
    ("server", "auth-integration"),
    ("server", "catalog-integration"),
    ("web", "auth-e2e"),
    ("mobile-backend-e2e", "e2e"),
    ("infra", "integration"),
    ("jobs", "integration"),
]
# Every stage of stages.json maps to a file whose change must select its project.
STAGE_FILES = {
    "toolchain": ("scripts/platform/install-render.py", "tooling"),
    "node-install": ("packages/server/package.json", "server"),
    "python-sync": ("workers/processing/uv.lock", "processing"),
    "render-cli": ("scripts/platform/install-render.py", "tooling"),
    "root-python-tests": ("tests/test_geometry_export.py", "root-python"),
    "server-tooling": ("packages/server/src/cli.ts", "server"),
    "mobile-android-dart": ("apps/mobile/lib/main.dart", "mobile"),
    "staged-dart-hook": ("scripts/platform/check-staged-dart.test.mjs", "tooling"),
    "local-ci-self-test": ("scripts/local-ci/local_ci.py", "tooling"),
    "catalog-integration": ("packages/server/migrations/001.sql", "server"),
    "server-auth-integration": ("packages/server/test-auth/postgres.mjs", "server"),
    "web-auth-e2e": ("apps/web/test-e2e/auth.e2e.test.mjs", "web"),
    "mobile-backend-e2e": (
        "apps/mobile/test_backend/run_real_backend.mjs",
        "mobile-backend-e2e",
    ),
    "jobs-controller-integration": ("apps/jobs/test-integration/harness.mjs", "jobs"),
    "runtime-smoke": ("render.yaml", "infra"),
}


class NxGraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Fail, never skip: a gate that ran without `pnpm install` must not look green.
        if not NX.exists():
            raise AssertionError(
                "no Nx binary: run pnpm install --frozen-lockfile first"
            )
        cls.tmp = tempfile.TemporaryDirectory()
        env = {k: v for k, v in os.environ.items() if not k.startswith("NX_")}
        env.update(
            NX_DAEMON="false",
            NX_NO_CLOUD="true",
            NX_TUI="false",
            NX_WORKSPACE_DATA_DIRECTORY=str(Path(cls.tmp.name) / "data"),
            NX_CACHE_DIRECTORY=str(Path(cls.tmp.name) / "cache"),
        )
        cls.env = env
        cls.affected_cache: dict[str, set[str]] = {}
        graph_file = Path(cls.tmp.name) / "graph.json"
        cls.nx("graph", f"--file={graph_file}")
        cls.graph = json.loads(graph_file.read_text())["graph"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    @classmethod
    def nx(cls, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        # Nx's native layer sometimes aborts (SIGABRT, negative status) on a cold
        # workspace-data directory; a signal death says nothing about the graph, so only
        # that case is repeated and any real Nx error fails at once.
        for _ in range(3):
            result = subprocess.run(
                [str(NX), *args],
                cwd=ROOT,
                env=cls.env,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode >= 0:
                break
        if check and result.returncode:
            raise AssertionError(f"nx {' '.join(args)} failed:\n{result.stderr}")
        return result

    @classmethod
    def affected(cls, file: str) -> set[str]:
        if file not in cls.affected_cache:
            out = cls.nx("show", "projects", "--affected", f"--files={file}", "--json")
            cls.affected_cache[file] = set(json.loads(out.stdout))
        return cls.affected_cache[file]

    def upstream(self, project: str) -> set[str]:
        seen: set[str] = set()
        todo = [project]
        while todo:
            for dep in self.graph["dependencies"].get(todo.pop(), []):
                if dep["target"] not in seen:
                    seen.add(dep["target"])
                    todo.append(dep["target"])
        return seen

    def test_contracts_is_upstream_of_every_contract_consumer(self):
        for project in (
            "mobile",
            "contracts-dart",
            "server",
            "mobile-backend-e2e",
            "jobs",
            "web",
        ):
            self.assertIn("contracts", self.upstream(project), project)
        for project in ("processing", "jobs"):
            self.assertIn("contracts-python", self.upstream(project), project)

    def test_jobs_and_the_mobile_e2e_depend_on_server_and_web(self):
        for project in ("jobs", "mobile-backend-e2e"):
            direct = {d["target"] for d in self.graph["dependencies"][project]}
            self.assertTrue({"server", "web"} <= direct, project)

    def test_the_static_mobile_e2e_project_depends_on_mobile_only(self):
        direct = {
            d["target"] for d in self.graph["dependencies"]["mobile-auth-backend-e2e"]
        }
        self.assertEqual(direct, {"mobile"})

    def test_every_mobile_project_and_only_those_carry_the_toolchain_tag(self):
        tagged = {
            name
            for name, node in self.graph["nodes"].items()
            if "mobile-toolchain" in (node["data"].get("tags") or [])
        }
        self.assertEqual(tagged, MOBILE_PROJECTS)

    def test_fixture_and_e2e_targets_declare_cache_false_on_the_project(self):
        for project, target in UNCACHED:
            config = self.graph["nodes"][project]["data"]["targets"][target]
            self.assertIs(config.get("cache"), False, f"{project}:{target}")
            self.assertIs(config.get("parallelism"), False, f"{project}:{target}")
            self.assertTrue(config.get("inputs"), f"{project}:{target} has no inputs")

    def test_every_fixture_stage_runs_a_target_declared_uncached(self):
        stages = json.loads((Path(__file__).parent / "stages.json").read_text())[
            "stages"
        ]
        fixture = [s for s in stages if s.get("fixtures")]
        self.assertTrue(fixture)
        for stage in fixture:
            argv = stage["argv"]
            self.assertEqual(argv[:4], ["pnpm", "exec", "nx", "run"], stage["id"])
            project, target = argv[4].split(":")
            config = self.graph["nodes"][project]["data"]["targets"][target]
            self.assertIs(config.get("cache"), False, stage["id"])
            self.assertIs(config.get("parallelism"), False, stage["id"])
            self.assertNotIn("cache", stage, stage["id"])
            self.assertIn((project, target), UNCACHED, stage["id"])

    def test_every_pyproject_path_dependency_is_a_graph_dependency(self):
        import tomllib

        by_root = {
            node["data"]["root"]: name for name, node in self.graph["nodes"].items()
        }
        found = 0
        for pyproject in sorted(ROOT.glob("*/**/pyproject.toml")):
            if any(part in ("node_modules", ".venv") for part in pyproject.parts):
                continue
            rel = pyproject.parent.relative_to(ROOT).as_posix()
            if rel not in by_root:
                continue
            sources = tomllib.loads(pyproject.read_text())
            for dep, spec in (
                sources.get("tool", {}).get("uv", {}).get("sources") or {}
            ).items():
                if not isinstance(spec, dict) or "path" not in spec:
                    continue
                target = (pyproject.parent / spec["path"]).resolve().relative_to(ROOT)
                self.assertIn(
                    target.as_posix(), by_root, f"{rel}: {dep} has no project"
                )
                found += 1
                self.assertIn(
                    by_root[target.as_posix()],
                    self.upstream(by_root[rel]),
                    f"{rel} path-depends on {dep} but the graph has no edge",
                )
        self.assertGreaterEqual(found, 1)

    def test_backend_change_reaches_dependents_but_no_mobile_toolchain_project(self):
        reached = self.affected("packages/server/src/cli.ts")
        self.assertTrue(
            {"server", "web", "jobs", "infra", "mobile-backend-e2e"} <= reached
        )
        self.assertEqual(
            reached & (MOBILE_PROJECTS - {"mobile-backend-e2e"}), set(), reached
        )

    def test_contract_change_reaches_every_consumer(self):
        reached = self.affected("packages/contracts/src/index.ts")
        self.assertTrue(
            {
                "mobile",
                "contracts-dart",
                "server",
                "mobile-auth-backend-e2e",
                "mobile-backend-e2e",
                "web",
                "jobs",
            }
            <= reached,
            reached,
        )

    def test_web_only_change_does_not_reach_mobile_or_contracts_dart(self):
        reached = self.affected("apps/web/app/page.tsx")
        self.assertIn("web", reached)
        self.assertFalse({"mobile", "contracts-dart", "stera-recorder"} & reached)

    def test_runner_script_change_reaches_tooling_and_no_application_project(self):
        self.assertEqual(self.affected("scripts/local-ci/local_ci.py"), {"tooling"})
        self.assertEqual(self.affected("scripts/local-ci/stages.json"), {"tooling"})

    @classmethod
    def input_files(cls, target: str) -> set[str]:
        out = cls.nx("show", "target", "inputs", target, "--json")
        return set(json.loads(out.stdout)["files"])

    def test_blueprint_change_reaches_infra(self):
        self.assertIn("infra", self.affected("render.yaml"))
        for task in ("format", "test"):
            self.assertIn("render.yaml", self.input_files(f"infra:{task}"), task)
        self.assertIn(
            "docs/components/render-deployment.md", self.input_files("infra:format")
        )

    def test_local_ci_files_are_inputs_of_the_cached_self_test_and_the_format_check(
        self,
    ):
        for task in ("test-local-ci", "format"):
            files = self.input_files(f"tooling:{task}")
            for file in (
                "scripts/local-ci/local_ci.py",
                "scripts/local-ci/stages.json",
            ):
                self.assertIn(file, files, f"tooling:{task}")
        self.assertFalse(
            [f for f in self.input_files("tooling:test-local-ci") if "__pycache__" in f]
        )

    def test_test_only_files_do_not_invalidate_the_web_build(self):
        files = self.input_files("web:build")
        self.assertTrue(any(f.startswith("packages/server/src/") for f in files))
        for file in (
            "packages/server/test-auth/postgres.mjs",
            "packages/server/test-integration/admission.test.ts",
            "apps/web/test-e2e/auth.e2e.test.mjs",
            "apps/jobs/test-integration/harness.mjs",
        ):
            self.assertTrue((ROOT / file).exists(), file)
            self.assertNotIn(file, files)

    def resolved_inputs(self, project: str, inputs: list) -> list:
        """Expand named inputs (workspace, then project overrides) to their leaves."""
        nx_json = json.loads((ROOT / "nx.json").read_text())
        named = dict(nx_json.get("namedInputs", {}))
        named.update(self.graph["nodes"][project]["data"].get("namedInputs") or {})
        leaves: list = []
        todo = list(inputs)
        seen: set[str] = set()
        while todo:
            item = todo.pop()
            if isinstance(item, str) and item in named and item not in seen:
                seen.add(item)
                todo.extend(named[item])
            else:
                leaves.append(item)
        return leaves

    def test_every_target_names_its_external_dependencies(self):
        """No target may fall back to hashing every package in the lockfile.

        A target whose resolved inputs hold no `externalDependencies` entry gets the
        implicit AllExternalDependencies input, so any lockfile change re-runs it.
        """
        missing = []
        for project, node in sorted(self.graph["nodes"].items()):
            for target, config in node["data"]["targets"].items():
                inputs = config.get("inputs")
                leaves = self.resolved_inputs(
                    project, ["default"] if inputs is None else inputs
                )
                if not any(
                    isinstance(leaf, dict) and "externalDependencies" in leaf
                    for leaf in leaves
                ):
                    missing.append(f"{project}:{target}")
        self.assertEqual(missing, [])

    def test_declared_external_dependencies_cover_the_package_json_dependencies(self):
        """A JS project lists each direct npm dependency, as the graph names it."""
        checked = 0
        for project, node in sorted(self.graph["nodes"].items()):
            package_json = ROOT / node["data"]["root"] / "package.json"
            if not package_json.exists():
                continue
            manifest = json.loads(package_json.read_text())
            direct = {
                name
                for section in ("dependencies", "devDependencies")
                for name in manifest.get(section, {})
                if not name.startswith("@stateaction/")
            }
            listed = {
                re.sub(r"(?<=.)@[^@/]*$", "", entry.removeprefix("npm:"))
                for leaf in self.resolved_inputs(
                    project, node["data"].get("namedInputs", {}).get("externalDeps", [])
                )
                if isinstance(leaf, dict)
                for entry in leaf["externalDependencies"]
            }
            self.assertEqual(listed, direct, project)
            checked += 1
        self.assertGreaterEqual(checked, 5)

    def test_a_stera_sdk_pointer_bump_reaches_the_root_python_tests(self):
        """The submodule path (a gitlink, absent from worktrees) is a changed file.

        Nx's file map holds no file below a populated submodule, so the glob alone
        selects nothing; the bare path selects the project when the pointer moves, and
        the `git ls-files -s` runtime input changes the hash with it.
        """
        self.assertIn("root-python", self.affected("stera-sdk"))
        target = self.graph["nodes"]["root-python"]["data"]["targets"]["test"]
        self.assertIn(
            {"runtime": "git ls-files -s stera-sdk | sha256sum"}, target["inputs"]
        )
        self.assertIn("{workspaceRoot}/stera-sdk", target["inputs"])

    def test_every_stage_of_stages_json_is_reachable_from_some_change(self):
        stages = json.loads((Path(__file__).parent / "stages.json").read_text())[
            "stages"
        ]
        ids = [stage["id"] for stage in stages]
        self.assertEqual(sorted(ids), sorted(STAGE_FILES), "map every stage here")
        for stage_id, (file, project) in STAGE_FILES.items():
            self.assertIn(project, self.affected(file), f"{stage_id}: {file}")


if __name__ == "__main__":
    unittest.main()
