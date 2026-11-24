"""Stage CLI runner for the Modal GPU functions (SA-94). Stdlib only; `modal_stage.py` calls it.

`run_stage_bootstrap` mirrors the CPU wrapper in `workers/processing/modal_app.py`: it adds the
provider call ID and the executor kind to the controller's scoped bootstrap, pipes it to
`python -m stateaction_processing run-stage <call id>` on STDIN (never argv or logs), stops the CLI at
the deadline, and returns a structured result only after the CLI's process group is gone. The stage
claim, source read, module run and uploads are the stage entrypoint's (SA-90); this file adds none.
`run_io_dir` is the operator smoke harness around the same entrypoint (`--io-dir`, no HTTP).
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

EXIT_INTERNAL = 70
BOOTSTRAP_MAX_BYTES = 8192
_CALL_ID = re.compile(r"^fc-[A-Za-z0-9]{1,77}$")
_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
REAP_GRACE_S = 15.0
_RECEIPT_MAX_BYTES = 64 * 1024


def child_env(
    source: dict[str, str], extra: dict[str, str] | None = None
) -> dict[str, str]:
    """The stage CLI's environment: the container's own, minus any Modal credential."""
    env = {k: v for k, v in source.items() if not k.startswith("MODAL_")}
    env.update(extra or {})
    return env


def _group_members(pgid: int) -> list[int]:
    live: list[int] = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            raw = Path(f"/proc/{entry}/stat").read_text()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise RuntimeError("process table unreadable") from error
        rest = raw[raw.rindex(")") + 2 :].split()
        state, group, session = rest[0], int(rest[2]), int(rest[3])
        if state != "Z" and (group == pgid or session == pgid):
            live.append(int(entry))
    return live


def close_group(pgid: int, grace_s: float) -> None:
    """SIGKILL the group until it is provably empty, or raise. Never returns on an unproven group."""
    until = time.monotonic() + grace_s
    while _group_members(pgid):
        if time.monotonic() >= until:
            raise RuntimeError("process group not provably empty")
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        time.sleep(0.05)


def _run(
    args: list[str],
    stdin: bytes | None,
    env: dict[str, str],
    deadline_s: float,
    grace_s: float,
    stdout: Any = None,
) -> int:
    child = subprocess.Popen(
        args,
        stdin=subprocess.PIPE if stdin is not None else None,
        stdout=stdout,
        shell=False,
        start_new_session=True,  # session and group leader: every descendant (vLLM workers) is in it
        env=env,
    )
    try:
        if stdin is not None:
            try:
                assert child.stdin is not None
                child.stdin.write(stdin)
                child.stdin.close()
            except OSError:
                pass  # the CLI rejects a missing bootstrap itself (exit 70)
        try:
            code = child.wait(timeout=deadline_s)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            code = child.wait(timeout=grace_s)
        close_group(child.pid, grace_s)
        return code
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
        raise


def run_stage_bootstrap(
    bootstrap_json: str,
    call_id: str | None,
    *,
    deadline_s: float,
    python: str = sys.executable,
    env_source: dict[str, str] | None = None,
    reap_grace_s: float = REAP_GRACE_S,
) -> dict[str, Any]:
    """Run the stage CLI for exactly this call; the result is returned after the group is proven gone."""
    if not isinstance(call_id, str) or not _CALL_ID.match(call_id):
        raise RuntimeError(
            "function call identity unavailable"
        )  # without it the worker cannot claim
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "functionCallId": call_id,
        "exitCode": EXIT_INTERNAL,
    }
    try:
        if len(bootstrap_json.encode()) > BOOTSTRAP_MAX_BYTES:
            return result
        bootstrap = json.loads(bootstrap_json)
        if not isinstance(bootstrap, dict) or {"executionRef", "executorKind"} & set(
            bootstrap
        ):
            return result
    except ValueError:
        return result
    bootstrap["executionRef"] = call_id
    bootstrap["executorKind"] = "modal"
    from stateaction_processing.modal_result import call_binding

    with tempfile.TemporaryFile() as stdout:
        result["exitCode"] = max(
            -255,
            min(
                255,
                _run(
                    [python, "-m", "stateaction_processing", "run-stage", call_id],
                    json.dumps(bootstrap).encode(),
                    child_env(dict(os.environ if env_source is None else env_source)),
                    deadline_s,
                    reap_grace_s,
                    stdout=stdout,
                ),
            ),
        )
        end = stdout.tell()
        stdout.seek(max(0, end - _RECEIPT_MAX_BYTES - 2))
        lines = stdout.read().splitlines()
    receipt = None
    if (
        lines
        and len(lines[-1]) <= _RECEIPT_MAX_BYTES
        and (end <= _RECEIPT_MAX_BYTES + 2 or len(lines) > 1)
    ):
        try:
            value = json.loads(lines[-1])
            if isinstance(value, dict):
                receipt = value
        except ValueError:
            pass
    result["schemaVersion"] = 2
    result["receipt"] = receipt
    binding = call_binding(bootstrap)
    if binding is not None:
        result["callBinding"] = binding
    return result


def run_io_dir(
    files: dict[str, bytes],
    *,
    deadline_s: float,
    python: str = sys.executable,
    env_source: dict[str, str] | None = None,
    extra_env: dict[str, str] | None = None,
    reap_grace_s: float = REAP_GRACE_S,
) -> dict[str, Any]:
    """Operator smoke: run `run-stage --io-dir` over `files` and return everything it wrote.

    `files` maps a plain file name (bootstrap.json, source.mcap, ...) to its bytes. Only the harness
    function calls this; the production functions never set `STATEACTION_IO_DIR_HARNESS`.
    """
    with tempfile.TemporaryDirectory(prefix="flora-io-") as tmp:
        root = Path(tmp)
        for name, data in files.items():
            if not _NAME.match(name):
                raise ValueError("bad file name")
            (root / name).write_bytes(data)
        env = child_env(
            dict(os.environ if env_source is None else env_source),
            {"STATEACTION_IO_DIR_HARNESS": "1", **(extra_env or {})},
        )
        started = time.monotonic()
        code = _run(
            [
                python,
                "-m",
                "stateaction_processing",
                "run-stage",
                "--io-dir",
                str(root),
            ],
            None,
            env,
            deadline_s,
            reap_grace_s,
        )
        out: dict[str, bytes] = {}
        for path in sorted(root.rglob("*")):
            rel = path.relative_to(root).as_posix()
            if (
                path.is_file()
                and rel not in files
                and path.stat().st_size <= 64 * 1024 * 1024
            ):
                out[rel] = path.read_bytes()
    return {
        "exitCode": code,
        "seconds": round(time.monotonic() - started, 1),
        "files": out,
    }
