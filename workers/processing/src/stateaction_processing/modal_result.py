"""Non-secret correlation for terminal Modal results."""

import hashlib
import json
from typing import Any

from stateaction_contracts import validate_value

RECEIPT_MAX_BYTES = 64 * 1024


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


def parse_worker_receipt(
    line: bytes, bootstrap: dict[str, Any], exit_code: int
) -> dict[str, Any] | None:
    """A diagnostic line cannot stand in for the child's stage receipt."""
    if not line or len(line) > RECEIPT_MAX_BYTES:
        return None
    try:
        value = json.loads(line)
    except ValueError:
        return None
    if (
        not isinstance(value, dict)
        or not validate_value("jobs.stage-receipt.v1", value).valid
        or any(value[k] != bootstrap.get(k) for k in ("jobId", "stage", "module"))
        or (value["status"] == "succeeded") != (exit_code == 0)
    ):
        return None
    return value
