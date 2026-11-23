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
import time
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import flow_hook  # noqa: E402

GIB = 1024**3
JOB_MAX = 6 * GIB
TOTAL_MAX = 12 * GIB  # legacy installed guard
AGG_MAX = 24 * GIB  # only with a positive policy proof
CI_LANE = "ci"
CI_SCOPE = re.compile(r"agent-lane-ci-[0-9a-f]{8}\.scope")
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
    if not (
        report.get("ok") is True
        and report.get("watchdogPolicyActive") is True
        and report.get("kernelSwapMax") == "0"
        and report.get("kernelMemoryMaxBytes") == slice_max
        and report.get("recordedCapBytes") == slice_max
    ):
        raise GuardError(
            "aggregate cap above 12 GiB is not proved by a current policy-2 watchdog "
            "and a recorded cap equal to the kernel cap with zero swap"
        )
    return {
        "capBytes": slice_max,
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


def load_stages(text: bytes) -> dict:
    data = json.loads(text)
    if data.get("schema") != STAGES_SCHEMA or not data.get("stages"):
        raise Refused("stages.json has an unknown schema or no stages")
    seen = set()
    for stage in data["stages"]:
        if stage["id"] in seen or not stage.get("argv"):
            raise Refused(f"invalid or duplicate stage {stage.get('id')!r}")
        seen.add(stage["id"])
    return data


def argv_hash(stage: dict) -> str:
    canonical = json.dumps(
        {
            k: stage.get(k)
            for k in ("argv", "cwd", "env", "fixtures", "cache", "gradleBuildCache")
        },
        sort_keys=True,
    )
    return sha256_bytes(canonical.encode())


def is_nx(argv: list[str]) -> bool:
    return argv[:3] == ["pnpm", "exec", "nx"]


def effective_argv(stage: dict, fresh: bool) -> tuple[list[str], bool]:
    """Nx caching is decided by each target's own `cache` flag; only --fresh bypasses it.

    Integration and E2E targets declare `cache: false` in their project, so the runner
    no longer forces a cold dependency chain. Returns the argv and whether the cache is skipped.
    """
    argv = list(stage["argv"])
    if not is_nx(argv):
        return argv, False
    if fresh and "--skip-nx-cache" not in argv:
        argv.append("--skip-nx-cache")
    return argv, fresh


def fixture_task(stage: dict, argv: list[str]) -> str | None:
    """The requested task of a fixture-backed `nx run` stage (it must always execute)."""
    if not stage.get("fixtures") or not is_nx(argv) or argv[3:4] != ["run"]:
        return None
    return argv[4] if len(argv) > 4 else None


def cached_fixture_task(stage: dict, argv: list[str], cache: dict | None) -> str | None:
    """The fixture task that did not provably execute: replayed from cache or never reported.

    Fails closed: when the Nx output carries no record of the task, it is reported too.
    """
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
            "hitTasks": self.hit[:200],
            "executedTasks": self.executed[:200],
            "taskTimings": self.timings(),
        }


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
) -> int:
    """Terminate and reap everything below this runner; only its own descendants.

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
        procs = descendants(root)
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
) -> dict:
    started = time.monotonic()
    cpu_before = cpu_seconds(cgroup)
    peak_seen = memory_current(cgroup) or 0
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            preexec_fn=raise_open_file_limit,
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
            if limit > GIB:
                raise Refused(f"{scope} exceeds its 1 GiB service cap")
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


def acquire_lock(home: Path) -> int:
    """One run per CI home: it owns the fixed export path and the shared caches."""
    fd = os.open(home / "run.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(fd)
        raise Refused("Another local CI run owns this CI home.") from error
    return fd


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
    """Per-stage wall time table (PASS, FAIL or INTERRUPTED), for budgeting the gate."""
    rows = [("stage", "status", "seconds", "cache hits")]
    for item in record["stages"]:
        cache = item.get("cache") or {}
        hit_text = f"{cache.get('hits', 0)}/{cache.get('tasks', 0)}" if cache else "-"
        rows.append(
            (
                item["id"],
                item["status"],
                f"{item.get('durationSec', 0.0):.1f}",
                hit_text,
            )
        )
    rows.append(
        (
            "TOTAL",
            record["verdict"],
            f"{record.get('totalDurationSec', 0.0):.1f}",
            f"wall {record.get('wallSec', 0.0):.1f}s",
        )
    )
    widths = [max(len(r[i]) for r in rows) for i in range(4)]
    lines = [
        "  ".join(
            c.ljust(w) if i in (0, 1) else c.rjust(w)
            for i, (c, w) in enumerate(zip(r, widths))
        )
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
    return f"[local-ci] median per stage over {len(runs)} PASS run(s)\n{body}"


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
    lock_fd = acquire_lock(home)
    run_id = time.strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(3)
    invalidate(home, tree)
    record_attempt(home, tree, run_id, "running")
    # A fixed export path (we hold the CI-home lock) keeps path-sensitive build caches
    # such as Gradle's valid between runs; its content is always a fresh export.
    work = private_dir(home / "work") / "current"
    if work.exists():
        shutil.rmtree(work)
    nx_cache = private_dir(home / "nx-cache")
    nx_data = private_dir(home / "nx-workspace-data")
    logs = private_dir(home / "logs" / run_id)
    work.mkdir(mode=0o700)
    export = work / "tree"
    tmp = work / "tmp"
    tmp.mkdir(mode=0o700)
    shim_dir = work / "shims"
    shim_dir.mkdir(mode=0o700)
    pins = spec["pins"]
    make_shims(shim_dir, pins["uv"])
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
    }
    stop = {"process": None, "requested": False}
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
    try:
        set_subreaper()
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
        snapshot = take_snapshot(repo, tree, export)
        for item in stages:
            for needed in item.get("requiresPaths", []):
                if not (export / needed).exists():
                    raise Refused(
                        f"Stage {item['id']} needs {needed}, which is not in the exported tree. "
                        "Initialize the submodule or set STATEACTION_LOCAL_CI_SUBMODULES=<dir containing it>."
                    )
        for stage in stages:
            if stop["requested"]:
                record["stages"].append({"id": stage["id"], "status": "interrupted"})
                raise Interrupted("Cancelled before stage " + stage["id"])
            cwd = export / stage.get("cwd", ".")
            argv, skip_nx = effective_argv(stage, fresh)
            gradle_cache = bool(stage.get("gradleBuildCache")) and not fresh
            env = stage_env(
                os.environ.copy(),
                shim_dir=shim_dir,
                node_version=pins["node"],
                stage=stage,
                fixtures=fixtures,
                fixture_file=fixture_file,
                tmp=tmp,
                cache_dir=nx_cache,
                workspace_data_dir=nx_data,
                skip_nx_cache=skip_nx,
                gradle_cache=gradle_cache,
            )
            if stage.get("docsChanged"):
                changed = [p for e in docs["entries"] for p in e["paths"][-1:] if p]
                if stage["docsChanged"] == "env":
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
            log(f"[local-ci] stage {stage['id']}: {stage['title']}")
            result = run_child(
                argv,
                cwd=cwd,
                env=env,
                log=logs / f"{stage['id']}.log",
                timeout=float(stage.get("timeoutSec", 1800)),
                output_cap=int(stage.get("maxOutputBytes", DEFAULT_OUTPUT_CAP)),
                secrets_=secrets_,
                stop=stop,
                capture=bool(stage.get("capture")),
                scan=CacheScan() if is_nx(argv) else None,
                wait_for_gradle=stage["id"] == "mobile-android-dart",
                cgroup=Path(guard["cgroup"]) if guard.get("cgroup") else None,
            )
            entry = {
                "id": stage["id"],
                "argvSha256": argv_hash(stage),
                "status": result["status"],
                "exitCode": result["exitCode"],
                "durationSec": result["durationSec"],
                "startedAt": None,
                "logBytes": result.get("logBytes", 0),
                "logSha256": result.get("logSha256"),
                "fixtureBacked": bool(stage.get("fixtures")),
                "cacheMode": "none"
                if skip_nx or not is_nx(argv)
                else "none-by-target"
                if fixture_task(stage, argv)
                else "nx",
                "gradleBuildCache": gradle_cache,
                "cache": result.get("cache"),
                "metrics": result.get("metrics"),
            }
            if stage.get("capture") == "toolchain" and "captured" in result:
                toolchain = {
                    k: v.strip()
                    for k, _, v in (
                        line.partition("=") for line in result["captured"].splitlines()
                    )
                    if k and v
                }
            # The tree under test must be exactly what is being committed.
            observed = current_tree(repo, rev)
            if observed != tree and result["status"] == "passed":
                entry["status"] = "tree-changed"
                entry["detail"] = (
                    f"tree changed from {tree} to {observed} during the run"
                )
            rewritten = modified_since(export, snapshot)
            replayed = cached_fixture_task(stage, argv, result.get("cache"))
            if replayed and entry["status"] == "passed":
                entry["status"] = "cached-fixture"
                entry["detail"] = (
                    f"fixture-backed task {replayed} was replayed from cache "
                    "or missing from the Nx run output"
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
            if entry["status"] != "passed" and result.get("tail"):
                log(redact(result["tail"].encode(), secrets_).decode(errors="replace"))
            record["stages"].append(entry)
            if entry["status"] == "interrupted":
                raise Interrupted("Cancelled during stage " + stage["id"])
            if entry["status"] != "passed" and not keep_going:
                break
        passed = [s for s in record["stages"] if s["status"] == "passed"]
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
        record["verdict"] = "FAIL"
        record["detail"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        if stop.get("process") is not None:
            kill_group(stop["process"])
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
        write_json_private(logs / "run.json", record)
        log(format_timing(record))
    if record.get("fallbackFull"):
        record_attempt(home, tree, run_id, "finished", "FAIL")
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
                    k: s[k]
                    for k in (
                        "id",
                        "argvSha256",
                        "status",
                        "exitCode",
                        "durationSec",
                        "logSha256",
                        "fixtureBacked",
                        "cacheMode",
                        "gradleBuildCache",
                        "cache",
                    )
                }
                | {"metrics": s.get("metrics")}
                for s in record["stages"]
            ],
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
    flow_hook.report_ci_run(record, repo=repo, mode=ci_mode)
    return record


# ------------------------------------------------------------------- verification


def receipt_fixture_problem(stage: dict, item: dict) -> str | None:
    """Why a receipt entry does not prove its fixture `nx run` task executed uncached."""
    task = fixture_task(stage, stage["argv"])
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


def verify_receipt(
    repo: Path,
    head: str = "HEAD",
    *,
    home: Path | None = None,
    base_ref: str = "refs/remotes/origin/main",
    require_single_commit: bool = True,
    affected=None,
    guarded=None,
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
    if list(got) != list(declared):
        errors.append("receipt stages do not equal the declared stages in order")
    for stage_id, digest in declared.items():
        item = got.get(stage_id)
        if (
            not item
            or item.get("status") != "passed"
            or item.get("argvSha256") != digest
        ):
            errors.append(f"stage {stage_id} did not pass with the declared command")
            continue
        problem = receipt_fixture_problem(
            next((x for x in stage_list if x["id"] == stage_id), {"argv": []}), item
        )
        if problem:
            errors.append(f"stage {stage_id} {problem}")
    if docs_mode:
        errors += docs_receipt_problems(
            repo, receipt, spec, head_sha, base_sha, affected, guarded
        )
    guard = receipt.get("guard", {})
    if not (
        0 < guard.get("memoryMaxBytes", 0) <= JOB_MAX and guard.get("swapMaxBytes") == 0
    ):
        errors.append("receipt lacks verified guard limits")
    ancestor = (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", base_sha, head_sha], cwd=repo
        ).returncode
        == 0
    )
    if not ancestor:
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
    merge.add_argument("--repo", default="timothywangdev/stateaction")
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
