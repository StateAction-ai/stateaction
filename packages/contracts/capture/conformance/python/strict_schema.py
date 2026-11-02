"""Portable strict JSON-Schema subset interpreter (reference; ported to TS, Dart, Kotlin and Swift).

Fail closed: loading a schema that uses any keyword outside SUPPORTED, a non-local `$ref`, an unanchored
pattern or an unknown type raises SchemaUnsupported. Validation returns every violation as a sorted list of
"<instance pointer>:<keyword>" strings; verify.py checks the same set against jsonschema's
Draft202012Validator for every JSON message in the corpus.

Semantics (identical in every port):
- numbers: `integer` = finite number with zero fraction (booleans are never numbers); minimum/maximum
  apply to every non-boolean number.
- pattern: the whole string must match (`^...$` anchored ECMA-262 subset, ASCII classes only), so a
  trailing newline never satisfies `$`.
- length: Unicode code points.
- const/enum: deep JSON equality (1 == 1.0; true != 1; object key sets must match).
- pointer tokens: UTF-8 bytes outside [A-Za-z0-9._-] are written %XX; arrays use decimal indexes.
- error collection: type-specific keywords ignore other types; `anyOf` failure is one `anyOf` error;
  `allOf`, `$ref`, `if/then`, `properties`, `items` and map `additionalProperties` report the nested
  errors; `additionalProperties: false` is one error at the object; `propertyNames` errors are reported at
  the object with the nested keyword; `required` reports once per object.
JSON text is parsed strictly (identical in every port; see parse_json): a leading UTF-8 BOM, invalid UTF-8,
nesting deeper than MAX_DEPTH (32) open arrays/objects, duplicate object keys (compared as exact code point
sequences, never Unicode-normalized), \\u escapes that leave an unpaired surrogate (RFC 7493 I-JSON),
NaN/Infinity and numbers that overflow a double are malformed.
"""

from __future__ import annotations

import json
import math
import re

SUPPORTED = {
    "$schema",
    "$id",
    "$defs",
    "$ref",
    "title",
    "description",
    "type",
    "const",
    "enum",
    "required",
    "properties",
    "additionalProperties",
    "propertyNames",
    "minProperties",
    "maxProperties",
    "items",
    "minItems",
    "maxItems",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "anyOf",
    "allOf",
    "if",
    "then",
}
TYPES = {"object", "array", "string", "integer", "number", "boolean", "null"}
SAFE = set(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")


class SchemaUnsupported(Exception):
    pass


class MalformedJson(ValueError):
    pass


MAX_DEPTH = 32
BOM = b"\xef\xbb\xbf"


def nesting_exceeds(text: str, limit: int = MAX_DEPTH) -> bool:
    """True when more than `limit` arrays/objects are open at once (string contents are skipped).

    Runs before the recursive parse so the depth bound, not the runtime stack, decides the outcome.
    """
    depth, i, n = 0, 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif c in "[{":
            depth += 1
            if depth > limit:
                return True
        elif c in "]}":
            depth -= 1
        i += 1
    return False


def _check_scalars(value) -> None:
    """Reject strings/keys holding an unpaired surrogate (only reachable through \\u escapes)."""
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            if any(0xD800 <= ord(ch) <= 0xDFFF for ch in v):
                raise MalformedJson("unpaired surrogate escape")
        elif isinstance(v, list):
            stack.extend(v)
        elif isinstance(v, dict):
            stack.extend(v.keys())
            stack.extend(v.values())


def parse_json(data: bytes):
    """Strict RFC 8259 / RFC 7493 parse (rules in the module docstring)."""

    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                raise MalformedJson(f"duplicate key {k!r}")
            out[k] = v
        return out

    def bad_constant(name):
        raise MalformedJson(name)

    def finite(text):
        value = float(text)
        if not math.isfinite(value):
            raise MalformedJson(f"number overflows a double: {text}")
        return value

    def integer(text):
        value = int(text)
        try:
            float(value)
        except OverflowError:
            raise MalformedJson(f"number overflows a double: {text[:20]}...") from None
        return value

    if data.startswith(BOM):
        raise MalformedJson("UTF-8 byte order mark")
    try:
        text = data.decode("utf-8")
        if nesting_exceeds(text):
            raise MalformedJson(f"nesting deeper than {MAX_DEPTH}")
        value = json.loads(
            text,
            object_pairs_hook=pairs,
            parse_constant=bad_constant,
            parse_float=finite,
            parse_int=integer,
        )
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise MalformedJson(str(e)) from None
    _check_scalars(value)
    return value


def token(key) -> str:
    if isinstance(key, int):
        return str(key)
    return "".join(
        chr(b) if b in SAFE else f"%{b:02X}"
        for b in key.encode("utf-8", "surrogatepass")
    )


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_type(v, t: str) -> bool:
    if t == "null":
        return v is None
    if t == "boolean":
        return isinstance(v, bool)
    if t == "string":
        return isinstance(v, str)
    if t == "array":
        return isinstance(v, list)
    if t == "object":
        return isinstance(v, dict)
    if t == "number":
        return _is_number(v)
    if t == "integer":
        if isinstance(v, float):
            return math.isfinite(v) and v.is_integer()
        return _is_number(v)
    raise SchemaUnsupported(t)


def json_equal(a, b) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b))
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return False


