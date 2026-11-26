"""Replay segmenter and captioner: cached FLORA-native output through the production adapter.

LOCAL ONLY, zero model cost. Reads `STATEACTION_REPLAY_DIR/<source_sha256>/flora/` (or an episode
directory whose `source.conversion.json` names the MCAP's sha256, the T01 store layout) and refuses
unless the FLORA files describe exactly this recording: the FLORA source sha256 must equal the one
the store records for it and the frame count must equal the remux frame count. Output is labelled
`module_id=replay_*`, and the original FLORA run record travels with it (`ext.replayed_from` on
every segment row and the diagnostic blob `replayed_from.json`), so replayed output is never shown
as a live model run.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from ..flora_adapter import (
    canonical_bytes,
    captions_from_flora,
    flat_params,
    segments_from_flora,
)
from ..stage_docs import (
    ModuleOutput,
    ProducerFacts,
    StageContext,
    StageError,
    captions_document,
    segments_document,
)

ENV = "STATEACTION_REPLAY_DIR"
_MAX_JSON_BYTES = 32 * 1024 * 1024


def _read(path: Path) -> tuple[bytes, Any]:
    if not path.is_file() or path.stat().st_size > _MAX_JSON_BYTES:
        raise StageError("replay_file_missing")
    data = path.read_bytes()
    try:
        return data, json.loads(data)
    except ValueError:
        raise StageError("replay_file_invalid") from None


def find_flora(source_sha256: str) -> tuple[Path, str]:
    """(flora directory, FLORA source sha256 the store records for this MCAP)."""
    root = os.environ.get(ENV)
    if not root:
        raise StageError("replay_dir_unset")
    base = Path(root)
    direct = base / source_sha256
    candidates = [direct] if direct.is_dir() else []
    if not candidates and base.is_dir():
        for child in sorted(base.iterdir()):
            conv = child / "source.conversion.json"
            if conv.is_file() and conv.stat().st_size < 65536:
                try:
                    if json.loads(conv.read_text()).get("mcap_sha256") == source_sha256:
                        candidates.append(child)
                except ValueError:
                    continue
    if len(candidates) != 1 or not (candidates[0] / "flora").is_dir():
        raise StageError("replay_not_found")
    episode = candidates[0]
    conv = episode / "source.conversion.json"
    expected = episode.name
    if conv.is_file():
        try:
            expected = str(json.loads(conv.read_text())["source_sha256"])
        except (ValueError, KeyError):
            raise StageError("replay_file_invalid") from None
    return episode / "flora", expected


def _checked_segments(ctx: StageContext) -> tuple[Path, str, bytes, dict[str, Any]]:
    flora, expected = find_flora(ctx.source_sha256)
    raw, native = _read(flora / "segments.json")
    if native["source"]["sha256"] != expected:
        raise StageError("replay_source_mismatch")
    if native["source"]["frames"] != len(ctx.frames):
        raise StageError("replay_frame_count_mismatch")
    return flora, expected, raw, native


def _sub(env: dict[str, Any], key: str) -> dict[str, Any]:
    value = env.get(key)
    return value if isinstance(value, dict) else {}


def _env(flora: Path) -> tuple[str | None, dict[str, Any]]:
    path = flora / "env.json"
    if not path.is_file():
        return None, {}
    raw, env = _read(path)
    return hashlib.sha256(raw).hexdigest(), env if isinstance(env, dict) else {}


def _replayed_from(
    env_sha: str | None, env: dict[str, Any], native_sha: str
) -> dict[str, Any]:
    model = _sub(env, "model")
    return {
        "source": "flora_native_replay",
        "native_sha256": native_sha,
        "env_sha256": env_sha,
        "run_utc": str(env["run_utc"]) if "run_utc" in env else None,
        "gpu_name": str(env["gpu_name"]) if "gpu_name" in env else None,
        "captioner_revision": str(model["revision"]) if "revision" in model else None,
    }


def run_segment(ctx: StageContext) -> ModuleOutput:
    flora, _expected, raw, native = _checked_segments(ctx)
    env_sha, env = _env(flora)
    prov = native.get("provenance", {})
    replayed = _replayed_from(env_sha, env, hashlib.sha256(raw).hexdigest())
    spans, total, failed = segments_from_flora(ctx, native, replayed)
    facts = ProducerFacts(
        engine_version="replay-1",
        model_revision=prov.get("tempseg_weights_revision_pinned_in_models_json"),
        weights_sha256=prov.get("tempseg_adapter_sha256"),
        prompt_sha256=prov.get("prompt_sha256"),
        decoding_params=flat_params(prov.get("decoding", {})),
    )
    document = segments_document(ctx, ctx.producer(facts), spans, total, failed)
    windows_rows: list[dict[str, Any]] = []
    path = flora / "windows.jsonl"
    if path.is_file() and path.stat().st_size <= _MAX_JSON_BYTES:
        for line in path.read_text().splitlines()[
            1:
        ]:  # the first line is the run config
            try:
                item = json.loads(line)
            except ValueError:
                continue
            windows_rows.append(
                {
                    "window_index": item.get("window_index"),
                    "status": item.get("status"),
                    "error_code": item.get("error_code"),
                }
            )
    blob = canonical_bytes(
        {"env": env, "tempseg_provenance": prov, "replayed_from": replayed}
    )
    return ModuleOutput(
        document=document,
        counts={
            "frames": len(ctx.frames),
            "windows": total,
            "failed_windows": len(failed),
            "segments": len(spans),
        },
        windows_rows=windows_rows,
        extra_diagnostics={"replayed_from.json": blob},
    )


def run_caption(
    ctx: StageContext, *, expected_native_segments_sha256: str | None = None
) -> ModuleOutput:
    flora, expected, native_segments_raw, _native_segments = _checked_segments(ctx)
    segments_sha256 = hashlib.sha256(native_segments_raw).hexdigest()
    if (
        expected_native_segments_sha256 is not None
        and segments_sha256 != expected_native_segments_sha256
    ):
        raise StageError("replay_segments_changed")
    raw, native = _read(flora / "captions.json")
    if native.get("source_sha256") != expected:
        raise StageError("replay_source_mismatch")
    if native.get("segments_sha256") != segments_sha256:
        raise StageError("replay_flora_inconsistent")
    env_sha, env = _env(flora)
    model = _sub(env, "model")
    prompt = _sub(env, "prompt")
    facts = ProducerFacts(
        engine_version="replay-1",
        model_revision=model.get("revision"),
        weights_sha256=model.get("weights_listing_sha256"),
        prompt_sha256=prompt.get("prompt_set_sha256"),
        decoding_params=flat_params(env.get("decoding", {})),
    )
    outcomes = captions_from_flora(ctx, native)
    document = captions_document(ctx, ctx.producer(facts), outcomes)
    statuses = [r["status"] for r in document["rows"]]
    replayed = _replayed_from(env_sha, env, hashlib.sha256(raw).hexdigest())
    return ModuleOutput(
        document=document,
        counts={
            "captions": statuses.count("complete"),
            "failed_captions": statuses.count("failed"),
            "not_captioned": statuses.count("not_captioned"),
        },
        extra_diagnostics={
            "replayed_from.json": canonical_bytes(
                {"env": env, "replayed_from": replayed}
            )
        },
    )
