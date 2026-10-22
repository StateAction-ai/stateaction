#!/usr/bin/env python3
"""Run the official Stera Process/Evaluate example locally and retain evidence.

Use .venv-stera/bin/python, with dependencies in requirements-stera.txt.
Raw MCAP data is opened read-only. Existing completed output is never replaced.
"""

from __future__ import annotations

import argparse
import csv
import dataclasses
import hashlib
import importlib.metadata
import json
import logging
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import traceback

from report_clock import apply_report_clock
from skeleton_world_up import adapt_skeleton_world_up


ROOT = Path(__file__).resolve().parents[1]
SDK_COMMIT = "df6a5ec8919053c5cd448db83d4816e1faaaec62"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command(args: list[str], cwd: Path | None = None) -> str:
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def clean_json(value, path="$", nonfinite=None):
    """Serialize SDK dataclasses/NumPy values; explicitly record NaN/Inf paths."""
    import numpy as np

    if dataclasses.is_dataclass(value):
        value = dataclasses.asdict(value)
    if isinstance(value, np.ndarray):
        value = value.tolist()
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, dict):
        return {str(k): clean_json(v, f"{path}.{k}", nonfinite) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean_json(v, f"{path}[{i}]", nonfinite) for i, v in enumerate(value)]
    if isinstance(value, float) and not math.isfinite(value):
        if nonfinite is not None:
            nonfinite.append({"path": path, "original_value": str(value)})
        return None
    if isinstance(value, Path):
        return str(value)
    return value


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(clean_json(value), indent=2, allow_nan=False) + "\n")


def adapt_rerun_022(rr) -> list[str]:
    """Bridge the newer calls used by Stera to equivalent Rerun 0.22 APIs.

    Stera requires numpy<2, while Rerun 0.23+ requires numpy>=2. These aliases
    preserve the float64 timestamp seconds and scalar values passed by Stera.
    They affect only this Python process; no installed or SDK file is changed.
    """
    adaptations = []
    if not hasattr(rr, "set_time"):
        def set_time(timeline, *, timestamp):
            return rr.set_time_seconds(timeline, timestamp)
        rr.set_time = set_time
        adaptations.append("rr.set_time(timeline, timestamp=s) -> rr.set_time_seconds(timeline, s)")
    if not hasattr(rr, "TimeColumn"):
        def time_column(timeline, *, timestamp):
            return rr.TimeSecondsColumn(timeline, timestamp)
        rr.TimeColumn = time_column
        adaptations.append("rr.TimeColumn(timeline, timestamp=values) -> rr.TimeSecondsColumn(timeline, values)")
    if not hasattr(rr, "Scalars"):
        class Scalars:
            def __new__(cls, scalars):
                if len(scalars) != 1:
                    raise ValueError("Rerun 0.22 scalar adapter accepts one scalar per log call")
                return rr.Scalar(scalars[0])

            @staticmethod
            def columns(*, scalars):
                return rr.Scalar.columns(scalar=scalars)
        rr.Scalars = Scalars
        adaptations.append("rr.Scalars([v]) -> rr.Scalar(v); Scalars.columns(scalars=x) -> Scalar.columns(scalar=x)")
    if not hasattr(rr, "flush_blocking"):
        def flush_blocking():
            recording = rr.get_data_recording()
            if recording is not None:
                recording.flush(blocking=True)
        rr.flush_blocking = flush_blocking
        adaptations.append("rr.flush_blocking() -> active RecordingStream.flush(blocking=True)")
    return adaptations


