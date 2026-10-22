"""Read a versioned Android image/pose contract without guessing registration.

The old Pixel capture can be inspected with an explicitly requested 180-degree
hypothesis. That mode is never considered calibrated or timing-verified.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
from pathlib import Path

import numpy as np
from stera.data.mcap import MCAPReader, CameraIntrinsics
from stera.data.mcap import _decoders as dec

VERSION_V1 = "android_arcore_cpu_v1"
VERSION = "android_arcore_cpu_v2"
SUPPORTED_VERSIONS = frozenset((VERSION_V1, VERSION))
OPTICAL_TO_ARCORE = np.diag([1., -1., -1.])
LEGACY_SHA256 = "8e508a5605ad01cf51de77e9d5600a8fcb5e65a4180dcc45a3261e63cb97c6bf"


def header_ns(msg):
    stamp = msg.header.stamp
    return int(stamp.sec) * 1_000_000_000 + int(stamp.nanosec)


def intrinsic_matrix(value):
    k = np.array([[value["focalLengthX"], 0, value["principalPointX"]],
                  [0, value["focalLengthY"], value["principalPointY"]],
                  [0, 0, 1]], dtype=float)
    if not np.isfinite(k).all() or k[0, 0] <= 0 or k[1, 1] <= 0:
        raise ValueError("Invalid per-frame camera intrinsics")
    return k


def validate_record(row, rgb_shape, depth_shape=None, max_depth_dt=.033):
    """Validate independently recorded mapping, dimensions and clock association."""
    version = row.get("capture_geometry_version")
    if version not in SUPPORTED_VERSIONS or not row.get("rgb_encoded"):
        raise ValueError("Missing/unsupported encoded-frame geometry contract")
    frame_timestamp = int(row["frame_timestamp_ns"])
    rgb_timestamp = int(row["rgb_timestamp_ns"])
    if version == VERSION_V1 and frame_timestamp != rgb_timestamp:
        raise ValueError("CPU image and pose frame timestamps differ")
    if version == VERSION:
        android_camera_timestamp = row.get("android_camera_timestamp_ns")
        if android_camera_timestamp is None or int(android_camera_timestamp) != rgb_timestamp:
            raise ValueError("CPU image timestamp differs from Android camera timestamp")
        if row.get("cross_stream_clock_verified") is not False:
            raise ValueError("v2 requires explicit unverified cross-stream clock semantics")
    width, height = rgb_shape[1], rgb_shape[0]
    if (row["rgb_width"], row["rgb_height"]) != (width, height):
        raise ValueError("Saved RGB dimensions disagree with geometry record")
    ri = row["rgb_intrinsics"]
    if (ri["imageWidth"], ri["imageHeight"]) != (width, height):
        raise ValueError("RGB calibration dimensions disagree with saved pixels")
    kr = intrinsic_matrix(ri)
    kd, mapping, depth_delta = None, None, None
    timing_verified = False
    if row.get("depth_available"):
        if depth_shape is None:
            raise ValueError("Geometry record references absent depth payload")
        dh, dw = depth_shape
        di = row["depth_intrinsics"]
        if (row["depth_width"], row["depth_height"]) != (dw, dh) or (di["imageWidth"], di["imageHeight"]) != (dw, dh):
            raise ValueError("Depth raster and calibration dimensions disagree")
        kd = intrinsic_matrix(di)
        mapping = np.array(row["rgb_pixel_to_depth_pixel"], dtype=float).reshape(3, 3)
        if not np.isfinite(mapping).all() or not np.allclose(mapping[2], [0, 0, 1], atol=1e-6):
            raise ValueError("Invalid RGB-to-depth mapping")
        if mapping[0, 0] <= 0 or mapping[1, 1] <= 0 or abs(mapping[0, 1]) > 1e-5 or abs(mapping[1, 0]) > 1e-5:
            raise ValueError("CPU/depth mapping has unsupported optical-axis rotation")
        if not np.allclose(kd, mapping @ kr, atol=1e-3, rtol=1e-5):
            raise ValueError("Depth intrinsics disagree with recorded pixel mapping")
        # These are native clocks with no verified common timebase. A numeric
        # difference (even zero) cannot establish depth age or synchronization.
        # v1 incorrectly assumed that equality of RGB/Frame clock numbers was
        # a cross-stream guarantee; retained v1 data is conservatively unverified.
        if row.get("depth_timestamp_ns") is None:
            raise ValueError("Available depth lacks a native acquisition timestamp")
    return {"rgb_K": kr, "depth_K": kd, "rgb_to_depth": mapping,
            "calibration_contract_verified": True,
            "depth_registered": mapping is not None,
            "depth_time_verified": timing_verified,
            "depth_dt_s": depth_delta,
            "cross_stream_clock_verified": False,
            "frame_event_timestamp_ns": frame_timestamp,
            "rgb_timestamp_ns": rgb_timestamp,
            "timestamp_semantics": "frame event in ARCore clock; RGB and depth retain native clocks; no cross-stream clock calibration",
            "tracking": row["tracking_state"] == "TRACKING",
            "source": row, "metric_accuracy_validated": False}


def rotate_intrinsics_180(intrinsic):
    k = intrinsic.K.copy()
    k[0, 2] = intrinsic.width - 1 - k[0, 2]
    k[1, 2] = intrinsic.height - 1 - k[1, 2]
    return dataclasses.replace(intrinsic, K=k)


class GeometrySession(MCAPReader):
    """Keep exact acquisition association and per-frame calibration in the SDK."""

    def __init__(self, path, *, legacy_hypothesis=False, max_depth_dt=.033):
        super().__init__(path)
        self.metadata = json.loads((Path(path).parent / "metadata.json").read_text())
        for flag in ("capture_result_valid", "finalization_complete"):
            if self.metadata.get(flag) is False:
                raise ValueError(f"Capture metadata declares {flag}=false; failed capture cannot be processed")
        self.version = self.metadata.get("capture_geometry_version")
        if self.version is not None and self.version not in SUPPORTED_VERSIONS:
            raise ValueError(f"Unsupported capture_geometry_version: {self.version!r}")
        self.legacy_hypothesis = legacy_hypothesis
        self.max_depth_dt = max_depth_dt
        if not np.isfinite(max_depth_dt) or max_depth_dt < 0:
            raise ValueError("Depth timestamp tolerance must be finite and nonnegative")
        self._geometry_rows = {}
        self._native_rgb_times = []
        self._rgb_events = []
        self._event_rgb_times = {}
        self._event_depth = {}
        self._event_pose = {}
        self._saved_rgb_shape = None
        self._saved_depth_shape = None
        self.frame_geometry = []
        if self.num_rgb_frames == 0:
            raise ValueError("Capture contains zero encoded RGB frames; inspect recorder failure metadata before processing")
        if legacy_hypothesis:
            with Path(path).open("rb") as f:
                digest = hashlib.file_digest(f, "sha256").hexdigest()
            if digest != LEGACY_SHA256:
                raise ValueError("180-degree hypothesis is limited to the audited Pixel capture")
            self._rgb_intrinsics = rotate_intrinsics_180(self.rgb_intrinsics)
            self._depth_intrinsics = rotate_intrinsics_180(self.depth_intrinsics)
            self._optical_to_link = OPTICAL_TO_ARCORE @ np.diag([-1., -1., 1.])
        elif self.version in SUPPORTED_VERSIONS:
            if not np.allclose(self.R_optical_to_link, OPTICAL_TO_ARCORE, atol=1e-6):
                raise ValueError("Versioned Android capture has an incorrect optical transform")
            for _ts, parent, child, pose in self.tf_transforms():
                if "link" in parent and "optical" in child:
                    if not np.allclose(pose.rotation, OPTICAL_TO_ARCORE, atol=1e-6) or not np.allclose(pose.translation, 0, atol=1e-8):
                        raise ValueError("Per-frame optical transform violates the capture contract")
            self._load_geometry()

    def _load_geometry(self):
        topics = ["/capture/frame_geometry", self._topics.rgb, self._topics.depth, self._topics.camera_pose]
        with self.path.open("rb") as stream:
            reader = self._reader._make_reader(stream)
            for _schema, channel, message, decoded in reader.iter_decoded_messages(topics=topics):
                if channel.topic == "/capture/frame_geometry":
                    row = json.loads(decoded.data)
                    if row.get("capture_geometry_version") != self.version:
                        raise ValueError("Frame has unsupported or metadata-mismatched geometry version")
                    if not row.get("rgb_encoded"):
                        continue
                    event = int(row["frame_timestamp_ns"])
                    if message.log_time != event or message.publish_time != event:
                        raise ValueError("Geometry record timestamps do not identify its frame event")
                    if event in self._geometry_rows:
                        raise ValueError("Duplicate encoded frame geometry")
                    self._geometry_rows[event] = row
                elif channel.topic == self._topics.rgb:
                    event, native = int(message.log_time), header_ns(decoded)
                    if event in self._event_rgb_times:
                        raise ValueError("Ambiguous duplicate RGB acquisition event")
                    if message.publish_time != native:
                        raise ValueError("RGB publish time and native header timestamp disagree")
                    self._rgb_events.append(event)
                    self._native_rgb_times.append(native)
                    self._event_rgb_times[event] = native
                elif channel.topic == self._topics.depth:
                    event = int(message.log_time)
                    if event in self._event_depth:
                        raise ValueError("Ambiguous duplicate depth event")
                    if message.publish_time != header_ns(decoded):
                        raise ValueError("Depth publish time and native header timestamp disagree")
                    self._event_depth[event] = (header_ns(decoded), dec.decode_depth_image(decoded)[1])
                elif channel.topic == self._topics.camera_pose:
                    event = header_ns(decoded)
                    if message.log_time != event or message.publish_time != event:
                        raise ValueError("Pose timestamps do not identify its frame event")
                    if event in self._event_pose:
                        raise ValueError("Ambiguous duplicate pose event")
                    self._event_pose[event] = dec.decode_pose_stamped(decoded)[1]
        if set(self._rgb_events) != set(self._geometry_rows) or len(self._rgb_events) != len(self._geometry_rows):
            raise ValueError("Saved RGB and geometry rows do not correspond one-to-one")
        for event, native in self._event_rgb_times.items():
            if native != self._geometry_rows[event].get("rgb_timestamp_ns"):
                raise ValueError("RGB header does not match its acquisition record")

    def depth_frames(self):
        for timestamp, depth in super().depth_frames():
            yield timestamp, depth[::-1, ::-1].copy() if self.legacy_hypothesis else depth

    def frames(self, max_depth_dt=None, max_pose_dt=.1):
        # The SDK's initial synchronization is overridden below for versioned
        # captures: association is by acquiring frame, never nearest depth time.
        effective_depth_dt = self.max_depth_dt if max_depth_dt is None else max_depth_dt
        if not np.isfinite(effective_depth_dt) or effective_depth_dt < 0:
            raise ValueError("Depth timestamp tolerance must be finite and nonnegative")
        self.frame_geometry = []
        for frame in super().frames(max_depth_dt=effective_depth_dt, max_pose_dt=max_pose_dt):
            if self._saved_rgb_shape is None:
                self._saved_rgb_shape = frame.rgb.shape
            if frame.rgb.shape != self._saved_rgb_shape:
                raise ValueError("Changing RGB raster size cannot be exported as a fixed-size episode")
            if self.version in SUPPORTED_VERSIONS and not self.legacy_hypothesis:
                event = self._rgb_events[frame.index]
                row = self._geometry_rows[event]
                payload = self._event_depth.get(event) if row.get("depth_available") else None
                if payload is not None and payload[0] != row["depth_timestamp_ns"]:
                    raise ValueError("Depth header does not match its acquisition record")
                frame.depth = None if payload is None else payload[1]
                geometry = validate_record(row, frame.rgb.shape, None if frame.depth is None else frame.depth.shape, effective_depth_dt)
                if frame.depth is not None:
                    if self._saved_depth_shape is None:
                        self._saved_depth_shape = frame.depth.shape
                    if frame.depth.shape != self._saved_depth_shape:
                        raise ValueError("Changing depth raster size cannot be exported with native calibration")
                    initial = self.depth_intrinsics
                    if initial is not None and frame.depth.shape != (initial.height, initial.width):
                        raise ValueError("Depth raster disagrees with episode calibration size")
                frame.rgb_K, frame.depth_K = geometry["rgb_K"], geometry["depth_K"]
                frame.camera_pose = self._event_pose.get(event) if geometry["tracking"] else None
                if geometry["tracking"] and frame.camera_pose is None:
                    raise ValueError("Tracked RGB frame has no matching physical camera pose")
                # The base SDK searches IMU by nearest native RGB timestamp.
                # Without a verified shared clock that association is invalid.
                frame.imu = None
            else:
                geometry = {
                    "rgb_K": frame.rgb_K, "depth_K": frame.depth_K,
                    "rgb_to_depth": frame.depth_K @ np.linalg.inv(frame.rgb_K) if self.legacy_hypothesis and frame.depth_K is not None else None,
                    "calibration_contract_verified": False, "depth_registered": False,
                    "depth_time_verified": False, "depth_dt_s": None,
                    "cross_stream_clock_verified": False,
                    "tracking": frame.camera_pose is not None,
                    "metric_accuracy_validated": False,
                    "source": {"mode": "legacy_180_degree_hypothesis" if self.legacy_hypothesis else "unversioned_unverified"},
                }
            frame.geometry = geometry
            self.frame_geometry.append(geometry)
            yield frame

    @property
    def geometry_summary(self):
        return {"capture_geometry_version": self.version,
                "legacy_hypothesis": self.legacy_hypothesis,
                "metric_accuracy_validated": False,
                "depth_max_dt_s": self.max_depth_dt,
                "cross_stream_clock_verified": False,
                "depth_age_available": False,
                "mapping_source": "recorded_per_frame" if self.version in SUPPORTED_VERSIONS else "inferred_180_degree_hypothesis" if self.legacy_hypothesis else "unavailable"}
