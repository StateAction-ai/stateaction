"""Best-effort side channels of a gate run (SA-130): cgroup pid/memory counters for the run
record and the `flowlog ci-run` report. Nothing here may fail or slow a gate: every error is
swallowed and `flowlog` being absent is normal."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

TIMEOUT_SEC = 5
SLICE_NAME = "agent-work.slice"


def _number(path: Path) -> int | str | None:
    try:
        text = path.read_text().strip()
        return text if text == "max" else int(text)
    except (OSError, ValueError):
        return None


def _counters(path: Path) -> dict[str, int] | None:
    try:
        return {
            key: int(value)
            for key, value in (
                line.split() for line in path.read_text().splitlines() if line.strip()
            )
        }
    except (OSError, ValueError):
        return None


def group_counters(group: Path) -> dict:
    """pids.current/max/events(max) and memory.events of one cgroup; None for unreadable files."""
    pids_events = _counters(group / "pids.events")
    return {
        "pidsCurrent": _number(group / "pids.current"),
        "pidsMax": _number(group / "pids.max"),
        "pidsEventsMax": None if pids_events is None else pids_events.get("max", 0),
        "memoryEvents": _counters(group / "memory.events"),
    }


def slice_group(scope: Path) -> Path | None:
    for candidate in (scope, *scope.parents):
        if candidate.name == SLICE_NAME:
            return candidate
    return None


def guard_counters(proof: dict) -> dict:
    """Counters of the run's scope and of the shared work slice (where EAGAIN thread-spawn
    failures came from: slice pids.max was exhausted 717 times before SA-130)."""
    try:
        scope = Path(proof["cgroup"])
    except (KeyError, TypeError):
        return {}
    shared = slice_group(scope)
    return {
        "scope": group_counters(scope),
        "slice": group_counters(shared) if shared else None,
    }


def scrubbed_env() -> dict[str, str]:
    """flowlog needs no GitHub credential from a gate run."""
    return {
        k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN")
    }


def ticket_of(branch: str | None) -> str | None:
    match = re.search(r"/sa-([1-9][0-9]*)-", branch or "")
    return f"SA-{match.group(1)}" if match else None


def flowlog_binary() -> str | None:
    explicit = os.environ.get("FLOWLOG")
    if explicit == "off":  # tests and sandboxes: never write to the real flow database
        return None
    candidates = [explicit] if explicit else []
    candidates += [shutil.which("flowlog"), str(Path.home() / ".local/bin/flowlog")]
    return next((c for c in candidates if c and os.access(c, os.X_OK)), None)


def report_ci_run(
    record: dict, *, repo: Path, mode: str = "ci:local", run=subprocess.run
) -> bool:
    """`flowlog ci-run` for a finished run record. Returns whether flowlog accepted it."""
    try:
        binary = flowlog_binary()
        if not binary:
            return False
        branch = run(
            ["git", "-C", str(repo), "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SEC,
        ).stdout.strip()
        verdict = {"PASS": "pass", "INTERRUPTED": "cancelled"}.get(
            record.get("verdict", ""), "fail"
        )
        failing = (
            ""
            if verdict == "pass"
            else next(
                (
                    s["id"]
                    for s in record.get("stages", [])
                    if s.get("status") != "passed"
                ),
                "",
            )
        )
        stages = [
            {
                "stage": s["id"],
                "wall_s": s.get("durationSec", 0.0),
                "status": s.get("status"),
                "cache": (s.get("cache") or {}).get("mode") or s.get("cacheMode"),
                "cache_hits": (s.get("cache") or {}).get("hits"),
                "cache_tasks": (s.get("cache") or {}).get("tasks"),
            }
            for s in record.get("stages", [])
        ]
        argv = [
            binary,
            "ci-run",
            "--run-id",
            str(record.get("runId", "")),
            "--verdict",
            verdict,
            "--wall",
            str(record.get("wallSec", 0.0)),
            "--mode",
            mode,
            "--head",
            str(record.get("head") or ""),
            "--tree",
            str(record.get("tree") or ""),
            "--branch",
            branch,
            "--log-dir",
            str(record.get("logDir", "")),
            "--stages",
            "-",
        ]
        ticket = ticket_of(branch)
        if ticket:
            argv += ["--ticket", ticket]
        if failing:
            argv += ["--failing-stage", failing]
        if record.get("receipt"):
            argv += ["--receipt", str(record["receipt"])]
        done = run(
            argv,
            input=json.dumps(stages),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=TIMEOUT_SEC,
            env=scrubbed_env(),
        )
        return done.returncode == 0
    except Exception:  # noqa: BLE001  (best effort: never fail or slow the gate)
        return False
