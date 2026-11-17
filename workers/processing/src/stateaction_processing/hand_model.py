"""Pinned hand landmarker model: provenance and hash-verified location (SA-30).

The pins live in `hand_model.json` (reused from the merged SA-61 spike). The model file is never
committed or silently downloaded: `resolve_model` verifies byte count and SHA-256 of an existing
local file and fails otherwise. `STATEACTION_HAND_MODEL` overrides the default cache path
`~/.cache/mediapipe/hand_landmarker.task` (fetch it with spikes/android/processing/fetch_model.sh).
"""

from __future__ import annotations

import builtins
import hashlib
import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PINS: dict[str, Any] = json.loads(
    (Path(__file__).with_name("hand_model.json")).read_text(encoding="utf-8")
)
DEFAULT_MODEL_PATH = Path.home() / ".cache/mediapipe/hand_landmarker.task"
MAX_HANDS: int = int(PINS["max_hands"])
NUM_LANDMARKS = 21


class HandModelError(RuntimeError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class VerifiedModel:
    path: Path
    sha256: str
    bytes: int
    asset_buffer: builtins.bytes = field(repr=False)


def resolve_model(path: str | os.PathLike[str] | None = None) -> VerifiedModel:
    chosen = Path(
        path or os.environ.get("STATEACTION_HAND_MODEL") or DEFAULT_MODEL_PATH
    )
    expected_size = int(PINS["bytes"])
    try:
        fd = os.open(chosen, os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError as error:
        raise HandModelError("E_MODEL_MISSING", str(chosen)) from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise HandModelError("E_MODEL_MISSING", str(chosen))
        if info.st_size != expected_size:
            raise HandModelError("E_MODEL_SIZE_MISMATCH", info.st_size)
        # Read a single descriptor through EOF, including one byte beyond the pin.
        with os.fdopen(fd, "rb", closefd=False) as source:
            asset_buffer = source.read(expected_size + 1)
    finally:
        os.close(fd)
    size = len(asset_buffer)
    if size != expected_size:
        raise HandModelError("E_MODEL_SIZE_MISMATCH", size)
    digest = hashlib.sha256(asset_buffer).hexdigest()
    if digest != PINS["sha256"]:
        raise HandModelError("E_MODEL_HASH_MISMATCH", digest)
    return VerifiedModel(chosen, digest, size, asset_buffer)


def provenance() -> dict[str, Any]:
    """Pinned model + runtime facts for reports (no local paths)."""
    out = {k: PINS[k] for k in PINS if k not in ("provenance",)}
    try:
        from importlib.metadata import version

        out["mediapipe_installed"] = version("mediapipe")
    except Exception:  # pragma: no cover - dependency absent
        out["mediapipe_installed"] = None
    return out
