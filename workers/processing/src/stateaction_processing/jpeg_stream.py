"""Bounded adapter for original Stera ROS2 CompressedImage JPEG recordings.

There are no H264 lifecycle records or qualified clock mappings in this source profile.
All images are provisional until the MCAP reader verifies its index, CRCs, footer and SHA.
The message ordinal is a processing identity; it is never presented as a camera acquisition id.
"""

from __future__ import annotations

import hashlib
import struct
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, BinaryIO

from .capture_stream import (
    T_PROFILE,
    VIDEO_TOPIC,
    CaptureReport,
    CaptureStreamError,
    StreamLimits,
)
from .mcap_stream import (
    ChannelDef,
    Header,
    McapStream,
    McapStreamError,
    Message,
    SchemaDef,
)

JPEG_PROFILE = "stera_jpeg_mcap_v1"
JPEG_TOPIC = "/camera/rgb/compressed"
JPEG_CLOCK = "stera_ros_header_unqualified"
PTS_RULE = "floor_ros_stamp_ns_div_1000_then_clip_origin"
_NON_RGB_DOMAIN = {
    "/camera/depth": "depth",
    "/camera/depth/camera_info": "calibration",
    "/camera/camera_info": "calibration",
    "/camera/pose": "pose",
    "/trajectory": "pose",
    "/device/imu": "imu",
    "/capture/frame_geometry": "frame_geometry",
    "/tf": "transforms",
    "/tf_static": "transforms",
    "/map/point_cloud": "scene_geometry",
    "/map/mesh": "scene_geometry",
    "/map/mesh_cloud": "scene_geometry",
    "/device/metrics": "device_metrics",
}


