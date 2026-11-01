"""sa-cjson-v1 request digests and exact stored-byte manifest digests."""

from __future__ import annotations

import hashlib
import json
from typing import Literal

MAX_SAFE = 9007199254740991
_SHORT = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


class NoncanonicalValueError(TypeError):
    code = "noncanonical_value"


class MalformedJsonError(ValueError):
    code = "malformed_json"


def _reject_constant(name: str) -> object:
    raise MalformedJsonError(f"Non-standard JSON constant {name}")


def loads_strict(text: str) -> object:
    """json.loads without NaN/Infinity literals (rejected by every adapter)."""
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except MalformedJsonError:
        raise
    except (ValueError, RecursionError) as error:
        raise MalformedJsonError("Invalid JSON text") from error


def _string(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise NoncanonicalValueError("String contains a lone surrogate") from error
    out = ['"']
    for ch in value:
        code = ord(ch)
        out.append(_SHORT.get(ch) or (f"\\u{code:04x}" if code < 0x20 else ch))
    out.append('"')
    return "".join(out)


def _utf16_key(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


def canonical_json(value: object) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float):
        if not value.is_integer():  # also rejects NaN and infinities
            raise NoncanonicalValueError("Only safe integers are canonical")
        value = int(value)
    if isinstance(value, int):
        if not -MAX_SAFE <= value <= MAX_SAFE:
            raise NoncanonicalValueError("Integer outside the safe range")
        return str(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=_utf16_key)
        return (
            "{"
            + ",".join(f"{_string(k)}:{canonical_json(value[k])}" for k in keys)
            + "}"
        )
    raise NoncanonicalValueError(f"Unsupported value type {type(value).__name__}")


def canonical_json_text(text: str) -> str:
    return canonical_json(loads_strict(text))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def request_sha256(value: object) -> str:
    return sha256_hex(canonical_json(value).encode("utf-8"))


def classify_replay(
    stored_sha256: str, request: object
) -> Literal["replay", "idempotency_conflict"]:
    return (
        "replay" if request_sha256(request) == stored_sha256 else "idempotency_conflict"
    )


def verify_stored_bytes(
    data: bytes, declared_sha256: str
) -> Literal["match", "digest_mismatch"]:
    return "match" if sha256_hex(data) == declared_sha256 else "digest_mismatch"
