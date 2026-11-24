"""Build an unfiltered plan and whole-recording MP4 from a verified capture."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, BinaryIO, Callable

from stateaction_contracts import request_sha256, validate_value

from .artifact_types import MANIFEST_NAME, make_output
from .capture_stream import CaptureStream
from .hand_pose_cpu_v1 import (
    EXIT_OK,
    EXIT_UNREPORTED,
    Api,
    ServerOutputSink,
    _Beater,
    _check_runtime_identity,
    _error_code,
    _fail,
    _report,
)
from .run_job import _OPENER
from .source_range import MAX_FRAMES
from .stage_media import StageMediaError, remux_source


def _plan(
    *,
    recording_id: str,
    plan_version: int,
    source_manifest_sha256: str,
    frame_count: int,
    clock: str,
    first_id: str,
    last_id: str,
    start: str,
    end: str,
    error_code: str | None = None,
) -> dict[str, Any]:
    plan = {
        "schema": "stateaction.clip-plan.v1",
        "recording_id": recording_id,
        "plan_version": plan_version,
        "source_manifest_sha256": source_manifest_sha256,
        "frame_count": frame_count,
        "origin_ts_ns": start,
        "clock_domain": clock,
        "mode": "passthrough",
        "state": "succeeded" if error_code is None else "failed",
        "error_code": error_code,
        "filter_version": "clip_filter@0",
        "params_sha256": request_sha256({}),
        "producer": {
            "module_id": "clip_filter",
            "revision": "0",
            "weights_sha256": None,
            "gpu_type": None,
        },
        "spans": [
            {
                "kind": "clip",
                "start_ordinal": 0,
                "end_ordinal": frame_count,
                "first_source_frame_id": first_id,
                "last_source_frame_id": last_id,
                "start_ts_ns": start,
                "end_ts_ns": end,
            },
        ],
    }
    if not validate_value("artifacts.clip-plan.v1", plan).valid:
        raise StageMediaError("clip_plan_invalid")
    return plan


def prepare_passthrough(
    raw: BinaryIO,
    output: Path,
    *,
    recording_id: str,
    plan_version: int,
    source_manifest_sha256: str,
    expected_source_sha256: str,
    expected_profile: str | None = None,
    on_frame: Callable[[int], None] | None = None,
) -> dict[str, Any]:
    """Return the plan and expose the remux only after both have been verified."""
    import av

    with TemporaryDirectory(prefix="clip-plan-", dir=output.parent) as work:
        temporary = Path(work) / "recording.mp4"
        try:
            frames = remux_source(
                raw, temporary, expected_profile=expected_profile, on_frame=on_frame
            )
        except av.error.FFmpegError as error:
            raise StageMediaError("native_remux_failed") from error
        if frames.source_sha256 != expected_source_sha256:
            raise StageMediaError("source_digest_mismatch")
        plan = _plan(
            recording_id=recording_id,
            plan_version=plan_version,
            source_manifest_sha256=source_manifest_sha256,
            frame_count=len(frames),
            clock=frames.clock_domain,
            first_id=frames.frame_ids[0],
            last_id=frames.frame_ids[-1],
            start=frames.timestamps_ns[0],
            end=frames.timestamps_ns[-1],
        )
        temporary.replace(output)
        return plan


def _fallback_plan(
    raw: BinaryIO,
    task: dict[str, Any],
    expected_source_sha256: str,
    error_code: str,
    on_frame: Callable[[int], None],
) -> dict[str, Any]:
    """Keep a full clip when remux fails but the sealed source still verifies."""
    stream = CaptureStream(raw, expected_profile=task["rgbProfile"])
    frames = iter(stream)
    first = last = next(frames, None)
    if first is None:
        raise StageMediaError("no_video_frames")
    count = 1
    for frame in frames:
        if frame.native_clock_id != first.native_clock_id:
            raise StageMediaError("clock_changed")
        count += 1
        if count > MAX_FRAMES:
            raise StageMediaError("too_many_frames")
        last = frame
        on_frame(count)
    report = stream.report
    report.require_auto_admissible()
    if report.source.sha256 != expected_source_sha256:
        raise StageMediaError("source_digest_mismatch")
    assert last is not None
    return _plan(
        recording_id=task["targetId"],
        plan_version=task["planVersion"],
        source_manifest_sha256=task["sourceManifestSha256"],
        frame_count=count,
        clock=first.native_clock_id,
        first_id=first.source_frame_id,
        last_id=last.source_frame_id,
        start=first.native_timestamp_ns,
        end=last.native_timestamp_ns,
        error_code=error_code,
    )


def run(grant: dict[str, Any], context: dict[str, Any]) -> int:
    """Plan a recording only after the bootstrap has exchanged its worker claim."""
    api = Api(context)
    beater = _Beater(api)
    beater.start()
    sink = ServerOutputSink(api, beater)
    verified_task: dict[str, Any] | None = None
    try:
        task = api.call("GET", "task-input")
        digests = grant["digests"]
        if (
            not validate_value("jobs.task-input.v5", task).valid
            or task["jobId"] != grant["jobId"]
            or task["sourceManifestSha256"] != digests["sourceManifestSha256"]
        ):
            raise StageMediaError("task_input_invalid")
        _check_runtime_identity(digests, context)
        verified_task = task
        sources = [
            source for source in grant["inputs"] if source["role"] == "source_mcap"
        ]
        if len(sources) != 1:
            raise StageMediaError("grant_inventory")
        source = sources[0]
        request = urllib.request.Request(source["readUrl"], method="GET")
        beater.phase = "decoding"
        with TemporaryDirectory(prefix="sa147-plan-worker-") as directory:
            scratch = Path(directory)
            output = scratch / "recording.mp4"

            def progress(count: int) -> None:
                beater.frames = count

            try:
                with _OPENER.open(request, timeout=120) as raw:
                    plan = prepare_passthrough(
                        raw,
                        output,
                        recording_id=task["targetId"],
                        plan_version=task["planVersion"],
                        source_manifest_sha256=task["sourceManifestSha256"],
                        expected_source_sha256=source["sha256"],
                        expected_profile=task["rgbProfile"],
                        on_frame=progress,
                    )
            except StageMediaError as error:
                if error.code == "source_digest_mismatch":
                    raise
                with _OPENER.open(request, timeout=120) as raw:
                    plan = _fallback_plan(
                        raw, task, source["sha256"], error.code, progress
                    )
            if plan["state"] == "succeeded":
                sink.put(make_output("recording_mp4", "recording.mp4", output, None))
            manifest = scratch / MANIFEST_NAME
            manifest.write_text(
                json.dumps(plan, sort_keys=True, separators=(",", ":")),
                encoding="utf-8",
            )
            receipt = sink.seal(
                make_output("result_manifest", MANIFEST_NAME, manifest, None)
            )
            # The generic result envelope counts viewer output chunks.
            _report(api, sink, receipt, "succeeded", 0, [], None)
        return EXIT_OK
    except Exception as error:
        code = _error_code(error)
        sink.abort(code)
        if verified_task is not None and MANIFEST_NAME not in sink.receipts:
            with TemporaryDirectory(prefix="clip-plan-diagnostic-") as directory:
                return _fail(api, sink, grant, verified_task, error, Path(directory))
        print(f"Clip planning failed: {code}")
        return EXIT_UNREPORTED
    finally:
        beater.stop()
