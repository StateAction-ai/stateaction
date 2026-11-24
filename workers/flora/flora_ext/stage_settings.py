"""Modal function settings of the FLORA stage functions (SA-94). Stdlib only, so CI can test them.

`modal_stage.py` is the only file that imports `modal`; it applies these options verbatim. The Modal
timeout is static per function, so it comes from the stage `budgetSeconds` of the default recipe
(`flora_fp8@1`, pinned by a test against the committed recipe fixture) and can be overridden at
deploy time with `FLORA_SEGMENT_BUDGET_S` / `FLORA_CAPTION_BUDGET_S`; the wrapper stops the stage
CLI before that timeout so a late stage still returns a result.
"""

from __future__ import annotations

import os

# Single source of truth for where the stage functions live. `modal_stage.py` deploys under APP_NAME and
# the controller (SA-91) must be configured from `controller_env()`, never from a hand-typed copy.
APP_NAME = os.environ.get("FLORA_STAGE_APP_NAME", "stateaction-flora-stages")
MODELS_VOLUME = "stateaction-models"
GPU = "RTX-PRO-6000"
DEFAULT_BUDGET_S = {
    "flora_tempseg": 1800,
    "flora_captioner": 3600,
}  # flora_fp8@1 budgetSeconds
BUDGET_ENV = {
    "flora_tempseg": "FLORA_SEGMENT_BUDGET_S",
    "flora_captioner": "FLORA_CAPTION_BUDGET_S",
}
# stage module id -> Modal function that runs it (the stage bootstrap names the module, the function only
# provides the container); the format is SA-91's `MODAL_STAGE_FUNCTIONS="module@version=app/function,..."`.
FUNCTION_OF_MODULE = {
    "flora_tempseg_vllm_fp8": "flora_tempseg",
    "flora_tempseg_hf": "flora_tempseg",
    "flora_captioner_vllm_fp8": "flora_captioner",
    "flora_captioner_hf": "flora_captioner",
}
MODULE_VERSION = 1
STAGE_OF = {"flora_tempseg": "segment", "flora_captioner": "caption"}
WRAPPER_MARGIN_S = (
    120  # the wrapper kills the stage CLI this long before Modal's own timeout
)
CPU, MEMORY_MIB, EPHEMERAL_DISK_MIB = 8, 65536, 524288  # Modal minimum


def budget_s(function: str, env: dict[str, str] | None = None) -> int:
    source = os.environ if env is None else env
    raw = source.get(BUDGET_ENV[function])
    value = int(raw) if raw else DEFAULT_BUDGET_S[function]
    if not 600 <= value <= 21600:
        raise ValueError(f"{BUDGET_ENV[function]} out of range")
    return value


def function_options(
    function: str, env: dict[str, str] | None = None
) -> dict[str, object]:
    """The keyword arguments for `app.function` (image and volumes are added by the caller)."""
    source = os.environ if env is None else env
    bounded = source.get("FLORA_STAGE_BOUNDED") == "1"
    return {
        "gpu": GPU,
        "retries": 0,
        "max_containers": 1,
        "min_containers": 0,
        "single_use_containers": True,
        "restrict_modal_access": True,
        "secrets": [],
        "timeout": budget_s(function, env),
        "cpu": (CPU, CPU) if bounded else CPU,
        "memory": (MEMORY_MIB, MEMORY_MIB) if bounded else MEMORY_MIB,
        **({"startup_timeout": 60, "scaledown_window": 10} if bounded else {}),
        "ephemeral_disk": EPHEMERAL_DISK_MIB,
    }


def controller_env() -> dict[str, str]:
    """Environment the controller needs to spawn these functions (SA-91 `MODAL_STAGE_FUNCTIONS`).

    Each binding is `module@version=app/function`: the controller's single `MODAL_APP_NAME` is the app of
    `hand_pose` (`stateaction-processing`), these functions live in `APP_NAME`, and `app/function` makes
    the controller look each one up in its own app. `APP_NAME` here is the only place the app is named.
    """
    pairs = ",".join(
        f"{module}@{MODULE_VERSION}={APP_NAME}/{function}"
        for module, function in sorted(FUNCTION_OF_MODULE.items())
    )
    return {"MODAL_STAGE_FUNCTIONS": pairs}
