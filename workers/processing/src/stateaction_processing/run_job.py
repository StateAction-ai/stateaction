"""Physical worker entry: claim first, import and read afterwards.

Stdlib only until the claim has been WON. The bootstrap capability arrives on
stdin (never argv/env/logs), the nonce is generated here per physical
invocation, and a lost claim exits before any pipeline import, source read or
signed URL exists. Nothing in this module logs a token, URL or payload.
"""

from __future__ import annotations

import base64
import ctypes
import errno
import importlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

EXIT_OK = 0
EXIT_INTERNAL = 70
EXIT_CLAIM_LOST = 75
EXIT_PIPELINE_UNAVAILABLE = 78

_REF = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_TOKEN = re.compile(r"^sa_svc_[A-Za-z0-9_-]{43}$")
# Pipelines are resolved from this fixed table; never from caller-supplied names.
_PIPELINES = {
    "hand_pose_cpu_v1": "hand_pose_cpu_v1",
    "local_fixture_noop": "fixture_noop",
}
_CLAIM_TIMEOUT_SECONDS = 30
_MAX_BOOTSTRAP_BYTES = 8192
_FIXTURE_PIPELINE = "local_fixture_noop"
_ISOLATION_FD = 3


class WorkerExit(Exception):
    def __init__(self, code: int, label: str) -> None:
        super().__init__(label)
        self.code = code
        self.label = label


def enforce_single_process() -> None:
    """Install an irreversible no-process-creation filter before fixture work."""
    try:
        lib = ctypes.CDLL("libseccomp.so.2")
        lib.seccomp_init.argtypes = [ctypes.c_uint32]
        lib.seccomp_init.restype = ctypes.c_void_p
        lib.seccomp_attr_set.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32]
        lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
        lib.seccomp_rule_add.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_int,
            ctypes.c_uint,
        ]
        lib.seccomp_load.argtypes = [ctypes.c_void_p]
        lib.seccomp_release.argtypes = [ctypes.c_void_p]
        lib.seccomp_release.restype = None
        ctx = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
        if not ctx:
            raise OSError("seccomp_init")
        try:
            if lib.seccomp_attr_set(ctx, 4, 1) != 0:  # SCMP_FLTATR_CTL_TSYNC
                raise OSError("seccomp_attr_set")
            deny = 0x00050000 | errno.EPERM  # SCMP_ACT_ERRNO(EPERM)
            for name in (
                b"fork",
                b"vfork",
                b"clone",
                b"clone3",
                b"execve",
                b"execveat",
            ):
                number = lib.seccomp_syscall_resolve_name(name)
                if number < 0 or lib.seccomp_rule_add(ctx, deny, number, 0) != 0:
                    raise OSError("seccomp_rule_add")
            if lib.seccomp_load(ctx) != 0:
                raise OSError("seccomp_load")
            # A leader's exit is terminal only when no other thread can outlive it.
            if len(os.listdir("/proc/self/task")) != 1:
                raise OSError("fixture startup is not single-threaded")
        finally:
            lib.seccomp_release(ctx)
    except (AttributeError, OSError) as error:
        raise WorkerExit(
            EXIT_PIPELINE_UNAVAILABLE, "FixtureIsolationUnavailable"
        ) from error


def _read_bootstrap(execution_ref: str) -> dict[str, Any]:
    raw = sys.stdin.buffer.read(_MAX_BOOTSTRAP_BYTES + 1)
    if len(raw) > _MAX_BOOTSTRAP_BYTES:
        raise WorkerExit(EXIT_INTERNAL, "BootstrapTooLarge")
    try:
        value = json.loads(raw)
        allowed = {
            "schemaVersion",
            "apiUrl",
            "jobId",
            "bootstrapToken",
            "executionRef",
            "pipeline",
            "fixtureHoldSeconds",
        }
        if not isinstance(value, dict) or not set(value) <= allowed:
            raise ValueError("shape")
        if value["schemaVersion"] != 1:
            raise ValueError("version")
        if str(uuid.UUID(value["jobId"])) != value["jobId"]:
            raise ValueError("job")
        if not _TOKEN.match(value["bootstrapToken"]):
            raise ValueError("token")
        if value["executionRef"] != execution_ref or not _REF.match(execution_ref):
            raise ValueError("ref")
        if value["pipeline"] not in _PIPELINES:
            raise ValueError("pipeline")
        value["apiUrl"] = _strict_origin(value["apiUrl"])
        return value
    except (ValueError, KeyError, TypeError) as error:
        raise WorkerExit(EXIT_INTERNAL, "InvalidBootstrap") from error


