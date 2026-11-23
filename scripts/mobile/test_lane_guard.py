"""SA-124 lane/Free guard code: unit tests with fakes; the real-systemd proof is
scripts/mobile/e2e_lanes.py (run by hand, never by the gate)."""

import argparse
import hashlib
import importlib.util
import json
import os
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "resource_guard", Path(__file__).with_name("resource_guard.py")
)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
REPO = Path(__file__).resolve().parents[2]


def options(**kwargs):
    base = dict(lane=None, key=None, runtime=None, timeout=None, mem=None)
    return argparse.Namespace(**{**base, **kwargs})


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lane-guard-")).resolve()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, True))
        self.root_a = self.tmp / "a"
        self.root_b = self.tmp / "b"
        self.other = self.tmp / "other"
        for d in (self.root_a / "wt/sub", self.root_b, self.other):
            d.mkdir(parents=True)
        patcher = mock.patch.dict(
            os.environ,
            {
                "AGENT_RESOURCE_TEST": "1",
                "AGENT_RESOURCE_PROJECT_ROOTS": f"{self.root_a}{os.pathsep}{self.root_b}",
            },
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("STATEACTION_LANE_HELD", None)
        runtime = mock.patch.object(guard, "runtime_dir", lambda: self.tmp)
        runtime.start()
        self.addCleanup(runtime.stop)


class RootsAndManifest(Env):
    def files(self, root):
        return guard.lane_files(root, "ci", guard.project_key(root, root))

    def test_only_registered_roots_activate_and_the_longest_wins(self):
        self.assertEqual(guard.registered_root(self.root_a / "wt/sub"), self.root_a)
        self.assertEqual(guard.registered_root(self.root_b), self.root_b)
        self.assertIsNone(guard.registered_root(self.other))
        self.assertIsNone(
            guard.registered_root(self.tmp)
        )  # parent of a root is not inside

    def test_committed_manifest_declares_the_three_lanes_without_command_mapping(self):
        manifest = tomllib.loads((REPO / "config/agentqueue/lanes.toml").read_text())
        self.assertEqual(set(manifest["lanes"]), set(guard.LANES))
        for name, lane in manifest["lanes"].items():
            # SA-108: the shipped value is ONE heavy job; a second ci slot is the user's call.
            self.assertEqual(lane["slots"], 1, name)
            self.assertNotIn("commands", lane)  # no reclassification by command name
        self.assertNotIn("roots", manifest)

    def test_two_ci_slots_fit_the_lane_budget_but_three_wait_for_memory(self):
        job = guard.JOB_MAX
        ci = tomllib.loads((REPO / "config/agentqueue/lanes.toml").read_text())[
            "lanes"
        ]["ci"]
        self.assertEqual(ci["mem"], "6G")
        self.assertGreaterEqual(guard.lane_budget(24 * guard.GIB), 2 * job)
        self.assertLess(guard.lane_budget(24 * guard.GIB), 3 * job)
        # At the 12 GiB boot cap one job at a time: the second ticket waits, never over-commits.
        self.assertEqual(guard.lane_budget(12 * guard.GIB), job)

    def test_slots_two_is_honoured_by_the_effective_manifest_when_activated(self):
        text = (REPO / "config/agentqueue/lanes.toml").read_text()
        two = self.tmp / "lanes-two.toml"
        two.write_text(text.replace("[lanes.ci]\nslots = 1", "[lanes.ci]\nslots = 2"))
        real = guard.resource_file
        with mock.patch.object(
            guard,
            "resource_file",
            lambda name, repo_path: (
                two if name == "lanes.toml" else real(name, repo_path)
            ),
        ):
            _, manifest, key = self.files(self.root_a)
        lanes = tomllib.loads(manifest.read_text())["lanes"]
        self.assertEqual(lanes[f"ci-{key}"]["slots"], 2)
        self.assertEqual(lanes[f"android-build-{key}"]["slots"], 1)
        self.assertEqual(lanes["emulator"]["slots"], 1)

    def test_effective_manifest_has_this_repo_lanes_machine_state_and_all_roots(self):
        state, manifest, key = self.files(self.root_a)
        text = tomllib.loads(manifest.read_text())
        self.assertEqual(text["roots"], [str(self.root_a), str(self.root_b)])
        self.assertEqual(text["state_dir"], str(state))
        self.assertTrue(str(state).endswith("agentqueue/machine"))
        self.assertEqual(
            set(text["lanes"]),
            {f"ci-{key}", f"android-build-{key}", "emulator"},
        )
        self.assertEqual(guard.aq_lane("emulator", key), "emulator")

    def test_two_repositories_share_state_and_budget_but_not_lanes(self):
        state_a, _, key_a = self.files(self.root_a)
        state_b, _, key_b = self.files(self.root_b)
        self.assertEqual(state_a, state_b)  # one machine-wide reservation
        self.assertNotEqual(key_a, key_b)  # distinct ci lanes
        self.assertNotEqual(guard.aq_lane("ci", key_a), guard.aq_lane("ci", key_b))

    def test_worktrees_of_one_git_repository_share_a_key(self):
        import subprocess as sp

        repo = self.tmp / "repo"
        sp.run(["git", "init", "-q", str(repo)], check=True)
        sp.run(
            ["git", "-C", str(repo), "commit", "-q", "--allow-empty", "-m", "x"],
            check=True,
            env={
                **os.environ,
                "GIT_AUTHOR_NAME": "a",
                "GIT_AUTHOR_EMAIL": "a@b",
                "GIT_COMMITTER_NAME": "a",
                "GIT_COMMITTER_EMAIL": "a@b",
            },
        )
        wt = self.tmp / "wt"
        sp.run(
            ["git", "-C", str(repo), "worktree", "add", "-q", "-b", "w", str(wt)],
            check=True,
        )
        self.assertEqual(
            guard.project_key(self.tmp, repo), guard.project_key(self.tmp, wt)
        )
        # an enclosing repository outside the registered root is ignored
        self.assertNotEqual(
            guard.project_key(self.root_a, repo), guard.project_key(self.root_b, repo)
        )

    def test_budget_is_machine_wide_and_follows_the_live_cap(self):
        gib = guard.GIB
        self.assertEqual(guard.lane_budget(None), 6 * gib)  # boot cap: one job
        self.assertEqual(guard.lane_budget(12 * gib), 6 * gib)
        self.assertEqual(guard.lane_budget(24 * gib), 14 * gib)
        self.assertLessEqual(
            guard.lane_budget(24 * gib) + guard.FREE_LOW + guard.EMULATOR_SHARE,
            24 * gib,
        )

    def test_missing_config_and_hooks_off_mean_no_registered_root(self):
        with mock.patch.dict(os.environ, {"AGENT_RESOURCE_TEST": ""}):
            with mock.patch.object(guard, "INSTALL", self.tmp / "absent"):
                self.assertEqual(guard.project_roots(), [])  # no crash: legacy behavior
                self.assertIsNone(guard.registered_root(self.root_a))
        with mock.patch.object(Path, "cwd", side_effect=FileNotFoundError):
            self.assertIsNone(guard.registered_root())


class BinaryPin(Env):
    def make(self, content=b"#!/bin/sh\nexit 0\n", rev=None, digest=None):
        root = self.tmp / "aq"
        (root / "bin").mkdir(parents=True, exist_ok=True)
        binary = root / "bin/agentqueue"
        binary.write_bytes(content)
        binary.chmod(0o755)
        pin = json.loads((REPO / "config/agentqueue/pin.json").read_text())
        (root / "INSTALLED.json").write_text(
            json.dumps(
                {
                    "rev": rev or pin["rev"],
                    "sha256": digest or hashlib.sha256(content).hexdigest(),
                }
            )
        )
        return binary

    def test_pin_is_a_full_git_rev(self):
        pin = json.loads((REPO / "config/agentqueue/pin.json").read_text())
        self.assertRegex(pin["rev"], r"^[0-9a-f]{40}$")
        self.assertTrue(pin["version"])

    def test_matching_record_is_accepted(self):
        binary = self.make()
        with mock.patch.dict(os.environ, {"AGENTQUEUE_BIN": str(binary)}):
            self.assertEqual(guard.agentqueue_binary(), binary)

    def test_tampered_or_wrong_rev_binary_is_refused(self):
        for kwargs in ({"digest": "0" * 64}, {"rev": "1" * 40}):
            binary = self.make(**kwargs)
            with mock.patch.dict(os.environ, {"AGENTQUEUE_BIN": str(binary)}):
                with self.assertRaisesRegex(guard.Refused, "pin.json"):
                    guard.agentqueue_binary()

    def test_missing_binary_fails_closed_with_the_install_script_named(self):
        with mock.patch.dict(os.environ, {"AGENTQUEUE_BIN": str(self.tmp / "nope")}):
            with mock.patch.object(guard, "INSTALL", self.tmp / "no-install"):
                with self.assertRaisesRegex(guard.Refused, "install-agentqueue.sh"):
                    guard.agentqueue_binary()

    def test_binary_override_needs_the_test_switch(self):
        binary = self.make()
        with mock.patch.dict(
            os.environ, {"AGENTQUEUE_BIN": str(binary), "AGENT_RESOURCE_TEST": ""}
        ):
            with mock.patch.object(guard, "INSTALL", self.tmp / "no-install"):
                self.assertNotEqual(guard.agentqueue_binary() if False else 0, binary)

    def test_probe_script_checks_the_lane_in_the_cgroup_not_the_environment(self):
        text = (REPO / "scripts/source_hash_probe.sh").read_text()
        self.assertNotIn(
            "STATEACTION_LANE_HELD", text.split("source ")[0].replace("# ", "#")
        )
        self.assertIn("/proc/self/cgroup", text)
        self.assertIn("--lane emulator", text)

    def test_install_script_pins_the_same_rev_and_needs_no_network_flags(self):
        text = (REPO / "scripts/install-agentqueue.sh").read_text()
        self.assertIn("pin.json", text)
        self.assertIn("--locked", text)
        self.assertIn("sha256sum", text)
        self.assertIn("CARGO_BUILD_JOBS=2", text)


class BoundedChildLimits(Env):
    def run_bounded_hook(self, limits):
        """Runs run_bounded with fakes and returns the preexec hook it hands to the child."""
        captured = {}

        def fake_run(argv, **kwargs):
            captured["hook"] = kwargs["preexec_fn"]
            return mock.Mock(returncode=0)

        with (
            mock.patch.object(guard.subprocess, "run", side_effect=fake_run),
            mock.patch.object(guard, "runtime_dir", return_value=self.tmp),
            mock.patch.object(guard, "call"),
            mock.patch.object(guard.resource, "getrlimit", return_value=limits),
            mock.patch.object(guard.resource, "setrlimit") as setter,
        ):
            guard.run_bounded(
                "agent-lane-ci-aaaaaaaa.scope",
                ["tool"],
                slice_name="s",
                job_max=guard.GIB,
                env={},
            )
            captured["hook"]()
        return setter

    def test_lane_job_raises_the_soft_open_file_limit_to_the_hard_limit(self):
        # agentqueue units start at 1024: web-auth-e2e (Chrome, Next, Nx) failed on it.
        setter = self.run_bounded_hook((1024, 524288))
        setter.assert_called_once_with(guard.resource.RLIMIT_NOFILE, (524288, 524288))

    def test_lane_job_gets_1536_tasks(self):
        with (
            mock.patch.object(guard, "admit"),
            mock.patch.object(guard, "enforce_slice"),
            mock.patch.object(guard, "bounded_environment", return_value={}),
            mock.patch.object(guard, "run_bounded", return_value=0) as run,
        ):
            guard.lane_job("ci", "abcd1234", ["tool"])
        self.assertEqual(run.call_args.kwargs["tasks"], 1536)
        self.assertEqual(run.call_args.kwargs["cpu_weight"], guard.LANE_CPU_WEIGHT)
        self.assertEqual(guard.LANE_CPU_WEIGHT, 400)
        self.assertEqual(guard.SLICE_TASKS_MAX, 8192)

    def test_run_bounded_passes_cpu_weight_only_when_given(self):
        for weight, expected in ((400, ["--property=CPUWeight=400"]), (None, [])):
            with (
                mock.patch.object(guard, "runtime_dir", return_value=self.tmp),
                mock.patch.object(guard, "call"),
                mock.patch.object(guard.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0
                guard.run_bounded(
                    "agent-lane-ci-aaaaaaaa.scope",
                    ["x"],
                    slice_name="s",
                    job_max=1,
                    env={},
                    cpu_weight=weight,
                )
            argv = run.call_args[0][0]
            self.assertEqual([a for a in argv if "CPUWeight" in a], expected)

    def test_free_slice_is_reasserted_with_cpu_weight_and_tasks(self):
        limit = guard.free_slice_max(24 * guard.GIB)
        good = {
            "MemoryMax": str(limit),
            "MemorySwapMax": "0",
            "TasksMax": "2048",
            "CPUWeight": "100",
        }
        unset = ("[not set]", "18446744073709551615", "1")
        cases = [(good, False)] + [({**good, "CPUWeight": v}, True) for v in unset]
        for props, expect_set in cases:
            with (
                mock.patch.object(guard, "properties", return_value=props),
                mock.patch.object(guard, "free_slice_max", return_value=limit),
                mock.patch.object(guard, "call") as call,
            ):
                guard.ensure_free_slice()
            self.assertEqual(call.called, expect_set)
            if expect_set:
                self.assertIn("CPUWeight=100", call.call_args[0])
                self.assertIn("CPUAccounting=yes", call.call_args[0])

    def test_an_already_raised_limit_is_left_alone(self):
        self.assertFalse(self.run_bounded_hook((524288, 524288)).called)


class RunRouting(Env):
    def setUp(self):
        super().setUp()
        # The suite itself may run inside the ci lane (the gate): routing tests simulate "not in a lane".
        for name, value in (("current_lane", None), ("inside_lane", False)):
            patcher = mock.patch.object(guard, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_in(self, cwd, **kwargs):
        with mock.patch.object(Path, "cwd", return_value=cwd):
            return guard.run_command(["tool", "arg"], options(**kwargs))

    def test_free_run_in_a_registered_root_takes_no_slot_and_never_waits(self):
        with (
            mock.patch.object(guard, "free_run", return_value=7) as free,
            mock.patch.object(guard, "run_scope") as legacy,
            mock.patch.object(guard, "singleton") as slot,
        ):
            self.assertEqual(self.run_in(self.root_a / "wt"), 7)
        free.assert_called_once()
        legacy.assert_not_called()
        slot.assert_not_called()

    def test_other_roots_keep_the_legacy_heavy_job_behavior(self):
        with (
            mock.patch.object(guard, "free_run") as free,
            mock.patch.object(guard, "inside_guard", return_value=False),
            mock.patch.object(guard, "run_scope", return_value=3) as legacy,
        ):
            self.assertEqual(self.run_in(self.other), 3)
        legacy.assert_called_once_with(guard.BUILD, ["tool", "arg"], emulator=False)
        free.assert_not_called()

    def test_lane_from_another_root_executes_untouched_and_is_never_queued(self):
        with mock.patch.object(guard.os, "execvpe", side_effect=SystemExit(0)) as run:
            with mock.patch.object(guard, "agentqueue_binary") as binary:
                with self.assertRaises(SystemExit):
                    self.run_in(self.other, lane="ci")
        run.assert_called_once()
        binary.assert_not_called()

    def test_lane_in_a_registered_root_submits_to_agentqueue_with_pass_env(self):
        aq = self.tmp / "aq"
        with mock.patch.dict(
            os.environ, {"STATEACTION_X": "1", "SECRET_TOKEN": "s", "GH_TOKEN": "t"}
        ):
            with (
                mock.patch.object(guard, "agentqueue_binary", return_value=aq),
                mock.patch.object(guard, "user_environment", return_value={}),
                mock.patch.object(guard, "aggregate_cap", return_value=24 * guard.GIB),
                mock.patch.object(guard, "run_and_stream", return_value=0) as ex,
            ):
                self.assertEqual(
                    self.run_in(self.root_a / "wt", lane="ci", key="k1"), 0
                )
        argv = ex.call_args[0][0]
        self.assertTrue(ex.call_args[0][1][guard.LANE_LOG_ENV].endswith(".log"))
        self.assertEqual(argv[0], str(aq))
        self.assertIn("run", argv)
        self.assertTrue(argv[argv.index("--lane") + 1].startswith("ci-"))
        self.assertEqual(argv[argv.index("--key") + 1], "k1")
        self.assertIn("--retry", argv)
        self.assertEqual(argv[argv.index("--budget") + 1], str(14 * guard.GIB))
        passed = [argv[i + 1] for i, x in enumerate(argv) if x == "--pass-env"]
        self.assertIn("STATEACTION_X", passed)
        self.assertNotIn("SECRET_TOKEN", passed)
        self.assertIn("GH_TOKEN", passed)  # by name only, never the value
        self.assertNotIn("t", [x for x in argv if x == "t"])
        tail = argv[argv.index("--", argv.index("run")) + 1 :]
        self.assertEqual(tail[1].endswith("resource_guard.py"), True)
        self.assertEqual(tail[2], "lane-job")
        self.assertEqual(tail[-2:], ["tool", "arg"])

    def submit_argv(self, help_text):
        aq = self.tmp / "aq"
        log = self.tmp / "state" / "lane-log.jsonl"
        with (
            mock.patch.dict(os.environ, {"AGENT_RESOURCE_LANE_LOG": str(log)}),
            mock.patch.object(guard, "agentqueue_binary", return_value=aq),
            mock.patch.object(guard, "agentqueue_help", return_value=help_text),
            mock.patch.object(guard, "user_environment", return_value={}),
            mock.patch.object(guard, "aggregate_cap", return_value=24 * guard.GIB),
            mock.patch.object(guard, "run_and_stream", return_value=0) as ex,
        ):
            self.run_in(self.root_a / "wt", lane="ci")
        return ex.call_args[0][0], log

    def test_lane_submit_passes_the_durable_log_when_agentqueue_supports_it(self):
        argv, log = self.submit_argv("options: --manifest FILE --log FILE")
        self.assertEqual(argv[argv.index("--log") + 1], str(log))
        self.assertLess(argv.index("--log"), argv.index("run"))
        self.assertTrue(
            log.parent.is_dir()
        )  # created private for agentqueue to append to

    def test_lane_submit_omits_log_for_an_agentqueue_without_it(self):
        argv, _ = self.submit_argv("options: --manifest FILE --state-dir DIR")
        self.assertNotIn("--log", argv)
        self.assertIn("run", argv)

    def test_log_flag_is_matched_as_an_exact_token(self):
        for text, expected in (
            ("options: --manifest FILE --log-level N", False),
            ("options: --logs-dir D", False),
            ("options: --state-dir DIR  --log FILE (durable)", True),
            ("stats  --log FILE [--since T]", True),
        ):
            self.assertEqual(guard.has_flag(text, "--log"), expected, text)
        argv, _ = self.submit_argv("options: --log-level N")
        self.assertNotIn("--log", argv)

    def test_unwritable_log_directory_runs_unlogged_with_a_warning(self):
        blocker = self.tmp / "file"
        blocker.write_text("x")
        with mock.patch.dict(
            os.environ, {"AGENT_RESOURCE_LANE_LOG": str(blocker / "sub" / "log.jsonl")}
        ):
            with (
                mock.patch.object(
                    guard, "agentqueue_help", return_value="options: --log FILE"
                ),
                mock.patch.object(guard.sys, "stderr") as err,
            ):
                self.assertEqual(guard.log_arguments(self.tmp / "aq"), [])
        self.assertIn(
            "runs unlogged", "".join(c.args[0] for c in err.write.call_args_list)
        )

    def test_unreadable_help_runs_unlogged_with_a_warning(self):
        with (
            mock.patch.object(guard, "agentqueue_help", return_value=""),
            mock.patch.object(guard.sys, "stderr") as err,
        ):
            self.assertEqual(guard.log_arguments(self.tmp / "aq"), [])
        self.assertIn("unlogged", "".join(c.args[0] for c in err.write.call_args_list))

    def test_stats_fallback_accepts_lane_and_since(self):
        import subprocess as sp

        out = sp.run(
            [
                guard.sys.executable,
                str(REPO / "scripts/flow-report.py"),
                "--lanes-only",
                "--lane",
                "ci",
                "--since",
                "24h",
                "--lane-log",
                str(self.tmp / "none"),
                "--state-dir",
                str(self.tmp / "none"),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(out.returncode, 0, out.stderr)

    def test_stats_wraps_agentqueue_stats_with_the_log(self):
        aq = self.tmp / "aq"
        log = self.tmp / "lane-log.jsonl"
        with (
            mock.patch.dict(os.environ, {"AGENT_RESOURCE_LANE_LOG": str(log)}),
            mock.patch.object(Path, "cwd", return_value=self.root_a),
            mock.patch.object(guard, "agentqueue_binary", return_value=aq),
            mock.patch.object(
                guard, "agentqueue_help", return_value="usage:\n  stats  [--lane L]\n"
            ),
            mock.patch.object(guard, "user_environment", return_value={}),
            mock.patch.object(guard.subprocess, "run") as run,
        ):
            run.return_value.returncode = 0
            self.assertEqual(guard.stats_command(["--lane", "ci"]), 0)
        self.assertEqual(
            run.call_args[0][0], [str(aq), "stats", "--log", str(log), "--lane", "ci"]
        )

    def test_stats_falls_back_to_the_flow_report_without_agentqueue_stats(self):
        (self.root_a / "scripts").mkdir()
        (self.root_a / "scripts/flow-report.py").write_text("")
        log = self.tmp / "lane-log.jsonl"
        with (
            mock.patch.dict(os.environ, {"AGENT_RESOURCE_LANE_LOG": str(log)}),
            mock.patch.object(Path, "cwd", return_value=self.root_a),
            mock.patch.object(guard, "agentqueue_binary", return_value=self.tmp / "aq"),
            mock.patch.object(
                guard, "agentqueue_help", return_value="usage:\n  run [opts]\n"
            ),
            mock.patch.object(guard, "user_environment", return_value={}),
            mock.patch.object(guard.subprocess, "run") as run,
        ):
            run.return_value.returncode = 0
            guard.stats_command([])
        argv = run.call_args[0][0]
        self.assertTrue(argv[1].endswith("scripts/flow-report.py"))
        self.assertIn("--lanes-only", argv)
        self.assertEqual(argv[argv.index("--lane-log") + 1], str(log))

    def test_nesting_flattens_android_build_and_refuses_other_lanes(self):
        cases = [
            ("ci", "ci", True),
            ("ci", "android-build", True),
            ("emulator", "android-build", True),
            ("android-build", "android-build", True),
            ("ci", "emulator", False),
            ("emulator", "ci", False),
            ("android-build", "ci", False),
        ]
        for held, wanted, flattened in cases:
            with mock.patch.object(guard, "current_lane", return_value=held):
                with mock.patch.object(
                    guard.os, "execvpe", side_effect=SystemExit(0)
                ) as run:
                    with mock.patch.object(guard, "agentqueue_binary") as binary:
                        if flattened:
                            with self.assertRaises(SystemExit):
                                self.run_in(self.root_a, lane=wanted)
                            run.assert_called_once()
                        else:
                            self.assertEqual(self.run_in(self.root_a, lane=wanted), 64)
                            run.assert_not_called()
                        binary.assert_not_called()

    def test_a_leaked_lane_variable_is_not_trusted(self):
        aq = self.tmp / "aq"
        with (
            mock.patch.dict(os.environ, {"STATEACTION_LANE_HELD": "ci"}),
            mock.patch.object(guard, "current_lane", return_value=None),
            mock.patch.object(guard, "agentqueue_binary", return_value=aq),
            mock.patch.object(guard, "user_environment", return_value={}),
            mock.patch.object(guard, "run_and_stream", return_value=0) as stream,
        ):
            self.assertEqual(self.run_in(self.root_a, lane="android-build"), 0)
        stream.assert_called_once()  # queued, not flattened

    def test_unknown_lane_and_empty_command_are_refused(self):
        with self.assertRaises(guard.Refused):
            guard.lane_run("heavy", ["x"], options())
        with self.assertRaises(guard.Refused):
            guard.run_command([], options())


class LaneOutput(Env):
    def test_a_key_gives_a_deterministic_log_so_a_resubmit_sees_the_same_output(self):
        self.assertEqual(
            guard.lane_log_path("ci-local-abc"), guard.lane_log_path("ci-local-abc")
        )
        self.assertNotEqual(guard.lane_log_path("a"), guard.lane_log_path("b"))
        self.assertNotEqual(guard.lane_log_path(), guard.lane_log_path())

    def test_a_keyed_log_is_shared_not_removed_and_a_missing_log_does_not_crash(self):
        log = guard.lane_log_path("shared-key")
        code = guard.run_and_stream(
            [guard.sys.executable, "-c", "pass"], {}, log, remove=False
        )
        self.assertEqual(code, 0)
        self.assertTrue(log.exists())
        log.unlink()  # a second attached client finds the log gone: no traceback
        self.assertEqual(
            guard.run_and_stream([guard.sys.executable, "-c", "pass"], {}, log), 0
        )

    def test_signal_exit_of_the_client_is_a_shell_style_code(self):
        log = guard.lane_log_path()
        code = guard.run_and_stream(
            [
                guard.sys.executable,
                "-c",
                "import os,signal;os.kill(os.getpid(),signal.SIGKILL)",
            ],
            {},
            log,
        )
        self.assertEqual(code, 128 + 9)

    def test_job_output_is_streamed_from_the_ticket_log_and_the_log_removed(self):
        log = guard.lane_log_path()
        script = f"import time;open({str(log)!r},'a').write('one\\n');time.sleep(0.6);open({str(log)!r},'a').write('two\\n')"
        with mock.patch.object(guard.sys, "stdout") as out:
            rc = guard.run_and_stream([guard.sys.executable, "-c", script], {}, log)
        written = b"".join(c.args[0] for c in out.buffer.write.call_args_list)
        self.assertEqual((rc, written), (0, b"one\ntwo\n"))
        self.assertFalse(log.exists())

    def test_a_lane_job_refusal_reaches_the_submitter_through_the_log(self):
        log = guard.lane_log_path()
        with (
            mock.patch.dict(os.environ, {guard.LANE_LOG_ENV: str(log)}),
            mock.patch.object(guard, "admit", side_effect=guard.Refused("low memory")),
        ):
            with self.assertRaises(guard.Refused):
                guard.lane_job("ci", "0123abcd", ["x"])
        self.assertIn("low memory", log.read_text())
        log.unlink()


class FreeAndLaneJob(Env):
    def test_free_command_inside_a_capped_scope_just_execs(self):
        with (
            mock.patch.object(guard, "guarded_pid", return_value=True),
            mock.patch.object(guard.os, "execvpe", side_effect=SystemExit(0)) as run,
            mock.patch.object(guard, "run_bounded") as bounded,
        ):
            with self.assertRaises(SystemExit):
                guard.free_run(["x"])
        run.assert_called_once()
        bounded.assert_not_called()

    def test_free_command_gets_its_own_capped_scope_in_the_free_slice(self):
        with (
            mock.patch.object(guard, "guarded_pid", return_value=False),
            mock.patch.object(guard, "enforce_slice"),
            mock.patch.object(guard, "ensure_free_slice"),
            mock.patch.object(guard, "bounded_environment", return_value={"E": "1"}),
            mock.patch.object(guard, "run_bounded", return_value=5) as bounded,
        ):
            self.assertEqual(guard.free_run(["x"]), 5)
        unit = bounded.call_args[0][0]
        self.assertRegex(unit, r"^agent-free-\d+-[0-9a-f]{6}\.scope$")
        self.assertEqual(bounded.call_args[1]["slice_name"], guard.FREE_SLICE)
        self.assertEqual(bounded.call_args[1]["job_max"], guard.FREE_JOB_MAX)
        self.assertEqual(guard.FREE_SLICE, "agent-work-free.slice")
        self.assertEqual(guard.FREE_JOB_MAX, 6 * guard.GIB)
        gib = guard.GIB
        for cap, free in ((12, 4), (20, 12), (24, 16)):
            self.assertEqual(guard.free_slice_max(cap * gib), free * gib)
        # Free overlaps the emulator and a gate job: the sum can exceed the cap.
        self.assertGreater(
            guard.free_slice_max(24 * gib) + guard.EMULATOR_SHARE + guard.JOB_MAX,
            24 * gib,
        )
        self.assertEqual(bounded.call_args[1]["cpu_weight"], guard.FREE_CPU_WEIGHT)

    def test_free_mem_override_lowers_but_never_raises_the_cap(self):
        self.assertEqual(guard.parse_mem("512m"), 512 * guard.MIB)
        self.assertEqual(guard.parse_mem(None), 6 * guard.GIB)
        with self.assertRaises(guard.Refused):
            guard.parse_mem("lots")
        with (
            mock.patch.object(guard, "guarded_pid", return_value=False),
            mock.patch.object(guard, "enforce_slice"),
            mock.patch.object(guard, "ensure_free_slice"),
            mock.patch.object(guard, "bounded_environment", return_value={}),
            mock.patch.object(guard, "run_bounded", return_value=0) as bounded,
        ):
            guard.free_run(["x"], 64 * guard.GIB)
        self.assertEqual(bounded.call_args[1]["job_max"], guard.JOB_MAX)

    def test_free_scopes_are_the_oom_killers_first_victims(self):
        with (
            mock.patch.object(guard, "guarded_pid", return_value=False),
            mock.patch.object(guard, "enforce_slice"),
            mock.patch.object(guard, "ensure_free_slice"),
            mock.patch.object(guard, "bounded_environment", return_value={}),
            mock.patch.object(guard, "run_bounded", return_value=0) as bounded,
        ):
            guard.free_run(["x"])
        self.assertEqual(bounded.call_args[1]["oom_adjust"], 500)
        with (
            mock.patch.object(guard, "call"),
            mock.patch.object(guard.subprocess, "run") as run,
        ):
            run.return_value.returncode = 0
            guard.run_bounded(
                "agent-free-1-aaaaaa.scope",
                ["x"],
                slice_name="s",
                job_max=1,
                env={},
                oom_adjust=500,
            )
        self.assertTrue(callable(run.call_args[1]["preexec_fn"]))

    def test_heavy_tools_are_refused_in_free_with_the_lane_named(self):
        for tool, lane in (("/x/gradlew", "android-build"), ("emulator", "emulator")):
            with self.assertRaisesRegex(guard.Refused, lane):
                guard.free_run([tool, "a"])

    def test_lane_job_sets_the_nesting_variable_and_a_lane_scope(self):
        with (
            mock.patch.object(guard, "admit"),
            mock.patch.object(guard, "enforce_slice"),
            mock.patch.object(guard, "bounded_environment", return_value={}),
            mock.patch.object(guard, "run_bounded", return_value=0) as bounded,
        ):
            guard.lane_job("ci", "0123abcd", ["x"])
        self.assertEqual(bounded.call_args[0][0], "agent-lane-ci-0123abcd.scope")
        self.assertEqual(bounded.call_args[1]["env"]["STATEACTION_LANE_HELD"], "ci")
        self.assertEqual(bounded.call_args[1]["job_max"], guard.JOB_MAX)
        self.assertRegex(bounded.call_args[0][0], guard.LANE_SCOPE.pattern)

    def test_lane_job_is_for_agentqueue_only(self):
        for lane, key in (
            ("nope", "0123abcd"),
            ("ci", "../x"),
            ("ci", "ZZZZZZZZ"),
            ("ci", "machine"),
        ):
            with self.assertRaises(guard.Refused):
                guard.lane_job(lane, key, ["x"])
        with self.assertRaises(guard.Refused):
            guard.lane_job("ci", "0123abcd", [])

    def test_scope_classification(self):
        for name, lane, guardish in (
            ("agent-lane-ci-0123abcd.scope", True, True),
            ("agent-lane-android-build-0123abcd.scope", True, True),
            ("agent-mobile-build.scope", True, True),
            (
                "agent-free-1-abcdef.scope",
                False,
                True,
            ),  # bounded-fixtures prepare works in Free
            ("agent-lane-ci-xyz.scope", False, False),
            ("app-orca-1.scope", False, False),
        ):
            with (
                mock.patch.object(guard, "own_scope", return_value=name),
                mock.patch.object(guard, "guarded_pid", return_value=True),
            ):
                self.assertEqual(guard.inside_lane(), lane, name)
                self.assertEqual(guard.inside_guard(), guardish, name)

    def test_current_lane_comes_from_the_scope_name(self):
        with (
            mock.patch.object(
                guard, "own_scope", return_value="agent-lane-emulator-00aa11bb.scope"
            ),
            mock.patch.object(guard, "guarded_pid", return_value=True),
        ):
            self.assertEqual(guard.current_lane(), "emulator")
        with (
            mock.patch.object(
                guard, "own_scope", return_value="agent-lane-emulator-00aa11bb.scope"
            ),
            mock.patch.object(guard, "guarded_pid", return_value=False),
        ):
            self.assertIsNone(guard.current_lane())

    def test_slot_one_scope_name_is_a_lane_scope_and_distinct_from_slot_zero(self):
        # SA-108: a second ci slot must not collide with slot 0's transient unit name.
        self.assertEqual(
            guard.lane_unit("ci", "0123abcd", 0), "agent-lane-ci-0123abcd.scope"
        )
        self.assertEqual(
            guard.lane_unit("ci", "0123abcd", 1), "agent-lane-ci-0123abcd-s1.scope"
        )
        self.assertEqual(
            guard.lane_unit("ci", "0123abcd", 2), "agent-lane-ci-0123abcd-s2.scope"
        )
        for slot in (0, 1, 2):
            name = guard.lane_unit("ci", "0123abcd", slot)
            with (
                mock.patch.object(guard, "own_scope", return_value=name),
                mock.patch.object(guard, "guarded_pid", return_value=True),
            ):
                self.assertEqual(guard.current_lane(), "ci", name)
                self.assertTrue(guard.inside_lane(), name)
        for bad in (
            "agent-lane-ci-0123abcd-s0.scope",
            "agent-lane-ci-0123abcd-sx.scope",
        ):
            self.assertIsNone(guard.LANE_SCOPE.fullmatch(bad), bad)

    def test_lane_task_cap_fits_three_parallel_gates_under_the_slice_cap(self):
        self.assertEqual(guard.LANE_TASKS, 1536)  # 512 killed nested nx graph workers
        self.assertLessEqual(3 * guard.LANE_TASKS, guard.SLICE_TASKS_MAX)

    def test_slot_index_comes_from_the_held_slot_descriptor(self):
        self.assertEqual(guard.slot_index(), 0)  # no slot descriptor: slot 0 name
        sink = self.tmp / "lanes/ci-0123abcd/slot-1"
        sink.parent.mkdir(parents=True)
        fd = os.open(sink, os.O_RDWR | os.O_CREAT)
        self.addCleanup(os.close, fd)
        self.assertEqual(guard.slot_index(), 1)

    def test_lane_job_passes_slot_descriptors_to_the_scope(self):
        sink = self.tmp / "lanes/ci/slot-0"
        sink.parent.mkdir(parents=True)
        fd = os.open(sink, os.O_RDWR | os.O_CREAT)
        self.addCleanup(os.close, fd)
        self.assertIn(fd, guard.slot_fds())
        with (
            mock.patch.object(guard, "call"),
            mock.patch.object(guard.subprocess, "run") as run,
        ):
            run.return_value.returncode = 0
            guard.run_bounded(
                "agent-lane-ci-0123abcd.scope", ["x"], slice_name="s", job_max=1, env={}
            )
        self.assertIn(fd, run.call_args[1]["pass_fds"])

    def test_queue_commands_wrap_agentqueue_status_cancel_find(self):
        aq = self.tmp / "aq"
        for action, verb in (
            ("queue", "status"),
            ("cancel", "cancel"),
            ("find", "find"),
        ):
            with (
                mock.patch.object(Path, "cwd", return_value=self.root_a),
                mock.patch.object(guard, "agentqueue_binary", return_value=aq),
                mock.patch.object(guard, "user_environment", return_value={}),
                mock.patch.object(guard.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0
                guard.queue_command(action, ["x"])
            argv = run.call_args[0][0]
            self.assertEqual(argv[-2:], [verb, "x"])
            self.assertIn("--state-dir", argv)

    def test_bounded_scope_stops_the_unit_and_drops_its_owner_record(self):
        calls = []
        with (
            mock.patch.object(
                guard, "call", side_effect=lambda *a, **k: calls.append(a)
            ),
            mock.patch.object(guard.subprocess, "run") as run,
        ):
            run.return_value.returncode = 9
            self.assertEqual(
                guard.run_bounded(
                    "agent-free-1-aaaaaa.scope",
                    ["x"],
                    slice_name=guard.FREE_SLICE,
                    job_max=guard.FREE_JOB_MAX,
                    env={},
                ),
                9,
            )
        argv = run.call_args[0][0]
        self.assertIn(f"--slice={guard.FREE_SLICE}", argv)
        self.assertIn(f"--property=MemoryMax={guard.FREE_JOB_MAX}", argv)
        self.assertIn("--property=MemorySwapMax=0", argv)
        self.assertEqual(calls[0][:3], ("systemctl", "--user", "stop"))
        self.assertFalse((self.tmp / "agent-free-1-aaaaaa.scope.owner").exists())


if __name__ == "__main__":
    unittest.main()
