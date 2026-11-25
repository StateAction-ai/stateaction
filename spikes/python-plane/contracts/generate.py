"""Generate the spike's static types from the versioned API JSON Schemas."""

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urldefrag, urljoin

HERE = Path(__file__).resolve().parent
API = HERE.parents[2] / "packages" / "contracts" / "api"
CATALOG = "catalog.v23.json"
HTTP_CONTRACTS = {
    "http.dag-run.v1",
    "http.error-envelope.v1",
    "http.success-envelope.v1",
}
SCALARS = {
    "string": "str",
    "integer": "int",
    "number": "float",
    "boolean": "bool",
    "null": "None",
}


def name_part(value):
    return "".join(
        piece[0].upper() + piece[1:] for piece in re.findall("[a-zA-Z0-9]+", value)
    )


class Generator:
    def __init__(self, schemas):
        self.schemas = schemas
        self.names = {}
        self.blocks = []

    def declare(self, uri, pointer=()):
        location = (uri, pointer)
        if location in self.names:
            return self.names[location]

        file_name = uri.split("/schemas/", 1)[1].removesuffix(".json")
        suffix = tuple(
            piece for piece in pointer if piece not in {"properties", "$defs"}
        )
        name = name_part(file_name) + "".join(map(name_part, suffix))
        if name in self.names.values():
            raise ValueError(f"Duplicate generated name {name}: {location}")
        self.names[location] = name

        schema = self.schemas[uri]
        for part in pointer:
            schema = schema[int(part)] if isinstance(schema, list) else schema[part]

        if "properties" in schema:
            if schema.get("additionalProperties") is not False:
                raise ValueError(
                    f"Record with open keys requires a type mapping: {location}"
                )
            fields = {}
            required = set(schema.get("required", []))
            for key in schema["properties"]:
                field_type = self.expression(
                    uri, (*pointer, "properties", key), schema["properties"][key]
                )
                fields[key] = (
                    field_type if key in required else f"NotRequired[{field_type}]"
                )
            formatted = "".join(
                f"        {key!r}: {field_type},\n"
                for key, field_type in fields.items()
            )
            body = f"{name} = TypedDict(\n    {name!r},\n    {{\n{formatted}    }},\n)"
        else:
            body = f"type {name} = {self.expression(uri, pointer, schema)}"
        self.blocks.append(body)
        return name

    def expression(self, uri, pointer, schema):
        if schema is True or (
            isinstance(schema, dict) and schema.keys() <= {"description", "title"}
        ):
            return "object"
        if schema is False:
            return "Never"
        if "$ref" in schema:
            target, fragment = urldefrag(urljoin(uri, schema["$ref"]))
            parts = tuple(
                p.replace("~1", "/").replace("~0", "~") for p in fragment.split("/")[1:]
            )
            return self.declare(target, parts)
        if "const" in schema or "enum" in schema:
            literals = schema["enum"] if "enum" in schema else [schema["const"]]
            return "Literal[" + ", ".join(map(repr, literals)) + "]"
        for keyword in ("oneOf", "anyOf"):
            if keyword in schema:
                return self.union(
                    self.expression(uri, (*pointer, keyword, str(i)), item)
                    for i, item in enumerate(schema[keyword])
                )
        if "properties" in schema:
            return self.declare(uri, pointer)

        kind = schema.get("type")
        if isinstance(kind, list):
            return self.union(
                self.expression(uri, pointer, {**schema, "type": k}) for k in kind
            )
        if kind == "array":
            if "prefixItems" in schema and schema.get("items") is False:
                items = self.union(
                    self.expression(uri, (*pointer, "prefixItems", str(i)), item)
                    for i, item in enumerate(schema["prefixItems"])
                )
            else:
                items = self.expression(
                    uri, (*pointer, "items"), schema.get("items", True)
                )
            return f"list[{items}]"
        if kind == "object":
            values = self.expression(
                uri,
                (*pointer, "additionalProperties"),
                schema.get("additionalProperties", True),
            )
            return f"dict[str, {values}]"
        if kind not in SCALARS:
            raise ValueError(f"Unsupported schema shape at {uri} {pointer}")
        return SCALARS[kind]

    @staticmethod
    def union(types):
        return " | ".join(dict.fromkeys(types))


def generate():
    catalog = json.loads((API / CATALOG).read_text())
    entries = catalog["contracts"]
    paths = {entry["schema"] for entry in entries.values()}
    paths.update([catalog["common"], *catalog["shared"]])
    documents = [json.loads((API / path).read_text()) for path in sorted(paths)]
    generator = Generator({schema["$id"]: schema for schema in documents})

    declared = {}
    for contract, entry in sorted(entries.items()):
        if contract.startswith("jobs.") or contract in HTTP_CONTRACTS:
            declared[contract] = generator.declare(entry["id"])

    header = (
        "# fmt: off\n"
        f"# Generated by generate.py from {CATALOG}. Do not edit.\n"
        '"""Static JSON shapes. The shared wire validator enforces schema and catalog rules."""\n\n'
        "from typing import Literal, Never, NotRequired, TypedDict, overload\n\n"
        "from stateaction_contracts import ContractViolation, validate_bytes"
    )
    overloads = "\n\n".join(
        f"@overload\ndef parse_wire(contract: Literal[{key!r}], data: bytes) -> {name}: ..."
        for key, name in declared.items()
    )
    parser = (
        "def parse_wire(contract: str, data: bytes) -> object:\n"
        "    result = validate_bytes(contract, data)\n"
        "    if not result.valid:\n"
        "        raise ContractViolation(contract, result)\n"
        "    return result.value"
    )
    return (
        "\n\n".join([header, *generator.blocks])
        + "\n\n\n"
        + overloads
        + "\n\n\n"
        + parser
        + "\n"
    )


if __name__ == "__main__":
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--check", action="store_true")
    destination = HERE / "generated.py"
    expected = generate()
    if arguments.parse_args().check:
        if not destination.is_file() or destination.read_text() != expected:
            raise SystemExit("Generated Python contracts differ from the JSON Schemas")
    else:
        destination.write_text(expected)
