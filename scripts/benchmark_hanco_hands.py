#!/usr/bin/env python3
"""Compare hand estimates to external HanCo calibrated reference annotations.

HanCo is research-only. Its joint annotations derive from MANO fits, not direct
joint measurements; default selection requires the publisher's is_valid flag.
This is a diagnostic reference benchmark, not a commercial training dataset or
proof of performance on Pixel recordings. No alignment to reference pose/scale
is performed. The oracle-depth baseline is explicitly privileged with reference
wrist depth; its root-relative error does not depend on this privilege.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from hand_geometry import detect_observations, fit_perspective_camera, project_points


def summarize(rows):
    result = {"images": len(rows), "detected_images": sum(r["detected"] for r in rows)}
    for key in ("landmark_error_mean_px", "raw_relative_mpjpe_mm",
                "perspective_relative_mpjpe_mm", "perspective_absolute_mpjpe_mm",
                "perspective_wrist_error_mm", "oracle_depth_absolute_mpjpe_mm",
                "rotated_oracle_depth_absolute_mpjpe_mm", "scaled_oracle_depth_absolute_mpjpe_mm",
                "scaled_oracle_depth_relative_mpjpe_mm"):
        values = [r[key] for r in rows if r.get(key) is not None]
        result[key] = None if not values else {
            "mean": float(np.mean(values)), "median": float(np.median(values)),
            "p90": float(np.quantile(values, .9)), "count": len(values),
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="HanCo root containing rgb/, xyz/, calib/, meta.json")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stride", type=int, default=1, help="Deterministic timestep stride, applied before camera expansion")
    parser.add_argument("--include-unvalidated", action="store_true")
    args = parser.parse_args()
    if args.stride < 1:
        parser.error("stride must be positive")
    if args.output.exists():
        parser.error("Use a fresh output directory")
    metadata = json.loads((args.dataset / "meta.json").read_text())
    from stera.models import HandTracker
    from stera.models.mediapipe import tracker as mp_tracker
    mp_tracker._MODEL_CACHE = str(args.model.resolve(strict=True))
    tracker = HandTracker(model="mediapipe")
    rows = []
    args.output.mkdir(parents=True)
    annotation_units_checked = []
    try:
        for xyz_file in sorted((args.dataset / "xyz").glob("*/*.json")):
            sequence, frame = int(xyz_file.parent.name), int(xyz_file.stem)
            if frame % args.stride:
                continue
            valid = bool(metadata["is_valid"][sequence][frame])
            if not metadata["has_fit"][sequence][frame] or (not valid and not args.include_unvalidated):
                continue
            xyz = np.asarray(json.loads(xyz_file.read_text()), dtype=float)
            calibration = json.loads((args.dataset / "calib" / xyz_file.parent.name / xyz_file.name).read_text())
            bone = np.linalg.norm(xyz[9] - xyz[10])
            if xyz.shape != (21, 3) or not np.isfinite(xyz).all() or not .005 < bone < .1:
                raise ValueError("Unexpected joint layout/units; inspect source before benchmarking")
            annotation_units_checked.append(float(bone))
            for camera in range(8):
                image_file = args.dataset / "rgb" / xyz_file.parent.name / f"cam{camera}" / (xyz_file.stem + ".jpg")
                if not image_file.exists():
                    continue
                rgb = cv2.cvtColor(cv2.imread(str(image_file)), cv2.COLOR_BGR2RGB)
                K = np.asarray(calibration["K"][camera], dtype=float)
                M = np.asarray(calibration["M"][camera], dtype=float)
                reference = xyz @ M[:3, :3].T + M[:3, 3]
                reference_uv = project_points(reference, K)
                if np.any(reference[:, 2] <= 0):
                    raise ValueError("Reference camera convention invalid")
                # Independent geometry control: recovering the reference shape
                # from reference image coordinates must recover camera XYZ.
                control = fit_perspective_camera(reference - reference[:1], reference_uv, K)
                if control is None or np.max(np.linalg.norm(control["candidate_joints_m"] - reference, axis=1)) > 1e-5:
                    raise RuntimeError("Known-camera recovery control failed")
                observations = detect_observations(tracker._backend, rgb, deduplicate_by_side=False)
                row = {"image": str(image_file.relative_to(args.dataset)), "reference_manually_validated": valid,
                       "detected": bool(observations), "detections": len(observations),
                       "reference_bone_m": float(bone)}
                if observations:
                    # One reference hand per image. GT is used for evaluation
                    # assignment only, never for inference or perspective fit.
                    ob = min(observations, key=lambda item: np.mean(np.linalg.norm(item["landmarks_rgb_px"]-reference_uv, axis=1)))
                    shape, uv = ob["relative_joints_m"], ob["landmarks_rgb_px"]
                    gt_relative = reference - reference[:1]
                    ray = np.linalg.solve(K, np.r_[uv[0], 1.])
                    oracle_depth = shape + ray * reference[0, 2] / ray[2]
                    fit = fit_perspective_camera(shape, uv, K)
                    row.update({"hand_side": ob["hand_side"],
                        "landmark_error_mean_px": float(np.linalg.norm(uv-reference_uv, axis=1).mean()),
                        "raw_relative_mpjpe_mm": float(np.linalg.norm(shape-gt_relative, axis=1).mean()*1000),
                        "oracle_depth_absolute_mpjpe_mm": float(np.linalg.norm(oracle_depth-reference, axis=1).mean()*1000)})
                    if fit is not None:
                        points = fit["candidate_joints_m"]
                        # Oracle controls isolate camera rotation from the
                        # learned metric-scale ambiguity. Both use true wrist Z
                        # unavailable at inference; neither is a deployable fix.
                        rotated_oracle = points-points[:1] + ray*reference[0, 2]/ray[2]
                        scale = float(reference[0, 2]/points[0, 2])
                        scaled_oracle = points*scale
                        row.update({
                            "perspective_relative_mpjpe_mm": float(np.linalg.norm(points-points[:1]-gt_relative, axis=1).mean()*1000),
                            "perspective_absolute_mpjpe_mm": float(np.linalg.norm(points-reference, axis=1).mean()*1000),
                            "perspective_wrist_error_mm": float(np.linalg.norm(points[0]-reference[0])*1000),
                            "rotated_oracle_depth_absolute_mpjpe_mm": float(np.linalg.norm(rotated_oracle-reference, axis=1).mean()*1000),
                            "scaled_oracle_depth_absolute_mpjpe_mm": float(np.linalg.norm(scaled_oracle-reference, axis=1).mean()*1000),
                            "scaled_oracle_depth_relative_mpjpe_mm": float(np.linalg.norm(scaled_oracle-scaled_oracle[:1]-gt_relative, axis=1).mean()*1000),
                            "oracle_depth_scale": scale,
                        })
                    if len(rows) < 12:
                        overlay = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
                        for points, color in ((reference_uv, (0, 255, 0)), (uv, (0, 165, 255))):
                            for x, y in points:
                                cv2.circle(overlay, (round(x), round(y)), 2, color, -1)
                        cv2.imwrite(str(args.output / f"{sequence:04d}_{frame:08d}_cam{camera}.jpg"), overlay)
                rows.append(row)
            if frame % 10 == 0:
                print(f"frame {sequence}/{frame}: {len(rows)} reference images", flush=True)
    finally:
        tracker._backend.close()
    if not rows:
        raise RuntimeError("No matching reference images; inspect metadata/selection")
    report = {
        "source": "https://lmbweb.informatik.uni-freiburg.de/resources/datasets/HanCo.en.html",
        "model_sha256": hashlib.sha256(args.model.read_bytes()).hexdigest(),
        "reference": "Publisher's MANO-derived joint fits and per-frame K/M; is_valid means manually validated fit",
        "protocol": "No Procrustes, rotation, scale, or root alignment to reference; report absolute and wrist-relative errors separately. Detection misses remain counted. GT only assigns one predicted hand to one reference hand.",
        "selection": {"stride": args.stride, "include_unvalidated": args.include_unvalidated},
        "unit_check": {"reference_middle_finger_proximal_bone_median_m": float(np.median(annotation_units_checked))},
        "summary": summarize(rows),
        "manually_validated_summary": summarize([r for r in rows if r["reference_manually_validated"]]),
        "images": rows,
        "limits": ["Research-only dataset; no images or annotations redistributed by this repository.",
                   "One sequence is not representative of egocentric Pixel hand-object interaction.",
                   "Reference annotations are fitted models, not measured anatomical joint ground truth.",
                   "Oracle-depth baseline uses reference wrist Z and is an optimistic diagnostic baseline."],
    }
    (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
