"""Stream a verified capture into bounded, immutable clip artifacts (SA-31).

    result = export_artifacts(open(path, "rb"), sink, context)

Pipeline per source: `FrameStream` (SA-29: one decode per frame) -> `HandInferencer` (SA-30: one
CPU inference per frame) -> `ClipWriter` (native MP4 remux of the original access units, NPZ, JSON,
frame map, thumbnail, bounded spatial-proxy RRD). Nothing here decodes or infers twice and nothing
holds a whole recording: at most one clip's arrays and files are alive, a closed clip is handed to
the sink and its scratch copy dropped before the next clip starts.

Everything is provisional until `FrameStream.require_accepted()` (whole-source footer/CRC/SHA-256,
Close counts, decoder flush) passes. Only then is the `stateaction.processing_result.v1` manifest
built, checked by the shared contract validator, written to scratch and passed to `sink.seal()` as
the very last step. Any error aborts the sink: no manifest means nothing was published.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import shutil
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from . import hand_model
from .artifact_clip import ClipWriter
from .artifact_types import (
    FILE_NAMES,
    MANIFEST_NAME,
    ROLE_BY_KEY,
    RULE_REVISION,
    Attestation,
    ExportContext,
    ExportError,
    ExportLimits,
    OutputFile,
    OutputReceipt,
    OutputSink,
    derived_uuid,
    make_output,
    require,
    simulation_note,
)
from .capture_stream import StreamLimits
from .frames import FrameStream
from .h264_decode import DecodedFrame
from .hand_stream import Missingness
from .hands import HandInferenceError, HandInferencer


@dataclass
class ExportResult:
    manifest: dict[str, Any]
    manifest_sha256: str
    clips: list[dict[str, Any]]
    outputs: list[OutputFile]
    receipts: dict[str, OutputReceipt]
    manifest_receipt: OutputReceipt
    source_sha256: str
    source_bytes: int
    native_capture_recording_id: str | None
    missingness: Missingness
    frames: int
    inference_ms_mean: float
    inference_ms_max: float
    observations_sha256: str
    peak_scratch_clip_bytes: int


def config_sha256(limits: ExportLimits, stream_limits: StreamLimits) -> str:
    cfg = {
        "export_limits": dataclasses.asdict(limits),
        "stream_limits": dataclasses.asdict(stream_limits),
        "model_sha256": hand_model.PINS["sha256"],
        "model_thresholds": [
            hand_model.PINS["min_hand_detection_confidence"],
            hand_model.PINS["min_hand_presence_confidence"],
        ],
        "rule_revision": RULE_REVISION,
    }
    text = json.dumps(cfg, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode()).hexdigest()


def should_cut(age_us: int, frames: int, is_idr: bool, limits: ExportLimits) -> bool:
    """Cut only at an IDR; never exceed the ceiling or frame cap (explicit error otherwise)."""
    age_s = age_us / 1e6
    due = age_s >= limits.clip_target_seconds or frames >= limits.clip_target_frames
    if is_idr and due:
        return True
    require(
        age_s <= limits.clip_ceiling_seconds and frames < limits.clip_max_frames,
        "E_NO_IDR_WITHIN_CLIP_CEILING",
        {"age_s": age_s, "frames": frames},
    )
    return False


def _scan_forbidden(path: Path, tokens: tuple[str, ...]) -> None:
    needles = [t.encode() for t in tokens if len(t) >= 6]
    if not needles:
        return
    keep = max(len(n) for n in needles) - 1
    tail = b""
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            window = tail + chunk
            for n in needles:
                if n in window:
                    raise ExportError("E_ARTIFACT_NOT_CUSTOMER_SAFE", path.name)
            tail = window[-keep:] if keep else b""


def export_artifacts(
    raw: BinaryIO,
    sink: OutputSink,
    context: ExportContext,
    *,
    model: str | Path | None = None,
    limits: ExportLimits | None = None,
    stream_limits: StreamLimits | None = None,
    scratch_dir: Path | None = None,
    on_clip_closed: Callable[[dict[str, Any]], None] | None = None,
) -> ExportResult:
    limits = limits or ExportLimits()
    require(
        0 <= limits.clip_target_seconds <= limits.clip_ceiling_seconds <= 60
        and 1 <= limits.clip_target_frames <= limits.clip_max_frames <= 7200,
        "E_CLIP_LIMITS_INVALID",
    )
    require(
        context.fixture_identities
        or (
            context.recording_id is not None
            and context.source_file_id is not None
            and context.expected_source_sha256 is not None
        ),
        "E_IDENTITY_REQUIRED",
        "production exports need caller-supplied recording_id, source_file_id and "
        "expected_source_sha256 (the admitted source bytes the whole-source hash is compared to)",
    )
    stream_limits = stream_limits or StreamLimits()
    own_scratch = scratch_dir is None
    scratch = (
        Path(scratch_dir)
        if scratch_dir is not None
        else Path(tempfile.mkdtemp(prefix="sa31-scratch-"))
    )
    scratch.mkdir(parents=True, exist_ok=True)
    forbidden = (*context.forbidden_strings, str(scratch))
    verified = hand_model.resolve_model(model)  # hash-checked BEFORE any decode
    stream = FrameStream(raw, stream_limits)
    miss = Missingness()
    digest = hashlib.sha256()
    total_ms = max_ms = 0.0
    clips_meta: list[dict[str, Any]] = []
    outputs: list[OutputFile] = []
    receipts: dict[str, OutputReceipt] = {}  # relative_path -> what the sink stored
    writer: ClipWriter | None = None
    peak_clip_bytes = 0
    config_hash = config_sha256(limits, stream_limits)
    att = context.attestation
    sim_note = simulation_note(att.simulation) if att else None

    def close_clip() -> None:
        nonlocal writer, peak_clip_bytes
        assert writer is not None
        meta, files = writer.close()
        peak_clip_bytes = max(peak_clip_bytes, sum(f.size_bytes for f in files))
        for f in files:
            _scan_forbidden(f.path, forbidden)
            rc = sink.put(f)  # may move, upload or copy; never overwrites
            require(
                (rc.role, rc.size_bytes, rc.sha256) == (f.role, f.size_bytes, f.sha256),
                "E_RECEIPT_MISMATCH",
                f.relative_path,
            )
            receipts[f.relative_path] = rc
            f.path.unlink(missing_ok=True)
        shutil.rmtree(writer.dir, ignore_errors=True)
        clips_meta.append(meta)
        outputs.extend(files)
        if on_clip_closed is not None:
            on_clip_closed(meta)
        writer = None

    def plan_cut(frame: DecodedFrame) -> bool:
        assert writer is not None
        return should_cut(
            writer.age_us(frame.access_unit.encoder_pts_us),
            writer.frames,
            frame.access_unit.is_idr,
            limits,
        )

    try:
        with HandInferencer(verified) as inferencer:
            for frame in stream:
                obs = inferencer.infer(frame)  # the only inference of this frame
                if writer is not None and plan_cut(frame):
                    close_clip()
                if writer is None:
                    ordinal = len(clips_meta)
                    require(ordinal < 1000, "E_TOO_MANY_CLIPS")
                    writer = ClipWriter(
                        scratch,
                        ordinal,
                        derived_uuid(context.job_id, f"clip/{ordinal}"),
                        context.job_id,
                        frame,
                        limits,
                        sim_note,
                    )
                writer.add(frame, obs)
                miss.add(obs)
                obs.digest_into(digest)
                total_ms += obs.inference_ms
                max_ms = max(max_ms, obs.inference_ms)
            frames_inferred = inferencer.frames_inferred
        if writer is not None:
            close_clip()
        # Acceptance gate: the whole source (footer/CRC/SHA/Close) and the decoder flush.
        report = stream.require_accepted()
        stats = stream.decode_stats
        if stats is None or frames_inferred != stats.frames_out or frames_inferred == 0:
            raise HandInferenceError("E_INFERENCE_COUNT", (frames_inferred, stats))
        sha, nbytes = report.source.sha256, report.source.bytes_read
        if context.expected_source_sha256 and context.expected_source_sha256 != sha:
            raise ExportError("E_SOURCE_SHA_MISMATCH", sha)
        if att is not None:
            _check_actual_profile(report.profile, att)
        manifest = build_manifest(
            context, report, sha, nbytes, clips_meta, outputs, receipts, miss, stats, frames_inferred,
            total_ms, digest.hexdigest(), config_hash, limits,
        )  # fmt: skip
        data = json.dumps(
            manifest, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
        from stateaction_contracts import validate_bytes

        verdict = validate_bytes(
            "artifacts.processing-result.v2"
            if att is not None
            else "artifacts.processing-result.v1",
            data,
        )
        if not verdict.valid:
            raise ExportError(
                "E_CONTRACT_VIOLATION",
                ("processing-result", verdict.code, verdict.errors[:3]),
            )
        mpath = scratch / MANIFEST_NAME
        mpath.write_bytes(data)
        _scan_forbidden(mpath, forbidden)
        out = make_output("result_manifest", MANIFEST_NAME, mpath, None)
        mrc = sink.seal(out)  # LAST: after every file is closed, hashed and put
        require(
            (mrc.role, mrc.size_bytes, mrc.sha256)
            == (out.role, out.size_bytes, out.sha256),
            "E_RECEIPT_MISMATCH",
            MANIFEST_NAME,
        )
        mpath.unlink(missing_ok=True)
    except BaseException as e:
        if writer is not None:
            writer.abort()
        sink.abort(getattr(e, "code", type(e).__name__))
        raise
    finally:
        if own_scratch:
            shutil.rmtree(scratch, ignore_errors=True)
    return ExportResult(
        manifest=manifest,
        manifest_sha256=out.sha256,
        clips=clips_meta,
        outputs=outputs,
        receipts=receipts,
        manifest_receipt=mrc,
        source_sha256=sha,
        native_capture_recording_id=report.recording_id,
        source_bytes=nbytes,
        missingness=miss,
        frames=frames_inferred,
        inference_ms_mean=total_ms / frames_inferred,
        inference_ms_max=max_ms,
        observations_sha256=digest.hexdigest(),
        peak_scratch_clip_bytes=peak_clip_bytes,
    )


def _check_actual_profile(profile: dict[str, Any] | None, att: Attestation) -> None:
    """The ACTUAL MCAP capture profile must equal what the backend admitted and attests."""
    actual = (profile or {}).get("rgb_profile")
    require(actual == att.rgb_profile, "E_PROFILE_MISMATCH", actual)
    simulated = actual == "h264_mcap_simulation_v1"
    require(simulated == (att.simulation is not None), "E_SIMULATION_MISMATCH")
    if simulated:
        require(
            (profile or {}).get("qualification") == "simulation_only"
            and (profile or {}).get("production_qualified") is False,
            "E_SIMULATION_MISMATCH",
            "qualification",
        )


def build_manifest(
    ctx: ExportContext,
    report: Any,
    sha: str,
    nbytes: int,
    clips_meta: list[dict[str, Any]],
    outputs: list[OutputFile],
    receipts: dict[str, OutputReceipt],
    miss: Missingness,
    stats: Any,
    frames: int,
    total_ms: float,
    obs_digest: str,
    config_hash: str,
    limits: ExportLimits,
) -> dict[str, Any]:
    by_path = {o.relative_path: o for o in outputs}
    file_ids = {p: receipts[p].file_id for p in by_path}  # store-selected immutable ids
    clips = []
    for meta in clips_meta:
        rel = f"clips/{meta['ordinal']:03d}"
        files = {key: file_ids[f"{rel}/{FILE_NAMES[key]}"] for key in ROLE_BY_KEY}
        shapes = meta["array_shapes"]
        names = (
            ("image_landmarks_px", "float32"),
            ("image_landmarks_mask", "bool"),
            ("model_relative_joints", "float32"),
            ("model_relative_mask", "bool"),
            ("hand_detected", "bool"),
            ("handedness_score", "float32"),
            ("handedness", "int8"),
            ("frame_index", "int64"),
        )
        clips.append(
            {
                "clip_id": meta["clip_id"],
                "clip_ordinal": meta["ordinal"],
                "title": f"Clip {meta['ordinal'] + 1}",
                "source_start_ns": meta["source_start_ns"],
                "source_end_ns": meta["source_end_ns"],
                "duration_ns": str(
                    int(meta["source_end_ns"]) - int(meta["source_start_ns"])
                ),
                "clock_domain": meta["clock_domain"],
                "raster": meta["raster"],
                "frame_count": meta["frame_count"],
                "files": files,
                "hand_arrays": {
                    "format": "npz",
                    "joint_order_ref": "stateaction.hand_observations.v1#joint_order",
                    "arrays": [
                        {"name": n, "dtype": dt, "shape": shapes[n]} for n, dt in names
                    ],
                },
                "frame_map_schema": "stateaction.frame_map.v1",
                "hand_observations_schema": "stateaction.hand_observations.v1",
            }
        )
    rrd_bytes = [m["rrd"]["bytes"] for m in clips_meta]
    reencoded = [m["rrd"]["reencoded"] for m in clips_meta]

    # Frozen contract: measurements are <= 16 int64-decimal STRING values (no floats, lists or ids).
    def d(**kv: int) -> dict[str, str]:
        return {k: str(int(v)) for k, v in kv.items()}

    checks = [
        _check("source_accepted", "pass", "Entire source verified to footer, CRC, SHA-256 and Close; decoder flushed.",
               d(source_bytes=nbytes, video_messages=report.video_messages, frames_decoded=stats.frames_out)),
        _check("decode_and_inference_once", "pass", "One persistent decoder; one CPU inference per decoded frame.",
               d(decoder_instances=stats.decoder_instances, frames_decoded=stats.frames_out, frames_inferred=frames)),
        _check("native_mp4_remux", "pass", "Original access units remuxed unchanged; PTS and VCL NAL bytes match.",
               d(clips=len(clips_meta), reencoded_clips=0)),
        _check("clip_bounds", "pass", "Every clip starts at an IDR and respects the duration and frame ceilings.",
               d(ceiling_seconds=int(limits.clip_ceiling_seconds), target_seconds=int(limits.clip_target_seconds),
                 max_frames=limits.clip_max_frames)),
        _check("proxy_rrd_bounds", "pass", "Pixel-encoded RRDs are within the byte and raster bounds.",
               d(max_rrd_bytes=limits.max_rrd_bytes, largest_rrd_bytes=max(rrd_bytes),
                 proxy_reencoded_clips=sum(1 for r in reencoded if r),
                 proxy_max_width=limits.proxy_max_width, proxy_max_height=limits.proxy_max_height)),
        _check("hand_detection_summary", "measured", "Detection counts only; not an accuracy claim.",
               d(**dataclasses.asdict(miss), inference_us_mean=round(total_ms * 1000 / frames))),
    ]  # fmt: skip
    doc: dict[str, Any] = {
        "schema": "stateaction.processing_result.v1",
        "job_id": ctx.job_id,
        "recording_id": ctx.recording_id
        or str(uuid.uuid5(uuid.NAMESPACE_URL, f"stateaction:fixture-recording:{sha}")),
        "source_manifest_sha256": ctx.source_manifest_sha256,
        "provenance": {
            "code_revision": ctx.code_revision,
            "image_spec_sha256": ctx.image_spec_sha256,
            "config_sha256": config_hash,
            "profile_revision": ctx.profile_revision,
            "model": {
                "name": "mediapipe_hand_landmarker",
                "asset_sha256": hand_model.PINS["sha256"],
                "license": "Apache-2.0",
            },
            "rerun_sdk_version": "0.41.0",
        },
        "verified_sources": [
            {
                "file_id": ctx.source_file_id or derived_uuid(ctx.job_id, "source"),
                "size_bytes": str(nbytes),
                "sha256": sha,
            }
        ],
        "outputs": [
            {
                "file_id": file_ids[o.relative_path],
                "role": o.role,
                "relative_path": o.relative_path,
                "size_bytes": str(o.size_bytes),
                "sha256": o.sha256,
            }
            for o in outputs
        ],
        "clips": clips,
        "checks": checks,
        "metric_accuracy_validated": False,
        "limitations": [
            "3D hand points are MediaPipe model-relative estimates; metric accuracy is not validated.",
            "Capture crop, rotation and mirror are unknown in contract v1; frame-map transforms describe only this export (identity).",
            "frame-map timing_verified is false: native clock quality is not qualified by this export.",
            "Handedness labels assume mirrored input; capture mirror state is unknown.",
            "No hand is a valid result; absent hands are masked, never fabricated or threshold-lowered.",
            *(
                [
                    "Job/recording/file identities are offline deterministic fixtures, not backend-reserved ids."
                ]
                if ctx.fixture_identities
                else []
            ),
            *ctx.extra_limitations,
        ],
    }
    att = ctx.attestation
    if att is not None:
        # Backend job (processing-result.v2): claim-bound source attestation + simulation marker.
        doc["schema"] = "stateaction.processing_result.v2"
        doc["attestation"] = {
            "invocation_nonce": att.invocation_nonce,
            "rgb_profile": att.rgb_profile,
            "source_file_id": ctx.source_file_id,
            "source_eof_verified": True,
        }
        if att.simulation is not None:
            doc["simulation"] = att.simulation
            doc["limitations"].append(
                "Simulated capture (simulation_only): not hardware evidence and not production qualified; "
                "camera, encoder and clock provenance are exactly as stated in the simulation marker."
            )
    return doc


def _check(
    code: str, status: str, message: str, measurements: dict[str, Any]
) -> dict[str, Any]:
    return {
        "code": code,
        "status": status,
        "message": message,
        "rule_revision": RULE_REVISION,
        "measurements": measurements,
    }
