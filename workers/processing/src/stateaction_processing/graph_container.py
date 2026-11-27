"""Run a graph node under the provider's finite process-group boundary."""

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

CALL_ID = re.compile(r"fc-[A-Za-z0-9]{1,77}")
FUNCTION_ID = re.compile(r"fu-[A-Za-z0-9]{1,77}")
DIGEST = re.compile(r"[0-9a-f]{64}")
CPU_MODULES = {"clip_filter_passthrough@1", "recording_mp4_remux@1", "hand_pose_cpu@1"}
GPU_MODULES = {"flora_tempseg_vllm_fp8@1", "flora_captioner_vllm_fp8@1"}
REAP_SECONDS = 15


def runtime_definition():
    # The pinned SDK already has this metadata in the container. Reading it
    # uses no provider credentials or request.
    from modal._runtime.container_io_manager import _ContainerIOManager

    instance = _ContainerIOManager._singleton
    if instance is None:
        raise ValueError("Graph container identity unavailable")
    definition = instance.function_def.SerializeToString(deterministic=True)
    return instance.function_id, hashlib.sha256(definition).hexdigest()


def container_facts(bootstrap, module, env):
    if not isinstance(bootstrap, dict) or bootstrap.keys() != {
        "schemaVersion",
        "apiUrl",
        "jobId",
        "nodeId",
        "recipeSha256",
        "bindingSha256",
        "functionId",
        "runtimeDefinitionSha256",
        "nodeDeadline",
        "module",
        "codeRevision",
        "imageSha256",
        "paramsSha256",
        "gpu",
        "bootstrapToken",
    }:
        raise ValueError("Invalid graph bootstrap")
    if (
        bootstrap["schemaVersion"] != 1
        or bootstrap["module"] != module
        or bootstrap["codeRevision"] != env.get("STATEACTION_CODE_REVISION")
        or bootstrap["imageSha256"] != env.get("STATEACTION_IMAGE_SPEC_SHA256")
        or bootstrap["paramsSha256"] != env.get("STATEACTION_GRAPH_PARAMS_SHA256")
        or not all(
            isinstance(bootstrap[key], str) and DIGEST.fullmatch(bootstrap[key])
            for key in (
                "imageSha256",
                "recipeSha256",
                "bindingSha256",
                "paramsSha256",
                "runtimeDefinitionSha256",
            )
        )
        or not isinstance(bootstrap["functionId"], str)
        or not FUNCTION_ID.fullmatch(bootstrap["functionId"])
        or not re.fullmatch("[0-9a-f]{40}", bootstrap["codeRevision"] or "")
    ):
        raise ValueError("Graph container definition mismatch")
    if runtime_definition() != (
        bootstrap["functionId"],
        bootstrap["runtimeDefinitionSha256"],
    ):
        raise ValueError("Graph container provider definition mismatch")
    origin = urlsplit(bootstrap["apiUrl"])
    if (
        origin.scheme != "https"
        or not origin.hostname
        or origin.hostname in ("localhost", "127.0.0.1", "::1")
        or origin.username is not None
        or origin.path not in ("", "/")
        or origin.query
        or origin.fragment
    ):
        raise ValueError("Graph controller origin mismatch")
    if (
        module in CPU_MODULES
        and bootstrap["gpu"] is None
        and not Path("/dev/nvidiactl").exists()
    ):
        return None
    if module in GPU_MODULES and bootstrap["gpu"] == "RTX-PRO-6000":
        from flora_ext.stage_glue import gpu_matches, observed_gpu_name
        from flora_ext.stage_runtime import gpu_name

        observed = observed_gpu_name(gpu_name())
        if gpu_matches(bootstrap["gpu"], observed):
            return observed
    raise ValueError("Graph container GPU mismatch")


def reap_group(pgid):
    until = time.monotonic() + REAP_SECONDS
    while True:
        members = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                proc = (entry / "stat").read_text()
            except FileNotFoundError:
                continue
            state, _, group, session = proc[proc.rindex(")") + 2 :].split()[:4]
            if state != "Z" and (int(group) == pgid or int(session) == pgid):
                members.append(int(entry.name))
        if not members:
            return
        if time.monotonic() >= until:
            raise RuntimeError("Graph process group unproved")
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        time.sleep(0.05)


def run_graph_bootstrap(raw, call_id, *, module, budget_seconds, env=os.environ):
    if not isinstance(call_id, str) or not CALL_ID.fullmatch(call_id):
        raise RuntimeError("Missing graph call identity")
    result = {
        "schemaVersion": 3,
        "functionCallId": call_id,
        "exitCode": 70,
        "receipt": None,
    }
    try:
        if not isinstance(raw, str) or len(raw.encode()) > 8192:
            return result
        bootstrap = json.loads(raw)
        observed_gpu = container_facts(bootstrap, module, env)
        deadline = bootstrap["nodeDeadline"]
        if not isinstance(deadline, str) or not deadline.endswith("Z"):
            return result
        timeout = min(
            budget_seconds, datetime.fromisoformat(deadline).timestamp() - time.time()
        )
        if timeout <= 0:
            return result
    except (ValueError, TypeError, OSError, ImportError, AttributeError):
        return result

    with TemporaryDirectory(prefix="stateaction-graph-proof-") as scratch:
        path = Path(scratch) / "receipt.json"
        child_env = {
            key: env[key]
            for key in (
                "PATH",
                "LANG",
                "LC_ALL",
                "HOME",
                "TMPDIR",
                "PYTHONPATH",
                "STATEACTION_HAND_MODEL",
                "STATEACTION_CAPTURE_CONTRACT_DIR",
                "STATEACTION_FLORA_CHECKPOINTS",
                "HF_HOME",
                "FLORA_MODEL_CACHE",
                "TOKENIZERS_PARALLELISM",
                "VLLM_LOGGING_LEVEL",
            )
            if key in env
        }
        child = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "stateaction_processing.graph_worker",
                call_id,
                str(path),
            ],
            stdin=subprocess.PIPE,
            start_new_session=True,
            env={**child_env, "PYTHONNOUSERSITE": "1", "PYTHONUNBUFFERED": "1"},
        )
        try:
            try:
                child.communicate(
                    json.dumps({**bootstrap, "observedGpu": observed_gpu}).encode(),
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=REAP_SECONDS)
            reap_group(child.pid)
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise
        result["exitCode"] = max(-255, min(255, child.returncode))
        if child.returncode == 0:
            with path.open("rb") as file:
                payload = file.read(1000001)
            if len(payload) > 1000000:
                raise ValueError("Graph receipt exceeds its bound")
            result["receipt"] = json.loads(payload)
    return result
