#!/usr/bin/env python3
"""Compare recorded RGB/depth orientation hypotheses; never repair geometry.

The edge correlation is a diagnostic, not a calibrated registration metric.
Run with .venv-stera/bin/python. All inputs are opened read-only.
"""

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import h5py
import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def edges(image):
    smooth = cv2.GaussianBlur(image.astype(np.float32), (5, 5), 1)
    return cv2.magnitude(
        cv2.Sobel(smooth, cv2.CV_32F, 1, 0),
        cv2.Sobel(smooth, cv2.CV_32F, 0, 1),
    )


def hand_anchor_hypothesis(h5, rgb_k, rgb_wh):
    """Isolate depth lookup rotation; deliberately leave K and hand shape fixed."""
    from stera.models.mediapipe.tracker import _sample_depth

    errors = {"saved": [], "depth_rotated_180_only": []}
    sample = None
    paired_hands = 0
    for side in ("left", "right"):
        for index in np.flatnonzero(h5[f"hand-pose/{side}_valid"][:]):
            points = h5[f"hand-pose/{side}_kpts_2d_rgb"][index]
            joints = h5[f"hand-pose/{side}_joints"][index]
            depth = h5["depth/frames"][index]
            height, width = depth.shape
            z = None
            for anchor in (0, 9, 5, 13, 17):
                z = _sample_depth(depth[::-1, ::-1], points[anchor, 0] * width / rgb_wh[0], points[anchor, 1] * height / rgb_wh[1], width, height, 7)
                if z is not None:
                    break
            if z is None or not np.isfinite(joints).all() or joints[0, 2] <= 0:
                continue
            wrist_candidate = joints[0] / joints[0, 2] * z
            candidate = joints - joints[0] + wrist_candidate
            if (joints[:, 2] <= 0).any() or (candidate[:, 2] <= 0).any():
                continue
            paired_hands += 1
            for name, xyz in (("saved", joints), ("depth_rotated_180_only", candidate)):
                uv = xyz @ rgb_k.T
                uv = uv[:, :2] / uv[:, 2:]
                errors[name].extend(np.linalg.norm(uv[1:] - points[1:], axis=1).tolist())
            if index == 79 and side == "right":
                sample = {"frame": 79, "saved_wrist_depth_m": float(joints[0, 2]), "hypothetical_wrist_depth_m": float(z)}
    return {
        "meaning": "Diagnostic hypothesis only: rotate the lookup depth 180 degrees, repeat SDK first-valid depth anchoring, preserve saved wrist ray and relative 3D hand shape. RGB K stays unchanged, deliberately isolating depth lookup. This is NOT a complete calibration correction or validated output.",
        "paired_hands": paired_hands,
        "nonwrist_disagreement_px": {name: {"count": len(values), "median": float(np.median(values)), "p90": float(np.percentile(values, 90))} for name, values in errors.items() if values},
        "frame79_example": sample,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("processed", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    processed = args.processed.resolve(strict=True)
    output = args.output.resolve()
    if output.exists():
        parser.error("Use a new output directory; existing audit evidence is preserved")
    annotations = processed / "episode/annotation.hdf5"
    intrinsics = processed / "episode/calibrations/rgb_K.npy"
    rgb_dir = processed.parent / "inspection/rgb_frames"
    selected = [30, 50, 70, 100, 130, 160, 190, 220]
    transforms = {
        "recorded": lambda x: x,
        "rotate_180": lambda x: x[::-1, ::-1],
        "flip_horizontal": lambda x: x[:, ::-1],
        "flip_vertical": lambda x: x[::-1, :],
    }
    output.mkdir(parents=True)
    rows = []
    sources = {str(annotations): digest(annotations), str(intrinsics): digest(intrinsics)}
    fig, axes = plt.subplots(2, 3, figsize=(15, 7.5))
    with h5py.File(annotations, "r") as h5:
        for index in selected:
            image_path = rgb_dir / f"{index:06d}.jpg"
            sources[str(image_path)] = digest(image_path)
            rgb = cv2.cvtColor(cv2.imread(str(image_path)), cv2.COLOR_BGR2RGB)
            depth = h5["depth/frames"][index].astype(np.float32) / 1000
            gray = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), depth.shape[::-1], interpolation=cv2.INTER_AREA)
            rgb_edges = edges(gray)
            inverse = np.divide(1.0, depth, out=np.zeros_like(depth), where=depth > 0)
            scores = {}
            for name, transform in transforms.items():
                valid = (transform(depth) > 0).astype(np.uint8)
                valid = cv2.erode(valid, np.ones((7, 7), dtype=np.uint8)).astype(bool)
                valid[:4] = valid[-4:] = False
                valid[:, :4] = valid[:, -4:] = False
                a, b = rgb_edges[valid], edges(transform(inverse))[valid]
                scores[name] = float(np.corrcoef(a, b)[0, 1]) if len(a) and a.std() > 0 and b.std() > 0 else None
            rows.append({"frame": index, "edge_correlation": scores})
            if index in (70, 130):
                row = (70, 130).index(index)
                axes[row, 0].imshow(rgb)
                axes[row, 0].set_title(f"Recorded RGB — frame {index}")
                valid_depth = depth[depth > 0]
                low, high = np.percentile(valid_depth, [2, 98])
                for col, name in enumerate(("recorded", "rotate_180"), start=1):
                    axes[row, col].imshow(transforms[name](depth), cmap="viridis", vmin=low, vmax=high)
                    axes[row, col].set_title(f"Depth: {name}\nedge correlation {scores[name]:.3f}")
                for ax in axes[row]:
                    ax.axis("off")
        hand_hypothesis = hand_anchor_hypothesis(h5, np.load(intrinsics), rgb.shape[1::-1])
    fig.suptitle("Orientation hypotheses only: rotation/crop/intrinsics were not saved together.\nA better edge match does not establish metric depth or correct hand pose.")
    fig.tight_layout()
    fig.savefig(output / "depth_orientation.png", dpi=130)
    plt.close(fig)
    report = {
        "status": "diagnostic_only_not_a_geometry_correction",
        "method": "Pearson correlation of gradient magnitudes: grayscale RGB downsampled to depth size versus inverse depth; Gaussian 5x5 sigma=1, Sobel, valid-depth mask eroded 7x7, 4px border excluded",
        "limitations": [
            "Photometric and depth edges are not equivalent; correlation is not proof of registration.",
            "Only rotation/reflection hypotheses are compared; crop, focal length, native sensor timing and metric accuracy remain unverified.",
            "No depth, landmarks, camera poses or existing exports were modified.",
        ],
        "median_edge_correlation": {name: float(np.median([r["edge_correlation"][name] for r in rows if r["edge_correlation"][name] is not None])) for name in transforms},
        "frames": rows,
        "hand_anchor_hypothesis": hand_hypothesis,
        "sources_sha256": sources,
        "script_sha256": digest(Path(__file__)),
    }
    (output / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(report["median_edge_correlation"], indent=2))


if __name__ == "__main__":
    main()