def seal_rerun_recording(rr) -> None:
    """Close the file sink before checksumming; flush alone omits its footer."""
    rr.flush_blocking()
    rr.disconnect()
    rr.rerun_shutdown()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mcap", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--no-rerun-compat", action="store_true", help="Reproduce the unadapted upstream Rerun compatibility failure")
    args = parser.parse_args()
    raw = args.mcap.resolve(strict=True)
    output = (args.output or raw.parent / "stera_processed").resolve()
    if output == raw.parent or output in raw.parents:
        parser.error("Output must be a separate derived-data directory")
    if (output / "receipt.json").exists() or (output / "episode").exists():
        parser.error("Output already contains a run; use a new --output directory")
    output.mkdir(parents=True, exist_ok=True)
    (output / "models").mkdir(exist_ok=True)
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ.setdefault("MPLCONFIGDIR", str(output / "cache" / "matplotlib"))
    os.environ.setdefault("MPLBACKEND", "Agg")
    os.environ.setdefault("RERUN_ANALYTICS_ENABLED", "false")

    import h5py
    import numpy as np
    import rerun as rr
    import stera
    from stera import Evaluate
    from stera.data import MCAPReader
    from stera.models import HandTracker, UpperBodyEstimator
    from stera.models.mediapipe import tracker as mp_tracker
    from stera.models.skeleton.estimator import JOINT_NAMES
    from stera.viz import Visualizer

    rerun_adaptations = [] if args.no_rerun_compat else adapt_rerun_022(rr)
    stera.setup_logging()
    sdk_logger = logging.getLogger("stera")
    file_handler = logging.FileHandler(output / "sdk.log")
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    sdk_logger.addHandler(file_handler)

    sdk = ROOT / "stera-sdk"
    commit = command(["git", "rev-parse", "HEAD"], cwd=sdk)
    if commit != SDK_COMMIT:
        raise RuntimeError(f"Expected SDK {SDK_COMMIT}, found {commit}")
    if command(["git", "diff", "HEAD", "--", "src", "pyproject.toml"], cwd=sdk):
        raise RuntimeError("SDK source has changes; reproducible execution requires pinned source")

    # Cache-location override only; the SDK downloads its unmodified official model.
    # Keep downloaded assets in this derived-data tree instead of ~/.cache.
    mp_tracker._MODEL_CACHE = str(output / "models" / "hand_landmarker.task")
    started = time.time()
    receipt = {
        "status": "running",
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
        "command": [sys.executable, *sys.argv],
        "raw_mcap": {"path": str(raw), "size_bytes": raw.stat().st_size, "sha256_before": sha256(raw)},
        "sdk": {"version": stera.__version__, "commit": commit, "tracked_source_modified": False},
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "packages": dict(sorted((d.metadata["Name"], d.version) for d in importlib.metadata.distributions())),
            "ffmpeg": command(["ffmpeg", "-version"]).splitlines()[0],
            "compute": "MediaPipe CPU; CUDA_VISIBLE_DEVICES is empty; no cloud compute",
        },
        "pipeline": {
            "hand_tracker": "HandTracker(model='mediapipe') with SDK defaults",
            "skeleton": "UpperBodyEstimator with default dimensions; verified Android ARCore captures use +Y world-up after unchanged warmup",
            "visualizer": {"map_3d": "both", "mesh_refine": {"color_speed": 0.5}},
            "evaluation": "Evaluate(session), instantiated after processing; default EvaluateConfig",
            "headless": "Visualizer(output=episode/visualization.rrd); Evaluate.export(evaluation.upstream.html); clock-aware presentation in evaluation.html",
            "model_cache_override": mp_tracker._MODEL_CACHE,
            "sdk_source_patches": [],
            "rerun_runtime_adapter": rerun_adaptations,
            "point_cloud_filtering": "none; unchanged documented SDK selection and processing",
        },
        "model": {"url": mp_tracker._MODEL_URL},
        "limitations": [
            "Hand and skeleton outputs are model-derived estimates, not ground-truth annotations.",
            "The SDK health score is a heuristic QC score, not physical accuracy or downstream training utility.",
            "Default cloud selection uses the last mesh_cloud or FIRST point_cloud message, not all sparse-cloud messages.",
            "SDK cloud statistics do not filter nonfinite coordinates; separate JSON uses null with paths recorded.",
            "A missing triangle-mesh stream means requested mesh refinement is skipped, not reconstructed.",
            "SDK RGB MP4 export uses constant average frame rate; refer to timestamps for original temporal spacing.",
            "SDK depth.valid marks matched frames, not valid pixels; exported depth timestamps use the RGB frame clock.",
            "Independent native depth timestamps were discarded by this capture app, so physical synchronization cannot be verified.",
            "Skeletons use default body dimensions; verified Android ARCore captures pin world-up to +Y. No subject-specific or mount calibration was supplied.",
            "For this handheld Pixel capture, the estimator's head-mounted-camera body assumptions are unsuitable; skeletons are illustrative only.",
            "Skeleton estimates are saved separately and visualized, but are not passed to the official Evaluate(session) call.",
            "Android native timestamps are device uptime. The report preserves native bounds and marks UTC start/end unavailable; the session name is only a local-clock hint, without a recorded UTC anchor.",
            "No face blurring was requested by the Process example; derived RGB retains original content.",
        ],
    }
    write_json(output / "receipt.json", receipt)
    hands = None
    try:
        session = MCAPReader(str(raw))
        expected = session.num_rgb_frames
        receipt["input"] = {"rgb_frames": expected, "depth_frames": session.num_depth_frames, "sdk_duration_s": session.duration}
        cloud, colors = session.point_cloud()
        finite_cloud = np.isfinite(cloud).all(axis=1)
        receipt["selected_point_cloud"] = {
            "points": len(cloud), "finite_points": int(finite_cloud.sum()),
            "nonfinite_points": int((~finite_cloud).sum()),
            "retained_unchanged_in_visualizer": True,
        }
        has_mesh = session.mesh() is not None
        receipt["input"]["triangle_mesh_present"] = has_mesh
        receipt["pipeline"]["mesh_refinement_executed"] = has_mesh
        episode = output / "episode"
        episode.mkdir()
        hands = HandTracker(model="mediapipe")
        receipt["model"].update({"path": mp_tracker._MODEL_CACHE, "sha256": sha256(Path(mp_tracker._MODEL_CACHE)), "size_bytes": Path(mp_tracker._MODEL_CACHE).stat().st_size})
        receipt["pipeline"]["hand_config"] = dataclasses.asdict(hands._backend.config)
        estimator = UpperBodyEstimator(session=session)
        receipt["pipeline"]["skeleton_world_up_adapter"] = adapt_skeleton_world_up(
            estimator, session, raw, raw.parent / "metadata.json", commit,
        )
        receipt["pipeline"]["skeleton_config"] = dataclasses.asdict(estimator.config)
        viz = Visualizer(session, output=str(episode / "visualization.rrd"), map_3d="both", mesh_refine={"color_speed": 0.5})

        rows, skeleton_indices, skeleton_joints, skeleton_visible = [], [], [], []
        for frame in session.frames():
            hand_poses = hands.detect_hands(frame)
            skeleton = estimator.estimate(frame, hands=hand_poses)
            session.add_hand_pose(frame.index, hand_poses)
            viz.log_frame(frame, hands=hand_poses, skeleton=skeleton)
            row = {"frame_index": frame.index, "timestamp": frame.timestamp,
                   "num_hands": len(hand_poses), "left": False, "right": False,
                   "left_3d": False, "right_3d": False,
                   "left_confidence": "", "right_confidence": "",
                   "skeleton": skeleton is not None}
            for hand in hand_poses:
                side = hand.hand_side
                row[side] = True
                row[f"{side}_3d"] = bool(hand.wrist.z != 0 and np.isfinite([hand.wrist.x, hand.wrist.y, hand.wrist.z]).all())
                row[f"{side}_confidence"] = hand.confidence
            rows.append(row)
            if skeleton is not None:
                skeleton_indices.append(frame.index)
                skeleton_joints.append(skeleton.joints)
                skeleton_visible.append(skeleton.visible)
            if len(rows) % 25 == 0 or len(rows) == expected:
                print(f"Processed {len(rows)}/{expected} frames; any hand in {sum(r['num_hands'] > 0 for r in rows)}", flush=True)
        if len(rows) != expected or [r["frame_index"] for r in rows] != list(range(expected)):
            raise RuntimeError("Frame count or indices do not match input")
        with (output / "hand_coverage.csv").open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        np.savez_compressed(output / "skeleton_estimates.npz", frame_indices=np.asarray(skeleton_indices), joints=np.asarray(skeleton_joints), visible=np.asarray(skeleton_visible), joint_names=np.asarray(JOINT_NAMES))
        receipt["processing"] = {
            "frames": len(rows), "frames_with_any_hand": sum(r["num_hands"] > 0 for r in rows),
            "frames_with_two_hands": sum(r["num_hands"] == 2 for r in rows),
            "left_hand_frames": sum(r["left"] for r in rows), "right_hand_frames": sum(r["right"] for r in rows),
            "left_hand_3d_frames": sum(r["left_3d"] for r in rows), "right_hand_3d_frames": sum(r["right_3d"] for r in rows),
            "skeleton_frames": len(skeleton_indices), "skeleton_missing_indices": [r["frame_index"] for r in rows if not r["skeleton"]],
        }
        print("Exporting standard episode", flush=True)
        manifest = session.export(str(episode), visualizer=viz)
        write_json(output / "export_manifest.json", manifest)
        receipt["export_manifest"] = manifest
        print("Computing and exporting official Evaluate report", flush=True)
        evaluation = Evaluate(session)
        metrics = evaluation.compute()
        nonfinite = []
        normalized = clean_json(metrics, nonfinite=nonfinite)
        write_json(output / "evaluation_metrics.upstream.json", normalized)
        write_json(output / "evaluation_nonfinite_values.json", nonfinite)
        evaluation.export(output / "evaluation.upstream.html")
        receipt["evaluation_clock"] = apply_report_clock(output, raw.parent / "metadata.json")
        receipt["evaluation_nonfinite_values"] = nonfinite

        validation = {}
        with h5py.File(episode / "annotation.hdf5", "r") as h5:
            for key in ("depth/frames", "depth/timestamps", "depth/valid", "hand-pose/left_valid", "hand-pose/right_valid", "hand-pose/timestamps"):
                shape = list(h5[key].shape)
                if shape[0] != expected:
                    raise RuntimeError(f"Wrong exported count for {key}: {shape}")
                validation[key] = {"shape": shape, "dtype": str(h5[key].dtype)}
            validation["depth_matched_frames"] = int(h5["depth/valid"][:].sum())
            validation["pose_samples"] = len(h5["cam-pose/timestamps"])
            validation["imu_samples"] = len(h5["imu/timestamps"])
            for side in ("left", "right"):
                count = int(h5[f"hand-pose/{side}_valid"][:].sum())
                if count != receipt["processing"][f"{side}_hand_frames"]:
                    raise RuntimeError("Exported hand validity differs from actual detections")
            for key in h5:
                if isinstance(h5[key], h5py.Group):
                    for name, dataset in h5[key].items():
                        if isinstance(dataset, h5py.Dataset):
                            # Read back every dataset, including compressed depth, to detect corruption.
                            for start in range(0, len(dataset), 32):
                                dataset[start:start + 32]
        probe = json.loads(command(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate,duration", "-of", "json", str(episode / "rgb.mp4")]))
        if int(probe["streams"][0]["nb_read_frames"]) != expected:
            raise RuntimeError("Exported RGB frame count differs from input")
        write_json(output / "video_probe.json", probe)
        for path in (episode / "visualization.rrd", output / "evaluation.html"):
            if path.stat().st_size < 1024:
                raise RuntimeError(f"Missing or empty artifact: {path}")
        html = (output / "evaluation.html").read_text()
        if "<html" not in html.lower() or "plotly" not in html.lower():
            raise RuntimeError("Evaluation report is not the expected HTML/Plotly artifact")
        for path in (episode / "calibrations").glob("*.npy"):
            np.load(path, allow_pickle=False)
        json.loads((episode / "calibrations" / "meta.json").read_text())
        with np.load(output / "skeleton_estimates.npz", allow_pickle=False) as skeleton_archive:
            if len(skeleton_archive["frame_indices"]) != len(skeleton_indices):
                raise RuntimeError("Skeleton archive frame count differs")
        receipt["validation"] = {"passed": True, "hdf5": validation, "video": probe, "report_html_nonempty": True, "rerun_nonempty": True}
        receipt["status"] = "complete"
        print(json.dumps(receipt["processing"], indent=2), flush=True)
        return 0
    except BaseException as error:
        receipt["status"] = "failed"
        receipt["error"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
        raise
    finally:
        if hands is not None:
            hands._backend.close()
        sealing_error = None
        try:
            seal_rerun_recording(rr)
            receipt["rerun_finalization"] = {
                "completed": True,
                "operations": ["flush_blocking", "disconnect", "rerun_shutdown"],
                "artifact_hashes_recorded_after_file_close": True,
            }
        except Exception as error:
            sealing_error = error
            receipt["status"] = "failed"
            receipt["rerun_finalization"] = {"completed": False, "error": str(error)}
        receipt["elapsed_s"] = time.time() - started
        receipt["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        receipt["raw_mcap"]["sha256_after"] = sha256(raw)
        receipt["raw_mcap"]["unchanged"] = receipt["raw_mcap"]["sha256_before"] == receipt["raw_mcap"]["sha256_after"]
        receipt["script_sha256"] = sha256(Path(__file__))
        lock = ROOT / "requirements-stera.txt"
        if lock.exists():
            receipt["requirements_sha256"] = sha256(lock)
        receipt["artifacts"] = {
            str(path.relative_to(output)): {"bytes": path.stat().st_size, "sha256": sha256(path)}
            for path in sorted(output.rglob("*")) if path.is_file()
            and path.name not in ("receipt.json", "sdk.log", "run.log") and "cache" not in path.parts
            and not (sealing_error is not None and path == output / "episode" / "visualization.rrd")
        }
        write_json(output / "receipt.json", receipt)
        if sealing_error is not None:
            raise RuntimeError("Rerun recording could not be closed; no final RRD checksum was recorded") from sealing_error
        if not receipt["raw_mcap"]["unchanged"]:
            raise RuntimeError("Raw MCAP hash changed during processing")


if __name__ == "__main__":
    raise SystemExit(main())
