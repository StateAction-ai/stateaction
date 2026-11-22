"""Stage module registry: `(stage, module_id)` -> import path, imported lazily after the claim.

`resolve` is pure data (no module code runs) so the entrypoint can refuse before it claims.
`load` imports the module and is called only after the claim was won. A module is a callable
`run(ctx: StageContext) -> ModuleOutput` (see `stage_docs`). Modules marked `localOnly` in
`api/modules.json` are refused unless `APP_ENV=local`, like `local_fixture_noop`. GPU modules are
added to `REGISTRY` by the ticket that ships them; an unregistered module is unavailable, never
silently substituted.
"""

from __future__ import annotations

import importlib
import os
from typing import Any, Callable

REGISTRY: dict[tuple[str, str], str] = {
    ("segment", "stub_segmenter"): "stateaction_processing.modules.stub:run_segment",
    ("caption", "stub_captioner"): "stateaction_processing.modules.stub:run_caption",
    (
        "segment",
        "replay_segmenter",
    ): "stateaction_processing.modules.replay:run_segment",
    (
        "caption",
        "replay_captioner",
    ): "stateaction_processing.modules.replay:run_caption",
}


class ModuleRefused(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def parse_ref(ref: str) -> tuple[str, int]:
    module_id, _, version = ref.partition("@")
    if not module_id or not version.isdigit():
        raise ModuleRefused("module_ref_invalid")
    return module_id, int(version)


def resolve(stage: str, module_ref: str) -> dict[str, Any]:
    """The manifest entry of an admissible module; no module code is imported."""
    from stateaction_contracts.rules import _modules

    module_id, _version = parse_ref(module_ref)
    entry = _modules().get(module_ref)
    if entry is None or entry["stage"] != stage:
        raise ModuleRefused("module_unknown")
    if (stage, module_id) not in REGISTRY:
        raise ModuleRefused("module_unavailable")
    if entry["localOnly"] and os.environ.get("APP_ENV") != "local":
        raise ModuleRefused("module_local_only")
    result: dict[str, Any] = entry
    return result


def load(stage: str, module_id: str) -> Callable[..., Any]:
    path = REGISTRY[(stage, module_id)]
    module_name, _, attr = path.partition(":")
    fn: Callable[..., Any] = getattr(importlib.import_module(module_name), attr)
    return fn