def _strict_origin(raw: object) -> str:
    """A bare origin only: https, or http on loopback. No credentials, path, query or fragment."""
    if not isinstance(raw, str) or any(c in raw for c in "?#@\\ "):
        raise ValueError("api")
    parsed = urlparse(raw)
    host = parsed.hostname
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.params
        or parsed.query
        or parsed.fragment
        or not host
    ):
        raise ValueError("api")
    loopback = host in ("127.0.0.1", "localhost", "::1")
    if not (parsed.scheme == "https" or (parsed.scheme == "http" and loopback)):
        raise ValueError("api")
    return f"{parsed.scheme}://{parsed.netloc}"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """The Bearer capability must never follow a redirect to another origin."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _pipeline_present(name: str) -> bool:
    """Harmless pre-claim check: a file exists. Nothing is imported or executed."""
    if name == "local_fixture_noop" and os.environ.get("APP_ENV") != "local":
        return False
    return (Path(__file__).parent / f"{_PIPELINES[name]}.py").is_file()


def _post(url: str, token: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
        },
    )
    with _OPENER.open(request, timeout=_CLAIM_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read(4 * 1024 * 1024))
    data = payload["data"]
    if not isinstance(data, dict):
        raise ValueError("data")
    return data


def run(execution_ref: str) -> int:
    isolation_requested = os.environ.get("STATEACTION_FIXTURE_ISOLATION_FD") == "3"
    if isolation_requested:
        if not _pipeline_present(_FIXTURE_PIPELINE):
            raise WorkerExit(EXIT_PIPELINE_UNAVAILABLE, "PipelineUnavailable")
        enforce_single_process()
        try:
            os.write(_ISOLATION_FD, b"1")
        finally:
            os.close(_ISOLATION_FD)
    boot = _read_bootstrap(execution_ref)
    pipeline = boot["pipeline"]
    if isolation_requested and pipeline != _FIXTURE_PIPELINE:
        raise WorkerExit(EXIT_INTERNAL, "InvalidBootstrap")
    if not _pipeline_present(pipeline):
        # Fail closed BEFORE the claim: an unavailable pipeline never takes a claim it cannot honour.
        raise WorkerExit(EXIT_PIPELINE_UNAVAILABLE, "PipelineUnavailable")
    if pipeline == _FIXTURE_PIPELINE and not isolation_requested:
        enforce_single_process()
    nonce = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    claim = {
        "schemaVersion": 1,
        "jobId": boot["jobId"],
        "invocationNonce": nonce,
        "executor": {"kind": "local", "localExecutionRef": execution_ref},
    }
    try:
        grant = _post(
            f"{boot['apiUrl']}/internal/v1/jobs/{boot['jobId']}/claim",
            boot["bootstrapToken"],
            claim,
        )
        if grant["jobId"] != boot["jobId"] or grant["invocationNonce"] != nonce:
            raise ValueError("grant")
        capability = grant["capability"]["token"]
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as error:
        # A lost or rejected claim cannot be replayed (the bootstrap stops resolving): stop here.
        raise WorkerExit(EXIT_CLAIM_LOST, "ClaimLost") from error
    del boot["bootstrapToken"]
    # Only now may heavy or pipeline code load and signed URLs be touched.
    module = importlib.import_module(f"stateaction_processing.{_PIPELINES[pipeline]}")
    context = {
        "apiUrl": boot["apiUrl"],
        "jobId": boot["jobId"],
        "nonce": nonce,
        "capability": capability,
        "post": _post,
        "fixtureHoldSeconds": boot.get("fixtureHoldSeconds"),
    }
    return int(module.run(grant, context))


def main(execution_ref: str) -> int:
    try:
        return run(execution_ref)
    except WorkerExit as stop:
        # Class names only: no credentials, URLs, source paths or payloads.
        print(f"Worker stopped: {stop.label}", file=sys.stderr)
        return stop.code
    except Exception as error:
        print(f"Worker failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_INTERNAL
