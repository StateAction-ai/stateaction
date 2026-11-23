#!/usr/bin/env python3
"""Full local CI for StateAction: guarded, serial, bound to an exact Git tree.

  local_ci.py run --tree REV        the single required pass: a clean commit tree (rebased head)
  local_ci.py verify --head REV     validate the PASS receipt for REV against origin/main
  local_ci.py merge --pr N          verify, then squash merge through the GitHub CLI

Rules enforced here, not by convention:
  * every stage runs inside the agent-resource `ci` lane scope (one ticket, 6 GiB, no swap,
    FIFO behind other gates of the project); without verified enforcement the run is refused;
  * stages run one at a time, uncached, in a private export of the exact tree;
  * the tree is re-read after every stage; a change fails the run;
  * only a run in which every declared stage passed leaves a PASS receipt;
  * receipts, logs and the export live outside Git and hold no credentials.
Standard library only.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
import random
import re
import resource
import secrets
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import flow_hook  # noqa: E402

GIB = 1024**3
# Finite service caps; SeaweedFS needs 2 GiB (SA-108: throttled at 1 GiB, measured peak 1.02 GiB).
SERVICE_CAPS = {"storage": 2 * GIB, "postgres": 5 * GIB // 2}
JOB_MAX = 6 * GIB
TOTAL_MAX = 12 * GIB  # legacy installed guard
AGG_MAX = 24 * GIB  # only with a positive policy proof
CI_LANE = "ci"
# Slot 0 of the lane keeps the historical scope name; slot n >= 1 (SA-108) is `-s<n>`.
CI_SCOPE = re.compile(r"agent-lane-ci-[0-9a-f]{8}(?:-s[1-9])?\.scope")
# At most this many gates share one CI home at once (the lane's slot count is the real limit;
# this is the number of isolated private slots: export and Nx state each).
MAX_PARALLEL = 3
# Port blocks are claimed machine-wide (any CI home, the stress harness included), so two
# gates never get the same block even from different homes; more blocks than slots on purpose.
MAX_PORT_BLOCKS = 6
# The shared bounded PostgreSQL fixture has max_connections=100 since SA-135 (30 before; 3
# reserved for superusers; scripts/platform/bounded-fixtures.py defines it) and is also used by
# every agent's Free runs. Gates draw their own connections from one machine-wide budget of
# this many units (flock files), so concurrent gates never exceed it; each fixture stage
# declares its measured peak in stages.json (`dbConnections`).
DB_BUDGET = 60  # three gates at the 19-unit peak fit; 37 are left for other agents
DB_WAIT_SEC = 3600
# Below the kernel's ephemeral range (32768+), above well-known dev ports.
PORT_BASE = 10100
PORT_STRIDE = 10
# Independent stage lanes (SA-116) share the one gate, the one agent-resource job and its 6 GiB
# cap (MemoryHigh 5 GiB). The memory the lanes of one group may be budgeted for together, in MiB.
LANE_MEMORY_MIB = 4608
LANE_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")
PORT_VARS = (
    "HOSTED_SMOKE_WEB_PORT",
    "HOSTED_SMOKE_RUNNER_PORT",
    "CI_SMOKE_WEB_PORT",
    "CI_SMOKE_RUNNER_PORT",
)
SLICE = "agent-work.slice"
RECEIPT_SCHEMA = "stateaction.local-ci.receipt/1"
STAGES_SCHEMA = "stateaction.local-ci.stages/1"
STAGES_PATH = "scripts/local-ci/stages.json"
RUNNER_PATH = "scripts/local-ci/local_ci.py"
DOCS_MODE = "docs-only"
DOCS_ENV = "STATEACTION_DOCS_CHANGED"
DOCS_REMOVED_ENV = "STATEACTION_DOCS_REMOVED"
DEFAULT_OUTPUT_CAP = 64 * 1024 * 1024
FIXTURE_KEYS = (
    "CATALOG_TEST_ADMIN_URL",
    "CATALOG_TEST_OWNER_URL",
    "CATALOG_TEST_APP_URL",
    "STORAGE_TEST_ENDPOINT",
    "STORAGE_TEST_ACCESS_KEY_ID",
    "STORAGE_TEST_SECRET_ACCESS_KEY",
    "TRANSPORT_TEST_S3_ENDPOINT",
    "TRANSPORT_TEST_S3_ACCESS_KEY",
    "TRANSPORT_TEST_S3_SECRET_KEY",
)
REQUIRED_FIXTURE_KEYS = FIXTURE_KEYS[:6]
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
SECRET_KEY = re.compile(
    r"(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE|CREDENTIAL)", re.I
)
GIT_ENV = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_EDITOR",
)


class Refused(RuntimeError):
    """The run must not start or its result must not count."""


class GuardError(Refused):
    pass


class DocsOnlyUnsafe(Refused):
    """A changed doc is an input of a task the docs-only run would skip: run everything."""


# --------------------------------------------------------------------------- git


def git(repo: Path, *args: str, input: bytes | None = None, check=True) -> str:
    result = subprocess.run(
        ["git", *args], cwd=repo, input=input, capture_output=True, timeout=120
    )
    if check and result.returncode:
        raise Refused(
            f"git {args[0]} failed: {result.stderr.decode(errors='replace').strip()}"
        )
    return result.stdout.decode(errors="replace").strip()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def blob(repo: Path, rev: str, path: str) -> bytes | None:
    result = subprocess.run(
        ["git", "cat-file", "blob", f"{rev}:{path}"], cwd=repo, capture_output=True
    )
    return result.stdout if result.returncode == 0 else None


def local_ci_home() -> Path:
    return Path(
        os.environ.get("STATEACTION_LOCAL_CI_HOME")
        or Path.home() / ".cache" / "stateaction-local-ci"
    )


def private_dir(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise Refused(f"{path} must be private and owned by this user")
    return path


# ------------------------------------------------------------------------ guard


def _read(path: Path) -> str:
    return path.read_text().strip()


def _limit(value: str) -> int:
    if not value.isdigit():
        raise GuardError(f"cgroup limit {value!r} is not a finite byte count")
    return int(value)


def fetch_policy() -> dict:
    launcher = guard_binary()
    if launcher is None:
        raise GuardError("agent-resource is missing; cannot prove the aggregate cap")
    result = subprocess.run(
        [str(launcher), "policy"], capture_output=True, text=True, timeout=30
    )
    try:
        report = json.loads(result.stdout)
    except ValueError as error:
        raise GuardError(
            "the installed agent-resource has no policy proof, so a cap above 12 GiB is refused"
        ) from error
    if not isinstance(report, dict):
        raise GuardError("agent-resource policy returned an invalid report")
    return report


def check_aggregate(slice_max: int, fetch=None) -> dict | None:
    """<=12 GiB is the legacy guard. Up to 24 GiB needs positive policy-2 proof."""
    if slice_max <= TOTAL_MAX:
        return None
    if slice_max > AGG_MAX:
        raise GuardError("aggregate cap exceeds the 24 GiB policy maximum")
    report = (fetch or fetch_policy)()
    # The watchdog moves the aggregate cap every few seconds with the host's free memory
    # (SA-130), so the cap this process read from the kernel a moment ago and the one the
    # policy report read a moment later differ by design (the gate's own `fixture port 54340`
    # proof failed on that equality, SA-108). The proof is the report's own consistent
    # instant: kernel cap equals the recorded cap, inside the policy bounds, zero swap, and a
    # current-policy watchdog.
    kernel = report.get("kernelMemoryMaxBytes")
    if not (
        report.get("ok") is True
        and report.get("watchdogPolicyActive") is True
        and report.get("kernelSwapMax") == "0"
        and isinstance(kernel, int)
        and not isinstance(kernel, bool)
        and kernel == report.get("recordedCapBytes")
        and JOB_MAX <= kernel <= AGG_MAX
    ):
        raise GuardError(
            "aggregate cap above 12 GiB is not proved by a current policy-2 watchdog "
            "and a recorded cap equal to the kernel cap with zero swap"
        )
    return {
        "capBytes": kernel,  # the value the report proved, not the earlier read
        "observedSliceMaxBytes": slice_max,
        "watchdogPolicyActive": True,
        "stopThresholdBytes": report.get("stopThresholdBytes"),
    }


def guard_proof(
    proc: Path = Path("/proc"),
    cgroup: Path = Path("/sys/fs/cgroup"),
    policy_fetch=None,
) -> dict:
    """Prove from the kernel's own files that this process is inside the budget."""
    try:
        line = _read(proc / "self/cgroup")
        relative = line.split("::", 1)[1]
        scope = relative.rsplit("/", 1)[-1]
        if f"/{SLICE}/" not in relative or not CI_SCOPE.fullmatch(scope):
            raise GuardError("not inside the agent-resource ci lane scope")
        group = cgroup / relative.lstrip("/")
        scope_max = _limit(_read(group / "memory.max"))
        slice_max = _limit(_read(group.parent / "memory.max"))
        if scope_max > JOB_MAX:
            raise GuardError("job memory limit exceeds 6 GiB")
        aggregate = check_aggregate(slice_max, policy_fetch)
        if (
            _read(group / "memory.swap.max") != "0"
            or _read(group.parent / "memory.swap.max") != "0"
        ):
            raise GuardError("swap is not disabled in the enforced cgroups")
    except (OSError, IndexError) as error:
        raise GuardError(f"cgroup enforcement cannot be verified: {error}") from error
    return {
        "scope": scope,
        "lane": CI_LANE,
        "slice": SLICE,
        "memoryMaxBytes": scope_max,
        "sliceMemoryMaxBytes": slice_max,
        "swapMaxBytes": 0,
        "aggregatePolicy": aggregate,
        "cgroup": str(group),
    }


def peak_memory(proof: dict) -> int | None:
    try:
        return int(_read(Path(proof["cgroup"]) / "memory.peak"))
    except (OSError, ValueError, KeyError):
        return None


def cpu_seconds(group: Path | None) -> float | None:
    """Cumulative CPU seconds (user+system) of a cgroup, from cpu.stat usage_usec."""
    try:
        for line in _read(group / "cpu.stat").splitlines():
            key, _, value = line.partition(" ")
            if key == "usage_usec":
                return int(value) / 1e6
    except (OSError, ValueError, TypeError):
        pass
    return None


def memory_current(group: Path | None) -> int | None:
    try:
        return int(_read(group / "memory.current"))
    except (OSError, ValueError, TypeError):
        return None


def memory_anon(group: Path | None) -> int | None:
    """Anonymous (non-reclaimable) memory of a cgroup: the pressure that page cache is not."""
    try:
        for line in _read(group / "memory.stat").splitlines():
            key, _, value = line.partition(" ")
            if key == "anon":
                return int(value)
    except (OSError, ValueError, TypeError):
        pass
    return None


def guard_binary() -> Path | None:
    candidate = Path(
        os.environ.get("AGENT_RESOURCE_BIN")
        or Path.home() / ".local/bin/agent-resource"
    )
    return candidate if candidate.is_file() and os.access(candidate, os.X_OK) else None


def ticket_key(prefix: str, tree: str, argv: list[str]) -> str:
    """Deterministic ticket key. agentqueue refuses a reused key whose command or cwd differs,
    so the key carries a digest of both: a rerun with the same arguments from the same checkout
    path attaches to or replaces the ticket; other arguments get their own ticket."""
    digest = sha256_bytes(json.dumps([argv, os.getcwd()]).encode())[:12]
    return f"{prefix}-{tree}-{digest}"


def ensure_guard(
    argv: list[str],
    *,
    check=guard_proof,
    binary=guard_binary,
    execv=os.execv,
    key: str | None = None,
) -> dict:
    """Return the proof, or re-execute this command under the installed guard.

    There is no unguarded path: no binary and no proof means refusal.
    """
    try:
        return check()
    except GuardError as inside:
        if os.environ.get("STATEACTION_LOCAL_CI_REEXEC") == "1":
            raise GuardError(
                f"guard re-execution did not enforce limits: {inside}"
            ) from inside
        launcher = binary()
        if launcher is None:
            raise GuardError(
                "agent-resource is not installed; refusing to run outside the machine-wide budget"
            ) from inside
        os.environ["STATEACTION_LOCAL_CI_REEXEC"] = "1"
        execv(
            str(launcher),
            [
                str(launcher),
                "run",
                "--lane",
                CI_LANE,
                *(["--key", key] if key else []),
                "--",
                sys.executable,
                *argv,
            ],
        )
        return {}  # unreachable with a real exec; only a mocked execv returns


# ------------------------------------------------------------- docs-only classifier


def rule_sha256(rule: dict) -> str:
    return sha256_bytes(json.dumps(rule, sort_keys=True).encode())


def path_matches(path: str, pattern: str) -> bool:
    """Glob match where `**/` spans any directories, `**` anything and `*` stays in a segment."""
    regex, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            regex, i = regex + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            regex, i = regex + ".*", i + 2
        elif pattern[i] == "*":
            regex, i = regex + "[^/]*", i + 1
        else:
            regex, i = regex + re.escape(pattern[i]), i + 1
    return re.fullmatch(regex, path) is not None


def is_docs_path(path: str, rule: dict) -> bool:
    return any(path_matches(path, p) for p in rule["docsPaths"]) and not any(
        path_matches(path, p) for p in rule["forceFullPaths"]
    )


def classify_diff(repo: Path, base_sha: str | None, head_sha: str, rule: dict | None):
    """Classify `git diff --name-status -M <merge-base> <head>`; fails closed to the full suite.

    Returns a dict: docsOnly, reason, mergeBase, entries and paths (every path on both sides
    of every change, sorted). Anything unresolvable, shallow, empty or unusual is not docs-only.
    """

    def full(reason: str, **extra) -> dict:
        return {
            "docsOnly": False,
            "reason": reason,
            "paths": [],
            "entries": [],
            **extra,
        }

    try:
        if not rule:
            return full("stages.json declares no docsOnly rule")
        if not base_sha:
            return full("origin/main is unresolvable")
        if git(repo, "rev-parse", "--is-shallow-repository", check=False) != "false":
            return full("shallow or unknown clone")
        merge_base = git(repo, "merge-base", base_sha, head_sha, check=False)
        if not merge_base:
            return full("no merge base with origin/main")
        # `--raw` is `--name-status` plus the file modes. Local git config (submodule
        # ignore, external diff drivers) must not hide or reshape an entry.
        raw = subprocess.run(
            [
                "git",
                "-c",
                "diff.ignoreSubmodules=none",
                "diff",
                "--raw",
                "-M",
                "-z",
                "--no-abbrev",
                "--ignore-submodules=none",
                "--no-ext-diff",
                "--no-textconv",
                merge_base,
                head_sha,
            ],
            cwd=repo,
            capture_output=True,
            timeout=120,
        )
        if raw.returncode:
            return full("git diff failed", mergeBase=merge_base)
        tokens = raw.stdout.decode(errors="surrogateescape").split("\0")
        if tokens and tokens[-1] == "":
            tokens.pop()
        entries, i = [], 0
        while i < len(tokens):
            meta = tokens[i].split(" ")
            if len(meta) != 5 or not meta[0].startswith(":"):
                return full("unrecognized diff output", mergeBase=merge_base)
            modes, status = (meta[0][1:], meta[1]), meta[4]
            width = 2 if status[:1] in ("R", "C") else 1
            paths = tokens[i + 1 : i + 1 + width]
            if len(paths) != width or status[:1] not in ("A", "M", "D", "R"):
                return full(f"unrecognized diff entry {status!r}", mergeBase=merge_base)
            if any(mode in ("160000", "120000") for mode in modes):
                return full(
                    f"symlink or submodule entry {paths[-1]!r}", mergeBase=merge_base
                )
            entries.append({"status": status, "paths": paths})
            i += 1 + width
    except (Refused, OSError, subprocess.SubprocessError) as error:
        return full(f"classification failed: {error}")
    paths = sorted({p for e in entries for p in e["paths"]})
    base = {"mergeBase": merge_base, "entries": entries, "paths": paths}
    if not paths:
        return {"docsOnly": False, "reason": "empty diff", **base}
    if any(
        not p or "\n" in p or "\\" in p or "," in p or p != p.strip() for p in paths
    ):
        return {"docsOnly": False, "reason": "unusual path name", **base}
    code = [p for p in paths if not is_docs_path(p, rule)]
    if code:
        return {
            "docsOnly": False,
            "reason": "not docs-only: " + ", ".join(code[:5]),
            **base,
        }
    return {"docsOnly": True, "reason": "every changed path is docs-only", **base}


