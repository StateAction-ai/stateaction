#!/usr/bin/env python3
"""Measure capture depth/pose consistency against a printed ChArUco board.

This is an independent image-feature reference, sharing the recorded camera K.
It does not certify intrinsic accuracy, synchronization, hand labels or a buyer's
training requirements. Use the project Python environment.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

SQUARES = (7, 10)
NOMINAL_SQUARE_MM = 20.
MARKER_RATIO = .7


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def board(square_mm=NOMINAL_SQUARE_MM):
    if not np.isfinite(square_mm) or square_mm <= 0:
        raise ValueError("Measured square size must be positive millimetres")
    return cv2.aruco.CharucoBoard(SQUARES, square_mm / 1000,
        square_mm * MARKER_RATIO / 1000,
        cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_100))


def stats(values):
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    if not values.size:
        return {"count": 0}
    return {"count": int(values.size), "median": float(np.median(values)),
            "p90": float(np.percentile(values, 90)), "max": float(values.max())}


def rotation_deg(rotation):
    return float(np.degrees(np.arccos(np.clip((np.trace(rotation) - 1) / 2, -1, 1))))


def transform(rotation, translation):
    out = np.eye(4)
    out[:3, :3], out[:3, 3] = rotation, np.asarray(translation).reshape(3)
    return out


def generate_target(output):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    output.mkdir(parents=True, exist_ok=False)
    image = board().generateImage((1400, 2000), marginSize=0, borderBits=1)
    cv2.imwrite(str(output / "board.png"), image)
    fig = plt.figure(figsize=(210 / 25.4, 297 / 25.4))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 210); ax.set_ylim(297, 0); ax.set_axis_off()
    ax.imshow(image, cmap="gray", vmin=0, vmax=255, interpolation="nearest",
              extent=(35, 175, 245, 45))
    ax.text(105, 16, "Capture calibration target", ha="center", fontsize=14)
    ax.text(105, 25, "Print A4 at 100% / Actual size. Disable Fit to page.", ha="center", fontsize=9)
    ax.text(105, 33, "7 x 10 squares; each square 20 mm. Mount flat and keep still.", ha="center", fontsize=9)
    ax.plot([35, 85], [270, 270], color="black", linewidth=1)
    for x in range(35, 86, 10):
        ax.plot([x, x], [268, 272], color="black", linewidth=1)
    ax.text(60, 279, "Measure this line: 50 mm", ha="center", fontsize=9)
    ax.text(105, 289, "DICT_4X4_100 | ChArUco 7 x 10 | marker 14 mm", ha="center", fontsize=8)
    fig.savefig(output / "target-a4.pdf", dpi=254)  # 10 pixels/mm; retain physical A4 size.
    fig.savefig(output / "page-preview.png", dpi=150)
    plt.close(fig)
    spec = {"schema": "capture_charuco_target_v1", "page_mm": [210, 297],
            "board_mm": [140, 200], "squares": list(SQUARES),
            "square_mm": NOMINAL_SQUARE_MM, "marker_mm": 14.,
            "dictionary": "DICT_4X4_100", "legacy_pattern": False,
            "opencv_version": cv2.__version__, "print_scale_verified": False,
            "files": {p.name: sha(p) for p in output.iterdir() if p.is_file()}}
    (output / "spec.json").write_text(json.dumps(spec, indent=2) + "\n")
    return spec


def estimate_board(gray, camera_k, reference, *, min_corners=12, max_rms_px=1.5,
                   ambiguity_margin_px=.25):
    # Detect without K so corner localization does not use the geometry being tested.
    corners, ids, _, _ = cv2.aruco.CharucoDetector(reference).detectBoard(gray)
    row = {"corner_count": 0 if ids is None else len(ids), "pose_usable": False}
    if ids is None or len(ids) < min_corners:
        return {**row, "reason": "insufficient_detected_corners"}, None, None
    points = reference.getChessboardCorners()[ids.ravel()].astype(np.float64)
    pixels = corners.reshape(-1, 2).astype(np.float64)
    if np.linalg.matrix_rank(points[:, :2] - points[:, :2].mean(axis=0)) < 2:
        return {**row, "reason": "collinear_corners"}, None, pixels
    _, rvecs, tvecs, _ = cv2.solvePnPGeneric(points, pixels, camera_k, None,
                                           flags=cv2.SOLVEPNP_IPPE)
    candidates = []
    for rvec, tvec in zip(rvecs, tvecs):
        rotation = cv2.Rodrigues(rvec)[0]
        z = (points @ rotation.T + tvec.reshape(3))[:, 2]
        predicted = cv2.projectPoints(points, rvec, tvec, camera_k, None)[0].reshape(-1, 2)
        error = float(np.sqrt(np.mean(np.sum((predicted - pixels) ** 2, axis=1))))
        if np.isfinite(error) and np.isfinite(z).all() and np.all(z > 0):
            candidates.append((error, transform(rotation, tvec)))
    candidates.sort(key=lambda value: value[0])
    row.update(corner_ids=ids.ravel().tolist(),
               candidate_reprojection_rms_px=[x[0] for x in candidates])
    if not candidates or candidates[0][0] > max_rms_px:
        return {**row, "reason": "no_low_residual_positive_depth_pose"}, None, pixels
    if len(candidates) > 1:
        delta = np.linalg.inv(candidates[0][1]) @ candidates[1][1]
        equivalent = np.linalg.norm(delta[:3, 3]) < .001 and rotation_deg(delta[:3, :3]) < .5
        row["planar_solution_margin_px"] = candidates[1][0] - candidates[0][0]
        if not equivalent and row["planar_solution_margin_px"] < ambiguity_margin_px:
            return {**row, "reason": "ambiguous_planar_pose"}, None, pixels
    return {**row, "pose_usable": True, "reason": "image_reference_available",
            "board_to_optical": candidates[0][1].tolist()}, candidates[0][1], pixels


def depth_comparison(depth_mm, depth_k, rgb_to_depth, pixels, camera_from_board):
    """Compare every positive interior depth sample with the image-derived plane.

    No depth value selects or fits the reference plane. Zero/missing depth is
    counted separately, and large residuals are retained rather than filtered.
    """
    homogeneous = np.column_stack((pixels, np.ones(len(pixels)))) @ rgb_to_depth.T
    mapped = homogeneous[:, :2] / homogeneous[:, 2, None]
    mask = np.zeros(depth_mm.shape, dtype=np.uint8)
    cv2.fillConvexPoly(mask, cv2.convexHull(np.rint(mapped).astype(np.int32)), 1)
    mask = cv2.erode(mask, np.ones((5, 5), np.uint8))
    yy, xx = np.nonzero(mask)
    result = {"interior_pixels": len(xx), "positive_depth_pixels": 0}
    if not len(xx):
        return {**result, "status": "no_interior_depth_pixels"}
    rays = np.column_stack((xx, yy, np.ones(len(xx)))) @ np.linalg.inv(depth_k).T
    normal = camera_from_board[:3, 2]
    denominator = rays @ normal
    expected = np.full(len(xx), np.nan)
    valid_rays = np.abs(denominator) > 1e-9
    expected[valid_rays] = (normal @ camera_from_board[:3, 3]) / denominator[valid_rays]
    measured = depth_mm[yy, xx].astype(float) / 1000
    valid = (measured > 0) & np.isfinite(measured) & np.isfinite(expected) & (expected > 0)
    result.update(positive_depth_pixels=int(valid.sum()),
                  missing_or_invalid_fraction=float(1 - valid.mean()))
    if not valid.any():
        return {**result, "status": "no_valid_depth"}
    difference_mm = (measured[valid] - expected[valid]) * 1000
    return {**result, "status": "comparison_available",
            "median_signed_error_mm": float(np.median(difference_mm)),
            "absolute_error_mm": stats(np.abs(difference_mm)),
            "absolute_relative_error": stats(np.abs(difference_mm / 1000) / expected[valid]),
            "expected_z_m": stats(expected[valid])}


def motion_comparison(first_camera_world, camera_world, first_board_camera, board_camera):
    """Compare camera motion with a fixed board; arbitrary world gauge cancels."""
    observed = np.linalg.inv(first_camera_world) @ camera_world
    reference = first_board_camera @ np.linalg.inv(board_camera)
    error = np.linalg.inv(reference) @ observed
    board_drift = np.linalg.inv(first_camera_world @ first_board_camera) @ (camera_world @ board_camera)
    return {"relative_camera_translation_error_m": float(np.linalg.norm(error[:3, 3])),
            "relative_camera_rotation_error_deg": rotation_deg(error[:3, :3]),
            "board_world_translation_drift_m": float(np.linalg.norm(board_drift[:3, 3])),
            "reference_camera_translation_m": float(np.linalg.norm(reference[:3, 3]))}


def audit_capture(source, output, *, measured_square_mm=None, static_board=False, stride=5):
    from capture_geometry import GeometrySession, SUPPORTED_VERSIONS

    if stride < 1:
        raise ValueError("Frame stride must be positive")
    # Reject invalid captures before creating a result directory.
    session = GeometrySession(source)
    if session.version not in SUPPORTED_VERSIONS:
        raise ValueError("Target audit requires a versioned capture with recorded acquisition association")
    output.mkdir(parents=True, exist_ok=False)
    before = sha(source)
    reference = board(NOMINAL_SQUARE_MM if measured_square_mm is None else measured_square_mm)
    records, first_reference, first_camera, annotated = [], None, None, 0
    for frame in session.frames():
        if frame.index % stride:
            continue
        gray = cv2.cvtColor(frame.rgb, cv2.COLOR_RGB2GRAY)
        estimate, camera_from_board, pixels = estimate_board(gray, frame.rgb_K, reference)
        row = {"frame_index": frame.index,
               "frame_timestamp_ns": frame.geometry["source"].get("frame_timestamp_ns"),
               "rgb_timestamp_ns": frame.geometry["source"].get("rgb_timestamp_ns"),
               "depth_timestamp_ns": frame.geometry["source"].get("depth_timestamp_ns"),
               "board": estimate}
        if camera_from_board is not None:
            if frame.depth is not None and frame.geometry.get("depth_registered"):
                row["depth"] = depth_comparison(frame.depth, frame.depth_K,
                    frame.geometry["rgb_to_depth"], pixels, camera_from_board)
            if static_board and frame.camera_pose is not None:
                world_camera = transform(frame.camera_pose.rotation @ session.R_optical_to_link,
                                         frame.camera_pose.translation)
                if first_reference is None:
                    first_reference, first_camera = camera_from_board, world_camera
                    row["motion_reference_frame"] = True
                else:
                    row["motion"] = motion_comparison(first_camera, world_camera, first_reference, camera_from_board)
            if annotated < 6:
                image = cv2.cvtColor(frame.rgb, cv2.COLOR_RGB2BGR)
                for x, y in pixels:
                    cv2.circle(image, (int(round(x)), int(round(y))), 4, (0, 220, 0), 1)
                cv2.imwrite(str(output / f"detected-{frame.index:06d}.jpg"), image)
                annotated += 1
        records.append(row)
    summary = {"sampled_frames": len(records),
        "usable_board_frames": sum(row["board"]["pose_usable"] for row in records),
        "board_reasons": dict(Counter(row["board"]["reason"] for row in records)),
        "per_frame_median_absolute_depth_error_mm": stats([row["depth"]["absolute_error_mm"]["median"]
            for row in records if row.get("depth", {}).get("status") == "comparison_available"]),
        "relative_camera_translation_error_m": stats([row["motion"]["relative_camera_translation_error_m"]
            for row in records if "motion" in row]),
        "relative_camera_rotation_error_deg": stats([row["motion"]["relative_camera_rotation_error_deg"]
            for row in records if "motion" in row])}
    after = sha(source)
    if before != after:
        raise RuntimeError("Raw source was modified")
    result = {"schema": "printed_target_evidence_v1", "source_sha256": before,
        "source_unchanged": True, "script_sha256": sha(__file__),
        "capture_geometry_version": session.version, "opencv_version": cv2.__version__,
        "reference_square_mm": NOMINAL_SQUARE_MM if measured_square_mm is None else measured_square_mm,
        "print_scale_user_measured": measured_square_mm is not None,
        "board_static_user_asserted": static_board, "stride": stride,
        "reference_filters": {"min_corners": 12, "max_reprojection_rms_px": 1.5,
                              "min_planar_solution_margin_px": .25,
                              "depth_mask_erosion_pixels": 2},
        "status": "reference_comparisons_available" if summary["usable_board_frames"] else "insufficient_reference_evidence",
        "metric_accuracy_validated": False, "frontier_lab_training_qualified": False,
        "cross_stream_clock_verified": False, "summary": summary,
        "limitations": ["The reference shares recorded K; intrinsic/distortion accuracy is not independently proven.",
            "Unprovided distortion coefficients are not measured zero distortion.",
            "Print scale, flatness, corner localization and planar ambiguity affect the reference.",
            "Motion comparison requires a stationary board; motion can expose timing errors without certifying clocks.",
            "Depth pixels and joints are not independently validated by passing metadata checks.",
            "PnP thresholds are engineering reference filters, not a buyer acceptance standard."],
        "frames": records}
    (output / "audit.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    target = subparsers.add_parser("target", help="Generate fixed-size printable A4 reference")
    target.add_argument("--output", type=Path, required=True)
    audit = subparsers.add_parser("audit", help="Read a versioned MCAP without changing it")
    audit.add_argument("mcap", type=Path)
    audit.add_argument("--output", type=Path, required=True)
    audit.add_argument("--measured-square-mm", type=float)
    audit.add_argument("--static-board", action="store_true")
    audit.add_argument("--stride", type=int, default=5)
    args = parser.parse_args()
    if args.command == "target":
        result = generate_target(args.output)
    else:
        result = audit_capture(args.mcap, args.output, measured_square_mm=args.measured_square_mm,
                               static_board=args.static_board, stride=args.stride)
    print(json.dumps(result.get("summary", result), indent=2))


if __name__ == "__main__":
    main()
