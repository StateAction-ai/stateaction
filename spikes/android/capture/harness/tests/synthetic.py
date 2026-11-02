"""Builds spike-shaped MCAP files from synthetic H.264 so verifier tests are repeatable."""

from __future__ import annotations

import json
import struct
from pathlib import Path

import capture_verify as v

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
EPOCH = 1_800_000_000_123_456_789


def split_access_units(stream: bytes) -> list[bytes]:
    """Group a raw Annex B elementary stream into one byte string per picture."""
    nals = v.split_annexb(stream)
    units: list[list[bytes]] = []
    seen_vcl = False
    for nal in nals:
        kind = nal[0] & 31
        starts = kind in (7, 8, 9) or (kind in (1, 5) and v.slice_header(nal)[0] == 0)
        if starts and seen_vcl:
            units.append([])
            seen_vcl = False
        if not units:
            units.append([])
        units[-1].append(nal)
        seen_vcl = seen_vcl or kind in (1, 5)
    return [b"".join(b"\x00\x00\x00\x01" + n for n in unit) for unit in units]


def _s(text: str) -> bytes:
    raw = text.encode()
    return struct.pack("<I", len(raw)) + raw


def _record(op: int, body: bytes) -> bytes:
    return bytes([op]) + struct.pack("<Q", len(body)) + body


def _varint(n: int) -> bytes:
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out)


