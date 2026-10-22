#!/usr/bin/env python3
"""Decode every MCAP message and export a local, explicitly retimed preview.

Run with the lightweight requirements-inspection.txt environment. Raw inputs
are read only; all outputs go into the session's inspection directory. The SDK
compatibility patch is loaded directly, avoiding its heavy model imports.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
from importlib.metadata import version
import io
import json
import math
from pathlib import Path
import runpy
import subprocess
import sys

import numpy as np
from PIL import Image
from mcap.reader import make_reader
from mcap.records import Channel, Message, Schema
from mcap.stream_reader import StreamReader
from mcap_ros2.decoder import DecoderFactory


RGB = "/camera/rgb/compressed"
DEPTH = "/camera/depth"
POSE = "/camera/pose"
IMU = "/device/imu"
FPS = 15
TIME_FIELDS = ["log_time_ns", "publish_time_ns", "header_time_ns"]


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def dump(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def write_csv(path, fields, rows):
    with Path(path).open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def plain(value):
    if hasattr(value, "__slots__"):
        return {key: plain(getattr(value, key)) for key in value.__slots__}
    if isinstance(value, (tuple, list)):
        return [plain(item) for item in value]
    return value


def stamp_ns(header):
    if not 0 <= header.stamp.nanosec < 1_000_000_000:
        raise ValueError("header nanosec outside [0, 1e9)")
    return int(header.stamp.sec) * 1_000_000_000 + int(header.stamp.nanosec)


def timing_stats(values):
    values = [int(value) for value in values if value is not None]
    if not values:
        return {"count": 0}
    a = np.asarray(values, dtype=np.int64)
    delta = np.diff(a)
    unique = np.unique(a)
    gaps = np.diff(unique)
    median = float(np.median(gaps)) if len(gaps) else None
    return {
        "count": len(values), "first_in_file_ns": values[0],
        "last_in_file_ns": values[-1], "min_ns": int(a.min()),
        "max_ns": int(a.max()), "span_ns": int(a.max() - a.min()),
        "unique_timestamps": len(unique), "duplicate_timestamps": len(a) - len(unique),
        "adjacent_equal_in_file": int((delta == 0).sum()),
        "backwards_steps_in_file": int((delta < 0).sum()),
        "chronological_unique_gap_min_ns": int(gaps.min()) if len(gaps) else None,
        "chronological_unique_gap_median_ns": median,
        "chronological_unique_gap_p95_ns": float(np.percentile(gaps, 95)) if len(gaps) else None,
        "chronological_unique_gap_max_ns": int(gaps.max()) if len(gaps) else None,
        "gaps_above_1_5_times_median": int((gaps > 1.5 * median).sum()) if median else 0,
        "unique_interval_rate_hz": (len(unique) - 1) * 1e9 / int(a.max() - a.min())
        if a.max() > a.min() else None,
    }


def pose_values(pose):
    p, q = pose.position, pose.orientation
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w]


def validate_pose(values, norms):
    if not np.isfinite(values).all():
        raise ValueError("nonfinite pose/transform component")
    norm = float(np.linalg.norm(values[3:]))
    norms.append(norm)
    if not math.isclose(norm, 1.0, abs_tol=1e-4):
        raise ValueError(f"quaternion norm {norm} differs from 1 by more than 1e-4")


def run(command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path, help="directory with one MCAP and metadata.json")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    session = args.session.resolve()
    candidates = list(session.glob("*.mcap"))
    if len(candidates) != 1:
        parser.error("expected exactly one MCAP in the session directory")
    source = candidates[0]
    output = session / "inspection"
    output.mkdir(exist_ok=True)
    frames = output / "rgb_frames"
    frames.mkdir(exist_ok=True)
    if any(output.iterdir()) and list(frames.iterdir()):
        parser.error("inspection/rgb_frames already contains exports; choose a fresh session/output")
    metadata = json.loads((session / "metadata.json").read_text())
    raw_paths = [source, session / "metadata.json", session / "thumbnail.jpg"]
    raw_hashes = {path.name: {"bytes": path.stat().st_size, "sha256": sha256(path)}
                  for path in raw_paths if path.exists()}
    compat = root / "stera-sdk/src/stera/data/mcap/_compat.py"
    runpy.run_path(str(compat))["patch_mcap_ros2"]()
    factory = DecoderFactory()
    with source.open("rb") as stream:
        summary = make_reader(stream).get_summary()
    if summary is None or summary.statistics is None:
        raise ValueError("recording has no MCAP summary/statistics")

    topics = defaultdict(list)
    channel_counts = Counter()
    schemas, channels, decoders = {}, {}, {}
    errors, timestamp_rows, frame_rows, rgb_rows, depth_rows = [], [], [], [], []
    pose_rows, imu_rows, depth_arrays, depth_formats = [], [], [], Counter()
    image_sizes, image_modes, image_formats, jpeg_hashes = Counter(), Counter(), Counter(), []
    calibrations, calibration_records = defaultdict(dict), []
    quaternion_norms = defaultdict(list)
    cloud_points, cloud_formats, cloud_bounds = 0, Counter(), []
    cloud_nonfinite_fields = Counter()
    cloud_nonfinite_messages = 0
    cloud_nonfinite_points = 0
    cloud_dense_with_nonfinite_messages = 0
    tf_pairs = Counter()
    record_counts = Counter()
    metric_unique_values = defaultdict(set)
    decoded_count = 0
    print("Scanning and decoding all MCAP records...", flush=True)
    # Sequential StreamReader traverses the complete file, validates record bounds,
    # and checks data/chunk CRCs when present. File order is preserved in exports.
    with source.open("rb") as stream:
        for record in StreamReader(stream, validate_crcs=True).records:
            record_counts[type(record).__name__] += 1
            if isinstance(record, Schema):
                schemas[record.id] = record
                continue
            if isinstance(record, Channel):
                channels[record.id] = record
                continue
            if not isinstance(record, Message):
                continue
            channel = channels[record.channel_id]
            schema = schemas[channel.schema_id]
            topic = channel.topic
            topic_index = channel_counts[record.channel_id]
            channel_counts[record.channel_id] += 1
            times = {"log_time_ns": int(record.log_time),
                     "publish_time_ns": int(record.publish_time), "header_time_ns": None}
            row = {"topic": topic, "topic_message_index": topic_index,
                   "channel_id": channel.id, "sequence": record.sequence, **times}
            try:
                key = (channel.message_encoding, schema.id)
                if key not in decoders:
                    decoders[key] = factory.decoder_for(channel.message_encoding, schema)
                if decoders[key] is None:
                    raise ValueError(f"no decoder for {schema.name}")
                obj = decoders[key](record.data)
                decoded_count += 1
                if hasattr(obj, "header"):
                    times["header_time_ns"] = stamp_ns(obj.header)
                elif hasattr(obj, "transforms"):
                    stamps = [stamp_ns(t.header) for t in obj.transforms]
                    if len(set(stamps)) == 1:
                        times["header_time_ns"] = stamps[0]
                row.update(times)
                common = {"frame_index": topic_index, "sequence": record.sequence, **times}
                if topic == RGB:
                    payload = bytes(obj.data)
                    with Image.open(io.BytesIO(payload)) as img:
                        img.verify()
                    with Image.open(io.BytesIO(payload)) as img:
                        img.load()  # force a full decode for every JPEG
                        if img.format != "JPEG":
                            raise ValueError(f"compressed image is {img.format}, not JPEG")
                        image_sizes[f"{img.width}x{img.height}"] += 1
                        image_modes[img.mode] += 1
                        image_formats[obj.format] += 1
                    name = f"rgb_frames/{topic_index:06d}.jpg"
                    (output / name).write_bytes(payload)  # preserve original JPEG bytes
                    digest = hashlib.sha256(payload).hexdigest()
                    jpeg_hashes.append(digest)
                    rgb_rows.append({**common, "file": name, "sha256": digest})
                    frame_rows.append({"topic": topic, **rgb_rows[-1]})
                elif topic == DEPTH:
                    if obj.encoding != "16UC1" or obj.is_bigendian not in (0, 1):
                        raise ValueError(f"unsupported depth {obj.encoding}/{obj.is_bigendian}")
                    if obj.width <= 0 or obj.height <= 0 or obj.step < obj.width * 2:
                        raise ValueError("invalid depth dimensions or row stride")
                    payload = bytes(obj.data)
                    if len(payload) != obj.height * obj.step:
                        raise ValueError("depth bytes do not match height * step")
                    dtype = np.dtype(">u2" if obj.is_bigendian else "<u2")
                    depth = np.ndarray((obj.height, obj.width), dtype=dtype, buffer=payload,
                                       strides=(obj.step, 2)).astype(np.uint16, copy=True)
                    depth_arrays.append(depth)
                    depth_rows.append(common)
                    depth_formats[(obj.width, obj.height, obj.encoding, obj.is_bigendian, obj.step)] += 1
                    frame_rows.append({"topic": topic, **common,
                                       "file": f"depth.npz#depth[{topic_index}]",
                                       "sha256": hashlib.sha256(payload).hexdigest()})
                elif topic == POSE:
                    values = pose_values(obj.pose)
                    validate_pose(values, quaternion_norms[topic])
                    pose_rows.append({**common, "frame_id": obj.header.frame_id,
                                      **dict(zip(["x", "y", "z", "qx", "qy", "qz", "qw"], values))})
                elif topic == IMU:
                    acc, gyro, quat = obj.linear_acceleration, obj.angular_velocity, obj.orientation
                    values = [acc.x, acc.y, acc.z, gyro.x, gyro.y, gyro.z,
                              quat.x, quat.y, quat.z, quat.w]
                    if not np.isfinite(values).all():
                        raise ValueError("nonfinite IMU component")
                    imu_rows.append({**common, "frame_id": obj.header.frame_id,
                                     **dict(zip(["ax", "ay", "az", "gx", "gy", "gz",
                                                 "qx", "qy", "qz", "qw"], values)),
                                     "orientation_available": obj.orientation_covariance[0] != -1,
                                     **{f"{name}_{i}": value for name in (
                                         "orientation_covariance", "angular_velocity_covariance",
                                         "linear_acceleration_covariance")
                                         for i, value in enumerate(getattr(obj, name))}})
                elif schema.name.endswith("/CameraInfo"):
                    payload = plain(obj)
                    payload.pop("header")
                    payload["frame_id"] = obj.header.frame_id
                    if not np.isfinite(obj.k + obj.d + obj.r + obj.p).all():
                        raise ValueError("nonfinite camera calibration")
                    fingerprint = json.dumps(payload, sort_keys=True)
                    if fingerprint not in calibrations[topic]:
                        calibrations[topic][fingerprint] = {"calibration": payload,
                            "first_header_time_ns": times["header_time_ns"], "message_count": 0}
                    calibrations[topic][fingerprint]["message_count"] += 1
                    calibration_records.append({"topic": topic, **times})
                elif schema.name.endswith("/TFMessage"):
                    for transform in obj.transforms:
                        t, q = transform.transform.translation, transform.transform.rotation
                        validate_pose([t.x, t.y, t.z, q.x, q.y, q.z, q.w], quaternion_norms[topic])
                        stamp_ns(transform.header)
                        tf_pairs[f"{transform.header.frame_id} -> {transform.child_frame_id}"] += 1
                elif schema.name.endswith("/Path"):
                    for pose in obj.poses:
                        stamp_ns(pose.header)
                        validate_pose(pose_values(pose.pose), quaternion_norms[topic])
                elif schema.name.endswith("/PointCloud2"):
                    if obj.width < 0 or obj.height <= 0 or obj.point_step <= 0:
                        raise ValueError("invalid point-cloud dimensions")
                    if obj.row_step < obj.point_step * obj.width or len(obj.data) != obj.height * obj.row_step:
                        raise ValueError("invalid point-cloud buffer/stride")
                    sizes = {1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4, 8: 8}
                    xyz = {}
                    invalid_points = np.zeros((obj.height, obj.width), dtype=bool)
                    for field in obj.fields:
                        if field.datatype not in sizes or field.count < 1 or field.offset < 0:
                            raise ValueError("invalid point-cloud field")
                        if field.offset + sizes[field.datatype] * field.count > obj.point_step:
                            raise ValueError("point-cloud field exceeds point stride")
                        if field.name in ("x", "y", "z", "confidence"):
                            if field.datatype != 7 or field.count != 1:
                                raise ValueError("expected scalar float32 point-cloud coordinates")
                            values = np.ndarray((obj.height, obj.width),
                                dtype=(">f4" if obj.is_bigendian else "<f4"), buffer=obj.data,
                                offset=field.offset, strides=(obj.row_step, obj.point_step))
                            invalid_field = ~np.isfinite(values)
                            cloud_nonfinite_fields[field.name] += int(invalid_field.sum())
                            invalid_points |= invalid_field
                            if field.name in ("x", "y", "z"):
                                xyz[field.name] = values
                    if set(xyz) != {"x", "y", "z"}:
                        raise ValueError("point cloud lacks XYZ")
                    invalid_count = int(invalid_points.sum())
                    cloud_nonfinite_points += invalid_count
                    if invalid_count:
                        cloud_nonfinite_messages += 1
                        cloud_dense_with_nonfinite_messages += bool(obj.is_dense)
                    valid_xyz = np.isfinite(xyz["x"]) & np.isfinite(xyz["y"]) & np.isfinite(xyz["z"])
                    if valid_xyz.any():
                        cloud_bounds.append([[float(xyz[k][valid_xyz].min()), float(xyz[k][valid_xyz].max())]
                                             for k in "xyz"])
                    cloud_points += obj.width * obj.height
                    cloud_formats[(obj.point_step, bool(obj.is_bigendian))] += 1
                elif topic == "/device/metrics":
                    for key in ("thermal_state", "thermal_state_str", "battery_level"):
                        metric_unique_values[key].add(getattr(obj, key))
            except Exception as exc:
                errors.append({"topic": topic, "index": topic_index,
                               "sequence": record.sequence, "error": str(exc)})
            topics[topic].append(times)
            timestamp_rows.append(row)

    all_count = sum(channel_counts.values())
    declared = [{"channel_id": channel.id, "topic": channel.topic,
                 "schema": summary.schemas[channel.schema_id].name,
                 "actual_count": channel_counts[channel.id],
                 "summary_count": summary.statistics.channel_message_counts.get(channel.id, 0)}
                for channel in summary.channels.values()]
    if all_count != summary.statistics.message_count:
        errors.append({"error": "actual message count disagrees with MCAP summary"})
    for channel in declared:
        if channel["actual_count"] != channel["summary_count"]:
            errors.append({"error": "actual channel count disagrees with summary", **channel})
    dump(output / "decode_errors.json", errors)
    if errors:
        raise RuntimeError(f"{len(errors)} decode/validation errors; see inspection/decode_errors.json")

    write_csv(output / "message_timestamps.csv",
              ["topic", "topic_message_index", "channel_id", "sequence", *TIME_FIELDS], timestamp_rows)
    write_csv(output / "frame_timestamps.csv",
              ["topic", "frame_index", "sequence", *TIME_FIELDS, "file", "sha256"], frame_rows)
    write_csv(output / "poses.csv", ["frame_index", "sequence", *TIME_FIELDS, "frame_id",
              "x", "y", "z", "qx", "qy", "qz", "qw"], pose_rows)
    write_csv(output / "imu.csv", list(imu_rows[0]), imu_rows)
    depth = np.stack(depth_arrays)
    np.savez_compressed(output / "depth.npz", depth=depth,
                        **{field: np.asarray([row[field] for row in depth_rows], dtype=np.int64)
                           for field in TIME_FIELDS})
    calibration_json = {
        "topics": {topic: list(records.values()) for topic, records in calibrations.items()},
        "limitations": "Recorded calibration only. Matching dimensions and timestamps do not establish "
                        "physical accuracy, RGB-depth registration, distortion correction, or TF conventions.",
    }
    dump(output / "calibration.json", calibration_json)

    print(f"Decoded {decoded_count} messages. Encoding {len(rgb_rows)} JPEGs at inspection-only 15 fps...", flush=True)
    encode_command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-framerate", str(FPS), "-start_number", "0", "-i", str(frames / "%06d.jpg"),
        "-frames:v", str(len(rgb_rows)), "-an", "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "20", "-threads", "2", "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-fps_mode", "cfr", "-video_track_timescale", "15000", "-movflags", "+faststart",
        "-metadata", "comment=Inspection only: one source JPEG per 15fps CFR frame; timestamps retimed. "
        "Original MCAP and timestamp CSVs are authoritative.", str(output / "preview.mp4")]
    run(encode_command)
    probe_command = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_streams", "-show_frames", "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,time_base,nb_read_frames,duration:"
        "frame=best_effort_timestamp,best_effort_timestamp_time", "-of", "json", str(output / "preview.mp4")]
    probe = json.loads(run(probe_command))
    video = probe["streams"][0]
    if int(video["nb_read_frames"]) != len(rgb_rows) or len(probe["frames"]) != len(rgb_rows):
        raise ValueError("preview frame count does not match JPEG count")
    if Fraction(video["avg_frame_rate"]) != FPS:
        raise ValueError("preview is not 15 fps")
    mapping = []
    for index, (row, frame) in enumerate(zip(rgb_rows, probe["frames"], strict=True)):
        pts = int(frame["best_effort_timestamp"])
        if pts * Fraction(video["time_base"]) != Fraction(index, FPS):
            raise ValueError(f"unexpected preview PTS at frame {index}")
        mapping.append({"preview_frame_index": index, "preview_pts": pts,
            "preview_time_base": video["time_base"], "preview_pts_seconds": frame["best_effort_timestamp_time"],
            "source_rgb_frame_index": row["frame_index"], "source_sequence": row["sequence"],
            **{field: row[field] for field in TIME_FIELDS},
            "source_elapsed_ns": row["header_time_ns"] - rgb_rows[0]["header_time_ns"],
            "source_jpeg": row["file"], "source_jpeg_sha256": row["sha256"]})
    write_csv(output / "preview_frame_mapping.csv", list(mapping[0]), mapping)
    decode_command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror",
                      "-i", str(output / "preview.mp4"), "-f", "null", "-"]
    run(decode_command)  # decode the entire encoded video, not only the first frame
    dump(output / "preview_probe.json", probe)

    topic_stats = {topic: {"count": len(rows), **{field: timing_stats([r[field] for r in rows])
                   for field in TIME_FIELDS}} for topic, rows in sorted(topics.items())}
    imu_array = np.asarray([[row[k] for k in ("ax", "ay", "az", "gx", "gy", "gz")] for row in imu_rows])
    unchanged_acc = np.all(imu_array[1:, :3] == imu_array[:-1, :3], axis=1)
    unchanged_gyro = np.all(imu_array[1:, 3:] == imu_array[:-1, 3:], axis=1)
    held = {"comparison_order": "MCAP file order", "adjacent_pairs": len(imu_rows) - 1,
        "acceleration_unchanged_pairs": int(unchanged_acc.sum()),
        "acceleration_unchanged_fraction": float(unchanged_acc.mean()),
        "angular_velocity_unchanged_pairs": int(unchanged_gyro.sum()),
        "angular_velocity_unchanged_fraction": float(unchanged_gyro.mean()),
        "both_unchanged_pairs": int((unchanged_acc & unchanged_gyro).sum()),
        "at_least_one_unchanged_fraction": float((unchanged_acc | unchanged_gyro).mean())}
    metadata_fields = {
        "total_rgb_frames": RGB, "total_video_frames_encoded": RGB, "rgb_encoded_count": RGB,
        "total_depth_frames": DEPTH, "total_pointcloud_frames": "/map/point_cloud",
        "total_imu_samples": IMU, "poseFrameCount": POSE, "total_ar_frames": "/device/metrics"}
    comparisons = [{"field": field, "metadata_value": metadata.get(field), "actual_topic": topic,
                    "actual_count": len(topics[topic]), "equal": metadata.get(field) == len(topics[topic])}
                   for field, topic in metadata_fields.items()]
    unique_depth_frames = len({hashlib.sha256(d.tobytes()).hexdigest() for d in depth})
    rgb_header_times = [r["header_time_ns"] for r in rgb_rows]
    depth_header_times = [r["header_time_ns"] for r in depth_rows]
    pose_header_times = [r["header_time_ns"] for r in pose_rows]
    unavailable_orientation_count = sum(not r["orientation_available"] for r in imu_rows)
    hand_topic_present = any("hand" in channel["topic"].lower() for channel in declared)
    tracking_topic_present = any("tracking" in channel["topic"].lower() for channel in declared)
    warnings = [
        f"metadata.total_rgb_frames={metadata.get('total_rgb_frames')} counts AR processing-loop iterations; "
        f"the recording contains {len(rgb_rows)} JPEG frames. Use the actual topic count.",
        f"metadata.arcore_fps={metadata.get('arcore_fps')} is a loop-count rate, not unique RGB exposures; "
        f"metadata.arcore_native_fps={metadata.get('arcore_native_fps')} is a different estimate.",
        f"metadata.rgb_target_fps={metadata.get('rgb_target_fps')} and encoder_mode={metadata.get('encoder_mode')} "
        f"are recorded alongside runtime target {metadata.get('fps_target_runtime')} and profile "
        f"{metadata.get('video_profile')}; use observed frame intervals to assess the capture cadence.",
        f"metadata.actual_width/height={metadata.get('actual_width')}x{metadata.get('actual_height')}; "
        f"actual decoded RGB dimensions are {dict(image_sizes)}.",
        f"Recorded header timestamp lists: RGB-depth equal={rgb_header_times == depth_header_times}; "
        f"RGB-pose equal={rgb_header_times == pose_header_times}. The app passes frame.timestamp "
        "to the depth writer; no independent depth exposure timestamp is retained here. Zero timestamp "
        "delta is not proof of physical sensor synchronization.",
        f"IMU orientation is unavailable in {unavailable_orientation_count}/{len(imu_rows)} messages "
        "(orientation_covariance[0]=-1); an unavailable zero quaternion is a placeholder. "
        "Each accelerometer or gyro callback emits the latest values from both sensors, so repeated "
        "components are held samples, not independent paired measurements at the combined callback rate.",
        f"metadata.tracking_loss_events={metadata.get('tracking_loss_events')} is metadata only; "
        f"a topic named for tracking is present={tracking_topic_present}. "
        "This inspection does not independently validate physical tracking accuracy.",
        f"A topic named for hands is present={hand_topic_present}. Camera poses and sparse environmental "
        "points are not hand trajectories or robot actions.",
        "Calibration dimensions agreeing with decoded images does not establish projection alignment, "
        "physical accuracy, metric drift, or frame/TF convention correctness. Those require separate validation.",
        "Timestamps are native integer nanoseconds, not wall-clock UTC. File order is preserved; "
        "a gap above 1.5 times the median unique timestamp interval is only a diagnostic, not a dropped-frame count.",
        "preview.mp4 is inspection-only CFR 15 fps: one original JPEG per preview frame, with timing retimed. "
        "Original MCAP, original JPEG exports, and timestamp CSVs are authoritative.",
    ]
    if unique_depth_frames == 1 and len(depth) > 1:
        warnings.insert(0, f"All {len(depth)} recorded depth payloads are pixel-identical despite distinct "
                        "timestamps (one unique decoded depth array). This capture does not demonstrate "
                        "fresh depth updates. The cause is unverified; do not treat these as independent "
                        "measurements of changing geometry.")
    if cloud_nonfinite_messages:
        warnings.insert(0, f"Sparse point clouds contain nonfinite XYZ/confidence values in "
                        f"{cloud_nonfinite_messages}/{len(topics['/map/point_cloud'])} messages: "
                        f"{cloud_nonfinite_points}/{cloud_points} point records have at least one invalid field. "
                        f"{cloud_dense_with_nonfinite_messages} affected messages nevertheless set is_dense=True. "
                        "Do not assume every recorded point is usable; bounds below use finite XYZ only. "
                        "The recording's raw values are preserved and the cause is unverified.")
    nonzero = depth[depth > 0]
    cal_dimensions = {topic: sorted({(r["calibration"]["width"], r["calibration"]["height"])
                                   for r in records.values()}) for topic, records in calibrations.items()}
    image_dimensions_agree = all(f"{w}x{h}" in image_sizes
        for w, h in cal_dimensions["/camera/camera_info"])
    depth_dimensions_agree = all((h, w) == depth.shape[1:]
        for w, h in cal_dimensions["/camera/depth/camera_info"])
    for path in raw_paths:
        if path.exists() and sha256(path) != raw_hashes[path.name]["sha256"]:
            raise ValueError(f"raw input changed: {path}")
    provenance_paths = [Path(__file__).resolve(), root / "requirements-inspection.txt", compat]
    source_dir = root / "stera-app/packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder"
    provenance_paths += [source_dir / relative for relative in (
        "coordination/RecordingFrameOrchestrator.kt", "coordination/MetadataAssembler.kt",
        "sensors/ImuCollectorImpl.kt", "data/CDRSerializer.kt", "data/MCAPDatasetWriter.kt")]
    pose_positions = np.asarray([[row[k] for k in ("x", "y", "z")] for row in pose_rows])
    qa = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "session": str(session), "raw_inputs": raw_hashes, "raw_inputs_unchanged_after_processing": True,
        "provenance": {str(p.relative_to(root)): sha256(p) for p in provenance_paths},
        "repository_commits": {name: run(["git", "-C", str(root / name), "rev-parse", "HEAD"]).strip()
                               for name in ("stera-app", "stera-sdk")},
        "dependencies": {name: version(name) for name in ("mcap", "mcap-ros2-support", "numpy", "Pillow", "lz4", "zstandard")},
        "inspection": {"scope": "all MCAP messages; all JPEG/depth payloads; all camera/trajectory/TF poses",
            "actual_message_count": all_count, "decoded_message_count": decoded_count, "decode_errors": len(errors),
            "point_cloud_messages_with_quality_issues": cloud_nonfinite_messages,
            "summary_message_count": summary.statistics.message_count, "record_counts": dict(record_counts),
            "crc_validation": "enabled for CRCs present in MCAP; no claim that every record has a checksum",
            "recorded_span_ns": max(r["log_time_ns"] for r in timestamp_rows) - min(r["log_time_ns"] for r in timestamp_rows),
            "declared_channels": declared, "populated_topic_count": len(topics),
            "empty_declared_topics": [r["topic"] for r in declared if r["actual_count"] == 0],
            "log_publish_mismatches": sum(r["log_time_ns"] != r["publish_time_ns"] for r in timestamp_rows),
            "header_log_mismatches": sum(r["header_time_ns"] != r["log_time_ns"] for r in timestamp_rows
                                          if r["header_time_ns"] is not None)},
        "topics": topic_stats,
        "rgb": {"frames": len(rgb_rows), "fully_decoded": len(rgb_rows), "dimensions": dict(image_sizes),
                "pixel_modes": dict(image_modes), "message_formats": dict(image_formats),
                "unique_jpeg_payloads": len(set(jpeg_hashes))},
        "depth": {"frames": len(depth), "shape": list(depth.shape), "npz_dtype": str(depth.dtype),
            "formats": [{"width": k[0], "height": k[1], "encoding": k[2], "is_bigendian": k[3],
                         "row_step_bytes": k[4], "count": count} for k, count in depth_formats.items()],
            "zero_fraction": float((depth == 0).mean()), "nonzero_value_min": int(nonzero.min()) if len(nonzero) else None,
            "nonzero_value_max": int(nonzero.max()) if len(nonzero) else None,
            "units": "ARCore writer convention: uint16 millimetres; no independent range calibration performed",
            "unique_decoded_frames": unique_depth_frames,
            "rgb_header_timestamp_lists_equal": rgb_header_times == depth_header_times},
        "poses": {"camera_pose_count": len(pose_rows), "all_components_finite": True,
            "position_min_xyz": pose_positions.min(axis=0).tolist(),
            "position_max_xyz": pose_positions.max(axis=0).tolist(),
            "position_range_xyz": np.ptp(pose_positions, axis=0).tolist(),
            "first_to_last_position_distance": float(np.linalg.norm(pose_positions[-1] - pose_positions[0])),
            "position_units": "recorded ARCore metre convention; physical accuracy unverified",
            "quaternion_norms": {topic: {"checked": len(v), "min": min(v), "max": max(v),
                "max_absolute_error_from_1": max(abs(x - 1) for x in v)} for topic, v in quaternion_norms.items()},
            "tf_pairs": dict(tf_pairs), "normalization_applied": False},
        "imu": {"messages": len(imu_rows), "all_components_finite": True,
                "orientation_unavailable_count": unavailable_orientation_count,
                "held_samples": held, "units": "recorded sensor convention: acceleration m/s^2, angular velocity rad/s"},
        "point_cloud": {"messages": len(topics["/map/point_cloud"]), "point_records_total": cloud_points,
            "all_xyz_confidence_finite": cloud_nonfinite_points == 0,
            "messages_with_nonfinite_fields": cloud_nonfinite_messages,
            "nonfinite_field_value_counts": dict(cloud_nonfinite_fields),
            "point_records_with_nonfinite_fields": cloud_nonfinite_points,
            "nonfinite_point_fraction": cloud_nonfinite_points / cloud_points if cloud_points else 0,
            "is_dense_true_despite_nonfinite_messages": cloud_dense_with_nonfinite_messages,
            "xyz_bounds": np.asarray(cloud_bounds).min(axis=0)[:, 0].tolist() +
                          np.asarray(cloud_bounds).max(axis=0)[:, 1].tolist() if cloud_bounds else [],
            "xyz_bounds_order": "xmin,ymin,zmin,xmax,ymax,zmax"},
        "calibration": {"rgb_dimensions_agree": image_dimensions_agree,
            "depth_dimensions_agree": depth_dimensions_agree, "dimensions": cal_dimensions,
            "unique_calibrations": {topic: len(records) for topic, records in calibrations.items()}},
        "metrics_observed_values": {key: sorted(values) for key, values in metric_unique_values.items()},
        "metadata_count_comparisons": comparisons,
        "metadata_reported_duration_seconds": metadata.get("session_duration_seconds"),
        "metadata_reported_tracking_loss_events": metadata.get("tracking_loss_events"),
        "hand_tracking_topic_present": hand_topic_present,
        "preview": {"purpose": "inspection only; retimed", "fps": FPS, "source_frames": len(rgb_rows),
            "verified_decoded_frames": int(video["nb_read_frames"]), "stream": video,
            "frame_mapping": "preview_frame_mapping.csv", "mapping_all_pts_verified": True,
            "full_ffmpeg_decode_passed": True, "encode_command": encode_command,
            "decode_check_command": decode_command},
        "warnings_and_limitations": warnings,
    }
    dump(output / "qa.json", qa)
    md = [f"# Capture inspection: {session.name}", "", f"Source: `{source.name}`", "",
          f"Decoded **{all_count:,}/{all_count:,} messages**, with **0 decode/structural errors**. "
          f"**{cloud_nonfinite_messages} point-cloud messages have nonfinite-value quality issues.** "
          f"Native recorded span: **{qa['inspection']['recorded_span_ns'] / 1e9:.9f} seconds**. "
          "The raw MCAP, metadata and thumbnail hashes were unchanged after processing.", "",
          "## Actual topic inventory", "", "| Topic | Messages | Header span (s) | Duplicate stamps | Backwards steps in file | Max unique gap (ms) |",
          "|---|---:|---:|---:|---:|---:|"]
    for channel in declared:
        stats = topic_stats.get(channel["topic"], {}).get("header_time_ns", {})
        md.append(f"| `{channel['topic']}` | {channel['actual_count']:,} | "
                  f"{stats.get('span_ns', 0)/1e9:.6f} | {stats.get('duplicate_timestamps', 0)} | "
                  f"{stats.get('backwards_steps_in_file', 0)} | "
                  f"{(stats.get('chronological_unique_gap_max_ns') or 0)/1e6:.6f} |")
    md += ["", "Full log/publish/header timing statistics, exact integer bounds, interval distributions, "
           "and diagnostic gap counts are in `qa.json`; every message timestamp is in `message_timestamps.csv`.",
           "", "## Payload checks", "",
           f"- RGB: all {len(rgb_rows)} JPEGs fully decoded; dimensions {dict(image_sizes)}. "
           "Exported JPEGs preserve the exact original compressed bytes.",
           f"- Depth: all {len(depth)} buffers checked for encoding, endian flag, row stride and length; "
           f"{list(depth_formats)}; zero-valued fraction {qa['depth']['zero_fraction']:.6%}; "
           f"**{unique_depth_frames} unique decoded depth arrays across {len(depth)} messages**. "
           "`depth.npz` contains uint16 values plus the three native timestamp arrays.",
           f"- Camera poses: {len(pose_rows)} finite poses; all camera, TF and trajectory quaternion norms "
           "within 1e-4 of one. Original values exported without normalization.",
           f"- IMU: {len(imu_rows):,} finite samples; orientation unavailable in "
           f"{qa['imu']['orientation_unavailable_count']:,}. Of {held['adjacent_pairs']:,} adjacent file-order pairs, "
           f"acceleration is unchanged in {held['acceleration_unchanged_fraction']:.3%}, "
           f"gyro in {held['angular_velocity_unchanged_fraction']:.3%}, "
           f"and at least one is unchanged in {held['at_least_one_unchanged_fraction']:.3%}.",
           f"- Sparse point clouds: {len(topics['/map/point_cloud'])} messages / {cloud_points:,} point records; "
           f"buffer bounds and fields checked; **{cloud_nonfinite_points:,} point records have nonfinite "
           f"XYZ/confidence values in {cloud_nonfinite_messages} messages**. "
           "Repeated map points are not deduplicated; reported bounds use finite XYZ only.",
           f"- Calibration: RGB dimension agreement={image_dimensions_agree}; "
           f"depth dimension agreement={depth_dimensions_agree}. Original K/D/R/P and frame IDs are in `calibration.json`.",
           "", "## Interpretation limits", ""]
    md += [f"- {warning}" for warning in warnings]
    md += ["", "## Inspection preview and exports", "",
           f"`preview.mp4`: CPU libx264, CFR {FPS} fps, {len(rgb_rows)} frames, "
           f"{float(video['duration']):.6f} seconds. Every encoded frame and PTS was checked, "
           "and a full ffmpeg decode succeeded. The preview is retimed; its duration and cadence "
           "are not the recording's native timing.", "",
           "`preview_frame_mapping.csv` maps every preview index/PTS to its source JPEG hash, "
           "MCAP sequence, and integer log/publish/header timestamps. `frame_timestamps.csv` covers "
           "RGB and depth; `poses.csv` and `imu.csv` carry their own native timestamps. "
           "All CSVs retain source file order; do not silently treat IMU file order as chronological.", "",
           "`manifest.json` hashes every derived file except itself and lists hashes for source files. "
           "Checks use only local CPU decoding and public lightweight Python packages. "
           "No model inference, cloud processing, physical accuracy validation or hand tracking was performed.", ""]
    (output / "QA.md").write_text("\n".join(md))
    manifest = {"raw_inputs": raw_hashes,
        "derived_files": {str(p.relative_to(output)): {"bytes": p.stat().st_size, "sha256": sha256(p)}
                          for p in sorted(output.rglob("*")) if p.is_file() and p.name != "manifest.json"},
        "excludes": ["manifest.json (self-reference)"],
        "timestamp_authority": "original MCAP and native integer nanosecond CSV fields; preview is retimed"}
    dump(output / "manifest.json", manifest)
    print(json.dumps({"output": str(output), "messages": all_count, "rgb_frames": len(rgb_rows),
                      "depth_frames": len(depth), "preview_decode": "passed", "held_samples": held}, indent=2))


if __name__ == "__main__":
    main()
