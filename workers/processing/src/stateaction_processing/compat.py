"""Review boundary for the frozen Android interoperability adapter.

The optional CPU command consumes a local path, not production storage grants.
The unchanged original remains the spike/evidence source of truth.
"""
import hashlib
import json
from pathlib import Path
from typing import Any, cast


def process_local(source: Path, output: Path, expected_sha256: str, model: Path,
                  allow_simulation_profile: bool = False) -> dict[str, Any]:
    if len(expected_sha256) != 64 or any(c not in "0123456789abcdef" for c in expected_sha256):
        raise ValueError("Expected lowercase SHA256")
    directory = Path(__file__).parent / "_compat"
    provenance = json.loads((directory / "provenance.json").read_text())
    if hashlib.sha256((directory / "android_processing.py").read_bytes()).hexdigest() != provenance["source_sha256"]:
        raise ValueError("Compatibility source changed without review")
    from ._compat.android_processing import process
    return cast(dict[str, Any], process(source, output, model=model, expected_sha256=expected_sha256,
                   allow_simulation_profile=allow_simulation_profile))