def compressed_video(ns: int, data: bytes, fmt: str = "h264") -> bytes:
    stamp = b"\x08" + _varint(ns // 10**9) + b"\x10" + _varint(ns % 10**9)

    def field(number: int, payload: bytes) -> bytes:
        return _varint(number << 3 | 2) + _varint(len(payload)) + payload

    return (
        field(1, stamp)
        + field(2, b"camera_rgb_optical")
        + field(3, data)
        + field(4, fmt.encode())
    )


class McapBuilder:
    def __init__(self, profile: str = "") -> None:
        self.profile = profile
        self.schemas: list[bytes] = []
        self.channels: list[tuple[int, str]] = []
        self.messages: list[tuple[int, int, int, bytes]] = []
        self.sequences: dict[int, int] = {}

    def channel(
        self,
        topic: str,
        encoding: str,
        schema_name: str,
        schema_encoding: str,
        schema_data: bytes,
    ) -> int:
        sid = len(self.schemas) + 1
        self.schemas.append(
            _record(
                3,
                struct.pack("<H", sid)
                + _s(schema_name)
                + _s(schema_encoding)
                + struct.pack("<I", len(schema_data))
                + schema_data,
            )
        )
        cid = len(self.channels) + 1
        self.channels.append((cid, topic))
        self.schemas.append(
            _record(
                4,
                struct.pack("<HH", cid, sid)
                + _s(topic)
                + _s(encoding)
                + struct.pack("<I", 0),
            )
        )
        return cid

    def message(
        self, channel: int, log_time: int, data: bytes, sequence: int | None = None
    ) -> None:
        seq = self.sequences.get(channel, 0) if sequence is None else sequence
        self.sequences[channel] = seq + 1
        self.messages.append((channel, seq, log_time, data))

    def build(
        self, *, statistics_count_delta: int = 0, truncate_tail: bool = False
    ) -> bytes:
        body = bytearray(v.MAGIC)
        body += _record(1, _s(self.profile) + _s("synthetic-test"))
        records = b"".join(self.schemas)
        counts: dict[int, int] = {}
        for cid, seq, log, data in self.messages:
            records += _record(5, struct.pack("<HIQQ", cid, seq, log, log) + data)
            counts[cid] = counts.get(cid, 0) + 1
        times = [m[2] for m in self.messages] or [0]
        chunk = (
            struct.pack("<QQQI", min(times), max(times), len(records), 0)
            + _s("")
            + struct.pack("<Q", len(records))
            + records
        )
        chunk_start = len(body)
        body += _record(6, chunk)
        body += _record(0x0F, struct.pack("<I", 0))
        summary_start = len(body)
        body += b"".join(self.schemas)
        body += _record(
            8,
            struct.pack("<QQQQ", min(times), max(times), chunk_start, len(chunk))
            + struct.pack("<I", 0)
            + struct.pack("<Q", 0)
            + _s("")
            + struct.pack("<QQ", len(records), len(records)),
        )
        per = b"".join(struct.pack("<HQ", c, n) for c, n in counts.items())
        body += _record(
            0x0B,
            struct.pack(
                "<QHIIIIQQ",
                len(self.messages) + statistics_count_delta,
                len(self.schemas) // 2,
                len(self.channels),
                0,
                0,
                1,
                min(times),
                max(times),
            )
            + struct.pack("<I", len(per))
            + per,
        )
        body += _record(2, struct.pack("<QQI", summary_start, 0, 0))
        body += v.MAGIC
        return bytes(body[:-12]) if truncate_tail else bytes(body)


def build_capture(
    stream_name: str = "main-nob.h264",
    *,
    sensors: bool = True,
    tamper=None,
    fps: float = 30.0,
    profile: str = "",
) -> bytes:
    """A capture shaped like CaptureEngine/CaptureSink output, with exact identities."""
    units = split_access_units((FIXTURES / stream_name).read_bytes())
    b = McapBuilder(profile)
    video = b.channel(
        v.VIDEO_TOPIC, "protobuf", "foxglove.CompressedVideo", "protobuf", b"D" * 200
    )
    frames = b.channel(
        v.FRAMES_TOPIC, "json", "stateaction.capture.FrameEvent.v1", "jsonschema", b"{}"
    )
    info = b.channel(
        v.CAMERA_INFO_TOPIC, "cdr", "sensor_msgs/msg/CameraInfo", "ros2msg", b"x"
    )
    accel = b.channel(
        v.ACCEL_TOPIC, "json", "stateaction.capture.MotionEvent.v1", "jsonschema", b"{}"
    )
    gyro = b.channel(
        v.GYRO_TOPIC, "json", "stateaction.capture.MotionEvent.v1", "jsonschema", b"{}"
    )
    step = int(1e9 / fps)
    native0 = 5_000_000_000_000
    log = EPOCH
    for index, unit in enumerate(units):
        native = native0 + index * step
        mapped = EPOCH + index * step
        pts = (native - native0) // 1000
        row = {
            "source_frame_id": str(index),
            "state": "acquired",
            "native_timestamp_ns": str(native),
            "mapped_capture_time_ns": str(mapped),
            "encoder_pts_us": str(pts),
        }
        is_idr = bool((unit.find(b"\x00\x00\x00\x01\x65") >= 0))
        b.message(frames, log, json.dumps(row).encode())
        b.message(info, log, b"\x00\x01\x00\x00")
        written = dict(row, output_sequence=index, is_idr=is_idr, state="written")
        b.message(video, log + 1, compressed_video(mapped, unit))
        b.message(frames, log + 2, json.dumps(written).encode())
        log += step
    if sensors:
        for sid, name, unit_name, gravity in (
            (accel, "accel", "m/s^2", True),
            (gyro, "gyro", "rad/s", False),
        ):
            for k in range(60):
                b.message(
                    sid,
                    EPOCH + k * 10_000_000,
                    json.dumps(
                        {
                            "stream_id": name,
                            "event_id": str(k),
                            "native_timestamp_ns": str(7_000_000_000 + k * 10_000_000),
                            "native_clock_id": "android.elapsed_realtime",
                            "mapped_capture_time_ns": str(EPOCH + k * 10_000_000),
                            "axes": "android_device_native",
                            "units": unit_name,
                            "includes_gravity": gravity,
                            "accuracy": 3,
                            "values": [0.1, 0.2, 9.8 if gravity else 0.0],
                            "sensor_name": "synthetic",
                        }
                    ).encode(),
                )
    if tamper:
        tamper(b)
    return b.build()
