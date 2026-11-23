#!/usr/bin/env python3
"""SA-124 real end-to-end proof of the lane queue on this machine (manual, never in the gate).

Runs the repository copy of resource_guard.py against real systemd user units and the pinned
agentqueue binary, with an isolated agentqueue state dir. Two scratch directories act as two
registered project roots and a third as a foreign (unregistered) root. Jobs are `sleep`-sized.
It never installs the guard, never touches other projects' units, and removes only what it made.

  AGENT_RESOURCE_TEST=1 python3 scripts/mobile/e2e_lanes.py [--evidence FILE]
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
GUARD = HERE / "resource_guard.py"
results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)


def snippet(marker: Path, seconds: float) -> list[str]:
    code = (
        "import os,time,pathlib;m=pathlib.Path(%r);"
        "m.write_text(str(time.time())+' '+open('/proc/self/cgroup').read().strip()+'\\n');"
        "time.sleep(%r);"
        "m.with_suffix('.end').write_text(str(time.time()))"
    ) % (str(marker), seconds)
    return [sys.executable, "-c", code]


class Bench:
    def __init__(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="sa124-e2e-")).resolve()
        self.state = Path(
            f"/run/user/{os.getuid()}/agent-resource-guard/e2e-{os.getpid()}"
        )
        self.roots = {n: self.tmp / n for n in ("rootA", "rootB", "foreign")}
        for r in self.roots.values():
            r.mkdir()
        self.env = {
            **os.environ,
            "AGENT_RESOURCE_TEST": "1",
            "AGENT_RESOURCE_STATE_DIR": str(self.state),
            "AGENT_RESOURCE_PROJECT_ROOTS": os.pathsep.join(
                str(self.roots[n]) for n in ("rootA", "rootB")
            ),
        }
        self.env.pop("STATEACTION_LANE_HELD", None)
        self.procs: list[subprocess.Popen] = []

    def guard(self, root: str, *argv: str, env=None) -> subprocess.Popen:
        proc = subprocess.Popen(
            [sys.executable, str(GUARD), *argv],
            cwd=self.roots[root],
            env=env or self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            # A harness started in the background has SIGINT ignored, and children inherit
            # that, which makes case 5 (Ctrl-C detaches the client) meaningless: restore it.
            preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL),
        )
        self.procs.append(proc)
        return proc

    def wait_file(self, path: Path, timeout: float) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if path.exists() and path.read_text().strip():
                return True
            time.sleep(0.1)
        return False

    def cleanup(self) -> None:
        for p in self.procs:
            if p.poll() is None:
                p.terminate()
        time.sleep(0.5)
        shutil.rmtree(self.state, ignore_errors=True)
        sys.path.insert(0, str(HERE))
        import resource_guard as g  # noqa: PLC0415

        base = g.runtime_dir() / "agentqueue"
        for manifest in base.glob("*.lanes.toml"):
            if str(self.tmp) in manifest.read_text():
                manifest.unlink()
        shutil.rmtree(self.tmp, ignore_errors=True)


def started(path: Path) -> float:
    return float(path.read_text().split()[0])


def ended(path: Path) -> float:
    return float(path.with_suffix(".end").read_text())


def lane_pid(marker: Path) -> int | None:
    """Exactly the lane-job wrapper process whose command line carries this marker."""
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                cmd = (entry / "cmdline").read_bytes().decode(errors="replace")
            except OSError:
                continue
            if "lane-job" in cmd and str(marker) in cmd:
                return int(entry.name)
    return None


def run(bench: Bench) -> None:
    t = bench.tmp
    # 1. eight Free commands never wait while a ci ticket is running
    hold = t / "s1-ci"
    ci = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(hold, 20))
    assert bench.wait_file(hold, 30), "ci ticket never started"
    free = []
    begin = time.time()
    for i in range(8):
        marker = t / f"s1-free{i}"
        free.append((marker, bench.guard("rootA", "run", "--", *snippet(marker, 1))))
    for _, proc in free:
        proc.wait(timeout=60)
    waits = [started(m) - begin for m, _ in free]
    codes = [p.returncode for _, p in free]
    cgs = {m.read_text().split()[1] for m, _ in free}
    ok = (
        all(c == 0 for c in codes)
        and max(waits) < 8
        and all("agent-work-free.slice" in c for c in cgs)
        and "agent-lane-ci-" in hold.read_text()
        and ci.poll() is None
    )
    record(
        "1 eight Free commands run while a ci ticket holds its lane",
        ok,
        f"rc={codes} max start delay {max(waits):.1f}s; ci still running={ci.poll() is None}",
    )
    ci.wait(timeout=60)

    # 2. two repositories' ci tickets: the reservation is machine-wide and sized to the cap
    for cap, want_overlap in ((24, True), (12, False)):
        env = {**bench.env, "AGENT_RESOURCE_TEST_CAP_GIB": str(cap)}
        a, b = t / f"s2-{cap}-a", t / f"s2-{cap}-b"
        pa = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(a, 4), env=env)
        time.sleep(0.5)
        pb = bench.guard("rootB", "run", "--lane", "ci", "--", *snippet(b, 4), env=env)
        pa.wait(timeout=90)
        pb.wait(timeout=90)
        overlap = min(ended(a), ended(b)) - max(started(a), started(b))
        ok = (
            pa.returncode == 0
            and pb.returncode == 0
            and ((overlap > 2) == want_overlap)
        )
        record(
            f"2 two repositories' ci tickets with a {cap} GiB cap "
            + (
                "both run at once"
                if want_overlap
                else "wait on the machine-wide reservation"
            ),
            ok,
            f"overlap {overlap:.1f}s rc={pa.returncode},{pb.returncode}",
        )

    # 3. FIFO with 5 queued tickets, with Free traffic meanwhile
    markers = [t / f"s3-{i}" for i in range(5)]
    tickets = []
    for m in markers:
        tickets.append(
            bench.guard(
                "rootA",
                "run",
                "--lane",
                "ci",
                "--",
                *snippet(m, 4),
                env={**bench.env, "AGENT_RESOURCE_TEST_CAP_GIB": "24"},
            )
        )
        time.sleep(0.5)
    stream = 0
    while any(p.poll() is None for p in tickets) and stream < 400:
        for p in [
            bench.guard("rootA", "run", "--", sys.executable, "-c", "pass")
            for _ in range(3)
        ]:
            p.wait(timeout=30)
        stream += 3
    starts = [started(m) for m in markers]
    ends = [ended(m) for m in markers]
    in_order = starts == sorted(starts)
    sys.path.insert(0, str(HERE))
    # At the 12 GiB boot cap (or with other apps using memory) the reservation budget admits one.
    import tomllib  # noqa: PLC0415

    import resource_guard as guard  # noqa: PLC0415

    slots = tomllib.loads((REPO / "config/agentqueue/lanes.toml").read_text())["lanes"][
        "ci"
    ]["slots"]
    # SA-135: memory alone decides; the slot count is a ceiling. The reservation budget admits
    # two 6 GiB jobs at a cap of 22 GiB or more, one below, so a third ticket always waits.
    expected_peak = min(slots, guard.lane_budget(24 * guard.GIB) // guard.JOB_MAX)
    peak = max(
        sum(1 for j in range(5) if starts[j] <= starts[i] < ends[j] - 0.05)
        for i in range(5)
    )
    serial = peak <= slots
    scopes = {m: m.read_text().split()[1].rsplit("/", 1)[-1] for m in markers}
    clash = any(
        scopes[markers[i]] == scopes[markers[j]]
        and starts[j] < ends[i] - 0.05
        and starts[i] < ends[j] - 0.05
        for i in range(5)
        for j in range(i + 1, 5)
    )
    record(
        "3 five queued ci tickets run FIFO, as many at once as the memory budget admits, with distinct scopes, despite Free traffic",
        in_order
        and serial
        and peak == expected_peak
        and not clash
        and all(p.returncode == 0 for p in tickets),
        f"order ok={in_order} peak concurrency={peak} (want {expected_peak}) scope clash={clash} "
        f"rc={[p.returncode for p in tickets]}, {stream} Free commands meanwhile",
    )

    # 3b. SA-135: android-build admits two jobs at once at a 24 GiB cap, but never two in the same
    # worktree (the worktree lock): A and B (two worktrees) overlap, C (A's worktree) waits for A.
    env24 = {**bench.env, "AGENT_RESOURCE_TEST_CAP_GIB": "24"}
    for sub in ("wt1", "wt2"):
        (bench.roots["rootA"] / sub).mkdir(exist_ok=True)
    bench.roots.update(
        wt1=bench.roots["rootA"] / "wt1", wt2=bench.roots["rootA"] / "wt2"
    )
    # FIFO order A (wt1, long), C (wt1), B (wt2): memory and slots admit C beside A at once, so
    # only the worktree lock makes C wait for A; B (another worktree) waits behind C in the FIFO.
    builds = [t / "s3b-a", t / "s3b-c", t / "s3b-b"]
    procs = []
    for m, where, secs in zip(builds, ("wt1", "wt1", "wt2"), (7, 2, 2)):
        procs.append(
            bench.guard(
                where,
                "run",
                "--lane",
                "android-build",
                "--",
                *snippet(m, secs),
                env=env24,
            )
        )
        time.sleep(0.6)
    for proc in procs:
        proc.wait(timeout=120)
    a_, c_, b_ = builds
    c_gap = started(c_) - ended(a_)
    record(
        "3b android-build: a second ticket in the same worktree waits for the first",
        c_gap > -0.1 and all(p.returncode == 0 for p in procs),
        f"C started {c_gap:+.1f}s after A ended (without the lock it starts ~0.6 s after A "
        f"started); rc={[p.returncode for p in procs]}",
    )
    emus = [t / "s3c-a", t / "s3c-b"]
    ep = [
        bench.guard(
            "rootA", "run", "--lane", "emulator", "--", *snippet(emus[0], 3), env=env24
        )
    ]
    time.sleep(0.4)
    ep.append(
        bench.guard(
            "rootB",
            "run",
            "--lane",
            "emulator",
            "--",
            *snippet(emus[1], 0.2),
            env=env24,
        )
    )
    for proc in ep:
        proc.wait(timeout=120)
    e_overlap = min(ended(emus[0]), ended(emus[1])) - max(
        started(emus[0]), started(emus[1])
    )
    record(
        "3c two emulator tickets from two repositories never overlap (exactly one machine-wide)",
        e_overlap <= 0.2 and all(p.returncode == 0 for p in ep),
        f"overlap {e_overlap:.1f}s rc={[p.returncode for p in ep]}",
    )

    # 4. kill -9 of the submitter keeps both the running and the queued ticket
    r1, r2 = t / "s4-run", t / "s4-queued"
    q1 = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(r1, 6))
    assert bench.wait_file(r1, 30)
    q2 = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(r2, 0.2))
    time.sleep(2)
    os.kill(q2.pid, signal.SIGKILL)
    os.kill(q1.pid, signal.SIGKILL)
    q1.wait()
    q2.wait()
    ok1 = bench.wait_file(r1.with_suffix(".end"), 30)
    ok2 = bench.wait_file(r2.with_suffix(".end"), 60)
    record(
        "4 kill -9 of the submitter keeps the running and the queued ticket",
        ok1 and ok2,
        f"running finished={ok1} queued ran after the kill={ok2}",
    )

    # 5. Ctrl-C (SIGINT) on the client detaches: the ticket still runs to the end
    c1 = t / "s5-ctrlc"
    cc = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(c1, 3))
    assert bench.wait_file(c1, 30)
    signalled = time.time()
    cc.send_signal(signal.SIGINT)
    cc.wait(timeout=30)
    client_exit = time.time()
    done = bench.wait_file(c1.with_suffix(".end"), 30)
    record(
        "5 Ctrl-C detaches the client, the ticket is not cancelled",
        done and cc.returncode != 0,
        f"client rc={cc.returncode}, job finished={done}; job started {signalled - started(c1):.1f}s "
        f"before the signal, client exited {client_exit - signalled:.1f}s after it",
    )

    # 6. kill -9 of the lane wrapper: its slot stays held while the job's scope lives. The next
    # ticket may run beside the orphan (memory admits two), but a third must not.
    w1, w2, w3 = t / "s6-first", t / "s6-second", t / "s6-third"
    p1 = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(w1, 9))
    assert bench.wait_file(w1, 30)
    wrapper = lane_pid(w1)
    if wrapper:
        os.kill(wrapper, signal.SIGKILL)  # exactly this wrapper pid
    p2 = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(w2, 4))
    assert bench.wait_file(w2, 30)
    p3 = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(w3, 0.2))
    p3.wait(timeout=90)
    p2.wait(timeout=90)
    p1.wait(timeout=90)
    orphan_ended = w1.with_suffix(".end").exists()
    gap = started(w3) - ended(w2)
    both_held = (not orphan_ended) or ended(w1) > started(w3)
    record(
        "6 kill -9 of the wrapper: a third ticket does not run beside the orphan and a running job",
        wrapper is not None and p3.returncode == 0 and (gap >= -0.2 or not both_held),
        f"wrapper pid {wrapper}; orphan finished={orphan_ended}; third started {gap:+.1f}s after "
        "the second ended (if the orphan was reaped, the new watchdog killed it)",
    )

    # 7 and 7b deliberately OOM-kill a process, which raises a desktop "Application Stopped"
    # warning, so they run only on request.
    if os.environ.get("AGENT_RESOURCE_OOM_TESTS") == "1":
        # 7. a Free command over its memory cap is OOM-killed; a running ci ticket is untouched
        keep = t / "s7-ci"
        ck = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(keep, 5))
        assert bench.wait_file(keep, 30)
        oom = bench.guard(
            "rootA",
            "run",
            "--mem",
            "64M",
            "--",
            sys.executable,
            "-c",
            "x=bytearray(300*1024*1024);print('survived')",
        )
        out = oom.communicate(timeout=60)[0]
        ck.wait(timeout=60)
        record(
            "7 Free command over --mem 64M is OOM-killed, the ci ticket is untouched",
            oom.returncode != 0
            and "survived" not in out
            and ck.returncode == 0
            and keep.with_suffix(".end").exists(),
            f"free rc={oom.returncode}, ci rc={ck.returncode}",
        )

        # 7b. a real memory hog in Free (5 GiB touched) is killed at the Free slice cap, the ci job lives
        keep2 = t / "s7b-ci"
        ck2 = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(keep2, 12))
        assert bench.wait_file(keep2, 30)
        hog = bench.guard(
            "rootA",
            "run",
            "--",
            sys.executable,
            "-c",
            "b=bytearray(5*1024**3)\nfor i in range(0,len(b),4096): b[i]=1\nprint('survived')",
        )
        out = hog.communicate(timeout=120)[0]
        ck2.wait(timeout=60)
        record(
            "7b a 5 GiB Free hog is killed at the Free slice cap; the running ci job is untouched",
            hog.returncode != 0
            and "survived" not in out
            and ck2.returncode == 0
            and keep2.with_suffix(".end").exists(),
            f"free rc={hog.returncode}, ci rc={ck2.returncode}",
        )

    else:
        print(
            "SKIP  7/7b deliberate OOM kills: set AGENT_RESOURCE_OOM_TESTS=1",
            flush=True,
        )

    # 8. a non-StateAction root is untouched and never queued, even with a ci ticket running
    block = t / "s8-ci"
    cb = bench.guard("rootA", "run", "--lane", "ci", "--", *snippet(block, 6))
    assert bench.wait_file(block, 30)
    dummy = t / "s8-dummy"
    before = time.time()
    dl = bench.guard("foreign", "run", "--lane", "ci", "--", *snippet(dummy, 0.2))
    dl.wait(timeout=30)
    cg = dummy.read_text().split()[1]
    untouched = not any(x in cg for x in ("agent-lane", "agent-work", "agent-free"))
    record(
        "8 dummy command from a non-StateAction root is untouched and not queued",
        dl.returncode == 0
        and untouched
        and started(dummy) - before < 5
        and cb.poll() is None,
        f"ran {started(dummy) - before:.1f}s after submit while ci busy; cgroup {cg}",
    )
    cb.wait(timeout=60)

    # 9/10 use this repository's real project key, whose transient unit names equal the real
    # lane's: they must not run while a real ci job holds `agent-lane-ci-<key>*.scope`.
    live = subprocess.run(
        [
            "systemctl",
            "--user",
            "list-units",
            "--plain",
            "--no-legend",
            "agent-lane-ci-*",
        ],
        capture_output=True,
        text=True,
    ).stdout.strip()
    if live:
        print(
            "SKIP  9/10 a real agent-lane-ci scope is running (same transient unit names)",
            flush=True,
        )
        return
    # 9. ci:merge --execute enters the ci lane with the pinned gh identity and reaches the PR lookup
    shim = t / "agent-resource"
    shim.write_text(f'#!/bin/sh\nexec {sys.executable} {GUARD} "$@"\n')
    shim.chmod(0o755)
    token = subprocess.run(
        ["gh", "auth", "token", "--user", "timothywangdev"],
        capture_output=True,
        text=True,
    ).stdout.strip()
    env = {
        **bench.env,
        "AGENT_RESOURCE_BIN": str(shim),
        "AGENT_RESOURCE_PROJECT_ROOTS": str(REPO),
        "STATEACTION_LOCAL_CI_HOME": str(t / "ci-home"),
        "GH_TOKEN": token,
    }
    env.pop("STATEACTION_LOCAL_CI_REEXEC", None)
    probe = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/local-ci/local_ci.py"),
            "merge",
            "--pr",
            "999999",
            "--execute",
        ],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    text = (
        (probe.stdout + probe.stderr).replace(token, "***")
        if token
        else probe.stdout + probe.stderr
    )
    proof = subprocess.run(
        [
            str(shim),
            "run",
            "--lane",
            "ci",
            "--",
            sys.executable,
            "-c",
            "import sys,json;sys.path.insert(0,'scripts/local-ci');import local_ci;"
            "p=local_ci.guard_proof();print(json.dumps({k:p[k] for k in ('scope','lane','memoryMaxBytes','swapMaxBytes')}))",
        ],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    got = [x for x in proof.stdout.splitlines() if x.startswith("{")]
    reached = (
        "404" in text or "Not Found" in text
    ) and "Active GitHub account" not in text
    record(
        "9 local_ci enters the ci lane; gh identity reaches the PR lookup inside it",
        bool(token)
        and "agent-lane-ci-" in (got[0] if got else "")
        and reached
        and probe.returncode != 0,
        f"proof={got[0] if got else proof.stdout[-120:]!r}; merge refusal reason: "
        f"{[ln for ln in text.splitlines() if 'REFUSED' in ln or '404' in ln or 'Not Found' in ln][:2]}",
    )
    dry = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/local-ci/local_ci.py"),
            "merge",
            "--pr",
            "999999",
        ],
        cwd=REPO,
        env={**env, "AGENT_RESOURCE_BIN": "/nonexistent"},
        capture_output=True,
        text=True,
        timeout=300,
    )
    record(
        "10 a dry-run merge takes no ci ticket (works with no guard launcher at all)",
        "agent-resource is not installed" not in dry.stdout + dry.stderr
        and dry.returncode != 0,
        f"rc={dry.returncode}",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    if os.environ.get("AGENT_RESOURCE_TEST") != "1":
        print("set AGENT_RESOURCE_TEST=1 (enables the isolated roots/state test hooks)")
        return 2
    bench = Bench()
    try:
        run(bench)
    finally:
        bench.cleanup()
    failed = [n for n, ok, _ in results if not ok]
    text = "\n".join(f"{'PASS' if ok else 'FAIL'} {n}: {d}" for n, ok, d in results)
    if args.evidence:
        args.evidence.write_text(text + "\n")
    print("\nALL PASS" if not failed else f"\nFAILED: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
