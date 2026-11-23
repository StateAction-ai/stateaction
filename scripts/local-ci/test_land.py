"""SA-127 tests for `land.py`: a throwaway bare remote and clones, a fake gate/merge/PR API.
No real gate, GitHub, lane or credential is used."""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
from contextlib import contextmanager
from pathlib import Path

os.environ["FLOWLOG"] = "off"  # never write the real flow database from a test
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import land  # noqa: E402
import local_ci  # noqa: E402

GITHUB_REPO = "timothywangdev/stateaction"
BR = "wanghujie/sa-1-feat"
os.environ.update(
    GIT_AUTHOR_NAME="t",
    GIT_AUTHOR_EMAIL="t@example.com",
    GIT_COMMITTER_NAME="t",
    GIT_COMMITTER_EMAIL="t@example.com",
    GIT_CONFIG_GLOBAL="/dev/null",
    GIT_CONFIG_SYSTEM="/dev/null",
)


def sh(cwd: Path, *args: str) -> str:
    return subprocess.run(
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class Bench:
    def __init__(self, test: unittest.TestCase):
        self.tmp = Path(tempfile.mkdtemp(prefix="sa127-"))
        test.addCleanup(subprocess.run, ["rm", "-rf", str(self.tmp)])
        self.remote = self.tmp / "remote.git"
        self.remote.mkdir()
        sh(self.remote, "init", "--bare", "-b", "main")
        self.seed = self.tmp / "seed"
        self.work = self.tmp / "work"
        self.home = self.tmp / "home"
        sh(self.tmp, "clone", str(self.remote), "seed")
        (self.seed / "a.txt").write_text("a\nb\nc\n")
        sh(self.seed, "add", "-A")
        sh(self.seed, "commit", "-m", "base")
        sh(self.seed, "push", "origin", "HEAD:main")
        sh(self.tmp, "clone", str(self.remote), "work")
        sh(self.work, "checkout", "-b", BR)
        (self.work / "f.txt").write_text("feature\n")
        sh(self.work, "add", "-A")
        sh(self.work, "commit", "-m", "SA-1: feature")
        sh(self.work, "push", "origin", BR)
        self.events: list[str] = []
        self.pr_state = "open"
        self.merge_sha = None
        self.lock_held = False
        self.gate_verdict = "PASS"
        self.on_gate = None
        self.pr_branch = BR
        self.policy = lambda pr: self.events.append("policy") or "SA-1"
        self.auth = contextlib.nullcontext
        self.reexec = None

    def advance_main(self, name="m.txt", text="main\n"):
        (self.seed / name).write_text(text)
        sh(self.seed, "add", "-A")
        sh(self.seed, "commit", "-m", "main moves")
        sh(self.seed, "push", "origin", "HEAD:main")

    def remote_head(self, branch=BR):
        return sh(self.work, "ls-remote", "origin", f"refs/heads/{branch}").split()[0]

    def pr(self, branch=BR, repo=GITHUB_REPO):
        return {
            "state": self.pr_state,
            "draft": False,
            "branch": branch,
            "head": self.remote_head(BR),
            "headRepo": repo,
            "author": "timothywangdev",
            "base": "main",
            "mergeSha": self.merge_sha,
        }

    def run(self, **overrides):
        def fetch():
            self.events.append("fetch")
            sh(
                self.work,
                "fetch",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
            )
            return sh(self.work, "rev-parse", "refs/remotes/origin/main")

        def rebase():
            self.events.append("rebase")
            land.rebase_onto_main(self.work)

        def push(branch, expected):
            self.events.append("push")
            land.push_with_lease(self.work, None, branch, expected)

        def gate():
            self.events.append("gate")
            if self.on_gate:
                self.on_gate()
            stage = {"id": "s1", "status": "passed", "durationSec": 1.5}
            bad = {"id": "s2", "status": "failed", "durationSec": 2.0}
            return {
                "verdict": self.gate_verdict,
                "stages": [stage] if self.gate_verdict == "PASS" else [stage, bad],
                "logDir": "/logs/run",
                "wallSec": 4.0,
                "totalDurationSec": 3.5,
                "receipt": "/receipts/t.json" if self.gate_verdict == "PASS" else None,
            }

        def merge():
            self.events.append("merge" + ("+lock" if self.lock_held else ""))
            self.pr_state = "merged"
            self.merge_sha = "f" * 40

        @contextmanager
        def lock():
            self.lock_held = True
            self.events.append("lock")
            try:
                yield
            finally:
                self.lock_held = False

        args = dict(
            github_repo=GITHUB_REPO,
            home=self.home,
            fetch_pr=lambda: self.pr(self.pr_branch),
            policy=lambda pr: self.policy(pr),
            auth=self.auth,
            identity=lambda: None,
            submodules=lambda: [],
            origin_check=lambda: True,
            fetch=fetch,
            rebase=rebase,
            push=push,
            gate=gate,
            merge=merge,
            lock=lock,
            sleep=lambda _s: None,
            log=lambda _m: None,
        )
        if self.reexec:
            args["reexec"] = self.reexec
        args.update(overrides)
        return land.land(self.work, 7, **args)


class LandTests(unittest.TestCase):
    def test_current_base_gates_then_merges_under_lock(self):
        b = Bench(self)
        code, res = b.run()
        self.assertEqual(code, 0, res)
        self.assertEqual(res["status"], "merged")
        self.assertEqual(res["mergedSha"], "f" * 40)
        self.assertEqual(res["attempts"], 1)
        self.assertFalse(res["rebased"])
        self.assertEqual(res["gate"]["stageSec"], {"s1": 1.5})
        self.assertEqual(res["receipt"], "/receipts/t.json")
        self.assertEqual(
            b.events, ["policy", "fetch", "gate", "lock", "fetch", "merge+lock"]
        )
        stored = json.loads((b.home / "land" / "pr-7.json").read_text())
        self.assertEqual(stored["mergedSha"], "f" * 40)
        self.assertTrue((b.home / "land" / f"{res['key']}.json").exists())

    def test_stale_base_is_rebased_pushed_then_gated_then_merged(self):
        b = Bench(self)
        old = b.remote_head()
        b.advance_main()
        code, res = b.run()
        self.assertEqual(code, 0, res)
        self.assertTrue(res["rebased"])
        self.assertEqual(b.events[:5], ["policy", "fetch", "rebase", "push", "gate"])
        self.assertLess(b.events.index("push"), b.events.index("gate"))
        self.assertLess(b.events.index("gate"), b.events.index("merge+lock"))
        self.assertNotEqual(b.remote_head(), old)
        self.assertEqual(
            sh(b.work, "rev-parse", "HEAD^"), sh(b.work, "rev-parse", "origin/main")
        )
        self.assertEqual(sh(b.work, "rev-parse", "HEAD"), b.remote_head())

    def test_conflict_stops_with_reason_and_pushes_nothing(self):
        b = Bench(self)
        sh(b.work, "checkout", "-q", "-B", BR, f"origin/{BR}")
        (b.work / "a.txt").write_text("a\nFEATURE\nc\n")
        sh(b.work, "commit", "-qam", "SA-1: edit a")
        sh(b.work, "push", "-q", "-f", "origin", BR)
        (b.seed / "a.txt").write_text("a\nMAIN\nc\n")
        sh(b.seed, "commit", "-qam", "main edits a")
        sh(b.seed, "push", "origin", "HEAD:main")
        before = b.remote_head()
        # make the PR a single commit above the OLD base so only the rebase conflicts
        sh(b.work, "reset", "-q", "--soft", "HEAD~1")
        sh(b.work, "commit", "-q", "--amend", "-m", "SA-1: feature+a")
        sh(b.work, "push", "-q", "-f", "origin", BR)
        before = b.remote_head()
        code, res = b.run()
        self.assertEqual((code, res["reason"]), (7, "rebase_conflict"))
        self.assertEqual(b.remote_head(), before)
        self.assertNotIn("push", b.events)
        self.assertNotIn("gate", b.events)
        self.assertEqual(
            sh(b.work, "status", "--porcelain", "--untracked-files=no"), ""
        )
        self.assertEqual(sh(b.work, "rev-parse", "HEAD"), before)

    def test_foreign_branch_and_repo_refused_before_any_git_change(self):
        b = Bench(self)
        code, res = b.run(fetch_pr=lambda: b.pr(branch="someone-else"))
        self.assertEqual((code, res["reason"]), (land.EXIT_REFUSED, "foreign_branch"))
        code, res = b.run(fetch_pr=lambda: b.pr(repo="fork-owner/stateaction"))
        self.assertEqual((code, res["reason"]), (land.EXIT_REFUSED, "foreign_branch"))
        code, res = b.run(fetch_pr=lambda: {**b.pr(), "author": "someone"})
        self.assertEqual((code, res["reason"]), (land.EXIT_REFUSED, "foreign_branch"))
        self.assertEqual(b.events, [])

    def test_gate_failure_returns_stage_and_log_and_never_merges(self):
        b = Bench(self)
        b.gate_verdict = "FAIL"
        code, res = b.run()
        self.assertEqual(code, land.EXIT_GATE_FAILED)
        self.assertEqual(res["status"], "gate_failed")
        self.assertEqual(res["gate"]["failedStage"], "s2")
        self.assertEqual(res["gate"]["failedStageLog"], "/logs/run/s2.log")
        self.assertEqual(b.events, ["policy", "fetch", "gate"])
        self.assertEqual(res["attempts"], 1)

    def test_a_skipped_stage_is_never_the_reported_failed_stage(self):
        summary = land.gate_summary(
            {
                "verdict": "FAIL",
                "stages": [
                    {"id": "setup", "status": "passed", "durationSec": 1},
                    {"id": "mobile", "status": "skipped", "durationSec": 0},
                    {"id": "static", "status": "failed", "durationSec": 2},
                ],
                "logDir": "/logs/run",
            }
        )
        self.assertEqual(summary["failedStage"], "static")

    def test_main_moving_during_gate_regates_after_rebase_inside_ticket(self):
        b = Bench(self)
        moved = []

        def move_once():
            if not moved:
                moved.append(1)
                b.advance_main("late.txt", "late\n")

        b.on_gate = move_once
        code, res = b.run()
        self.assertEqual(code, 0, res)
        self.assertEqual(res["attempts"], 2)
        self.assertEqual(b.events.count("gate"), 2)
        self.assertEqual(b.events.count("merge+lock"), 1)
        self.assertEqual(b.events.index("merge+lock"), len(b.events) - 1)

    def test_resubmit_after_merge_returns_stored_result_without_work(self):
        b = Bench(self)
        code, first = b.run()
        self.assertEqual(code, 0)
        b.events.clear()
        code, again = b.run()
        self.assertEqual(code, 0)
        self.assertTrue(again["resubmitted"])
        self.assertEqual(again["mergedSha"], first["mergedSha"])
        self.assertEqual(b.events, [])

    def test_multi_commit_pr_refused(self):
        b = Bench(self)
        (b.work / "g.txt").write_text("g\n")
        sh(b.work, "add", "-A")
        sh(b.work, "commit", "-qm", "second")
        sh(b.work, "push", "-q", "origin", BR)
        code, res = b.run()
        self.assertEqual(
            (code, res["reason"]), (land.EXIT_REFUSED, "not_single_commit")
        )

    def test_policy_error_fails_fast_before_rebase_push_or_gate(self):
        b = Bench(self)
        b.advance_main()

        def bad(pr):
            raise land.github_policy.PolicyError("bad title")

        b.policy = bad
        code, res = b.run()
        self.assertEqual((code, res["reason"]), (4, "policy"))
        self.assertEqual(b.events, [])
        self.assertTrue((b.home / "land" / "pr-7.json").exists())

    def test_foreign_ticket_branch_pattern_refused(self):
        b = Bench(self)
        sh(b.work, "branch", "-m", BR, "other/sa-1-feat")
        code, res = b.run(fetch_pr=lambda: {**b.pr(), "branch": "other/sa-1-feat"})
        self.assertEqual((code, res["reason"]), (2, "foreign_branch"))

    def test_closed_during_gate_never_merges_and_exits_9(self):
        b = Bench(self)
        b.on_gate = lambda: setattr(b, "pr_state", "closed")
        code, res = b.run()
        self.assertEqual((code, res["reason"]), (9, "pr_closed"))
        self.assertNotIn("merge+lock", b.events)

    def test_failed_gh_merge_and_unexpected_errors_get_result_and_codes(self):
        b = Bench(self)

        def boom():
            raise subprocess.CalledProcessError(1, ["gh", "pr", "merge"])

        code, res = b.run(merge=boom)
        self.assertEqual((code, res["reason"]), (5, "merge_failed"))
        self.assertTrue((b.home / "land" / "pr-7.json").exists())
        b2 = Bench(self)
        code, res = b2.run(gate=lambda: 1 / 0)
        self.assertEqual((code, res["reason"]), (10, "ZeroDivisionError"))

    def test_fatal_merged_on_untested_base_is_stored_and_never_downgraded(self):
        b = Bench(self)

        def fatal():
            raise land.local_ci.MergedOnUntestedBase("wrong parent")

        code, res = b.run(merge=fatal)
        self.assertEqual((code, res["status"]), (3, "fatal"))
        b.pr_state, b.merge_sha = "merged", "e" * 40
        code, again = b.run(verify_merged=lambda pr: True)
        self.assertEqual((code, again["status"]), (3, "fatal"))
        self.assertTrue(again["resubmitted"])

    def test_merged_without_stored_result_needs_receipt_proof(self):
        b = Bench(self)
        b.pr_state, b.merge_sha = "merged", "e" * 40
        code, res = b.run(verify_merged=lambda pr: False)
        self.assertEqual((code, res["status"]), (11, "merged_unverified"))
        code, res = b.run(verify_merged=lambda pr: True)
        self.assertEqual(code, 0)

    def test_push_failure_restores_local_branch_and_reports(self):
        b = Bench(self)
        b.advance_main()
        old = sh(b.work, "rev-parse", "HEAD")

        def bad_push(branch, expected):
            raise land.Refused("lease stale")

        code, res = b.run(push=bad_push)
        self.assertEqual((code, res["reason"]), (8, "push_failed"))
        self.assertEqual(sh(b.work, "rev-parse", "HEAD"), old)
        self.assertNotIn("gate", b.events)

    def test_patch_change_by_clean_rebase_needs_review_and_pushes_nothing(self):
        b = Bench(self)
        sh(b.work, "checkout", "-q", "-B", BR, f"origin/{BR}~0")
        (b.work / "a.txt").write_text("a\nb\nFEATURE\n")
        sh(b.work, "commit", "-qam", "SA-1: edit tail")
        sh(b.work, "reset", "-q", "--soft", "origin/main")
        sh(b.work, "commit", "-qm", "SA-1: edit tail only")
        sh(b.work, "push", "-q", "-f", "origin", BR)
        (b.seed / "a.txt").write_text("A\nb\nc\n")  # clean merge, new context
        sh(b.seed, "commit", "-qam", "main edits context")
        sh(b.seed, "push", "origin", "HEAD:main")
        before = b.remote_head()
        old = sh(b.work, "rev-parse", "HEAD")
        code, res = b.run()
        self.assertEqual((code, res["reason"]), (6, "needs_review"))
        self.assertEqual(b.remote_head(), before)
        self.assertEqual(sh(b.work, "rev-parse", "HEAD"), old)
        self.assertNotIn("gate", b.events)

    def test_changed_runner_after_rebase_reexecs_and_does_not_gate_in_process(self):
        b = Bench(self)
        (b.seed / "scripts" / "local-ci").mkdir(parents=True)
        (b.seed / "scripts" / "local-ci" / "land.py").write_text("new runner\n")
        sh(b.seed, "add", "-A")
        sh(b.seed, "commit", "-m", "runner changes")
        sh(b.seed, "push", "origin", "HEAD:main")
        called = []
        code, res = b.run(reexec=lambda: called.append(os.environ.get(land.STATE_ENV)))
        self.assertEqual(called and json.loads(called[0])["rebased"], True)
        self.assertEqual(res["reason"], "runner_changed")
        self.assertNotIn("gate", b.events)

    def test_askpass_answers_only_github_prompts_and_token_is_never_a_file(self):
        calls = []

        def fake_run(argv, **kw):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout="timothywangdev\n")

        with land.github_auth("SECRETTOKEN", run=fake_run) as env:
            askpass = env["GIT_ASKPASS"]
            fd = int(env["STATEACTION_LAND_TOKEN_FD"])

            def ask(prompt):
                return subprocess.run(
                    [askpass, prompt],
                    env=env,
                    pass_fds=[fd],
                    capture_output=True,
                    text=True,
                )

            self.assertEqual(
                ask("Username for 'https://github.com': ").stdout.strip(),
                "x-access-token",
            )
            self.assertEqual(
                ask("Password for 'https://x-access-token@github.com': ").stdout,
                "SECRETTOKEN",
            )
            for bad in (
                "Password for 'https://x-access-token@evil.example': ",
                "Username for 'https://github.com.evil.example': ",
                "Password for 'https://github.com@evil': ",
            ):
                got = ask(bad)
                self.assertNotEqual(got.returncode, 0, bad)
                self.assertNotIn("SECRETTOKEN", got.stdout)
            directory = Path(askpass).parent
            for f in directory.iterdir():
                self.assertNotIn("SECRETTOKEN", f.read_text())
            for name in ("GIT_TRACE", "GIT_CURL_VERBOSE"):
                self.assertNotIn(name, env)
        self.assertFalse(directory.exists())

    def test_origin_fails_closed_on_lookalikes_ssh_and_other_repos(self):
        ok = (
            "https://github.com/timothywangdev/stateaction",
            "https://github.com/timothywangdev/stateaction.git",
        )
        for url in ok:
            self.assertTrue(land.origin_allowed(url, GITHUB_REPO))
        for url in (
            "git@github.com:timothywangdev/stateaction.git",
            "ssh://git@github.com/timothywangdev/stateaction",
            "https://github.com.evil.example/timothywangdev/stateaction",
            "https://evil.example/github.com/timothywangdev/stateaction",
            "https://github.com/timothywangdev/stateaction-fork",
            "https://github.com/other/stateaction",
            "/tmp/x/timothywangdev/stateaction",
            "https://user:pw@github.com/timothywangdev/stateaction",
            "",
        ):
            self.assertFalse(land.origin_allowed(url, GITHUB_REPO), url)
        b = Bench(self)
        self.assertFalse(land.strict_origin(b.work, GITHUB_REPO))  # a local path remote
        sh(
            b.work,
            "remote",
            "set-url",
            "origin",
            "https://github.com/timothywangdev/stateaction.git",
        )
        self.assertTrue(land.strict_origin(b.work, GITHUB_REPO))
        sh(
            b.work,
            "remote",
            "set-url",
            "--push",
            "origin",
            "https://github.com.evil.example/x/y",
        )
        self.assertFalse(land.strict_origin(b.work, GITHUB_REPO))
        b2 = Bench(self)
        code, res = b2.run(origin_check=lambda: False)
        self.assertEqual((code, res["reason"]), (2, "foreign_origin"))
        self.assertEqual(b2.events, [])

    def test_reexec_happens_after_auth_cleanup_and_leaves_no_token_dir(self):
        b = Bench(self)
        (b.seed / "scripts" / "local-ci").mkdir(parents=True)
        (b.seed / "scripts" / "local-ci" / "land.py").write_text("new runner\n")
        sh(b.seed, "add", "-A")
        sh(b.seed, "commit", "-m", "runner changes")
        sh(b.seed, "push", "origin", "HEAD:main")
        seen = {}

        def runs(a, **k):
            return subprocess.CompletedProcess(a, 0, stdout="timothywangdev\n")

        def auth():
            ctx = land.github_auth("TOK", run=runs)
            return ctx

        orig = land.github_auth
        dirs = []

        @contextlib.contextmanager
        def tracking():
            with orig("TOK", run=runs) as env:
                dirs.append(Path(env["GIT_ASKPASS"]).parent)
                yield env

        code, res = b.run(
            auth=tracking, reexec=lambda: seen.update(gone=not dirs[0].exists())
        )
        self.assertTrue(seen.get("gone"), "auth dir must be removed before exec")
        self.assertEqual(res["reason"], "runner_changed")

    def test_interrupt_writes_result_and_cleans_auth(self):
        b = Bench(self)
        dirs = []

        def runs(a, **k):
            return subprocess.CompletedProcess(a, 0, stdout="timothywangdev\n")

        @contextlib.contextmanager
        def tracking():
            with land.github_auth("TOK", run=runs) as env:
                dirs.append(Path(env["GIT_ASKPASS"]).parent)
                yield env

        def term():
            raise SystemExit(143)

        with self.assertRaises(SystemExit):
            b.run(auth=tracking, gate=term)
        self.assertFalse(dirs[0].exists())
        stored = json.loads((b.home / "land" / "pr-7.json").read_text())
        self.assertEqual((stored["status"], stored["exit"]), ("interrupted", 12))

    def test_stale_auth_dirs_are_swept(self):
        base = Path(tempfile.mkdtemp())
        self.addCleanup(subprocess.run, ["rm", "-rf", str(base)])
        old = base / "land-auth-old"
        fresh = base / "land-auth-new"
        old.mkdir()
        fresh.mkdir()
        land.sweep_stale_auth(base, now=time.time() + 4 * 3600)
        self.assertFalse(old.exists() and fresh.exists())
        land.sweep_stale_auth(base, now=time.time())
        # a fresh dir (mtime now) survives a sweep at "now"
        keep = base / "land-auth-keep"
        keep.mkdir()
        land.sweep_stale_auth(base, now=time.time())
        self.assertTrue(keep.exists())

    def test_worktree_ownership_is_real(self):
        b = Bench(self)
        self.assertTrue(land.worktree_owns_branch(b.work, BR))
        self.assertFalse(land.worktree_owns_branch(b.work, "wanghujie/sa-9-other"))
        sh(b.work, "checkout", "-q", "--detach")
        self.assertFalse(land.worktree_owns_branch(b.work, BR))
        code, res = b.run()  # detached HEAD is refused before any work
        self.assertEqual((code, res["reason"]), (2, "foreign_branch"))
        self.assertEqual(b.events, [])

    def test_expected_head_must_match_the_pr_head(self):
        b = Bench(self)
        code, res = b.run(expected_head="0" * 40)
        self.assertEqual((code, res["reason"]), (2, "head_mismatch"))
        self.assertEqual(b.events, [])

    def test_attempts_are_bounded_across_reexecs(self):
        b = Bench(self)
        os.environ[land.STATE_ENV] = json.dumps(
            {
                "initialHead": sh(b.work, "rev-parse", "HEAD"),
                "attempts": 4,
                "rebased": True,
            }
        )
        self.addCleanup(os.environ.pop, land.STATE_ENV, None)
        code, res = b.run()
        self.assertEqual((code, res["reason"]), (2, "base_moved"))
        self.assertNotIn("gate", b.events)

    def test_non_merge_called_process_error_is_not_labelled_merge_failed(self):
        b = Bench(self)

        def boom():
            raise subprocess.CalledProcessError(1, ["git", "diff-tree"])

        code, res = b.run(gate=boom)
        self.assertEqual((code, res["reason"]), (10, "error"))

    def test_lagging_get_after_merge_is_not_a_fatal(self):
        b = Bench(self)
        seen = {"n": 0}
        real = b.pr

        def lagging():
            if b.pr_state == "merged":
                seen["n"] += 1
                if seen["n"] < 3:
                    return {**real(), "state": "open", "mergeSha": None}
            return real()

        code, res = b.run(fetch_pr=lagging)
        self.assertEqual((code, res["status"]), (0, "merged"))

    def test_wrong_default_gh_account_refused_before_anything(self):
        b = Bench(self)
        code, res = b.run(identity=lambda: "timothy-web3-dev")
        self.assertEqual((code, res["reason"]), (2, "identity"))
        self.assertEqual(b.events, [])


