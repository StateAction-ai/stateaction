"""SA-101 canary: turn the REAL stage outputs of one Modal run into a replay store (stdlib only).

The two GPU stages write contract documents (`segments.v1`, `captions.v1`) and diagnostics. The SA-96
seed replays FLORA-native files in the SA-86 store layout, so this module writes that layout from the
real outputs, so the review page can open them as a `replay_*` job whose `ext.replayed_from` names the
real Modal run:

    <store>/<fixture>/source.conversion.json     names the MCAP sha256 and the sha256 FLORA saw
    <store>/<fixture>/flora/{segments.json,windows.jsonl,captions.json,env.json}

Nothing is invented: a segment the live adapter dropped because an earlier one covered it is removed
from the native list and recorded in `canary.dropped_covered`; a failed caption keeps its error code as
its native status; a failed window stays in `windows.failed`.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

SCHEMA_ENV = "stateaction.flora_caption_env.v1"
SCHEMA_CAPTIONS = "stateaction.flora_captions.v1"
SEG_DIAG = "diagnostics/segment/"
CAP_DIAG = "diagnostics/caption/"


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _load(files: dict[str, bytes], name: str) -> Any:
    if name not in files:
        raise KeyError(f"missing {name}")
    return json.loads(files[name])


def native_segments(
    seg_files: dict[str, bytes],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The native TempSeg document without segments the live adapter dropped as covered, and those dropped."""
    native = _load(seg_files, SEG_DIAG + "native_segments.json")
    prov = _load(seg_files, SEG_DIAG + "provenance.json")
    dropped = list(prov.get("covered_segments_dropped") or [])
    ids = {d["id"] for d in dropped}
    kept = [s for s in native["segments"] if s["id"] not in ids]
    if len(kept) + len(ids) != len(native["segments"]):
        raise ValueError("a dropped segment id is not in the native segments")
    out = dict(native)
    out["segments"] = kept
    out["canary"] = {"source": "sa-101", "dropped_covered": dropped}
    return out, dropped


def native_captions(
    segments_doc: dict[str, Any],
    captions_doc: dict[str, Any],
    inputs: dict[str, Any],
    native: dict[str, Any],
    segments_sha256: str,
) -> dict[str, Any]:
    """FLORA-native `captions.json`: one entry per captioned or failed segment row (`not_captioned` rows are skipped).

    The per-caption prompt hash is taken from the planned inputs in plan order; a length mismatch is an error.
    """
    flora_id: dict[str, int] = {}
    span: dict[str, tuple[float, float]] = {}
    for row in segments_doc["rows"]:
        if row["status"] != "ok":
            continue
        flora = row["ext"]["flora"]
        flora_id[row["segment_id"]] = flora["id"]
        span[row["segment_id"]] = (
            float(flora["native_start_s"]),
            float(flora["native_end_s"]),
        )
    planned = [d for d in inputs["inputs"] if d["disposition"] == "caption_input"]
    prompt_of = {
        d["segment_id"]: p
        for d, p in zip(planned, inputs["prompt_sha256s"], strict=True)
    }
    items: list[dict[str, Any]] = []
    for row in captions_doc["rows"]:
        if row["status"] == "not_captioned":
            continue
        seg = row["segment_id"]
        item: dict[str, Any] = {
            "segment_id": flora_id[seg],
            "start_s": span[seg][0],
            "end_s": span[seg][1],
        }
        if seg in prompt_of:
            item["prompt_sha256"] = prompt_of[seg]
        if row["status"] == "complete":
            item["status"] = "complete"
            item["caption"] = row["text"]
        else:
            # the replay adapter turns the native status into the error code, so it carries the real code
            item["status"] = row["error_code"] or "failed"
            item["error"] = row["error_code"]
        items.append(item)
    return {
        "schema": SCHEMA_CAPTIONS,
        "source_sha256": native["source"]["sha256"],
        "segments_sha256": segments_sha256,
        "captions": items,
    }


