#!/usr/bin/env python3
"""SA-127 real-lane proof of `ci:land` (manual, never in the gate).

Two land tickets are queued in one real `ci` lane (isolated agentqueue state, as in
scripts/mobile/e2e_lanes.py) over a temp bare git remote. The gate is a fake 2-second stage and the
merge is a fast-forward push to the temp remote's main. Ticket two starts on a stale base, must be
rebased inside its own ticket, gated, and merge only after ticket one.

  AGENT_RESOURCE_TEST=1 python3 scripts/local-ci/e2e_land.py
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "mobile"))
import land  # noqa: E402

REPO = HERE.parents[1]
os.environ.update(
    GIT_AUTHOR_NAME="e2e",
    GIT_AUTHOR_EMAIL="e2e@example.com",
    GIT_COMMITTER_NAME="e2e",
    GIT_COMMITTER_EMAIL="e2e@example.com",
)


def sh(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def job(
    remote: str,
    branch: str,
    home: str,
    events: str,
    github_repo: str,
    pr: int,
    scenario: str,
) -> int:
    """Runs INSIDE the ci ticket (cwd = clone)."""
    repo = Path.cwd()
    merged = Path(home) / f"{branch.replace('/', '_')}.merged"
    closed = Path(home) / f"{branch.replace('/', '_')}.closed"

    def note(text: str) -> None:
        with open(events, "a") as handle:
            handle.write(f"{time.time():.3f} {branch} {text}\n")

    def fetch_pr() -> dict:
        head = sh(repo, "ls-remote", remote, f"refs/heads/{branch}").split()[0]
        return {
            "state": "merged"
            if merged.exists()
            else "closed"
            if closed.exists()
            else "open",
            "draft": False,
            "branch": branch,
            "author": "timothywangdev",
            "head": head,
            "headRepo": github_repo,
            "base": "main",
            "mergeSha": merged.read_text() if merged.exists() else None,
        }

    def fetch() -> str:
        sh(repo, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main")
        return sh(repo, "rev-parse", "refs/remotes/origin/main")

    def rebase() -> None:
        note("rebase")
        land.rebase_onto_main(repo)

    def gate() -> dict:
        note("gate-start")
        time.sleep(2)
        if scenario == "closed":
            closed.write_text("x")
        note("gate-end")
        return {
            "verdict": "PASS",
            "stages": [{"id": "fake", "status": "passed", "durationSec": 2.0}],
            "logDir": "-",
            "wallSec": 2.0,
            "totalDurationSec": 2.0,
            "receipt": "-",
        }

    def merge() -> None:
        note("merge")
        sh(
            repo, "push", "origin", "HEAD:refs/heads/main"
        )  # fast-forward only: fails if stale
        merged.write_text(sh(repo, "rev-parse", "HEAD"))

    def policy(_pr: dict) -> str:
        note("policy")
        if scenario == "policy":
            raise land.github_policy.PolicyError("bad title")
        return "SA-1"

    real = (
        scenario == "fresh"
    )  # real identity + submodule preflight, no environment at all
    if real:
        for name in (
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "STATEACTION_LOCAL_CI_SUBMODULES",
        ):
            os.environ.pop(name, None)
    code, result = land.land(
        repo,
        pr,
        policy=policy,
        auth=contextlib.nullcontext,
        **({} if real else {"identity": lambda: None, "submodules": lambda: []}),
        origin_check=lambda: True,
        reexec=None,
        github_repo=github_repo,
        home=Path(home),
        fetch_pr=fetch_pr,
        fetch=fetch,
        rebase=rebase,
        push=lambda b, e: (note("push"), land.push_with_lease(repo, None, b, e)),
        gate=gate,
        merge=merge,
        sleep=lambda s: time.sleep(0.1),
    )
    if real:  # what the tool itself resolved, and whether the pinned stera-sdk exports
        result["tokenLogin"] = subprocess.run(
            ["gh", "api", "user", "--jq", ".login"], capture_output=True, text=True
        ).stdout.strip()
        pin = sh(repo, "ls-tree", "HEAD", "stera-sdk").split()[2]
        out = Path(home) / "sdk-export"
        out.mkdir()
        result["sdkExported"] = (
            land.local_ci.export_submodule(repo, "stera-sdk", pin, out)
            and (out / "stera-sdk" / "f").read_text() == "x"
        )
    print(json.dumps(result, sort_keys=True))
    return code


def orchestrate() -> int:
    import e2e_lanes  # noqa: PLC0415  (scripts/mobile, the SA-124 harness)

    bench = e2e_lanes.Bench()
    ok = False
    try:
        t = bench.tmp
        root = bench.roots["rootA"]
        remote = t / "remote.git"
        remote.mkdir()
        sh(remote, "init", "--bare", "-b", "main")
        seed = t / "seed"
        sh(t, "clone", str(remote), "seed")
        (seed / "base.txt").write_text("base\n")
        sh(seed, "add", "-A")
        sh(seed, "commit", "-m", "base")
        sh(seed, "push", "origin", "HEAD:main")
        home, events = t / "home", t / "events.log"
        home.mkdir(mode=0o700)
        home.chmod(0o700)
        sh(
            root, "clone", str(remote), "w0"
        )  # one repository, two worktrees: one shared ci lane
        for n in (1, 2):
            clone = root / f"w{n}"
            sh(
                root / "w0",
                "worktree",
                "add",
                "-b",
                f"wanghujie/sa-{n}-feat",
                str(clone),
                "origin/main",
            )
            (clone / f"f{n}.txt").write_text(f"{n}\n")
            sh(clone, "add", "-A")
            sh(clone, "commit", "-m", f"SA-{n}: change")
            sh(clone, "push", "origin", f"wanghujie/sa-{n}-feat")
        procs = []
        for n in (1, 2):
            proc = subprocess.Popen(
                [
                    sys.executable,
                    str(bench_guard()),
                    "run",
                    "--lane",
                    "ci",
                    "--key",
                    f"land-{n}-{os.getpid()}",
                    "--",
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--job",
                    "--remote",
                    str(remote),
                    "--branch",
                    f"wanghujie/sa-{n}-feat",
                    "--home",
                    str(home),
                    "--events",
                    str(events),
                    "--repo",
                    "timothywangdev/stateaction",
                    "--pr",
                    str(n),
                    "--scenario",
                    "normal",
                ],
                cwd=root / f"w{n}",
                env=bench.env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            bench.procs.append(proc)
            procs.append(proc)
            time.sleep(1.0)  # ticket 1 must hold the lane before ticket 2 is queued
        outs = [p.communicate(timeout=240)[0] for p in procs]
        codes = [p.returncode for p in procs]
        log = [line.split() for line in events.read_text().splitlines()]

        def at(who, what):
            return next(float(t_) for t_, w, x in log if w == who and x == what)

        try:
            results = [
                json.loads([x for x in o.splitlines() if x.startswith("{")][-1])
                for o in outs
            ]
        except (ValueError, IndexError):
            print("job output:", codes, *outs, sep="\n")
            return 1
        main_log = (
            sh(seed, "log", "--format=%s", "origin/main")
            if sh(seed, "fetch", "origin") is not None
            else ""
        )
        checks = {
            "both exit 0": codes == [0, 0],
            "both merged": [r["status"] for r in results] == ["merged", "merged"],
            "ticket 1 not rebased": results[0]["rebased"] is False,
            "ticket 2 rebased inside its ticket": results[1]["rebased"] is True
            and any(w == "wanghujie/sa-2-feat" and x == "rebase" for _, w, x in log),
            "ticket 2 rebase after ticket 1 merge": at("wanghujie/sa-2-feat", "rebase")
            > at("wanghujie/sa-1-feat", "merge"),
            "ticket 2 gate after its rebase": at("wanghujie/sa-2-feat", "gate-start")
            > at("wanghujie/sa-2-feat", "rebase"),
            "ticket 2 merge after ticket 1 merge": at("wanghujie/sa-2-feat", "merge")
            > at("wanghujie/sa-1-feat", "merge"),
            "tickets did not overlap": at("wanghujie/sa-2-feat", "gate-start")
            >= at("wanghujie/sa-1-feat", "merge"),
            "linear history, one commit per PR": main_log.splitlines()
            == ["SA-2: change", "SA-1: change", "base"],
        }

        # failure paths: each a real ticket in the same lane, over the same temp remote
        def extra(
            n: int, scenario: str, prepare=None, committed=None
        ) -> tuple[int, dict, str]:
            clone = root / f"w{n}"
            br = f"wanghujie/sa-{n}-feat"
            sh(root / "w0", "fetch", "origin")
            sh(root / "w0", "worktree", "add", "-b", br, str(clone), "origin/main")
            if prepare:
                prepare(clone)
            else:
                (clone / f"f{n}.txt").write_text(f"{n}\n")
            sh(clone, "add", "-A")
            sh(clone, "commit", "-m", f"SA-{n}: change")
            sh(clone, "push", "origin", br)
            if committed:
                committed(clone)
            if scenario == "needs_review":  # main edits line 1 after the branch was cut
                (seed / "ctx.txt").write_text("A\nb\nc\n")
                sh(seed, "commit", "-qam", "main edits context")
                sh(seed, "push", "origin", "HEAD:main")
            before = sh(clone, "ls-remote", "origin", f"refs/heads/{br}").split()[0]
            p = subprocess.Popen(
                [
                    sys.executable,
                    str(bench_guard()),
                    "run",
                    "--lane",
                    "ci",
                    "--key",
                    f"land-{n}-{os.getpid()}",
                    "--",
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--job",
                    "--remote",
                    str(remote),
                    "--branch",
                    br,
                    "--home",
                    str(home),
                    "--events",
                    str(events),
                    "--repo",
                    "timothywangdev/stateaction",
                    "--pr",
                    str(n),
                    "--scenario",
                    scenario,
                ],
                cwd=clone,
                env=bench.env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            bench.procs.append(p)
            out = p.communicate(timeout=240)[0]
            try:
                res = json.loads([x for x in out.splitlines() if x.startswith("{")][-1])
            except IndexError:
                print("job output:", out, sep="\n")
                raise
            after = sh(clone, "ls-remote", "origin", f"refs/heads/{br}").split()[0]
            return p.returncode, res, f"{before == after}|{out}"

        code3, r3, o3 = extra(3, "policy")
        checks["policy refusal: exit 4, nothing pushed or gated"] = (
            code3 == 4
            and r3["reason"] == "policy"
            and "gate-start"
            not in "".join(
                line for line in events.read_text().splitlines() if "sa-3-feat" in line
            )
        )
        code4, r4, o4 = extra(4, "closed")
        checks["PR closed during the gate: exit 9, never merged"] = (
            code4 == 9
            and r4["reason"] == "pr_closed"
            and not any(
                "sa-4-feat merge" in line for line in events.read_text().splitlines()
            )
        )

        def ctx(clone: Path) -> None:
            (clone / "ctx.txt").write_text("a\nb\nFEATURE\n")

        sh(seed, "pull", "-q", "--ff-only", "origin", "main")
        (seed / "ctx.txt").write_text("a\nb\nc\n")
        sh(seed, "add", "-A")
        sh(seed, "commit", "-qm", "ctx file")
        sh(seed, "push", "origin", "HEAD:main")
        code5, r5, o5 = extra(5, "needs_review", ctx)
        checks[
            "clean rebase that changes the patch: exit 6 needs_review, remote branch untouched, no gate"
        ] = (
            code5 == 6
            and r5["reason"] == "needs_review"
            and o5.startswith("True|")
            and "gate-start"
            not in "".join(
                line for line in events.read_text().splitlines() if "sa-5-feat" in line
            )
        )
        # fresh worktree, no environment: the pinned submodule exists only in the main checkout
        sub = t / "sub"
        sub.mkdir()
        sh(sub, "init", "-b", "main")
        (sub / "f").write_text("x")
        sh(sub, "add", "f")
        sh(sub, "commit", "-m", "s")
        sh(t, "clone", "-q", str(sub), str(root / "w0" / "stera-sdk"))

        def pinned(clone: Path) -> None:
            sh(t, "clone", "-q", str(sub), str(clone / "stera-sdk"))
            (clone / "f6.txt").write_text("6\n")

        def unpopulate(
            clone: Path,
        ) -> None:  # a fresh worktree: gitlink pinned, directory empty
            shutil.rmtree(clone / "stera-sdk")
            (clone / "stera-sdk").mkdir()
            assert not sh(clone, "status", "--porcelain")

        code6, r6, o6 = extra(6, "fresh", pinned, unpopulate)
        checks[
            "fresh worktree, no GH_TOKEN/STATEACTION_LOCAL_CI_SUBMODULES: identity and stera-sdk found by the tool, merged"
        ] = (
            code6 == 0
            and r6["status"] == "merged"
            and r6.get("tokenLogin") == "timothywangdev"
            and r6.get("sdkExported") is True
        )
        for name, passed in checks.items():
            print(f"{'PASS' if passed else 'FAIL'}  {name}")
        ok = all(checks.values())
        if not ok:
            print("\n".join(outs), events.read_text(), sep="\n")
    finally:
        bench.cleanup()
    print("\nALL PASS" if ok else "\nFAILED")
    return 0 if ok else 1


def bench_guard() -> Path:
    return HERE.parent / "mobile" / "resource_guard.py"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", action="store_true")
    parser.add_argument("--remote")
    parser.add_argument("--branch")
    parser.add_argument("--home")
    parser.add_argument("--events")
    parser.add_argument("--repo")
    parser.add_argument("--pr", type=int, default=1)
    parser.add_argument("--scenario", default="normal")
    args = parser.parse_args()
    if args.job:
        return job(
            args.remote,
            args.branch,
            args.home,
            args.events,
            args.repo,
            args.pr,
            args.scenario,
        )
    if os.environ.get("AGENT_RESOURCE_TEST") != "1":
        print("set AGENT_RESOURCE_TEST=1 (enables the isolated roots/state test hooks)")
        return 2
    return orchestrate()


if __name__ == "__main__":
    raise SystemExit(main())
