"""Tests for the local CI gate. They use throwaway Git repositories, a fake
guard proof and tiny stage files; they never start the real suites, Docker or
any service, and never touch the checkout they run from."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import install as installer  # noqa: E402
import local_ci  # noqa: E402

GIB = local_ci.GIB
FAKE_GUARD = {
    "scope": "agent-lane-ci-0123abcd.scope",
    "slice": local_ci.SLICE,
    "memoryMaxBytes": 6 * GIB,
    "sliceMemoryMaxBytes": 12 * GIB,
    "swapMaxBytes": 0,
    "cgroup": "/nonexistent",
}
FAKE_SERVICE = lambda role, port: {  # noqa: E731
    "role": role,
    "port": port,
    "scope": f"agent-service-{role}.scope",
    "pids": 1,
    "memoryMaxBytes": GIB,
    "swapMaxBytes": 0,
}
SECRET = "synthetic-secret-value-123"
FIXTURE_ENV = f"""CATALOG_TEST_ADMIN_URL=postgresql://bootstrap@127.0.0.1:54340/postgres
CATALOG_TEST_OWNER_URL=postgresql://migration_owner:{SECRET}@127.0.0.1:54340/postgres
CATALOG_TEST_APP_URL=postgresql://stateaction_app:{SECRET}@127.0.0.1:54340/postgres
STORAGE_TEST_ENDPOINT=http://127.0.0.1:19000
STORAGE_TEST_ACCESS_KEY_ID=stateaction-local
STORAGE_TEST_SECRET_ACCESS_KEY={SECRET}
GITHUB_TOKEN=must-not-be-forwarded
"""


def sh(repo: Path, *args: str, check=True) -> str:
    result = subprocess.run(args, cwd=repo, capture_output=True, text=True)
    if check and result.returncode:
        raise AssertionError(f"{args}: {result.stderr}")
    return result.stdout.strip()


def stage(stage_id: str, code: str, **extra) -> dict:
    return {
        "id": stage_id,
        "title": stage_id,
        "timeoutSec": extra.pop("timeoutSec", 30),
        "argv": [sys.executable, "-c", textwrap.dedent(code)],
        **extra,
    }


class RepoCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="local-ci-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.home = self.tmp / "home"
        self.repo.mkdir()
        sh(self.repo, "git", "init", "-q", "-b", "main")
        sh(self.repo, "git", "config", "user.email", "t@example.invalid")
        sh(self.repo, "git", "config", "user.name", "T")
        sh(self.repo, "git", "config", "commit.gpgsign", "false")
        (self.repo / "scripts/local-ci").mkdir(parents=True)
        shutil.copy(HERE / "local_ci.py", self.repo / "scripts/local-ci/local_ci.py")
        (self.repo / "app.txt").write_text("one\n")
        self.set_stages([stage("ok", "print('ok')")])
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-qm", "base")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")

    def set_stages(self, stages, unautomated=None):
        spec = {
            "schema": local_ci.STAGES_SCHEMA,
            "pins": {"node": "24.22.2", "pnpm": "10.33.0", "uv": ""},
            "stages": stages,
            "unautomated": unautomated or ["physical device"],
        }
        (self.repo / local_ci.STAGES_PATH).write_text(json.dumps(spec))

    def commit_pending(self, message="change"):
        sh(self.repo, "git", "add", "-A")
        if sh(self.repo, "git", "diff", "--cached", "--name-only"):
            sh(self.repo, "git", "commit", "-qm", message)

    def run_tree(self, **kwargs):
        """Commit whatever the test staged, then gate the clean HEAD (tree mode)."""
        self.commit_pending()
        kwargs.setdefault("probe_fixtures", False)
        kwargs.setdefault("log", lambda _m: None)
        return local_ci.run_pipeline(
            self.repo,
            home=self.home,
            guard=FAKE_GUARD,
            **kwargs,
        )

    def stage_change(self, text="two\n"):
        (self.repo / "app.txt").write_text(text)
        sh(self.repo, "git", "add", "app.txt")

    def receipts(self):
        return (
            sorted((self.home / "receipts").glob("*.json"))
            if (self.home / "receipts").exists()
            else []
        )


class GuardTests(RepoCase):
    def fake_cgroup(
        self,
        scope="agent-lane-ci-0123abcd.scope",
        memory="6442450944",
        swap="0",
        slice_memory="12884901888",
    ):
        root = Path(tempfile.mkdtemp(prefix="local-ci-cg-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        relative = f"user.slice/user@1.service/{local_ci.SLICE}/{scope}"
        group = root / "sys" / relative
        group.mkdir(parents=True)
        (group / "memory.max").write_text(memory + "\n")
        (group / "memory.swap.max").write_text(swap + "\n")
        (group.parent / "memory.max").write_text(slice_memory + "\n")
        (group.parent / "memory.swap.max").write_text("0\n")
        proc = root / "proc/self"
        proc.mkdir(parents=True)
        (proc / "cgroup").write_text(f"0::/{relative}\n")
        return root / "proc", root / "sys"

    def test_enforced_scope_is_accepted(self):
        proc, sys_root = self.fake_cgroup()
        proof = local_ci.guard_proof(proc, sys_root)
        self.assertEqual(proof["memoryMaxBytes"], 6 * GIB)
        self.assertEqual(proof["swapMaxBytes"], 0)

    def test_unenforced_limits_are_refused(self):
        for kwargs in (
            {"memory": "max"},
            {"memory": str(7 * GIB)},
            {"swap": "max"},
            {"slice_memory": str(13 * GIB)},
            {"scope": "other.scope"},
        ):
            proc, sys_root = self.fake_cgroup(**kwargs)
            with self.assertRaises(local_ci.GuardError, msg=str(kwargs)):
                local_ci.guard_proof(proc, sys_root)

    def policy_report(self, **changes):
        report = {
            "ok": True,
            "watchdogPolicyActive": True,
            "kernelSwapMax": "0",
            "kernelMemoryMaxBytes": 24 * GIB,
            "recordedCapBytes": 24 * GIB,
            "stopThresholdBytes": 5 * GIB,
        }
        return {**report, **changes}

    def test_cap_above_12_gib_needs_a_positive_policy_proof(self):
        proc, sys_root = self.fake_cgroup(slice_memory=str(24 * GIB))
        proof = local_ci.guard_proof(
            proc, sys_root, policy_fetch=lambda: self.policy_report()
        )
        self.assertEqual(proof["sliceMemoryMaxBytes"], 24 * GIB)
        self.assertEqual(proof["aggregatePolicy"]["stopThresholdBytes"], 5 * GIB)
        for bad in (
            {"ok": False},
            {"watchdogPolicyActive": False},  # stale or old watchdog
            {"kernelSwapMax": "max"},
            {"recordedCapBytes": 12 * GIB},  # record differs from the kernel
            {"recordedCapBytes": None},
            {"kernelMemoryMaxBytes": 20 * GIB},
        ):
            with self.assertRaisesRegex(local_ci.GuardError, "policy-2"):
                local_ci.guard_proof(
                    proc,
                    sys_root,
                    policy_fetch=lambda bad=bad: self.policy_report(**bad),
                )

    def test_missing_policy_command_or_over_24_gib_is_refused(self):
        proc, sys_root = self.fake_cgroup(slice_memory=str(24 * GIB))

        def no_policy():
            raise local_ci.GuardError("no policy proof")

        with self.assertRaises(local_ci.GuardError):
            local_ci.guard_proof(proc, sys_root, policy_fetch=no_policy)
        proc, sys_root = self.fake_cgroup(slice_memory=str(25 * GIB))
        with self.assertRaisesRegex(local_ci.GuardError, "24 GiB"):
            local_ci.guard_proof(
                proc,
                sys_root,
                policy_fetch=lambda: self.policy_report(
                    kernelMemoryMaxBytes=25 * GIB, recordedCapBytes=25 * GIB
                ),
            )

    def test_legacy_12_gib_guard_never_consults_policy(self):
        proc, sys_root = self.fake_cgroup()

        def forbidden():
            raise AssertionError("policy must not be called for the legacy cap")

        proof = local_ci.guard_proof(proc, sys_root, policy_fetch=forbidden)
        self.assertIsNone(proof["aggregatePolicy"])

    def test_missing_cgroup_files_are_refused(self):
        with self.assertRaises(local_ci.GuardError):
            local_ci.guard_proof(Path("/nonexistent-proc"), Path("/nonexistent-sys"))

    def test_missing_launcher_fails_closed_without_executing(self):
        execv = mock.Mock()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_CI_REEXEC", None)
            with self.assertRaisesRegex(local_ci.GuardError, "not installed"):
                local_ci.ensure_guard(
                    ["x.py"],
                    check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                    binary=lambda: None,
                    execv=execv,
                )
        execv.assert_not_called()

    def test_reexec_goes_through_launcher_once(self):
        execv = mock.Mock()
        launcher = Path("/fake/agent-resource")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_CI_REEXEC", None)
            local_ci.ensure_guard(
                ["x.py", "run"],
                check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                binary=lambda: launcher,
                execv=execv,
            )
            self.assertEqual(os.environ["STATEACTION_LOCAL_CI_REEXEC"], "1")
            with self.assertRaisesRegex(local_ci.GuardError, "re-execution"):
                local_ci.ensure_guard(
                    ["x.py"],
                    check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                    binary=lambda: launcher,
                    execv=execv,
                )
        args = execv.call_args[0][1]
        self.assertEqual(args[1:5], ["run", "--lane", "ci", "--"])
        self.assertEqual(execv.call_count, 1)

    def test_pipeline_refuses_without_proof(self):
        with self.assertRaises(local_ci.GuardError):
            local_ci.run_pipeline(self.repo, home=self.home, guard=None)
        self.assertFalse((self.home / "work").exists())

    def test_cli_refuses_when_guard_is_missing(self):
        cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, cwd)
        with mock.patch.object(
            local_ci, "ensure_guard", side_effect=local_ci.GuardError("no guard")
        ):
            with mock.patch.object(local_ci, "run_pipeline") as pipeline:
                self.assertEqual(local_ci.main(["run", "--tree", "HEAD"]), 75)
        pipeline.assert_not_called()


class PipelineTests(RepoCase):
    def test_pass_writes_receipt_bound_to_the_head_tree(self):
        self.stage_change()
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS")
        tree = sh(self.repo, "git", "rev-parse", "HEAD^{tree}")
        receipt = json.loads(Path(record["receipt"]).read_text())
        self.assertEqual(receipt["tree"], tree)
        self.assertEqual(receipt["mode"], "tree")
        self.assertEqual(receipt["head"], sh(self.repo, "git", "rev-parse", "HEAD"))
        self.assertEqual(receipt["stages"][0]["status"], "passed")
        self.assertEqual(receipt["unautomated"], ["physical device"])
        self.assertEqual(receipt["guard"]["swapMaxBytes"], 0)
        self.assertEqual(oct(Path(record["receipt"]).stat().st_mode & 0o777), "0o600")
        self.assertFalse(
            list((self.home / "work").iterdir()), "private export is removed"
        )

    def test_dirty_worktree_is_refused_not_stashed(self):
        (self.repo / "app.txt").write_text("three\n")
        with self.assertRaisesRegex(local_ci.Refused, "clean checkout"):
            local_ci.run_pipeline(
                self.repo,
                home=self.home,
                guard=FAKE_GUARD,
                log=lambda _m: None,
                probe_fixtures=False,
            )
        self.assertEqual((self.repo / "app.txt").read_text(), "three\n")
        self.assertEqual(sh(self.repo, "git", "stash", "list"), "")
        self.assertEqual(self.receipts(), [])

    def test_tests_run_on_the_committed_tree_not_ignored_files(self):
        marker = self.tmp / "seen.txt"
        self.set_stages(
            [
                stage(
                    "read",
                    f"import pathlib, os; pathlib.Path({str(marker)!r}).write_text(open('app.txt').read() + str(os.path.exists('ignored.env')))",
                )
            ]
        )
        (self.repo / ".gitignore").write_text("ignored.env\n")
        (self.repo / "ignored.env").write_text("SECRET=1\n")
        self.stage_change("committed-content\n")
        self.run_tree()
        self.assertEqual(marker.read_text(), "committed-content\nFalse")

    def test_edit_during_run_invalidates_the_result(self):
        self.set_stages(
            [
                stage(
                    "edit",
                    f"import subprocess; open({str(self.repo / 'late.txt')!r}, 'w').write('x'); subprocess.run(['git', '-C', {str(self.repo)!r}, 'add', 'late.txt'], check=True); subprocess.run(['git', '-C', {str(self.repo)!r}, 'commit', '-qm', 'late'], check=True)",
                )
            ]
        )
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(record["stages"][0]["status"], "tree-changed")
        self.assertEqual(self.receipts(), [])

    def test_failed_child_blocks_later_stages_and_receipt(self):
        marker = self.tmp / "second.txt"
        self.set_stages(
            [
                stage("bad", "import sys; print('boom'); sys.exit(3)"),
                stage("later", f"open({str(marker)!r}, 'w').write('x')"),
            ]
        )
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual([s["status"] for s in record["stages"]], ["failed"])
        self.assertFalse(marker.exists())
        self.assertEqual(self.receipts(), [])
        self.assertTrue((Path(record["logDir"]) / "run.json").exists())

    def test_keep_going_still_fails_overall(self):
        self.set_stages(
            [stage("bad", "import sys; sys.exit(1)"), stage("good", "print(1)")]
        )
        self.commit_pending()
        record = self.run_tree(keep_going=True)
        self.assertEqual([s["status"] for s in record["stages"]], ["failed", "passed"])
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])

    def test_partial_stage_selection_never_yields_a_receipt(self):
        record = self.run_tree(only=["ok"])
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])

    def test_timeout_reaps_the_whole_process_group(self):
        pidfile = self.tmp / "grandchild.pid"
        code = f"import subprocess, time; p = subprocess.Popen(['sleep', '60']); open({str(pidfile)!r}, 'w').write(str(p.pid)); time.sleep(60)"
        self.set_stages([stage("hang", code, timeoutSec=2)])
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "timeout")
        pid = int(pidfile.read_text())
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_output_is_bounded(self):
        self.set_stages(
            [
                stage(
                    "noisy",
                    "import sys\nwhile True: sys.stdout.write('x' * 4096)",
                    maxOutputBytes=20000,
                )
            ]
        )
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "output-limit")
        self.assertLessEqual(record["stages"][0]["logBytes"], 20000)

    def test_cancellation_kills_runner_owned_children_and_leaves_no_receipt(self):
        pidfile = self.tmp / "child.pid"
        self.set_stages(
            [
                stage(
                    "hang",
                    f"import os, time; open({str(pidfile)!r}, 'w').write(str(os.getpid())); time.sleep(120)",
                    timeoutSec=120,
                )
            ]
        )
        self.commit_pending()
        script = (
            "import sys; sys.path.insert(0, %r); import local_ci; "
            "r = local_ci.run_pipeline(%r, home=%r, guard=%r, log=lambda m: None); "
            "sys.exit(0 if r['verdict'] == 'PASS' else 130 if r['verdict'] == 'INTERRUPTED' else 1)"
        ) % (str(HERE), str(self.repo), str(self.home), FAKE_GUARD)
        runner = subprocess.Popen([sys.executable, "-c", script])
        for _ in range(100):
            if pidfile.exists() and pidfile.read_text():
                break
            time.sleep(0.1)
        child = int(pidfile.read_text())
        runner.send_signal(signal.SIGTERM)
        self.assertEqual(runner.wait(timeout=30), 130)
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)
        self.assertEqual(self.receipts(), [])
        run = json.loads(next((self.home / "logs").glob("*/run.json")).read_text())
        self.assertEqual(run["verdict"], "INTERRUPTED")

    def test_stages_run_one_at_a_time_in_declared_order(self):
        log = self.tmp / "order.log"
        body = (
            "import time; f = open({log!r}, 'a'); f.write('start {n}\\n'); f.flush(); time.sleep(0.4); "
            "f.write('end {n}\\n'); f.close()"
        )
        self.set_stages(
            [stage(f"s{n}", body.format(log=str(log), n=n)) for n in (1, 2, 3)]
        )
        self.commit_pending()
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        self.assertEqual(
            log.read_text().split("\n")[:-1],
            ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"],
        )

    def test_environment_enforces_limits_and_blocks_docker_and_secrets(self):
        out = self.tmp / "env.json"
        code = f"""
            import json, os, subprocess
            docker = subprocess.run(['docker', 'version'], capture_output=True).returncode
            json.dump({{'env': dict(os.environ), 'docker': docker}}, open({str(out)!r}, 'w'))
        """
        self.set_stages([stage("env", code)])
        self.commit_pending()
        with mock.patch.dict(
            os.environ,
            {
                "STATEACTION_LOCAL_FIXTURES": "/x",
                "E2E_EXTERNAL_FIXTURES": "/x",
                "GH_TOKEN": "abc",
                "GIT_EDITOR": "/x",
                "NPM_PASSWORD": "p",
            },
        ):
            self.assertEqual(self.run_tree()["verdict"], "PASS")
        seen = json.loads(out.read_text())
        env = seen["env"]
        self.assertEqual(seen["docker"], 126)
        for key, value in {
            "NX_DAEMON": "false",
            "NX_PARALLEL": "1",
            "NX_NO_CLOUD": "true",
            "OMP_NUM_THREADS": "2",
            "CI": "true",
        }.items():
            self.assertEqual(env[key], value)
        for key in ("GH_TOKEN", "GIT_EDITOR", "NPM_PASSWORD"):
            self.assertNotIn(key, env)
        self.assertTrue(env["PATH"].split(os.pathsep)[0].endswith("shims"))
        self.assertNotIn("STATEACTION_LOCAL_FIXTURES", env)
        self.assertNotIn("E2E_EXTERNAL_FIXTURES", env)
        self.assertNotIn("LEFTHOOK", env)
        self.assertNotIn("STATEACTION_LOCAL_CI_ACTIVE", env)

    def test_runner_must_match_the_tree_under_test(self):
        with self.assertRaisesRegex(local_ci.Refused, "differs"):
            self.run_tree(runner_text=b"tampered")

    def detached_stage(self, pidfile, exit_code=0, sleep=False):
        code = (
            "import subprocess, sys, time; "
            "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], start_new_session=True); "
            f"open({str(pidfile)!r}, 'w').write(str(p.pid)); "
            + ("time.sleep(120)" if sleep else f"sys.exit({exit_code})")
        )
        return stage("detached", code, timeoutSec=120 if sleep else 30)

    def assertDead(self, pidfile):
        pid = int(pidfile.read_text())
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        self.fail(f"detached process {pid} survived")

    def test_detached_grandchild_after_success_fails_the_stage_and_is_reaped(self):
        pidfile = self.tmp / "d1.pid"
        self.set_stages([self.detached_stage(pidfile)])
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "leaked-process")
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])
        self.assertDead(pidfile)

    def test_mobile_stage_allows_gradle_to_finish_shutdown(self):
        pidfile = self.tmp / "gradle.pid"
        code = (
            "import subprocess, sys; "
            "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(0.5)'], "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, "
            "stderr=subprocess.DEVNULL, start_new_session=True); "
            f"open({str(pidfile)!r}, 'w').write(str(p.pid))"
        )
        self.set_stages([stage("mobile-android-dart", code)])
        self.commit_pending()
        with mock.patch.object(
            local_ci, "is_gradle_daemon", return_value=True
        ) as match:
            record = self.run_tree()
        match.assert_called_with(int(pidfile.read_text()))
        self.assertEqual(record["stages"][0]["status"], "passed")
        self.assertDead(pidfile)

    def test_mobile_stage_still_reaps_unrelated_detached_grandchild(self):
        pidfile = self.tmp / "unrelated.pid"
        self.set_stages([{**self.detached_stage(pidfile), "id": "mobile-android-dart"}])
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "leaked-process")
        self.assertDead(pidfile)

    def test_detached_grandchild_after_failure_is_reaped(self):
        pidfile = self.tmp / "d2.pid"
        self.set_stages([self.detached_stage(pidfile, exit_code=2)])
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "failed")
        self.assertDead(pidfile)

    def test_detached_grandchild_is_reaped_on_cancellation(self):
        pidfile = self.tmp / "d3.pid"
        self.set_stages([self.detached_stage(pidfile, sleep=True)])
        self.commit_pending()
        script = (
            "import sys; sys.path.insert(0, %r); import local_ci; "
            "r = local_ci.run_pipeline(%r, home=%r, guard=%r, log=lambda m: None); "
            "sys.exit(130 if r['verdict'] == 'INTERRUPTED' else 1)"
        ) % (str(HERE), str(self.repo), str(self.home), FAKE_GUARD)
        runner = subprocess.Popen([sys.executable, "-c", script])
        for _ in range(100):
            if pidfile.exists() and pidfile.read_text():
                break
            time.sleep(0.1)
        runner.send_signal(signal.SIGTERM)
        self.assertEqual(runner.wait(timeout=30), 130)
        self.assertDead(pidfile)

    def test_export_is_a_private_git_repo_for_ls_files_based_stages(self):
        out = self.tmp / "ls.txt"
        code = (
            "import subprocess; "
            "r = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], "
            f"capture_output=True, text=True, check=True); open({str(out)!r}, 'w').write(r.stdout)"
        )
        self.set_stages([stage("ls", code)])
        self.commit_pending()
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        self.assertIn("app.txt", out.read_text().split())
        self.assertEqual(sh(self.repo, "git", "stash", "list"), "")

    def test_stage_rewriting_tracked_source_is_detected(self):
        self.set_stages(
            [stage("rewrite", "open('app.txt', 'w').write('changed by a stage')")]
        )
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "source-modified")
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])

    def test_new_attempt_removes_old_pass_even_when_it_fails_or_is_refused(self):
        self.stage_change()
        first = self.run_tree()
        self.assertEqual(first["verdict"], "PASS")
        self.assertEqual(len(self.receipts()), 1)
        # The same tree, rerun with a failing stage list is impossible without changing the
        # tree, so simulate the failing attempt with a failing environment instead.
        with mock.patch.object(
            local_ci, "export_tree", side_effect=local_ci.Refused("export failed")
        ):
            second = self.run_tree()
        self.assertEqual(second["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])
        self.assertTrue(
            any(
                "no PASS receipt" in e
                for e in local_ci.verify_receipt(self.repo, "HEAD", home=self.home)
            )
        )

    def test_run_prints_a_per_stage_wall_time_table_for_pass_and_fail(self):
        self.set_stages(
            [stage("alpha", "print(1)"), stage("beta", "import sys; sys.exit(2)")]
        )
        lines = []
        record = self.run_tree(log=lines.append)
        self.assertEqual(record["verdict"], "FAIL")
        table = next(x for x in lines if "stage wall time" in x)
        self.assertRegex(table, r"stage\s+status\s+seconds\s+cache hits")
        self.assertRegex(table, r"alpha\s+passed\s+\d")
        self.assertRegex(table, r"beta\s+failed\s+\d")
        self.assertRegex(table, r"TOTAL\s+FAIL\s+\d")
        run = json.loads((Path(record["logDir"]) / "run.json").read_text())
        self.assertIn("durationSec", run["stages"][0])
        self.assertIn("totalDurationSec", run)
        lines.clear()
        self.set_stages([stage("alpha", "print(1)")])
        self.assertEqual(self.run_tree(log=lines.append)["verdict"], "PASS")
        self.assertRegex(next(x for x in lines if "wall time" in x), r"TOTAL\s+PASS")

    def test_interrupted_run_still_prints_the_table(self):
        self.set_stages([stage("hang", "import time; time.sleep(60)", timeoutSec=60)])
        self.commit_pending()
        script = (
            "import sys; sys.path.insert(0, %r); import local_ci; "
            "r = local_ci.run_pipeline(%r, home=%r, guard=%r, log=lambda m: print(m, flush=True)); "
            "sys.exit(130 if r['verdict'] == 'INTERRUPTED' else 1)"
        ) % (str(HERE), str(self.repo), str(self.home), FAKE_GUARD)
        out = self.tmp / "out.txt"
        with open(out, "w") as sink:
            runner = subprocess.Popen([sys.executable, "-c", script], stdout=sink)
            for _ in range(100):
                if "stage hang" in out.read_text():
                    break
                time.sleep(0.1)
            runner.send_signal(signal.SIGTERM)
            self.assertEqual(runner.wait(timeout=30), 130)
        self.assertRegex(out.read_text(), r"TOTAL\s+INTERRUPTED")

    def test_only_a_run_that_starts_supersedes_the_receipt(self):
        self.stage_change()
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        receipt = self.receipts()[0]
        before = receipt.read_text()
        # Refused before it starts (no guard proof): the PASS stays.
        with self.assertRaises(local_ci.GuardError):
            local_ci.run_pipeline(
                self.repo, home=self.home, guard=None, probe_fixtures=False
            )
        # Waiting for the slot (main never reaches run_pipeline) leaves it alone.
        cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, cwd)
        with mock.patch.object(
            local_ci, "ensure_guard", side_effect=SystemExit(130)
        ):  # cancelled while waiting
            with self.assertRaises(SystemExit):
                local_ci.main(["run", "--tree", "HEAD"])
        self.assertEqual(receipt.read_text(), before)
        self.assertEqual(local_ci.verify_receipt(self.repo, "HEAD", home=self.home), [])
        # A run that starts removes it, even if it then fails at the fixture probe.
        self.set_stages([stage("fx", "print(1)", fixtures=True)])
        self.commit_pending()
        tree = sh(self.repo, "git", "rev-parse", "HEAD^{tree}")
        started = local_ci.run_pipeline(
            self.repo,
            home=self.home,
            guard=FAKE_GUARD,
            probe_fixtures=False,
            log=lambda _m: None,
        )
        self.assertEqual(started["verdict"], "FAIL")
        self.assertFalse((self.home / "receipts" / f"{tree}.json").exists())


class CiLaneEntryTests(RepoCase):
    """SA-124: ci:local and ci:merge enter the `ci` lane once; no heavy-slot wait path."""

    def test_the_heavy_slot_wait_path_and_legacy_lock_are_gone(self):
        for name in (
            "wait_and_spawn_guarded",
            "heavy_slot_holder",
            "heavy_lock_path",
            "describe_holder",
            "WAIT_TIMEOUT_EXIT",
        ):
            self.assertFalse(hasattr(local_ci, name), name)
        text = (HERE / "local_ci.py").read_text()
        self.assertNotIn("mobile-validation.lock", text)
        self.assertNotIn("heavy-job", text)

    def test_reexec_requests_exactly_the_ci_lane_once(self):
        execv = mock.Mock()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_CI_REEXEC", None)
            self.addCleanup(os.environ.pop, "STATEACTION_LOCAL_CI_REEXEC", None)
            local_ci.ensure_guard(
                ["x.py", "run"],
                check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                binary=lambda: Path("/fake/agent-resource"),
                execv=execv,
            )
        self.assertEqual(
            execv.call_args[0][1][:5],
            ["/fake/agent-resource", "run", "--lane", "ci", "--"],
        )

    def test_legacy_and_other_lane_scopes_do_not_prove_the_ci_lane(self):
        for scope in (
            "agent-mobile-build.scope",
            "agent-lane-android-build-0123abcd.scope",
            "agent-lane-emulator-00000000.scope",
            "agent-free-1-abc.scope",
        ):
            proc, sys_root = GuardTests.fake_cgroup(self, scope=scope)
            with self.assertRaises(local_ci.GuardError, msg=scope):
                local_ci.guard_proof(proc, sys_root)

    def test_merge_lock_is_exclusive_bounded_and_released(self):
        home = Path(tempfile.mkdtemp(prefix="local-ci-lock-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        clock = iter(range(0, 1000))
        with local_ci.merge_lock(home):
            with self.assertRaisesRegex(local_ci.Refused, "merge lock"):
                with local_ci.merge_lock(
                    home, timeout=3, sleep=lambda _s: None, clock=lambda: next(clock)
                ):
                    self.fail("second holder must not enter")
        with local_ci.merge_lock(home):  # released after the first holder left
            pass

    def test_merge_runs_inside_the_lock_and_merge_cli_enters_the_ci_lane(self):
        home = Path(tempfile.mkdtemp(prefix="local-ci-lock-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        seen = []

        def inner(*_a, **_k):
            with self.assertRaises(local_ci.Refused):  # lock is held by merge_pr
                with local_ci.merge_lock(home, timeout=0):
                    pass
            seen.append("locked")
            return 0

        with mock.patch.object(local_ci, "_merge_pr", side_effect=inner):
            self.assertEqual(
                local_ci.merge_pr(
                    Path("."), 1, github_repo="o/r", execute=True, home=home
                ),
                0,
            )
        self.assertEqual(seen, ["locked"])
        # a dry run is read-only: no lock and no ticket
        with (
            mock.patch.object(local_ci, "_merge_pr", return_value=0),
            mock.patch.object(
                local_ci, "merge_lock", side_effect=AssertionError("lock")
            ),
        ):
            self.assertEqual(
                local_ci.merge_pr(
                    Path("."), 1, github_repo="o/r", execute=False, home=home
                ),
                0,
            )
        with (
            mock.patch.object(local_ci, "ensure_guard") as guard,
            mock.patch.object(local_ci, "merge_pr", return_value=0),
            mock.patch.object(local_ci, "git", return_value="/tmp"),
        ):
            self.assertEqual(local_ci.main(["merge", "--pr", "1"]), 0)
            guard.assert_not_called()
            self.assertEqual(local_ci.main(["merge", "--pr", "1", "--execute"]), 0)
        guard.assert_called_once()
        self.assertTrue(guard.call_args[1]["key"].startswith("ci-merge-1-/tmp-"))

    def test_ticket_key_is_deterministic_and_separates_other_arguments(self):
        a = local_ci.ticket_key("ci-local", "t" * 40, ["x.py", "run", "--tree", "HEAD"])
        self.assertEqual(
            a,
            local_ci.ticket_key(
                "ci-local", "t" * 40, ["x.py", "run", "--tree", "HEAD"]
            ),
        )
        for other in (
            ["x.py", "run", "--tree", "HEAD", "--fresh"],
            ["y.py", "run", "--tree", "HEAD"],
        ):
            self.assertNotEqual(a, local_ci.ticket_key("ci-local", "t" * 40, other))
        self.assertNotEqual(
            a,
            local_ci.ticket_key(
                "ci-local", "u" * 40, ["x.py", "run", "--tree", "HEAD"]
            ),
        )

    def test_merge_refuses_when_main_moved_before_the_merge_call(self):
        policy = mock.Mock()
        policy.validate_pr.return_value = "SA-1"
        policy.primary_declaration.return_value = "Refs SA-1"
        pr = {"draft": False, "title": "SA-1: x", "head": {"sha": "a" * 40}}

        def gh(*args):
            if args == ("api", "user"):
                return {"login": "timothywangdev"}
            return pr if "--paginate" not in args else [[pr]]

        def git(repo, *args, **_k):
            table = {
                ("rev-parse", "HEAD"): "a" * 40,
                ("rev-parse", "refs/remotes/origin/main"): "b" * 40,
                ("rev-parse", "HEAD^"): "c" * 40,  # head is above an older main
            }
            return table.get(args, "" if args[0] == "status" else "t" * 40)

        with (
            mock.patch.dict(sys.modules, {"github_policy": policy}),
            mock.patch.object(local_ci, "gh_json", side_effect=gh),
            mock.patch.object(local_ci, "git", side_effect=git),
            mock.patch.object(local_ci, "verify_receipt", return_value=[]),
            mock.patch.object(local_ci.subprocess, "run") as run,
        ):
            with self.assertRaisesRegex(local_ci.Refused, "origin/main moved"):
                local_ci._merge_pr(Path("."), 1, github_repo="o/r", execute=True)
            run.assert_not_called()

    def test_reexec_passes_the_deterministic_key(self):
        execv = mock.Mock()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_CI_REEXEC", None)
            self.addCleanup(os.environ.pop, "STATEACTION_LOCAL_CI_REEXEC", None)
            local_ci.ensure_guard(
                ["x.py"],
                check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                binary=lambda: Path("/fake/ar"),
                execv=execv,
                key="ci-local-abc",
            )
        args = execv.call_args[0][1]
        self.assertEqual(args[args.index("--key") + 1], "ci-local-abc")


class FixtureTests(RepoCase):
    def fixture_file(self, text=FIXTURE_ENV):
        path = self.tmp / "fixtures.env"
        path.write_text(text)
        return str(path)

    def fixture_stage(self):
        return stage(
            "fx",
            "import os; path = os.environ['E2E_EXTERNAL_FIXTURES']; print(open(path).read()); print(oct(os.stat(path).st_mode & 0o777)); print('direct', os.environ.get('STORAGE_TEST_SECRET_ACCESS_KEY'))",
            fixtures=True,
        )

    def test_missing_fixture_file_fails_closed_without_docker(self):
        self.set_stages([self.fixture_stage()])
        self.commit_pending()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_FIXTURES", None)
            os.environ.pop("E2E_EXTERNAL_FIXTURES", None)
            record = self.run_tree()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertIn("STATEACTION_LOCAL_FIXTURES", record["detail"])
        self.assertEqual(record["stages"], [])
        self.assertEqual(self.receipts(), [])

    def test_non_loopback_and_incomplete_fixtures_are_refused(self):
        with self.assertRaisesRegex(local_ci.Refused, "loopback"):
            local_ci.load_fixtures(
                self.fixture_file(
                    FIXTURE_ENV.replace("127.0.0.1:19000", "s3.example.com:9000")
                ),
                probe=False,
            )
        with self.assertRaisesRegex(local_ci.Refused, "missing"):
            local_ci.load_fixtures(
                self.fixture_file(
                    "CATALOG_TEST_ADMIN_URL=postgresql://127.0.0.1:1/x\n"
                ),
                probe=False,
            )

    def test_unreachable_fixture_is_refused(self):
        with self.assertRaisesRegex(local_ci.Refused, "not reachable"):
            local_ci.load_fixtures(
                self.fixture_file(
                    FIXTURE_ENV.replace("54340", "1").replace("19000", "1")
                )
            )

    def service_tree(
        self,
        scope="agent-service-postgres.scope",
        memory=str(GIB),
        swap="0",
        slice_memory=str(12 * GIB),
    ):
        root = Path(tempfile.mkdtemp(dir=self.tmp))
        relative = f"user.slice/user@1.service/{local_ci.SLICE}/{scope}"
        group = root / "sys" / relative
        group.mkdir(parents=True)
        (group / "memory.max").write_text(memory)
        (group / "memory.swap.max").write_text(swap)
        (group.parent / "memory.max").write_text(slice_memory)
        (group.parent / "memory.swap.max").write_text("0")
        (root / "proc/4242").mkdir(parents=True)
        (root / "proc/4242/cgroup").write_text(f"0::/{relative}\n")
        return root / "proc", root / "sys"

    def test_fixture_server_must_sit_in_a_finite_service_cgroup(self):
        proc, sys_root = self.service_tree()
        proof = local_ci.service_proof(
            "postgres", 54340, listeners=lambda _p: [4242], proc=proc, cgroup=sys_root
        )
        self.assertEqual(
            (proof["scope"], proof["memoryMaxBytes"], proof["swapMaxBytes"]),
            ("agent-service-postgres.scope", GIB, 0),
        )

    def test_unbounded_or_wrong_fixture_server_is_refused_with_instructions(self):
        for kwargs, role in (
            ({"memory": "max"}, "postgres"),
            ({"memory": str(2 * GIB)}, "postgres"),
            ({"swap": "max"}, "postgres"),
            ({"scope": "agent-service-storage.scope"}, "postgres"),
        ):
            proc, sys_root = self.service_tree(**kwargs)
            with self.assertRaisesRegex(
                local_ci.Refused, "agent-resource serve|1 GiB|swap"
            ):
                local_ci.service_proof(
                    role, 54340, listeners=lambda _p: [4242], proc=proc, cgroup=sys_root
                )
        with self.assertRaisesRegex(local_ci.Refused, "No loopback listener"):
            local_ci.service_proof("postgres", 54340, listeners=lambda _p: [])

    def test_pipeline_fails_closed_when_service_proof_is_unavailable(self):
        self.set_stages([self.fixture_stage()])
        self.commit_pending()

        def refuse(role, port):
            raise local_ci.Refused("not in service scope")

        record = self.run_tree(fixtures_path=self.fixture_file(), service_check=refuse)
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(record["stages"], [])
        self.assertEqual(self.receipts(), [])

    def test_dead_fixture_or_missing_service_proof_fails_before_export_and_any_stage(
        self,
    ):
        marker = self.tmp / "ran.txt"
        self.set_stages(
            [
                stage("first", f"open({str(marker)!r}, 'w').write('x')"),
                self.fixture_stage(),
            ]
        )
        self.commit_pending()

        def refuse(role, port):
            raise local_ci.Refused("agent-resource serve --name postgres")

        with mock.patch.object(local_ci, "export_tree") as export:
            record = self.run_tree(
                fixtures_path=self.fixture_file(), service_check=refuse
            )
            export.assert_not_called()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertIn("agent-resource serve", record["detail"])
        self.assertEqual(record["stages"], [])
        self.assertFalse(marker.exists(), "no stage ran before the fixture check")
        # An unreachable fixture is refused by the probe the same way.
        record = self.run_tree(
            fixtures_path=self.fixture_file(
                FIXTURE_ENV.replace("54340", "1").replace("19000", "1")
            ),
            probe_fixtures=True,
        )
        self.assertIn("not reachable", record["detail"])
        self.assertFalse(marker.exists())

    def test_only_allow_listed_keys_reach_stages_and_secrets_stay_out_of_evidence(self):
        self.set_stages(
            [
                self.fixture_stage(),
                stage(
                    "plain",
                    "import os; assert 'STORAGE_TEST_SECRET_ACCESS_KEY' not in os.environ",
                ),
            ]
        )
        self.commit_pending()
        record = self.run_tree(
            fixtures_path=self.fixture_file(), service_check=FAKE_SERVICE
        )
        self.assertEqual(record["verdict"], "PASS", record)
        log = (Path(record["logDir"]) / "fx.log").read_text()
        self.assertNotIn(SECRET, log)
        self.assertIn("<redacted>", log)
        self.assertNotIn("must-not-be-forwarded", log)  # not allow-listed
        self.assertIn(
            "direct None", log
        )  # values are not injected into the environment
        self.assertIn("0o600", log)
        receipt_text = Path(record["receipt"]).read_text()
        self.assertNotIn(SECRET, receipt_text)
        self.assertIn("http://127.0.0.1:19000", receipt_text)
        self.assertIn("agent-service-postgres.scope", receipt_text)
        self.assertFalse(
            (self.home / "work" / "current").exists(), "temp fixture copy removed"
        )


class VerifyTests(RepoCase):
    def commit_passed(self, text="two\n"):
        self.stage_change(text)
        record = self.run_tree()  # commits the change, then gates that exact head
        self.assertEqual(record["verdict"], "PASS")
        return record

    def errors(self):
        return local_ci.verify_receipt(self.repo, "HEAD", home=self.home)

    def rewrite(self, record, mutate):
        path = Path(record["receipt"])
        data = json.loads(path.read_text())
        mutate(data)
        data["receiptSha256"] = local_ci.receipt_digest(data)
        path.write_text(json.dumps(data))

    def test_fresh_single_commit_receipt_is_valid(self):
        self.commit_passed()
        self.assertEqual(self.errors(), [])

    def test_head_without_receipt_is_rejected(self):
        self.commit_passed()
        (self.repo / "app.txt").write_text("other\n")
        sh(self.repo, "git", "commit", "-qam", "amend", "--amend")
        self.assertTrue(any("no PASS receipt" in e for e in self.errors()))

    def test_stale_base_is_rejected(self):
        self.commit_passed()
        sh(self.repo, "git", "checkout", "-q", "--detach", "origin/main")
        (self.repo / "main.txt").write_text("m")
        sh(self.repo, "git", "add", "main.txt")
        sh(self.repo, "git", "commit", "-qm", "main moved")
        newer = sh(self.repo, "git", "rev-parse", "HEAD")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", newer)
        sh(self.repo, "git", "checkout", "-q", "main")
        self.assertTrue(any("latest origin/main" in e for e in self.errors()))

    def test_more_than_one_commit_is_rejected(self):
        self.commit_passed()
        (self.repo / "x.txt").write_text("x")
        sh(self.repo, "git", "add", "x.txt")
        sh(self.repo, "git", "commit", "-qm", "second")
        errors = self.errors()
        self.assertTrue(
            any("no PASS receipt" in e or "exactly one commit" in e for e in errors)
        )

    def test_two_commits_with_the_same_final_tree_are_still_rejected(self):
        self.stage_change("two\n")
        (self.repo / "y.txt").write_text("y")
        sh(self.repo, "git", "add", "y.txt")
        sh(self.repo, "git", "commit", "-qm", "first")
        # Tree after a second commit that changes nothing observable: empty commit.
        record = self.run_tree()
        sh(self.repo, "git", "commit", "-q", "--allow-empty", "-m", "empty")
        self.assertEqual(record["verdict"], "PASS")
        self.assertTrue(any("exactly one commit" in e for e in self.errors()))

    def test_tampered_receipt_is_rejected(self):
        record = self.commit_passed()
        path = Path(record["receipt"])
        data = json.loads(path.read_text())
        data["stages"][0]["status"] = "failed"
        path.write_text(json.dumps(data))
        self.assertTrue(any("digest" in e for e in self.errors()))

    def test_failed_stage_even_with_valid_digest_is_rejected(self):
        record = self.commit_passed()
        self.rewrite(record, lambda d: d["stages"][0].update(status="failed"))
        self.assertTrue(any("did not pass" in e for e in self.errors()))

    def test_changed_stage_list_or_runner_invalidates_old_receipt(self):
        record = self.commit_passed()
        self.rewrite(
            record, lambda d: d.update(stagesSha256="0" * 64, runnerSha256="1" * 64)
        )
        errors = self.errors()
        self.assertTrue(any("stage list changed" in e for e in errors))
        self.assertTrue(any("runner changed" in e for e in errors))

    def test_staged_mode_receipt_is_rejected_even_with_a_valid_digest(self):
        record = self.commit_passed()
        self.assertEqual(self.errors(), [])
        self.rewrite(record, lambda d: d.update(mode="staged"))
        self.assertTrue(any("different commit context" in e for e in self.errors()))
        parent = sh(self.repo, "git", "rev-parse", "HEAD^")
        self.rewrite(record, lambda d: d.update(mode="staged", head=parent))
        self.assertTrue(any("different commit context" in e for e in self.errors()))

    def test_tree_receipt_for_the_head_directly_above_origin_main_is_accepted(self):
        self.commit_passed()
        self.assertEqual(
            sh(self.repo, "git", "rev-parse", "HEAD^"),
            sh(self.repo, "git", "rev-parse", "origin/main"),
        )
        self.assertEqual(self.errors(), [])

    def test_receipt_from_another_parent_context_is_rejected(self):
        record = self.commit_passed()
        self.rewrite(record, lambda d: d.update(head="0" * 40))
        self.assertTrue(any("different commit context" in e for e in self.errors()))

    def test_superseded_attempt_invalidates_the_receipt(self):
        self.commit_passed()
        tree = sh(self.repo, "git", "rev-parse", "HEAD^{tree}")
        local_ci.record_attempt(self.home, tree, "newer-run", "running")
        self.assertTrue(any("superseded" in e for e in self.errors()))

    def test_receipt_without_guard_limits_is_rejected(self):
        record = self.commit_passed()
        self.rewrite(record, lambda d: d["guard"].update(memoryMaxBytes=0))
        self.assertTrue(any("guard" in e for e in self.errors()))


class AmendVerifyTests(RepoCase):
    """An amend changes the tree or head: the receipt never carries over."""

    commit_passed = VerifyTests.commit_passed
    errors = VerifyTests.errors

    def test_amended_head_needs_a_new_run(self):
        self.commit_passed()
        sh(self.repo, "git", "commit", "-q", "--amend", "-m", "amended")
        self.assertTrue(
            any(
                "different commit context" in e or "no PASS receipt" in e
                for e in self.errors()
            ),
            self.errors(),
        )
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS")
        self.assertEqual(self.errors(), [])

    def test_amend_with_different_content_than_tested_is_rejected(self):
        self.commit_passed()
        (self.repo / "app.txt").write_text("untested\n")
        sh(self.repo, "git", "commit", "-qa", "--amend", "-m", "again")
        self.assertTrue(any("no PASS receipt" in e for e in self.errors()))


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="local-ci-install-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.main = self.tmp / "main"
        self.main.mkdir()
        sh(self.main, "git", "init", "-q", "-b", "main")
        sh(self.main, "git", "config", "user.email", "t@example.invalid")
        sh(self.main, "git", "config", "user.name", "T")
        (self.main / "f").write_text("1")
        sh(self.main, "git", "add", "f")
        sh(self.main, "git", "commit", "-qm", "init")
        self.linked = self.tmp / "linked"
        sh(self.main, "git", "worktree", "add", "-q", "-b", "other", str(self.linked))

    def worktree_value(self, repo):
        return sh(
            repo, "git", "config", "--worktree", "--get", "core.hooksPath", check=False
        )

    def test_install_is_idempotent_and_worktree_scoped(self):
        first = installer.install(self.linked)
        self.assertIn("core.hooksPath(worktree)", first["changed"])
        self.assertEqual(installer.install(self.linked)["changed"], [])
        self.assertEqual(self.worktree_value(self.linked), first["hooksPath"])
        self.assertEqual(self.worktree_value(self.main), "")
        self.assertEqual(
            sh(
                self.main,
                "git",
                "config",
                "--local",
                "--get",
                "core.hooksPath",
                check=False,
            ),
            "",
        )
        shared = Path(sh(self.main, "git", "rev-parse", "--git-common-dir"))
        shared = shared if shared.is_absolute() else self.main / shared
        self.assertEqual(
            [
                p.name
                for p in (shared / "hooks").glob("*")
                if not p.name.endswith(".sample")
            ],
            [],
        )
        self.assertIn("worktrees/linked/stateaction-hooks", first["hooksPath"])
        for name in installer.HOOKS:
            self.assertTrue(os.access(Path(first["hooksPath"]) / name, os.X_OK))

    def test_uninstall_restores_only_our_own_setting(self):
        previous = self.tmp / "theirs"
        previous.mkdir()
        sh(self.linked, "git", "config", "extensions.worktreeConfig", "true")
        sh(self.linked, "git", "config", "--worktree", "core.hooksPath", str(previous))
        installer.install(self.linked)
        installer.install(self.main)
        result = installer.uninstall(self.linked)
        self.assertTrue(result["removed"])
        self.assertEqual(self.worktree_value(self.linked), str(previous))
        self.assertNotEqual(self.worktree_value(self.main), "")
        # A hooks path installed by someone else afterwards must survive uninstall.
        sh(
            self.linked,
            "git",
            "config",
            "--worktree",
            "core.hooksPath",
            "/someone/else",
        )
        again = installer.uninstall(self.linked)
        self.assertFalse(again["removed"])
        self.assertEqual(self.worktree_value(self.linked), "/someone/else")

    def test_wrappers_quote_hostile_paths_and_never_execute_them(self):
        hostile = self.tmp / 'we\'ird $(touch PWNED1) `touch PWNED2` "x"'
        sh(self.main, "git", "worktree", "add", "-q", "-b", "hostile", str(hostile))
        info = installer.install(hostile)
        (hostile / "scripts/local-ci/hooks").mkdir(parents=True)
        marker = self.tmp / "ran"
        hook = hostile / "scripts/local-ci/hooks/pre-commit"
        hook.write_text(f"#!/bin/sh\necho ran > {shlex.quote(str(marker))}\n")
        hook.chmod(0o755)
        result = subprocess.run(
            [str(Path(info["hooksPath"]) / "pre-commit")], cwd=hostile
        )
        self.assertEqual(result.returncode, 0)
        self.assertTrue(marker.exists())
        for name in ("PWNED1", "PWNED2"):
            self.assertFalse(list(self.tmp.rglob(name)))

    def test_wrapper_fails_closed_when_tracked_hook_is_missing(self):
        info = installer.install(self.linked)
        result = subprocess.run(
            [str(Path(info["hooksPath"]) / "pre-commit")],
            cwd=self.linked,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing", result.stderr)

    def shim_bin(self):
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir(exist_ok=True)
        self.trace = self.tmp / "trace"
        for name, code in (
            ("node", "${NODE_EXIT:-0}"),
            ("python3", "${PYTHON_EXIT:-0}"),
        ):
            shim = bin_dir / name
            shim.write_text(
                f'#!/bin/sh\necho "{name} $@" >> {self.trace}\nexit {code}\n'
            )
            shim.chmod(0o755)
        # A worktree wrapper exports STATEACTION_PREVIOUS_HOOKS to its hook; when
        # this suite runs from inside such a commit it must not redirect the
        # temporary repository's hook chain.
        env = {k: v for k, v in os.environ.items() if k != "STATEACTION_PREVIOUS_HOOKS"}
        return {**env, "PATH": f"{bin_dir}:{os.environ['PATH']}"}

    def test_pre_commit_runs_only_the_staged_checks_and_never_local_ci(
        self,
    ):
        hooks = self.linked / "scripts/local-ci/hooks"
        hooks.mkdir(parents=True)
        shutil.copy(HERE / "hooks/pre-commit", hooks / "pre-commit")
        (self.linked / "scripts/platform").mkdir(parents=True)
        (self.linked / "scripts/platform/check-staged.mjs").write_text("")
        env = self.shim_bin()
        ok = subprocess.run([str(hooks / "pre-commit")], cwd=self.linked, env=env)
        self.assertEqual(ok.returncode, 0)
        self.assertEqual(
            self.trace.read_text().split("\n")[:-1],
            ["node scripts/platform/check-staged.mjs"],
        )
        self.assertNotIn("local_ci.py", self.trace.read_text())
        self.assertNotIn("local_ci.py", (HERE / "hooks/pre-commit").read_text())
        self.trace.unlink()
        failing = subprocess.run(
            [str(hooks / "pre-commit")],
            cwd=self.linked,
            env={**env, "NODE_EXIT": "1"},
        )
        self.assertEqual(
            failing.returncode, 1, "a staged-content failure still blocks the commit"
        )

    def test_pre_commit_chains_the_previous_worktree_hooks_directory(self):
        previous = self.tmp / "prev-hooks"
        previous.mkdir()
        trace = self.tmp / "prev-trace"
        old = previous / "pre-commit"
        old.write_text(
            f"#!/bin/sh\necho previous >> {shlex.quote(str(trace))}\nexit ${{PREV_EXIT:-0}}\n"
        )
        old.chmod(0o755)
        sh(self.linked, "git", "config", "extensions.worktreeConfig", "true")
        sh(self.linked, "git", "config", "--worktree", "core.hooksPath", str(previous))
        info = installer.install(self.linked)
        hooks = self.linked / "scripts/local-ci/hooks"
        hooks.mkdir(parents=True)
        shutil.copy(HERE / "hooks/pre-commit", hooks / "pre-commit")
        env = self.shim_bin()
        self.assertEqual(
            subprocess.run(
                [str(Path(info["hooksPath"]) / "pre-commit")], cwd=self.linked, env=env
            ).returncode,
            0,
        )
        self.assertEqual(trace.read_text(), "previous\n")
        self.assertFalse(self.trace.exists(), "the hook never starts local_ci.py")
        blocked = subprocess.run(
            [str(Path(info["hooksPath"]) / "pre-commit")],
            cwd=self.linked,
            env={**env, "PREV_EXIT": "1"},
        )
        self.assertEqual(blocked.returncode, 1)
        self.assertFalse(self.trace.exists())

    def push(self, hook, lines, env=None):
        return subprocess.run(
            [str(hook), "origin", "url"],
            input=lines,
            text=True,
            capture_output=True,
            env=env,
        )

    def test_pre_push_blocks_main_even_without_or_with_a_previous_hook(self):
        hook = HERE / "hooks/pre-push"
        main_update = "refs/heads/x aaaa refs/heads/main bbbb\n"
        branch_update = "refs/heads/x aaaa refs/heads/ticket bbbb\n"
        delete_main = "(delete) 0000 refs/heads/main bbbb\n"
        base_env = {**os.environ, "STATEACTION_PREVIOUS_HOOKS": str(self.tmp / "none")}
        self.assertEqual(self.push(hook, main_update, base_env).returncode, 1)
        self.assertEqual(self.push(hook, delete_main, base_env).returncode, 1)
        self.assertEqual(self.push(hook, branch_update, base_env).returncode, 0)
        previous = self.tmp / "prev"
        previous.mkdir()
        seen = self.tmp / "seen"
        old = previous / "pre-push"
        old.write_text(f"#!/bin/sh\ncat > {shlex.quote(str(seen))}\nexit 0\n")
        old.chmod(0o755)
        env = {**os.environ, "STATEACTION_PREVIOUS_HOOKS": str(previous)}
        self.assertEqual(
            self.push(hook, main_update, env).returncode,
            1,
            "a permissive previous hook cannot waive main protection",
        )
        self.assertEqual(self.push(hook, branch_update, env).returncode, 0)
        self.assertEqual(seen.read_text(), branch_update)


class MergePostconditionTests(unittest.TestCase):
    BASE, HEAD_TREE, SHA = "a" * 40, "b" * 40, "c" * 40

    def api(self, parents, tree, merged=True):
        def call(*args):
            if "pulls" in args[1]:
                return {"merged": merged, "merge_commit_sha": self.SHA}
            return {
                "parents": [{"sha": p} for p in parents],
                "commit": {"tree": {"sha": tree}},
            }

        return call

    def check(self, **kwargs):
        return local_ci.check_merged_commit(
            "o/r", 7, self.BASE, self.HEAD_TREE, api=self.api(**kwargs)
        )

    def test_squash_on_the_tested_base_and_tree_is_accepted(self):
        result = self.check(parents=[self.BASE], tree=self.HEAD_TREE)
        self.assertEqual(result["mergeSha"], self.SHA)

    def test_base_race_tree_mismatch_or_extra_parent_is_fatal(self):
        for parents, tree in (
            (["d" * 40], self.HEAD_TREE),  # main moved in the final interval
            ([self.BASE], "e" * 40),  # content differs
            ([self.BASE, "d" * 40], self.HEAD_TREE),  # a merge commit
            ([], self.HEAD_TREE),
        ):
            with self.assertRaisesRegex(
                local_ci.MergedOnUntestedBase, "nothing was retried"
            ):
                self.check(parents=parents, tree=tree)

    def test_unreported_merge_is_fatal(self):
        with self.assertRaises(local_ci.MergedOnUntestedBase):
            self.check(parents=[self.BASE], tree=self.HEAD_TREE, merged=False)

    def test_merge_refuses_without_a_valid_receipt_and_never_calls_gh_merge(self):
        policy = mock.Mock()
        policy.validate_pr.return_value = "SA-1"
        policy.primary_declaration.return_value = "Refs SA-1"
        pr = {"draft": False, "title": "SA-1: x", "head": {"sha": "a" * 40}}

        def gh(*args):
            return (
                {"login": "timothywangdev"}
                if args == ("api", "user")
                else (
                    pr if "pulls/1" in args[1] and "--paginate" not in args else [[pr]]
                )
            )

        with mock.patch.dict(sys.modules, {"github_policy": policy}):
            with mock.patch.object(local_ci, "gh_json", side_effect=gh):
                with mock.patch.object(local_ci, "git", return_value="a" * 40):
                    with mock.patch.object(
                        local_ci,
                        "verify_receipt",
                        return_value=["no PASS receipt for tree t"],
                    ):
                        with mock.patch.object(local_ci.subprocess, "run") as run:
                            with self.assertRaisesRegex(
                                local_ci.Refused, "Local receipt rejected"
                            ):
                                local_ci._merge_pr(
                                    Path("."), 1, github_repo="o/r", execute=True
                                )
                            run.assert_not_called()

    def test_merge_is_not_blocked_by_a_running_ci_run_lock_and_the_cli_reports_fatal(
        self,
    ):
        home = Path(tempfile.mkdtemp(prefix="local-ci-merge-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        fd = local_ci.acquire_lock(local_ci.private_dir(home))  # a ci:local is running
        try:
            with mock.patch.object(local_ci, "_merge_pr", return_value=0) as inner:
                self.assertEqual(
                    local_ci.merge_pr(
                        Path("."), 1, github_repo="o/r", execute=False, home=home
                    ),
                    0,
                )
                inner.assert_called_once()
        finally:
            os.close(fd)
        with (
            mock.patch.object(
                local_ci,
                "merge_pr",
                side_effect=local_ci.MergedOnUntestedBase("FATAL x"),
            ),
            mock.patch.object(local_ci, "ensure_guard"),
        ):
            with mock.patch.object(local_ci, "git", return_value="/tmp"):
                self.assertEqual(local_ci.main(["merge", "--pr", "1"]), 3)


class SubmoduleExportTests(RepoCase):
    def test_pinned_commit_is_exported_even_when_a_hook_sets_git_dir(self):
        source = self.tmp / "sources" / "stera-sdk"
        source.mkdir(parents=True)
        sh(source, "git", "init", "-q", "-b", "main")
        sh(source, "git", "config", "user.email", "t@example.invalid")
        sh(source, "git", "config", "user.name", "T")
        (source / "README.md").write_text("pinned\n")
        sh(source, "git", "add", "README.md")
        sh(source, "git", "commit", "-qm", "pin")
        pinned = sh(source, "git", "rev-parse", "HEAD")
        (source / "README.md").write_text("dirty worktree, never exported\n")
        sh(source, "git", "commit", "-qam", "newer")
        destination = self.tmp / "export"
        destination.mkdir()
        hook_env = {
            "GIT_DIR": str(self.repo / ".git"),
            "GIT_INDEX_FILE": str(self.repo / ".git" / "index"),
            "STATEACTION_LOCAL_CI_SUBMODULES": str(self.tmp / "sources"),
        }
        with mock.patch.dict(os.environ, hook_env):
            self.assertTrue(
                local_ci.export_submodule(self.repo, "stera-sdk", pinned, destination)
            )
            missing = "0" * 40
            self.assertFalse(
                local_ci.export_submodule(self.repo, "stera-sdk", missing, destination)
            )
        self.assertEqual((destination / "stera-sdk/README.md").read_text(), "pinned\n")


class CacheTests(RepoCase):
    NX_STAGE = {"argv": ["pnpm", "exec", "nx", "run-many", "-t", "test"], "cache": "nx"}

    def test_cached_nx_stage_uses_the_cache_but_fresh_and_undeclared_stages_never_do(
        self,
    ):
        argv, skip = local_ci.effective_argv(self.NX_STAGE, fresh=False)
        self.assertFalse(skip)
        self.assertNotIn("--skip-nx-cache", argv)
        argv, skip = local_ci.effective_argv(self.NX_STAGE, fresh=True)
        self.assertTrue(skip)
        self.assertIn("--skip-nx-cache", argv)
        undeclared = {"argv": ["pnpm", "exec", "nx", "run", "web:auth-e2e"]}
        argv, skip = local_ci.effective_argv(undeclared, fresh=False)
        self.assertTrue(skip)
        self.assertEqual(argv.count("--skip-nx-cache"), 1)
        again, _ = local_ci.effective_argv({"argv": argv}, fresh=False)
        self.assertEqual(again.count("--skip-nx-cache"), 1)
        other = {"argv": ["python3", "-m", "unittest"], "cache": "nx"}
        self.assertEqual(
            local_ci.effective_argv(other, fresh=False),
            (["python3", "-m", "unittest"], False),
        )

    def test_environment_shares_one_private_cache_and_scopes_gradle_caching(self):
        shim = self.tmp / "shim"
        shim.mkdir()
        cache = self.tmp / "nx-cache"

        def env_for(**kwargs):
            return local_ci.stage_env(
                {"PATH": "/usr/bin", "HOME": str(self.tmp)},
                shim_dir=shim,
                node_version="24.22.2",
                stage={},
                tmp=self.tmp,
                cache_dir=cache,
                workspace_data_dir=self.tmp / "nx-data",
                **kwargs,
            )

        warm = env_for(skip_nx_cache=False, gradle_cache=True)
        self.assertEqual(warm["NX_CACHE_DIRECTORY"], str(cache))
        self.assertEqual(warm["NX_WORKSPACE_DATA_DIRECTORY"], str(self.tmp / "nx-data"))
        self.assertNotIn("NX_SKIP_NX_CACHE", warm)
        self.assertEqual(warm["NX_NO_CLOUD"], "true")
        self.assertEqual(warm["NX_DAEMON"], "false")
        self.assertIn("-Dorg.gradle.caching=true", warm["GRADLE_OPTS"])
        self.assertNotIn("configuration-cache", warm["GRADLE_OPTS"])
        self.assertIn("-XX:ActiveProcessorCount=2", warm["JAVA_TOOL_OPTIONS"])
        self.assertEqual((warm["UV_THREADPOOL_SIZE"], warm["GOMAXPROCS"]), ("2", "2"))
        cold = env_for(skip_nx_cache=True, gradle_cache=False)
        self.assertEqual(cold["NX_SKIP_NX_CACHE"], "true")
        self.assertIn("-Dorg.gradle.caching=false", cold["GRADLE_OPTS"])

    def test_cache_hits_and_executed_tasks_are_distinguished_in_the_receipt(self):
        code = """
            print('> nx run contracts:build  [local cache]')
            print('> nx run server:test')
            print('> nx run web:format  [existing outputs match the cache, left as is]')
        """
        spec = stage("fake-nx", code, cache="nx")
        self.set_stages([spec])
        self.commit_pending()
        record = self.run_tree()
        entry = record["stages"][0]
        self.assertEqual(entry["status"], "passed")
        # The fake is not an nx invocation, so it is neither scanned nor given cache mode.
        self.assertEqual(entry["cacheMode"], "none")
        scan = local_ci.CacheScan()
        scan.feed(
            b"> nx run contracts:build  [local cache]\n> nx run server:test\n> nx run web:format  [existing outputs ma"
        )
        scan.feed(b"tch the cache, left as is]\nnoise\n")
        summary = scan.summary()
        self.assertEqual(summary["hitTasks"], ["contracts:build", "web:format"])
        self.assertEqual(summary["executedTasks"], ["server:test"])
        self.assertEqual((summary["tasks"], summary["hits"]), (3, 2))
        colored = local_ci.CacheScan()
        colored.feed(
            b"\x1b[2m> \x1b[22m\x1b[2mnx run\x1b[22m contracts:build  \x1b[2m[local cache]\x1b[22m\n"
        )
        self.assertEqual(colored.summary()["hitTasks"], ["contracts:build"])

    def test_fresh_run_is_recorded_and_still_passes_every_stage(self):
        self.stage_change()
        record = self.run_tree(fresh=True)
        receipt = json.loads(Path(record["receipt"]).read_text())
        self.assertTrue(receipt["fresh"])
        self.assertEqual(receipt["stages"][0]["status"], "passed")
        # Informational metrics are present, and dropping them leaves the receipt verifiable.
        self.assertIn("metrics", receipt["stages"][0])
        for stage in receipt["stages"]:
            stage.pop("metrics", None)
        receipt["receiptSha256"] = local_ci.receipt_digest(receipt)
        self.assertEqual(local_ci.receipt_digest(receipt), receipt["receiptSha256"])
        self.assertGreaterEqual(receipt["totalDurationSec"], 0)
        self.assertEqual(
            receipt["toolchainSha256"],
            local_ci.sha256_bytes(
                json.dumps(receipt["toolchain"], sort_keys=True).encode()
            ),
        )

    def test_changed_inputs_never_reuse_an_old_receipt_or_attempt(self):
        self.stage_change("one\n")
        first = self.run_tree()
        self.assertEqual(first["verdict"], "PASS")
        self.stage_change("source changed\n")
        second = self.run_tree()
        self.assertNotEqual(first["tree"], second["tree"])
        self.assertEqual(len(self.receipts()), 2)
        self.assertEqual(local_ci.verify_receipt(self.repo, "HEAD", home=self.home), [])
        # Tampering with the recorded toolchain (stale compiler/runtime) is detected.
        receipt_path = Path(second["receipt"])
        data = json.loads(receipt_path.read_text())
        data["toolchain"] = {"node": "v0.0.0"}
        data["receiptSha256"] = local_ci.receipt_digest(data)
        receipt_path.write_text(json.dumps(data))
        self.assertTrue(
            any(
                "toolchain" in e
                for e in local_ci.verify_receipt(self.repo, "HEAD", home=self.home)
            )
        )

    def test_one_run_at_a_time_per_ci_home_and_fixed_export_path(self):
        fd = local_ci.acquire_lock(local_ci.private_dir(self.home))
        try:
            with self.assertRaisesRegex(local_ci.Refused, "owns this CI home"):
                self.run_tree()
        finally:
            os.close(fd)
        paths = self.tmp / "paths.txt"
        code = f"import os; open({str(paths)!r}, 'a').write(os.getcwd() + chr(10))"
        self.set_stages([stage("where", code)])
        self.commit_pending()
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        first, second = paths.read_text().split()
        self.assertEqual(
            first, second, "stable export path keeps path-sensitive caches valid"
        )

    def test_warm_stage_list_declares_cache_only_for_deterministic_stages(self):
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        for item in spec["stages"]:
            if item.get("fixtures"):
                self.assertNotIn("cache", item, item["id"])
                self.assertFalse(item.get("gradleBuildCache"), item["id"])
        self.assertEqual(
            [s["id"] for s in spec["stages"] if s.get("gradleBuildCache")],
            ["mobile-android-dart"],
        )
        gradle = (
            HERE.parents[1] / "spikes/android/capture/app/build.gradle.kts"
        ).read_text()
        self.assertIn(
            'outputs.dir(layout.buildDirectory.dir("spike-fixtures"))', gradle
        )
        for item in spec["stages"]:
            self.assertLessEqual(item["timeoutSec"], 1800, item["id"])
            if item.get("cache") == "nx":
                self.assertIn("--nxBail", item["argv"])
        cached = [s["id"] for s in spec["stages"] if s.get("cache") == "nx"]
        self.assertEqual(cached, ["server-tooling", "mobile-android-dart"])
        for item in spec["stages"]:
            if item.get("cache") == "nx":
                self.assertNotIn("--skip-nx-cache", item["argv"])

    def test_nx_hashes_include_toolchain_runtime_and_never_use_cloud(self):
        nx = json.loads((HERE.parents[1] / "nx.json").read_text())
        runtime = {
            i["runtime"]
            for i in nx["namedInputs"]["sharedGlobals"]
            if isinstance(i, dict) and "runtime" in i
        }
        for command in (
            "node --version",
            "pnpm --version",
            "python3 --version",
            "uv --version",
            "flutter --version --machine",
        ):
            self.assertIn(command, runtime)
        self.assertTrue(nx["neverConnectToCloud"])
        self.assertFalse(nx["targetDefaults"]["integration"]["cache"])


class StageOpenFileLimitTests(unittest.TestCase):
    def test_stage_child_gets_the_hard_open_file_limit_when_started_at_1024(self):
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if hard != resource.RLIM_INFINITY and hard <= 1024:
            self.skipTest("hard limit is already 1024")
        resource.setrlimit(resource.RLIMIT_NOFILE, (1024, hard))
        self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, (soft, hard))
        with tempfile.TemporaryDirectory() as raw:
            result = local_ci.run_child(
                [
                    sys.executable,
                    "-c",
                    "import resource;print(resource.getrlimit(resource.RLIMIT_NOFILE)[0])",
                ],
                cwd=Path(raw),
                env=os.environ.copy(),
                log=Path(raw) / "log",
                timeout=30,
                output_cap=100000,
                secrets_=[],
                stop={"requested": False},
                capture=True,
            )
            self.assertEqual(result["status"], "passed")
            self.assertEqual(
                int(result["captured"]),
                hard if hard != resource.RLIM_INFINITY else int(result["captured"]),
            )
            self.assertGreater(int(result["captured"]), 1024)


class StageMetricsTests(unittest.TestCase):
    def test_nx_task_timings_follow_task_lines(self):
        scan = local_ci.CacheScan()
        scan.feed(b"> nx run a:build  [local cache]\n> nx run b:test\n")
        timings = scan.summary()["taskTimings"]
        self.assertEqual([t["task"] for t in timings], ["a:build", "b:test"])
        self.assertEqual([t["cacheHit"] for t in timings], [True, False])
        self.assertTrue(all(t["spanSec"] >= 0 for t in timings))

    def test_cpu_and_memory_read_from_cgroup_files(self):
        with tempfile.TemporaryDirectory() as raw:
            group = Path(raw)
            (group / "cpu.stat").write_text("usage_usec 2500000\nuser_usec 1\n")
            (group / "memory.current").write_text("12345\n")
            self.assertEqual(local_ci.cpu_seconds(group), 2.5)
            self.assertEqual(local_ci.memory_current(group), 12345)
        self.assertIsNone(local_ci.cpu_seconds(Path("/nonexistent-cgroup")))
        self.assertIsNone(local_ci.memory_current(None))

    def test_run_child_reports_cpu_delta_and_sampled_peak(self):
        with tempfile.TemporaryDirectory() as raw:
            group = Path(raw) / "cg"
            group.mkdir()
            (group / "cpu.stat").write_text("usage_usec 1000000\n")
            (group / "memory.current").write_text("4096\n")
            (group / "memory.peak").write_text("8192\n")
            result = local_ci.run_child(
                [
                    sys.executable,
                    "-c",
                    "import pathlib,sys;g=pathlib.Path(sys.argv[1]);"
                    "g.joinpath('cpu.stat').write_text('usage_usec 3500000\\n')",
                    str(group),
                ],
                cwd=Path(raw),
                env=os.environ.copy(),
                log=Path(raw) / "log",
                timeout=30,
                output_cap=100000,
                secrets_=[],
                stop={"requested": False},
                cgroup=group,
            )
            self.assertEqual(result["metrics"]["cpuSeconds"], 2.5)
            self.assertEqual(result["metrics"]["peakMemorySampledBytes"], 4096)
            self.assertEqual(result["metrics"]["scopePeakBytesAfter"], 8192)

    def test_metrics_are_none_without_a_cgroup(self):
        with tempfile.TemporaryDirectory() as raw:
            result = local_ci.run_child(
                [sys.executable, "-c", "pass"],
                cwd=Path(raw),
                env=os.environ.copy(),
                log=Path(raw) / "log",
                timeout=30,
                output_cap=1000,
                secrets_=[],
                stop={"requested": False},
            )
            metrics = result["metrics"]
            self.assertIsNone(metrics["cpuSeconds"])
            self.assertIsNone(metrics["cpuPerWall"])
            self.assertIsNone(metrics["peakMemorySampledBytes"])
            self.assertIsNone(metrics["scopePeakBytesAfter"])
            self.assertGreater(metrics["wallSeconds"], 0)

    def _write_run(self, home, name, verdict, stages):
        run = home / "logs" / name
        run.mkdir(parents=True)
        (run / "run.json").write_text(
            json.dumps({"verdict": verdict, "stages": stages})
        )

    def test_timing_report_medians_and_not_recorded(self):
        def stage(sid, wall, cpu=None, peak=None):
            metrics = {
                "cpuSeconds": cpu,
                "cpuPerWall": None if cpu is None else round(cpu / wall, 2),
                "peakMemorySampledBytes": peak,
                "scopePeakBytesAfter": None,
            }
            return {"id": sid, "durationSec": wall, "metrics": metrics}

        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            # Old run: no metrics field at all.
            self._write_run(home, "1", "PASS", [{"id": "a", "durationSec": 10.0}])
            self._write_run(home, "2", "PASS", [stage("a", 10.0, 10.0, 1048576 * 100)])
            self._write_run(home, "3", "PASS", [stage("a", 20.0, 10.0, 1048576 * 300)])
            self._write_run(home, "4", "PASS", [stage("a", 30.0, 10.0, 1048576 * 200)])
            self._write_run(home, "5", "FAIL", [stage("a", 999.0, 1.0, 1)])
            text = local_ci.timing_report(home, 5)
            row = [r for r in text.splitlines() if r.startswith("a ")][0].split()
            self.assertEqual(row[1:], ["15.0", "10.0", "0.50", "200", "4"])
            self.assertIn("over 4 PASS run(s)", text)
            # Only old runs: not recorded, never zero.
            old = Path(raw) / "old"
            self._write_run(old, "1", "PASS", [{"id": "a", "durationSec": 10.0}])
            text = local_ci.timing_report(old, 3)
            self.assertIn("not recorded", text)
            self.assertNotIn(" 0.0", text)
            self.assertIn("no PASS runs", local_ci.timing_report(Path(raw) / "none"))

    def test_missing_cgroup_counter_is_not_available_not_zero(self):
        with tempfile.TemporaryDirectory() as raw:
            group = Path(raw)
            (group / "cpu.stat").write_text("user_usec 5\n")
            (group / "memory.current").write_text("garbage\n")
            self.assertIsNone(local_ci.cpu_seconds(group))
            self.assertIsNone(local_ci.memory_current(group))


class StageFileTests(unittest.TestCase):
    def test_android_upload_build_runs_in_mobile_lane(self):
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        stages = {item["id"]: item["argv"] for item in spec["stages"]}
        server = next(
            arg for arg in stages["server-tooling"] if arg.startswith("--exclude=")
        )
        mobile = next(
            arg
            for arg in stages["mobile-android-dart"]
            if arg.startswith("--projects=")
        )
        project = "android-upload-spike-native"
        self.assertIn(project, server.split("=", 1)[1].split(","))
        self.assertIn(project, mobile.split("=", 1)[1].split(","))

    def test_shipped_stage_file_is_valid_serial_and_declares_all_suites(self):
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        ids = [s["id"] for s in spec["stages"]]
        for needed in (
            "root-python-tests",
            "render-cli",
            "server-tooling",
            "mobile-android-dart",
            "catalog-integration",
            "server-auth-integration",
            "web-auth-e2e",
            "mobile-backend-e2e",
            "jobs-controller-integration",
            "runtime-smoke",
        ):
            self.assertIn(needed, ids)
        for item in spec["stages"]:
            joined = " ".join(item["argv"])
            if item["argv"][:3] == ["pnpm", "exec", "nx"]:
                if item.get("cache") != "nx":
                    self.assertIn("--skip-nx-cache", joined, item["id"])
                if "run-many" in joined:
                    self.assertIn("--parallel=1", joined, item["id"])
            self.assertNotIn("docker", joined)
        controller = next(
            s for s in spec["stages"] if s["id"] == "jobs-controller-integration"
        )
        self.assertTrue(controller["fixtures"])
        self.assertNotIn("cache", controller)
        self.assertEqual(
            controller["argv"],
            ["pnpm", "--filter", "@stateaction/jobs", "test:integration"],
        )
        self.assertLess(ids.index("render-cli"), ids.index(controller["id"]))
        self.assertLess(ids.index("python-sync"), ids.index(controller["id"]))
        self.assertLess(ids.index("server-tooling"), ids.index(controller["id"]))
        self.assertTrue(spec["unautomated"])


if __name__ == "__main__":
    unittest.main()