def run_env(
    seg_files: dict[str, bytes],
    cap_files: dict[str, bytes],
    run: dict[str, Any],
) -> dict[str, Any]:
    """`env.json`: the real Modal run record the replay copies into `ext.replayed_from`."""
    seg_doc = _load(seg_files, "segments.json")
    cap_doc = _load(cap_files, "captions.json")
    seg_prov = _load(seg_files, SEG_DIAG + "provenance.json")
    cap_prov = _load(cap_files, CAP_DIAG + "provenance.json")
    cp = cap_doc["producer"]
    returned = {
        name: sha256_bytes(data)
        for files in (seg_files, cap_files)
        for name, data in sorted(files.items())
    }
    return {
        "schema": SCHEMA_ENV,
        "ticket": "SA-101",
        "run_utc": run["run_utc"],
        "gpu_name": cp["gpu"]["observed_type"],
        "engine": cp["engine"],
        "model": {
            "repo": cp["model_name"],
            "revision": cp["model_revision"],
            "weights_listing_sha256": cp["weights_sha256"],
            "checkpoint": cap_prov.get("checkpoint"),
        },
        "prompt": {"prompt_set_sha256": cp["prompt_sha256"]},
        "decoding": cp["decoding_params"],
        "quant": cp.get("quant"),
        "modal": {
            "segment_module": seg_doc["producer"]["module_id"],
            "caption_module": cp["module_id"],
            "tempseg_checkpoint": seg_prov.get("checkpoint"),
            # The replayed segment rows take their weights hash from FLORA's own native provenance (the
            # bf16 adapter lineage); what the GPU really loaded (the published fp8 checkpoint) is here.
            "segment_producer": seg_doc["producer"],
            "caption_producer": cp,
            "returned_sha256": returned,
            "tempseg_gpu": seg_doc["producer"]["gpu"],
            "timing": {
                "segment": seg_prov.get("timing"),
                "caption": cap_prov.get("timing"),
            },
            **run,
        },
    }


def build_store(
    store: Path,
    fixture: str,
    mcap_sha256: str,
    seg_files: dict[str, bytes],
    cap_files: dict[str, bytes],
    run: dict[str, Any],
) -> dict[str, Any]:
    """Write `<store>/<fixture>/` (see the module docstring) and return what was written."""
    live = _load(seg_files, "segments.json")
    if live["source_manifest_sha256"] != mcap_sha256:
        raise ValueError("the stage ran on another MCAP than the one named")
    native, dropped = native_segments(seg_files)
    raw = _canonical(native)
    seg_sha = sha256_bytes(raw)
    cap_native = native_captions(
        _load(seg_files, "segments.json"),
        _load(cap_files, "captions.json"),
        _load(cap_files, CAP_DIAG + "caption_inputs.json"),
        native,
        seg_sha,
    )
    env = run_env(seg_files, cap_files, run)
    windows = seg_files.get(SEG_DIAG + "windows.jsonl", b"").decode().splitlines()
    header = {
        "source_sha256": native["source"]["sha256"],
        "note": "SA-101 canary: per-window status of the real TempSeg run",
    }
    root = store / fixture
    flora = root / "flora"
    flora.mkdir(parents=True, exist_ok=True)
    (flora / "segments.json").write_bytes(raw)
    (flora / "windows.jsonl").write_text(
        "\n".join([json.dumps(header, sort_keys=True), *windows]) + "\n"
    )
    (flora / "captions.json").write_bytes(_canonical(cap_native))
    (flora / "env.json").write_bytes(_canonical(env))
    (root / "source.conversion.json").write_bytes(
        _canonical(
            {
                "mcap_sha256": mcap_sha256,
                "source_sha256": native["source"]["sha256"],
                "note": "sha256 of the MP4 the real stage remuxed from the MCAP (SA-101 canary)",
            }
        )
    )
    return {
        "segments": len(native["segments"]),
        "dropped_covered": len(dropped),
        "captions": len(cap_native["captions"]),
        "failed_captions": sum(
            c["status"] != "complete" for c in cap_native["captions"]
        ),
        "windows_failed": len(native["windows"]["failed"]),
        "segments_sha256": seg_sha,
        "source_sha256": native["source"]["sha256"],
    }