class Schema:
    def __init__(self, root: dict):
        self.root = root
        self.patterns: dict[str, re.Pattern] = {}
        self._check(root, "#")

    # ------------------------------------------------------------- load-time fail-closed check
    def _check(self, s, where: str):
        if not isinstance(s, dict):
            raise SchemaUnsupported(f"{where}: schema must be an object")
        for k, v in s.items():
            if k not in SUPPORTED:
                raise SchemaUnsupported(f"{where}: unsupported keyword {k}")
            if k == "$defs" and where != "#":
                raise SchemaUnsupported(f"{where}: $defs only at the root")
        if "$defs" in s:
            for name, sub in s["$defs"].items():
                self._check(sub, f"{where}/$defs/{name}")
        if "$ref" in s:
            r = s["$ref"]
            if not (isinstance(r, str) and r.startswith("#/$defs/")) or r[
                8:
            ] not in self.root.get("$defs", {}):
                raise SchemaUnsupported(
                    f"{where}: unresolvable or non-local $ref {r!r}"
                )
        if "type" in s:
            ts = s["type"] if isinstance(s["type"], list) else [s["type"]]
            if not ts or any(t not in TYPES for t in ts):
                raise SchemaUnsupported(f"{where}: type {s['type']!r}")
        if "enum" in s and not (isinstance(s["enum"], list) and s["enum"]):
            raise SchemaUnsupported(f"{where}: enum must be a non-empty array")
        if "required" in s and not (
            isinstance(s["required"], list)
            and all(isinstance(x, str) for x in s["required"])
        ):
            raise SchemaUnsupported(f"{where}: required must be a string array")
        if "pattern" in s:
            p = s["pattern"]
            if (
                not (isinstance(p, str) and p.startswith("^") and p.endswith("$"))
                or not p.isascii()
            ):
                raise SchemaUnsupported(
                    f"{where}: pattern must be an anchored ASCII ^...$ expression"
                )
            self.patterns[p] = re.compile(p, re.ASCII)
        for k in (
            "minProperties",
            "maxProperties",
            "minItems",
            "maxItems",
            "minLength",
            "maxLength",
        ):
            if k in s and not (
                isinstance(s[k], int) and not isinstance(s[k], bool) and s[k] >= 0
            ):
                raise SchemaUnsupported(f"{where}: {k} must be a non-negative integer")
        for k in ("minimum", "maximum"):
            if k in s and not _is_number(s[k]):
                raise SchemaUnsupported(f"{where}: {k} must be a number")
        if "properties" in s:
            if not isinstance(s["properties"], dict):
                raise SchemaUnsupported(f"{where}: properties must be an object")
            for name, sub in s["properties"].items():
                self._check(sub, f"{where}/properties/{name}")
        if "additionalProperties" in s and s["additionalProperties"] is not False:
            self._check(s["additionalProperties"], f"{where}/additionalProperties")
        for k in ("propertyNames", "items", "if", "then"):
            if k in s:
                self._check(s[k], f"{where}/{k}")
        if "then" in s and "if" not in s:
            raise SchemaUnsupported(f"{where}: then without if")
        for k in ("anyOf", "allOf"):
            if k in s:
                if not (isinstance(s[k], list) and s[k]):
                    raise SchemaUnsupported(f"{where}: {k} must be a non-empty array")
                for i, sub in enumerate(s[k]):
                    self._check(sub, f"{where}/{k}/{i}")

    # ------------------------------------------------------------- validation
    def validate(self, instance) -> list[str]:
        out: set[str] = set()
        self._v(self.root, instance, "", out)
        return sorted(out)

    def _valid(self, s, v) -> bool:
        out: set[str] = set()
        self._v(s, v, "", out)
        return not out

    def _v(self, s: dict, v, path: str, out: set):
        def err(kw, p=path):
            out.add(f"{p}:{kw}")

        if "$ref" in s:
            self._v(self.root["$defs"][s["$ref"][8:]], v, path, out)
        if "type" in s:
            ts = s["type"] if isinstance(s["type"], list) else [s["type"]]
            if not any(_is_type(v, t) for t in ts):
                err("type")
        if "const" in s and not json_equal(v, s["const"]):
            err("const")
        if "enum" in s and not any(json_equal(v, e) for e in s["enum"]):
            err("enum")
        if isinstance(v, str):
            n = len(v)
            if "minLength" in s and n < s["minLength"]:
                err("minLength")
            if "maxLength" in s and n > s["maxLength"]:
                err("maxLength")
            if "pattern" in s and self.patterns[s["pattern"]].fullmatch(v) is None:
                err("pattern")
        if _is_number(v):
            if "minimum" in s and v < s["minimum"]:
                err("minimum")
            if "maximum" in s and v > s["maximum"]:
                err("maximum")
        if isinstance(v, list):
            if "minItems" in s and len(v) < s["minItems"]:
                err("minItems")
            if "maxItems" in s and len(v) > s["maxItems"]:
                err("maxItems")
            if "items" in s:
                for i, x in enumerate(v):
                    self._v(s["items"], x, f"{path}/{i}", out)
        if isinstance(v, dict):
            if "required" in s and any(k not in v for k in s["required"]):
                err("required")
            if "minProperties" in s and len(v) < s["minProperties"]:
                err("minProperties")
            if "maxProperties" in s and len(v) > s["maxProperties"]:
                err("maxProperties")
            props = s.get("properties", {})
            for k, x in v.items():
                if k in props:
                    self._v(props[k], x, f"{path}/{token(k)}", out)
            if "additionalProperties" in s:
                extra = [k for k in v if k not in props]
                if s["additionalProperties"] is False:
                    if extra:
                        err("additionalProperties")
                else:
                    for k in extra:
                        self._v(
                            s["additionalProperties"], v[k], f"{path}/{token(k)}", out
                        )
            if "propertyNames" in s:
                for k in v:
                    self._v(s["propertyNames"], k, path, out)
        if "allOf" in s:
            for sub in s["allOf"]:
                self._v(sub, v, path, out)
        if "anyOf" in s and not any(self._valid(sub, v) for sub in s["anyOf"]):
            err("anyOf")
        if "if" in s and "then" in s and self._valid(s["if"], v):
            self._v(s["then"], v, path, out)
