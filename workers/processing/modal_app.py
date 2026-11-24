"""Modal CPU wrapper for the shared worker CLI (SA-42). The ONLY module that imports `modal`.

One finite CPU function call per job. The wrapper does exactly three things:

1. reads the scoped bootstrap the controller passed as the call's single argument;
2. adds the provider call ID (`modal.current_function_call_id()`), the executor
   kind and nothing else, then pipes the JSON to `python -m stateaction_processing
   run-job --execution-ref <call id>` on STDIN (never argv, environment or logs);
3. returns a structured result AFTER the CLI has exited and its process group is
   gone. That return value is the only thing the controller accepts as terminal proof.

The shared CLI still claims BEFORE importing any pipeline module or reading any
source; the wrapper imports nothing heavy. The container holds no Modal, database,
R2 or Render credential (`restrict_modal_access`, no secrets, scrubbed child env).
Deploy (operator, billable, not run by tests or CI): see docs/components/modal-executor.md.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import modal

DEFAULT_APP_NAME = "stateaction-processing"
APP_NAME = os.environ.get("STATEACTION_MODAL_APP_NAME", DEFAULT_APP_NAME)
FUNCTION_NAME = "process_recording"

# Explicit resources (provisional sizing: confirm with the authorized canary before production).
CPU_REQUEST, CPU_LIMIT = 4.0, 4.0
MEMORY_REQUEST_MIB, MEMORY_LIMIT_MIB = 8192, 8192
SCRATCH_DISK_MIB = 524_288  # Modal's minimum container disk request.
# Modal's function timeout is a backstop; the wrapper kills the CLI first and still returns a result.
TIMEOUT_ENV = "STATEACTION_MODAL_HAND_POSE_TIMEOUT_S"
FUNCTION_TIMEOUT_SECONDS = int(os.environ.get(TIMEOUT_ENV, "21600"))
if not 600 <= FUNCTION_TIMEOUT_SECONDS <= 21_600:
    raise ValueError(f"{TIMEOUT_ENV} out of range")
STARTUP_TIMEOUT_ENV = "STATEACTION_MODAL_HAND_POSE_STARTUP_TIMEOUT_S"
STARTUP_TIMEOUT_SECONDS = (
    int(os.environ[STARTUP_TIMEOUT_ENV]) if STARTUP_TIMEOUT_ENV in os.environ else None
)
if STARTUP_TIMEOUT_SECONDS is not None and not 30 <= STARTUP_TIMEOUT_SECONDS <= 600:
    raise ValueError(f"{STARTUP_TIMEOUT_ENV} out of range")
WRAPPER_DEADLINE_SECONDS = FUNCTION_TIMEOUT_SECONDS - 300
# Bounded proof that the CLI's whole process group/session is gone before a result is returned.
REAP_GRACE_SECONDS = 15.0

EXIT_INTERNAL = 70  # mirrors run_job.EXIT_INTERNAL
_CALL_ID = re.compile(r"^fc-[A-Za-z0-9]{1,77}$")
# The CLI environment is built from scratch: nothing else (and no Modal credential) is inherited.
_ENV_ALLOWLIST = (
    "PATH",
    "LANG",
    "LC_ALL",
    "HOME",
    "TMPDIR",
    "PYTHONPATH",
    "PYTHONNOUSERSITE",
    "PYTHONUNBUFFERED",
    "STATEACTION_HAND_MODEL",
    "STATEACTION_CAPTURE_CONTRACT_DIR",
    "STATEACTION_CODE_REVISION",
    "STATEACTION_IMAGE_SPEC_SHA256",
)
_BOOTSTRAP_MAX_BYTES = 8192

IMAGE_ROOT = "/app"


def build_image(
    requirements_txt: Path, code_revision: str, image_spec_sha256: str
) -> Any:
    """The pinned image: locked third-party wheels, in-repo code and config, hash-verified model.

    `requirements_txt` is `uv export --locked --no-dev --no-emit-project
    --no-emit-package stateaction-contracts -o <file>` from uv.lock (hashes kept, so pip
    enforces them). The Python patch level is not selectable on Modal ("3.12" is the only
    available pin). The build loads the pinned MediaPipe model to check the native runtime.
    """
    repo = Path(__file__).resolve().parents[2]
    pins = json.loads(
        (
            repo / "workers/processing/src/stateaction_processing/hand_model.json"
        ).read_text(encoding="utf-8")
    )
    model_path = "/models/hand_landmarker.task"
    ignore = [
        "**/tests/**",
        "**/.venv*/**",
        "**/__pycache__/**",
        "**/dist/**",
        "**/node_modules/**",
    ]
    return (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install(
            "ca-certificates", "curl", "libgl1", "libglib2.0-0", "libegl1", "libgles2"
        )
        .pip_install_from_requirements(str(requirements_txt))
        .run_commands(
            f"mkdir -p /models && curl -fsSL --proto '=https' -o {model_path} {pins['url']}",
            f"echo '{pins['sha256']}  {model_path}' | sha256sum -c -",
        )
        .env(
            {
                "STATEACTION_HAND_MODEL": model_path,
                "STATEACTION_CODE_REVISION": code_revision,
                # The ADMITTED build-spec digest (not a Modal image ID); the worker compares it
                # with the claim grant before it reads any source.
                "STATEACTION_IMAGE_SPEC_SHA256": image_spec_sha256,
                "STATEACTION_CAPTURE_CONTRACT_DIR": f"{IMAGE_ROOT}/packages/contracts/capture",
                "PYTHONPATH": (
                    f"{IMAGE_ROOT}/workers/processing/src"
                    f":{IMAGE_ROOT}/packages/contracts/python/src"
                ),
                "PYTHONNOUSERSITE": "1",
                "PYTHONUNBUFFERED": "1",
            }
        )
        .add_local_dir(
            str(repo / "workers/processing/src"),
            f"{IMAGE_ROOT}/workers/processing/src",
            copy=True,
            ignore=ignore,
        )
        .add_local_dir(
            str(repo / "packages/contracts/python/src"),
            f"{IMAGE_ROOT}/packages/contracts/python/src",
            copy=True,
            ignore=ignore,
        )
        .add_local_dir(
            str(repo / "packages/contracts/api"),
            f"{IMAGE_ROOT}/packages/contracts/api",
            copy=True,
        )
        .add_local_dir(
            str(repo / "packages/contracts/capture"),
            f"{IMAGE_ROOT}/packages/contracts/capture",
            copy=True,
        )
        .run_commands(
            "python -c 'from stateaction_processing.hands import HandInferencer; "
            'HandInferencer().close(); print("Pinned CPU hand model loaded")\''
        )
    )


app = modal.App(APP_NAME)

if modal.is_local():
    # Deploy time only. Fail closed: a deploy without the locked requirements and the code revision
    # must not produce an unpinned image.
    _requirements = os.environ.get("STATEACTION_LOCKED_REQUIREMENTS")
    _revision = os.environ.get("STATEACTION_CODE_REVISION")
    _image_spec = os.environ.get("STATEACTION_IMAGE_SPEC_SHA256")
    if not _requirements or not _revision or not _image_spec:
        raise SystemExit(
            "Set STATEACTION_LOCKED_REQUIREMENTS (uv export of uv.lock), "
            "STATEACTION_CODE_REVISION and STATEACTION_IMAGE_SPEC_SHA256 "
            "(the admitted PROCESSING_IMAGE_SPEC_SHA256) before deploying"
        )
    image = build_image(Path(_requirements), _revision, _image_spec).env(
        {TIMEOUT_ENV: str(FUNCTION_TIMEOUT_SECONDS)}
    )
else:
    image = modal.Image.debian_slim()


def _child_env(source: dict[str, str]) -> dict[str, str]:
    return {k: source[k] for k in _ENV_ALLOWLIST if k in source}


def _group_members(pgid: int) -> list[int]:
    """Live (non-zombie) processes in the CLI's process group or session; unreadable /proc raises."""
    live: list[int] = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            raw = Path(f"/proc/{entry}/stat").read_text()
        except FileNotFoundError:
            continue  # exited between listing and reading
        except OSError as error:  # permission or I/O: absence is NOT proven
            raise RuntimeError("process table unreadable") from error
        # comm may contain spaces/parentheses: fields start after the LAST ')'
        rest = raw[raw.rindex(")") + 2 :].split()
        state, group, session = rest[0], int(rest[2]), int(rest[3])
        if state != "Z" and (group == pgid or session == pgid):
            live.append(int(entry))
    return live