class FakeGh:
    """Stands in for subprocess.run: `gh api user` answers by token, `gh auth token` from a map."""

    def __init__(self, keyring: str | None, logins: dict[str, str]):
        self.keyring, self.logins, self.calls = keyring, logins, []

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        if argv[:3] == ["gh", "auth", "token"]:
            out = (self.keyring or "") + "\n"
            return subprocess.CompletedProcess(argv, 0 if self.keyring else 1, out, "")
        who = self.logins.get(kw["env"].get("GH_TOKEN", ""), "")
        return subprocess.CompletedProcess(argv, 0 if who else 1, who + "\n", "")


class IdentityTest(unittest.TestCase):
    def test_resolves_owner_token_with_no_env_and_exports_it(self):
        env: dict = {}
        gh = FakeGh("owner-tok", {"owner-tok": "timothywangdev"})
        token = local_ci.resolve_owner_credential(run=gh, environ=env)
        self.assertEqual((token, env["GH_TOKEN"]), ("owner-tok", "owner-tok"))

    def test_wrong_account_in_env_falls_back_to_the_owner_keyring_token(self):
        env = {"GH_TOKEN": "other-tok"}
        gh = FakeGh(
            "owner-tok",
            {"owner-tok": "timothywangdev", "other-tok": "timothy-web3-dev"},
        )
        local_ci.resolve_owner_credential(run=gh, environ=env)
        self.assertEqual(env["GH_TOKEN"], "owner-tok")

    def test_correct_env_token_is_kept_without_touching_the_keyring(self):
        env = {"GH_TOKEN": "owner-tok"}
        gh = FakeGh(None, {"owner-tok": "timothywangdev"})
        local_ci.resolve_owner_credential(run=gh, environ=env)
        self.assertFalse(any(c[:3] == ["gh", "auth", "token"] for c in gh.calls))

    def test_missing_credential_names_the_fix(self):
        with self.assertRaises(local_ci.Refused) as ctx:
            local_ci.resolve_owner_credential(run=FakeGh(None, {}), environ={})
        self.assertIn("gh auth login", str(ctx.exception))

    def test_keyring_token_of_another_account_is_refused(self):
        gh = FakeGh("tok", {"tok": "someone-else"})
        with self.assertRaises(local_ci.Refused) as ctx:
            local_ci.resolve_owner_credential(run=gh, environ={})
        self.assertIn("someone-else", str(ctx.exception))

    def test_unusable_gh_binary_names_the_fix(self):
        def missing(*_a, **_k):
            raise FileNotFoundError("gh")

        with self.assertRaises(local_ci.Refused) as ctx:
            local_ci.resolve_owner_credential(run=missing, environ={})
        self.assertIn("gh auth login", str(ctx.exception))

    def test_replacing_a_wrong_env_token_is_announced(self):
        said = []
        gh = FakeGh(
            "owner-tok", {"owner-tok": "timothywangdev", "o": "timothy-web3-dev"}
        )
        local_ci.resolve_owner_credential(
            run=gh, environ={"GH_TOKEN": "o"}, say=said.append
        )
        self.assertEqual(len(said), 1)
        self.assertIn("timothy-web3-dev", said[0])

    def test_default_identity_returns_the_problem_text(self):
        with unittest.mock.patch.object(
            local_ci, "resolve_owner_credential", side_effect=local_ci.Refused("fix it")
        ):
            self.assertEqual(land.default_identity(), "fix it")
        with unittest.mock.patch.object(local_ci, "resolve_owner_credential"):
            self.assertIsNone(land.default_identity())


