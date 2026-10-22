#!/usr/bin/env python3
"""Summarize fitted consistency, depth contradiction and temporal diagnostics.

Reads cached raw model outputs; does not rerun inference or use these values as
ground truth. A ray-lift counterfactual demonstrates why matching the image
alone is insufficient: it changes the model's metric bone lengths.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

EDGES = [(0, start) for start in (1, 5, 9, 13, 17)] + [
    (start+j, start+j+1) for start in (1, 5, 9, 13, 17) for j in range(3)]


def describe(values):
    values = np.asarray(values, float)
    values = values[np.isfinite(values)]
    return {"n": int(len(values)), **({} if not len(values) else {
        "median": float(np.median(values)), "p90": float(np.quantile(values, .9)),
        "max": float(np.max(values))})}


def summarize(path):
    data = json.loads(path.read_text())
    output = {"raw_mcap": data["raw_mcap"], "raw_sha256": data["raw_sha256"],
              "cached_predictions_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
              "orientation_comparison": data["summary"]}
    records = [r for r in data["observations"] if r["quarter_turns_ccw"] == 0]
    wrist_depth_error, ray_bones, fit_bones = [], [], []
    wrist_steps, baseline_steps, rotation_steps, adjacent_frames = [], [], [], []
    previous = {}
    for r in records:
        model, pixels, K = (np.asarray(r[key], float) for key in ("shape", "pixels", "rgb_K"))
        if r["pnp_candidate_m"] is None:
            continue
        candidate = np.asarray(r["pnp_candidate_m"], float)
        rays = np.linalg.solve(K, np.column_stack([pixels, np.ones(21)]).T).T
        rays /= rays[:, 2:3]
        lifted = None if r["baseline_wrist_z_m"] is None else rays*(r["baseline_wrist_z_m"]+model[:, 2:3])
        for a, b in EDGES:
            original = np.linalg.norm(model[a]-model[b])
            if original > 1e-6:
                fit_bones.append(np.linalg.norm(candidate[a]-candidate[b])/original)
                if lifted is not None:
                    ray_bones.append(np.linalg.norm(lifted[a]-lifted[b])/original)
        wrist_surface = r["palm_depth_samples"][0]
        if wrist_surface:
            wrist_depth_error.append(abs(wrist_surface["depth_m"]-candidate[0, 2]))
        rotation = np.asarray(r["pnp_rotation"], float)
        side = r["side"]
        old = previous.get(side)
        if old is not None and r["frame_index"]-old["frame"] == 1:
            wrist_steps.append(float(np.linalg.norm(candidate[0]-old["wrist"])))
            relative = rotation @ old["rotation"].T
            rotation_steps.append(float(np.linalg.norm(cv2.Rodrigues(relative)[0])*180/np.pi))
            adjacent_frames.append([old["frame"], r["frame_index"]])
            if lifted is not None and old["baseline_wrist"] is not None:
                baseline_steps.append(float(np.linalg.norm(lifted[0]-old["baseline_wrist"])))
        previous[side] = {"frame": r["frame_index"], "wrist": candidate[0],
                          "baseline_wrist": None if lifted is None else lifted[0], "rotation": rotation}
    output.update({"wrist_vs_native_surface_depth_abs_error_m": describe(wrist_depth_error),
                   "fitted_bone_length_divided_by_raw_model_bone": describe(fit_bones),
                   "ray_lift_bone_length_divided_by_raw_model_bone": describe(ray_bones),
                   "adjacent_detected_frame_pair_count": len(adjacent_frames),
                   "estimated_wrist_step_m": describe(wrist_steps),
                   "baseline_depth_anchored_wrist_step_m": describe(baseline_steps),
                   "camera_correction_rotation_step_degrees": describe(rotation_steps)})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("predictions", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = {"schema": "hand_camera_recovery_diagnostics_v1",
              "accuracy_claim": "No real-hand anatomical ground truth; these scores measure internal consistency, independent sensor disagreement, or temporal stability.",
              "ray_lift_counterfactual": "Keep model relative Z, use ARCore-depth wrist anchor, compute calibrated X/Y on every predicted 2D ray. Zero fitted projection error follows by construction; bone-length distortion is reported rather than calling it accuracy.",
              "temporal_semantics": "Only consecutive detected image-frame indices, no interpolation across missed detections. Wrist steps are stability diagnostics, not errors; actual hand motion is unknown.",
              "captures": [summarize(p) for p in args.predictions]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
