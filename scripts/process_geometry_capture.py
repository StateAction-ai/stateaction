#!/usr/bin/env python3
"""Process versioned capture geometry and preserve hand evidence/quality masks.

Unknown calibration or visibility never becomes accepted 3D supervision.
An optional old-capture hypothesis creates a diagnostic replay, not a repair
certified against ground truth. Use .venv-stera/bin/python.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import shutil
import time

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("RERUN_ANALYTICS_ENABLED", "false")
os.environ.setdefault("MPLBACKEND", "Agg")

import h5py
import numpy as np
import rerun as rr

from capture_geometry import GeometrySession, VERSION, VERSION_V2, V3_PROVENANCE
from hand_geometry import detect_observations, reconstruct_hand
from geometry_visualizer import GeometryVisualizer
from geometry_report import write_geometry_report
from process_capture import ROOT, SDK_COMMIT, adapt_rerun_022, seal_rerun_recording, command, sha256, write_json
from report_clock import apply_report_clock


def write_geometry_annotations(path, observations, geometry, timestamps):
    """Extend SDK export without pretending its detection-valid flag is 3D QA."""
    count = len(geometry)
    with h5py.File(path, "a") as h5:
        cg = h5.create_group("capture-geometry")
        cg.attrs["metric_accuracy_validated"] = False
        for key in ("capture_geometry_version", *V3_PROVENANCE):
            cg.create_dataset(key, data=[g["source"].get(key, "unrecorded") for g in geometry],
                              dtype=h5py.string_dtype(encoding="utf-8"))
        cg.create_dataset("rgb_K", data=np.asarray([g["rgb_K"] for g in geometry]))
        cg.create_dataset("depth_K", data=np.asarray([np.full((3, 3), np.nan) if g["depth_K"] is None else g["depth_K"] for g in geometry]))
        cg.create_dataset("rgb_to_depth", data=np.asarray([np.full((3, 3), np.nan) if g["rgb_to_depth"] is None else g["rgb_to_depth"] for g in geometry]))
        for key in ("calibration_contract_verified", "depth_registered", "depth_time_verified", "tracking"):
            cg.create_dataset(key, data=[g[key] for g in geometry])
        cg.create_dataset("cross_stream_clock_verified", data=[g.get("cross_stream_clock_verified", False) for g in geometry])
        for key in ("frame_timestamp_ns", "android_camera_timestamp_ns", "rgb_timestamp_ns", "depth_timestamp_ns"):
            cg.create_dataset(key, data=np.array([g["source"].get(key) if g["source"].get(key) is not None else -1 for g in geometry], dtype=np.int64))
        if "depth" in h5:
            group = h5["depth"]
            group.move("timestamps", "rgb_association_timestamps")
            group["rgb_association_timestamps"][:] = timestamps
            native = np.array([g["source"].get("depth_timestamp_ns") if g["source"].get("depth_timestamp_ns") is not None else -1 for g in geometry], dtype=np.int64)
            group.create_dataset("native_timestamp_ns", data=native)
            group.create_dataset("timestamps", data=np.where(native >= 0, native / 1e9, np.nan))
            group.attrs["timestamps_semantics"] = "native depth acquisition seconds; NaN if not recorded; rgb_association_timestamps preserves association"
        if "cam-pose" in h5:
            pose_group = h5["cam-pose"]
            tracked_events = {int(g["source"]["frame_timestamp_ns"]) for g in geometry
                              if g["tracking"] and g["source"].get("frame_timestamp_ns") is not None}
            validity = [int(round(float(t) * 1e9)) in tracked_events for t in pose_group["timestamps"][:]]
            pose_group.create_dataset("valid", data=np.asarray(validity, dtype=bool))
            pose_group.attrs["valid_semantics"] = "raw poses retained; true only for tracked, exactly associated versioned RGB frame events"
        model = h5.create_group("hand-observations")
        model.attrs["coordinates"] = "2D pixels and wrist-relative model predictions; candidates are not ground truth"
        accepted = h5.create_group("hand-pose")
        accepted.attrs["coord_frame"] = "camera_3d"
        accepted.attrs["valid_semantics"] = "all 21 joints have independent visibility and pass consistency checks; not metric ground-truth validation"
        accepted.create_dataset("timestamps", data=timestamps)
        for side in ("left", "right"):
            group = model.create_group(side)
            detected = np.zeros(count, dtype=bool)
            shape = np.full((count, 21, 3), np.nan)
            raw_world = shape.copy(); raw_image = shape.copy()
            candidates = shape.copy(); supported = shape.copy()
            pixels = np.full((count, 21, 2), np.nan)
            score = np.full(count, np.nan)
            consistent = np.zeros(count, dtype=bool)
            supported_mask = np.zeros((count, 21), dtype=bool)
            for record in observations:
                if record["side"] != side:
                    continue
                i = record["frame_index"]; ob = record["observation"]; result = record["result"]
                detected[i] = True; shape[i] = ob["relative_joints_m"]
                if "raw_world_landmarks_m" in ob: raw_world[i] = ob["raw_world_landmarks_m"]
                if "raw_image_landmarks_normalized" in ob: raw_image[i] = ob["raw_image_landmarks_normalized"]
                pixels[i] = ob["landmarks_rgb_px"]; score[i] = ob["handedness_score"]
                candidates[i] = result["candidate_joints_m"]; supported[i] = result["supported_joints_m"]
                consistent[i] = result["quality"]["geometry_consistent"]
                supported_mask[i] = result["joint_visibility_supported"]
            for name, data in {"detected": detected, "image_landmarks_px": pixels,
                               "predicted_relative_joints_m": shape, "candidate_joints_m": candidates,
                               "raw_world_landmarks_m": raw_world, "raw_image_landmarks_normalized": raw_image,
                               "handedness_score": score, "geometry_consistent": consistent,
                               "joint_visibility_supported": supported_mask}.items():
                group.create_dataset(name, data=data)
            accepted.create_dataset(f"{side}_joints", data=supported)
            accepted.create_dataset(f"{side}_valid", data=supported_mask.all(axis=1))
            accepted.create_dataset(f"{side}_kpts_2d_rgb", data=pixels)
        h5.attrs["geometry_quality_schema"] = "local_geometry_v1"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mcap", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--legacy-geometry-hypothesis", action="store_true")
    parser.add_argument("--show-rejected-candidates", action="store_true", help="Display orange unverified candidates only in a diagnostic replay")
    args = parser.parse_args()
    raw = args.mcap.resolve(strict=True)
    output = (args.output or raw.parent / "stera_processed_geometry").resolve()
    if output.exists():
        parser.error("Use a fresh output directory")
    if command(["git", "rev-parse", "HEAD"], ROOT / "stera-sdk") != SDK_COMMIT or command(["git", "diff", "HEAD", "--", "src"], ROOT / "stera-sdk"):
        raise RuntimeError("Geometry runner requires the audited, unchanged SDK revision")
    session = GeometrySession(raw, legacy_hypothesis=args.legacy_geometry_hypothesis)
    output.mkdir(parents=True)
    episode = output / "episode"; episode.mkdir()
    models = output / "models"; models.mkdir()
    model_path = models / "hand_landmarker.task"
    cached = raw.parent / "stera_processed/models/hand_landmarker.task"
    if cached.exists(): shutil.copy2(cached, model_path)
    from stera.models import HandTracker
    from stera.models.mediapipe import tracker as mp_tracker
    from stera.viz.session import HAND_EDGES
    from stera import Evaluate
    mp_tracker._MODEL_CACHE = str(model_path)
    adapters = adapt_rerun_022(rr)
    receipt = {"status": "running", "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "raw_mcap": {"path": str(raw), "sha256_before": sha256(raw)},
               "sdk_commit": SDK_COMMIT, "geometry": session.geometry_summary,
               "pipeline": "per-frame calibrated association, independent raw model observations, conservative quality masks",
               "body_estimation": "disabled: mount/torso pose not observed",
               "default_viewer_eligible": session.version == VERSION and not args.legacy_geometry_hypothesis and not args.show_rejected_candidates,
               "show_rejected_candidates": args.show_rejected_candidates,
               "rerun_runtime_adapter": adapters}
    write_json(output / "receipt.json", receipt)
    tracker = None
    observations, geometries, timestamps, reports = [], [], [], []
    try:
        tracker = HandTracker(model="mediapipe")
        viz = GeometryVisualizer(session, output=str(episode / "visualization.rrd"))
        for frame in session.frames():
            geometry = frame.geometry; geometries.append(geometry); timestamps.append(frame.timestamp)
            overlay_hands = []; frame_candidates = []
            for observation in detect_observations(tracker._backend, frame.rgb):
                side = observation["hand_side"]
                result = reconstruct_hand(observation["relative_joints_m"], observation["landmarks_rgb_px"],
                    np.zeros((1, 1)) if frame.depth is None else frame.depth.astype(float) / 1000,
                    frame.rgb_K, rgb_size_wh=frame.rgb.shape[1::-1], rgb_to_depth=geometry["rgb_to_depth"],
                    calibration_verified=geometry["calibration_contract_verified"],
                    depth_registered=geometry["depth_registered"], depth_time_verified=geometry["depth_time_verified"],
                    handedness_score=observation["handedness_score"],
                    provenance={"frame_index": frame.index, "capture_geometry_version": session.version,
                                "legacy_hypothesis": args.legacy_geometry_hypothesis})
                observations.append({"frame_index": frame.index, "side": side, "observation": observation, "result": result})
                reports.append({"frame_index": frame.index, "side": side, **result["quality"]})
                # Image landmarks are always separate from metric geometry.
                overlay_hands.append(tracker._backend._to_hand_pose(side, None, observation["landmarks_rgb_px"], 0.0))
                if result["quality"]["geometry_consistent"] or args.show_rejected_candidates:
                    frame_candidates.append((side, result))
            viz.log_frame(frame, hands=overlay_hands, skeleton=None, enable_pointcloud=False)
            for side in ("left", "right"):
                rr.log(f"world/hand_candidates/{side}", rr.Clear(recursive=True))
            for side, result in frame_candidates:
                candidate = result["candidate_joints_m"]
                if frame.camera_pose is None or not np.isfinite(candidate).all(): continue
                world = candidate @ session.R_optical_to_link.T @ frame.camera_pose.rotation.T + frame.camera_pose.translation
                color = [255, 150, 40]
                path = f"world/hand_candidates/{side}"
                rr.log(path + "/bones", rr.LineStrips3D([[world[a], world[b]] for a, b in HAND_EDGES], colors=[color], radii=.003))
                label = "UNVERIFIED ESTIMATE" if result["quality"]["geometry_consistent"] else "REJECTED GEOMETRY"
                rr.log(path + "/status", rr.Points3D(world[:1], labels=[label], show_labels=True, colors=[color], radii=.004))
            if (frame.index + 1) % 50 == 0: print(f"Processed {frame.index + 1}/{session.num_rgb_frames}", flush=True)
        manifest = session.export(str(episode), visualizer=viz)
        write_json(output / "export_manifest.json", manifest)
        write_geometry_annotations(episode / "annotation.hdf5", observations, geometries, timestamps)
        write_json(output / "frame_geometry.json", geometries)
        failures = Counter(reason for r in reports for reason in r["rejection_reasons"])
        summary = {"frames": len(timestamps), "detected_hands": len(reports),
                   "geometry_consistent_hands": sum(r["geometry_consistent"] for r in reports),
                   "fully_observed_consistent_hands": sum(r["fully_observed_consistent"] for r in reports),
                   "metric_accuracy_validated": False, "rejection_reasons": dict(failures)}
        write_json(output / "geometry_quality.json", {"summary": summary, "hands": reports})
        evaluation = Evaluate(session)
        write_json(output / "evaluation_metrics.upstream.json", evaluation.compute())
        evaluation.export(output / "evaluation.upstream.html")
        if session.version in (VERSION_V2, VERSION):
            write_geometry_report(output, geometries, timestamps, summary)
        else:
            apply_report_clock(output, raw.parent / "metadata.json")
            # Historical diagnostics retain the old clock adapter, not v2 clock assumptions.
            html = (output / "evaluation.html").read_text()
            notice = '<div style="padding:16px;background:#7c2d12;color:white;font:16px sans-serif"><b>3D hand geometry requires separate validation.</b> ' + str(summary["geometry_consistent_hands"]) + '/' + str(summary["detected_hands"]) + ' estimates pass internal consistency checks; independently verified metric accuracy: unavailable. See geometry_quality.json. The SDK health score is not hand-pose accuracy.</div>'
            import re
            html, matches = re.subn(r"(<body\b[^>]*>)", lambda m: m.group(1) + notice, html, count=1, flags=re.IGNORECASE)
            if matches != 1: raise RuntimeError("Unable to add geometry status to evaluation report")
            (output / "evaluation.html").write_text(html)
        receipt["processing"] = summary
        receipt["status"] = "complete"
        print(json.dumps(summary, indent=2), flush=True)
    except Exception as error:
        receipt["status"] = "failed"; receipt["error"] = repr(error)
        raise
    finally:
        if tracker is not None: tracker._backend.close()
        seal_rerun_recording(rr)
        receipt["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        receipt["raw_mcap"]["sha256_after"] = sha256(raw)
        receipt["raw_mcap"]["unchanged"] = receipt["raw_mcap"]["sha256_before"] == receipt["raw_mcap"]["sha256_after"]
        receipt["source_files"] = {str(p.relative_to(ROOT)): sha256(p) for p in [Path(__file__), ROOT / "scripts/capture_geometry.py", ROOT / "scripts/hand_geometry.py", ROOT / "scripts/geometry_visualizer.py", ROOT / "scripts/geometry_report.py"]}
        receipt["artifacts"] = {str(p.relative_to(output)): {"bytes": p.stat().st_size, "sha256": sha256(p)} for p in output.rglob("*") if p.is_file() and p.name != "receipt.json"}
        write_json(output / "receipt.json", receipt)
        if not receipt["raw_mcap"]["unchanged"]: raise RuntimeError("Raw input was modified")


if __name__ == "__main__": main()
