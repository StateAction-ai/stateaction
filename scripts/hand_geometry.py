"""Explicit hand camera reconstruction and conservative evidence checks.

MediaPipe's separate 2D/world predictions are not a calibrated reconstruction.
This module preserves the predicted shape and compares a historical depth
anchor with an explicit calibrated perspective camera estimate. Surface-depth
and model contradictions remain reported. A fitted consistency score is not
ground truth. Unknown finger visibility remains unknown.

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


def fit_perspective_camera(relative_joints_m, landmarks_rgb_px, rgb_K,
                           *, fit_indices=None):
    """Recover a rigid calibrated camera, preserving the learned model shape.

    MediaPipe's world-landmark graph rotates crop XYZ back into image axes;
    it does not recover a perspective camera using the recording's intrinsics.
    This solve supplies that missing step. The model's metric scale remains a
    learned prior. Reprojection is a FIT residual, not an accuracy measurement.
    ``fit_indices`` supports disjoint-joint diagnostic evaluation.
    """
    import cv2

    shape = np.asarray(relative_joints_m, dtype=np.float64)
    pixels = np.asarray(landmarks_rgb_px, dtype=np.float64)
    K = np.asarray(rgb_K, dtype=np.float64)
    if shape.shape != (21, 3) or pixels.shape != (21, 2) or K.shape != (3, 3):
        raise ValueError("Expected 21x3 model, 21x2 pixels and 3x3 intrinsics")
    if not np.isfinite(K).all() or abs(np.linalg.det(K)) < 1e-10:
        raise ValueError("RGB intrinsics must be finite and invertible")
    indices = np.arange(21) if fit_indices is None else np.asarray(fit_indices, dtype=int)
    if indices.ndim != 1 or np.any(indices < 0) or np.any(indices >= 21):
        raise ValueError("fit_indices must index the 21 hand joints")
    finite = np.isfinite(shape[indices]).all(axis=1) & np.isfinite(pixels[indices]).all(axis=1)
    indices = np.unique(indices[finite])
    if len(indices) < 4 or np.linalg.matrix_rank(shape[indices]-shape[indices].mean(axis=0), tol=1e-8) < 2:
        return None
    try:
        ok, r, t = cv2.solvePnP(shape[indices], pixels[indices], K, None,
                              flags=cv2.SOLVEPNP_SQPNP)
        if not ok:
            return None
        ok, r, t = cv2.solvePnP(shape[indices], pixels[indices], K, None,
                              r, t, useExtrinsicGuess=True,
                              flags=cv2.SOLVEPNP_ITERATIVE)
        if not ok:
            return None
    except cv2.error:
        return None
    rotation = cv2.Rodrigues(r)[0]
    candidate = shape @ rotation.T + t.ravel()
    finite_points = np.isfinite(candidate).all(axis=1)
    if not finite_points[indices].all() or np.any(candidate[finite_points, 2] <= 0):
        return None
    return {"candidate_joints_m": candidate, "rotation": rotation,
            "translation_m": t.ravel(), "fit_joint_indices": indices,
            "reprojection_error_px": np.linalg.norm(project_points(candidate, K)-pixels, axis=1)}


def use_video_mode(backend, model_path):
    """Use frame-to-frame ROI tracking with the same MediaPipe model/settings.

    Local adapter only; the audited SDK checkout stays unchanged. Call once at
    the start of a recording, then supply its monotonically increasing event
    timestamps to ``detect_observations``. Never share state across recordings.
    """
    backend.load()
    mp, cfg = backend._mp, backend.config
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=cfg.max_num_hands,
        min_hand_detection_confidence=cfg.min_detection_confidence,
        min_hand_presence_confidence=cfg.min_presence_confidence,
        min_tracking_confidence=cfg.min_tracking_confidence)
    replacement = mp.tasks.vision.HandLandmarker.create_from_options(options)
    try:
        backend._landmarker.close()
    except Exception:
        replacement.close()
        raise
    backend._landmarker = replacement


def detect_observations(backend, rgb, *, deduplicate_by_side=True, timestamp_ms=None):
    """Read MediaPipe predictions before Stera's depth anchoring loses evidence.

    ``backend`` is the SDK MediaPipeHandTracker (not its HandTracker facade).
    The backend's already configured landmarker/model is reused. Labels and
    per-side best-handedness deduplication match Stera by default. Set
    ``deduplicate_by_side=False`` for diagnostics that preserve every returned
    detection even when two hands receive the same side label. Handedness scores are
    deliberately named; they are never treated as pose confidence.
    ``timestamp_ms`` selects VIDEO inference; call ``use_video_mode`` first.
    """
    backend.load()
    image = np.asarray(rgb)
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("Expected HxWx3 RGB image")
    image = np.ascontiguousarray(image, dtype=np.uint8)
    mp = backend._mp
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image)
    if timestamp_ms is None:
        result = backend._landmarker.detect(mp_image)
    else:
        if isinstance(timestamp_ms, bool) or not isinstance(timestamp_ms, (int, np.integer)) or timestamp_ms < 0:
            raise ValueError("Video inference requires a nonnegative integer event timestamp in milliseconds")
        result = backend._landmarker.detect_for_video(mp_image, int(timestamp_ms))
    if not result.hand_landmarks or not result.handedness:
        return []
    if len(result.hand_landmarks) != len(result.handedness) or len(result.hand_landmarks) != len(result.hand_world_landmarks):
        raise RuntimeError("MediaPipe returned inconsistent hand result counts")
    height, width = image.shape[:2]
    best, observations = {}, []
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
        observations.append(observation)
        if side not in best or observation["handedness_score"] > best[side]["handedness_score"]:
            best[side] = observation
    return list(best.values()) if deduplicate_by_side else observations


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


def reconstruct_perspective_hand(relative_joints_m, landmarks_rgb_px, depth_m,
                                 rgb_K, **kwargs):
    """Recover the camera missing from crop-model XYZ, then audit depth.

    The rigid shape is preserved. Surface depth is independent evidence and
    does not force a wrong camera translation onto the learned shape. Raw
    observations, the old depth-anchored candidate, and the fitted candidate
    remain separate. Anatomical accuracy and learned scale are unvalidated.
    """
    baseline = reconstruct_hand(relative_joints_m, landmarks_rgb_px, depth_m,
                                rgb_K, **kwargs)
    model = np.asarray(relative_joints_m, dtype=float)
    model = model-model[:1]
    uv = np.asarray(landmarks_rgb_px, dtype=float)
    K = np.asarray(rgb_K, dtype=float)
    policy = kwargs.get("policy") or GeometryPolicy()
    size = np.asarray(kwargs["rgb_size_wh"], dtype=float)
    in_image = np.isfinite(uv).all(axis=1) & (uv >= 0).all(axis=1) & (uv < size).all(axis=1)
    fit = fit_perspective_camera(model, uv, K, fit_indices=np.flatnonzero(in_image))
    if fit is None:
        baseline["baseline_candidate_joints_m"] = baseline["candidate_joints_m"].copy()
        baseline["candidate_joints_m"] = np.full((21, 3), np.nan)
        baseline["supported_joints_m"] = np.full((21, 3), np.nan)
        baseline["joint_geometry_valid"] = np.zeros(21, dtype=bool)
        baseline["joint_visibility_supported"] = np.zeros(21, dtype=bool)
        q = baseline["quality"]
        q.update({"schema_version": 2, "reconstruction_method": "calibrated_rigid_pnp",
                  "camera_fit_valid": False, "geometry_consistent": False,
                  "status": "camera_reconstruction_failed", "fully_observed_consistent": False,
                  "joint_geometry_valid": [False]*21,
                  "joint_visibility_supported": [False]*21})
        q["rejection_reasons"].append("perspective_camera_solve_failed")
        return baseline
    # Rotate the shape into fitted camera axes before checking whether the
    # independently observed palm surface depths imply a common wrist depth.
    rotated = model @ fit["rotation"].T
    rotated_audit = reconstruct_hand(rotated, uv, depth_m, K, **kwargs)
    q = rotated_audit["quality"]
    q["camera_rotated_model_sha256"] = q["input_hashes"]["model_joints"]
    q["input_hashes"] = baseline["quality"]["input_hashes"]
    q["baseline_translation_only"] = {
        "nonwrist_reprojection_median_px": baseline["quality"]["nonwrist_reprojection_median_px"],
        "nonwrist_reprojection_p90_px": baseline["quality"]["nonwrist_reprojection_p90_px"],
        "wrist_depth_m": baseline["quality"]["wrist_depth_m"],
        "rejection_reasons": baseline["quality"]["rejection_reasons"]}
    candidate = fit["candidate_joints_m"]
    residual = fit["reprojection_error_px"]
    finite = np.isfinite(candidate).all(axis=1) & (candidate[:, 2] > 0) & in_image
    nonwrist = finite.copy(); nonwrist[0] = False
    median_px = float(np.median(residual[nonwrist])) if nonwrist.any() else None
    p90_px = float(np.quantile(residual[nonwrist], .9)) if nonwrist.any() else None
    reasons = [r for r in q["rejection_reasons"] if r not in (
        "model_image_projection_inconsistent", "wrist_depth_out_of_range", "insufficient_projectable_joints")]
    if nonwrist.sum() < 5:
        reasons.append("insufficient_projectable_joints")
    elif median_px > q["reprojection_threshold_px"] or p90_px > q["reprojection_threshold_px"]*2:
        reasons.append("model_image_projection_inconsistent")
    if not policy.min_depth_m <= candidate[0, 2] <= policy.max_depth_m:
        reasons.append("wrist_depth_out_of_range")
    z_residual = np.full(21, np.nan)
    for i, sample in enumerate(q["depth_samples"]):
        if sample is not None:
            z_residual[i] = abs(candidate[i, 2]-sample["depth_m"])
    anchor_z = q["wrist_depth_m"]
    depth_disagreement = None if anchor_z is None else abs(float(candidate[0, 2])-anchor_z)
    if depth_disagreement is not None and depth_disagreement > policy.max_anchor_disagreement_m:
        reasons.append("model_scale_surface_depth_disagreement")
    joint_consistent = finite & (residual <= q["reprojection_threshold_px"]) & np.isfinite(z_residual) & (z_residual <= policy.max_joint_depth_residual_m)
    consistent = not reasons
    joint_valid = joint_consistent & consistent
    visibility = kwargs.get("visible_joints")
    visible = np.zeros(21, bool) if visibility is None else np.asarray(visibility, bool)
    supported = joint_valid & visible
    masked = candidate.copy(); masked[~supported] = np.nan

    def numbers(values):
        return [float(v) if np.isfinite(v) else None for v in values]

    # Evaluate a distinct subset of joints, still explicitly same-model
    # consistency. This is not the fitted all-joint reprojection score.
    palm = [j for j in (0, 5, 9, 13, 17) if in_image[j]]
    holdout = [j for j in range(21) if j not in palm and in_image[j]]
    palm_fit = fit_perspective_camera(model, uv, K, fit_indices=palm)
    heldout_px = (float(np.median(palm_fit["reprojection_error_px"][holdout]))
                  if palm_fit is not None and holdout else None)
    q.update({"schema_version": 2, "reconstruction_method": "calibrated_rigid_pnp",
              "camera_fit_valid": True,
              "pose_solution_ambiguity_evaluated": False,
              "geometry_consistent": consistent,
              "status": "consistent_estimate" if consistent else "rejected_geometry",
              "fully_observed_consistent": bool(supported.all()),
              "rejection_reasons": reasons,
              "reprojection_semantics": "fitted same-model 2D/world prediction consistency; not independent accuracy",
              "fit_joint_indices": fit["fit_joint_indices"].tolist(),
              "camera_fit_rotation": fit["rotation"].tolist(),
              "camera_fit_translation_m": fit["translation_m"].tolist(),
              "metric_scale_source": "learned model shape prior; not measured or independently validated",
              "nonwrist_reprojection_median_px": median_px,
              "nonwrist_reprojection_p90_px": p90_px,
              "reprojection_error_px": numbers(residual),
              "joint_depth_residual_m": numbers(z_residual),
              "surface_depth_wrist_m": anchor_z,
              "wrist_depth_m": float(candidate[0, 2]),
              "model_scale_surface_depth_disagreement_m": depth_disagreement,
              "palm_fit_finger_heldout_median_px": heldout_px,
              "heldout_score_semantics": "disjoint joints from same model; not independent ground truth",
              "joint_geometry_valid": joint_valid.tolist(),
              "joint_visibility_supported": supported.tolist(),
              "limitations": [
                  "Camera fit preserves learned model shape and inherits its unverified metric scale.",
                  "Fitted reprojection is not independent evidence of anatomical accuracy.",
                  "Depth measures skin/object/background surfaces, not anatomical joint centres.",
                  "Occluded-joint visibility remains unknown unless independently supplied."]})
    return {"candidate_joints_m": candidate,
            "baseline_candidate_joints_m": baseline["candidate_joints_m"],
            "supported_joints_m": masked,
            "joint_geometry_valid": joint_valid,
            "joint_visibility_supported": supported,
            "quality": q}
