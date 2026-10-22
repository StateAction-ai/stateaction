#!/usr/bin/env python3
"""Reproducible hand-model orientation and camera-fit ablation on raw MCAP.

Reprojection scores compare two predictions of the same model. They are an
internal consistency diagnostic, never independent anatomical accuracy.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import time

import numpy as np

from capture_geometry import GeometrySession
from hand_geometry import (detect_observations, reconstruct_hand,
                           fit_perspective_camera)


def perspective_fit(shape, pixels, K, fit_indices=None):
    """Calibrated rigid PnP; no depth or free scale used by this diagnostic."""
    result = fit_perspective_camera(shape, pixels, K, fit_indices=fit_indices)
    if result is None:
        return None
    return {"points": result["candidate_joints_m"], "rotation": result["rotation"],
            "translation": result["translation_m"], "residual": result["reprojection_error_px"]}


def native_observation(ob, width, height, turns):
    """Map 180-degree model input back to the unchanged native camera raster."""
    if turns == 0:
        return ob
    out = dict(ob)
    out["landmarks_rgb_px"] = [width-1, height-1]-ob["landmarks_rgb_px"]
    out["relative_joints_m"] = ob["relative_joints_m"] * [-1, -1, 1]
    # Preserve originals explicitly: these two raw arrays describe model input.
    out["model_input_quarter_turns_ccw"] = turns
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mcap", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stride", type=int, default=1)
    args = parser.parse_args()
    from stera.models.mediapipe import tracker as mp_tracker
    from stera.models import HandTracker
    model = args.mcap.parent / "stera_processed_geometry_v3/models/hand_landmarker.task"
    if model.exists():
        mp_tracker._MODEL_CACHE = str(model)
    tracker = HandTracker(model="mediapipe")
    session = GeometrySession(args.mcap)
    records = []
    started = time.monotonic()
    try:
        for frame in session.frames():
            if frame.index % args.stride:
                continue
            for turns in (0, 2):
                model_rgb = np.ascontiguousarray(np.rot90(frame.rgb, turns))
                for raw_ob in detect_observations(tracker._backend, model_rgb,
                                                  deduplicate_by_side=False):
                    ob = native_observation(raw_ob, frame.rgb.shape[1], frame.rgb.shape[0], turns)
                    result = reconstruct_hand(ob["relative_joints_m"], ob["landmarks_rgb_px"],
                        frame.depth.astype(float)/1000, frame.rgb_K,
                        rgb_size_wh=frame.rgb.shape[1::-1], rgb_to_depth=frame.geometry["rgb_to_depth"],
                        calibration_verified=frame.geometry["calibration_contract_verified"],
                        depth_registered=frame.geometry["depth_registered"],
                        depth_time_verified=frame.geometry["depth_time_verified"])
                    fit = perspective_fit(ob["relative_joints_m"], ob["landmarks_rgb_px"], frame.rgb_K)
                    # Fit palm+wrist only and evaluate the remaining 16 predicted
                    # finger landmarks. Disjoint joints reduce direct fitting
                    # leakage; both are still predictions of the SAME model.
                    heldout_fit = perspective_fit(ob["relative_joints_m"], ob["landmarks_rgb_px"], frame.rgb_K,
                                                  [0, 5, 9, 13, 17])
                    heldout = [i for i in range(21) if i not in (0, 5, 9, 13, 17)]
                    q = result["quality"]
                    records.append({"frame_index": frame.index, "quarter_turns_ccw": turns,
                        "side": ob["hand_side"], "handedness_score": ob["handedness_score"],
                        "pixels": ob["landmarks_rgb_px"].tolist(), "shape": ob["relative_joints_m"].tolist(),
                        "raw_model_image_landmarks": raw_ob["raw_image_landmarks_normalized"].tolist(),
                        "raw_model_world_landmarks": raw_ob["raw_world_landmarks_m"].tolist(),
                        "rgb_K": frame.rgb_K.tolist(),
                        "baseline_median_px": q["nonwrist_reprojection_median_px"],
                        "baseline_p90_px": q["nonwrist_reprojection_p90_px"],
                        "baseline_wrist_z_m": q["wrist_depth_m"],
                        "palm_depth_samples": [q["depth_samples"][j] for j in (0, 5, 9, 13, 17)],
                        "pnp_median_px": None if fit is None else float(np.median(fit["residual"][1:])),
                        "pnp_wrist_z_m": None if fit is None else float(fit["points"][0, 2]),
                        "pnp_rotation": None if fit is None else fit["rotation"].tolist(),
                        "pnp_candidate_m": None if fit is None else fit["points"].tolist(),
                        "palm_fit_finger_heldout_median_px": None if heldout_fit is None else float(np.median(heldout_fit["residual"][heldout]))})
            if frame.index % 30 == 0:
                print(f"frame {frame.index}/{session.num_rgb_frames}, {len(records)} observations", flush=True)
    finally:
        tracker._backend.close()
    summary = {}
    for turns in (0, 2):
        group = [r for r in records if r["quarter_turns_ccw"] == turns]
        metrics = {"detected_observations": len(group),
                   "frames_detected": len({r["frame_index"] for r in group})}
        for key in ("baseline_median_px", "pnp_median_px", "pnp_wrist_z_m", "baseline_wrist_z_m", "palm_fit_finger_heldout_median_px"):
            values = [r[key] for r in group if r[key] is not None]
            metrics[key] = None if not values else float(np.median(values))
        summary[str(turns)] = metrics
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"raw_mcap": str(args.mcap),
        "raw_sha256": hashlib.sha256(args.mcap.read_bytes()).hexdigest(),
        "model_sha256": hashlib.sha256(Path(mp_tracker._MODEL_CACHE).read_bytes()).hexdigest(),
        "source_hashes": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in
                          [Path(__file__), Path(__file__).with_name("hand_geometry.py")]},
        "runtime": {name: importlib.metadata.version(name) for name in ("mediapipe", "numpy", "opencv-contrib-python")},
        "summary": summary, "wall_seconds": time.monotonic()-started,
        "score_semantics": "same-model prediction consistency, not independent ground truth", "observations": records}, indent=2))
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
