#!/usr/bin/env python3
"""Audit saved Stera hand geometry without changing SDK, recordings or exports.

Run with .venv-stera/bin/python. All fits are geometric diagnostics, never
ground truth, corrected annotations, or evidence of physical hand accuracy.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
from pathlib import Path

import cv2
import h5py
import numpy as np
from scipy.optimize import least_squares


EDGES = [(0, start) for start in (1, 5, 9, 13, 17)] + [
    (start + j, start + j + 1) for start in (1, 5, 9, 13, 17) for j in range(3)
]


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def statistics(values):
    a = np.asarray(values, dtype=float).ravel()
    a = a[np.isfinite(a)]
    if not a.size:
        return {"count": 0}
    return {"count": int(a.size), "min": float(a.min()),
            "p10": float(np.quantile(a, .1)), "median": float(np.median(a)),
            "p90": float(np.quantile(a, .9)), "max": float(a.max()),
            "mean": float(a.mean()), "rms": float(np.sqrt(np.mean(a * a)))}


def project(xyz, intrinsic):
    homogeneous = xyz @ intrinsic.T
    with np.errstate(divide="ignore", invalid="ignore"):
        return homogeneous[..., :2] / homogeneous[..., 2:]


def errors(xyz, observed, intrinsic):
    projected = project(xyz, intrinsic)
    valid = (np.isfinite(observed).all(axis=-1)
             & np.isfinite(xyz).all(axis=-1) & (xyz[..., 2] > 0)
             & np.isfinite(projected).all(axis=-1))
    radial = np.linalg.norm(projected - observed, axis=-1)
    return np.where(valid, radial, np.nan), valid, projected


def sample_depth(depth, point, rgb_size, radius):
    height, width = depth.shape
    u, v = np.rint(point * np.array([width, height]) / rgb_size).astype(int)
    if not (0 <= u < width and 0 <= v < height):
        return None
    patch = depth[max(0, v-radius):min(height, v+radius+1),
                  max(0, u-radius):min(width, u+radius+1)].astype(float)
    valid = patch[(patch > 50) & (patch < 2000)]
    if len(valid) < max(3, .15 * patch.size):
        return None
    return float(np.median(valid) / 1000)


def depth_audit(depth, observed, rgb_size):
    for anchor in (0, 9, 5, 13, 17):
        z = sample_depth(depth, observed[anchor], rgb_size, 7)
        if z is not None:
            return {"anchor_joint": anchor, "method": "first_valid_patch_median",
                    "depth_m": z, "radius_depth_pixels": 7}
    samples = [sample_depth(depth, uv, rgb_size, 5) for uv in observed]
    samples = [z for z in samples if z is not None]
    return {"anchor_joint": None, "method": "all_joint_patch_medians_fallback",
            "depth_m": float(np.median(samples)) if len(samples) >= 3 else None,
            "radius_depth_pixels": 5}


def diagnostic_fits(xyz, observed, intrinsic):
    relative = xyz - xyz[:1]
    finite = np.isfinite(relative).all(axis=1) & np.isfinite(observed).all(axis=1)
    if finite.sum() < 6:
        return {"status": "insufficient_finite_landmarks"}, {}
    rel, uv = relative[finite], observed[finite]
    minimum_z = max(.01, .01 - float(relative[:, 2].min()))

    def residual(translation):
        return (project(rel + translation, intrinsic) - uv).ravel()

    fit = least_squares(residual, xyz[0],
                        bounds=([-3, -3, minimum_z], [3, 3, 3]), max_nfev=200)
    translated = relative + fit.x
    translation_error, _, _ = errors(translated, observed, intrinsic)
    results = {"translation_only": {
        "success": bool(fit.success), "wrist_m": fit.x.tolist(),
        "nonwrist_error_px": statistics(translation_error[1:]),
        "coordinate_rmse_all_joints_px": float(np.sqrt(np.mean(fit.fun ** 2))),
        "interpretation": "Fixed predicted metric hand shape; translation fitted to the same 2D detections, not verified depth."}}
    predictions = {"translation_only": translated}

    success, rvec, tvec = cv2.solvePnP(
        rel.astype(np.float64), uv.astype(np.float64), intrinsic, None,
        rvec=np.zeros((3, 1)), tvec=xyz[0].astype(float).reshape(3, 1).copy(),
        useExtrinsicGuess=True, flags=cv2.SOLVEPNP_ITERATIVE)
    if success:
        rotation = cv2.Rodrigues(rvec)[0]
        posed = relative @ rotation.T + tvec.ravel()
        error, mask, _ = errors(posed, observed, intrinsic)
        results["rigid_pnp"] = {
            "success": True, "positive_depth_all_joints": bool(np.all(posed[:, 2] > 0)),
            "rotation_matrix": rotation.tolist(), "translation_m": tvec.ravel().tolist(),
            "rotation_angle_degrees": float(np.linalg.norm(rvec) * 180 / np.pi),
            "nonwrist_error_px": statistics(error[1:]),
            "interpretation": "Per-hand six-parameter local PnP fit; metric scale inherited from model, not ground truth."}
        predictions["rigid_pnp"] = posed
    else:
        results["rigid_pnp"] = {"success": False}
    return results, predictions


def safe(value):
    if isinstance(value, dict):
        return {k: safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [safe(v) for v in value]
    if isinstance(value, np.ndarray):
        return safe(value.tolist())
    if isinstance(value, (float, np.floating)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, (np.integer, np.bool_)):
        return value.item()
    return value


def render(records, session, output):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from PIL import Image

    cyan, orange = "#03c6fc", "#ff8c20"
    preferred = [79, 200, 227, 243, 112, 230]
    selected = []
    for frame in preferred:
        choices = [r for r in records if r["frame_index"] == frame]
        if choices:
            selected.append(choices[0])

    def draw(ax, record, mode):
        source = session / "inspection/rgb_frames" / f'{record["frame_index"]:06d}.jpg'
        with Image.open(source) as image:
            ax.imshow(image)
            width, height = image.size
        observed, predicted = np.array(record["observed_2d_rgb_px"]), np.array(record["saved_3d_reprojected_px"])
        combined = np.concatenate([observed, predicted])
        good = np.isfinite(combined).all(axis=1)
        box = combined[good]
        lo, hi = box.min(axis=0)-75, box.max(axis=0)+75
        ax.set_xlim(max(0, lo[0]), min(width, hi[0]))
        ax.set_ylim(min(height, hi[1]), max(0, lo[1]))
        for points, color, marker, label in [(observed, cyan, "o", "Saved 2D detection"),
                                              (predicted, orange, "x", "Saved 3D reprojected")]:
            if mode == "2d" and marker == "x" or mode == "3d" and marker == "o":
                continue
            for a, b in EDGES:
                ax.plot(points[[a,b], 0], points[[a,b], 1], color=color, lw=1.7, alpha=.95)
            ax.scatter(points[:, 0], points[:, 1], s=22, marker=marker, c=color,
                       linewidths=1.2, label=label)
        ax.set_xticks([]); ax.set_yticks([])

    first = next((r for r in selected if r["frame_index"] == 79), selected[0])
    fig, axes = plt.subplots(1, 2, figsize=(11, 6), constrained_layout=True)
    for ax, mode, title in zip(axes, ["2d", "3d"],
                               ["Saved 2D model landmarks", "Saved 3D projected through RGB intrinsics"]):
        draw(ax, first, mode)
        ax.set_title(title, fontsize=11)
    fig.suptitle(f'Same recorded frame {first["frame_index"]} | {first["elapsed_s"]:.3f} s | '
                 f'non-wrist median disagreement {first["saved_error_nonwrist_px"]["median"]:.1f} px\n'
                 'Cyan circles: 2D detection    Orange crosses: projection of saved 3D', fontsize=12)
    fig.savefig(output / "frame_79_comparison.png", dpi=150)
    plt.close(fig)

    fig, axes = plt.subplots(2, 3, figsize=(13, 8), constrained_layout=True)
    for ax, record in zip(axes.flat, selected):
        draw(ax, record, "both")
        ax.set_title(f'{record["frame_index"]} | {record["side"]} | {record["elapsed_s"]:.2f}s\n'
                     f'median {record["saved_error_nonwrist_px"]["median"]:.1f}px', fontsize=10)
    for ax in list(axes.flat)[len(selected):]:
        ax.axis("off")
    fig.suptitle('Saved 2D vs saved 3D reprojection — diagnostic disagreement, not ground-truth error\n'
                 'Cyan circles: 2D detection    Orange crosses: projection of saved 3D', fontsize=13)
    fig.savefig(output / "representative_contact_sheet.png", dpi=140)
    plt.close(fig)
    return [{"frame_index": r["frame_index"], "side": r["side"]} for r in selected]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--processed", default="stera_processed_y_up")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    session = args.session.resolve()
    source = session / args.processed
    output = (args.output or session / "geometry_audit").resolve()
    if output == source or source in output.parents:
        raise ValueError("Audit output must be separate from the original processed output")
    output.mkdir(parents=True, exist_ok=True)
    paths = [source / "episode/annotation.hdf5", source / "skeleton_estimates.npz",
             source / "episode/calibrations/rgb_K.npy", source / "episode/calibrations/depth_K.npy",
             source / "episode/calibrations/R_optical_to_link.npy", source / "receipt.json"]
    before = {str(p): digest(p) for p in paths}
    receipt = json.loads(paths[-1].read_text())
    intrinsic = np.load(paths[2]).astype(float)
    depth_intrinsic = np.load(paths[3]).astype(float)
    optical_to_link = np.load(paths[4]).astype(float)
    rgb_size = np.array([receipt["validation"]["video"]["streams"][0]["width"],
                         receipt["validation"]["video"]["streams"][0]["height"]])
    records, all_xyz, all_uv, csv_rows = [], [], [], []
    fitted_errors = {"translation_only": [], "rigid_pnp": []}
    with h5py.File(paths[0], "r") as data, np.load(paths[1]) as skeleton:
        indices = {int(frame): index for index, frame in enumerate(skeleton["frame_indices"])}
        timestamps = data["hand-pose/timestamps"][:]
        rotations = data["cam-pose/rotations"][:]
        translations = data["cam-pose/translations"][:]
        skeleton_joints = skeleton["joints"][:]
        assert len(timestamps) == len(rotations) == len(translations)
        assert np.allclose(data["cam-pose/timestamps"][:], timestamps, atol=1e-6, rtol=0)
        for side, shoulder, elbow, wrist in [("left", 3, 4, 5), ("right", 6, 7, 8)]:
            flags = data[f"hand-pose/{side}_valid"][:]
            for frame in np.flatnonzero(flags):
                frame = int(frame)
                xyz = data[f"hand-pose/{side}_joints"][frame].astype(float)
                observed = data[f"hand-pose/{side}_kpts_2d_rgb"][frame].astype(float)
                error, mask, predicted = errors(xyz, observed, intrinsic)
                inbounds = ((observed >= 0) & (observed < rgb_size)).all(axis=1)
                fits, fit_xyz = diagnostic_fits(xyz, observed, intrinsic)
                for name, fitted in fit_xyz.items():
                    fitted_errors[name].extend(errors(fitted, observed, intrinsic)[0][1:].tolist())
                world_wrist = rotations[frame] @ optical_to_link @ xyz[0] + translations[frame]
                record = {"frame_index": frame, "side": side,
                          "elapsed_s": float(timestamps[frame] - timestamps[0]),
                          "native_timestamp_s": float(timestamps[frame]), "source_hand_valid": True,
                          "handedness_confidence": float(data[f"hand-pose/{side}_confidence"][frame]),
                          "finite_positive_depth_mask": mask.tolist(),
                          "observed_in_image_mask": inbounds.tolist(),
                          "saved_xyz_camera_m": xyz.tolist(), "observed_2d_rgb_px": observed.tolist(),
                          "saved_3d_reprojected_px": predicted.tolist(),
                          "saved_error_per_joint_px": error.tolist(),
                          "saved_error_nonwrist_px": statistics(error[1:]),
                          "saved_error_inbounds_nonwrist_px": statistics(error[1:][inbounds[1:]]),
                          "wrist_optical_y_m": float(xyz[0, 1]), "wrist_depth_m": float(xyz[0, 2]),
                          "wrist_world_minus_camera_y_m": float(world_wrist[1] - translations[frame, 1]),
                          "depth_anchor": depth_audit(data["depth/frames"][frame], observed, rgb_size),
                          "diagnostic_fits": fits}
                if frame in indices:
                    joints = skeleton_joints[indices[frame]]
                    reach = float(np.linalg.norm(joints[wrist] - joints[shoulder]))
                    record["body"] = {"shoulder_wrist_m": reach, "reach_exceeds_configured_arm": reach > .6,
                        "upper_arm_m": float(np.linalg.norm(joints[elbow] - joints[shoulder])),
                        "forearm_m": float(np.linalg.norm(joints[wrist] - joints[elbow])),
                        "wrist_minus_head_y_m": float(joints[wrist, 1] - joints[0, 1]),
                        "configured_upper_arm_m": .33, "configured_forearm_m": .27}
                records.append(record); all_xyz.append(xyz); all_uv.append(observed)
    records.sort(key=lambda row: (row["frame_index"], row["side"]))
    xyz = np.asarray(all_xyz); observed = np.asarray(all_uv)
    relative = xyz - xyz[:, :1]
    candidates = []
    for permutation in itertools.permutations(range(3)):
        for signs in itertools.product([1, -1], repeat=3):
            matrix = np.eye(3)[list(permutation)] * np.array(signs)[:, None]
            transformed = relative @ matrix.T + xyz[:, :1]
            err, valid, _ = errors(transformed, observed, intrinsic)
            name = ",".join(("+" if sign > 0 else "-") + "xyz"[axis]
                            for sign, axis in zip(signs, permutation))
            candidates.append({"name": name, "matrix": matrix.tolist(),
                               "determinant": int(round(np.linalg.det(matrix))),
                               "invalid_joint_count": int((~valid).sum()),
                               "nonwrist_error_px": statistics(err[:, 1:]),
                               "wrist_fixed": True})
    candidates.sort(key=lambda row: row["nonwrist_error_px"]["median"])
    for record in records:
        saved = np.asarray(record["saved_xyz_camera_m"])
        observed_one = np.asarray(record["observed_2d_rgb_px"])
        relative_one = saved - saved[:1]
        frame_candidates = []
        for candidate in candidates:
            hypothesis = relative_one @ np.asarray(candidate["matrix"]).T + saved[:1]
            error = errors(hypothesis, observed_one, intrinsic)[0][1:]
            frame_candidates.append({"name": candidate["name"],
                                     "median_px": statistics(error)["median"]})
        best = min(frame_candidates, key=lambda item: item["median_px"])
        record["diagnostic_best_per_hand_axis_candidate"] = best
        row = {key: record[key] for key in ["frame_index", "side", "elapsed_s", "handedness_confidence",
               "wrist_depth_m", "wrist_optical_y_m", "wrist_world_minus_camera_y_m"]}
        row.update({"valid_joints": sum(record["finite_positive_depth_mask"]),
                    "inbounds_observed_joints": sum(record["observed_in_image_mask"]),
                    "saved_nonwrist_median_px": record["saved_error_nonwrist_px"]["median"],
                    "saved_nonwrist_rms_px": record["saved_error_nonwrist_px"]["rms"],
                    "diagnostic_best_axis_candidate": best["name"],
                    "diagnostic_best_axis_median_px": best["median_px"],
                    "anchor_joint": record["depth_anchor"]["anchor_joint"],
                    "anchor_depth_m": record["depth_anchor"]["depth_m"]})
        row.update(record.get("body", {}))
        for name in ["translation_only", "rigid_pnp"]:
            fit = record["diagnostic_fits"].get(name, {})
            row[name + "_median_px"] = fit.get("nonwrist_error_px", {}).get("median")
        csv_rows.append(row)
    csv_fields = list(dict.fromkeys(key for row in csv_rows for key in row))
    with (output / "per_hand_frame.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=csv_fields)
        writer.writeheader(); writer.writerows(csv_rows)
    panels = render(records, session, output)
    body_keys = ["shoulder_wrist_m", "upper_arm_m", "forearm_m", "wrist_minus_head_y_m"]
    report = {"schema_version": 1, "source_processed_directory": str(source),
        "input_sha256": before, "script_sha256": digest(__file__),
        "definitions": {
            "projection": "u = (K @ X)[0]/(K @ X)[2], v = (K @ X)[1]/(K @ X)[2]; saved RGB K; no distortion coefficients are available.",
            "error": "Euclidean pixel distance between saved 2D model landmark and projection of corresponding saved camera-space 3D joint. This is self-consistency, not error against ground truth.",
            "summary_population": "All saved valid hands, both sides; all non-wrist joints with finite observed/3D coordinates and positive camera depth. In-image-only results are reported separately; no confidence threshold.",
            "axis_candidates": "All 48 signed 3D axis permutations applied to wrist-relative joints only; saved wrist fixed; includes 90/180-degree rotations and improper reflections. No candidate is applied to source data.",
            "fits": "Translation-only least squares and per-frame rigid iterative PnP fit the SAME 2D predictions. Lower residual does not establish physical pose/depth correctness.",
            "confidence": "SDK stores MediaPipe handedness classification score as HandPose confidence; it is NOT per-joint confidence or metric 3D accuracy.",
            "depth_anchor": "SDK first valid 15x15 depth patch around wrist, then MCP joints [9,5,13,17]; median of values >50 and <2000 mm, requiring max(3,15% of patch) valid samples. Entire-hand fallback uses radius5. Temporal median is used only if no current anchor.",
            "body": "Saved model assumes head-mounted camera and fixed body dimensions. Current handheld recording does not observe torso. Measurements use existing y_up output and its existing optical transform."},
        "rgb_K": intrinsic.tolist(), "depth_K": depth_intrinsic.tolist(),
        "rgb_size_wh": rgb_size.tolist(), "depth_K_call_verified":
            "stera.models.HandTracker.detect_hands(SyncedFrame) passes frame.depth_K to backend; frame.rgb_K is fallback only.",
        "counts": {"hands": len(records), "right": sum(r["side"] == "right" for r in records),
                   "left": sum(r["side"] == "left" for r in records)},
        "saved_nonwrist_error_px": statistics([x for r in records for x in r["saved_error_per_joint_px"][1:]]),
        "saved_nonwrist_error_by_side_px": {side: statistics([x for r in records if r["side"] == side
            for x in r["saved_error_per_joint_px"][1:]]) for side in ["left", "right"]},
        "saved_inbounds_nonwrist_error_px": statistics([e for r in records for e, m in
            zip(r["saved_error_per_joint_px"][1:], r["observed_in_image_mask"][1:]) if m]),
        "diagnostic_fit_nonwrist_error_px": {key: statistics(values) for key, values in fitted_errors.items()},
        "signed_axis_candidates_ranked": candidates,
        "body_summary": {side: {**{key: statistics([r["body"][key] for r in records if
            r["side"] == side and "body" in r]) for key in body_keys},
            "unreachable_hands": sum(r.get("body", {}).get("reach_exceeds_configured_arm", False)
                                      for r in records if r["side"] == side)} for side in ["left", "right"]},
        "selected_image_records": panels, "per_hand_records": records,
        "inputs_unchanged": all(digest(path) == before[str(path)] for path in paths)}
    assert report["inputs_unchanged"]
    (output / "report.json").write_text(json.dumps(safe(report), indent=2, allow_nan=False) + "\n")
    print(json.dumps({"hands": len(records), "output": str(output),
        "identity_nonwrist_median_px": report["saved_nonwrist_error_px"]["median"],
        "best_signed_axis_candidate": candidates[0]["name"],
        "diagnostic_fits": report["diagnostic_fit_nonwrist_error_px"],
        "inputs_unchanged": report["inputs_unchanged"]}, indent=2))


if __name__ == "__main__":
    main()
