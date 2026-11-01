"""StateAction v1 contract validation shared with the TypeScript and Dart adapters."""

from .canonical import (
    MalformedJsonError,
    NoncanonicalValueError,
    canonical_json,
    canonical_json_text,
    classify_replay,
    request_sha256,
    sha256_hex,
    verify_stored_bytes,
)
from .rules import HAND_ARRAY_SHAPES, check_sealed_inventory
from .validate import (
    ContractViolation,
    ValidationResult,
    contract_ids,
    parse_contract,
    validate_bytes,
    validate_value,
)

__version__ = "0.1.0"
__all__ = [
    "HAND_ARRAY_SHAPES",
    "ContractViolation",
    "MalformedJsonError",
    "NoncanonicalValueError",
    "ValidationResult",
    "canonical_json",
    "canonical_json_text",
    "check_sealed_inventory",
    "classify_replay",
    "contract_ids",
    "parse_contract",
    "request_sha256",
    "sha256_hex",
    "validate_bytes",
    "validate_value",
    "verify_stored_bytes",
]
