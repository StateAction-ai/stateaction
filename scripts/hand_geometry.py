"""Conservative metric-hand reconstruction and evidence checks.

MediaPipe's separate 2D/world predictions are not a calibrated reconstruction.
This module preserves the predicted shape, anchors it using registered depth,
and reports contradictions instead of fitting them away. A passing consistency
check is not ground truth. Unknown finger visibility remains unknown.

Depth must be camera-Z in meters. ``rgb_to_depth`` must be the recorded mapping
from saved RGB pixels to depth pixels; dimensions alone cannot establish it.
The RGB camera must use the same optical axes as the depth-Z measurement.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
from typing import Mapping

import numpy as np


@dataclass(frozen=True)
class GeometryPolicy:
    # Conservative engineering tolerances, not calibrated confidence scores.
    depth_patch_radius: int = 1
    min_patch_samples: int = 3
    min_anchor_count: int = 3
    min_depth_m: float = 0.1
    max_depth_m: float = 2.0
    max_patch_spread_m: float = 0.04
    max_anchor_disagreement_m: float = 0.04
    max_joint_depth_residual_m: float = 0.04
    max_reprojection_px: float = 12.0
    max_reprojection_fraction: float = 0.06


def _fingerprint(array):
    a = np.ascontiguousarray(array)
    return hashlib.sha256(str(a.dtype).encode() + str(a.shape).encode()
                          + a.tobytes()).hexdigest()


def project_points(points_m, intrinsic):
    p = np.asarray(points_m, dtype=float) @ np.asarray(intrinsic, dtype=float).T
    with np.errstate(invalid="ignore", divide="ignore"):
        return p[:, :2] / p[:, 2:3]


def detect_observations(backend, rgb):
    """Read MediaPipe predictions before Stera's depth anchoring loses evidence.

    ``backend`` is the SDK MediaPipeHandTracker (not its HandTracker facade).
    The backend's already configured landmarker/model is reused. Labels and
    per-side best-handedness deduplication match Stera. Handedness scores are
    deliberately named; they are never treated as pose confidence.
    """
    backend.load()
    image = np.asarray(rgb)
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("Expected HxWx3 RGB image")
    image = np.ascontiguousarray(image, dtype=np.uint8)
    mp = backend._mp
    result = backend._landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=image))
    if not result.hand_landmarks or not result.handedness:
        return []
    if len(result.hand_landmarks) != len(result.handedness) or len(result.hand_landmarks) != len(result.hand_world_landmarks):
        raise RuntimeError("MediaPipe returned inconsistent hand result counts")
    height, width = image.shape[:2]
    best = {}
    for image_lm, world_lm, categories in zip(result.hand_landmarks, result.hand_world_landmarks, result.handedness):
        if not categories:
            continue
        side = categories[0].category_name.lower()
        if side not in ("left", "right"):
            raise RuntimeError(f"Unexpected MediaPipe handedness category: {side!r}")
        normalized = np.array([[p.x, p.y, p.z] for p in image_lm], dtype=np.float64)
        world = np.array([[p.x, p.y, p.z] for p in world_lm], dtype=np.float64)
        if normalized.shape != (21, 3) or world.shape != (21, 3):
            raise RuntimeError("MediaPipe returned an unexpected hand topology")
        observation = {
            "hand_side": side,
            "handedness_score": float(categories[0].score),
            "landmarks_rgb_px": normalized[:, :2] * [width, height],
            "relative_joints_m": world - world[:1],
            "raw_world_landmarks_m": world,
            "raw_image_landmarks_normalized": normalized,
            "backend": "mediapipe",
        }
        if side not in best or observation["handedness_score"] > best[side]["handedness_score"]:
            best[side] = observation
    return list(best.values())


def _sample(depth, pixel, policy):
    if not np.isfinite(pixel).all():
        return None, "nonfinite_pixel"
    h, w = depth.shape
    if not (0 <= pixel[0] < w and 0 <= pixel[1] < h):
        return None, "outside_depth"
    # Pixel centres are represented by integer coordinates.
    x, y = np.rint(pixel).astype(int)
    if not (0 <= x < w and 0 <= y < h):
        return None, "outside_depth"
    r = policy.depth_patch_radius
    patch = depth[max(0, y-r):min(h, y+r+1), max(0, x-r):min(w, x+r+1)]
    good = patch[np.isfinite(patch) & (patch >= policy.min_depth_m)
                 & (patch <= policy.max_depth_m)]
    if good.size < policy.min_patch_samples:
        return None, "insufficient_depth_samples"
    q10, q90 = np.quantile(good, [.1, .9])
    if q90 - q10 > policy.max_patch_spread_m:
        return None, "depth_discontinuity"
    return {"depth_m": float(np.median(good)), "samples": int(good.size),
            "spread_p90_p10_m": float(q90-q10),
            "depth_pixel": [float(pixel[0]), float(pixel[1])]}, None


def reconstruct_hand(relative_joints_m, landmarks_rgb_px, depth_m, rgb_K, *,
                     rgb_size_wh, rgb_to_depth,
                     calibration_verified=False, depth_registered=False,
                     depth_time_verified=False, visible_joints=None,
                     handedness_score=None, provenance: Mapping | None = None,
                     policy: GeometryPolicy | None = None):
    """Return candidate arrays and a JSON-safe quality report without mutation.

    ``relative_joints_m`` may have any origin; the wrist is subtracted here.
    ``visible_joints`` is an independently supplied visibility mask, NOT the
    MediaPipe handedness score. Omit it when visibility is unknown. Candidate
    geometry is still returned for diagnostics, but unsupported joints are NaN
    in ``supported_joints_m``. No scale, bone lengths or rotations are fitted.

    ``geometry_consistent`` means this estimate survived specified checks;
    it never certifies anatomical or hidden-joint accuracy.
    """
    policy = policy or GeometryPolicy()
    raw = np.asarray(relative_joints_m)
    uv_raw = np.asarray(landmarks_rgb_px)
    depth_raw = np.asarray(depth_m)
    model = np.array(raw, dtype=float, copy=True)
    uv = np.array(uv_raw, dtype=float, copy=True)
    depth = np.asarray(depth_raw, dtype=float)
    K = np.array(rgb_K, dtype=float, copy=True)
    H = None if rgb_to_depth is None else np.array(rgb_to_depth, dtype=float, copy=True)
    if model.shape != (21, 3) or uv.shape != (21, 2) or depth.ndim != 2:
        raise ValueError("Expected 21x3 model, 21x2 image landmarks and 2D depth")
    if K.shape != (3, 3) or not np.isfinite(K).all() or abs(np.linalg.det(K)) < 1e-10:
        raise ValueError("RGB intrinsics must be finite and invertible")
    size = np.asarray(rgb_size_wh, dtype=float)
    if size.shape != (2,) or not np.isfinite(size).all() or np.any(size <= 0):
        raise ValueError("rgb_size_wh must contain positive width and height")
    if H is not None and (H.shape != (3, 3) or not np.isfinite(H).all()
                          or abs(np.linalg.det(H)) < 1e-10):
        raise ValueError("rgb_to_depth must be a finite invertible 3x3 mapping")
    if policy.depth_patch_radius < 0 or policy.min_patch_samples < 1 or policy.min_anchor_count < 1:
        raise ValueError("Invalid depth sampling policy")
    visibility_known = visible_joints is not None
    visible = np.zeros(21, dtype=bool) if not visibility_known else np.array(visible_joints, dtype=bool, copy=True)
    if visible.shape != (21,):
        raise ValueError("visible_joints must contain 21 boolean entries")
    reasons = []
    if not calibration_verified:
        reasons.append("camera_calibration_unverified")
    if not depth_registered or H is None:
        reasons.append("rgb_depth_registration_unverified")
    if not depth_time_verified:
        reasons.append("rgb_depth_timing_unverified")
    if not np.isfinite(model[0]).all() or not np.isfinite(uv[0]).all():
        reasons.append("missing_wrist")
    model -= model[:1]
    in_image = np.isfinite(uv).all(axis=1) & (uv >= 0).all(axis=1) & (uv < size).all(axis=1)
    if not in_image[0]:
        reasons.append("wrist_outside_image")
    mapped = np.full((21, 2), np.nan)
    if H is not None:
        hp = np.column_stack([uv, np.ones(21)]) @ H.T
        with np.errstate(invalid="ignore", divide="ignore"):
            mapped = hp[:, :2] / hp[:, 2:3]
    samples, sample_reasons = [], []
    for i in range(21):
        sample, why = _sample(depth, mapped[i], policy) if in_image[i] else (None, "outside_rgb")
        samples.append(sample); sample_reasons.append(why)
    # Skin-surface depth is only an approximate skeletal-joint depth. Anchor
    # disagreement is exposed; hidden fingers must not be promoted by this fit.
    anchors = []
    for joint in (0, 5, 9, 13, 17):
        if samples[joint] is not None and np.isfinite(model[joint]).all():
            # When visibility is known, an occluded MCP cannot anchor the hand.
            if visibility_known and not visible[joint]:
                continue
            anchors.append({"joint": joint,
                            "wrist_depth_m": samples[joint]["depth_m"] - float(model[joint, 2])})
    candidate = np.full((21, 3), np.nan)
    anchor_z, agreement = None, None
    if len(anchors) < policy.min_anchor_count or not any(a["joint"] == 0 for a in anchors):
        reasons.append("insufficient_wrist_and_palm_depth")
    else:
        values = np.array([a["wrist_depth_m"] for a in anchors])
        anchor_z = float(np.median(values))
        agreement = float(np.max(np.abs(values - anchor_z)))
        if agreement > policy.max_anchor_disagreement_m:
            reasons.append("inconsistent_palm_depth")
        if not policy.min_depth_m <= anchor_z <= policy.max_depth_m:
            reasons.append("wrist_depth_out_of_range")
        if np.isfinite(uv[0]).all():
            ray = np.linalg.solve(K, np.r_[uv[0], 1.])
            candidate = model + ray * (anchor_z / ray[2])
    projected = project_points(candidate, K)
    residual = np.linalg.norm(projected - uv, axis=1)
    finite = np.isfinite(candidate).all(axis=1) & (candidate[:, 2] > 0) & in_image
    spatial_extent = (float(np.linalg.norm(np.ptp(uv[in_image], axis=0))) if in_image.any() else 0.)
    # Both absolute pixels and hand-size-relative error must be small. Large
    # image resolution alone does not buy permission for gross finger errors.
    threshold = min(policy.max_reprojection_px,
                    max(2., policy.max_reprojection_fraction * spatial_extent))
    evidence = finite & np.isfinite(residual)
    nonwrist = evidence.copy(); nonwrist[0] = False
    median_px = float(np.median(residual[nonwrist])) if nonwrist.any() else None
    p90_px = float(np.quantile(residual[nonwrist], .9)) if nonwrist.any() else None
    if nonwrist.sum() < 5:
        reasons.append("insufficient_projectable_joints")
    elif median_px > threshold or p90_px > threshold * 2:
        reasons.append("model_image_projection_inconsistent")
    z_residual = np.full(21, np.nan)
    for i, sample in enumerate(samples):
        if sample is not None:
            z_residual[i] = abs(candidate[i, 2] - sample["depth_m"])
    joint_consistency = evidence & (residual <= threshold) & np.isfinite(z_residual) & (z_residual <= policy.max_joint_depth_residual_m)
    geometry_consistent = not reasons
    joint_geometry_valid = joint_consistency & geometry_consistent
    supported = joint_geometry_valid & visible
    masked = candidate.copy(); masked[~supported] = np.nan

    def numbers(a):
        return [float(x) if np.isfinite(x) else None for x in a]

    report = {
        "schema_version": 1,
        "status": "consistent_estimate" if geometry_consistent else "rejected_geometry",
        "geometry_consistent": geometry_consistent,
        "metric_accuracy_validated": False,
        "fully_observed_consistent": bool(supported.all()),
        "rejection_reasons": reasons,
        "visibility_status": "provided" if visibility_known else "unknown",
        "unknown_visibility_is_not_acceptance": True,
        "handedness_score": float(handedness_score) if handedness_score is not None and np.isfinite(handedness_score) else None,
        "handedness_score_is_pose_confidence": False,
        "policy": asdict(policy),
        "reprojection_threshold_px": threshold,
        "nonwrist_reprojection_median_px": median_px,
        "nonwrist_reprojection_p90_px": p90_px,
        "reprojection_error_px": numbers(residual),
        "joint_depth_residual_m": numbers(z_residual),
        "depth_sample_rejection_reasons": sample_reasons,
        "depth_samples": samples,
        "anchor_wrist_depth_estimates": anchors,
        "wrist_depth_m": anchor_z,
        "max_anchor_disagreement_m": agreement,
        "joint_geometry_valid": joint_geometry_valid.tolist(),
        "joint_visibility_supported": supported.tolist(),
        "calibration_verified": bool(calibration_verified),
        "depth_registered": bool(depth_registered),
        "depth_time_verified": bool(depth_time_verified),
        "rgb_K": K.tolist(),
        "rgb_to_depth": None if H is None else H.tolist(),
        "rgb_size_wh": size.tolist(),
        "input_hashes": {"model_joints": _fingerprint(raw), "landmarks_rgb": _fingerprint(uv_raw),
                         "depth_m": _fingerprint(depth_raw)},
        "provenance": dict(provenance or {}),
        "limitations": ["Depth measures skin/object surfaces, not anatomical joint centres.",
                        "No scale, bone length or rotation is fitted to the same 2D predictions.",
                        "Consistency and supplied visibility do not establish ground-truth 3D accuracy."]}
    return {"candidate_joints_m": candidate,
            "supported_joints_m": masked,
            "joint_geometry_valid": joint_geometry_valid,
            "joint_visibility_supported": supported,
            "quality": report}
