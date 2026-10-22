"""Pin verified Stera Android/ARCore body estimates to world +Y at runtime.

This changes only the skeleton's up/down sign. The upstream warmup, camera
poses, optical transform, wrist detections and body dimensions are preserved.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path


VERIFIED_SDK_COMMIT = "df6a5ec8919053c5cd448db83d4816e1faaaec62"


def adapt_skeleton_world_up(estimator, session, mcap: Path, metadata_path: Path,
                            sdk_commit: str) -> dict:
    mcap, metadata_path = Path(mcap).resolve(), Path(metadata_path)
    result = {
        "adapter": "stera_arcore_world_up_v1",
        "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "applied": False,
        "sdk_commit": sdk_commit,
        "metadata_path": str(metadata_path.resolve()),
        "metadata_sha256": None,
        "world_up": None,
        "camera_poses_changed": False,
        "optical_transform_changed": False,
        "hand_detections_changed_by_adapter": False,
        "upstream_warmup_preserved": True,
    }

    def skip(reason):
        result["reason"] = reason
        return result

    if sdk_commit != VERIFIED_SDK_COMMIT:
        return skip("SDK revision is not the verified pose/estimator implementation")
    if not metadata_path.is_file():
        return skip("No source recorder metadata; upstream behavior retained")
    result["metadata_sha256"] = hashlib.sha256(metadata_path.read_bytes()).hexdigest()
    metadata = json.loads(metadata_path.read_text())
    if not metadata.get("android_version") or not metadata.get("arcore_version"):
        return skip("Not identified as an Android ARCore recording")
    session_name = mcap.parent.name
    if (Path(metadata.get("storage", {}).get("path", "")).name != session_name
            or not session_name.startswith("session_")
            or mcap.name != f"session_data_{session_name.removeprefix('session_')}.mcap"
            or Path(session.path).resolve() != mcap):
        return skip("Metadata, MCAP filename and session path do not identify the same capture")
    native_start = metadata.get("session_start_timestamp_ns")
    poses = session.all_camera_poses()
    if (not isinstance(native_start, int) or native_start <= 0 or not poses
            or not math.isclose(poses[0][0], native_start / 1e9, rel_tol=0, abs_tol=1e-6)):
        return skip("Native first-pose timestamp does not match recorder metadata")

    import numpy as np

    upstream_ensure_up = estimator._ensure_up

    def ensure_world_up(camera_position, camera_rotation):
        # Let the original implementation collect its ten samples. Override
        # only after it declares readiness, preserving the first nine misses.
        ready = upstream_ensure_up(camera_position, camera_rotation)
        if ready:
            estimator._up = np.array([0.0, 1.0, 0.0])
            estimator._down = np.array([0.0, -1.0, 0.0])
        return ready

    estimator._ensure_up = ensure_world_up
    result.update({
        "applied": True,
        "reason": "Verified Android ARCore world frame is +Y up; image roll must not choose gravity sign",
        "world_up": [0.0, 1.0, 0.0],
        "device_model": metadata.get("device_model"),
        "arcore_version": metadata["arcore_version"],
        "native_first_pose_ns": native_start,
        "upstream_up_axis_config": estimator.config.up_axis,
        "source_pose_contract": "Android ArFrameProcessorImpl.extractPose stores camera.pose unchanged",
        "source_reference": "https://developers.google.com/ar/reference/java/com/google/ar/core/Camera#getPose()",
        "limitation": "Vertical-sign correction only; optical-frame alignment and head-mount/body assumptions remain unvalidated",
    })
    return result
