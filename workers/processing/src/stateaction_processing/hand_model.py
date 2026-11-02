"""Pinned hand landmarker model: provenance and hash-verified location (SA-30).

The pins live in `hand_model.json` (reused from the merged SA-61 spike). The model file is never
committed or silently downloaded: `resolve_model` verifies byte count and SHA-256 of an existing
local file and fails otherwise. `STATEACTION_HAND_MODEL` overrides the default cache path
`~/.cache/mediapipe/hand_landmarker.task` (fetch it with spikes/android/processing/fetch_model.sh).
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
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


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def resolve_model(path: str | os.PathLike[str] | None = None) -> VerifiedModel:
    chosen = Path(
        path or os.environ.get("STATEACTION_HAND_MODEL") or DEFAULT_MODEL_PATH
    )
    if not chosen.is_file():
        raise HandModelError("E_MODEL_MISSING", str(chosen))
    size = chosen.stat().st_size
    if size != PINS["bytes"]:
        raise HandModelError("E_MODEL_SIZE_MISMATCH", size)
    digest = file_sha256(chosen)
    if digest != PINS["sha256"]:
        raise HandModelError("E_MODEL_HASH_MISMATCH", digest)
    return VerifiedModel(chosen, digest, size)


def provenance() -> dict[str, Any]:
    """Pinned model + runtime facts for reports (no local paths)."""
    out = {k: PINS[k] for k in PINS if k not in ("provenance",)}
    try:
        from importlib.metadata import version

        out["mediapipe_installed"] = version("mediapipe")
    except Exception:  # pragma: no cover - dependency absent
        out["mediapipe_installed"] = None
    return out