def _req(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise CaptureStreamError(code, detail)


@dataclass(frozen=True)
class JpegImage:
    """Original JPEG evidence with explicit derived PTS for existing RGB consumers.

    `encoder_pts_us` is an interface alias for derived_pts_us, never a source encoder fact.
    `capture_time_ns` is an interface alias for the unqualified ROS stamp, never mapped time.
    Empty calibration/mapping fields indicate that this source supplies no such evidence.
    """

    index: int
    sequence: int
    channel_id: int
    ros_stamp_ns: str
    publish_time_ns: str
    log_time_ns: str
    frame_id: str
    sha256: str
    data: bytes
    raster: tuple[int, int]
    derived_pts_us: int
    source_encoding: str = "jpeg"
    native_clock_id: str = JPEG_CLOCK
    calibration_id: str = ""
    clock_mapping_revision: str = ""
    stream_id: str = JPEG_TOPIC
    sensor_events: tuple[dict[str, Any], ...] = ()
    native_timestamps: dict[str, Any] = field(default_factory=dict)

    @property
    def source_frame_id(self) -> str:
        return str(self.index)

    @property
    def native_timestamp_ns(self) -> str:
        return self.ros_stamp_ns

    @property
    def capture_time_ns(self) -> str:
        return self.ros_stamp_ns

    @property
    def encoder_pts_us(self) -> int:
        return self.derived_pts_us

    @property
    def is_idr(self) -> bool:
        # Independent JPEG frames allow cuts anywhere; this says nothing about source H264.
        return True

    @property
    def source_message(self) -> dict[str, Any]:
        return {
            "channel_id": self.channel_id,
            "sequence": self.sequence,
            "log_time_ns": self.log_time_ns,
            "publish_time_ns": self.publish_time_ns,
            "ros_stamp_ns": self.ros_stamp_ns,
            "frame_id": self.frame_id,
            "jpeg_sha256": self.sha256,
        }


def decode_compressed_image(data: bytes, max_jpeg_bytes: int) -> tuple[int, str, bytes]:
    """Decode bounded little-endian CDR1, including alignment relative to encapsulation."""
    _req(data[:4] == b"\x00\x01\x00\x00", "E_JPEG_CDR", "little-endian CDR1 required")
    pos = 4

    def u32(signed: bool = False) -> int:
        nonlocal pos
        pos = 4 + ((pos - 4 + 3) // 4) * 4
        _req(pos + 4 <= len(data), "E_JPEG_CDR", "truncated integer")
        value = int(struct.unpack_from("<i" if signed else "<I", data, pos)[0])
        pos += 4
        return value

    def string() -> str:
        nonlocal pos
        n = u32()
        _req(1 <= n <= 4096 and pos + n <= len(data), "E_JPEG_CDR", "string bound")
        raw = data[pos : pos + n]
        pos += n
        _req(
            raw[-1:] == b"\x00" and b"\x00" not in raw[:-1],
            "E_JPEG_CDR",
            "string terminator",
        )
        try:
            return raw[:-1].decode("utf-8")
        except UnicodeDecodeError:
            raise CaptureStreamError("E_JPEG_CDR", "invalid UTF-8") from None

    sec, nanos = u32(True), u32()
    _req(sec >= 0 and nanos < 1_000_000_000, "E_JPEG_TIMESTAMP")
    frame_id, fmt = string(), string()
    _req(fmt == "jpeg", "E_JPEG_FORMAT", fmt)
    n = u32()
    _req(n > 0 and pos + n == len(data), "E_JPEG_CDR", "image length/trailing bytes")
    _req(n <= max_jpeg_bytes, "E_ACCESS_UNIT_BOUND")
    return sec * 1_000_000_000 + nanos, frame_id, data[pos:]


def jpeg_raster(data: bytes, limits: StreamLimits) -> tuple[int, int]:
    """Read SOF dimensions before decoding, so hostile rasters cannot allocate RGB first."""
    _req(data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9", "E_JPEG_PAYLOAD")
    pos = 2
    while pos < len(data) - 2:
        _req(data[pos] == 0xFF, "E_JPEG_PAYLOAD", "marker")
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        _req(pos < len(data), "E_JPEG_PAYLOAD")
        marker = data[pos]
        pos += 1
        _req(marker not in (0x00, 0xD8, 0xD9, 0xDA), "E_JPEG_PAYLOAD", "missing SOF")
        _req(pos + 2 <= len(data), "E_JPEG_PAYLOAD")
        n = int.from_bytes(data[pos : pos + 2], "big")
        _req(n >= 2 and pos + n <= len(data), "E_JPEG_PAYLOAD", "segment length")
        if marker in (0xC0, 0xC1, 0xC2):
            _req(n >= 8 and data[pos + 2] == 8, "E_JPEG_PAYLOAD", "SOF")
            h = int.from_bytes(data[pos + 3 : pos + 5], "big")
            w = int.from_bytes(data[pos + 5 : pos + 7], "big")
            _req(
                0 < w <= limits.max_raster_side
                and 0 < h <= limits.max_raster_side
                and w * h <= limits.max_pixels,
                "E_RASTER_BOUND",
                [w, h],
            )
            return w, h
        pos += n
    raise CaptureStreamError("E_JPEG_PAYLOAD", "missing supported SOF")


class JpegCaptureStream:
    def __init__(self, raw: BinaryIO, limits: StreamLimits | None = None):
        self.limits = limits or StreamLimits()
        self._mcap = McapStream(raw, self.limits.mcap)
        self.report = CaptureReport(self._mcap.report, rgb_only=True)

    @property
    def accepted(self) -> bool:
        return self.report.accepted

    def __iter__(self) -> Iterator[JpegImage]:
        schemas: dict[int, SchemaDef] = {}
        excluded_channels: dict[int, str] = {}
        rgb_channel: int | None = None
        last_stamp = last_pts = -1
        try:
            for item in self._mcap:
                if isinstance(item, Header):
                    _req(item.profile == "ros2", "E_JPEG_PROFILE", item.profile)
                    self.report.profile = {"rgb_profile": JPEG_PROFILE}
                elif isinstance(item, SchemaDef):
                    schemas[item.id] = item
                elif isinstance(item, ChannelDef):
                    _req(item.topic not in (T_PROFILE, VIDEO_TOPIC), "E_JPEG_PROFILE")
                    if item.topic == JPEG_TOPIC:
                        schema = schemas.get(item.schema_id)
                        _req(
                            rgb_channel in (None, item.id),
                            "E_JPEG_CHANNEL",
                            "multiple RGB channels",
                        )
                        _req(
                            item.message_encoding == "cdr"
                            and schema is not None
                            and schema.name == "sensor_msgs/msg/CompressedImage"
                            and schema.encoding == "ros2msg",
                            "E_JPEG_CHANNEL",
                        )
                        rgb_channel = item.id
                    else:
                        excluded_channels[item.id] = _NON_RGB_DOMAIN.get(
                            item.topic, "other"
                        )
                elif isinstance(item, Message):
                    if item.channel_id != rgb_channel:
                        domain = excluded_channels[item.channel_id]
                        counts = self.report.excluded_messages_by_domain
                        counts[domain] = counts.get(domain, 0) + 1
                        continue
                    index = self.report.video_messages
                    _req(index < self.limits.max_frames, "E_FRAME_LIMIT")
                    stamp, frame_id, jpeg = decode_compressed_image(
                        item.data, self.limits.max_access_unit_bytes
                    )
                    pts = stamp // 1000
                    _req(stamp > last_stamp, "E_JPEG_TIMESTAMP_ORDER", stamp)
                    _req(pts > last_pts, "E_JPEG_PTS_COLLISION", stamp)
                    last_stamp, last_pts = stamp, pts
                    raster = jpeg_raster(jpeg, self.limits)
                    self.report.video_messages += 1
                    yield JpegImage(
                        index,
                        item.sequence,
                        item.channel_id,
                        str(stamp),
                        str(item.publish_time),
                        str(item.log_time),
                        frame_id,
                        hashlib.sha256(jpeg).hexdigest(),
                        jpeg,
                        raster,
                        pts,
                    )
            _req(
                rgb_channel is not None and self.report.video_messages > 0,
                "E_JPEG_CHANNEL",
                "no RGB images",
            )
            self.report.accepted = True
        except McapStreamError as error:
            raise CaptureStreamError(error.code, error.detail) from None
