#!/usr/bin/env python3
"""Measure fixed crop fallback coverage on unchanged raw RGB recordings.

Each crop increases the hand's relative detector input size. Full-frame misses
trigger three overlapping half-width views. Counts are detector coverage, not
recall or 3D accuracy. Crop outputs retain their exact native-pixel mapping and
are diagnostics only, never accepted training labels.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np

from capture_geometry import GeometrySession
from hand_geometry import detect_observations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mcap", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frames", type=int, nargs="+", help="Optional fixed frame subset")
    parser.add_argument("--rotate-180", action="store_true", help="Model input only; outputs mapped back to native coordinates")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Use a fresh output path")
    from stera.models import HandTracker
    from stera.models.mediapipe import tracker as mp_tracker
    mp_tracker._MODEL_CACHE = str(args.model.resolve(strict=True))
    tracker = HandTracker(model="mediapipe")
    session = GeometrySession(args.mcap)
    selected = None if args.frames is None else set(args.frames)
    rows = []
    start = time.monotonic()
    try:
        for frame in session.frames():
            if selected is not None and frame.index not in selected:
                continue
            native = frame.rgb
            image = np.ascontiguousarray(np.rot90(native, 2)) if args.rotate_180 else native
            h, w = image.shape[:2]
            views = [("full", 0, w)]
            regions = []
            full_detected = False
            while views:
                name, left, right = views.pop(0)
                crop = np.ascontiguousarray(image[:, left:right])
                observations = detect_observations(tracker._backend, crop, deduplicate_by_side=False)
                hands = []
                for ob in observations:
                    uv = ob["landmarks_rgb_px"] + [left, 0]
                    shape = ob["relative_joints_m"]
                    if args.rotate_180:
                        uv = [w-1, h-1]-uv
                        shape = shape*[-1, -1, 1]
                    hands.append({"side": ob["hand_side"], "handedness_score": ob["handedness_score"],
                                  "native_landmarks_px": uv.tolist(), "relative_joints_m": shape.tolist()})
                regions.append({"name": name, "model_input_roi_xyxy": [left, 0, right, h], "hands": hands})
                if name == "full":
                    full_detected = bool(hands)
                    if not full_detected:
                        views.extend([("left", 0, w//2), ("middle", w//4, w//4+w//2), ("right", w//2, w)])
            rows.append({"frame_index": frame.index, "full_frame_detected": full_detected,
                         "any_view_detected": any(r["hands"] for r in regions), "regions": regions})
            if frame.index % 30 == 0:
                print(f"frame {frame.index}/{session.num_rgb_frames}", flush=True)
    finally:
        tracker._backend.close()
    report = {
        "raw_mcap_sha256": hashlib.sha256(args.mcap.read_bytes()).hexdigest(),
        "model_sha256": hashlib.sha256(args.model.read_bytes()).hexdigest(),
        "model_input_rotation_ccw": 2 if args.rotate_180 else 0,
        "frames": rows,
        "summary": {"frames_examined": len(rows),
                    "full_frame_detected": sum(r["full_frame_detected"] for r in rows),
                    "with_fixed_crop_fallback_detected": sum(r["any_view_detected"] for r in rows),
                    "recovered_frame_indices": [r["frame_index"] for r in rows if r["any_view_detected"] and not r["full_frame_detected"]],
                    "model_calls": sum(len(r["regions"]) for r in rows),
                    "wall_seconds": time.monotonic()-start},
        "limits": ["Detection coverage is not recall; no full-clip manual hand-presence annotation exists.",
                   "Multiple crop observations may describe one hand; no multi-hand identity claim.",
                   "Hidden joints, 3D geometry, scale, temporal continuity and false positives are not validated.",
                   "Coordinates map to untouched native raster; raw recording and training pipeline unchanged."],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report["summary"], indent=2), flush=True)


if __name__ == "__main__":
    main()
