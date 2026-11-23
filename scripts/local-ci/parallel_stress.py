#!/usr/bin/env python3
"""Paired (or N-wide) full-gate stress for SA-108. Manual, never part of the gate.

Runs `--width` full local CI gates at the same time on different trees, `--rounds` times, one
round after the other. Each gate is a real `local_ci.py run` inside a real `ci` lane scope of
the repository's own guard copy (isolated agentqueue state, scratch project root), against the
shared bounded fixtures and a private CI home, so nothing of the real lane, receipts or locks is
touched. After every round it asserts that the run records share no resource and logs the host
load, pressure (PSI) and the shared slice's `memory.events` / `pids.events` deltas.

  STATEACTION_LOCAL_FIXTURES=<env file> STATEACTION_LOCAL_CI_SUBMODULES=<dir> \
  AGENT_RESOURCE_TEST=1 python3 scripts/local-ci/parallel_stress.py --rounds 20 --width 2

Throughput (`--width 1|2|3 --rounds 1`) is trees per hour = width * 3600 / round wall seconds.
Any failure stops the loop (zero-flake rule: root-cause it, never rerun hoping).
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
GUARD = REPO / "scripts/mobile/resource_guard.py"
SLICE_GLOB = "agent-work.slice"
DISJOINT = ("export", "tmp", "nxCache", "nxWorkspaceData")


def sh(*argv: str, cwd: Path | None = None, check: bool = True, **kw):
    return subprocess.run(argv, cwd=cwd, check=check, text=True, **kw)


def slice_dir() -> Path | None:
    for line in Path("/proc/self/cgroup").read_text().splitlines():
        rel = line.split("::", 1)[-1]
        if f"/{SLICE_GLOB}/" in rel:
            return (
                Path("/sys/fs/cgroup")
                / rel.lstrip("/").split(f"/{SLICE_GLOB}/")[0]
                / SLICE_GLOB
            )
    for found in Path("/sys/fs/cgroup").glob(
        f"user.slice/*/user@*.service/*/{SLICE_GLOB}"
    ):
        return found
    return None


def events(path: Path | None, name: str) -> dict[str, int]:
    try:
        return {
            k: int(v)
            for k, v in (ln.split() for ln in (path / name).read_text().splitlines())
        }
    except (OSError, ValueError, TypeError):
        return {}


def psi() -> dict[str, str]:
    out = {}
    for kind in ("cpu", "memory", "io"):
        try:
            out[kind] = Path(f"/proc/pressure/{kind}").read_text().splitlines()[0]
        except OSError:
            pass
    return out


def host() -> dict:
    mem = {
        k: int(v.split()[0])
        for k, v in (
            ln.split(":", 1) for ln in Path("/proc/meminfo").read_text().splitlines()
        )
    }
    group = slice_dir()
    return {
        "load": Path("/proc/loadavg").read_text().split()[:3],
        "psi": psi(),
        "memAvailableMiB": mem["MemAvailable"] // 1024,
        "sliceMemoryEvents": events(group, "memory.events"),
        "slicePidsEvents": events(group, "pids.events"),
    }


class Bench:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.id = time.strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(2)
        base = Path(args.workdir or Path.home() / ".cache/stateaction-sa108-stress")
        self.root = base / self.id
        self.root.mkdir(parents=True)
        self.home = base / "ci-home"  # persistent: warm caches, like the real home
        self.state = Path(
            f"/run/user/{os.getuid()}/agent-resource-guard/stress-{self.id}"
        )
        self.clone = self.root / "clone"
        self.out = self.root / "rounds.jsonl"
        head = sh(
            "git", "rev-parse", args.rev, cwd=REPO, capture_output=True
        ).stdout.strip()
        sh(
            "git",
            "clone",
            "--local",
            "--no-checkout",
            "--quiet",
            str(REPO),
            str(self.clone),
        )
        sh("git", "fetch", "--quiet", str(REPO), head, cwd=self.clone)
        self.head = head
        self.env = {
            **os.environ,
            "AGENT_RESOURCE_TEST": "1",
            "AGENT_RESOURCE_STATE_DIR": str(self.state),
            "AGENT_RESOURCE_PROJECT_ROOTS": str(self.root),
            "STATEACTION_LOCAL_CI_HOME": str(self.home),
            "FLOWLOG": "off",
        }
        for key in ("STATEACTION_LANE_HELD", "STATEACTION_LOCAL_CI_REEXEC"):
            self.env.pop(key, None)
        # The reservation arithmetic needs 22 GiB for two 6 GiB tickets and 28 for three; on a
        # busy host the live cap is lower and the gates would silently run one after the other.
        cap = args.cap_gib or {2: 24, 3: 28}.get(args.width)
        if cap:
            self.env["AGENT_RESOURCE_TEST_CAP_GIB"] = str(cap)

    def tree(self, label: str) -> Path:
        """A fresh worktree of the clone whose tree differs from every other one."""
        path = self.root / f"wt-{label}"
        sh(
            "git",
            "worktree",
            "add",
            "--quiet",
            "--detach",
            str(path),
            self.head,
            cwd=self.clone,
        )
        sh("git", "config", "user.email", "stress@example.invalid", cwd=path)
        sh("git", "config", "user.name", "stress", cwd=path)
        sh("git", "config", "commit.gpgsign", "false", cwd=path)
        marker = path / "docs" / "sa108-stress.txt"
        marker.write_text(f"{self.id} {label}\n")
        sh("git", "add", "-f", str(marker), cwd=path)
        sh(
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--quiet",
            "-m",
            f"stress {label}",
            cwd=path,
        )
        return path

    def start(self, path: Path, key: str) -> subprocess.Popen:
        cmd = [
            sys.executable, str(GUARD), "run", "--lane", "ci", "--key", key, "--",
            # the gate must not see the test hooks that isolate the guard state (a real gate never does)
            "env", "-u", "AGENT_RESOURCE_TEST", "-u", "AGENT_RESOURCE_STATE_DIR",
            "-u", "AGENT_RESOURCE_PROJECT_ROOTS", "-u", "AGENT_RESOURCE_TEST_CAP_GIB",
            sys.executable, "scripts/local-ci/local_ci.py", "run", "--tree", "HEAD",
        ]  # fmt: skip
        for stage in self.args.only or []:
            cmd += ["--only", stage]
        log = (self.root / f"{key}.out").open("w")
        return subprocess.Popen(
            cmd, cwd=path, env=self.env, stdout=log, stderr=subprocess.STDOUT, text=True
        )

    def cleanup(self) -> None:
        if self.args.keep:
            return
        for tree in self.root.glob("wt-*"):
            shutil.rmtree(tree, ignore_errors=True)
        shutil.rmtree(self.clone, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)


def summary(out: Path) -> dict:
    """The runner's JSON summary: the last top-level object (the guard prints lines after it)."""
    text = out.read_text()
    decoder = json.JSONDecoder()
    found = None
    for index in range(len(text)):
        if text[index] == "{" and (index == 0 or text[index - 1] == "\n"):
            try:
                found = decoder.raw_decode(text[index:])[0]
            except ValueError:
                continue
    return found or {"verdict": "NO-SUMMARY", "tail": text[-2000:]}


