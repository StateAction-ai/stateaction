#!/usr/bin/env python3
"""Replay hash-checked offline WiLoR predictions with actual capture geometry.

Run with .venv-stera. No model dependency or recorder change is required. Every
prediction must match its exact decoded MCAP frame. Duplicates remain separate;
visibility is unknown and all training hand masks remain false.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path

os.environ.setdefault("RERUN_ANALYTICS_ENABLED", "false")
os.environ.setdefault("MPLBACKEND", "Agg")

import cv2
import h5py
import numpy as np
import rerun as rr

from capture_geometry import GeometrySession
from geometry_visualizer import GeometryVisualizer, HAND_EDGES
from hand_geometry import reconstruct_perspective_hand
from process_capture import ROOT, SDK_COMMIT, adapt_rerun_022, command, seal_rerun_recording, sha256, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mcap", type=Path)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--benchmark-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--display-rotate180", action="store_true", help="Rotate only the two 2D RGB views and their overlays; preserve native geometry")
    args = parser.parse_args()
    raw = args.mcap.resolve(strict=True)
    if args.output.exists():
        parser.error("Use a fresh output directory")
    benchmark = json.loads(args.benchmark_report.read_text())
    if sha256(args.predictions) != benchmark["raw_predictions_sha256"]:
        raise RuntimeError("Predictions differ from the benchmark receipt")
    if command(["git", "rev-parse", "HEAD"], ROOT/"stera-sdk") != SDK_COMMIT or command(["git", "diff", "HEAD", "--", "src"], ROOT/"stera-sdk"):
        raise RuntimeError("Replay requires the audited, unchanged SDK")
    rows = [row for row in json.loads(args.predictions.read_text()) if row["dataset"] == raw.parent.name]
    by_frame = {row["frame_index"]: row for row in rows}
    session = GeometrySession(raw)
    if len(by_frame) != len(rows) or set(by_frame) != set(range(session.num_rgb_frames)):
        raise RuntimeError("Predictions must cover every recording frame exactly once, including misses")
    args.output.mkdir(parents=True)
    episode = args.output/"episode"
    episode.mkdir()
    receipt = {"status": "running", "raw_mcap_sha256_before": sha256(raw),
               "source_predictions_sha256": sha256(args.predictions), "benchmark_report_sha256": sha256(args.benchmark_report),
               "hand_source": "Standalone official WiLoR research model; not the exact SDK WiLoR wrapper",
               "sdk_commit": SDK_COMMIT, "display_rotate180": args.display_rotate180,
               "display_rotation_changes_camera_geometry": False, "training_qualified_hands": 0,
               "visibility": "unknown", "candidate_camera": "measured-K PnP of model shape and its own predicted2D; learned metric scale",
               "camera_fit_protocol": "Replay uses the existing quality helper and only predicted joints inside the actual RGB bounds. Benchmark reports all21. Differences for cropped/outside-image guesses are retained explicitly.",
               "model_assets": benchmark["model_assets"], "mano_asset_provenance": benchmark["mano_asset_provenance"]}
    write_json(args.output/"receipt.json", receipt)
    adapt_rerun_022(rr)
    observations, quality, offsets, timestamps, geometries = [], [], [0], [], []
    try:
        viz = GeometryVisualizer(session, output=str(episode/"visualization.rrd"))
        for frame in session.frames():
            row = by_frame[frame.index]
            image_file = raw.parent/"inspection/rgb_frames"/f"{frame.index:06d}.jpg"
            if sha256(image_file) != row["frame_sha256"]:
                raise RuntimeError(f"Source image hash mismatch at frame {frame.index}")
            expected_rgb = cv2.cvtColor(cv2.imread(str(image_file)), cv2.COLOR_BGR2RGB)
            if not np.array_equal(frame.rgb, expected_rgb):
                raise RuntimeError(f"Decoded MCAP/frame identity mismatch at frame {frame.index}")
            geometry = frame.geometry
            # GeometryVisualizer logs the native camera/depth and temporal pose;
            # the optional RGB display rotation below never changes these data.
            viz.log_frame(frame, hands=[], skeleton=None, enable_pointcloud=False)
            if args.display_rotate180:
                rgb_view = frame.rgb[::-1, ::-1].copy()
                rr.log("camera/rgb", rr.Image(rgb_view).compress(jpeg_quality=80))
                rr.log("camera/rgb_overlay", rr.Image(rgb_view).compress(jpeg_quality=80))
            rr.log("camera/rgb_overlay/wilor", rr.Clear(recursive=True))
            rr.log("world/wilor", rr.Clear(recursive=True))
            frame_quality = []
            for index, ob in enumerate(row["predictions"]):
                uv = np.asarray(ob["landmarks_rgb_px"], dtype=float)
                shape = np.asarray(ob["relative_joints_m"], dtype=float)
                result = reconstruct_perspective_hand(shape, uv,
                    np.zeros((1, 1)) if frame.depth is None else frame.depth.astype(float)/1000,
                    frame.rgb_K, rgb_size_wh=frame.rgb.shape[1::-1], rgb_to_depth=geometry["rgb_to_depth"],
                    calibration_verified=geometry["calibration_contract_verified"],
                    depth_registered=geometry["depth_registered"], depth_time_verified=geometry["depth_time_verified"],
                    handedness_score=float("nan"), provenance={"model": "wilor_research", "frame_index": frame.index,
                        "observation_index": index, "bbox_confidence": ob["bbox_confidence"]})
                if result["quality"]["fully_observed_consistent"] or np.isfinite(result["supported_joints_m"]).any():
                    raise RuntimeError("Unknown visibility must not produce accepted training joints")
                candidate = result["candidate_joints_m"]
                inside = (uv >= 0).all(axis=1) & (uv < np.asarray(frame.rgb.shape[1::-1])).all(axis=1)
                if "calibrated_pnp_joints_m" in ob and inside.all() and not np.allclose(candidate, ob["calibrated_pnp_joints_m"], atol=1e-5):
                    raise RuntimeError(f"Identical in-image camera solve disagrees with benchmark at frame {frame.index}")
                points = uv.copy()
                if args.display_rotate180:
                    points = np.array(frame.rgb.shape[1::-1])-1-points
                path = f"camera/rgb_overlay/wilor/{index}_{ob['side']}"
                color = [255, 150, 40]
                rr.log(path+"/joints", rr.Points2D(points, colors=[color], radii=2.5))
                rr.log(path+"/bones", rr.LineStrips2D([[points[a], points[b]] for a, b in HAND_EDGES], colors=[color], radii=1.2))
                if frame.camera_pose is not None and np.isfinite(candidate).all():
                    world = candidate @ session.R_optical_to_link.T @ frame.camera_pose.rotation.T + frame.camera_pose.translation
                    path3d = f"world/wilor/{index}_{ob['side']}"
                    rr.log(path3d+"/bones", rr.LineStrips3D([[world[a], world[b]] for a, b in HAND_EDGES], colors=[color], radii=.002))
                    rr.log(path3d+"/status", rr.Points3D(world[:1], labels=["WiLoR ESTIMATE; visibility unknown"], show_labels=True, colors=[color], radii=.003))
                observations.append({"frame_index": frame.index, "side": ob["side"], "bbox_confidence": ob["bbox_confidence"],
                    "relative_joints_m": shape, "image_landmarks_px": uv, "candidate_joints_m": candidate})
                audit = {"frame_index": frame.index, "observation_index": index, "side": ob["side"], **result["quality"]}
                audit["predicted_joints_outside_rgb"] = int((~inside).sum())
                audit["handedness_score"] = None  # detector bbox score does not supply this probability
                quality.append(audit)
                frame_quality.extend(result["quality"]["rejection_reasons"])
            rr.log("quality", rr.TextDocument(f"Frame {frame.index}; {len(row['predictions'])} WiLoR observations (duplicates retained).\n"
                f"2D RGB display rotated180: {args.display_rotate180}; camera/depth remain native.\n"
                "3D is a research estimate with learned scale; hidden fingers are unverified.\n"
                f"Independent depth/visibility audit: {', '.join(sorted(set(frame_quality))) or 'no hand detected'}.\n"
                "Training-qualified hands: 0. No body pose inferred."))
            offsets.append(len(observations)); timestamps.append(frame.timestamp); geometries.append(geometry)
            if (frame.index+1) % 50 == 0:
                print(f"Replayed {frame.index+1}/{session.num_rgb_frames}", flush=True)
        manifest = session.export(str(episode), visualizer=viz)
        write_json(args.output/"export_manifest.json", manifest)
        with h5py.File(episode/"annotation.hdf5", "a") as h5:
            estimates = h5.create_group("wilor-research-observations")
            estimates.attrs["coordinates"] = "native RGB pixels and OpenCV optical camera XYZ metres; learned-scale estimates, not ground truth"
            estimates.attrs["visibility"] = "unknown; bbox confidence is not joint visibility or pose accuracy"
            estimates.create_dataset("frame_offsets", data=offsets)
            estimates.create_dataset("frame_timestamps", data=timestamps)
            for key in ("frame_index", "bbox_confidence", "relative_joints_m", "image_landmarks_px", "candidate_joints_m"):
                estimates.create_dataset(key, data=np.asarray([ob[key] for ob in observations]))
            estimates.create_dataset("side", data=[ob["side"] for ob in observations], dtype=h5py.string_dtype("utf-8"))
            estimates.create_dataset("joint_visibility_known", data=np.zeros((len(observations), 21), dtype=bool))
            estimates.create_dataset("training_valid", data=np.zeros(len(observations), dtype=bool))
            h5.attrs["hand_estimates_metric_accuracy_validated"] = False
        failures = Counter(reason for row in quality for reason in row["rejection_reasons"])
        summary = {"frames": len(timestamps), "observations": len(observations),
                   "geometry_consistent_observations": sum(row["geometry_consistent"] for row in quality),
                   "training_qualified_observations": 0, "rejection_reasons": dict(failures)}
        write_json(args.output/"geometry_quality.json", {"summary": summary, "hands": quality})
        receipt["processing"] = summary
        receipt["status"] = "complete"
        print(json.dumps(summary, indent=2), flush=True)
    except Exception as error:
        receipt["status"] = "failed"; receipt["error"] = repr(error)
        raise
    finally:
        seal_rerun_recording(rr)
        receipt["raw_mcap_sha256_after"] = sha256(raw)
        receipt["raw_unchanged"] = receipt["raw_mcap_sha256_before"] == receipt["raw_mcap_sha256_after"]
        receipt["script_sha256"] = sha256(Path(__file__))
        receipt["artifacts"] = {str(p.relative_to(args.output)): {"bytes": p.stat().st_size, "sha256": sha256(p)}
                                for p in args.output.rglob("*") if p.is_file() and p.name != "receipt.json"}
        write_json(args.output/"receipt.json", receipt)
        if not receipt["raw_unchanged"]:
            raise RuntimeError("Raw capture was modified")


if __name__ == "__main__":
    main()
