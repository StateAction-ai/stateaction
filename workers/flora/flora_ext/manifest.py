"""MANIFEST.json writer and verifier for published FLORA FP8 checkpoints (SA-93). Stdlib only."""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any

from . import pins

SCHEMA = "stateaction.flora_checkpoint_manifest.v1"
MANIFEST_NAME = "MANIFEST.json"
FORMATS = ("compressed-tensors", "vllm-sharded-state")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
REQUIRED_TOP = (
    "schema",
    "checkpoint_id",
    "model",
    "hf",
    "source",
    "quant",
    "format",
    "runtime",
    "files",
    "code_revision",
    "parity_receipt",
    "created_utc",
)
REQUIRED_RUNTIME = ("vllm", "torch", "cuda", "transformers", "gpu_name", "gpu_arch")


class ManifestError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(16 << 20):
            h.update(chunk)
    return h.hexdigest()


def file_digests(root: Path) -> dict[str, dict[str, Any]]:
    """sha256 and size of every file under root except the manifest itself, keyed by POSIX relative path."""
    out: dict[str, dict[str, Any]] = {}
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.name != MANIFEST_NAME:
            out[p.relative_to(root).as_posix()] = {
                "sha256": sha256_file(p),
                "bytes": p.stat().st_size,
            }
    return out


def tree_digest(files: dict[str, dict[str, Any]]) -> str:
    """Order-independent digest over (path, sha256) pairs; used as the merge digest of the merged adapter."""
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(f"{rel} {files[rel]['sha256']}\n".encode())
    return h.hexdigest()


def checkpoint_id(model: str, revision: str, fmt: str, version: int = 1) -> str:
    if model not in pins.MODELS:
        raise ManifestError(f"unknown model {model!r}")
    if fmt not in FORMATS:
        raise ManifestError(f"unknown format {fmt!r}")
    return f"{model}-{revision[:8]}-fp8_per_tensor-{fmt}-v{version}"


def build_manifest(
    *,
    model: str,
    fmt: str,
    files: dict[str, dict[str, Any]],
    source: dict[str, Any],
    runtime: dict[str, Any],
    code_revision: str,
    parity_receipt: dict[str, Any],
    version: int = 1,
    quant: dict[str, Any] | None = None,
    format_note: str = "",
    created_utc: str | None = None,
) -> dict[str, Any]:
    spec = pins.MODELS[model]
    m: dict[str, Any] = {
        "schema": SCHEMA,
        "checkpoint_id": checkpoint_id(model, spec["revision"], fmt, version),
        "model": model,
        "hf": dict(spec),
        "source": dict(source),
        "quant": dict(quant or pins.QUANT_CONFIG),
        "format": {"name": fmt, "note": format_note},
        "runtime": dict(runtime),
        "files": files,
        "code_revision": code_revision,
        "parity_receipt": parity_receipt,
        "created_utc": created_utc
        or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if model == "tempseg":
        m["base"] = {"repo": pins.BASE_REPO, "revision": pins.BASE_REV}
    problems = validate_manifest(m)
    if problems:
        raise ManifestError("; ".join(problems))
    return m


def validate_manifest(m: dict[str, Any]) -> list[str]:
    """Structural and identity checks that need no files. Returns a list of problems (empty = valid)."""
    p: list[str] = []
    for k in REQUIRED_TOP:
        if k not in m:
            p.append(f"missing {k}")
    if p:
        return p
    if m["schema"] != SCHEMA:
        p.append("wrong schema")
    model = m["model"]
    spec = pins.MODELS.get(model)
    if spec is None:
        return p + [f"unknown model {model!r}"]
    if m["hf"] != spec:
        p.append("hf repo/revision is not the pinned one")
    if m["format"].get("name") not in FORMATS:
        p.append("unknown format")
    elif m["checkpoint_id"] != checkpoint_id(
        model, spec["revision"], m["format"]["name"], _version(m["checkpoint_id"])
    ):
        p.append("checkpoint_id does not match model, revision and format")
    src = m["source"]
    if not HEX64.match(str(src.get("source_manifest_sha256", ""))):
        p.append("source.source_manifest_sha256 missing or not sha256")
    if model == "tempseg":
        if src.get("adapter_sha256") != pins.ADAPTER_SHA256:
            p.append("source.adapter_sha256 is not the pinned adapter")
        if not HEX64.match(str(src.get("merge_digest", ""))):
            p.append("source.merge_digest missing")
        if m.get("base") != {"repo": pins.BASE_REPO, "revision": pins.BASE_REV}:
            p.append("base repo/revision is not the pinned one")
    q = m["quant"]
    if q.get("quantization") != "fp8_per_tensor" or q.get("ignore") != pins.IGNORE:
        p.append("quant config must be fp8_per_tensor with the pinned IGNORE list")
    for k in REQUIRED_RUNTIME:
        if not m["runtime"].get(k):
            p.append(f"runtime.{k} missing")
    if not m["files"]:
        p.append("files empty")
    for rel, d in m["files"].items():
        if not HEX64.match(str(d.get("sha256", ""))) or not isinstance(
            d.get("bytes"), int
        ):
            p.append(f"bad file entry {rel}")
    if not m["code_revision"]:
        p.append("code_revision missing")
    r = m["parity_receipt"]
    if not isinstance(r, dict) or r.get("passed") is not True:
        p.append("parity_receipt.passed is not true")
    return p


def _version(cid: str) -> int:
    mt = re.search(r"-v(\d+)$", cid)
    return int(mt.group(1)) if mt else 0


def write_manifest(root: Path, manifest: dict[str, Any]) -> Path:
    problems = validate_manifest(manifest)
    if problems:
        raise ManifestError("; ".join(problems))
    target = root / MANIFEST_NAME
    tmp = root / (MANIFEST_NAME + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    tmp.replace(target)
    return target


def verify_checkpoint(root: Path, *, deep: bool = True) -> list[str]:
    """Verify MANIFEST.json against the directory: schema, identity, file set, sizes and (deep) sha256."""
    mp = root / MANIFEST_NAME
    if not mp.is_file():
        return [f"missing {MANIFEST_NAME}"]
    try:
        m = json.loads(mp.read_text())
    except json.JSONDecodeError as e:
        return [f"manifest is not JSON: {e}"]
    problems = validate_manifest(m)
    if problems:
        return problems
    listed = set(m["files"])
    present = {
        p.relative_to(root).as_posix()
        for p in root.rglob("*")
        if p.is_file() and p.name != MANIFEST_NAME
    }
    problems += [f"unlisted file {f}" for f in sorted(present - listed)]
    problems += [f"missing file {f}" for f in sorted(listed - present)]
    for rel in sorted(listed & present):
        p = root / rel
        d = m["files"][rel]
        if p.stat().st_size != d["bytes"]:
            problems.append(f"size mismatch {rel}")
        elif deep and sha256_file(p) != d["sha256"]:
            problems.append(f"sha256 mismatch {rel}")
    return problems


def refuse_existing(final_dir: Path) -> None:
    """Publish never overwrites a checkpoint id: a present directory (even empty) is an error."""
    if final_dir.exists():
        raise ManifestError(
            f"checkpoint already published, refusing to overwrite: {final_dir}"
        )


def require_published(final_dir: Path) -> dict[str, Any]:
    """Job-side guard: a missing or invalid checkpoint fails loudly, never falls back to quantizing."""
    problems = verify_checkpoint(final_dir, deep=False)
    if problems:
        raise ManifestError(
            f"checkpoint {final_dir} is not published/valid: {'; '.join(problems)}"
        )
    return json.loads((final_dir / MANIFEST_NAME).read_text())
