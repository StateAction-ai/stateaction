"""Non-secret correlation for terminal Modal results."""

import hashlib
from typing import Any


def call_binding(bootstrap: dict[str, Any]) -> str | None:
    token = bootstrap.get("bootstrapToken")
    if not isinstance(token, str) or not token:
        return None
    parts = [
        bootstrap.get("apiUrl"),
        bootstrap.get("jobId"),
        bootstrap.get("stage", ""),
        bootstrap.get("module", ""),
        hashlib.sha256(token.encode()).hexdigest(),
    ]
    if not all(isinstance(part, str) and "\n" not in part for part in parts):
        return None
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()