def docs_run_stages(spec: dict) -> list[dict]:
    """The setup stages and the fast docs checks of a docs-only run, in order."""
    rule = spec["docsOnly"]
    by_id = {s["id"]: s for s in spec["stages"]}
    missing = [i for i in rule["setupStages"] if i not in by_id]
    checks = rule["checks"]
    if missing or any(c["id"] in by_id for c in checks):
        raise Refused(f"docsOnly rule names unknown or duplicate stages: {missing}")
    return [s for s in spec["stages"] if s["id"] in rule["setupStages"]] + checks


def guarded_tasks(
    cwd: Path, paths: list[str], env: dict[str, str], targets: list[str]
) -> list[str]:
    """Task-level affected tasks among `targets` (the ones a docs-only run never executes)."""
    out = (
        Path(env.get("TMPDIR") or tempfile.gettempdir())
        / f"docs-graph-{os.getpid()}.json"
    )
    try:
        result = subprocess.run(
            [
                "pnpm",
                "exec",
                "nx",
                "affected",
                "-t",
                ",".join(targets),
                f"--files={','.join(paths)}",
                f"--graph={out}",
            ],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        try:
            tasks = json.loads(out.read_text())["tasks"]["tasks"]
        except (OSError, ValueError, KeyError, TypeError):
            tasks = None
    finally:
        out.unlink(missing_ok=True)
    if result.returncode or not isinstance(tasks, dict):
        raise Refused(
            "cannot compute the guarded Nx tasks: "
            + (result.stderr.strip()[-300:] or "unreadable task graph")
        )
    return sorted(t for t in tasks if t.split(":", 1)[-1] in targets)


def affected_projects(cwd: Path, paths: list[str], env: dict[str, str]) -> list[str]:
    """Nx projects affected by exactly these files (project level; sorted)."""
    result = subprocess.run(
        [
            "pnpm",
            "exec",
            "nx",
            "show",
            "projects",
            "--affected",
            f"--files={','.join(paths)}",
            "--json",
        ],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    try:
        value = json.loads(result.stdout)
    except ValueError:
        value = None
    if result.returncode or not isinstance(value, list):
        raise Refused(
            "cannot compute the Nx affected set: "
            + (result.stderr.strip()[-300:] or "unparsable output")
        )
    return sorted(value)


# --------------------------------------------------------------------- stage file


EXCLUDE_ITEM = re.compile(r"!?(\*|tag:[A-Za-z0-9_.-]+|[A-Za-z0-9_.@/-]+)")


def load_stages(text: bytes) -> dict:
    data = json.loads(text)
    if data.get("schema") != STAGES_SCHEMA or not data.get("stages"):
        raise Refused("stages.json has an unknown schema or no stages")
    seen = set()
    for stage in data["stages"]:
        affected = stage.get("affected")
        if stage["id"] in seen or not (stage.get("argv") or affected):
            raise Refused(f"invalid or duplicate stage {stage.get('id')!r}")
        if affected is not None and not (
            isinstance(affected.get("targets"), list) and affected["targets"]
        ):
            raise Refused(f"stage {stage['id']!r} declares affected without targets")
        for item in ((affected or {}).get("exclude") or "").split(","):
            if item and not EXCLUDE_ITEM.fullmatch(item):
                raise Refused(
                    f"stage {stage['id']!r}: unsupported exclude pattern {item!r}"
                )
        seen.add(stage["id"])
    lane_plan(data["stages"])  # refuses an unsafe lane plan before anything runs
    always = data.get("alwaysRunAll", [])
    if not isinstance(always, list) or not all(isinstance(x, str) for x in always):
        raise Refused("alwaysRunAll must be a list of path patterns")
    return data


def stage_ports(stage: dict) -> list[str]:
    """The port variables a stage is handed: its declared `ports`, else all of the gate's block."""
    declared = stage.get("ports")
    return list(PORT_VARS) if declared is None else list(declared)


def lane_groups(stages: list[dict]) -> list[list[list[dict]]]:
    """The execution schedule: a list of steps, each a list of lanes, each an ordered stage list.

    A stage without a `lane` is a barrier: it runs alone, after everything before it and before
    anything after it (setup and every build). Consecutive stages that carry a `lane` form one
    group; the stages of one lane run in declared order, the lanes of a group concurrently.
    """
    steps: list[list[list[dict]]] = []
    group: dict[str, list[dict]] = {}
    for item in stages:
        lane = item.get("lane")
        if lane is None:
            if group:
                steps.append(list(group.values()))
                group = {}
            steps.append([[item]])
        else:
            group.setdefault(lane, []).append(item)
    if group:
        steps.append(list(group.values()))
    return steps


def db_units(item: dict) -> int:
    """Connection units a stage draws from the shared budget (only fixture stages acquire any)."""
    units = item.get("dbConnections", 0)
    if isinstance(units, bool) or not isinstance(units, int) or units < 0:
        raise Refused(
            f"stage {item['id']!r}: dbConnections must be a non-negative integer"
        )
    return units if item.get("fixtures") else 0


def private_nx_state(work: Path, stage_id: str, nx_data: Path) -> dict[str, Path]:
    """Nx runtime state private to one lane (SA-116): a copy of the workspace data (the project
    graph and the SQLite task index, taken while no Nx process of this gate is running), its own
    temporary directory and its own socket directory. Only the cache artifact directory stays
    shared, so no two concurrent Nx processes ever share a database, a lock file or a socket."""
    root = work / f"nx-{stage_id}"
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(mode=0o700)
    shutil.copytree(nx_data, root / "data")
    (root / "tmp").mkdir(mode=0o700)
    # unix socket paths are short (about 100 characters): not under the work directory
    sock = Path(tempfile.mkdtemp(prefix="ci-nx-"))
    return {"root": root, "data": root / "data", "tmp": root / "tmp", "sock": sock}


def in_declared_order(entries: dict[str, dict], stages: list[dict]) -> list[dict]:
    """Entries in the declared stage order, whatever order the lanes finished in."""
    ids = [item["id"] for item in stages]
    return [entries[stage_id] for stage_id in sorted(entries, key=ids.index)]


def lane_plan(stages: list[dict]) -> list[dict]:
    """Validate the lane plan and describe each concurrent group (also stored in the receipt).

    Refused: a bad lane name, a lane without a measured `memoryMiB`, lane budgets (the largest
    stage of each lane, summed over the lanes of a group) above LANE_MEMORY_MIB, two lanes of a
    group that share a port variable, and two lanes that both draw from the database connection
    budget (two stages holding one unit each while waiting for the next could deadlock a gate).
    """
    for item in stages:
        lane = item.get("lane")
        if lane is not None and not (
            isinstance(lane, str) and LANE_NAME.fullmatch(lane)
        ):
            raise Refused(f"stage {item['id']!r}: invalid lane name {lane!r}")
        ports = item.get("ports")
        if ports is not None and not (
            isinstance(ports, list) and set(ports) <= set(PORT_VARS)
        ):
            raise Refused(f"stage {item['id']!r}: ports must be a list of {PORT_VARS}")
    groups = []
    for step in lane_groups(stages):
        if len(step) < 2:
            continue
        lanes = []
        for members in step:
            name = members[0]["lane"]
            for member in members:
                budget = member.get("memoryMiB")
                if (
                    not isinstance(budget, int)
                    or isinstance(budget, bool)
                    or budget <= 0
                ):
                    raise Refused(
                        f"stage {member['id']!r} runs in lane {name!r} and must declare a "
                        "positive integer memoryMiB"
                    )
            lanes.append(
                {
                    "lane": name,
                    "stages": [m["id"] for m in members],
                    "memoryMiB": max(m["memoryMiB"] for m in members),
                    "ports": sorted({p for m in members for p in stage_ports(m)}),
                    "dbConnections": sum(db_units(m) for m in members),
                }
            )
        total = sum(lane["memoryMiB"] for lane in lanes)
        if total > LANE_MEMORY_MIB:
            raise Refused(
                f"lane plan {[lane['lane'] for lane in lanes]} is budgeted for {total} MiB; "
                f"one gate admits {LANE_MEMORY_MIB} MiB (4.5 GiB of the 6 GiB job cap)"
            )
        seen_ports: dict[str, str] = {}
        for lane in lanes:
            for port in lane["ports"]:
                if port in seen_ports:
                    raise Refused(
                        f"lanes {seen_ports[port]!r} and {lane['lane']!r} share port variable {port}"
                    )
                seen_ports[port] = lane["lane"]
        if sum(1 for lane in lanes if lane["dbConnections"]) > 1:
            raise Refused(
                "at most one concurrent lane may draw from the database connection budget"
            )
        groups.append({"lanes": lanes, "memoryMiB": total})
    return groups


def argv_hash(stage: dict) -> str:
    canonical = json.dumps(
        {
            k: stage.get(k)
            for k in (
                "argv",
                "affected",
                "cwd",
                "env",
                "fixtures",
                "cache",
                "gradleBuildCache",
                "lane",
                "memoryMiB",
                "ports",
                "nxState",
            )
        },
        sort_keys=True,
    )
    return sha256_bytes(canonical.encode())


NX_DEFAULT = ["pnpm", "exec", "nx"]


def is_nx(argv: list[str], nx: list[str] | None = None) -> bool:
    nx = nx or NX_DEFAULT
    return argv[: len(nx)] == nx


def effective_argv(
    stage: dict, fresh: bool, argv: list[str] | None = None, nx: list[str] | None = None
) -> tuple[list[str], bool]:
    """Nx caching is decided by each target's own `cache` flag; only --fresh bypasses it.

    Integration and E2E targets declare `cache: false` in their project, so the runner
    no longer forces a cold dependency chain. Returns the argv and whether the cache is skipped.
    """
    argv = list(argv if argv is not None else stage["argv"])
    if not is_nx(argv, nx):
        return argv, False
    if fresh and "--skip-nx-cache" not in argv:
        argv.append("--skip-nx-cache")
    return argv, fresh


def fixture_task(stage: dict, argv: list[str]) -> str | None:
    """The requested task of a fixture-backed `nx run` stage (it must always execute)."""
    if not stage.get("fixtures") or not is_nx(argv) or argv[3:4] != ["run"]:
        return None
    return argv[4] if len(argv) > 4 else None


def cached_fixture_task(
    stage: dict, argv: list[str], cache: dict | None, selected: list[str] | None = None
) -> str | None:
    """The fixture task that did not provably execute: replayed from cache or never reported.

    Fails closed: when the Nx output carries no record of the task, it is reported too.
    An `affected` fixture stage must execute every task selected for it.
    """
    if selected is not None and stage.get("fixtures"):
        done = (cache or {}).get("executedTasks", [])
        targets = set((stage.get("affected") or {}).get("targets", []))
        replayed = [
            t
            for t in (cache or {}).get("hitTasks", [])
            if t.rpartition(":")[2] in targets
        ]
        if not selected and not replayed:
            # A running fixture stage with nothing selected means the affected computation
            # failed (graph unreadable): no task is known, so none is proven to have executed.
            return "no fixture task is selected, so none is proven to have executed"
        missing = [t for t in selected if t not in done]
        return ", ".join(missing + replayed) or None
    task = fixture_task(stage, argv)
    if task is None or task in (cache or {}).get("executedTasks", []):
        return None
    return task


ANSI = re.compile(r"\x1b\[[0-9;]*m")


class CacheScan:
    """Counts Nx tasks and local-cache hits from the stage's own output."""

    TASK = re.compile(r"^>\s+nx run (\S+)(.*)$")

    def __init__(self) -> None:
        self.partial = b""
        self.hit: list[str] = []
        self.executed: list[str] = []
        self.began = time.monotonic()
        self.starts: list[tuple[str, float, bool]] = []

    def feed(self, chunk: bytes) -> None:
        *lines, self.partial = (self.partial + chunk).split(b"\n")
        self.partial = self.partial[-4000:]
        for raw in lines:
            line = ANSI.sub("", raw.decode(errors="replace")).strip()
            match = self.TASK.match(line)
            if not match:
                continue
            rest = match[2]
            hit = (
                "[local cache]" in rest
                or "[remote cache]" in rest
                or "existing outputs match the cache" in rest
            )
            (self.hit if hit else self.executed).append(match[1])
            self.starts.append((match[1], time.monotonic() - self.began, hit))

    def timings(self) -> list[dict]:
        """Per Nx task: start offset in the stage and the span to the next task line (or to
        the end of the stage). With parallel Nx tasks the span is an upper bound."""
        end = time.monotonic() - self.began
        out = []
        for i, (task, start, hit) in enumerate(self.starts[:200]):
            nxt = self.starts[i + 1][1] if i + 1 < len(self.starts) else end
            out.append(
                {
                    "task": task,
                    "startSec": round(start, 2),
                    "spanSec": round(max(0.0, nxt - start), 2),
                    "cacheHit": hit,
                }
            )
        return out

    def summary(self) -> dict:
        return {
            "tasks": len(self.hit) + len(self.executed),
            "hits": len(self.hit),
            "hitTasks": self.hit[:2000],
            "executedTasks": self.executed[:2000],
            "taskTimings": self.timings(),
        }


# ------------------------------------------------------------------ affected set

SKIP_REASON = "skipped: unaffected"
AFFECTED_SCHEMA = "stateaction.local-ci.affected/1"


def glob_match(pattern: str, path: str) -> bool:
    """`**` crosses directories, `*` stays inside one path segment."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            out += ".*"
            i += 2
        elif pattern[i] == "*":
            out += "[^/]*"
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.fullmatch(out, path) is not None


def matched_always_run(patterns: list[str], files: list[str]) -> list[str]:
    return sorted({f for f in files if any(glob_match(p, f) for p in patterns)})


def changed_files(repo: Path, base: str, head: str) -> list[str]:
    out = git(repo, "diff", "--name-only", "--no-renames", "-z", base, head)
    return sorted(f for f in out.split("\0") if f)


def resolve_affected_base(
    repo: Path, head: str, base_ref: str = "refs/remotes/origin/main"
) -> tuple[str | None, str]:
    """The commit `nx affected` compares against, or why none can be trusted.

    The runner never guesses: a shallow clone or an unresolvable merge base means the whole
    suite runs. Because PRs are squashed, the base is origin/main (the head's direct parent).
    """
    if git(repo, "rev-parse", "--is-shallow-repository", check=False) == "true":
        return None, "shallow"
    base = git(repo, "merge-base", base_ref, head, check=False)
    return (base, "ok") if base else (None, "base-unresolved")


def nx_command(spec: dict) -> list[str]:
    return list(spec.get("nx") or NX_DEFAULT)


def stage_argv(
    spec: dict, stage: dict, *, base: str | None, head: str, run_all: bool
) -> list[str]:
    """The Nx command of an `affected` stage; stages without the key keep their own argv."""
    declared = stage.get("affected")
    if not declared:
        return list(stage["argv"])
    narrow = bool(base) and not run_all
    argv = [
        *nx_command(spec),
        "affected" if narrow else "run-many",
        "-t",
        ",".join(declared["targets"]),
    ]
    if declared.get("exclude"):
        argv.append(f"--exclude={declared['exclude']}")
    if narrow:
        argv += [f"--base={base}", f"--head={head}"]
    return argv + list(declared.get("args", []))


def make_nx(cmd: list[str], cwd: Path, env: dict[str, str], timeout: float = 600.0):
    """A callable running one Nx query; any failure is a Refused (the caller runs everything).

    `{out}` in an argument becomes a scratch file; with `output=` that JSON file is returned."""
    scratch = Path(tempfile.mkdtemp(prefix="nx-plan-", dir=env.get("TMPDIR")))

    def run(args: list[str], *, output: str | None = None):
        argv = [
            *cmd,
            *[a.replace("{out}", str(scratch / (output or ""))) for a in args],
        ]
        try:
            proc = subprocess.run(
                argv,
                cwd=cwd,
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Refused(f"nx query failed to run: {error}") from error
        if proc.returncode:
            raise Refused(
                f"nx {' '.join(args[:2])} failed: {proc.stderr.strip()[-300:]}"
            )
        if output:
            try:
                return json.loads((scratch / output).read_text())
            except (OSError, ValueError) as error:
                raise Refused(f"nx wrote no readable {output}: {error}") from error
        return proc.stdout

    run.scratch = scratch  # type: ignore[attr-defined]
    return run


def graph_projects(nx) -> dict[str, dict]:
    data = nx(["graph", "--file={out}"], output="graph.json")
    nodes = (data.get("graph") or {}).get("nodes")
    if not isinstance(nodes, dict) or not nodes:
        raise Refused("nx graph returned no projects")
    return {
        name: {
            "tags": sorted(node["data"].get("tags") or []),
            "targets": sorted((node["data"].get("targets") or {}).keys()),
        }
        for name, node in nodes.items()
    }


def excluded_projects(pattern: str | None, projects: dict[str, dict]) -> set[str]:
    """Nx `--exclude` semantics for the forms the stage file uses: names, `*`, `tag:x`, `!`."""
    excluded: set[str] = set()
    for raw in (pattern or "").split(","):
        item = raw.strip()
        if not item:
            continue
        negate = item.startswith("!")
        item = item.lstrip("!")
        if item == "*":
            hit = set(projects)
        elif item.startswith("tag:"):
            hit = {n for n, p in projects.items() if item[4:] in p["tags"]}
        else:
            hit = {item} & set(projects)
        excluded = excluded - hit if negate else excluded | hit
    return excluded


def candidate_tasks(declared: dict, projects: dict[str, dict]) -> list[str]:
    gone = excluded_projects(declared.get("exclude"), projects)
    return sorted(
        f"{name}:{target}"
        for name, info in projects.items()
        if name not in gone
        for target in declared["targets"]
        if target in info["targets"]
    )


def evidence_digest(block: dict) -> str:
    body = {k: v for k, v in block.items() if k != "evidenceSha256"}
    return sha256_bytes(json.dumps(body, sort_keys=True).encode())


def plan_affected(
    spec: dict,
    *,
    nx,
    repo: Path,
    head: str,
    base: str | None,
    base_problem: str = "base-unresolved",
) -> dict:
    """What the gate runs: the affected set, selected and skipped tasks per stage, the matched
    always-run-everything paths and an evidence hash. Fails wide, never narrow: an unresolved
    base, a failed Nx query or a matched path runs every stage."""
    patterns = spec.get("alwaysRunAll", [])
    computation, detail = ("ok", "") if base else (base_problem, "no usable base")
    changed: list[str] = []
    if base:
        try:
            changed = changed_files(repo, base, head)
        except Refused as error:
            computation, detail = "failed", str(error)
    matched = matched_always_run(patterns, changed)
    declared = [s for s in spec["stages"] if s.get("affected")]
    projects: dict[str, dict] = {}
    affected_projects: list[str] = []
    selection: dict[str, set[str]] = {}
    try:
        if declared:
            projects = graph_projects(nx)
        if computation == "ok" and not matched and declared:
            affected_projects = sorted(
                json.loads(
                    nx(
                        [
                            "show",
                            "projects",
                            "--affected",
                            f"--base={base}",
                            f"--head={head}",
                            "--json",
                        ]
                    )
                )
            )
            for stage in declared:
                data = nx(
                    [
                        "affected",
                        "-t",
                        ",".join(stage["affected"]["targets"]),
                        f"--base={base}",
                        f"--head={head}",
                        "--explain={out}",
                    ],
                    output=f"explain-{stage['id']}.json",
                )
                chosen_ids = set(data["affected"])
                unknown = chosen_ids - set(
                    candidate_tasks({**stage["affected"], "exclude": None}, projects)
                )
                if unknown:
                    raise Refused(
                        f"nx selected task ids the stage cannot map: {sorted(unknown)[:5]}"
                    )
                selection[stage["id"]] = chosen_ids
    except (Refused, ValueError, KeyError, TypeError) as error:
        computation, detail = "failed", f"{type(error).__name__}: {error}"
    run_all = bool(matched) or computation != "ok"
    if run_all:
        affected_projects = sorted(projects)
    stages: dict[str, dict] = {}
    for stage in spec["stages"]:
        declared_a = stage.get("affected")
        if not declared_a:
            stages[stage["id"]] = {"run": True, "selectedTasks": [], "skippedTasks": []}
            continue
        candidates = candidate_tasks(declared_a, projects) if projects else []
        if run_all:
            chosen, skipped = candidates, []
        else:
            chosen = [t for t in candidates if t in selection[stage["id"]]]
            skipped = [
                {"task": t, "reason": SKIP_REASON}
                for t in candidates
                if t not in selection[stage["id"]]
            ]
        stages[stage["id"]] = {
            "run": run_all or bool(chosen),
            "selectedTasks": chosen,
            "skippedTasks": skipped,
        }
    block = {
        "schema": AFFECTED_SCHEMA,
        "base": base,
        "head": head,
        "computation": computation,
        "computationDetail": detail[:400],
        "runAll": run_all,
        "matchedAlwaysRunPaths": matched,
        "changedFileCount": len(changed),
        "changedFilesSha256": sha256_bytes("\0".join(changed).encode()),
        "projects": affected_projects,
        "stages": stages,
    }
    block["evidenceSha256"] = evidence_digest(block)
    return block


def affected_declared(spec: dict) -> bool:
    return bool(spec.get("alwaysRunAll")) or any(
        s.get("affected") for s in spec["stages"]
    )


def link_history(repo: Path, export: Path) -> None:
    """Let the export's private git repository read the real repository's objects (an
    `objects/info/alternates` file, read-only), so Nx can diff base against head inside the
    export, which carries no history. Only this one repository sees them: the tasks' own
    throwaway repositories do not."""
    objects = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "objects")
    info = export / ".git" / "objects" / "info"
    info.mkdir(parents=True, exist_ok=True)
    (info / "alternates").write_text(objects + "\n")


# -------------------------------------------------------------------- environment


def _shim(directory: Path, name: str, body: str) -> None:
    path = directory / name
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)


def make_shims(directory: Path, uv_pin: str, which=shutil.which) -> None:
    """Docker/podman would escape the cgroup budget: refuse them for every stage."""
    for name in ("docker", "docker-compose", "podman"):
        _shim(
            directory,
            name,
            f'echo "{name}: disabled by local CI; use the bounded external fixtures" >&2\nexit 126\n',
        )
    uvx = which("uvx")
    uv = which("uv")
    version = ""
    if uv:
        with contextlib.suppress(Exception):
            version = subprocess.run(
                [uv, "--version"], capture_output=True, text=True
            ).stdout
    if pin_missing(version, uv_pin):
        if not uvx:
            raise Refused(f"uv {uv_pin} is required and uvx is unavailable")
        _shim(directory, "uv", f'exec "{uvx}" -q --from "uv=={uv_pin}" uv "$@"\n')


def pin_missing(version_output: str, pin: str) -> bool:
    return pin not in version_output


def tool_paths(env: dict[str, str], node_version: str) -> list[str]:
    home = Path(env.get("HOME", str(Path.home())))
    tools = Path(
        env.get("ROBOTICS_CAPTURE_TOOLS")
        or home / ".local/share/robotics-capture-tools"
    )
    paths = [
        home / ".nvm/versions/node" / f"v{node_version}" / "bin",
        tools / "flutter/bin",
        tools / "android-sdk/platform-tools",
        tools / "android-sdk/cmdline-tools/latest/bin",
    ]
    return [str(p) for p in paths if p.is_dir()]


def stage_env(
    base: dict[str, str],
    *,
    shim_dir: Path,
    node_version: str,
    stage: dict,
    fixtures: dict[str, str] | None = None,
    fixture_file: Path | None = None,
    tmp: Path,
    cache_dir: Path | None = None,
    workspace_data_dir: Path | None = None,
    skip_nx_cache: bool = True,
    gradle_cache: bool = False,
    ports: dict[str, str] | None = None,
) -> dict[str, str]:
    env = {
        k: v
        for k, v in base.items()
        if k not in GIT_ENV
        and not k.startswith("GIT_")
        and not SECRET_KEY.search(k)
        and k not in FIXTURE_KEYS
        and k not in ("STATEACTION_LOCAL_FIXTURES", "E2E_EXTERNAL_FIXTURES")
    }
    # Guard-provided build variables (JAVA_HOME, GRADLE_USER_HOME, ...) survive the
    # filter above because none of their names match the secret pattern.
    extra = tool_paths(env, node_version)
    env["PATH"] = os.pathsep.join([str(shim_dir), *extra, env.get("PATH", "")])
    env.update(
        CI="true",
        NX_DAEMON="false",
        NX_NO_CLOUD="true",
        NX_TUI="false",
        NX_PARALLEL="1",
        npm_config_workspace_concurrency="1",
        npm_config_child_concurrency="1",
        OMP_NUM_THREADS="2",
        OPENBLAS_NUM_THREADS="2",
        MKL_NUM_THREADS="2",
        NUMEXPR_NUM_THREADS="2",
        RAYON_NUM_THREADS="2",
        UV_CONCURRENT_DOWNLOADS="2",
        UV_CONCURRENT_BUILDS="1",
        UV_CONCURRENT_INSTALLS="2",
        CMAKE_BUILD_PARALLEL_LEVEL="2",
        MAKEFLAGS="-j2",
        UV_THREADPOOL_SIZE="2",
        GOMAXPROCS="2",
        NO_COLOR="1",
        TMPDIR=str(tmp),
        STATEACTION_REQUIRE_EXTERNAL_FIXTURES="1",
    )
    home = Path(env.get("HOME", str(Path.home())))
    tools = Path(
        env.get("ROBOTICS_CAPTURE_TOOLS")
        or home / ".local/share/robotics-capture-tools"
    )
    if (tools / "android-sdk").is_dir():
        env.update(
            ANDROID_HOME=str(tools / "android-sdk"),
            ANDROID_SDK_ROOT=str(tools / "android-sdk"),
        )
    if cache_dir is not None:
        # One private cache shared by every exported tree; correctness comes from Nx's
        # input hashes (sources, lockfiles, nx.json runtime/toolchain inputs), not paths.
        env["NX_CACHE_DIRECTORY"] = str(cache_dir)
    if workspace_data_dir is not None:
        # Nx indexes cache artifacts in a database kept with the workspace data; without a
        # stable location every fresh export would see the shared cache as "unrecognized".
        env["NX_WORKSPACE_DATA_DIRECTORY"] = str(workspace_data_dir)
    if skip_nx_cache:
        env["NX_SKIP_NX_CACHE"] = "true"
    # Every JVM (Gradle, test workers, Kotlin) sizes its thread pools from the CPU count;
    # the guard scope allows only 256 tasks (512 in a lane), so cap them like the 2-worker rule.
    jvm = "-XX:ActiveProcessorCount=2"
    if jvm not in env.get("JAVA_TOOL_OPTIONS", ""):
        env["JAVA_TOOL_OPTIONS"] = f"{env.get('JAVA_TOOL_OPTIONS', '')} {jvm}".strip()
    flag = f"-Dorg.gradle.caching={'true' if gradle_cache else 'false'}"
    env["GRADLE_OPTS"] = f"{env.get('GRADLE_OPTS', '')} {flag}".strip()
    if fixtures is not None and stage.get("fixtures") and fixture_file is not None:
        # Stages get only the path of a private, allow-listed 0600 copy; their own
        # bounded-fixture adapter creates and reaps run-owned databases/buckets.
        env["STATEACTION_LOCAL_FIXTURES"] = str(fixture_file)
        env["E2E_EXTERNAL_FIXTURES"] = str(fixture_file)
    env.update(
        ports or {}
    )  # per-run ports; a stage's own env may still pin one explicitly
    env.update({str(k): str(v) for k, v in (stage.get("env") or {}).items()})
    return env


# ---------------------------------------------------------------------- fixtures


def parse_env_file(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$", line)
        if match:
            values[match[1]] = re.sub(r"^(['\"])(.*)\1$", r"\2", match[2].strip())
    return values


def load_fixtures(path: str | None, *, probe=True) -> dict[str, str]:
    """Only an explicit file of loopback, synthetic fixtures; allow-listed keys only."""
    if not path:
        raise Refused(
            "Fixture-backed stages need STATEACTION_LOCAL_FIXTURES=<env file>; Docker is never started"
        )
    try:
        values = parse_env_file(Path(path).read_text())
    except OSError as error:
        raise Refused(f"Cannot read the fixture file: {error.strerror}") from error
    selected = {k: v for k, v in values.items() if k in FIXTURE_KEYS}
    for key in REQUIRED_FIXTURE_KEYS:
        if not selected.get(key):
            raise Refused(f"{key} missing from the fixture file")
    endpoints = []
    for key, value in selected.items():
        if key.endswith(("_URL", "_ENDPOINT")):
            parsed = urlparse(value)
            if parsed.hostname not in LOOPBACK or not parsed.port:
                raise Refused(f"{key} must be a loopback host with an explicit port")
            endpoints.append((parsed.hostname, parsed.port))
    if probe:
        for host, port in sorted(set(endpoints)):
            try:
                with socket.create_connection((host, port), timeout=3):
                    pass
            except OSError as error:
                raise Refused(
                    f"Fixture {host}:{port} is not reachable: {error.strerror}"
                ) from error
    return selected


def fixture_secrets(fixtures: dict[str, str]) -> list[str]:
    secrets_ = set()
    for key, value in fixtures.items():
        if SECRET_KEY.search(key) and len(value) >= 6:
            secrets_.add(value)
        if key.endswith("_URL"):
            password = urlparse(value).password
            if password and len(password) >= 6:
                secrets_.add(password)
    return sorted(secrets_, key=len, reverse=True)


def fixture_summary(fixtures: dict[str, str]) -> list[str]:
    seen = set()
    for key, value in fixtures.items():
        if key.endswith(("_URL", "_ENDPOINT")):
            parsed = urlparse(value)
            seen.add(f"{parsed.scheme}://{parsed.hostname}:{parsed.port}")
    return sorted(seen)


# ----------------------------------------------------------------------- children


class Interrupted(Refused):
    pass


class LaneStop(dict):
    """The stop state one stage's child sees: `process` is its own, `requested` is the signal
    flag of the whole run or the cancellation of its lane group (a sibling lane failed)."""

    def __init__(self, parent: dict, cancel: threading.Event) -> None:
        super().__init__(process=None)
        self.parent = parent
        self.cancel = cancel

    def get(self, key, default=None):
        if key == "requested":
            return bool(self.parent.get("requested") or self.cancel.is_set())
        return super().get(key, default)

    def __getitem__(self, key):
        return self.get(key) if key == "requested" else super().__getitem__(key)


def raise_open_file_limit() -> None:
    """Stages inherit the soft nofile of their parent. An agentqueue lane unit starts at 1024,
    which broke Chrome/Next/Nx in web-auth-e2e; plain shells and Free scopes get the hard limit."""
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if hard != resource.RLIM_INFINITY and soft < hard:
        resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))


def kill_group(process: subprocess.Popen, grace: float = 8.0) -> None:
    """Reap only the process group this runner created."""
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 5.0)):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process.pid, sig)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            # As a subreaper we inherit orphaned grandchildren; a killed one stays a zombie, and
            # a zombie keeps the group "alive", until someone waits for it. Reap them here
            # instead of waiting out both grace periods (13 s per timeout).
            # The group leader is left to `process`, whose exit code must stay intact.
            for pid, state in descendants(os.getpid()):
                if state == "Z" and pid != process.pid and _pgrp(pid) == process.pid:
                    with contextlib.suppress(ChildProcessError, OSError):
                        os.waitpid(pid, os.WNOHANG)
            if process.poll() is not None and not _group_alive(process.pid):
                return
            time.sleep(0.05)


def _pgrp(pid: int) -> int | None:
    try:
        stat = (Path("/proc") / str(pid) / "stat").read_text()
        return int(stat.rsplit(")", 1)[1].split()[2])
    except (OSError, IndexError, ValueError):
        return None


def _session(pid: int) -> int | None:
    try:
        stat = (Path("/proc") / str(pid) / "stat").read_text()
        return int(stat.rsplit(")", 1)[1].split()[3])
    except (OSError, IndexError, ValueError):
        return None


def in_stage(root: int):
    """Scope of one stage while other stages run beside it: its own session and process group
    (a stage runs in a session of its own). A daemon that left them is only provable at the end
    of the whole lane group."""

    def scope(pid: int) -> bool:
        return pid != root and (_session(pid) == root or _pgrp(pid) == root)

    return scope


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


LEAK_SETTLE_SEC = 2.0  # exiting descendants (Nx plugin workers) get this long before they count as leaked


def set_subreaper() -> None:
    """Orphaned descendants (even setsid daemons) re-parent to this runner."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise Refused(
            "Cannot become a child subreaper; exact process reaping cannot be proved"
        )


def descendants(root: int, proc: Path = Path("/proc")) -> list[tuple[int, str]]:
    """(pid, state) of every process below `root`, from the kernel's parent links."""
    children: dict[int, list[tuple[int, str]]] = {}
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            children.setdefault(int(fields[1]), []).append((int(entry.name), fields[0]))
        except (OSError, IndexError, ValueError):
            continue
    found, queue = [], [root]
    while queue:
        for pid, state in children.get(queue.pop(), []):
            found.append((pid, state))
            queue.append(pid)
    return found


def is_gradle_daemon(pid: int) -> bool:
    try:
        proc = Path("/proc") / str(pid)
        return (proc / "exe").resolve(
            strict=True
        ).name == "java" and b"org.gradle.launcher.daemon.bootstrap.GradleDaemon" in (
            proc / "cmdline"
        ).read_bytes().split(b"\0")
    except OSError:
        return False


def describe_process(pid: int) -> dict:
    """Evidence for one leaked process: command line, parent, state and age."""
    info: dict = {"pid": pid}
    proc = Path("/proc") / str(pid)
    with contextlib.suppress(OSError, IndexError, ValueError):
        fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
        info["state"], info["ppid"] = fields[0], int(fields[1])
        ticks = os.sysconf("SC_CLK_TCK")
        uptime = float(Path("/proc/uptime").read_text().split()[0])
        info["ageSec"] = round(uptime - int(fields[19]) / ticks, 2)
    with contextlib.suppress(OSError):
        raw = (proc / "cmdline").read_bytes().split(b"\0")
        info["cmdline"] = " ".join(a.decode(errors="replace") for a in raw if a)[:300]
    return info


def reap_subtree(
    root: int | None = None,
    grace: float = 8.0,
    *,
    gradle_shutdown: dict | None = None,
    settle: float = 0.0,
    details: list | None = None,
    transient: list | None = None,
    scope=None,
) -> int:
    """Terminate and reap everything below this runner; only its own descendants.

    `scope(pid)` narrows the check to one stage's processes while other stages run (SA-116).

    Returns how many live processes were found. Raises Refused when the subtree
    cannot be proved empty, so such a stage can neither pass nor be followed.
    `settle` is how long descendants that are still exiting on their own (no signal sent) get
    before they count as leaked: a process that is gone within `settle` seconds of the stage's
    own exit is not a leak, one that survives it is. `details` collects evidence per leaked process,
    `transient` the evidence of processes that were alive at first sight but exited within `settle`.
    """
    root = root or os.getpid()
    leaked: set[int] = set()
    settle_deadline = time.monotonic() + settle
    seen: dict[int, dict] = {}
    terminated = False
    shutdown_deadline = time.monotonic() + (5.0 if gradle_shutdown is not None else 0)
    deadline = (
        time.monotonic() + settle + grace
    )  # the settle window is not taken from grace
    while True:
        procs = [p for p in descendants(root) if scope is None or scope(p[0])]
        for pid, state in procs:
            if state == "Z":
                with contextlib.suppress(ChildProcessError, OSError):
                    os.waitpid(pid, os.WNOHANG)
        live = [pid for pid, state in procs if state != "Z"]
        if transient is not None:
            for pid in live:
                if pid not in seen:
                    seen[pid] = describe_process(pid)
        if not procs:
            if transient is not None:
                transient.extend(v for k, v in seen.items() if k not in leaked)
            return len(leaked)
        # Gradle's single-use daemon can still be closing its caches after the CLI exits.
        if (
            gradle_shutdown is not None
            and not gradle_shutdown.get("requested")
            and time.monotonic() < shutdown_deadline
            and all(is_gradle_daemon(pid) for pid in live)
        ):
            deadline = time.monotonic() + grace
            time.sleep(0.05)
            continue
        gradle_shutdown = None
        if live and not terminated and time.monotonic() < settle_deadline:
            time.sleep(0.02)
            continue
        if details is not None:
            details.extend(describe_process(pid) for pid in live if pid not in leaked)
        leaked.update(live)
        if live:
            sig = (
                signal.SIGKILL
                if terminated and time.monotonic() > deadline - grace / 2
                else signal.SIGTERM
            )
            for pid in live:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, sig)
            terminated = True
        if time.monotonic() > deadline:
            raise Refused(
                f"Could not prove that {len(procs)} descendant process(es) exited"
            )
        time.sleep(0.05)


def redact(text: bytes, secrets_: list[str]) -> bytes:
    for secret in secrets_:
        text = text.replace(secret.encode(), b"<redacted>")
    return text


def run_child(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log: Path,
    timeout: float,
    output_cap: int,
    secrets_: list[str],
    stop: dict,
    capture: bool = False,
    scan: "CacheScan | None" = None,
    wait_for_gradle: bool = False,
    cgroup: Path | None = None,
    concurrent: bool = False,
) -> dict:
    started = time.monotonic()
    # Raised in the runner itself and inherited by the child: `preexec_fn` is unsafe next to the
    # lane threads (it runs after a fork that may hold another thread's lock).
    raise_open_file_limit()
    cpu_before = cpu_seconds(cgroup)
    peak_seen = memory_current(cgroup) or 0
    anon_seen = memory_anon(cgroup) or 0
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as error:
        return {
            "status": "error",
            "exitCode": None,
            "detail": f"cannot start: {error.strerror}",
            "durationSec": 0.0,
        }
    stop["process"] = process
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    written = 0
    digest = hashlib.sha256()
    captured = bytearray()
    status = None
    tail = bytearray()
    with log.open("wb") as sink:
        os.fchmod(sink.fileno(), 0o600)
        while True:
            if stop.get("requested"):
                kill_group(process)
                status = "interrupted"
                break
            if time.monotonic() - started > timeout:
                kill_group(process)
                status = "timeout"
                break
            events = selector.select(timeout=0.25)
            peak_seen = max(peak_seen, memory_current(cgroup) or 0)
            anon_seen = max(anon_seen, memory_anon(cgroup) or 0)
            if events:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                chunk = redact(chunk, secrets_)
                digest.update(chunk)
                if scan is not None:
                    scan.feed(chunk)
                tail = (tail + chunk)[-4000:]
                if capture and len(captured) < 1_000_000:
                    captured += chunk
                if written + len(chunk) > output_cap:
                    sink.write(chunk[: max(0, output_cap - written)])
                    written = output_cap
                    kill_group(process)
                    status = "output-limit"
                    break
                sink.write(chunk)
                written += len(chunk)
            elif process.poll() is not None:
                break
    selector.close()
    code = process.poll()
    if code is None:
        kill_group(process)
        code = process.wait()
    with contextlib.suppress(Exception):
        process.stdout.close()
    stop["process"] = None
    leaked = 0
    leaked_details: list = []
    settled: list = []
    try:
        leaked = reap_subtree(
            gradle_shutdown=(
                stop if wait_for_gradle and status is None and code == 0 else None
            ),
            settle=LEAK_SETTLE_SEC,
            details=leaked_details,
            transient=settled,
            scope=in_stage(process.pid) if concurrent else None,
        )
    except Refused:
        status = "unreaped"
        leaked = len(leaked_details)
    for item in leaked_details + settled:
        if "cmdline" in item:
            item["cmdline"] = redact(item["cmdline"].encode(), secrets_).decode()
    if status is None:
        if stop.get("requested"):
            status = "interrupted"
        else:
            status = "passed" if code == 0 else "failed"
    if leaked and status == "passed":
        status = (
            "leaked-process"  # a daemon outliving its stage is a failure, never a pass
        )
    result = {
        "status": status,
        "exitCode": code,
        "durationSec": round(time.monotonic() - started, 2),
        "logBytes": written,
        "leakedProcesses": leaked,
        "leakedDetails": leaked_details,
        "settledProcesses": settled,
        "logSha256": digest.hexdigest(),
        "tail": tail.decode(errors="replace") if status != "passed" else "",
    }
    if scan is not None:
        result["cache"] = scan.summary()
    cpu_after = cpu_seconds(cgroup)
    cpu_used = (
        round(cpu_after - cpu_before, 2)
        if cpu_before is not None and cpu_after is not None
        else None
    )
    wall = round(time.monotonic() - started, 2)
    result["metrics"] = {
        "cpuSeconds": cpu_used,
        "wallSeconds": wall,
        "cpuPerWall": round(cpu_used / wall, 2)
        if cpu_used is not None and wall > 0
        else None,
        "peakMemorySampledBytes": peak_seen or None,
        "peakAnonSampledBytes": anon_seen or None,
        # the cgroup is shared: while other lanes run, cpu and memory are those of the whole gate
        "sharedWithLanes": concurrent,
        "scopePeakBytesAfter": peak_memory({"cgroup": str(cgroup)}) if cgroup else None,
    }
    if capture:
        result["captured"] = captured.decode(errors="replace")
    return result


# ------------------------------------------------------------------------- export


def current_tree(repo: Path, rev: str) -> str:
    return git(repo, "rev-parse", f"{rev}^{{tree}}")


def require_clean_for_tree(repo: Path, rev: str) -> None:
    if git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise Refused("--tree mode needs a clean checkout of the revision under test.")
    if git(repo, "rev-parse", "HEAD") != git(repo, "rev-parse", rev):
        raise Refused("--tree mode must test the checked-out HEAD.")


def export_tree(repo: Path, tree: str, destination: Path) -> None:
    destination.mkdir(mode=0o700)
    untar(["git", "archive", "--format=tar", tree], repo, destination)
    for line in git(repo, "ls-tree", "-r", "-z", tree).split("\0"):
        meta, _, path = line.partition("\t")
        if meta.startswith("160000"):
            export_submodule(repo, path, meta.split()[2], destination)


def submodule_pins(repo: Path, tree: str) -> dict[str, str]:
    pins = {}
    for line in git(repo, "ls-tree", "-r", "-z", tree).split("\0"):
        meta, _, path = line.partition("\t")
        if meta.startswith("160000"):
            pins[path] = meta.split()[2]
    return pins


def init_export_repo(export: Path) -> None:
    """Give the export a private index so `git ls-files` based stages behave as in a clone.

    Hooks are disabled for it; it shares nothing with the original repository.
    """
    for args in (
        ["init", "-q"],
        ["config", "core.hooksPath", "/dev/null"],
        ["config", "user.email", "local-ci@invalid"],
        ["config", "user.name", "local-ci"],
        ["add", "-A"],
    ):
        result = subprocess.run(
            ["git", "-C", str(export), *args],
            env=foreign_repo_env(),
            capture_output=True,
        )
        if result.returncode:
            raise Refused(f"Could not prepare the export repository ({args[0]}).")


def foreign_repo_env() -> dict[str, str]:
    """Hook-provided GIT_DIR/GIT_INDEX_FILE must not redirect git into another repo."""
    return {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


def untar(
    producer: list[str], cwd: Path, destination: Path, env: dict | None = None
) -> None:
    archive = subprocess.Popen(
        producer, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env
    )
    extract = subprocess.run(
        ["tar", "-x", "-C", str(destination)], stdin=archive.stdout, capture_output=True
    )
    archive.stdout.close()
    if archive.wait() or extract.returncode:
        raise Refused("Could not export the tree under test.")


def submodule_candidates(repo: Path, path: str) -> list[Path]:
    """Every place a pinned submodule's objects may live: this checkout, the shared git dir's
    modules, STATEACTION_LOCAL_CI_SUBMODULES, and every checkout of the same repository (git
    worktree list), so a fresh worktree needs no environment."""
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    candidates = [repo / path, common / "modules" / path]
    candidates += [
        Path(base) / path
        for base in os.environ.get("STATEACTION_LOCAL_CI_SUBMODULES", "").split(":")
        if base
    ]
    listing = subprocess.run(
        ["git", "-C", str(repo), "worktree", "list", "--porcelain"],
        capture_output=True,
        text=True,
        env=foreign_repo_env(),
    ).stdout
    candidates += [
        Path(line.split(" ", 1)[1]) / path
        for line in listing.splitlines()
        if line.startswith("worktree ")
    ]
    candidates.append(common.parent / path)
    return list(dict.fromkeys(candidates))


def find_submodule_source(repo: Path, path: str, sha: str) -> Path | None:
    for candidate in submodule_candidates(repo, path):
        if not candidate.is_dir():
            continue
        has = subprocess.run(
            ["git", "-C", str(candidate), "cat-file", "-e", f"{sha}^{{commit}}"],
            capture_output=True,
            env=foreign_repo_env(),
        )
        top = subprocess.run(
            ["git", "-C", str(candidate), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            env=foreign_repo_env(),
        )
        if (
            has.returncode == 0
            and top.returncode == 0
            and Path(top.stdout.strip()).resolve() == candidate.resolve()
        ):
            return candidate
    return None


def missing_submodules(repo: Path, tree: str) -> list[str]:
    """Fast preflight: pinned submodules no local repository can supply, each with its fix."""
    return [
        f"submodule {path} commit {sha[:12]} is in no local checkout: run "
        f"`git submodule update --init {path}` in the main checkout (or any worktree), "
        f"or set STATEACTION_LOCAL_CI_SUBMODULES=<directory containing {path}>"
        for path, sha in submodule_pins(repo, tree).items()
        if find_submodule_source(repo, path, sha) is None
    ]


def export_submodule(repo: Path, path: str, sha: str, destination: Path) -> bool:
    """Export the pinned gitlink commit when any local repository has it (optional)."""
    candidate = find_submodule_source(repo, path, sha)
    if candidate is None:
        return False
    target = destination / path
    target.mkdir(parents=True, exist_ok=True)
    untar(
        [
            "git",
            "--no-replace-objects",
            "-c",
            "core.attributesFile=/dev/null",
            "-C",
            str(candidate),
            "archive",
            "--format=tar",
            sha,
        ],
        repo,
        target,
        env=foreign_repo_env(),
    )
    return True


def fixture_services(fixtures: dict[str, str]) -> list[tuple[str, int]]:
    found = set()
    for key, value in fixtures.items():
        if key.endswith("_URL"):
            found.add(("postgres", urlparse(value).port))
        elif key.endswith("_ENDPOINT"):
            found.add(("storage", urlparse(value).port))
    return sorted(found)


def listener_pids(port: int) -> list[int]:
    """Owners of the loopback listener, from `ss` filtered to this exact port."""
    result = subprocess.run(
        ["ss", "-ltnpH", f"sport = :{port}"], capture_output=True, text=True, timeout=10
    )
    pids = set()
    for line in result.stdout.splitlines():
        fields = line.split()
        local = fields[3] if len(fields) > 3 else ""
        if local not in (f"127.0.0.1:{port}", f"[::1]:{port}"):
            raise Refused(f"Fixture port {port} listens beyond loopback ({local})")
        pids.update(int(p) for p in re.findall(r"pid=(\d+)", line))
    return sorted(pids)


def service_proof(
    role: str,
    port: int,
    *,
    listeners=listener_pids,
    proc: Path = Path("/proc"),
    cgroup: Path = Path("/sys/fs/cgroup"),
    policy_fetch=None,
) -> dict:
    """The external fixture server must itself sit in a finite, no-swap service cgroup."""
    scope = f"agent-service-{role}.scope"
    setup = f"Start it with `agent-resource serve --name {role} -- <server command>`."
    pids = listeners(port)
    if not pids:
        raise Refused(f"No loopback listener on fixture port {port}. {setup}")
    limit = None
    for pid in pids:
        try:
            relative = _read(proc / str(pid) / "cgroup").split("::", 1)[1]
            if f"/{SLICE}/" not in relative or not relative.endswith("/" + scope):
                raise Refused(f"Fixture port {port} is served outside {scope}. {setup}")
            group = cgroup / relative.lstrip("/")
            limit = _limit(_read(group / "memory.max"))
            slice_limit = _limit(_read(group.parent / "memory.max"))
            if limit > SERVICE_CAPS.get(role, GIB):
                raise Refused(
                    f"{scope} exceeds its {SERVICE_CAPS.get(role, GIB) / GIB:g} GiB service cap"
                )
            try:
                high = _read(group / "memory.high")
            except OSError:
                high = "max"
            if high != "max" and _limit(high) < limit:
                # A scope created by an old guard (768M high under a 1G max) throttled every gate
                # (SA-108); the current guard creates MemoryHigh == MemoryMax.
                raise Refused(
                    f"{scope} has memory.high {high} below its memory.max {limit} "
                    f"(throttle band). {setup}"
                )
            check_aggregate(slice_limit, policy_fetch)
            if (
                _read(group / "memory.swap.max") != "0"
                or _read(group.parent / "memory.swap.max") != "0"
            ):
                raise Refused(f"{scope} allows swap")
        except (OSError, IndexError, GuardError) as error:
            raise Refused(
                f"Cannot verify the cgroup of fixture port {port}: {error}. {setup}"
            ) from error
    return {
        "role": role,
        "port": port,
        "scope": scope,
        "pids": len(pids),
        "memoryMaxBytes": limit,
        "swapMaxBytes": 0,
    }


# ----------------------------------------------------------------------- pipeline


def _digest(path: Path) -> str:
    if path.is_symlink():
        return sha256_bytes(os.readlink(path).encode())
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def take_snapshot(
    repo: Path, tree: str, export: Path
) -> dict[str, tuple[int, int, str]]:
    """Content of every tracked (and submodule) file as exported, to detect rewrites."""
    listing = git(repo, "ls-tree", "-r", "-z", "--name-only", tree)
    names = [n for n in listing.split("\0") if n]
    snapshot: dict[str, tuple[int, int, str]] = {}
    for name in names:
        path = export / name
        if path.is_symlink() or path.is_file():
            stat_ = path.lstat()
            snapshot[name] = (stat_.st_size, stat_.st_mtime_ns, _digest(path))
    return snapshot


def modified_since(
    export: Path, snapshot: dict[str, tuple[int, int, str]]
) -> list[str]:
    changed = []
    for name, (size, mtime, digest) in snapshot.items():
        path = export / name
        try:
            stat_ = path.lstat()
        except OSError:
            changed.append(name)
            continue
        if (stat_.st_size, stat_.st_mtime_ns) != (size, mtime) and _digest(
            path
        ) != digest:
            changed.append(name)
    return changed


def acquire_slot(home: Path, parallel: int = MAX_PARALLEL) -> tuple[int, int]:
    """Own one private slot of the CI home: `(fd, index)`.

    Each slot owns its fixed export path, Nx cache and workspace data and a disjoint port
    block, so up to `parallel` gates on different trees never share mutable state. Receipts,
    attempts and logs are keyed by tree or run id and stay shared. Slot 0 keeps the historical
    `run.lock`, so a pre-SA-108 runner still excludes it."""
    for index in range(parallel):
        name = "run.lock" if index == 0 else f"run.{index}.lock"
        fd = os.open(home / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            continue
        return fd, index
    raise Refused("Another local CI run owns this CI home.")


def acquire_lock(home: Path) -> int:
    """First free slot's lock (see `acquire_slot`)."""
    return acquire_slot(home)[0]


def slot_dirs(home: Path, slot: int) -> tuple[Path, Path, Path]:
    """(work, nx cache, nx workspace data) of a slot; slot 0 keeps the historical names."""
    suffix = "" if slot == 0 else f"-s{slot}"
    work = private_dir(home / "work") / ("current" if slot == 0 else f"slot-{slot}")
    return (
        work,
        private_dir(home / f"nx-cache{suffix}"),
        private_dir(home / f"nx-workspace-data{suffix}"),
    )


def port_lock_dir() -> Path:
    """Machine-wide (per user) directory of the port-block locks."""
    explicit = os.environ.get("STATEACTION_CI_PORT_LOCKS")
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return Path(explicit) if explicit else Path(runtime) / "stateaction-ci-ports"


def acquire_port_block(directory: Path | None = None) -> tuple[int, int]:
    """Claim the first free port block machine-wide: `(fd, block)` (flock, released on exit)."""
    directory = private_dir(Path(directory) if directory else port_lock_dir())
    for block in range(MAX_PORT_BLOCKS):
        fd = os.open(
            directory / f"block-{block}.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
        )
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            continue
        return fd, block
    raise Refused("Every local CI port block on this machine is in use.")


def slot_ports(block: int, port_base: int = PORT_BASE) -> dict[str, str]:
    """A block of fixed loopback ports for the smoke stages (disjoint across blocks, below the
    ephemeral range so `bind(0)` never takes one). Exported to every stage."""
    base = port_base + PORT_STRIDE * block
    return {
        "STATEACTION_CI_PORT_BLOCK": str(block),
        "STATEACTION_CI_PORT_BASE": str(base),
        "HOSTED_SMOKE_WEB_PORT": str(base),
        "HOSTED_SMOKE_RUNNER_PORT": str(base + 1),
        "CI_SMOKE_WEB_PORT": str(base + 2),
        "CI_SMOKE_RUNNER_PORT": str(base + 3),
    }


def acquire_db_budget(
    units: int,
    directory: Path | None = None,
    *,
    timeout: float = DB_WAIT_SEC,
    capacity: int = DB_BUDGET,
    clock=time.monotonic,
    pause=time.sleep,
    cancelled=lambda: False,
) -> list[int]:
    """Take `units` of the machine-wide fixture-connection budget (one flock file per unit);
    returns the descriptors. All-or-nothing: a partial grant is released before waiting, so
    two gates can never hold half a budget each and starve one another."""
    if units > capacity:
        raise Refused(
            f"A stage needs {units} database connections; the budget is {capacity}."
        )
    directory = private_dir(Path(directory) if directory else port_lock_dir())
    deadline = clock() + timeout
    while True:
        held: list[int] = []
        # One scanner at a time (a short flock): two gates can never each grab part of the
        # budget and release it in lockstep.
        gate = os.open(
            directory / "db-gate.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
        )
        try:
            fcntl.flock(gate, fcntl.LOCK_EX)
            for unit in range(capacity):
                if len(held) == units:
                    break
                fd = os.open(
                    directory / f"db-{unit}.lock",
                    os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                    0o600,
                )
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    os.close(fd)
                    continue
                held.append(fd)
        except BaseException:
            for fd in held:
                os.close(fd)
            raise
        finally:
            os.close(gate)
        if len(held) == units:
            return held
        for fd in held:
            os.close(fd)
        if cancelled():
            raise Interrupted(
                "Cancelled while waiting for the database connection budget"
            )
        if clock() >= deadline:
            raise Refused(
                "Timed out waiting for the shared database connection budget."
            )
        pause(0.5 + random.random() * 0.5)


def acquire_tree_lock(home: Path, tree: str) -> int:
    """One gate per tree at a time: a second run of the same tree would invalidate the
    receipt and attempt record of the first (receipts and attempts are keyed by tree)."""
    directory = private_dir(home / "locks")
    fd = os.open(
        directory / f"{tree}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(fd)
        raise Refused(f"Tree {tree} is already being gated by another run.") from error
    return fd


def check_ports_free(ports: dict[str, str]) -> None:
    """Fail in seconds, before the export, when a foreign process holds one of the slot's ports."""
    for key, value in ports.items():
        if not key.endswith("_PORT"):
            continue
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("0.0.0.0", int(value)))
            except OSError as error:
                raise Refused(
                    f"Port {value} ({key}) of CI port block {ports['STATEACTION_CI_PORT_BLOCK']} is in use "
                    f"by another process: {error.strerror}"
                ) from error


def write_json_private(path: Path, data: dict) -> None:
    temporary = path.with_name(path.name + f".{secrets.token_hex(4)}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(data, file, indent=2, sort_keys=True)
        file.write("\n")
    os.replace(temporary, path)


def invalidate(home: Path, tree: str) -> None:
    """A new full attempt supersedes, and so removes, any earlier PASS for the tree."""
    (private_dir(home / "receipts") / f"{tree}.json").unlink(missing_ok=True)


def record_attempt(
    home: Path, tree: str, run_id: str, state: str, verdict: str | None = None
) -> None:
    write_json_private(
        private_dir(home / "attempts") / f"{tree}.json",
        {
            "tree": tree,
            "runId": run_id,
            "state": state,
            "verdict": verdict,
            "at": time.time(),
        },
    )


def receipt_digest(receipt: dict) -> str:
    body = {k: v for k, v in receipt.items() if k != "receiptSha256"}
    return sha256_bytes(json.dumps(body, sort_keys=True).encode())


def format_timing(record: dict) -> str:
    """Per-stage wall time table (PASS, FAIL or INTERRUPTED), for budgeting the gate. Stages in
    different lanes overlap: TOTAL is the gate's wall time, the stage seconds add up to more."""
    rows = [("stage", "status", "seconds", "cache hits", "lane", "window s")]
    for item in record["stages"]:
        cache = item.get("cache") or {}
        hit_text = f"{cache.get('hits', 0)}/{cache.get('tasks', 0)}" if cache else "-"
        start, end = item.get("startOffsetSec"), item.get("endOffsetSec")
        rows.append(
            (
                item["id"],
                item["status"],
                f"{item.get('durationSec', 0.0):.1f}",
                hit_text,
                item.get("lane") or "-",
                f"{start:.0f}-{end:.0f}"
                if start is not None and end is not None
                else "-",
            )
        )
    rows.append(
        (
            "TOTAL",
            record["verdict"],
            f"{record.get('wallSec', 0.0):.1f}",
            f"stage sum {record.get('totalDurationSec', 0.0):.1f}s",
            "",
            "",
        )
    )
    widths = [max(len(r[i]) for r in rows) for i in range(6)]
    lines = [
        "  ".join(
            c.ljust(w) if i in (0, 1, 4) else c.rjust(w)
            for i, (c, w) in enumerate(zip(r, widths))
        ).rstrip()
        for r in rows
    ]
    return "[local-ci] stage wall time\n" + "\n".join(lines)


def _median(values: list[float]) -> float | None:
    ordered = sorted(values)
    if not ordered:
        return None
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def timing_report(home: Path, last: int = 5) -> str:
    """Read-only per-stage table (wall, CPU, cpu/wall, peak memory) over the last N PASS runs.
    Runs recorded before the metrics existed show "not recorded"; unreadable counters are
    never reported as zero."""
    runs = []
    for path in sorted((home / "logs").glob("*/run.json"), reverse=True):
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if record.get("verdict") == "PASS":
            runs.append(record)
        if len(runs) >= last:
            break
    if not runs:
        return "[local-ci] no PASS runs recorded"
    rows = [("stage", "wall s", "cpu s", "cpu/wall", "peak MiB", "runs")]
    order: list[str] = []
    for record in runs:
        for stage in record["stages"]:
            if stage["id"] not in order:
                order.append(stage["id"])
    for stage_id in order:
        walls, cpus, ratios, peaks = [], [], [], []
        seen = 0
        for record in runs:
            for stage in record["stages"]:
                if stage["id"] != stage_id:
                    continue
                seen += 1
                walls.append(float(stage.get("durationSec") or 0.0))
                m = stage.get("metrics") or {}
                if m.get("cpuSeconds") is not None:
                    cpus.append(m["cpuSeconds"])
                    if m.get("cpuPerWall") is not None:
                        ratios.append(m["cpuPerWall"])
                peak = m.get("peakMemorySampledBytes") or m.get("scopePeakBytesAfter")
                if peak:
                    peaks.append(peak / 1048576)

        def cell(values: list[float], fmt: str) -> str:
            med = _median(values)
            return "not recorded" if med is None else fmt.format(med)

        rows.append(
            (
                stage_id,
                cell(walls, "{:.1f}"),
                cell(cpus, "{:.1f}"),
                cell(ratios, "{:.2f}"),
                cell(peaks, "{:.0f}"),
                str(seen),
            )
        )
    widths = [max(len(r[i]) for r in rows) for i in range(6)]
    body = "\n".join(
        "  ".join(
            c.ljust(w) if i == 0 else c.rjust(w)
            for i, (c, w) in enumerate(zip(r, widths))
        )
        for r in rows
    )
    walls = [float(r["wallSec"]) for r in runs if r.get("wallSec") is not None]
    gate = f"\ngate wall s (median): {_median(walls):.1f}" if walls else ""
    return f"[local-ci] median per stage over {len(runs)} PASS run(s)\n{body}{gate}"


def skipped_entry(stage: dict) -> dict:
    """A stage Nx proved unaffected: recorded, never confused with a stage that failed to run."""
    return {
        "id": stage["id"],
        "argvSha256": argv_hash(stage),
        "status": "skipped",
        "reason": SKIP_REASON,
        "exitCode": None,
        "durationSec": 0.0,
        "startedAt": None,
        "logBytes": 0,
        "logSha256": None,
        "fixtureBacked": bool(stage.get("fixtures")),
        "cacheMode": "none",
        "gradleBuildCache": False,
        "cache": None,
        "metrics": None,
    }


def compute_plan(
    spec: dict,
    *,
    repo: Path,
    head: str | None,
    export: Path,
    base_env: dict[str, str],
    shim_dir: Path,
    node_version: str,
    tmp: Path,
    nx_cache: Path,
    nx_data: Path,
    log=lambda message: None,
) -> dict:
    """Compute the affected plan inside the export, after setup installed Nx."""
    base, problem = (
        resolve_affected_base(repo, head) if head else (None, "base-unresolved")
    )
    env = stage_env(
        base_env,
        shim_dir=shim_dir,
        node_version=node_version,
        stage={},
        tmp=tmp,
        cache_dir=nx_cache,
        workspace_data_dir=nx_data,
        skip_nx_cache=False,
    )
    nx = make_nx(nx_command(spec), export, env)
    try:
        plan = plan_affected(
            spec, nx=nx, repo=repo, head=head or "", base=base, base_problem=problem
        )
    finally:
        shutil.rmtree(nx.scratch, ignore_errors=True)
    log(
        f"[local-ci] affected: base={plan['base']} computation={plan['computation']} "
        f"runAll={plan['runAll']} matched={plan['matchedAlwaysRunPaths']} "
        f"projects={len(plan['projects'])}"
    )
    return plan


def run_pipeline(
    repo: Path,
    *,
    rev: str = "HEAD",
    home: Path | None = None,
    guard: dict | None = None,
    keep_going: bool = False,
    keep_work: bool = False,
    fresh: bool = False,
    only: list[str] | None = None,
    docs_only: bool = True,
    fixtures_path: str | None = None,
    probe_fixtures: bool = True,
    runner_text: bytes | None = None,
    service_check=None,
    log=lambda message: print(message, file=sys.stderr, flush=True),
    install_signals: bool = True,
    ci_mode: str = "ci:local",
    port_base: int = PORT_BASE,
    probe_ports: bool = True,
    port_locks: Path | None = None,
) -> dict:
    """Run the declared stages. Returns the run record; receipt only when all passed."""
    repo = Path(repo).resolve()
    home = private_dir(Path(home) if home else local_ci_home())
    service_check = service_check or service_proof
    if guard is None:
        raise GuardError("A verified guard proof is required.")
    require_clean_for_tree(repo, rev)
    tree = current_tree(repo, rev)
    head = git(repo, "rev-parse", "HEAD", check=False) or None
    stages_text = blob(repo, tree, STAGES_PATH)
    if stages_text is None:
        raise Refused(f"{STAGES_PATH} is not part of the tree under test.")
    runner_in_tree = blob(repo, tree, RUNNER_PATH)
    runner_text = (
        runner_text if runner_text is not None else Path(__file__).read_bytes()
    )
    if runner_in_tree is None or sha256_bytes(runner_in_tree) != sha256_bytes(
        runner_text
    ):
        raise Refused(
            "The running local CI runner differs from the runner in the tree under test."
        )
    spec = load_stages(stages_text)
    stages = spec["stages"]
    if only:
        unknown = set(only) - {s["id"] for s in stages}
        if unknown:
            raise Refused(f"Unknown stage ids: {sorted(unknown)}")
        stages = [s for s in stages if s["id"] in only]
    base_sha = (
        git(repo, "rev-parse", "--verify", "refs/remotes/origin/main", check=False)
        or None
    )
    docs = None
    if docs_only and not only:
        commit = git(repo, "rev-parse", "--verify", f"{rev}^{{commit}}", check=False)
        docs = classify_diff(
            repo,
            base_sha,
            commit if commit and commit == head else "",
            spec.get("docsOnly"),
        )
        if docs["docsOnly"]:
            stages = docs_run_stages(spec)
        else:
            log(f"[local-ci] full suite: {docs['reason']}")
    lock_fd, slot = acquire_slot(home)
    held = [lock_fd]
    try:
        held.append(acquire_tree_lock(home, tree))
        port_fd, block = acquire_port_block(port_locks)
        held.append(port_fd)
        run_id = time.strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(3)
        invalidate(home, tree)
        record_attempt(home, tree, run_id, "running")
        # A fixed export path (we hold the slot lock) keeps path-sensitive build caches
        # such as Gradle's valid between runs; its content is always a fresh export.
        work, nx_cache, nx_data = slot_dirs(home, slot)
        ports = slot_ports(block, port_base)
        if work.exists():
            shutil.rmtree(work)
        logs = private_dir(home / "logs" / run_id)
        work.mkdir(mode=0o700)
        export = work / "tree"
        tmp = work / "tmp"
        tmp.mkdir(mode=0o700)
        shim_dir = work / "shims"
        shim_dir.mkdir(mode=0o700)
        pins = spec["pins"]
        nx_cmd = nx_command(spec)
        make_shims(shim_dir, pins["uv"])
    except BaseException:
        for fd in held:
            os.close(fd)
        raise
    tree_fd, port_fd = held[1], held[2]
    plan: dict | None = None
    fixtures = None
    services: list[dict] = []
    fixture_file = None
    secrets_: list[str] = []
    record = {
        "runId": run_id,
        "mode": "tree",
        "tree": tree,
        "head": head,
        "stages": [],
        "verdict": "FAIL",
        "logDir": str(logs),
        # Everything this run owns exclusively (SA-108): two concurrent runs must list
        # disjoint values for every key but `home`, `fixtureRunDirs` and `pid`-independent ones.
        "isolation": {
            "slot": slot,
            "portBlock": block,
            "pid": os.getpid(),
            "export": str(export),
            "tmp": str(tmp),
            "nxCache": str(nx_cache),
            "nxWorkspaceData": str(nx_data),
            "ports": {k: v for k, v in ports.items() if k.endswith("_PORT")},
        },
    }
    stop = {"process": None, "requested": False}
    crashed = False  # an unexpected exception propagates: no receipt follows
    previous: dict = {}
    if install_signals:

        def handler(signum, _frame):
            stop["requested"] = True
            stop["signal"] = signum

        for name in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[name] = signal.signal(name, handler)
    started_at = time.time()
    counters_start = flow_hook.guard_counters(guard)
    toolchain: dict[str, str] = {}
    live_stops_all: list[LaneStop] = []
    try:
        set_subreaper()
        if probe_ports:
            check_ports_free(ports)
        # Fixture health first: a dead PostgreSQL/S3 fixture or a missing service
        # cgroup proof fails in seconds, before the export and any stage.
        if any(s.get("fixtures") for s in stages):
            fixtures = load_fixtures(
                fixtures_path
                or os.environ.get("STATEACTION_LOCAL_FIXTURES")
                or os.environ.get("E2E_EXTERNAL_FIXTURES"),
                probe=probe_fixtures,
            )
            secrets_ = fixture_secrets(fixtures)
            for role, port in fixture_services(fixtures):
                services.append(service_check(role, port))
            fixture_file = work / "fixtures.env"
            fd = os.open(fixture_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as file:
                file.write("".join(f"{k}={v}\n" for k, v in sorted(fixtures.items())))
        export_tree(repo, tree, export)
        init_export_repo(export)
        link_history(repo, export)
        snapshot = take_snapshot(repo, tree, export)
        for item in stages:
            for needed in item.get("requiresPaths", []):
                if not (export / needed).exists():
                    raise Refused(
                        f"Stage {item['id']} needs {needed}, which is not in the exported tree. "
                        "Initialize the submodule or set STATEACTION_LOCAL_CI_SUBMODULES=<dir containing it>."
                    )
        epoch = time.monotonic()
        live_stops = live_stops_all
        plan_lock = threading.Lock()
        private_nx: dict[str, dict[str, Path]] = {}

        def run_stage(item: dict, lstop: "LaneStop", concurrent: bool) -> dict:
            """Run (or skip) one stage and return its entry; never touches `record`."""
            nonlocal plan, toolchain
            cwd = export / item.get("cwd", ".")
            selection = None
            built = None
            if item.get("affected"):
                with plan_lock:
                    if plan is None:
                        plan = compute_plan(
                            spec,
                            repo=repo,
                            head=head,
                            export=export,
                            base_env=os.environ.copy(),
                            shim_dir=shim_dir,
                            node_version=pins["node"],
                            tmp=tmp,
                            nx_cache=nx_cache,
                            nx_data=nx_data,
                            log=log,
                        )
                selection = plan["stages"][item["id"]]
                if not selection["run"]:
                    log(f"[local-ci] stage {item['id']}: {SKIP_REASON}")
                    return skipped_entry(item) | {"lane": item.get("lane")}
                built = stage_argv(
                    spec,
                    item,
                    base=plan["base"],
                    head=head,
                    run_all=plan["runAll"],
                )
            argv, skip_nx = effective_argv(item, fresh, built, nx_cmd)
            gradle_cache = bool(item.get("gradleBuildCache")) and not fresh
            env = stage_env(
                os.environ.copy(),
                shim_dir=shim_dir,
                node_version=pins["node"],
                stage=item,
                fixtures=fixtures,
                fixture_file=fixture_file,
                tmp=private_nx[item["id"]]["tmp"] if item["id"] in private_nx else tmp,
                cache_dir=nx_cache,
                workspace_data_dir=private_nx[item["id"]]["data"]
                if item["id"] in private_nx
                else nx_data,
                skip_nx_cache=skip_nx,
                gradle_cache=gradle_cache,
                ports={
                    k: v
                    for k, v in ports.items()
                    if not k.endswith("_PORT") or k in stage_ports(item)
                },
            )
            if item["id"] in private_nx:
                env["NX_SOCKET_DIR"] = str(private_nx[item["id"]]["sock"])
            if item.get("docsChanged"):
                changed = [p for e in docs["entries"] for p in e["paths"][-1:] if p]
                if item["docsChanged"] == "env":
                    env[DOCS_ENV] = "\n".join(sorted(set(changed)))
                    env[DOCS_REMOVED_ENV] = "\n".join(
                        sorted(
                            e["paths"][0]
                            for e in docs["entries"]
                            if e["status"][:1] in ("D", "R")
                        )
                    )
                else:
                    hit = guarded_tasks(
                        cwd, docs["paths"], env, spec["docsOnly"]["guardedTargets"]
                    )
                    if hit:
                        raise DocsOnlyUnsafe(
                            "changed docs are inputs of tasks a docs-only run skips: "
                            + ", ".join(hit)
                        )
                    docs["affectedProjects"] = affected_projects(
                        cwd, docs["paths"], env
                    )
                    argv = [*argv, "--files=" + ",".join(docs["paths"])]
            log(
                f"[local-ci] stage {item['id']}"
                + (f" (lane {item['lane']})" if concurrent else "")
                + f": {item['title']}"
            )
            budget: list[int] = []
            waited = 0.0
            if item.get("fixtures") and item.get("dbConnections"):
                began_wait = time.monotonic()
                try:
                    budget = acquire_db_budget(
                        int(item["dbConnections"]),
                        port_locks,
                        cancelled=lambda: bool(lstop.get("requested")),
                    )
                except Interrupted:
                    if stop["requested"]:
                        raise
                    # a sibling lane failed while this stage waited for its turn: it never ran
                    return not_run(item, "stopped while waiting: another lane failed")
                waited = time.monotonic() - began_wait
                if waited > 1:
                    log(
                        f"[local-ci] stage {item['id']} waited {waited:.0f}s for the shared "
                        f"database connection budget ({item['dbConnections']} of {DB_BUDGET})"
                    )
            began = time.time()
            began_offset = time.monotonic() - epoch
            try:
                result = run_child(
                    argv,
                    cwd=cwd,
                    env=env,
                    log=logs / f"{item['id']}.log",
                    timeout=float(item.get("timeoutSec", 1800)),
                    output_cap=int(item.get("maxOutputBytes", DEFAULT_OUTPUT_CAP)),
                    secrets_=secrets_,
                    stop=lstop,
                    capture=bool(item.get("capture")),
                    scan=CacheScan() if is_nx(argv, nx_cmd) else None,
                    wait_for_gradle=item["id"] == "mobile",
                    cgroup=Path(guard["cgroup"]) if guard.get("cgroup") else None,
                    concurrent=concurrent,
                )
            finally:
                for fd in budget:
                    os.close(fd)
            entry = {
                "id": item["id"],
                "lane": item.get("lane"),
                "argvSha256": argv_hash(item),
                "status": result["status"],
                "exitCode": result["exitCode"],
                "durationSec": result["durationSec"],
                "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(began)),
                "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "startOffsetSec": round(began_offset, 2),
                "endOffsetSec": round(time.monotonic() - epoch, 2),
                "logBytes": result.get("logBytes", 0),
                "logSha256": result.get("logSha256"),
                "fixtureBacked": bool(item.get("fixtures")),
                "cacheMode": "none"
                if skip_nx or not is_nx(argv, nx_cmd)
                else "none-by-target"
                if fixture_task(item, argv) or (selection and item.get("fixtures"))
                else "nx",
                "gradleBuildCache": gradle_cache,
                "cache": result.get("cache"),
                "metrics": result.get("metrics"),
                "dbBudgetWaitSec": round(waited, 1),
            }
            if entry["status"] == "interrupted" and not stop["requested"]:
                # stopped because a sibling lane failed, not by a signal: it did not finish
                entry["status"] = "cancelled"
                entry["detail"] = "stopped because another lane failed"
            if item.get("capture") == "toolchain" and "captured" in result:
                toolchain = {
                    k.removeprefix("toolchain:"): v.strip()
                    for k, _, v in (
                        line.partition("=") for line in result["captured"].splitlines()
                    )
                    if k.startswith("toolchain:") and v
                }
            # The tree under test must be exactly what is being committed.
            observed = current_tree(repo, rev)
            if observed != tree and result["status"] == "passed":
                entry["status"] = "tree-changed"
                entry["detail"] = (
                    f"tree changed from {tree} to {observed} during the run"
                )
            rewritten = modified_since(export, snapshot)
            replayed = cached_fixture_task(
                item,
                argv,
                result.get("cache"),
                selection["selectedTasks"] if selection else None,
            )
            if replayed and entry["status"] == "passed":
                entry["status"] = "cached-fixture"
                entry["detail"] = (
                    f"fixture-backed task {replayed} was replayed from cache "
                    "or missing from the Nx run output"
                )
            if selection is not None and entry["status"] == "passed":
                ran = set((result.get("cache") or {}).get("executedTasks", [])) | set(
                    (result.get("cache") or {}).get("hitTasks", [])
                )
                absent = [t for t in selection["selectedTasks"] if t not in ran]
                if absent:
                    entry["status"] = "plan-mismatch"
                    entry["detail"] = (
                        "Nx did not report these planned tasks: "
                        + ", ".join(absent[:10])
                    )
            if rewritten and entry["status"] == "passed":
                entry["status"] = "source-modified"
                entry["detail"] = "stage rewrote tracked source: " + ", ".join(
                    rewritten[:10]
                )
            if result.get("settledProcesses"):
                entry["settledProcesses"] = result["settledProcesses"]
            if result.get("leakedProcesses"):
                entry["leakedProcesses"] = result["leakedProcesses"]
                entry["leakedDetails"] = result.get("leakedDetails", [])
            if entry["status"] not in ("passed", "cancelled") and result.get("tail"):
                log(redact(result["tail"].encode(), secrets_).decode(errors="replace"))
            return entry

        def not_run(item: dict, reason: str) -> dict:
            """A stage that never started: recorded as such, never as passed."""
            return {
                "id": item["id"],
                "lane": item.get("lane"),
                "argvSha256": argv_hash(item),
                "status": "not-run",
                "reason": reason,
                "exitCode": None,
                "durationSec": 0.0,
                "startedAt": None,
                "logBytes": 0,
                "logSha256": None,
                "fixtureBacked": bool(item.get("fixtures")),
                "cacheMode": "none",
                "gradleBuildCache": False,
                "cache": None,
                "metrics": None,
            }

        def run_group(step: list[list[dict]]) -> dict[str, dict]:
            """Run the lanes of one group concurrently inside this gate; stop the rest of the
            group as soon as one stage fails (unless keep_going)."""
            for members in step:
                for item in members:
                    if item.get("nxState") == "private":
                        private_nx[item["id"]] = private_nx_state(
                            work, item["id"], nx_data
                        )
            cancel = threading.Event()
            entries: dict[str, dict] = {}
            errors: list[BaseException] = []
            lock = threading.Lock()
            finished = threading.Event()
            peak = {"current": 0, "anon": 0}
            cgroup = Path(guard["cgroup"]) if guard.get("cgroup") else None
            group_began = time.monotonic()

            def watch() -> None:
                while not finished.wait(0.25):
                    peak["current"] = max(peak["current"], memory_current(cgroup) or 0)
                    peak["anon"] = max(peak["anon"], memory_anon(cgroup) or 0)

            def lane(members: list[dict]) -> None:
                lstop = LaneStop(stop, cancel)
                with lock:
                    live_stops.append(lstop)
                for item in members:
                    if cancel.is_set() or stop["requested"]:
                        break
                    try:
                        entry = run_stage(item, lstop, True)
                    except BaseException as error:  # reported by the scheduler thread
                        with lock:
                            errors.append(error)
                        cancel.set()
                        break
                    with lock:
                        entries[item["id"]] = entry
                    if entry["status"] not in ("passed", "skipped") and not keep_going:
                        cancel.set()

            watcher = threading.Thread(target=watch, daemon=True)
            watcher.start()
            workers = [
                threading.Thread(target=lane, args=(members,), name=members[0]["lane"])
                for members in step
            ]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join()
            finished.set()
            watcher.join()
            # Orphaned daemons cannot be tied to one lane; after the group they are leaks of it.
            leaked_details: list = []
            gradle_ran = any(
                e["status"] == "passed" and e["id"] == "mobile"
                for e in entries.values()
            )
            try:
                leaked = reap_subtree(
                    settle=LEAK_SETTLE_SEC,
                    details=leaked_details,
                    gradle_shutdown=stop if gradle_ran else None,
                )
                unreaped = False
            except Refused:
                leaked, unreaped = len(leaked_details), True
            for entry in entries.values():
                if (leaked or unreaped) and entry["status"] == "passed":
                    entry["status"] = "unreaped" if unreaped else "leaked-process"
                    entry["leakedProcesses"] = leaked
                    entry["leakedDetails"] = leaked_details
                    entry["detail"] = (
                        "a process outlived its lane group and cannot be tied to one "
                        "stage of it; every stage that had passed is failed"
                    )
            for item in (i for members in step for i in members):
                if item["id"] not in entries:
                    entries[item["id"]] = not_run(
                        item, "a stage in another lane failed first"
                    )
            record.setdefault("lanes", []).append(
                {
                    "lanes": [
                        {
                            "lane": members[0]["lane"],
                            "stages": [i["id"] for i in members],
                            "memoryMiB": max(i["memoryMiB"] for i in members),
                        }
                        for members in step
                    ],
                    "wallSec": round(time.monotonic() - group_began, 2),
                    "peakMemoryBytes": peak["current"] or None,
                    "peakAnonBytes": peak["anon"] or None,
                    "admittedMemoryMiB": LANE_MEMORY_MIB,
                }
            )
            pending.extend(errors)
            for state in private_nx.values():
                shutil.rmtree(state["root"], ignore_errors=True)
                shutil.rmtree(state["sock"], ignore_errors=True)
            private_nx.clear()
            return entries

        pending: list[BaseException] = []
        halted = False
        for step in lane_groups(stages):
            if halted:
                for members in step:
                    for item in members:
                        record["stages"].append(
                            not_run(item, "an earlier stage did not pass")
                        )
                continue
            if stop["requested"]:
                record["stages"].append(
                    {"id": step[0][0]["id"], "status": "interrupted"}
                )
                raise Interrupted("Cancelled before stage " + step[0][0]["id"])
            if len(step) == 1:
                lstop = LaneStop(stop, threading.Event())
                live_stops.append(lstop)
                entries = {}
                for item in step[0]:
                    entries[item["id"]] = run_stage(item, lstop, False)
                    if entries[item["id"]]["status"] not in ("passed", "skipped") and (
                        not keep_going
                    ):
                        break
            else:
                entries = run_group(step)
            order = [i["id"] for members in step for i in members]
            record["stages"].extend(in_declared_order(entries, stages))
            if pending:
                raise pending[0]  # entries of the finished stages are recorded first
            interrupted = [e for e in entries.values() if e["status"] == "interrupted"]
            if interrupted:
                raise Interrupted("Cancelled during stage " + interrupted[0]["id"])
            if len(step) > 1 and stop["requested"]:
                raise Interrupted("Cancelled during the lane group")
            if not keep_going and any(
                e["status"] not in ("passed", "skipped") for e in entries.values()
            ):
                halted = True
                for stage_id in order:
                    if stage_id not in entries:
                        record["stages"].append(
                            not_run(
                                next(i for i in stages if i["id"] == stage_id),
                                "an earlier stage did not pass",
                            )
                        )
        passed = [s for s in record["stages"] if s["status"] in ("passed", "skipped")]
        complete = len(passed) == len(stages) == len(record["stages"])
        final = current_tree(repo, rev)
        if final != tree:
            complete = False
            record["detail"] = "tree changed during the run"
        if complete and only:
            complete = False
            record["detail"] = "partial stage selection never produces a PASS receipt"
        record["verdict"] = "PASS" if complete else "FAIL"
    except Interrupted as error:
        record["verdict"] = "INTERRUPTED"
        record["detail"] = str(error)
    except DocsOnlyUnsafe as error:
        record["verdict"] = "FAIL"
        record["detail"] = str(error)
        record["fallbackFull"] = True
    except Refused as error:
        record["verdict"] = "FAIL"
        record["detail"] = str(error)
    except BaseException as error:  # never leave a half-trusted result
        crashed = True
        record["verdict"] = "FAIL"
        record["detail"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        for lstop in live_stops_all:
            if lstop.get("process") is not None:
                kill_group(lstop["process"])
        for name, handler_ in previous.items():
            signal.signal(name, handler_)
        with contextlib.suppress(Refused):
            reap_subtree()
        record["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        record["totalDurationSec"] = round(
            sum(s.get("durationSec", 0.0) for s in record["stages"]), 2
        )
        record["wallSec"] = round(time.time() - started_at, 2)
        peak = peak_memory(guard)
        record["guard"] = {
            **{k: v for k, v in guard.items() if k != "cgroup"},
            "peakMemoryBytes": peak,
            "counters": {
                "start": counters_start,
                "end": flow_hook.guard_counters(guard),
            },
        }
        if not keep_work and work.resolve().parent == (home / "work").resolve():
            shutil.rmtree(work, ignore_errors=True)
        os.close(lock_fd)
        os.close(port_fd)
        if crashed:
            os.close(tree_fd)
        write_json_private(logs / "run.json", record)
        log(format_timing(record))
    if record.get("fallbackFull"):
        record_attempt(home, tree, run_id, "finished", "FAIL")
        os.close(tree_fd)  # the full-suite run below takes the tree lock itself
        log(f"[local-ci] {record['detail']}; running the full suite instead")
        return run_pipeline(
            repo,
            rev=rev,
            home=home,
            guard=guard,
            keep_going=keep_going,
            keep_work=keep_work,
            fresh=fresh,
            only=only,
            docs_only=False,
            port_base=port_base,
            probe_ports=probe_ports,
            port_locks=port_locks,
            ci_mode=ci_mode,
            fixtures_path=fixtures_path,
            probe_fixtures=probe_fixtures,
            runner_text=runner_text,
            service_check=service_check,
            log=log,
            install_signals=install_signals,
        )
    if record["verdict"] == "PASS":
        receipt = {
            "schema": RECEIPT_SCHEMA,
            "verdict": "PASS",
            "mode": "tree",
            "tree": tree,
            "head": head,
            "base": {"ref": "origin/main", "sha": base_sha},
            "stagesSha256": sha256_bytes(stages_text),
            "runnerSha256": sha256_bytes(runner_text),
            "stages": [
                {
                    k: s.get(k)
                    for k in (
                        "id",
                        "argvSha256",
                        "status",
                        "exitCode",
                        "durationSec",
                        "lane",
                        "startedAt",
                        "finishedAt",
                        "startOffsetSec",
                        "endOffsetSec",
                        "logSha256",
                        "fixtureBacked",
                        "cacheMode",
                        "gradleBuildCache",
                        "cache",
                    )
                }
                | {"metrics": s.get("metrics"), "reason": s.get("reason")}
                for s in record["stages"]
            ],
            "lanePlan": lane_plan(stages),
            "lanes": record.get("lanes", []),
            "affected": plan,
            "toolchain": toolchain,
            "toolchainSha256": sha256_bytes(
                json.dumps(toolchain, sort_keys=True).encode()
            ),
            "fresh": fresh,
            "totalDurationSec": round(
                sum(s["durationSec"] for s in record["stages"]), 2
            ),
            "guard": record["guard"],
            "fixtures": fixture_summary(fixtures) if fixtures else [],
            "fixtureServices": services,
            "submodules": submodule_pins(repo, tree),
            "requirementsSha256": sha256_bytes(
                blob(repo, tree, "requirements-stera.txt") or b""
            ),
            "unautomated": spec.get("unautomated", []),
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at)),
            "finishedAt": record["finishedAt"],
            "runId": run_id,
            "logDir": str(logs),
        }
        if docs and docs["docsOnly"]:
            ran = [s["id"] for s in stages]
            evidence = {
                "changedPaths": docs["paths"],
                "affectedProjects": docs.get("affectedProjects", []),
            }
            receipt["mode"] = DOCS_MODE
            receipt["docsOnly"] = {
                "ruleVersion": spec["docsOnly"]["version"],
                "ruleSha256": rule_sha256(spec["docsOnly"]),
                "mergeBase": docs["mergeBase"],
                "changed": docs["entries"],
                **evidence,
                "setup": spec["docsOnly"]["setupStages"],
                "checks": [c["id"] for c in spec["docsOnly"]["checks"]],
            }
            receipt["skipped"] = [
                {"id": s["id"], "status": "skipped: unaffected", "evidence": evidence}
                for s in spec["stages"]
                if s["id"] not in ran
            ]
        receipt["receiptSha256"] = receipt_digest(receipt)
        receipts = private_dir(home / "receipts")
        write_json_private(receipts / f"{tree}.json", receipt)
        record["receipt"] = str(receipts / f"{tree}.json")
    record_attempt(home, tree, run_id, "finished", record["verdict"])
    os.close(tree_fd)  # the tree stays locked until its receipt and attempt are written
    flow_hook.report_ci_run(record, repo=repo, mode=ci_mode)
    return record


# ------------------------------------------------------------------- verification


def receipt_fixture_problem(
    stage: dict, item: dict, selected: list[str] | None = None
) -> str | None:
    """Why a receipt entry does not prove its fixture task(s) executed uncached."""
    if selected is not None and stage.get("fixtures"):
        ran = (item.get("cache") or {}).get("executedTasks") or []
        if not (
            selected
            and item.get("fixtureBacked")
            and item.get("cacheMode") in ("none", "none-by-target")
            and all(t in ran for t in selected)
        ):
            return f"lacks proof that {', '.join(selected)} executed uncached"
        return None
    task = fixture_task(stage, stage.get("argv") or [])
    if task and not (
        item.get("fixtureBacked")
        and item.get("cacheMode") in ("none", "none-by-target")
        and task in ((item.get("cache") or {}).get("executedTasks") or [])
    ):
        return f"lacks proof that {task} executed uncached"
    return None


def docs_receipt_problems(
    repo: Path,
    receipt: dict,
    spec: dict,
    head_sha: str,
    base_sha: str,
    affected,
    guarded,
) -> list[str]:
    """Recompute a docs-only receipt's classification and affected set from the head."""
    rule = spec.get("docsOnly")
    info = receipt.get("docsOnly") or {}
    if not rule:
        return ["the stage list declares no docs-only rule"]
    errors = []
    if info.get("ruleSha256") != rule_sha256(rule):
        errors.append("docs-only rule changed since the receipt")
    if git(repo, "rev-parse", f"{head_sha}^", check=False) != base_sha:
        errors.append("docs-only head's parent is not the latest origin/main")
    if (
        info.get("mergeBase") != base_sha
        or (receipt.get("base") or {}).get("sha") != base_sha
    ):
        errors.append(
            "docs-only receipt names a base other than the latest origin/main"
        )
    now = classify_diff(repo, base_sha, head_sha, rule)
    if not now["docsOnly"]:
        errors.append(f"recomputed classification is not docs-only: {now['reason']}")
    elif (
        info.get("changed") != now["entries"]
        or info.get("changedPaths") != now["paths"]
    ):
        errors.append("receipt changed-path list differs from the recomputed diff")
    ran = set(rule["setupStages"]) | {c["id"] for c in rule["checks"]}
    expected = [s["id"] for s in spec["stages"] if s["id"] not in ran]
    skipped = receipt.get("skipped")
    if (
        not isinstance(skipped, list)
        or [s.get("id") for s in skipped if isinstance(s, dict)] != expected
    ):
        errors.append("receipt skipped stages are not exactly the stages not run")
    else:
        evidence = {
            "changedPaths": info.get("changedPaths"),
            "affectedProjects": info.get("affectedProjects"),
        }
        for item in skipped:
            if (
                item.get("status") != "skipped: unaffected"
                or item.get("evidence") != evidence
            ):
                errors.append(
                    f"skipped stage {item.get('id')} lacks its unaffected evidence"
                )
    if now["docsOnly"]:
        try:
            if affected is None or guarded is None:
                if git(repo, "rev-parse", "HEAD^{tree}", check=False) != git(
                    repo, "rev-parse", f"{head_sha}^{{tree}}"
                ):
                    raise Refused("the head is not checked out")
                nx_env = {**os.environ, "NX_DAEMON": "false"}
                affected = affected or (
                    lambda r, paths: affected_projects(r, paths, nx_env)
                )
                guarded = guarded or (
                    lambda r, paths: guarded_tasks(
                        r, paths, nx_env, rule["guardedTargets"]
                    )
                )
            recomputed = affected(repo, now["paths"])
            selected = guarded(repo, now["paths"])
        except (Refused, OSError, subprocess.SubprocessError) as error:
            errors.append(f"cannot recompute the affected set: {error}")
        else:
            if selected:
                errors.append(
                    "changed docs select tasks the receipt skipped: "
                    + ", ".join(selected)
                )
            if recomputed != info.get("affectedProjects"):
                errors.append(
                    "recomputed affected set selects tasks the receipt skipped: "
                    f"{recomputed} != {info.get('affectedProjects')}"
                )
    return errors


def default_verify_nx(repo: Path, spec: dict):
    if (
        nx_command(spec) == NX_DEFAULT
        and not (repo / "node_modules" / ".bin" / "nx").exists()
    ):
        raise Refused(
            "node_modules is missing: run `pnpm install --frozen-lockfile` so the "
            "affected set can be reproduced"
        )
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(NX_DAEMON="false", NX_NO_CLOUD="true", NX_TUI="false", CI="true")
    return make_nx(nx_command(spec), repo, env)


def affected_problems(
    repo: Path,
    spec: dict,
    receipt: dict,
    head_sha: str,
    base_sha: str,
    items: dict[str, dict],
    nx=None,
) -> list[str]:
    """Reproduce the receipt's affected set from the head versus the base; fail closed."""
    block = receipt.get("affected")
    if not isinstance(block, dict):
        return ["receipt lacks the affected set the stage list requires"]
    errors: list[str] = []
    if block.get("evidenceSha256") != evidence_digest(block):
        errors.append("affected evidence hash does not match the recorded affected set")
    if block.get("base") != base_sha:
        errors.append(
            "affected base is not the latest origin/main (the head's direct parent)"
        )
    if block.get("head") != head_sha:
        errors.append("affected head differs from the head under verification")
    try:
        changed = changed_files(repo, base_sha, head_sha)
    except Refused as error:
        return errors + [f"cannot recompute the changed files: {error}"]
    matched = matched_always_run(spec.get("alwaysRunAll", []), changed)
    if block.get("changedFilesSha256") != sha256_bytes("\0".join(changed).encode()):
        errors.append("recorded changed files differ from the head versus its base")
    if block.get("matchedAlwaysRunPaths") != matched:
        errors.append(
            f"always-run paths differ: recomputed {matched}, receipt "
            f"{block.get('matchedAlwaysRunPaths')}"
        )
    stages = block.get("stages") or {}
    if set(stages) != {s["id"] for s in spec["stages"]}:
        errors.append("affected stage records differ from the declared stages")
    ran_all = bool(matched) or block.get("computation") != "ok"
    if ran_all and not block.get("runAll"):
        errors.append(
            "affected set was narrowed despite an always-run path or a failed computation"
        )
    if block.get("runAll") and not ran_all:
        errors.append("run-everything recorded without an always-run path or a failure")
    for stage in spec["stages"]:
        record = stages.get(stage["id"]) or {}
        item = items.get(stage["id"]) or {}
        ran = item.get("status") == "passed"
        skipped = item.get("status") == "skipped"
        if block.get("runAll") and not ran:
            errors.append(
                f"stage {stage['id']} was skipped although everything must run"
            )
        if bool(record.get("run")) != ran or (not ran and not skipped):
            errors.append(f"stage {stage['id']} status contradicts the affected record")
        if skipped and item.get("reason") != SKIP_REASON:
            errors.append(f"stage {stage['id']} skipped without the unaffected reason")
    if errors or block.get("runAll"):
        return errors
    if nx is None:
        if git(repo, "rev-parse", "HEAD", check=False) != head_sha or git(
            repo, "status", "--porcelain", check=False
        ):
            return [
                "affected set could not be reproduced: the checkout is not a clean "
                "copy of the head under verification"
            ]
        try:
            nx = default_verify_nx(repo, spec)
        except Refused as error:
            return [f"affected set could not be reproduced: {error}"]
    try:
        again = plan_affected(spec, nx=nx, repo=repo, head=head_sha, base=base_sha)
    except Refused as error:
        return [f"affected set could not be reproduced: {error}"]
    finally:
        shutil.rmtree(getattr(nx, "scratch", "/nonexistent"), ignore_errors=True)
    if again["computation"] != "ok" or again["runAll"]:
        return [
            "affected set could not be reproduced "
            f"({again['computation']}: {again['computationDetail']})"
        ]
    if again != block:
        diff = [k for k in again if again.get(k) != block.get(k)]
        return [f"recomputed affected set differs from the receipt ({', '.join(diff)})"]
    return []


def verify_receipt(
    repo: Path,
    head: str = "HEAD",
    *,
    home: Path | None = None,
    base_ref: str = "refs/remotes/origin/main",
    require_single_commit: bool = True,
    affected=None,
    guarded=None,
    nx=None,
) -> list[str]:
    """Return the reasons the receipt cannot authorize merging `head` (empty = valid)."""
    repo = Path(repo).resolve()
    errors: list[str] = []
    head_sha = git(repo, "rev-parse", "--verify", f"{head}^{{commit}}", check=False)
    base_sha = git(repo, "rev-parse", "--verify", base_ref, check=False)
    if not head_sha:
        return [f"{head} is not a commit"]
    if not base_sha:
        return ["origin/main is unknown; fetch it first"]
    tree = git(repo, "rev-parse", f"{head_sha}^{{tree}}")
    path = (home or local_ci_home()) / "receipts" / f"{tree}.json"
    try:
        receipt = json.loads(path.read_text())
    except (OSError, ValueError):
        return [
            f"no PASS receipt for tree {tree}; run `pnpm ci:local` on the clean rebased head"
        ]
    if receipt.get("schema") != RECEIPT_SCHEMA or receipt.get("verdict") != "PASS":
        errors.append("receipt is not a PASS receipt of the supported schema")
    if receipt.get("receiptSha256") != receipt_digest(receipt):
        errors.append("receipt digest does not match its content")
    if receipt.get("toolchainSha256") != sha256_bytes(
        json.dumps(receipt.get("toolchain", {}), sort_keys=True).encode()
    ):
        errors.append("receipt toolchain record is inconsistent")
    if receipt.get("tree") != tree:
        errors.append("receipt tree differs from the head tree")
    try:
        attempt = json.loads(
            (
                private_dir(home or local_ci_home()) / "attempts" / f"{tree}.json"
            ).read_text()
        )
    except (OSError, ValueError):
        attempt = {}
    if (
        attempt.get("runId") != receipt.get("runId")
        or attempt.get("state") != "finished"
        or attempt.get("verdict") != "PASS"
    ):
        errors.append(
            "a newer attempt on this tree superseded or invalidated the receipt"
        )
    docs_mode = receipt.get("mode") == DOCS_MODE
    if (
        receipt.get("mode") not in ("tree", DOCS_MODE)
        or receipt.get("head") != head_sha
    ):
        errors.append(
            "receipt was produced for a different commit context; run `pnpm ci:local` on this head"
        )
    stages_text = blob(repo, head_sha, STAGES_PATH)
    runner_text = blob(repo, head_sha, RUNNER_PATH)
    if stages_text is None or runner_text is None:
        return errors + ["the head does not contain the local CI runner and stage list"]
    if receipt.get("stagesSha256") != sha256_bytes(stages_text):
        errors.append("stage list changed since the receipt")
    if receipt.get("runnerSha256") != sha256_bytes(runner_text):
        errors.append("runner changed since the receipt")
    try:
        spec = load_stages(stages_text)
        stage_list = docs_run_stages(spec) if docs_mode else spec["stages"]
        declared = {s["id"]: argv_hash(s) for s in stage_list}
    except (Refused, ValueError, KeyError, TypeError) as error:
        return errors + [f"stage list invalid: {error}"]
    got = {s.get("id"): s for s in receipt.get("stages", [])}
    try:
        if receipt.get("lanePlan") != lane_plan(stage_list):
            errors.append("receipt lane plan differs from the declared lane plan")
    except Refused as error:
        errors.append(f"declared lane plan refused: {error}")
    if list(got) != list(declared):
        errors.append("receipt stages do not equal the declared stages in order")
    affected_on = affected_declared(spec)
    selected_by_stage = {
        k: v.get("selectedTasks")
        for k, v in ((receipt.get("affected") or {}).get("stages") or {}).items()
    }
    for stage_id, digest in declared.items():
        item = got.get(stage_id)
        skipped_ok = bool(
            affected_on
            and next((x for x in stage_list if x["id"] == stage_id), {}).get("affected")
            and item
            and item.get("status") == "skipped"
            and item.get("reason") == SKIP_REASON
        )
        if (
            not item
            or (item.get("status") != "passed" and not skipped_ok)
            or item.get("argvSha256") != digest
        ):
            errors.append(f"stage {stage_id} did not pass with the declared command")
            continue
        declared_lane = next((x for x in stage_list if x["id"] == stage_id), {}).get(
            "lane"
        )
        if item.get("lane") != declared_lane:
            errors.append(
                f"stage {stage_id} ran in lane {item.get('lane')!r}, declared {declared_lane!r}"
            )
        if skipped_ok:
            continue
        stage_spec = next((x for x in stage_list if x["id"] == stage_id), {"argv": []})
        problem = receipt_fixture_problem(
            stage_spec,
            item,
            selected_by_stage.get(stage_id) if stage_spec.get("affected") else None,
        )
        if problem:
            errors.append(f"stage {stage_id} {problem}")
    if docs_mode:
        errors += docs_receipt_problems(
            repo, receipt, spec, head_sha, base_sha, affected, guarded
        )
    ancestor_ok = (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", base_sha, head_sha], cwd=repo
        ).returncode
        == 0
    )
    if affected_on and ancestor_ok and not docs_mode:
        errors += affected_problems(repo, spec, receipt, head_sha, base_sha, got, nx)
    guard = receipt.get("guard", {})
    if not (
        0 < guard.get("memoryMaxBytes", 0) <= JOB_MAX and guard.get("swapMaxBytes") == 0
    ):
        errors.append("receipt lacks verified guard limits")
    if not ancestor_ok:
        errors.append(
            "head does not contain the latest origin/main (rebase and re-run)"
        )
    elif require_single_commit:
        if git(repo, "rev-list", "--count", f"{base_sha}..{head_sha}") != "1":
            errors.append(
                "head must be exactly one commit above origin/main (squash locally)"
            )
        if git(repo, "rev-list", "--merges", f"{base_sha}..{head_sha}"):
            errors.append("head contains a merge commit")
        if git(repo, "rev-parse", f"{head_sha}^") != base_sha:
            errors.append("head's parent is not the latest origin/main")
    return errors


# ---------------------------------------------------------------------- merge


OWNER_LOGIN = "timothywangdev"


def _repository_slug() -> str:
    """The one place code reads the GitHub repository slug (config/repository.json)."""
    path = Path(__file__).resolve().parents[2] / "config" / "repository.json"
    return json.loads(path.read_text())["slug"]


GITHUB_REPO = _repository_slug()
GH_TOKEN_SET_BY_TOOL = {"value": False}


def resolve_owner_credential(run=subprocess.run, environ=None, say=None) -> str:
    """Pin every later `gh` call of this process to timothywangdev (the default gh account on
    this workstation is another one). Order: GH_TOKEN if it belongs to the owner, else the
    owner's keyring token (`gh auth token --user`); it is exported as GH_TOKEN (and
    `GH_TOKEN_SET_BY_TOOL` records that, so a re-exec can drop it again). Errors name the
    exact fix and fail fast, before any rebase, push or gate."""
    environ = os.environ if environ is None else environ
    say = say or (lambda message: print(message, file=sys.stderr, flush=True))

    def gh(argv, **kw):
        try:
            return run(["gh", *argv], capture_output=True, text=True, timeout=60, **kw)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Refused(
                f"`gh` is unusable ({type(error).__name__}): install the GitHub CLI and run "
                f"`gh auth login` as {OWNER_LOGIN}"
            ) from error

    def login(token: str) -> str:
        out = gh(["api", "user", "--jq", ".login"], env={**environ, "GH_TOKEN": token})
        return out.stdout.strip() if out.returncode == 0 else ""

    given = environ.get("GH_TOKEN", "")
    given_login = login(given) if given else ""
    if given_login == OWNER_LOGIN:
        return given
    keyring = gh(["auth", "token", "--user", OWNER_LOGIN])
    token = keyring.stdout.strip() if keyring.returncode == 0 else ""
    if not token:
        raise Refused(
            f"no GitHub credential for {OWNER_LOGIN}: run `gh auth login` as {OWNER_LOGIN} "
            f"(check `gh auth status`), or export GH_TOKEN=<a {OWNER_LOGIN} token>"
        )
    who = login(token)
    if who != OWNER_LOGIN:
        raise Refused(
            f"the stored gh credential for {OWNER_LOGIN} is rejected or belongs to "
            f"{who or 'nobody'}: run `gh auth login` again as {OWNER_LOGIN}"
        )
    if given:
        say(
            f"[local-ci] GH_TOKEN belongs to {given_login or 'no valid account'}, not "
            f"{OWNER_LOGIN}: using the {OWNER_LOGIN} keyring credential instead"
        )
    environ["GH_TOKEN"] = token
    if environ is os.environ:
        GH_TOKEN_SET_BY_TOOL["value"] = True
    return token


def gh_json(*args: str) -> object:
    result = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise Refused(f"gh {args[0]} failed: {result.stderr.strip()[:300]}")
    return json.loads(result.stdout or "null")


class MergedOnUntestedBase(Refused):
    """The merge happened but not exactly on the tested base/tree: fatal, never retried."""


def check_merged_commit(
    github_repo: str, number: int, base: str, head_tree: str, api=None
) -> dict:
    """GitHub has no atomic expected-base guard: prove the result after the fact."""
    api = api or gh_json
    merged = api("api", f"repos/{github_repo}/pulls/{number}")
    sha = str(merged.get("merge_commit_sha") or "")
    if not merged.get("merged") or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise MergedOnUntestedBase("GitHub does not report a merged squash commit.")
    commit = api("api", f"repos/{github_repo}/commits/{sha}")
    parents = [parent.get("sha") for parent in commit.get("parents") or []]
    tree = (commit.get("commit") or {}).get("tree", {}).get("sha")
    if parents != [base] or tree != head_tree:
        raise MergedOnUntestedBase(
            f"FATAL: squash commit {sha} has parents {parents} and tree {tree}; "
            f"expected parent [{base}] and tree {head_tree}. main moved in the final "
            "interval or the content differs. Stop the merge queue and investigate; "
            "nothing was retried, reset or rewritten."
        )
    return {"mergeSha": sha, "parent": base, "tree": tree}


def merge_pr(
    repo: Path,
    number: int,
    *,
    github_repo: str,
    execute: bool,
    home: Path | None = None,
) -> int:
    """Verify the receipt for the exact head, then merge under the merge lock.

    The caller already holds the project's `ci` lane ticket (main enters it), so merges
    are serialized by the lane; the merge lock is the leaf lock that also covers any other
    lander on this machine. Verification, the merge and the tree postcondition
    (`check_merged_commit`: squash parent is the verified base, tree equals the tested
    head tree) all happen while it is held. `--match-head-commit` pins the head.
    """
    if not execute:  # read-only: no lock, no ticket
        return _merge_pr(
            repo, number, github_repo=github_repo, execute=False, home=home
        )
    with merge_lock(home):
        return _merge_pr(repo, number, github_repo=github_repo, execute=True, home=home)


MERGE_LOCK_WAIT_SEC = 900.0


@contextlib.contextmanager
def merge_lock(
    home: Path | None = None,
    *,
    timeout: float = MERGE_LOCK_WAIT_SEC,
    sleep=time.sleep,
    clock=time.monotonic,
):
    """Leaf lock (after the ci ticket): one landing at a time per CI home, bounded wait."""
    directory = private_dir(home or local_ci_home())
    fd = os.open(
        directory / "merge.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    deadline = clock() + timeout
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if clock() >= deadline:
                    raise Refused(
                        "Another merge holds the merge lock; nothing was merged."
                    ) from None
                sleep(1.0)
        yield
    finally:
        os.close(fd)


def _merge_pr(
    repo: Path,
    number: int,
    *,
    github_repo: str,
    execute: bool,
    home: Path | None = None,
) -> int:
    """Validate then squash merge. Never pushes main and never fakes a status."""
    sys.path.insert(0, str(Path(repo) / "scripts/automation"))
    import github_policy  # noqa: PLC0415  (repository module, stdlib only)

    resolve_owner_credential()
    owner = gh_json("api", "user")["login"]
    if owner != "timothywangdev":
        raise Refused(
            "Active GitHub account must be timothywangdev for this repository."
        )
    git(repo, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main")
    pr = gh_json("api", f"repos/{github_repo}/pulls/{number}")
    pages = gh_json(
        "api",
        "--paginate",
        "--slurp",
        f"repos/{github_repo}/pulls?state=all&per_page=100",
    )
    pulls = [item for page in pages for item in page]
    ticket = github_policy.validate_pr(pr, github_repo, pulls)
    if pr.get("draft"):
        raise Refused("PR is a draft.")
    head = git(repo, "rev-parse", "HEAD")
    if pr["head"]["sha"] != head:
        raise Refused(
            "PR head is not the locally verified HEAD; push the rebased head first."
        )
    errors = verify_receipt(repo, head, home=home)
    if errors:
        raise Refused("Local receipt rejected: " + "; ".join(errors))
    command = [
        "gh",
        "pr",
        "merge",
        str(number),
        "--repo",
        github_repo,
        "--squash",
        "--match-head-commit",
        head,
        "--subject",
        f"{pr['title']} (#{number})",
        "--body",
        github_policy.primary_declaration(pr),
    ]
    print(
        json.dumps(
            {"ticket": ticket, "head": head, "execute": execute, "command": command[:6]}
        )
    )
    if not execute:
        print("Dry run: receipt valid; re-run with --execute to squash merge.")
        return 0
    # Last look immediately before the merge: same head, clean tree, receipt still valid.
    git(repo, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main")
    if git(repo, "rev-parse", "HEAD") != head or git(
        repo, "status", "--porcelain", "--untracked-files=no"
    ):
        raise Refused("HEAD or the working tree changed during verification.")
    errors = verify_receipt(repo, head, home=home)
    if errors:
        raise Refused("Local receipt rejected at merge time: " + "; ".join(errors))
    base = git(repo, "rev-parse", "refs/remotes/origin/main")
    head_tree = git(repo, "rev-parse", f"{head}^{{tree}}")
    # Base check immediately before the merge call (the postcondition below detects, this prevents).
    if git(repo, "rev-parse", f"{head}^") != base:
        raise Refused(
            "origin/main moved: the head is no longer directly above it; rebase and rerun."
        )
    subprocess.run(command, check=True, timeout=300)
    print(json.dumps(check_merged_commit(github_repo, number, base, head_tree)))
    return 0


# -------------------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--tree", metavar="REV", required=True)
    run.add_argument("--keep-going", action="store_true")
    run.add_argument(
        "--fresh", action="store_true", help="bypass every cache (cold evidence run)"
    )
    run.add_argument("--keep-work", action="store_true")
    run.add_argument(
        "--full",
        action="store_true",
        help="run the full suite even when the diff is docs-only",
    )
    run.add_argument(
        "--only", action="append", help="debug only; never yields a receipt"
    )
    verify = sub.add_parser("verify")
    verify.add_argument("--head", default="HEAD")
    timing = sub.add_parser(
        "timing", help="read-only per-stage medians of recent PASS runs"
    )
    timing.add_argument("--last", type=int, default=5)
    merge = sub.add_parser("merge")
    merge.add_argument("--pr", type=int, required=True)
    merge.add_argument("--repo", default=GITHUB_REPO)
    merge.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "timing":
        print(timing_report(local_ci_home(), args.last))
        return 0
    try:
        repo = Path(git(Path.cwd(), "rev-parse", "--show-toplevel"))
        if args.command == "verify":
            git(
                repo,
                "fetch",
                "origin",
                "+refs/heads/main:refs/remotes/origin/main",
                check=False,
            )
            errors = verify_receipt(repo, args.head)
            print(json.dumps({"valid": not errors, "errors": errors}, indent=2))
            return 0 if not errors else 1
        if args.command == "merge":
            if args.execute:  # a dry run is read-only and never queues behind a gate
                head_tree = git(repo, "rev-parse", "HEAD^{tree}")
                ensure_guard(
                    [str(Path(__file__).resolve()), *argv],
                    key=ticket_key(
                        f"ci-merge-{args.pr}",
                        head_tree,
                        [str(Path(__file__).resolve()), *argv],
                    ),
                )
            return merge_pr(repo, args.pr, github_repo=args.repo, execute=args.execute)
        guard = ensure_guard(
            [str(Path(__file__).resolve()), *argv],
            key=ticket_key(
                "ci-local",
                git(repo, "rev-parse", args.tree + "^{tree}"),
                [str(Path(__file__).resolve()), *argv],
            ),
        )
        record = run_pipeline(
            repo,
            rev=args.tree,
            guard=guard,
            keep_going=args.keep_going,
            keep_work=args.keep_work,
            fresh=args.fresh,
            only=args.only,
            docs_only=not args.full,
        )
    except MergedOnUntestedBase as error:
        print(f"LOCAL CI FATAL: {error}", file=sys.stderr)
        return 3
    except Refused as error:
        print(f"LOCAL CI REFUSED: {error}", file=sys.stderr)
        return 75
    summary = {
        k: record.get(k) for k in ("verdict", "tree", "detail", "receipt", "logDir")
    }
    summary["stages"] = [(s["id"], s["status"]) for s in record["stages"]]
    summary["peakMemoryBytes"] = record["guard"]["peakMemoryBytes"]
    print(json.dumps(summary, indent=2))
    return (
        0
        if record["verdict"] == "PASS"
        else 130
        if record["verdict"] == "INTERRUPTED"
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
