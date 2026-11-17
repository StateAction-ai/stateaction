"""Locate and load the published SA-50 capture contract reference (schemas, hashes, AU rules).

The streaming reader reuses the reference module's per-message rules (`strict_schema`,
`decode_video`, `classify_au`, pinned schema hashes) instead of re-deriving them. The reference
checker's whole-file `check()` is deliberately never called: it needs the full source in memory.

Location: `STATEACTION_CAPTURE_CONTRACT_DIR` (the `packages/contracts/capture` directory), else the
monorepo-relative default. A missing contract is an explicit error, never a silent fallback.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from functools import lru_cache
from pathlib import Path
from types import ModuleType
from typing import Any

ENV = "STATEACTION_CAPTURE_CONTRACT_DIR"


class ContractUnavailable(RuntimeError):
    pass


def contract_dir() -> Path:
    override = os.environ.get(ENV)
    path = (
        Path(override)
        if override
        else Path(__file__).resolve().parents[4] / "packages/contracts/capture"
    )
    if (
        not (path / "manifest.json").is_file()
        or not (path / "conformance/python/capture_conformance.py").is_file()
    ):
        raise ContractUnavailable(
            f"capture contract not found at {path}; set {ENV} to packages/contracts/capture"
        )
    return path


@lru_cache(maxsize=1)
def reference() -> ModuleType:
    conformance = str(contract_dir() / "conformance/python")
    if conformance not in sys.path:
        sys.path.insert(0, conformance)
    return importlib.import_module("capture_conformance")


@lru_cache(maxsize=1)
def strict_schema() -> ModuleType:
    reference()
    return importlib.import_module("strict_schema")


@lru_cache(maxsize=1)
def manifest() -> dict[str, Any]:
    data = json.loads((contract_dir() / "manifest.json").read_text())
    files: dict[str, Any] = data["files"]
    return files
