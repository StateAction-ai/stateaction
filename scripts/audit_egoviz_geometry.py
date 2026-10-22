#!/usr/bin/env python3
"""Read-only cross-sensor audit of the downloaded EgoViz-120 sample.

Writes derived evidence only. Stereo agreement is an internal consistency test,
not externally measured geometric ground truth or a hand-label accuracy score.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

import cv2
import numpy as np
from scipy.spatial.transform import Rotation
from mcap.reader import make_reader
from mcap_ros2.decoder import DecoderFactory

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "/ego/zed_head"


def stamp(header):
    return int(header.stamp.sec) * 1_000_000_000 + int(header.stamp.nanosec)


def vector(value, fields="xyz"):
    return np.array([getattr(value, field) for field in fields], dtype=float)


def stats(values):
    a = np.asarray(values, dtype=float)
    a = a[np.isfinite(a)]
    return {"count": int(a.size), "min": float(a.min()), "median": float(np.median(a)),
            "p90": float(np.percentile(a, 90)), "max": float(a.max())} if a.size else {"count": 0}


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def protobuf_video(source, topic, output):
    from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
    clocks, frame_ids = [], set()
    parser = None
    with source.open("rb") as stream, output.with_suffix(".h264").open("wb") as encoded:
        for schema, channel, message in make_reader(stream).iter_messages(topics=[topic]):
            if parser is None:
                pool = descriptor_pool.DescriptorPool()
                for descriptor in descriptor_pb2.FileDescriptorSet.FromString(schema.data).file:
                    pool.Add(descriptor)
                parser = message_factory.GetMessageClass(pool.FindMessageTypeByName(schema.name))
            packet = parser.FromString(message.data)
            if packet.format != "h264":
                raise ValueError("Expected H.264")
            encoded.write(packet.data)
            clocks.append([packet.timestamp.seconds * 1_000_000_000 + packet.timestamp.nanos,
                           message.log_time, message.publish_time])
            frame_ids.add(packet.frame_id)
    times = np.array(clocks, np.int64)
    fps = 1e9 / np.median(np.diff(times[:, 0]))
    subprocess.run(["ffmpeg", "-v", "error", "-f", "h264", "-framerate", str(fps),
                    "-i", str(output.with_suffix(".h264")), "-c", "copy", str(output)], check=True)
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
                       "stream=has_b_frames,nb_frames,width,height", "-of", "json", str(output)]))["streams"][0]
    if probe["has_b_frames"] or int(probe["nb_frames"]) != len(times):
        raise ValueError("Cannot prove video packet/frame correspondence")
    return times, sorted(frame_ids), probe


def audit(source, output):
    output.mkdir(parents=True, exist_ok=False)
    before = sha(source)
    left_times, left_ids, left_probe = protobuf_video(source, PREFIX + "/left/image/compressed", output / "left.mp4")
    right_times, right_ids, right_probe = protobuf_video(source, PREFIX + "/right/image/compressed", output / "right.mp4")
    sample_indices = np.linspace(0, len(left_times) - 1, 6).astype(int).tolist()
    sample_times = {int(left_times[index, 0]): index for index in sample_indices}
    clocks = defaultdict(list)
    ids = defaultdict(set)
    calibration, static_tf = {}, {}
    static_counts, static_variants = Counter(), defaultdict(set)
    pose_rows, imu_rows, dynamic_poses, depth_samples = [], [], {}, {}
    histogram = np.zeros(65536, dtype=np.int64)
    depth_frame_stats, depth_formats, depth_shapes, depth_types = [], set(), set(), set()
    topics = [PREFIX + "/depth/image/compressed", PREFIX + "/odom", PREFIX + "/imu/data", "/tf", "/tf_static"]
    with source.open("rb") as stream:
        summary = make_reader(stream).get_summary()
        topics += [channel.topic for channel in summary.channels.values() if channel.topic.endswith("camera_info")]
    with source.open("rb") as stream:
        reader = make_reader(stream, decoder_factories=[DecoderFactory()])
        for _, channel, message, decoded in reader.iter_decoded_messages(topics=topics):
            topic = channel.topic
            if hasattr(decoded, "header"):
                ts = stamp(decoded.header)
                clocks[topic].append([ts, message.log_time, message.publish_time])
                ids[topic].add(decoded.header.frame_id)
            if topic.endswith("camera_info"):
                row = {"width": int(decoded.width), "height": int(decoded.height), "K": list(decoded.k),
                       "P": list(decoded.p), "R": list(decoded.r), "D": list(decoded.d),
                       "frame_id": decoded.header.frame_id, "distortion_model": decoded.distortion_model}
                if topic not in calibration:
                    calibration[topic] = {"first": row, "count": 0, "all_identical": True}
                calibration[topic]["count"] += 1
                calibration[topic]["all_identical"] &= calibration[topic]["first"] == row
            elif topic.endswith("depth/image/compressed"):
                depth = cv2.imdecode(np.frombuffer(bytes(decoded.data), np.uint8), cv2.IMREAD_UNCHANGED)
                depth_formats.add(decoded.format); depth_shapes.add(depth.shape); depth_types.add(str(depth.dtype))
                if depth.dtype != np.uint16 or depth.ndim != 2:
                    raise ValueError("Expected scalar uint16 depth PNG")
                bins = np.bincount(depth.ravel(), minlength=65536)
                histogram += bins
                nonzero = np.flatnonzero(bins[1:]) + 1
                depth_frame_stats.append({"timestamp_ns": ts, "zero_fraction": float(bins[0] / depth.size),
                                          "unique_nonzero": len(nonzero), "max": int(depth.max())})
                if ts in sample_times:
                    depth_samples[sample_times[ts]] = depth
            elif topic == PREFIX + "/odom":
                p = decoded.pose.pose
                pose_rows.append({"timestamp_ns": ts, "position": vector(p.position),
                                  "quaternion": vector(p.orientation, "xyzw"),
                                  "angular": vector(decoded.twist.twist.angular),
                                  "linear": vector(decoded.twist.twist.linear),
                                  "covariance": np.array(decoded.pose.covariance).reshape(6, 6),
                                  "child_frame": decoded.child_frame_id})
            elif topic == PREFIX + "/imu/data":
                imu_rows.append({"timestamp_ns": ts, "gyro": vector(decoded.angular_velocity),
                                 "accel": vector(decoded.linear_acceleration),
                                 "quaternion": vector(decoded.orientation, "xyzw")})
            elif topic in ("/tf", "/tf_static"):
                for transform in decoded.transforms:
                    key = transform.header.frame_id + " -> " + transform.child_frame_id
                    value = np.r_[vector(transform.transform.translation), vector(transform.transform.rotation, "xyzw")]
                    if topic == "/tf_static":
                        static_counts[key] += 1; static_variants[key].add(tuple(value))
                        static_tf.setdefault(key, value.tolist())
                    elif key == "odom -> zed_head_camera_link":
                        dynamic_poses[stamp(transform.header)] = value
    clocks[PREFIX + "/left/image/compressed"] = left_times
    clocks[PREFIX + "/right/image/compressed"] = right_times
    ids[PREFIX + "/left/image/compressed"] = set(left_ids)
    ids[PREFIX + "/right/image/compressed"] = set(right_ids)
    timing = {}
    for topic, rows in clocks.items():
        a = np.asarray(rows, np.int64)
        timing[topic] = {"count": len(a), "frame_ids": sorted(ids[topic]),
                         "unique_native_timestamps": len(np.unique(a[:, 0])),
                         "native_header_equals_log_and_publish": bool(np.all(a[:, 0:1] == a[:, 1:])),
                         "native_min_ns": int(a[:, 0].min()), "native_max_ns": int(a[:, 0].max()),
                         "native_step_ms": stats(np.diff(a[:, 0]) / 1e6),
                         "exact_rgb_timestamp_intersection": len(set(a[:, 0]) & set(left_times[:, 0]))}
    lk = calibration[PREFIX + "/left/camera_info"]["first"]
    rk = calibration[PREFIX + "/right/camera_info"]["first"]
    dk = calibration[PREFIX + "/depth/camera_info"]["first"]
    K = np.array(lk["K"]).reshape(3, 3)
    baseline = -rk["P"][3] / rk["P"][0]
    nonzero = np.flatnonzero(histogram[1:]) + 1
    depth_info = {"formats": sorted(depth_formats), "dtypes": sorted(depth_types),
                  "shapes": [list(x) for x in depth_shapes], "total_pixels": int(histogram.sum()),
                  "zero_fraction": float(histogram[0] / histogram.sum()),
                  "nonzero_min": int(nonzero.min()), "nonzero_max": int(nonzero.max()),
                  "unique_nonzero_values": len(nonzero), "nonzero_value_gcd": int(np.gcd.reduce(nonzero)),
                  "nonzero_value_step_gcd": int(np.gcd.reduce(np.diff(nonzero))),
                  "all_nonzero_multiples_of_10": bool(np.all(nonzero % 10 == 0)),
                  "per_frame_zero_fraction": stats([row["zero_fraction"] for row in depth_frame_stats]),
                  "per_frame_unique_nonzero": stats([row["unique_nonzero"] for row in depth_frame_stats])}
    # Independent image-correspondence check: depth is not used to select matches.
    captures = [cv2.VideoCapture(str(output / name)) for name in ("left.mp4", "right.mp4")]
    sift = cv2.SIFT_create(nfeatures=3000)
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    stereo_rows, correspondence_rows = [], []
    for index in sample_indices:
        images = []
        for cap in captures:
            cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, image = cap.read()
            if not ok:
                raise RuntimeError("Cannot decode sample frame")
            images.append(image)
        keypoints, descriptors = zip(*(sift.detectAndCompute(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), None) for image in images))
        pairs = matcher.knnMatch(descriptors[0], descriptors[1], k=2)
        backward = {m.queryIdx: m.trainIdx for m, n in matcher.knnMatch(descriptors[1], descriptors[0], k=2) if m.distance < .75 * n.distance}
        matches = [m for m, n in pairs if m.distance < .75 * n.distance and backward.get(m.trainIdx) == m.queryIdx]
        lp = np.array([keypoints[0][m.queryIdx].pt for m in matches])
        rp = np.array([keypoints[1][m.trainIdx].pt for m in matches])
        disparity = lp[:, 0] - rp[:, 0]
        vertical = np.abs(lp[:, 1] - rp[:, 1])
        valid = (vertical < 2.) & (disparity > 4.) & (disparity < 500.)
        sample = {"frame": index, "mutual_ratio_matches": len(matches),
                  "vertical_residual_px_before_epipolar_filter": stats(vertical),
                  "positive_disparity_fraction_before_filter": float(np.mean(disparity > 0)),
                  "epipolar_and_disparity_pass": int(valid.sum())}
        depth = depth_samples[index]
        accepted_matches = []
        for position in np.flatnonzero(valid):
            x, y = np.rint(lp[position]).astype(int)
            if not (2 <= x < depth.shape[1] - 2 and 2 <= y < depth.shape[0] - 2):
                continue
            patch = depth[y - 1:y + 2, x - 1:x + 2]
            positive = patch[patch > 0]
            if positive.size < 5:
                continue
            depth_raw = float(np.median(positive))
            if np.ptp(positive) > max(30, depth_raw * .05):
                continue
            stereo_z = K[0, 0] * baseline / disparity[position]
            flip_raw = float(depth[depth.shape[0] - 1 - y, depth.shape[1] - 1 - x])
            correspondence_rows.append({"frame": index, "left_uv": lp[position].tolist(),
                                        "right_uv": rp[position].tolist(), "disparity_px": float(disparity[position]),
                                        "vertical_residual_px": float(vertical[position]),
                                        "depth_raw": depth_raw, "stereo_z_m": float(stereo_z),
                                        "depth_flipped_raw": flip_raw})
            accepted_matches.append(matches[position])
        sample["valid_depth_comparisons"] = len(accepted_matches)
        stereo_rows.append(sample)
        rendered = cv2.drawMatches(images[0], keypoints[0], images[1], keypoints[1], accepted_matches[:60], None,
                                   flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS)
        cv2.imwrite(str(output / f"stereo_matches_{index:03d}.jpg"), cv2.resize(rendered, (1920, 600)))
    for cap in captures:
        cap.release()
    recorded = np.array([row["depth_raw"] for row in correspondence_rows])
    triangulated = np.array([row["stereo_z_m"] for row in correspondence_rows])
    flipped = np.array([row["depth_flipped_raw"] for row in correspondence_rows])
    stereo_info = {"method": "SIFT3000; mutual Lowe0.75 matches; abs(vertical)<2px; disparity4..500px; depth3x3 median with>=5 nonzero and spread<=max(30raw,5%)",
                   "baseline_m_from_right_P": baseline, "frames": stereo_rows,
                   "comparison_count": len(correspondence_rows),
                   "raw_units_per_stereo_meter": stats(recorded / triangulated),
                   "relative_error_raw_as_millimeters": stats(abs(recorded / 1000 - triangulated) / triangulated),
                   "relative_error_raw_as_centimeters": stats(abs(recorded / 100 - triangulated) / triangulated),
                   "relative_error_raw_as_meters": stats(abs(recorded - triangulated) / triangulated),
                   "relative_error_180_flipped_millimeters": stats(abs(flipped / 1000 - triangulated) / triangulated),
                   "agreement_is_external_ground_truth": False}
    # Inspect unit consistency without altering any stored IMU or odometry field.
    imu_t = np.array([row["timestamp_ns"] for row in imu_rows], np.int64)
    gyro = np.array([row["gyro"] for row in imu_rows])
    odom_t = np.array([row["timestamp_ns"] for row in pose_rows], np.int64)
    odom_omega = np.array([row["angular"] for row in pose_rows])
    nearest = np.abs(imu_t[:, None] - odom_t[None, :]).argmin(axis=0)
    matched = gyro[nearest]
    good = np.linalg.norm(odom_omega, axis=1) > .05
    imu_rotation = Rotation.from_quat(np.array([row["quaternion"] for row in imu_rows]))
    rotation_rate = np.linalg.norm((imu_rotation[:-1].inv() * imu_rotation[1:]).as_rotvec(), axis=1) / (np.diff(imu_t) / 1e9)
    midpoint_gyro = (gyro[:-1] + gyro[1:]) / 2
    rotation_good = rotation_rate > .05
    pose_xyz = np.array([row["position"] for row in pose_rows])
    pose_speed = np.linalg.norm(np.diff(pose_xyz, axis=0), axis=1) / (np.diff(odom_t) / 1e9)
    sensor_checks = {
        "nearest_imu_odom_delta_ms": stats(abs(imu_t[nearest] - odom_t) / 1e6),
        "gyro_norm_raw": stats(np.linalg.norm(gyro, axis=1)),
        "acceleration_norm": stats(np.linalg.norm([row["accel"] for row in imu_rows], axis=1)),
        "odom_angular_norm": stats(np.linalg.norm(odom_omega, axis=1)),
        "raw_gyro_over_odom_angular_norm_ratio": stats(np.linalg.norm(matched[good], axis=1) / np.linalg.norm(odom_omega[good], axis=1)),
        "gyro_vector_fit_scale_to_odom": float(np.sum(matched * odom_omega) / np.sum(matched * matched)),
        "gyro_assumed_radians_vector_error_vs_odom": stats(np.linalg.norm(matched - odom_omega, axis=1)),
        "gyro_degrees_to_radians_vector_error_vs_odom": stats(np.linalg.norm(np.deg2rad(matched) - odom_omega, axis=1)),
        "raw_gyro_norm_over_imu_orientation_rate": stats(np.linalg.norm(midpoint_gyro[rotation_good], axis=1) / rotation_rate[rotation_good]),
        "pose_derived_speed_m_s": stats(pose_speed),
        "stored_odom_linear_speed_norm": stats(np.linalg.norm([row["linear"] for row in pose_rows], axis=1)),
        "pose_position_covariance_diagonal": stats([row["covariance"][i, i] for row in pose_rows for i in range(3)]),
        "pose_quaternion_norm": stats([np.linalg.norm(row["quaternion"]) for row in pose_rows]),
        "odom_and_dynamic_tf_max_position_error": max(float(np.max(abs(row["position"] - dynamic_poses[row["timestamp_ns"]][:3]))) for row in pose_rows),
        "odom_and_dynamic_tf_max_quaternion_component_error": max(float(np.max(abs(row["quaternion"] - dynamic_poses[row["timestamp_ns"]][3:]))) for row in pose_rows),
    }
    report = {"source": str(source), "source_sha256": before, "created_utc": datetime.now(timezone.utc).isoformat(),
              "source_unchanged": sha(source) == before, "script_sha256": sha(__file__),
              "source_card": "https://huggingface.co/datasets/humaidtech/EgoViz-120", "license": "CC-BY-4.0",
              "calibration": calibration, "timing": timing,
              "static_tf": {key: {"translation_xyz_quaternion_xyzw": value, "count": static_counts[key],
                                  "distinct_values": len(static_variants[key])} for key, value in static_tf.items()},
              "metadata_alignment": {"left_depth_K_equal": lk["K"] == dk["K"],
                                     "left_depth_P_equal": lk["P"] == dk["P"],
                                     "left_right_K_equal": lk["K"] == rk["K"],
                                     "left_video_probe": left_probe, "right_video_probe": right_probe},
              "depth": depth_info, "stereo_depth": stereo_info, "imu_and_pose": sensor_checks,
              "publisher_hand_labels_used_as_ground_truth": False,
              "limitations": ["Stereo and depth may share the same underlying sensor/model; consistency is not external accuracy.",
                              "Timestamp equality does not prove physical synchronization or clock calibration.",
                              "No independent tape-measure, motion-capture, or hand-joint ground truth.",
                              "Depth zero validity convention and quantization history require producer confirmation."]}
    for name, value in [("audit.json", report), ("stereo_correspondences.json", correspondence_rows)]:
        (output / name).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"depth": depth_info, "stereo_depth": stereo_info, "imu_and_pose": sensor_checks}, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    audit(args.source.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
