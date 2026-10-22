#!/usr/bin/env python3
"""Independent HanCo reference check after sequential VIDEO-mode inference.

Replay every image of sequence 0110 separately for each camera at the published
5 Hz rate. Score only publisher manually validated reference fits. No pose/scale
alignment to the reference, no training, and no sharing state across cameras.
"""
import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from hand_geometry import detect_observations, fit_perspective_camera, project_points, use_video_mode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Use a fresh output path")
    from stera.models import HandTracker
    from stera.models.mediapipe import tracker as mp_tracker
    mp_tracker._MODEL_CACHE = str(args.model.resolve(strict=True))
    metadata = json.loads((args.dataset/"meta.json").read_text())
    rows = []
    for camera in range(8):
        tracker = HandTracker(model="mediapipe")
        use_video_mode(tracker._backend, args.model)
        try:
            for image_path in sorted((args.dataset/f"rgb/0110/cam{camera}").glob("*.jpg")):
                frame = int(image_path.stem)
                rgb = cv2.cvtColor(cv2.imread(str(image_path)), cv2.COLOR_BGR2RGB)
                observations = detect_observations(tracker._backend, rgb,
                    timestamp_ms=frame*200, deduplicate_by_side=False)
                if not metadata["is_valid"][110][frame]:
                    continue
                calibration = json.loads((args.dataset/f"calib/0110/{frame:08d}.json").read_text())
                K, M = np.array(calibration["K"][camera]), np.array(calibration["M"][camera])
                xyz = np.array(json.loads((args.dataset/f"xyz/0110/{frame:08d}.json").read_text()))
                reference = xyz@M[:3, :3].T + M[:3, 3]
                pixels = project_points(reference, K)
                relative = reference-reference[:1]
                row = {"frame": frame, "camera": camera, "detected": bool(observations)}
                if observations:
                    ob = min(observations, key=lambda o: np.linalg.norm(o["landmarks_rgb_px"]-pixels, axis=1).mean())
                    uv, shape = ob["landmarks_rgb_px"], ob["relative_joints_m"]
                    fit = fit_perspective_camera(shape, uv, K)
                    row.update({"mean_uv_error_px": float(np.linalg.norm(uv-pixels, axis=1).mean()),
                                "raw_root_relative_mpjpe_mm": float(np.linalg.norm(shape-relative, axis=1).mean()*1000)})
                    if fit is not None:
                        points = fit["candidate_joints_m"]
                        row["pnp_root_relative_mpjpe_mm"] = float(np.linalg.norm(points-points[:1]-relative, axis=1).mean()*1000)
                rows.append(row)
        finally:
            tracker._backend.close()
        print(f"camera {camera}", flush=True)
    if len(rows) != 24:
        raise RuntimeError("Expected 24 manually reviewed reference views in the official tester")
    summary = {"images": len(rows), "detected": sum(r["detected"] for r in rows)}
    for key in ("mean_uv_error_px", "raw_root_relative_mpjpe_mm", "pnp_root_relative_mpjpe_mm"):
        values = [r[key] for r in rows if r.get(key) is not None]
        summary[key] = None if not values else {"mean": float(np.mean(values)), "median": float(np.median(values))}
    report = {"summary": summary, "images": rows,
              "model_sha256": hashlib.sha256(args.model.read_bytes()).hexdigest(),
              "protocol": "Replay all 67 frames per camera at published 5Hz, evaluate only 3 manually validated timesteps, independent tracker per camera; same 0.3 thresholds/model as image mode.",
              "limits": "24 correlated views, single performer, MANO-fitted reference, no Pixel metric accuracy claim; model training overlap unknown."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