def walls_sum(records: list[dict]) -> float:
    return sum(float(r.get("wallSec") or 0) for r in records)


def check_disjoint(records: list[dict]) -> list[str]:
    """Every run owns its slot, dirs and ports; nothing but the shared fixtures is common."""
    problems = []
    iso = [r.get("isolation") or {} for r in records]
    if any(not i for i in iso):
        return ["a run record has no isolation block"]
    for name in ("slot", "runId", "logDir", *DISJOINT):
        values = [i[name] if name in i else r.get(name) for i, r in zip(iso, records)]
        if len(set(map(str, values))) != len(values):
            problems.append(f"{name} shared: {values}")
    ports = [set(i["ports"].values()) for i in iso]
    for a in range(len(ports)):
        for b in range(a + 1, len(ports)):
            if ports[a] & ports[b]:
                problems.append(
                    f"ports shared by {a} and {b}: {sorted(ports[a] & ports[b])}"
                )
    trees = [r["tree"] for r in records]
    if len(set(trees)) != len(trees):
        problems.append("two runs gated the same tree")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--width", type=int, default=2, choices=(1, 2, 3))
    parser.add_argument("--rev", default="HEAD")
    parser.add_argument(
        "--only", action="append", help="restrict stages (debug/short rounds)"
    )
    parser.add_argument("--workdir")
    parser.add_argument(
        "--cap-gib", type=int, help="reservation arithmetic only (width 3 needs 28)"
    )
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    if os.environ.get("AGENT_RESOURCE_TEST") != "1":
        print("set AGENT_RESOURCE_TEST=1 (isolated state dir and scratch project root)")
        return 2
    for needed in ("STATEACTION_LOCAL_FIXTURES", "STATEACTION_LOCAL_CI_SUBMODULES"):
        if not os.environ.get(needed):
            print(f"set {needed}")
            return 2
    bench = Bench(args)
    print(
        f"stress {bench.id}: {args.rounds} rounds x {args.width} gates; results {bench.out}",
        flush=True,
    )
    failures = 0
    try:
        for rnd in range(1, args.rounds + 1):
            before = host()
            began = time.monotonic()
            trees = [bench.tree(f"r{rnd}-g{g}") for g in range(args.width)]
            procs = [
                bench.start(t, f"stress-{bench.id}-r{rnd}-g{g}")
                for g, t in enumerate(trees)
            ]
            codes = [p.wait() for p in procs]
            wall = time.monotonic() - began
            sums = [
                summary(bench.root / f"stress-{bench.id}-r{rnd}-g{g}.out")
                for g in range(args.width)
            ]
            records = []
            for s in sums:
                try:
                    records.append(
                        json.loads((Path(s["logDir"]) / "run.json").read_text())
                    )
                except (KeyError, OSError, ValueError):
                    pass
            after = host()
            problems = [] if len(records) != args.width else check_disjoint(records)
            if len(records) != args.width:
                problems.append("a run produced no run.json")
            elif (
                args.width > 1
                and walls_sum(records) <= (time.monotonic() - began) * 1.1
            ):
                # The memory budget admitted one gate at a time (the live cap was below the
                # 22 GiB two 6 GiB tickets need): the gates never overlapped, so sharing a slot
                # or directory is correct, and this round says nothing about parallel gates.
                problems = []
                print(
                    "NOTE: gates ran one after the other (memory admission); not a parallel round",
                    flush=True,
                )
            delta = {
                kind: {
                    k: after[f"slice{kind}"].get(k, 0)
                    - before[f"slice{kind}"].get(k, 0)
                    for k in after[f"slice{kind}"]
                    if after[f"slice{kind}"].get(k, 0)
                    != before[f"slice{kind}"].get(k, 0)
                }
                for kind in ("MemoryEvents", "PidsEvents")
            }
            # `--only` runs never yield PASS (no receipt): every selected stage passing is the bar.
            gate_ok = [
                bool(r["stages"])
                and all(st["status"] == "passed" for st in r["stages"])
                and (r["verdict"] == "PASS" or args.only)
                for r in records
            ]
            # throttling counters (`high`, `sock_throttled`) rise with any load on the slice;
            # a kill or a refused spawn is what must not appear while the gates run.
            unsafe = {
                k: v
                for kind in delta.values()
                for k, v in kind.items()
                if k in ("max", "oom", "oom_kill", "oom_group_kill")
            }
            if unsafe:
                problems.append(f"slice kill/limit events during the round: {unsafe}")
            ok = (
                len(gate_ok) == args.width
                and all(gate_ok)
                and (all(c == 0 for c in codes) or bool(args.only))
                and not problems
            )
            row = {
                "round": rnd, "ok": ok, "width": args.width, "wallSec": round(wall, 1),
                "treesPerHour": round(args.width * 3600 / wall, 2), "exit": codes,
                "verdicts": [s.get("verdict") for s in sums],
                "gateWallSec": [r.get("wallSec") for r in records],
                "slots": [(r.get("isolation") or {}).get("slot") for r in records],
                "peakMiB": [round((r.get("guard") or {}).get("peakMemoryBytes", 0) / 1048576) for r in records],
                "problems": problems, "eventsDelta": delta, "before": before, "after": after,
                "failedStages": [
                    [(st["id"], st["status"]) for st in r["stages"] if st["status"] != "passed"]
                    for r in records
                ],
                "logs": [r.get("logDir") for r in records],
            }  # fmt: skip
            with bench.out.open("a") as handle:
                handle.write(json.dumps(row) + "\n")
            print(
                json.dumps(
                    {
                        k: row[k]
                        for k in (
                            "round",
                            "ok",
                            "wallSec",
                            "gateWallSec",
                            "slots",
                            "peakMiB",
                            "problems",
                            "eventsDelta",
                            "failedStages",
                        )
                    }
                ),
                flush=True,
            )
            for tree in trees:
                sh(
                    "git",
                    "worktree",
                    "remove",
                    "--force",
                    str(tree),
                    cwd=bench.clone,
                    check=False,
                )
            if not ok:
                failures += 1
                print(
                    f"ROUND {rnd} FAILED: stop and root-cause; see {bench.root}",
                    flush=True,
                )
                break
    finally:
        bench.cleanup()
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
