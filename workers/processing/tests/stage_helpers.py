"""Shared synthetic builders for the stage tests (no HomER data, no real model)."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from stateaction_contracts import request_sha256

from stateaction_processing import modules
from stateaction_processing.stage_docs import StageContext
from stateaction_processing.stage_media import FrameMap

JOB = "019a4b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b"
RECORDING = "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11"
MANIFEST_SHA = "8582d66a5ab61476bc09e1d678f94573144db3627d41d586359dc7dddc7ec597"
GOLDEN_MCAP = (
    Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden/valid.mcap"
)


def synthetic_frames(
    count: int = 100, step_us: int = 33_333, sha: str = "a" * 64
) -> FrameMap:
    frames = FrameMap(clock_domain="android.camera.sensor_timestamp", source_sha256=sha)
    for i in range(count):
        frames.frame_ids.append(str(i * 2))  # ids are native, never renumbered
        frames.timestamps_ns.append(str(1_000_000_000 + i * step_us * 1000))
        frames.pts_us.append(i * step_us)
    return frames


def make_ctx(
    stage: str,
    module_id: str,
    params: dict[str, Any] | None = None,
    frames: FrameMap | None = None,
    segments: dict[str, Any] | None = None,
    segments_sha256: str | None = None,
    source_sha: str = "a" * 64,
) -> StageContext:
    os.environ["APP_ENV"] = "local"
    ref = f"{module_id}@1"
    params = params or {}
    return StageContext(
        stage=stage,
        job_id=JOB,
        recording_id=RECORDING,
        source_manifest_sha256=MANIFEST_SHA,
        source_sha256=source_sha,
        module_id=module_id,
        module_version=1,
        params=params,
        params_sha256=request_sha256(params),
        gpu_requested="none",
        frames=frames or synthetic_frames(),
        scratch=Path(tempfile.gettempdir()),
        beat=lambda _phase, _frames: None,
        log=lambda _line: None,
        mp4_path=Path("unused.mp4"),
        manifest=modules.resolve(stage, ref),
        segments=segments,
        segments_sha256=segments_sha256,
    )


def recipe(
    segment_params: dict[str, Any] | None = None,
    caption_params: dict[str, Any] | None = None,
    segment_module: str = "stub_segmenter@1",
    caption_module: str = "stub_captioner@1",
) -> dict[str, Any]:
    def stage(name: str, module: str, params: dict[str, Any] | None) -> dict[str, Any]:
        return {
            "stage": name,
            "enabled": True,
            "module": module,
            "params": params or {},
            "resources": {
                "gpu": "none",
                "budgetSeconds": 60,
                "maxContainers": 1,
                "retries": 0,
            },
        }

    return {
        "schemaVersion": 1,
        "recipeId": "local_stub@1",
        "maxJobCostUsd": "0.00",
        "stages": [
            stage("segment", segment_module, segment_params),
            stage("caption", caption_module, caption_params),
            stage("hand_pose", "hand_pose_cpu_v1@1", {}),
        ],
    }


def task_input(rec: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 3,
        "jobId": JOB,
        "targetId": RECORDING,
        "profileRevision": "cpu-mediapipe-1",
        "kind": "process_recording",
        "sourceManifestSha256": MANIFEST_SHA,
        "rgbProfile": "h264_mcap_v1",
        "recipe": rec,
        "recipeSha256": request_sha256(rec),
    }


def write_io_dir(
    directory: Path,
    stage: str,
    rec: dict[str, Any],
    segments_bytes: bytes | None = None,
    segments_sha: str | None = None,
) -> None:
    """A file-backed stage directory over the committed SA-50 golden MCAP."""
    from indexed_fixture import chunked

    module = next(s["module"] for s in rec["stages"] if s["stage"] == stage)
    boot: dict[str, Any] = {
        "schemaVersion": 2,
        "jobId": JOB,
        "executionRef": "io-dir-test",
        "stage": stage,
        "module": module,
        "recipeSha256": request_sha256(rec),
        "taskInput": task_input(rec),
    }
    if stage == "caption":
        assert segments_bytes is not None
        boot["segmentsSha256"] = (
            segments_sha or __import__("hashlib").sha256(segments_bytes).hexdigest()
        )
        (directory / "segments.json").write_bytes(segments_bytes)
    (directory / "bootstrap.json").write_text(json.dumps(boot))
    (directory / "source.mcap").write_bytes(chunked(GOLDEN_MCAP.read_bytes()))
