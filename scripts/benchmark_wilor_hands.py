#!/usr/bin/env python3
"""Direct, research-only WiLoR evaluation on fixed HanCo and Pixel inputs.

The original model/source and separate MANO asset are hash checked. Reference
annotations are used only for assignment/scoring. Raw model predictions stay
local; the committed receipt contains scalar diagnostics only. Fitting the
model's own projected pixels to measured K is a camera diagnostic, not an
independent accuracy or visibility measurement.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
import time

sys.dont_write_bytecode = True

import cv2
import numpy as np
import torch

from hand_geometry import fit_perspective_camera, project_points
from preflight_wilor_research import (ASSETS, HF_REVISION, SOURCE_COMMIT,
                                      official_detector_loader, sha256,
                                      verified_asset)


EDGES = [(0, k) for k in (1, 5, 9, 13, 17)] + [
    (k+j, k+j+1) for k in (1, 5, 9, 13, 17) for j in range(3)]


def stats(values):
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    return {"count": len(values), **({} if not len(values) else {
        "mean": float(values.mean()), "median": float(np.median(values)),
        "p90": float(np.quantile(values, .9)), "max": float(values.max())})}


def bbox_iou(a, b):
    a, b = np.asarray(a), np.asarray(b)
    overlap = np.maximum(0, np.minimum(a[2:], b[2:])-np.maximum(a[:2], b[:2])).prod()
    union = np.maximum(0, a[2:]-a[:2]).prod()+np.maximum(0, b[2:]-b[:2]).prod()-overlap
    return float(overlap/union) if union > 0 else 0.


def load_models(root, mano, source_receipt):
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if commit != SOURCE_COMMIT or subprocess.check_output(["git", "diff", "HEAD", "--"], cwd=root):
        raise RuntimeError("WiLoR source differs from the pinned pristine revision")
    paths = {name: verified_asset(root, name) for name in ASSETS}
    provenance = json.loads(source_receipt.read_text())
    if sha256(mano) != provenance["sha256"]:
        raise RuntimeError("MANO asset differs from explicit provenance receipt")
    sys.path.insert(0, str(root))
    from ultralytics import YOLO
    from wilor.configs import get_config
    from wilor.models import WiLoR
    cfg = get_config(str(paths["pretrained_models/hf_pinned/model_config.yaml"]))
    cfg.defrost()
    cfg.MODEL.BACKBONE.pop("PRETRAINED_WEIGHTS", None)
    cfg.MODEL.BBOX_SHAPE = [192, 256]
    cfg.MANO.DATA_DIR = str(mano.parent)
    cfg.MANO.MODEL_PATH = str(mano)
    cfg.MANO.MEAN_PARAMS = str(root/"mano_data/mano_mean_params.npz")
    cfg.freeze()
    checkpoint = torch.load(paths["pretrained_models/wilor_final.ckpt"], map_location="cpu", weights_only=True)
    model = WiLoR(cfg, init_renderer=False)
    incompatible = model.load_state_dict(checkpoint["state_dict"], strict=False)
    if incompatible.missing_keys or incompatible.unexpected_keys:
        raise RuntimeError(f"Model state mismatch: {incompatible}")
    del checkpoint
    model = model.cuda().eval()
    with official_detector_loader(paths["pretrained_models/detector.pt"]):
        detector = YOLO(str(paths["pretrained_models/detector.pt"]))
    return model, cfg, detector, provenance


def predict(model, cfg, detector, bgr, K):
    from wilor.datasets.vitdet_dataset import ViTDetDataset
    from wilor.utils.renderer import cam_crop_to_full
    detections = detector.predict(bgr, device=0, half=True, conf=.3, imgsz=640,
                                  augment=False, verbose=False)[0]
    if not len(detections.boxes):
        return []
    boxes = detections.boxes.xyxy.cpu().numpy()
    right = detections.boxes.cls.cpu().numpy()
    # Official demo and SDK use 2.0; upstream dataset's implicit default is 2.5.
    dataset = ViTDetDataset(cfg, bgr, boxes, right, rescale_factor=2.0)
    batch = next(iter(torch.utils.data.DataLoader(dataset, batch_size=len(boxes), num_workers=0)))
    batch = {k: v.cuda() if torch.is_tensor(v) else v for k, v in batch.items()}
    with torch.no_grad(), torch.amp.autocast("cuda", dtype=torch.float16):
        output = model(batch)
    joints = output["pred_keypoints_3d"].float().cpu().numpy().astype(float)
    crop_uv = output["pred_keypoints_2d"].float().cpu().numpy().astype(float)
    if joints.shape != (len(boxes), 21, 3) or not np.isfinite(joints).all():
        raise RuntimeError("Nonfinite or malformed full model output")
    camera = output["pred_cam"].float().clone()
    multiplier = 2*batch["right"]-1
    camera[:, 1] *= multiplier
    focal = float(cfg.EXTRA.FOCAL_LENGTH/cfg.MODEL.IMAGE_SIZE*max(bgr.shape[:2]))
    cam_t = cam_crop_to_full(camera, batch["box_center"].float(), batch["box_size"].float(),
                             batch["img_size"].float(), focal).cpu().numpy().astype(float)
    centers = batch["box_center"].cpu().numpy().astype(float)
    sizes = batch["box_size"].cpu().numpy().astype(float)
    camera_np = camera.cpu().numpy().astype(float)
    bs = sizes*camera_np[:, 0]+1e-9
    expected_cam_t = np.column_stack((2*(centers[:, 0]-bgr.shape[1]/2)/bs+camera_np[:, 1],
                                     2*(centers[:, 1]-bgr.shape[0]/2)/bs+camera_np[:, 2], 2*focal/bs))
    if not np.allclose(cam_t, expected_cam_t, rtol=1e-5, atol=1e-5):
        raise RuntimeError("Official camera helper differs from independently evaluated source algebra")
    virtual_K = np.array([[focal, 0, bgr.shape[1]/2], [0, focal, bgr.shape[0]/2], [0, 0, 1.]])
    observations = []
    for n in range(len(boxes)):
        sign = float(multiplier[n])
        joints[n, :, 0] *= sign
        crop_uv[n, :, 0] *= sign
        native_uv = crop_uv[n]*sizes[n]+centers[n]
        nominal_xyz = joints[n]+cam_t[n]
        projection_difference = float(np.linalg.norm(project_points(nominal_xyz, virtual_K)-native_uv, axis=1).max())
        # cam_crop_to_full is a weak-perspective conversion: the full-camera
        # projection and affinely mapped crop projection need not coincide for
        # nonzero joint Z/off-center crops. Preserve that difference instead
        # of incorrectly treating it as an exact consistency requirement.
        if not np.allclose((native_uv-centers[n])/sizes[n], crop_uv[n], atol=1e-10, rtol=1e-10):
            raise RuntimeError("Native/crop affine roundtrip failed")
        shape = joints[n]-joints[n, :1]
        fit = fit_perspective_camera(shape, native_uv, K)
        ob = {"side": "right" if right[n] == 1 else "left", "bbox_xyxy": boxes[n].astype(float).tolist(),
              "bbox_confidence": float(detections.boxes.conf[n]), "relative_joints_m": shape.tolist(),
              "landmarks_rgb_px": native_uv.tolist(), "nominal_camera_joints_m": nominal_xyz.tolist(),
              "nominal_focal_px": focal, "crop_full_projection_difference_max_px": projection_difference,
              "training_qualified": False, "joint_visibility": "unknown"}
        if fit is not None:
            ob.update({"calibrated_pnp_joints_m": fit["candidate_joints_m"].tolist(),
                       "calibrated_pnp_fit_mean_px": float(fit["reprojection_error_px"].mean()),
                       "calibrated_pnp_rotation": fit["rotation"].tolist(),
                       "calibrated_pnp_translation_m": fit["translation_m"].tolist()})
        observations.append(ob)
    return observations


def overlay(bgr, observations, reference=None, rotate=False):
    out = bgr.copy()
    sets = [(np.asarray(ob["landmarks_rgb_px"]), (0, 165, 255)) for ob in observations]
    if reference is not None:
        sets.insert(0, (reference, (0, 255, 0)))
    for uv, color in sets:
        for a, b in EDGES:
            cv2.line(out, tuple(np.rint(uv[a]).astype(int)), tuple(np.rint(uv[b]).astype(int)), color, 1, cv2.LINE_AA)
        for x, y in uv:
            cv2.circle(out, (round(x), round(y)), 2, color, -1)
    return cv2.rotate(out, cv2.ROTATE_180) if rotate else out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wilor", type=Path, default=Path("artifacts/research-models/WiLoR"))
    parser.add_argument("--mano-asset", type=Path, required=True)
    parser.add_argument("--mano-source-receipt", type=Path, required=True)
    parser.add_argument("--hanco", type=Path, default=Path("captures/public-hand-benchmarks/hanco"))
    parser.add_argument("--hanco-selection", type=Path, default=Path("artifacts/hanco-validated-hand-benchmark/report.json"))
    parser.add_argument("--artifacts", type=Path, default=Path("artifacts/wilor-full-hand-benchmark"))
    parser.add_argument("--report", type=Path, default=Path("docs/validation/wilor-full-hand-benchmark.json"))
    args = parser.parse_args()
    if args.artifacts.exists():
        parser.error("Use a fresh output directory")
    args.artifacts.mkdir(parents=True)
    torch.manual_seed(0)
    model, cfg, detector, provenance = load_models(args.wilor.resolve(), args.mano_asset.resolve(strict=True), args.mano_source_receipt)
    raw, rows = [], []
    selection = json.loads(args.hanco_selection.read_text())
    meta = json.loads((args.hanco/"meta.json").read_text())
    for selected in selection["images"]:
        relative = Path(selected["image"])
        seq, camera, frame = relative.parts[1], int(relative.parts[2][3:]), relative.stem
        if not meta["is_valid"][int(seq)][int(frame)] or not meta["has_fit"][int(seq)][int(frame)]:
            raise RuntimeError("Reference selection contains an unvalidated/missing fit")
        xyz = np.asarray(json.loads((args.hanco/"xyz"/seq/f"{frame}.json").read_text()), float)
        calibration = json.loads((args.hanco/"calib"/seq/f"{frame}.json").read_text())
        K, M = (np.asarray(calibration[key][camera], float) for key in ("K", "M"))
        reference = xyz @ M[:3, :3].T + M[:3, 3]
        reference_uv = project_points(reference, K)
        control = fit_perspective_camera(reference-reference[:1], reference_uv, K)
        if control is None or np.max(np.linalg.norm(control["candidate_joints_m"]-reference, axis=1)) > 1e-5:
            raise RuntimeError("Known camera reference control failed")
        bgr = cv2.imread(str(args.hanco/relative))
        observations = predict(model, cfg, detector, bgr, K)
        raw.append({"dataset": "HanCo", "image": str(relative), "frame_sha256": sha256(args.hanco/relative), "predictions": observations})
        row = {"image": str(relative), "detected": bool(observations), "detections": len(observations),
               "reference_manually_validated": True}
        if observations:
            envelope = np.r_[reference_uv.min(axis=0), reference_uv.max(axis=0)]
            matched = max(observations, key=lambda ob: bbox_iou(ob["bbox_xyxy"], envelope))
            shape = np.asarray(matched["relative_joints_m"])
            uv = np.asarray(matched["landmarks_rgb_px"])
            row.update({"side": matched["side"], "landmark_error_mean_px": float(np.linalg.norm(uv-reference_uv, axis=1).mean()),
                "raw_relative_mpjpe_mm": float(np.linalg.norm(shape-(reference-reference[:1]), axis=1).mean()*1000),
                "nominal_camera_absolute_mpjpe_mm": float(np.linalg.norm(np.asarray(matched["nominal_camera_joints_m"])-reference, axis=1).mean()*1000)})
            if "calibrated_pnp_joints_m" in matched:
                candidate = np.asarray(matched["calibrated_pnp_joints_m"])
                row.update({"calibrated_pnp_relative_mpjpe_mm": float(np.linalg.norm(candidate-candidate[:1]-(reference-reference[:1]), axis=1).mean()*1000),
                    "calibrated_pnp_absolute_mpjpe_mm": float(np.linalg.norm(candidate-reference, axis=1).mean()*1000),
                    "calibrated_pnp_wrist_error_mm": float(np.linalg.norm(candidate[0]-reference[0])*1000),
                    "calibrated_pnp_fit_mean_px": matched["calibrated_pnp_fit_mean_px"]})
        cv2.imwrite(str(args.artifacts/f"hanco_{seq}_{frame}_cam{camera}.jpg"), overlay(bgr, observations, reference_uv))
        rows.append(row)
        print(f"HanCo: {len(rows)}/{len(selection['images'])}", flush=True)
    pixel_rows, panels = [], []
    for session in ("session_20261022_152005", "session_20261022_151917"):
        session_dir = Path("captures")/session
        K_file = session_dir/"inspection/calibration.json"
        calibrations = json.loads(K_file.read_text())["topics"]["/camera/camera_info"]
        if len(calibrations) != 1:
            raise RuntimeError("Pixel benchmark requires one explicitly recorded RGB calibration; multiple Ks need frame association")
        K = np.asarray(calibrations[0]["calibration"]["k"], dtype=float).reshape(3, 3)
        frames = sorted((session_dir/"inspection/rgb_frames").glob("*.jpg"))
        counts, negatives, fit_residuals = [], [], []
        for frame_file in frames:
            index = int(frame_file.stem)
            bgr = cv2.imread(str(frame_file))
            observations = predict(model, cfg, detector, bgr, K)
            raw.append({"dataset": session, "frame_index": index, "frame_sha256": sha256(frame_file), "predictions": observations})
            counts.append(len(observations))
            fit_residuals.extend(ob["calibrated_pnp_fit_mean_px"] for ob in observations if "calibrated_pnp_fit_mean_px" in ob)
            if session == "session_20261022_152005" and index in (0, 5, 180, 185):
                negatives.append({"frame_index": index, "false_positive_detections": len(observations)})
            if session == "session_20261022_152005" and index in (20, 40, 50, 60, 80, 100, 120, 140, 160):
                view = overlay(bgr, observations, rotate=True)
                cv2.imwrite(str(args.artifacts/f"pixel_{index:06d}.jpg"), view)
                panels.append(cv2.resize(view, (640, 360)))
            if index % 30 == 0:
                print(f"{session}: {index}/{len(frames)}", flush=True)
        pixel_rows.append({"session": session, "frames": len(frames), "detected_frames": int(np.count_nonzero(counts)),
            "observations": int(sum(counts)), "finite_full_model_observations": int(sum(counts)), "rgb_K_sha256": sha256(K_file),
            "calibrated_pnp_fit_mean_px": stats(fit_residuals), "known_negative_checks": negatives,
            "training_qualified_observations": 0, "visibility_labels": "unknown; not inferred from detector scores"})
    if panels:
        contact = np.concatenate([np.concatenate(panels[i:i+3], axis=1) for i in range(0, 9, 3)], axis=0)
        cv2.imwrite(str(args.artifacts/"pixel_contact.jpg"), contact)
    raw_file = args.artifacts/"predictions.json"
    raw_file.write_text(json.dumps(raw, indent=2)+"\n")
    metrics = ("landmark_error_mean_px", "raw_relative_mpjpe_mm", "nominal_camera_absolute_mpjpe_mm",
               "calibrated_pnp_relative_mpjpe_mm", "calibrated_pnp_absolute_mpjpe_mm", "calibrated_pnp_wrist_error_mm", "calibrated_pnp_fit_mean_px")
    report = {"finished_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source_commit": SOURCE_COMMIT,
        "hf_revision": HF_REVISION, "script_sha256": sha256(__file__), "hand_geometry_sha256": sha256(Path(__file__).with_name("hand_geometry.py")),
        "model_assets": ASSETS, "mano_asset_provenance": provenance, "raw_predictions": str(raw_file), "raw_predictions_sha256": sha256(raw_file),
        "runtime": {name: importlib.metadata.version(name) for name in ("torch", "torchvision", "numpy", "ultralytics", "smplx")},
        "gpu": torch.cuda.get_device_name(0),
        "settings": {"detector_confidence": .3, "detector_imgsz": 640, "rescale_factor": 2., "autocast": "float16",
                     "input": "Native OpenCV BGR, no raster rotation; official crop preprocessing/left flip", "renderer": False},
        "coordinates": "Official MANO OpenPose21 order: wrist0, thumb1-4/index5-8/middle9-12/ring13-16/pinky17-20. Left x mirror restored per demo. Positive camera Z; wrist subtraction only for relative metric. No Procrustes/scale/reference rotation alignment.",
        "camera_protocol": "Official crop/full projection with nominal F=cfgF/image_size*max(W,H). It is not calibrated camera depth. Diagnostic PnP uses measured K and the model's own predicted2D only; fit residual is circular consistency, not accuracy. GT is only for IoU assignment and error scoring.",
        "controls": {"official_camera_helper_vs_independent_algebra": "pass", "native_crop_affine_roundtrip": "pass", "known_reference_camera_recovery": "pass"},
        "crop_full_projection_difference_max_px": max(ob["crop_full_projection_difference_max_px"] for item in raw for ob in item["predictions"]),
        "hanco": {"source": selection["source"], "selection_sha256": sha256(args.hanco_selection),
            "images": len(rows), "detected_images": sum(row["detected"] for row in rows),
            "summary": {key: stats([row[key] for row in rows if key in row]) for key in metrics}, "per_image": rows},
        "pixel": pixel_rows,
        "limitations": ["Three correlated HanCo timesteps from one sequence; MANO-derived fits, not measured anatomical ground truth; training overlap unknown.",
            "No 3D reference or exhaustive presence/visibility labels for Pixel; finite joints and fitted projection do not establish training quality.",
            "Same detector hallucinations/duplicates are retained, with no silent deduplication or topology inference from detector keypoints.",
            "WiLoR/MANO/HanCo assets are for research comparison; source access does not establish commercial rights. No raw assets, images or annotations redistributed."]}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({"hanco": report["hanco"]["summary"], "pixel": pixel_rows}, indent=2))


if __name__ == "__main__":
    main()