def _close_group(pgid: int, grace_seconds: float) -> None:
    """SIGKILL the group until it is provably empty, or raise. Never returns on an unproven group."""
    until = time.monotonic() + grace_seconds
    while _group_members(pgid):
        if time.monotonic() >= until:
            raise RuntimeError("process group not provably empty")
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # the group vanished; the next scan decides
        time.sleep(0.05)


def run_bootstrap(
    bootstrap_json: str,
    call_id: str | None,
    *,
    python: str = sys.executable,
    deadline_seconds: float = WRAPPER_DEADLINE_SECONDS,
    reap_grace_seconds: float = REAP_GRACE_SECONDS,
    env_source: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run the shared CLI for exactly this call and return the structured terminal result.

    The result is returned ONLY after the CLI leader has exited and its whole process group/session
    is proven empty; if that cannot be proven (a permission error, an unreadable process table, a
    stray that will not die) this raises and returns nothing, so the controller stays uncertain.
    """
    if not isinstance(call_id, str) or not _CALL_ID.match(call_id):
        # Without the provider call ID the worker cannot claim; never run the pipeline.
        raise RuntimeError("function call identity unavailable")
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "functionCallId": call_id,
        "exitCode": EXIT_INTERNAL,
    }
    try:
        if len(bootstrap_json.encode()) > _BOOTSTRAP_MAX_BYTES:
            return result
        bootstrap = json.loads(bootstrap_json)
        if not isinstance(bootstrap, dict) or {"executionRef", "executorKind"} & set(
            bootstrap
        ):
            return result
    except ValueError:
        return result
    # The controller cannot know the call ID before the spawn: the wrapper supplies it.
    bootstrap["executionRef"] = call_id
    bootstrap["executorKind"] = "modal"
    # A recipe stage (SA-92 hand_pose) returns its stage receipt: its stdout is drained here and the
    # last line kept. Without `stage` the return stays exactly the v1 shape.
    staged = "stage" in bootstrap
    child = subprocess.Popen(
        [python, "-m", "stateaction_processing", "run-job", "--execution-ref", call_id],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE if staged else None,
        shell=False,
        start_new_session=True,  # session and group leader: every descendant is in its session
        env=_child_env(dict(os.environ if env_source is None else env_source)),
    )
    last_line: list[bytes] = []
    drain: threading.Thread | None = None
    if staged:
        drain = threading.Thread(
            target=_drain_last_line, args=(child.stdout, last_line), daemon=True
        )
        drain.start()
    try:
        try:
            assert child.stdin is not None
            child.stdin.write(json.dumps(bootstrap).encode())
            child.stdin.close()
        except OSError:
            pass  # the CLI rejects/ignores a missing bootstrap itself (exit 70)
        try:
            code = child.wait(timeout=deadline_seconds)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)  # a PermissionError must propagate
            code = child.wait(
                timeout=reap_grace_seconds
            )  # bounded; TimeoutExpired propagates
        _close_group(child.pid, reap_grace_seconds)
        if drain is not None:
            drain.join(timeout=reap_grace_seconds)
            if child.stdout is not None:
                child.stdout.close()
    except BaseException:
        # No result may be returned. Best effort only; the controller stays uncertain.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
        raise
    from stateaction_processing.modal_result import call_binding, parse_worker_receipt

    binding = call_binding(bootstrap)
    if binding is not None:
        result["callBinding"] = binding
    result["exitCode"] = max(-255, min(255, int(code)))
    if staged:
        result["schemaVersion"] = 2
        result["receipt"] = parse_worker_receipt(
            last_line[0] if last_line else b"", bootstrap, result["exitCode"]
        )
    return result


_RECEIPT_MAX_BYTES = 64 * 1024


def _drain_last_line(stream: Any, keep: list[bytes]) -> None:
    """Pass the child's stdout through to the container log, keeping only the last line."""
    try:
        for line in stream:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            stripped = line.strip()
            if stripped:
                keep[:] = [stripped[: _RECEIPT_MAX_BYTES + 1]]
    except (OSError, ValueError):
        pass


@app.function(
    image=image,
    cpu=(CPU_REQUEST, CPU_LIMIT),
    memory=(MEMORY_REQUEST_MIB, MEMORY_LIMIT_MIB),
    ephemeral_disk=SCRATCH_DISK_MIB,
    timeout=FUNCTION_TIMEOUT_SECONDS,
    startup_timeout=STARTUP_TIMEOUT_SECONDS,
    retries=0,
    max_containers=1,  # concurrency 1: one call at a time (default input concurrency is 1)
    min_containers=0,  # warm 0: no idle billing
    single_use_containers=True,
    nonpreemptible=True,  # a preemption restart would re-run the same input (3x CPU/RAM price)
    restrict_modal_access=True,
    secrets=[],
    name=FUNCTION_NAME,
)
def process_recording(bootstrap_json: str) -> dict[str, Any]:
    return run_bootstrap(bootstrap_json, modal.current_function_call_id())
