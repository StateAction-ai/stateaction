#!/usr/bin/env python3
"""Public RGB → production MediaPipe adapter → observations/overlays/Rerun.

The optional EgoViz extractor handles its actual protobuf H.264 channel. This
is deliberately separate from the Android GeometrySession contract. No depth,
intrinsics, camera pose, visibility, or accepted metric hand pose is invented.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

import cv2
import h5py
import numpy as np

from hand_geometry import detect_observations

ROOT = Path(__file__).resolve().parents[1]
CLIP = "c59801fe4172cf9b430cd9232dda3909"
SOURCE_DIR = ROOT / "captures" / "public-egocentric" / ("egoviz_" + CLIP)
SOURCE_URL = ("https://huggingface.co/buckets/humaidtech/EgoViz-120/resolve/"
              f"data/cleaning_restroom/{CLIP}/{CLIP}.mcap")
SOURCE_SHA = "c86d1d69df71953b0b7fe1d61cfbc919743d1c108a2a0adc30b5c1a449e2e7d4"
SOURCE_CARD = "https://huggingface.co/datasets/humaidtech/EgoViz-120"
TOPIC = "/ego/zed_head/left/image/compressed"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def download_default():
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    destination = SOURCE_DIR / (CLIP + ".mcap")
    if not destination.exists():
        partial = destination.with_suffix(".mcap.part")
        with urllib.request.urlopen(SOURCE_URL + "?download=true", timeout=30) as response, partial.open("wb") as stream:
            count = 0
            while block := response.read(1024 * 1024):
                count += len(block)
                if count > 160_000_000:
                    raise ValueError("Public sample exceeded the 160 MB download limit")
                stream.write(block)
        if digest(partial) != SOURCE_SHA:
            raise ValueError("Public MCAP differs from the reviewed source hash")
        partial.rename(destination)
    if digest(destination) != SOURCE_SHA:
        raise ValueError("Cached public MCAP differs from the reviewed source hash")
    return destination


def extract_egoviz(source, output):
    """Extract clean native ego-left RGB; retain original clocks and calibration.

    This restricted extractor requires one decoded frame per video message and
    no H.264 B-frame reordering. It does not adapt the other sensors to Stera.
    """
    from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
    from mcap.reader import make_reader
    from mcap_ros2.decoder import DecoderFactory

    elementary = output / "source_rgb.h264"
    timestamps, log_times, publish_times = [], [], []
    with source.open("rb") as stream, elementary.open("wb") as encoded:
        reader = make_reader(stream)
        summary = reader.get_summary()
        channels = [{"topic": channel.topic, "message_encoding": channel.message_encoding,
                     "schema": summary.schemas[channel.schema_id].name,
                     "message_count": summary.statistics.channel_message_counts.get(channel.id, 0)}
                    for channel in summary.channels.values()]
        parser = None
        for schema, channel, message in reader.iter_messages(topics=[TOPIC]):
            if channel.message_encoding != "protobuf" or schema.name != "foxglove.CompressedVideo":
                raise ValueError("Expected EgoViz foxglove.CompressedVideo protobuf stream")
            if parser is None:
                pool = descriptor_pool.DescriptorPool()
                descriptors = descriptor_pb2.FileDescriptorSet.FromString(schema.data)
                for descriptor in descriptors.file:
                    pool.Add(descriptor)
                parser = message_factory.GetMessageClass(pool.FindMessageTypeByName(schema.name))
            packet = parser.FromString(message.data)
            if packet.format != "h264":
                raise ValueError("Only the reviewed H.264 packet format is supported")
            encoded.write(packet.data)
            timestamps.append(int(packet.timestamp.seconds) * 1_000_000_000 + int(packet.timestamp.nanos))
            log_times.append(int(message.log_time))
            publish_times.append(int(message.publish_time))
    if len(timestamps) < 2 or np.any(np.diff(timestamps) <= 0):
        raise ValueError("Need strictly increasing native RGB packet timestamps")
    nominal_fps = 1e9 / float(np.median(np.diff(timestamps)))
    video = output / "source_rgb.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "h264",
                    "-framerate", str(nominal_fps), "-i", str(elementary),
                    "-c", "copy", "-movflags", "+faststart", str(video)], check=True)
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "stream=has_b_frames,nb_frames,width,height",
        "-of", "json", str(video)]))["streams"][0]
    if probe["has_b_frames"] != 0 or int(probe["nb_frames"]) != len(timestamps):
        raise ValueError("Packet/frame correspondence is unverified; refuse timestamp association")
    calibration = {}
    topics = [c["topic"] for c in channels if c["topic"].endswith("camera_info")]
    with source.open("rb") as stream:
        reader = make_reader(stream, decoder_factories=[DecoderFactory()])
        for _, channel, message, decoded in reader.iter_decoded_messages(topics=topics):
            row = {"width": int(decoded.width), "height": int(decoded.height),
                   "K": list(decoded.k), "D": list(decoded.d), "R": list(decoded.r),
                   "P": list(decoded.p), "distortion_model": decoded.distortion_model,
                   "frame_id": decoded.header.frame_id}
            record = calibration.setdefault(channel.topic, {"first": row, "count": 0,
                                                            "all_equal_first": True})
            record["count"] += 1
            record["all_equal_first"] &= record["first"] == row
    source_info = {"source_topic": TOPIC, "packet_count": len(timestamps),
                   "nominal_mp4_fps": nominal_fps, "source_channels": channels,
                   "calibration_records": calibration,
                   "calibration_used_for_hand_reconstruction": False,
                   "source_clock_relation_independently_validated": False,
                   "publisher_hand_labels_used": False,
                   "presentation_note": "MP4 uses nominal FPS; exact native RGB packet/header, log and publish times are preserved separately."}
    json_write(output / "source_streams.json", source_info)
    return video, {"rgb_native_timestamp_ns": np.array(timestamps, np.int64),
                   "mcap_log_time_ns": np.array(log_times, np.int64),
                   "mcap_publish_time_ns": np.array(publish_times, np.int64)}, source_info


def draw_observations(frame, observations, frame_index):
    from stera.viz.session import HAND_EDGES
    overlay = frame.copy()
    for observation in observations:
        points = observation["landmarks_rgb_px"]
        color = (40, 220, 80) if observation["hand_side"] == "left" else (0, 190, 255)
        for a, b in HAND_EDGES:
            if np.isfinite(points[[a, b]]).all():
                cv2.line(overlay, tuple(np.rint(points[a]).astype(int)), tuple(np.rint(points[b]).astype(int)), color, 3)
        for point in points:
            if np.isfinite(point).all():
                cv2.circle(overlay, tuple(np.rint(point).astype(int)), 4, color, -1)
        if np.isfinite(points[0]).all():
            location = tuple(np.maximum(np.rint(points[0]).astype(int) + [0, -15], [0, 20]))
            cv2.putText(overlay, observation["hand_side"] + " prediction", location,
                        cv2.FONT_HERSHEY_SIMPLEX, .8, color, 2)
    height = round(frame.shape[0] * 960 / frame.shape[1])
    if height % 2:
        height += 1
    left = cv2.resize(frame, (960, height))
    right = cv2.resize(overlay, (960, height))
    for image, label in [(left, "Source RGB"), (right, "Our 2D predictions | metric 3D unverified")]:
        cv2.rectangle(image, (0, 0), (960, 42), (0, 0, 0), -1)
        cv2.putText(image, f"{label} | frame {frame_index}", (12, 28), cv2.FONT_HERSHEY_SIMPLEX, .65, (255, 255, 255), 1)
    return overlay, np.concatenate([left, right], axis=1)


def write_observation_archive(path, frames, clocks, source_hash):
    """Preserve each supplied observation independently of its predicted side."""
    n = len(frames)
    slots = max(2, max((len(observations) for observations in frames), default=0))
    normalized = np.full((n, slots, 21, 3), np.nan)
    pixels = np.full((n, slots, 21, 2), np.nan)
    world = np.full((n, slots, 21, 3), np.nan)
    relative = world.copy()
    handedness = np.full((n, slots), np.nan)
    present = np.zeros((n, slots), bool)
    predicted_side = np.full((n, slots), "", dtype=object)
    for index, observations in enumerate(frames):
        for slot, observation in enumerate(observations):
            normalized[index, slot] = observation["raw_image_landmarks_normalized"]
            pixels[index, slot] = observation["landmarks_rgb_px"]
            world[index, slot] = observation["raw_world_landmarks_m"]
            relative[index, slot] = observation["relative_joints_m"]
            handedness[index, slot] = observation["handedness_score"]
            present[index, slot] = True
            predicted_side[index, slot] = observation["hand_side"]
    with h5py.File(path, "w") as archive:
        archive.attrs.update({"schema": "public_rgb_observations_v1",
                              "detection_axis": "per-frame observation slot, not an anatomical side or temporal track",
                              "metric_accuracy_validated": False, "visibility": "unknown",
                              "handedness_score_semantics": "side classification score; not joint/pose confidence",
                              "source_sha256": source_hash})
        archive.create_dataset("frame_index", data=np.arange(n))
        for name, values in clocks.items():
            archive.create_dataset("source_clocks/" + name, data=values[:n])
        for name, values in [("image_landmarks_normalized", normalized), ("image_landmarks_pixels", pixels),
                             ("world_landmarks_m", world), ("wrist_relative_joints_m", relative),
                             ("handedness_score", handedness), ("detected", present)]:
            archive.create_dataset("model_estimates/" + name, data=values, compression="gzip")
        archive.create_dataset("model_estimates/predicted_side", data=predicted_side, dtype=h5py.string_dtype())
        archive["model_estimates"].attrs["semantics"] = "Independent MediaPipe model outputs; world/meter labels are model convention, not calibrated camera/world measurements."
        archive.create_dataset("accepted_metric_hand_valid", data=np.zeros((n, slots), bool))
        archive.create_dataset("accepted_metric_joint_valid", data=np.zeros((n, slots, 21), bool))


def run(source, output, max_seconds):
    from stera.models import HandTracker
    from stera.models.mediapipe import tracker as mp_tracker
    import rerun as rr
    import rerun.blueprint as rrb

    started_utc = datetime.now(timezone.utc).isoformat()
    output.mkdir(parents=True, exist_ok=False)
    source_hash = digest(source)
    source_info, clocks = {}, {}
    video = source
    if source.suffix.lower() == ".mcap":
        video, clocks, source_info = extract_egoviz(source, output)
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise ValueError("Input video cannot be decoded")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if not np.isfinite(fps) or fps <= 0:
        raise ValueError("Input video lacks a usable presentation frame rate")
    n_source = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if clocks and len(clocks["rgb_native_timestamp_ns"]) != n_source:
        raise ValueError("Decoded source count disagrees with native RGB packet count")
    # Reuse the exact production SDK model and detect_observations adapter.
    cached = next((ROOT / "captures").glob("*/stera_processed*/models/hand_landmarker.task"), None)
    if cached is not None:
        mp_tracker._MODEL_CACHE = str(cached)
    tracker = HandTracker(model="mediapipe")
    model_path = Path(mp_tracker._ensure_model())
    rr.init("public_egocentric_rgb_validation", spawn=False)
    rr.save(output / "visualization.rrd")
    rr.send_blueprint(rrb.Horizontal(rrb.Spatial2DView(origin="source", name="Source RGB"),
                                    rrb.Spatial2DView(origin="predictions", name="Our 2D predictions")))
    rr.log("validation", rr.TextDocument("RGB-only model predictions. No accepted metric 3D, depth, pose, IMU, or visibility truth."), static=True)
    frames, detection_counts, out_of_bounds, detections = [], Counter(), 0, 0
    production_selected_count = 0
    coverage, sampled, writer = [], {}, None
    max_frames = min(n_source, int(max_seconds * fps))
    samples = set(np.linspace(0, max_frames - 1, 6).astype(int))
    start = time.monotonic()
    try:
        with (output / "observations.jsonl").open("w") as observations_file:
            for index in range(max_frames):
                ok, bgr = capture.read()
                if not ok:
                    raise RuntimeError(f"Decode stopped at frame {index}, expected {max_frames}")
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                observations = detect_observations(tracker._backend, rgb, deduplicate_by_side=False)
                production_selected_count += len({observation["hand_side"] for observation in observations})
                elapsed = ((int(clocks["rgb_native_timestamp_ns"][index]) - int(clocks["rgb_native_timestamp_ns"][0])) / 1e9
                           if clocks else index / fps)
                frame_row = {"frame_index": index, "relative_rgb_time_s": elapsed,
                             "native_clocks": {name: int(values[index]) for name, values in clocks.items()},
                             "metric_hand_pose_valid": False, "visibility": "unknown",
                             "observations": [{key: value.tolist() if isinstance(value, np.ndarray) else value
                                               for key, value in observation.items()}
                                              for observation in observations]}
                observations_file.write(json.dumps(frame_row, allow_nan=False) + "\n")
                frames.append(observations)
                coverage.append(len(observations))
                for observation in observations:
                    detection_counts[observation["hand_side"]] += 1
                    uv = observation["landmarks_rgb_px"]
                    out_of_bounds += int(np.any((uv < 0) | (uv >= [rgb.shape[1], rgb.shape[0]]), axis=1).sum())
                    detections += 1
                overlay, comparison = draw_observations(bgr, observations, index)
                if writer is None:
                    writer = cv2.VideoWriter(str(output / "comparison_temp.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps,
                                             (comparison.shape[1], comparison.shape[0]))
                    if not writer.isOpened():
                        raise RuntimeError("Cannot open comparison video writer")
                writer.write(comparison)
                rr.set_time_sequence("frame", index)
                rr.set_time_seconds("rgb_elapsed", elapsed)
                rr.log("source", rr.Image(rgb).compress(jpeg_quality=80))
                rr.log("predictions", rr.Image(cv2.cvtColor(overlay, cv2.COLOR_BGR2RGB)).compress(jpeg_quality=80))
                if index in samples:
                    sampled[index] = cv2.resize(comparison, (960, comparison.shape[0] // 2))
                if index % 100 == 0:
                    print(f"Processed {index + 1}/{max_frames} frames; {detections} hand observations", flush=True)
    finally:
        capture.release()
        if writer is not None:
            writer.release()
        tracker._backend.close()
        rr.disconnect()
    if not frames:
        raise RuntimeError("No frames processed")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(output / "comparison_temp.mp4"),
                    "-c:v", "libx264", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                    str(output / "comparison.mp4")], check=True)
    (output / "comparison_temp.mp4").unlink()
    tiles = list(sampled.values())
    while len(tiles) < 6:
        tiles.append(np.zeros_like(tiles[0]))
    sheet = np.concatenate([np.concatenate(tiles[i:i + 2], axis=1) for i in (0, 2, 4)], axis=0)
    if not cv2.imwrite(str(output / "contact_sheet.jpg"), sheet):
        raise RuntimeError("Could not write contact sheet")
    n = len(frames)
    write_observation_archive(output / "observations.hdf5", frames, clocks, source_hash)
    # Reopen each deliverable through its consumer before declaring completion.
    check = cv2.VideoCapture(str(output / "comparison.mp4"))
    decoded = 0
    while check.read()[0]:
        decoded += 1
    check.release()
    if decoded != n:
        raise RuntimeError("Comparison video failed frame-count roundtrip")
    with h5py.File(output / "observations.hdf5") as archive:
        if archive["model_estimates/detected"].shape[0] != n or archive["accepted_metric_hand_valid"][:].any():
            raise RuntimeError("Observation export violated validity separation")
    rerun_binary = Path(sys.executable).with_name("rerun")
    if not rerun_binary.is_file():
        rerun_binary = Path(shutil.which("rerun") or "/nonexistent/rerun")
    subprocess.run([str(rerun_binary), "--test-receive", str(output / "visualization.rrd")], check=True)
    if digest(source) != source_hash:
        raise RuntimeError("Read-only input changed during processing")
    summary = {"status": "complete", "started_utc": started_utc,
               "finished_utc": datetime.now(timezone.utc).isoformat(),
               "script_sha256": digest(Path(__file__)),
               "source": str(source), "source_sha256": source_hash,
               "source_url": SOURCE_URL if source_hash == SOURCE_SHA else None,
               "dataset_card": SOURCE_CARD if source_hash == SOURCE_SHA else None,
               "license": "CC-BY-4.0" if source_hash == SOURCE_SHA else "user-supplied",
               "attribution": "Humaid Tech Inc., EgoViz-120 (2026)" if source_hash == SOURCE_SHA else None,
               "changes": "Extracted clean ego-left stream; inferred MediaPipe landmarks; added overlays and exports.",
               "source_frame_count": n_source, "processed_frames": n,
               "frames_with_hand": int(np.count_nonzero(coverage)),
               "frames_with_two_hand_predictions": int(np.count_nonzero(np.array(coverage) == 2)),
               "hand_observations": detections, "detections_by_side": dict(detection_counts),
               "production_selected_hand_observations": production_selected_count,
               "raw_observations_removed_by_production_side_deduplication": detections - production_selected_count,
               "out_of_image_predicted_joint_count": out_of_bounds,
               "frames_without_hand_prediction": int(np.count_nonzero(np.array(coverage) == 0)),
               "detection_coverage_is_accuracy": False, "visibility": "unknown",
               "accepted_metric_hand_count": 0, "metric_3d_validated": False,
               "publisher_hand_labels_used": False, "model_sha256": digest(model_path),
               "observation_selection": "Same production model/config and detect_observations adapter, with deduplicate_by_side=False to preserve every raw detection. Production default keeps highest score per predicted side; its selected count is reported separately.",
               "handedness_convention_validated": False,
               "model_backend": "Stera MediaPipe HandTracker, detect_observations, IMAGE mode, default CPU delegate",
               "model_config": vars(tracker._backend.config),
               "library_versions": {name: importlib.metadata.version(name) for name in ["mediapipe", "stera-sdk", "rerun-sdk", "opencv-python"]},
               "processing_wall_seconds": round(time.monotonic() - start, 3),
               "comparison_decoded_frames": decoded,
               "rerun_ingestion_exit_code": 0, "source_unchanged": True,
               "calibration_used": False, "source_streams": source_info,
               "limitations": ["No independently labeled 2D or 3D ground truth; detection coverage is not accuracy.",
                               "No calibrated depth/pose/IMU integration in this RGB-only test.",
                               "Unknown occlusion, glove effects, and hidden-finger validity.",
                               "Model may miss hands or infer anatomically wrong joints."]}
    summary["output_sha256"] = {name: digest(output / name) for name in ["comparison.mp4", "contact_sheet.jpg", "observations.hdf5", "observations.jsonl", "visualization.rrd"]}
    json_write(output / "summary.json", summary)
    print(json.dumps({key: summary[key] for key in ["status", "processed_frames", "frames_with_hand", "hand_observations", "accepted_metric_hand_count"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Local video or compatible EgoViz MCAP")
    parser.add_argument("--download-default", action="store_true", help="Download the reviewed 150 MB CC-BY-4.0 public sample")
    parser.add_argument("--output", type=Path, required=True, help="New output directory")
    parser.add_argument("--max-seconds", type=float, default=30)
    args = parser.parse_args()
    if not np.isfinite(args.max_seconds) or args.max_seconds <= 0:
        parser.error("--max-seconds must be positive and finite")
    if args.output.exists():
        parser.error("Use a fresh output directory")
    source = download_default() if args.download_default else args.input
    if source is None or not source.is_file():
        parser.error("Provide --input or --download-default")
    run(source.resolve(), args.output.resolve(), args.max_seconds)


if __name__ == "__main__":
    main()