class SubmoduleSourceTest(unittest.TestCase):
    """A fresh worktree with no environment finds the pinned stera-sdk in another checkout."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sa130-sub-"))
        self.addCleanup(subprocess.run, ["rm", "-rf", str(self.tmp)])
        self._env = {
            k: os.environ.pop(k)
            for k in ("STATEACTION_LOCAL_CI_SUBMODULES",)
            if k in os.environ
        }
        self.addCleanup(os.environ.update, self._env)
        sub = self.tmp / "sub"
        sub.mkdir()
        sh(sub, "init", "-b", "main")
        (sub / "f").write_text("x")
        sh(sub, "add", "f")
        sh(sub, "commit", "-m", "s")
        self.sha = sh(sub, "rev-parse", "HEAD")
        self.main = self.tmp / "main"
        self.main.mkdir()
        sh(self.main, "init", "-b", "main")
        sh(self.main, "commit", "--allow-empty", "-m", "root")
        sh(
            self.main,
            "update-index",
            "--add",
            "--cacheinfo",
            f"160000,{self.sha},stera-sdk",
        )
        sh(self.main, "commit", "-m", "pin")
        self.sub = sub
        self.worktree = self.tmp / "wt"
        sh(self.main, "worktree", "add", "-b", "feat", str(self.worktree))

    def test_missing_everywhere_names_both_fixes(self):
        problems = local_ci.missing_submodules(self.worktree, "HEAD^{tree}")
        self.assertEqual(len(problems), 1)
        self.assertIn("git submodule update --init stera-sdk", problems[0])
        self.assertIn("STATEACTION_LOCAL_CI_SUBMODULES", problems[0])

    def test_found_in_the_main_checkout_without_any_env(self):
        subprocess.run(
            ["git", "clone", "-q", str(self.sub), str(self.main / "stera-sdk")],
            check=True,
        )
        self.assertEqual(local_ci.missing_submodules(self.worktree, "HEAD^{tree}"), [])
        out = self.tmp / "export"
        out.mkdir()
        self.assertTrue(
            local_ci.export_submodule(self.worktree, "stera-sdk", self.sha, out)
        )
        self.assertEqual((out / "stera-sdk" / "f").read_text(), "x")

    def test_land_refuses_with_reason_submodule_before_anything(self):
        b = Bench(self)
        code, res = b.run(submodules=lambda: ["submodule stera-sdk missing"])
        self.assertEqual((code, res["reason"]), (2, "submodule"))
        self.assertEqual(b.events, [])


if __name__ == "__main__":
    unittest.main()
