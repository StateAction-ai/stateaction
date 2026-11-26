"""Controller settings and capability loading."""

import json
import os
import re
import stat
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

from stateaction_contracts import parse_contract
from stateaction_contracts.validate import _api_dir

from .api import check_base

HAND_POSE = "hand_pose_cpu_v1@1"
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


@cache
def modules():
    manifest = json.loads((_api_dir() / "modules.json").read_bytes())
    return {f"{m['moduleId']}@{m['version']}": m for m in manifest["modules"]}


def secret(prefix, env=os.environ):
    file = env.get(f"{prefix}_FILE")
    if file:
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or info.st_mode & 0o077
            ):
                raise ValueError("Capability file must be private to its owner")
            value = stream.read(8193)
            if len(value) > 8192:
                raise ValueError("Capability file is too large")
            token = value.decode("ascii").strip()
    else:
        token = env.get(f"{prefix}_TOKEN", "").strip()
    if not token:
        raise ValueError(f"{prefix} is required")
    return token


@dataclass(frozen=True)
class Settings:
    backend: str
    api_url: str
    state_dir: Path
    pipeline: str = "hand_pose_cpu_v1"
    python: str | None = None
    fixture_hold: int = 0
    app: str | None = None
    function: str | None = None
    environment: str | None = None
    targets: dict = field(default_factory=dict)
    bindings: dict | None = None
    renew: float = 30
    poll: float = 2
    lease_wait: float = 150
    grace: float = 30
    timeout: float = 15

    def target(self, module):
        if module in (None, HAND_POSE):
            return self.app, self.function
        return self.targets.get(module, (None, None))

    def module_refusal(self, stage, module):
        entry = modules().get(module)
        if not entry or entry["stage"] != stage:
            return "module_unknown"
        if self.backend == "local":
            return None if entry["gpu"]["minimum"] == "none" else "module_needs_gpu"
        if entry.get("localOnly"):
            return "module_local_only"
        if not self.target(module)[1]:
            return "module_unbound"
        return None


def load_settings(env=os.environ):
    def number(key, default, minimum, maximum):
        raw = env.get(key)
        if raw is None:
            return default
        if not re.fullmatch(r"[0-9]+", raw) or not minimum <= int(raw) <= maximum:
            raise ValueError(f"{key} is outside its allowed range")
        return int(raw)

    backend, app_env = env.get("EXECUTION_BACKEND"), env.get("APP_ENV")
    if not (
        (backend == "local" and app_env == "local")
        or (backend == "modal" and app_env in ("development", "production"))
    ):
        raise ValueError("An explicit executor and matching APP_ENV are required")
    api = env.get("STATEACTION_API_URL", "")
    check_base(api, loopback=backend == "local")
    state = env.get("JOBS_STATE_DIR")
    if not state:
        raise ValueError("JOBS_STATE_DIR is required")
    fields = {
        "backend": backend,
        "api_url": api.rstrip("/"),
        "state_dir": Path(state),
        "renew": number("CONTROLLER_RENEW_MS", 30000, 200, 60000) / 1000,
        "poll": number("CONTROLLER_POLL_MS", 2000, 50, 30000) / 1000,
        "lease_wait": number("CONTROLLER_LEASE_WAIT_MS", 150000, 0, 300000) / 1000,
        "grace": number("CONTROLLER_REAP_GRACE_MS", 30000, 100, 120000) / 1000,
        "timeout": number("CONTROLLER_API_TIMEOUT_MS", 15000, 100, 60000) / 1000,
    }
    if backend == "local":
        pipeline = env.get("WORKER_PIPELINE", "hand_pose_cpu_v1")
        python = env.get("PYTHON_EXECUTABLE")
        if pipeline not in ("hand_pose_cpu_v1", "local_fixture_noop") or not python:
            raise ValueError("Valid WORKER_PIPELINE and PYTHON_EXECUTABLE are required")
        hold = (
            number("WORKER_FIXTURE_HOLD_SECONDS", 0, 0, 600)
            if pipeline == "local_fixture_noop"
            else 0
        )
        return Settings(**fields, python=python, pipeline=pipeline, fixture_hold=hold)

    if "WORKER_PIPELINE" in env:
        raise ValueError("WORKER_PIPELINE is not configurable for Modal")
    app = env.get("MODAL_APP_NAME", "")
    function = env.get("MODAL_FUNCTION_NAME", "")
    environment = env.get("MODAL_ENVIRONMENT")
    if (
        not NAME.fullmatch(app)
        or not NAME.fullmatch(function)
        or (environment is not None and not NAME.fullmatch(environment))
    ):
        raise ValueError("Explicit valid Modal app and function names are required")
    targets = {}
    raw = env.get("MODAL_STAGE_FUNCTIONS")
    for entry in raw.split(",") if raw else ():
        module, sep, target = entry.strip().partition("=")
        stage_app, slash, stage_fn = target.partition("/")
        if not slash:
            stage_app, stage_fn = app, stage_app
        manifest = modules().get(module)
        if (
            not sep
            or not manifest
            or manifest.get("localOnly")
            or module == HAND_POSE
            or module in targets
            or not NAME.fullmatch(stage_app)
            or not NAME.fullmatch(stage_fn)
        ):
            raise ValueError("MODAL_STAGE_FUNCTIONS is invalid")
        targets[module] = (stage_app, stage_fn)
    bindings = env.get("STATEACTION_RERUN_BINDINGS")
    if bindings is not None:
        if len(bindings) > 16384:
            raise ValueError("Modal binding configuration is too large")
        bindings = json.loads(bindings or "{}")
        if not isinstance(bindings, dict):
            raise ValueError("Invalid Modal binding configuration")
        for module, binding in bindings.items():
            if module not in modules():
                raise ValueError("Unknown bound Modal module")
            parse_contract(
                "jobs.rerun-preparation.v1",
                {"state": "ready", "functions": {"segment": binding}},
            )
    return Settings(
        **fields,
        app=app,
        function=function,
        environment=environment,
        targets=targets,
        bindings=bindings,
    )


def modal_credentials(env=os.environ):
    token_id = env.get("MODAL_TOKEN_ID")
    token_secret = env.get("MODAL_TOKEN_SECRET")
    if not token_id or not token_secret:
        raise ValueError("Both Modal credentials are required")
    return token_id, token_secret
