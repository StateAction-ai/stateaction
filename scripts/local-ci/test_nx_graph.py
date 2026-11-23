"""Assertions about the Nx graph the gate relies on (SA-105).

Runs the real Nx CLI against this workspace with a private workspace-data directory,
so it never touches the runner's shared Nx database. `tooling:test-local-ci` runs it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import local_ci  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NX = ROOT / "node_modules" / ".bin" / "nx"

MOBILE_PROJECTS = {
    "mobile",
    "stera-recorder",
    "contracts-dart",
    "capture-conformance-mobile",
    "android-capture-spike",
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
# Each affected stage of stages.json maps to a file whose change must select one of its tasks.
STAGE_FILES = {
    "build": ("packages/server/src/cli.ts", "server"),
    "static": ("packages/server/src/cli.ts", "server"),
    "mobile": ("apps/mobile/lib/main.dart", "mobile"),
    "integration": ("apps/jobs/test-integration/harness.mjs", "jobs"),
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
            # Nx's Rust runtime and each plugin worker start one thread per CPU (20 here). The
            # gate scope allows 512 tasks and Nx's own plugin worker died of "OS can't spawn
            # worker thread: EAGAIN" next to the format task (SA-106 r4), which exits 1 rather
            # than by signal, so it cannot be retried. Two threads each measure 67 tasks at
            # peak instead of 139 and change nothing in the graph.
            TOKIO_WORKER_THREADS="2",
            RAYON_NUM_THREADS="2",
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

    def test_the_runner_self_test_runs_alone_because_it_starts_nx_itself(self):
        """Its shards start the Nx CLI; next to other tasks they exhausted the 512-task scope."""
        target = self.graph["nodes"]["tooling"]["data"]["targets"]["test-local-ci"]
        self.assertIs(target.get("parallelism"), False)

    def test_the_memory_heavy_next_build_is_excluded_from_task_parallelism(self):
        """The static stage runs --parallel=3 (SA-118); `next build` must still run alone."""
        web = self.graph["nodes"]["web"]["data"]["targets"]
        self.assertIs(web["build"].get("parallelism"), False)

    def test_web_typecheck_consumes_the_build_route_types_and_runs_tsc(self):
        """`next build` already generates .next/types, so typecheck must not regenerate them."""
        web = self.graph["nodes"]["web"]["data"]["targets"]["typecheck"]
        self.assertIn("build", web["dependsOn"])
        self.assertIn("tsc --noEmit", web["options"]["command"])
        self.assertNotIn("typegen", web["options"]["command"])

    # SA-113: the three mobile build targets are cached verification tasks.
    CACHED_MOBILE_BUILDS = [
        ("mobile", "build"),
        ("android-capture-spike", "build"),
        ("android-upload-spike-native", "build"),
    ]

    def test_mobile_build_targets_are_cached_and_never_device_or_fixture_targets(self):
        uncached = {tuple(pair) for pair in UNCACHED}
        for project, target in self.CACHED_MOBILE_BUILDS:
            config = self.graph["nodes"][project]["data"]["targets"][target]
            self.assertIsNot(config.get("cache"), False, f"{project}:{target}")
            self.assertNotIn((project, target), uncached)
            leaves = self.resolved_inputs(project, config["inputs"])
            self.assertTrue(
                any(
                    isinstance(leaf, dict)
                    and "source.properties" in leaf.get("runtime", "")
                    for leaf in leaves
                ),
                f"{project}:{target} does not hash the installed Android SDK packages",
            )
            command = json.dumps(config["options"])
            for word in ("emulator", "adb", "--serial", "connectedAndroidTest"):
                self.assertNotIn(word, command, f"{project}:{target}")
            self.assertFalse(config.get("continuous"))

    def test_no_runtime_input_runs_flutter_whose_startup_lock_makes_hashes_flaky(self):
        # `flutter --version` waits for the startup lock a running flutter command holds
        # and prints a notice, so a hash computed meanwhile differs from an idle one.
        nx_json = json.loads((ROOT / "nx.json").read_text())
        commands = [
            leaf["runtime"]
            for leaves in nx_json["namedInputs"].values()
            for leaf in leaves
            if isinstance(leaf, dict) and "runtime" in leaf
        ]
        self.assertTrue(commands)
        for command in commands:
            self.assertNotRegex(command, r"(^|[\s;|&(])flutter\s", command)

    def test_prepare_is_not_a_standalone_always_run_task(self):
        for project, node in self.graph["nodes"].items():
            targets = node["data"]["targets"]
            self.assertNotIn("prepare", targets, project)
            for target, config in targets.items():
                for dep in config.get("dependsOn") or []:
                    name = dep if isinstance(dep, str) else dep.get("target")
                    self.assertNotEqual(name, "prepare", f"{project}:{target}")

    def test_no_gradle_dependency_is_dynamic_so_a_hit_cannot_hide_drift(self):
        # No Gradle dependency lockfile exists; exact direct versions are the lock.
        dynamic = re.compile(
            r"\+$|\.\+|latest\.|SNAPSHOT|^[\[(].*,.*[\])]$|:[\[(]|\+['\"]", re.I
        )
        roots = [
            ROOT / "apps/mobile/android",
            ROOT / "packages/stera_recorder/android",
            ROOT / "spikes/android/capture",
            ROOT / "spikes/android/upload",
        ]
        checked = 0
        for root in roots:
            for file in [*root.rglob("*.gradle"), *root.rglob("*.gradle.kts")]:
                if any(
                    part in {"build", ".gradle", ".gradle-user"} for part in file.parts
                ):
                    continue
                checked += 1
                for line in file.read_text().splitlines():
                    if line.strip().startswith("//"):
                        continue
                    for literal in re.findall(r"['\"]([^'\"]*)['\"]", line):
                        self.assertIsNone(
                            dynamic.search(literal), f"{file}: {line.strip()}"
                        )
        self.assertGreater(checked, 5)

    def named_runtime(self, name: str) -> list[str]:
        nx_json = json.loads((ROOT / "nx.json").read_text())
        return [
            leaf["runtime"]
            for leaf in nx_json["namedInputs"][name]
            if isinstance(leaf, dict) and "runtime" in leaf
        ]

    def run_runtime(self, command: str, **env: str) -> str:
        result = subprocess.run(
            ["sh", "-c", command],
            capture_output=True,
            text=True,
            timeout=30,
            env={"PATH": "/usr/bin:/bin", **env},
        )
        return result.stdout + result.stderr

    def test_the_sdk_runtime_input_changes_with_an_installed_package_revision(self):
        (command,) = self.named_runtime("androidToolchain")
        with tempfile.TemporaryDirectory() as tmp:
            sdk = Path(tmp)
            for package in (
                "build-tools/36.0.0",
                "platforms/android-36",
                "ndk/28.2.13676358",
                "platform-tools",
            ):
                (sdk / package).mkdir(parents=True)
                (sdk / package / "source.properties").write_text(
                    f"Pkg.Revision={package}\n"
                )
            first = self.run_runtime(command, ANDROID_HOME=str(sdk))
            self.assertEqual(first, self.run_runtime(command, ANDROID_HOME=str(sdk)))
            self.assertIn("build-tools/36.0.0", first)
            (sdk / "ndk/28.2.13676358/source.properties").write_text(
                "Pkg.Revision=29\n"
            )
            self.assertNotEqual(first, self.run_runtime(command, ANDROID_HOME=str(sdk)))
            (sdk / "ndk/28.2.13676358/source.properties").write_text(
                "Pkg.Revision=ndk/28.2.13676358\n"
            )
            self.assertEqual(first, self.run_runtime(command, ANDROID_HOME=str(sdk)))
            # ANDROID_SDK_ROOT is honoured when ANDROID_HOME is unset.
            self.assertEqual(
                first, self.run_runtime(command, ANDROID_SDK_ROOT=str(sdk))
            )

    def test_the_flutter_version_runtime_input_follows_a_symlinked_flutter(self):
        command = next(
            c for c in self.named_runtime("flutterToolchain") if "flutter" in c
        )
        with tempfile.TemporaryDirectory() as tmp:
            sdk = Path(tmp) / "sdk/bin"
            (sdk / "cache").mkdir(parents=True)
            (sdk / "flutter").write_text("#!/bin/sh\nexit 99\n")
            (sdk / "flutter").chmod(0o755)
            (sdk / "cache/flutter.version.json").write_text('{"flutterVersion": "9"}')
            link = Path(tmp) / "link"
            link.mkdir()
            (link / "flutter").symlink_to(sdk / "flutter")
            out = self.run_runtime(command, PATH=f"{link}:/usr/bin:/bin")
            self.assertEqual(out, '{"flutterVersion": "9"}')

    def test_integration_targets_that_run_compiled_output_build_their_own_project_first(
        self,
    ):
        """SA-114: jobs:integration imports apps/jobs/dist, so a run (or `nx affected`)
        that did not build jobs first tested stale compiled code."""
        for project, target in (("jobs", "integration"), ("web", "auth-e2e")):
            config = self.graph["nodes"][project]["data"]["targets"][target]
            self.assertIn("build", config["dependsOn"], f"{project}:{target}")

    def test_web_auth_e2e_builds_jobs_because_recipe_e2e_runs_its_compiled_runner(self):
        """SA-101: recipe.e2e.test.mjs starts `node apps/jobs/dist/index.js`. A web-only change
        does not affect jobs, so nothing built it and the runner never started (gate land-95)."""
        config = self.graph["nodes"]["web"]["data"]["targets"]["auth-e2e"]
        self.assertIn({"projects": ["jobs"], "target": "build"}, config["dependsOn"])

    def test_fixture_stage_selects_exactly_the_targets_declared_uncached(self):
        stages = json.loads((Path(__file__).parent / "stages.json").read_text())[
            "stages"
        ]
        fixture = [s for s in stages if s.get("fixtures")]
        self.assertEqual([s["id"] for s in fixture], ["integration"])
        stage = fixture[0]
        self.assertNotIn("cache", stage)
        targets = set(stage["affected"]["targets"])
        found = set()
        for project, node in self.graph["nodes"].items():
            for target, config in node["data"]["targets"].items():
                if target in targets:
                    found.add((project, target))
                    self.assertIs(config.get("cache"), False, f"{project}:{target}")
                    self.assertIs(
                        config.get("parallelism"), False, f"{project}:{target}"
                    )
        self.assertEqual(found, set(UNCACHED))

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
        # Nx truncates a large --json document at the 64 KiB pipe size, so read a file.
        target_file = Path(cls.tmp.name) / f"inputs-{target.replace(':', '-')}.json"
        with target_file.open("w") as handle:
            result = subprocess.run(
                [str(NX), "show", "target", "inputs", target, "--json"],
                cwd=ROOT,
                env=cls.env,
                stdout=handle,
                stderr=subprocess.PIPE,
                text=True,
                timeout=300,
            )
        if result.returncode:
            raise AssertionError(f"nx show target inputs {target}:\n{result.stderr}")
        return set(json.loads(target_file.read_text())["files"])

    def test_blueprint_change_reaches_infra(self):
        self.assertIn("infra", self.affected("render.yaml"))
        for task in ("format", "test"):
            self.assertIn("render.yaml", self.input_files(f"infra:{task}"), task)
        self.assertIn(
            "docs/components/render-deployment.md", self.input_files("infra:format")
        )

    def test_a_docs_file_named_as_a_task_input_selects_exactly_those_tasks(self):
        """SA-117: render-deployment.md is read by the blueprint checks, so a docs-only
        change to it still runs them (and no other docs file selects anything here)."""
        doc = "docs/components/render-deployment.md"
        self.assertIn("infra", self.affected(doc))
        for task in ("format", "test"):
            self.assertIn(doc, self.input_files(f"infra:{task}"), task)
        for task in ("syntax", "integration"):
            self.assertNotIn(doc, self.input_files(f"infra:{task}"), task)
        self.assertNotIn("infra", self.affected("docs/components/catalog.md"))

    def test_no_fixture_or_uncached_task_reads_a_docs_only_path(self):
        """The docs-only run executes only build/typecheck/syntax/test/format tasks, so a
        doc that an integration or e2e task reads would be skipped unchecked."""
        rule = json.loads((Path(__file__).parent / "stages.json").read_text())[
            "docsOnly"
        ]
        for project, target in UNCACHED:
            docs = [
                f
                for f in self.input_files(f"{project}:{target}")
                if local_ci.is_docs_path(f, rule)
            ]
            self.assertEqual(docs, [], f"{project}:{target}")

    def test_guarded_targets_cover_every_task_a_docs_only_run_skips(self):
        spec = json.loads((Path(__file__).parent / "stages.json").read_text())
        guarded = set(spec["docsOnly"]["guardedTargets"])
        for item in spec["stages"]:
            if item.get("fixtures"):
                for target in item["affected"]["targets"]:
                    self.assertIn(target, guarded, item["id"])
        self.assertIn("test-local-ci", guarded)
        run = {"build", "typecheck", "syntax", "test", "format"}
        known = {
            target
            for node in self.graph["nodes"].values()
            for target in node["data"]["targets"]
        }
        # Every other Nx target is a service, seed or tool command no gate stage runs.
        self.assertTrue(guarded <= known)
        self.assertTrue(run <= known)

    def test_docs_check_target_is_cached_on_the_docs_tree_and_changed_list(self):
        target = self.graph["nodes"]["tooling"]["data"]["targets"]["docs-check"]
        self.assertTrue(target["cache"])
        self.assertIn({"env": "STATEACTION_DOCS_CHANGED"}, target["inputs"])
        files = self.input_files("tooling:docs-check")
        for file in (
            "README.md",
            "docs/components/render-deployment.md",
            "scripts/local-ci/docs_checks.py",
        ):
            self.assertIn(file, files)

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

    def test_every_affected_stage_is_reachable_and_selects_tasks(self):
        spec = json.loads((Path(__file__).parent / "stages.json").read_text())
        stages = [s for s in spec["stages"] if s.get("affected")]
        self.assertEqual(sorted(s["id"] for s in stages), sorted(STAGE_FILES))
        for stage in stages:
            file, project = STAGE_FILES[stage["id"]]
            self.assertIn(project, self.affected(file), f"{stage['id']}: {file}")
        for stage in spec["stages"]:
            self.assertFalse(
                stage.get("affected") and stage.get("argv"),
                f"{stage['id']} hard-codes a command beside its affected spec",
            )
        migrations = ROOT / "packages/server/migrations"
        self.assertTrue(any(migrations.glob("*.sql")))
        self.assertIn("packages/server/migrations/**", spec["alwaysRunAll"])
        self.assertTrue(any(ROOT.glob("workers/*/uv.lock")))


if __name__ == "__main__":
    unittest.main()
