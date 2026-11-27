"""Validate v1 contracts with jsonschema (Draft 2020-12) plus shared cross-field rules."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, validators
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from .canonical import MalformedJsonError, loads_strict
from .rules import RULES

# Current registry: an exact superset of the immutable catalog.v17.json, which
# is an exact superset of catalog.v16.json through catalog.v1.json (all immutable).
CATALOG_FILE = "catalog.v24.json"


def _api_dir() -> Path:
    """Prefer the repository's api/ (source of truth); wheels carry a packaged copy."""
    checkout = Path(__file__).resolve().parents[3] / "api"
    if (checkout / CATALOG_FILE).is_file():
        return checkout
    return Path(str(resources.files("stateaction_contracts") / "_api"))


def _ecma_pattern(validator: Any, pattern: str, instance: Any, schema: Any) -> Any:
    """ECMA-262 semantics: an unescaped trailing $ matches only at end of input."""
    if not validator.is_type(instance, "string"):
        return
    if not _compile(pattern).search(instance):
        yield ValidationError(f"{instance!r} does not match {pattern!r}")


@cache
def _compile(pattern: str) -> re.Pattern[str]:
    if pattern.endswith("$") and not pattern.endswith("\\$"):
        pattern = pattern[:-1] + r"\Z"
    return re.compile(pattern)


_Validator = validators.extend(Draft202012Validator, {"pattern": _ecma_pattern})


@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    code: str | None = None
    errors: list[dict[str, str]] = field(default_factory=list)
    value: object = None


class ContractViolation(ValueError):
    def __init__(self, contract: str, result: ValidationResult) -> None:
        super().__init__(f"{contract}: {result.code}")
        self.contract = contract
        self.result = result


@cache
def _catalog() -> dict[str, Any]:
    with open(_api_dir() / CATALOG_FILE, "rb") as file:
        catalog: dict[str, Any] = json.load(file)
    return catalog


@cache
def _validators() -> dict[str, Any]:
    api = _api_dir()
    catalog = _catalog()
    paths = [
        catalog["common"],
        *catalog.get("shared", []),
        *(c["schema"] for c in catalog["contracts"].values()),
    ]
    loaded = {p: json.loads((api / p).read_text("utf-8")) for p in paths}
    registry: Registry[Any] = Registry().with_resources(
        (doc["$id"], Resource.from_contents(doc, default_specification=DRAFT202012))
        for doc in loaded.values()
    )
    result = {}
    for cid, entry in catalog["contracts"].items():
        for rule in entry["rules"]:
            if rule not in RULES:
                raise LookupError(f"Unknown rule {rule} for {cid}")
        schema = loaded[entry["schema"]]
        Draft202012Validator.check_schema(schema)
        result[cid] = _Validator(schema, registry=registry)
    return result


def contract_ids() -> list[str]:
    return sorted(_catalog()["contracts"])


def _fail(code: str, path: str = "", message: str | None = None) -> ValidationResult:
    return ValidationResult(False, code, [{"path": path, "message": message or code}])


def _well_formed(value: object, depth: int, max_depth: int) -> bool:
    if isinstance(value, bool) or value is None:
        return True
    if isinstance(value, int):
        # JSON numbers are IEEE-754 doubles in TypeScript and Dart: an integer
        # token that rounds to infinity is malformed there, so it is here too.
        try:
            float(value)
        except OverflowError:
            return False
        return True
    if isinstance(value, float):
        return value == value and value not in (float("inf"), float("-inf"))
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            return False
        return True
    if depth >= max_depth:
        return False
    if isinstance(value, list):
        return all(_well_formed(x, depth + 1, max_depth) for x in value)
    if isinstance(value, dict):
        return all(
            _well_formed(k, depth, max_depth) and _well_formed(x, depth + 1, max_depth)
            for k, x in value.items()
        )
    return False


def _pointer(error: ValidationError) -> str:
    return "".join(
        "/" + str(p).replace("~", "~0").replace("/", "~1") for p in error.absolute_path
    )


def _accepted(found: object, accepted: list[object]) -> bool:
    """Exact JSON-typed match: "1" is not 1 and true is not 1."""
    for a in accepted:
        if isinstance(found, bool) or isinstance(a, bool):
            continue
        if isinstance(a, str) and isinstance(found, str) and a == found:
            return True
        if isinstance(a, int) and isinstance(found, (int, float)) and a == found:
            return True
    return False


def validate_value(contract: str, value: object) -> ValidationResult:
    catalog = _catalog()
    entry = catalog["contracts"].get(contract)
    if entry is None:
        raise LookupError(f"Unknown contract {contract}")
    if not _well_formed(value, 0, catalog["maxDepth"]):
        return _fail("malformed_json")
    version = entry["version"]
    if (
        version
        and "field" in version
        and isinstance(value, dict)
        and version["field"] in value
    ):
        if not _accepted(value[version["field"]], version["accepted"]):
            return _fail("unsupported_version", "/" + version["field"])
    errors = list(_validators()[contract].iter_errors(value))
    if errors:
        return ValidationResult(
            False,
            "schema_violation",
            [{"path": _pointer(e), "message": e.message} for e in errors],
        )
    for rule in entry["rules"]:
        violation = RULES[rule](value)
        if violation:
            return _fail(violation[0], violation[1], rule)
    return ValidationResult(True, value=value)


def validate_bytes(contract: str, data: bytes) -> ValidationResult:
    entry = _catalog()["contracts"].get(contract)
    if entry is None:
        raise LookupError(f"Unknown contract {contract}")
    if len(data) > entry["maxBytes"]:
        return _fail("document_too_large")
    if data.startswith(b"\xef\xbb\xbf"):
        return _fail("malformed_json", "", "byte order mark")
    try:
        value = loads_strict(data.decode("utf-8"))
    except (UnicodeDecodeError, MalformedJsonError):
        return _fail("malformed_json")
    return validate_value(contract, value)


def parse_contract(contract: str, value: object) -> object:
    result = validate_value(contract, value)
    if not result.valid:
        raise ContractViolation(contract, result)
    return result.value
