#!/usr/bin/env python3
"""Evaluate the official WiLoR YOLO detector's 2D output without MANO.

Joint ordering is undocumented in the supplied detector metadata. Indexwise
reference errors are conditional on identity ordering, never a verified metric.
Ground-truth annotations are used only for matching/scoring, not fitting.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import importlib.metadata
import inspect
import json
from pathlib import Path
import time

import cv2
import numpy as np
import torch

from preflight_wilor_research import (SOURCE_COMMIT, HF_REVISION, ASSETS,
                                      official_detector_loader, verified_asset,
                                      sha256)

NEGATIVE_FRAMES = (0, 5, 180, 185)
REVIEW_FRAMES = (50, 60, 80, 100, 120, 140)


def stats(values):
    values = np.asarray(values, float)
    values = values[np.isfinite(values)]
    return {"count": len(values), **({} if not len(values) else {
        "mean": float(values.mean()), "median": float(np.median(values)),
        "p90": float(np.quantile(values, .9)), "max": float(values.max())})}


@contextmanager
def preserve_unmasked_keypoints():
    """Copy original-image predictions before Ultralytics zeroes conf<0.5 XY.

    This captures outputs without changing NMS, prediction, confidence or
    presentation behavior. It is scoped to the benchmark's result constructor.
    """
    import ultralytics.models.yolo.pose.predict as pose_predict
    original = pose_predict.Results

    def capture(*args, **kwargs):
        raw = kwargs["keypoints"].detach().cpu().numpy().copy()
        result = original(*args, **kwargs)
        result.benchmark_unmasked_keypoints = raw
        return result

    pose_predict.Results = capture
    try:
        yield
    finally:
        pose_predict.Results = original


def detect(detector, bgr):
    result = detector.predict(bgr, device=0, half=True, conf=.3,
                              imgsz=640, augment=False, verbose=False)[0]
    raw = result.benchmark_unmasked_keypoints
    boxes = result.boxes
    observations = []
    if len(boxes) and raw.shape != (len(boxes), 21, 3):
        raise RuntimeError(f"Unexpected keypoint tensor shape {raw.shape}")
    for index in range(len(boxes)):
        observations.append({"xyxy": boxes.xyxy[index].cpu().numpy().tolist(),
            "bbox_confidence": float(boxes.conf[index]), "side_class": int(boxes.cls[index]),
            "keypoints_xy_px": raw[index, :, :2].astype(float).tolist(),
            "keypoint_confidence": raw[index, :, 2].astype(float).tolist(),
            "presentation_keypoints_xy_px": result.keypoints.xy[index].cpu().numpy().tolist()})
    return observations


def overlay(bgr, observations, label, *, rotate=False):
    out = bgr.copy()
    # Lines are an explicit identity-order hypothesis for inspection only.
    edges = [(0, start) for start in (1, 5, 9, 13, 17)] + [
        (start+j, start+j+1) for start in (1, 5, 9, 13, 17) for j in range(3)]
    for ob in observations:
        xy = np.asarray(ob["keypoints_xy_px"])
        conf = np.asarray(ob["keypoint_confidence"])
        x0, y0, x1, y1 = np.rint(ob["xyxy"]).astype(int)
        cv2.rectangle(out, (x0, y0), (x1, y1), (255, 190, 40), 3)
        for a, b in edges:
            cv2.line(out, tuple(np.rint(xy[a]).astype(int)), tuple(np.rint(xy[b]).astype(int)), (160, 160, 160), 2)
        for index, (point, confidence) in enumerate(zip(xy, conf)):
            p = tuple(np.rint(point).astype(int))
            color = (70, 240, 70) if confidence >= .5 else (0, 150, 255)
            cv2.circle(out, p, 5, color, -1)
            cv2.putText(out, str(index), (p[0]+4, p[1]-4), cv2.FONT_HERSHEY_SIMPLEX, .45, (255, 255, 255), 1, cv2.LINE_AA)
    if rotate:
        out = cv2.rotate(out, cv2.ROTATE_180)
    cv2.rectangle(out, (0, 0), (out.shape[1], 72), (10, 10, 10), -1)
    cv2.putText(out, label, (16, 30), cv2.FONT_HERSHEY_SIMPLEX, .7, (255, 255, 255), 1, cv2.LINE_AA)
    cv2.putText(out, '2D estimate; ordering unverified; confidence is not visibility', (16, 59), cv2.FONT_HERSHEY_SIMPLEX, .55, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def bbox_iou(a, b):
    a, b = np.asarray(a), np.asarray(b)
    overlap = np.maximum(0, np.minimum(a[2:], b[2:])-np.maximum(a[:2], b[:2])).prod()
    union = np.maximum(0, a[2:]-a[:2]).prod()+np.maximum(0, b[2:]-b[:2]).prod()-overlap
    return float(overlap/union) if union > 0 else 0.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wilor", type=Path, default=Path("artifacts/research-models/WiLoR"))
    parser.add_argument("--hanco", type=Path, default=Path("captures/public-hand-benchmarks/hanco"))
    parser.add_argument("--hanco-selection", type=Path, default=Path("artifacts/hanco-validated-hand-benchmark/report.json"))
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts/wilor-detector-2d"))
    parser.add_argument("--report", type=Path, default=Path("docs/validation/wilor-detector-2d.json"))
    args = parser.parse_args()
    if args.artifacts.exists():
        parser.error("Use a fresh artifact directory")
    args.artifacts.mkdir(parents=True)
    from ultralytics import YOLO
    from ultralytics.engine.results import Keypoints
    from ultralytics.models.yolo.pose.predict import PosePredictor
    detector_path = verified_asset(args.wilor.resolve(), "pretrained_models/detector.pt")
    with official_detector_loader(detector_path):
        detector = YOLO(str(detector_path))
    assert detector.task == "pose" and detector.model.yaml["kpt_shape"] == [21, 3]
    torch.manual_seed(0)
    raw_predictions, pixel_reports, review_panels = [], [], []
    report = {"source_commit": SOURCE_COMMIT, "hf_revision": HF_REVISION,
        "detector_sha256": ASSETS["pretrained_models/detector.pt"], "script_sha256": sha256(__file__),
        "settings": {"bbox_confidence": .3, "imgsz": 640, "half": True, "device": "cuda:0",
                     "input": "Unrotated native BGR; no crops or tracking", "augment": False},
        "runtime": {name: importlib.metadata.version(name) for name in ("torch", "torchvision", "ultralytics", "numpy")},
        "gpu": torch.cuda.get_device_name(0),
        "output_contract": {"task": detector.task, "kpt_shape": detector.model.yaml["kpt_shape"],
            "side_classes": detector.model.names,
            "training_config_path_in_checkpoint": detector.ckpt["train_args"].get("data"),
            "joint_order_verified": False,
            "reason": "Official source/checkpoint metadata provide 21x3 dimensions but no named joint mapping. Referenced training YAML is absent from the source checkout.",
            "keypoint_confidence_semantics": "Learned per-keypoint prediction score; not ground-truth visibility, pose confidence, or handedness score.",
            "presentation_mask": "Ultralytics8.1.34 Keypoints zeros XY where joint confidence<0.5; benchmark copies raw original-image coordinates before this presentation masking.",
            "presentation_mask_source_sha256": sha256(inspect.getfile(Keypoints)),
            "postprocess_source_sha256": sha256(inspect.getfile(PosePredictor))},
        "license": "Research-only WiLoR weights; separate Ultralytics/HanCo/MANO terms. No MANO used."}
    with preserve_unmasked_keypoints():
        for session in ("session_20261022_152005", "session_20261022_151917"):
            frames = sorted((Path("captures")/session/"inspection/rgb_frames").glob("*.jpg"))
            counts, negatives = [], []
            for frame in frames:
                index = int(frame.stem)
                bgr = cv2.imread(str(frame))
                obs = detect(detector, bgr)
                raw_predictions.append({"dataset": session, "frame_index": index,
                    "frame_sha256": sha256(frame), "predictions": obs})
                counts.append(len(obs))
                if session == "session_20261022_152005" and index in NEGATIVE_FRAMES:
                    negatives.append({"frame_index": index, "known_negative": True,
                                      "false_positive_detections": len(obs)})
                if session == "session_20261022_152005" and index in REVIEW_FRAMES:
                    view = overlay(bgr, obs, f'Latest frame {index}; {len(obs)} detections; display rotated180 only', rotate=True)
                    cv2.imwrite(str(args.artifacts/f"latest_{index:06d}.jpg"), view)
                    review_panels.append(cv2.resize(view, (640, 360)))
                if index % 60 == 0:
                    print(f"{session}: {index}/{len(frames)}", flush=True)
            pixel_reports.append({"session": session, "frames": len(frames),
                "detected_frames": int(np.count_nonzero(counts)), "detection_observations": int(sum(counts)),
                "detected_frame_fraction": float(np.count_nonzero(counts)/len(frames)),
                "coverage_semantics": "Detected-frame coverage, not recall; hand presence/occlusion is not exhaustively annotated.",
                "known_negative_checks": negatives,
                "missed_frame_indices": [i for i, count in enumerate(counts) if not count]})
        selection = json.loads(args.hanco_selection.read_text())
        hanco_rows, confidence_error_pairs = [], []
        for selected in selection["images"]:
            relative = Path(selected["image"])
            sequence, camera, frame = relative.parts[1], int(relative.parts[2][3:]), relative.stem
            bgr = cv2.imread(str(args.hanco/relative))
            obs = detect(detector, bgr)
            raw_predictions.append({"dataset": "HanCo", "image": str(relative),
                                    "frame_sha256": sha256(args.hanco/relative), "predictions": obs})
            row = {"image": str(relative), "detected": bool(obs), "detections": len(obs),
                   "reference_manually_validated": selected["reference_manually_validated"]}
            if obs:
                xyz = np.asarray(json.loads((args.hanco/"xyz"/sequence/f"{frame}.json").read_text()), float)
                calibration = json.loads((args.hanco/"calib"/sequence/f"{frame}.json").read_text())
                K, M = (np.asarray(calibration[key][camera], float) for key in ("K", "M"))
                camera_xyz = xyz @ M[:3, :3].T + M[:3, 3]
                projected = camera_xyz @ K.T
                reference_uv = projected[:, :2]/projected[:, 2:3]
                envelope = np.r_[reference_uv.min(axis=0), reference_uv.max(axis=0)]
                matched = max(obs, key=lambda ob: bbox_iou(ob["xyxy"], envelope))
                xy, confidence = np.asarray(matched["keypoints_xy_px"]), np.asarray(matched["keypoint_confidence"])
                errors = np.linalg.norm(xy-reference_uv, axis=1)
                distances = np.linalg.norm(xy[:, None, :]-reference_uv[None, :, :], axis=2)
                available = confidence >= .5
                row.update({"matched_joint_envelope_iou": bbox_iou(matched["xyxy"], envelope),
                    "conditional_identity_order_all21_mean_error_px": float(errors.mean()),
                    "conditional_identity_order_conf_ge_0p5_mean_error_px": float(errors[available].mean()) if available.any() else None,
                    "conf_ge_0p5_joint_count": int(available.sum()),
                    "order_independent_symmetric_chamfer_px": float((distances.min(axis=0).mean()+distances.min(axis=1).mean())/2)})
                confidence_error_pairs.extend(zip(confidence.tolist(), errors.tolist()))
            hanco_rows.append(row)
    if review_panels:
        cv2.imwrite(str(args.artifacts/"latest_grasp_contact.jpg"),
                    np.concatenate([np.concatenate(review_panels[:3], axis=1),
                                    np.concatenate(review_panels[3:], axis=1)], axis=0))
    report["pixel"] = pixel_reports
    report["hanco"] = {"source": selection["source"], "selection_sha256": sha256(args.hanco_selection),
        "protocol": "Exact prior24 validated views:3 correlated timesteps×8 cameras. GT only matches highest predicted-box/reference-joint-envelope IoU and scores; no permutation, pose, scale or image fitting.",
        "images": len(hanco_rows), "detected_images": sum(r["detected"] for r in hanco_rows),
        "conditional_identity_order_all21_mean_error_px": stats([r["conditional_identity_order_all21_mean_error_px"] for r in hanco_rows if r["detected"]]),
        "conditional_identity_order_conf_ge_0p5_mean_error_px": stats([r["conditional_identity_order_conf_ge_0p5_mean_error_px"] for r in hanco_rows if r.get("conditional_identity_order_conf_ge_0p5_mean_error_px") is not None]),
        "order_independent_symmetric_chamfer_px": stats([r["order_independent_symmetric_chamfer_px"] for r in hanco_rows if r["detected"]]),
        "confidence_error_fixed_bins_conditional_identity_order": [
            {"low": lo, "high": hi, "reference_error_px": stats([error for confidence, error in confidence_error_pairs if lo <= confidence < hi or (hi == 1. and confidence == 1.)])}
            for lo, hi in ((0., .5), (.5, .9), (.9, .99), (.99, 1.))],
        "baseline_mediapipe_all21_mean_error_px": selection["summary"]["landmark_error_mean_px"],
        "comparability_limit": "Detector indexwise scores assume unverified joint ordering; confidence-filtered errors condition on retained predictions; three timesteps do not establish egocentric accuracy.",
        "per_image": hanco_rows}
    raw_file = args.artifacts/"predictions.json"
    raw_file.write_text(json.dumps(raw_predictions, indent=2)+"\n")
    report["ignored_prediction_artifact"] = {"path": str(raw_file), "sha256": sha256(raw_file),
                                            "contains": "Per-frame complete detector 2D predictions/confidences, no GT joint arrays"}
    report["accuracy_and_training_qualification"] = "No 3D reconstruction; no hidden-joint/visibility or training accuracy claim. Confidence is not visibility. MANO is not loaded or replaced."
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({"pixel": [{k: v for k, v in r.items() if k != "missed_frame_indices"} for r in pixel_reports],
                      "hanco_all21_conditional": report["hanco"]["conditional_identity_order_all21_mean_error_px"],
                      "hanco_chamfer": report["hanco"]["order_independent_symmetric_chamfer_px"]}, indent=2))


if __name__ == "__main__":
    main()
