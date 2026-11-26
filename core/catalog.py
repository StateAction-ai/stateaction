"""Discover modules and derive their locks and Python recipe bindings."""

import hashlib
import json
import keyword
import re
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry
from sandbox import canonical_json

ROOT = Path(__file__).resolve().parents[1]
ID = r"[a-z][a-z0-9_]{0,31}"
ARTIFACT = rf"{ID}@[1-9][0-9]{{0,8}}"
GPU_RATES = {"H100": "5.00", "RTX-PRO-6000": "3.00"}
CPU_RATE = "0.10"
PARAMETER_TYPES = {"string": str, "integer": int, "boolean": bool}
PARAMETER_CONSTRAINTS = {
    "string": {"minLength", "maxLength"},
    "integer": {"minimum", "maximum"},
    "boolean": set(),
}


def offline_validator(schema):
    return Draft202012Validator(schema, registry=Registry())


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pretty(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"


def refresh(path: Path, content: str, *, check: bool) -> None:
    if check:
        if not path.is_file() or path.read_text() != content:
            raise ValueError(
                f"{path}: stale or missing generated file. Run recipe sync."
            )
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.is_file() or path.read_text() != content:
            path.write_text(content)


def modules(root: Path, *, check: bool) -> dict:
    catalog = {}
    artifacts = {"recording_source@2", "video_range@1"}
    directories = sorted(path for path in (root / "modules").iterdir() if path.is_dir())
    for directory in directories:
        path = directory / "manifest.json"
        manifest = json.loads(path.read_text())
        required = {
            "id",
            "version",
            "scope",
            "inputs",
            "outputs",
            "params",
            "gpus",
            "maxBudgetSeconds",
            "license",
            "commercialUse",
            "passthroughPlan",
        }
        if type(manifest) is not dict or manifest.keys() != required:
            raise ValueError(
                f"{path}: module manifest fields differ from the documented format"
            )
        module = manifest["id"]
        version = manifest["version"]
        scope = manifest["scope"]
        if (
            not isinstance(module, str)
            or not re.fullmatch(ID, module)
            or keyword.iskeyword(module)
            or path.parent.name != module
            or type(version) is not int
            or not 1 <= version <= 999_999_999
            or scope not in ("recording", "clip")
            or type(manifest["gpus"]) is not list
            or len(set(manifest["gpus"])) != len(manifest["gpus"])
            or any(gpu not in GPU_RATES for gpu in manifest["gpus"])
            or type(manifest["maxBudgetSeconds"]) is not int
            or not 1 <= manifest["maxBudgetSeconds"] <= 86400
            or type(manifest["commercialUse"]) is not bool
            or not isinstance(manifest["license"], str)
            or not manifest["license"]
            or type(manifest["passthroughPlan"]) is not bool
        ):
            raise ValueError(
                f"{path}: check module identity, scope, resources and license"
            )
        for ports in (manifest["inputs"], manifest["outputs"]):
            if not isinstance(ports, dict):
                raise ValueError(f"{path}: declare input and output ports as objects")
            for name, kind in ports.items():
                check_identifier(name)
                if not isinstance(kind, str) or not re.fullmatch(ARTIFACT, kind):
                    raise ValueError(f"{path}: expected artifact id@major for {name}")
        if not manifest["outputs"]:
            raise ValueError(f"{path}: declare at least one output")
        if manifest["passthroughPlan"] and (
            scope != "recording" or "clip_plan@1" not in manifest["outputs"].values()
        ):
            raise ValueError(
                f"{path}: a passthrough plan must emit a recording clip_plan@1"
            )
        params = manifest["params"]
        if not isinstance(params, dict) or any(
            not isinstance(spec, dict) for spec in params.values()
        ):
            raise ValueError(f"{path}: declare params as objects")
        for name, spec in params.items():
            check_identifier(name)
            kind = spec.get("type")
            if name in manifest["inputs"] or kind not in PARAMETER_TYPES:
                raise ValueError(f"{path}: invalid parameter {name}")
            allowed = {
                "type",
                "enum",
                "default",
                "description",
            } | PARAMETER_CONSTRAINTS[kind]
            if spec.keys() - allowed:
                raise ValueError(f"{path}: unsupported constraint on parameter {name}")
            value_type = PARAMETER_TYPES[kind]
            if any(type(value) is not value_type for value in spec.get("enum", [])):
                raise ValueError(f"{path}: enum values must match the type of {name}")
            if "default" in spec and type(spec["default"]) is not value_type:
                raise ValueError(f"{path}: the default must match the type of {name}")
            canonical_json(spec)
        Draft202012Validator.check_schema(parameter_schema(params))
        for spec in params.values():
            if "default" in spec:
                offline_validator(spec).validate(spec["default"])
        implementation = path.parent / "impl.py"
        lock = {
            "schema": "stateaction.module-lock/v1",
            "manifest": manifest,
            "implementationSha256": sha256(implementation.read_bytes()),
        }
        refresh(path.parent / "module.lock.json", pretty(lock), check=check)
        catalog[f"{module}@{version}"] = lock
        artifacts.update(manifest["outputs"].values())
    for lock in catalog.values():
        manifest = lock["manifest"]
        if unknown := set(manifest["inputs"].values()) - artifacts:
            raise ValueError(
                f"{manifest['id']}: unknown artifact types {sorted(unknown)}"
            )
    return catalog


def check_identifier(name: str) -> None:
    if not re.fullmatch(ID, name) or keyword.iskeyword(name):
        raise ValueError(f"{name!r}: expected a lowercase Python identifier")


def parameter_schema(params: dict) -> dict:
    return {
        "type": "object",
        "properties": params,
        "additionalProperties": False,
        "required": [name for name, spec in params.items() if "default" not in spec],
    }


def bindings(catalog: dict) -> str:
    source = [
        "# fmt: off",
        "# Generated by recipe sync from module locks. Do not edit.",
        "from typing import Literal, NamedTuple",
        "",
        "from stateaction_recipes import Call, Handle",
        "",
        "__all__ = " + repr([lock["manifest"]["id"] for lock in catalog.values()]),
    ]
    types = {"boolean": "bool", "integer": "int", "string": "str"}
    for ref, lock in catalog.items():
        manifest = lock["manifest"]
        name, scope = manifest["id"], repr(manifest["scope"])
        output_type = f"_Outputs_{name}"

        def handle(kind):
            return f"Handle[Literal[{kind!r}], Literal[{scope}]]"

        source.extend(["", "", f"class {output_type}(NamedTuple):"])
        for port, artifact in sorted(manifest["outputs"].items()):
            source.append(f"    {port}: {handle(artifact)}")
        arguments = [
            f"{port}: {handle(artifact)}"
            for port, artifact in sorted(manifest["inputs"].items())
        ]
        params = manifest["params"]
        for param, spec in sorted(params.items()):
            annotation = types[spec["type"]]
            if spec.get("enum"):
                annotation = f"Literal[{', '.join(map(repr, spec['enum']))}]"
            default = f" = {spec['default']!r}" if "default" in spec else ""
            arguments.append(f"{param}: {annotation}{default}")
        signature = ", ".join(["*", *arguments]) if arguments else ""
        inputs = ", ".join(f"{key!r}: {key}" for key in sorted(manifest["inputs"]))
        values = ", ".join(f"{key!r}: {key}" for key in sorted(params))
        outputs = ", ".join(
            f"Handle(f'{{node}}.{key}')" for key in sorted(manifest["outputs"])
        )
        source.extend(
            [
                "",
                "",
                f"def {name}({signature}) -> Call[{output_type}, Literal[{scope}]]:",
                f"    return Call({ref!r}, {{{inputs}}}, {{{values}}}, lambda node: {output_type}({outputs}))",
            ]
        )
    return "\n".join(source) + "\n"
