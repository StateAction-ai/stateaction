#!/usr/bin/env python3
"""Independent verifier for SA-60 spike captures (stdlib only).

Reads an uncompressed generic MCAP written by the spike's Kotlin ``MCAPWriter``/
``CaptureSink`` and checks, without any code shared with the writer:

* ``container``: MCAP framing, empty profile, footer, statistics and message indexes.
* ``video``: Foxglove CompressedVideo protobuf, Annex B access units, SPS/PPS at every IDR,
  profile/level/raster from the SPS, absence of B slices and the IDR cadence.
* ``identity``: acquisition → encoder PTS → written message identity and timestamps.
* ``sensors``: independent raw accelerometer/gyroscope streams and measured cadence.

It never claims physical-device qualification: the report states which profile was
checked and every criterion outside the evidence is ``pending``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MAGIC = b"\x89MCAP0\r\n"
VIDEO_TOPIC = "/camera/rgb/video"
FRAMES_TOPIC = "/stateaction/frame_events"
ACCEL_TOPIC = "/stateaction/imu/accel"
GYRO_TOPIC = "/stateaction/imu/gyro"
SENSORS_TOPIC = "/stateaction/sensor_events"
CAMERA_INFO_TOPIC = "/camera/rgb/camera_info"
SECTIONS = ("container", "video", "identity", "sensors")

# Candidate production profile from the ticket. It is a hypothesis until measured.
HARDWARE_CANDIDATE = {
    "name": "hardware_main40_1080p30",
    "profile_idc": 77,
    "level_idc": 40,
    "width": 1920,
    "height": 1080,
    "fps": 30.0,
    "idr_interval_s": 1.0,
    "min_imu_hz": 50.0,
    # Provisional until measured on the phone: enforce the one-second IDR request and cadence in capture time.
    "enforce_time_cadence": True,
    "min_effective_fps": 27.0,
    "max_idr_interval_s": 1.5,
}
# Profile-agnostic simulation: still strict about structure, never about hardware.
SIMULATION = {
    "name": "simulation",
    "profile_idc": None,
    "level_idc": None,
    "width": None,
    "height": None,
    "fps": 30.0,
    "idr_interval_s": 1.0,
    "min_imu_hz": 0.0,
    "enforce_time_cadence": False,
    "min_effective_fps": 0.0,
    "max_idr_interval_s": 0.0,
}
PROFILES = {"simulation": SIMULATION, "hardware-candidate": HARDWARE_CANDIDATE}


class VerifyError(Exception):
    """A structural violation; message is safe to put in a report."""


# ---------------------------------------------------------------------------
# MCAP
# ---------------------------------------------------------------------------


@dataclass
class Message:
    channel_id: int
    sequence: int
    log_time: int
    publish_time: int
    data: bytes


@dataclass
class Mcap:
    profile: str = ""
    library: str = ""
    schemas: dict[int, tuple[str, str, bytes]] = field(default_factory=dict)
    channels: dict[int, tuple[str, str, int, dict[str, str]]] = field(
        default_factory=dict
    )
    messages: list[Message] = field(default_factory=list)
    statistics: dict[str, Any] | None = None
    chunk_indexes: int = 0
    footer: tuple[int, int, int] | None = None
    data_end: bool = False

    def topic_messages(self, topic: str) -> list[Message]:
        ids = {i for i, c in self.channels.items() if c[0] == topic}
        return [m for m in self.messages if m.channel_id in ids]


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def take(self, n: int) -> bytes:
        if n < 0 or self.pos + n > len(self.data):
            raise VerifyError("Truncated MCAP record")
        out = self.data[self.pos : self.pos + n]
        self.pos += n
        return out

    def u8(self) -> int:
        return self.take(1)[0]

    def u16(self) -> int:
        return struct.unpack("<H", self.take(2))[0]

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.take(8))[0]

    def string(self) -> str:
        return self.take(self.u32()).decode("utf-8")

    def string_map(self) -> dict[str, str]:
        end = self.u32() + self.pos
        out: dict[str, str] = {}
        while self.pos < end:
            key = self.string()
            out[key] = self.string()
        if self.pos != end:
            raise VerifyError("Malformed string map")
        return out

    @property
    def done(self) -> bool:
        return self.pos >= len(self.data)


def _records(blob: bytes, start: int, stop: int):
    r = _Reader(blob)
    r.pos = start
    while r.pos < stop:
        op = r.u8()
        length = r.u64()
        yield op, r.take(length)


def parse_mcap(blob: bytes) -> Mcap:
    if blob[:8] != MAGIC or blob[-8:] != MAGIC:
        raise VerifyError(
            "Missing MCAP magic at start or end (unclosed/truncated file)"
        )
    mcap = Mcap()
    saw_header = False

    def handle(op: int, body: bytes, in_chunk: bool) -> None:
        nonlocal saw_header
        r = _Reader(body)
        if op == 0x01:
            mcap.profile = r.string()
            mcap.library = r.string()
            saw_header = True
        elif op == 0x03:
            sid = r.u16()
            name, enc = r.string(), r.string()
            mcap.schemas[sid] = (name, enc, r.take(r.u32()))
        elif op == 0x04:
            cid = r.u16()
            sid = r.u16()
            topic, enc = r.string(), r.string()
            mcap.channels[cid] = (topic, enc, sid, r.string_map())
        elif op == 0x05:
            cid, seq = r.u16(), r.u32()
            log, pub = r.u64(), r.u64()
            mcap.messages.append(Message(cid, seq, log, pub, body[r.pos :]))
        elif op == 0x06:
            r.u64(), r.u64()
            uncompressed = r.u64()
            r.u32()
            compression = r.string()
            records_len = r.u64()
            if compression != "":
                raise VerifyError(f"Unsupported chunk compression {compression!r}")
            payload = r.take(records_len)
            if uncompressed != len(payload):
                raise VerifyError("Chunk uncompressed size mismatch")
            for cop, cbody in _records(payload, 0, len(payload)):
                if cop == 0x06:
                    raise VerifyError("Nested chunk")
                handle(cop, cbody, True)
        elif op == 0x08:
            mcap.chunk_indexes += 1
        elif op == 0x0B:
            stats = {
                "message_count": r.u64(),
                "schema_count": r.u16(),
                "channel_count": r.u32(),
                "attachment_count": r.u32(),
                "metadata_count": r.u32(),
                "chunk_count": r.u32(),
                "message_start_time": r.u64(),
                "message_end_time": r.u64(),
            }
            counts: dict[int, int] = {}
            end = r.u32() + r.pos
            while r.pos < end:
                cid = r.u16()
                counts[cid] = r.u64()
            stats["channel_message_counts"] = counts
            mcap.statistics = stats
        elif op == 0x02:
            mcap.footer = (r.u64(), r.u64(), r.u32())
        elif op == 0x0F:
            mcap.data_end = True

    try:
        for op, body in _records(blob, 8, len(blob) - 8):
            handle(op, body, False)
    except struct.error as error:
        raise VerifyError(f"Malformed MCAP record: {error}") from error
    if not saw_header:
        raise VerifyError("Missing MCAP header")
    return mcap


# ---------------------------------------------------------------------------
# Protobuf foxglove.CompressedVideo (fields: 1 timestamp, 2 frame_id, 3 data, 4 format)
# ---------------------------------------------------------------------------


def _varint(data: bytes, pos: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        if pos >= len(data) or shift > 63:
            raise VerifyError("Malformed protobuf varint")
        b = data[pos]
        pos += 1
        value |= (b & 127) << shift
        if not b & 128:
            return value, pos
        shift += 7


def decode_compressed_video(data: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {}
    pos = 0
    while pos < len(data):
        key, pos = _varint(data, pos)
        number, wire = key >> 3, key & 7
        if wire == 2:
            length, pos = _varint(data, pos)
            if pos + length > len(data):
                raise VerifyError("Truncated protobuf field")
            payload = data[pos : pos + length]
            pos += length
            if number == 1:
                seconds = nanos = 0
                p = 0
                while p < len(payload):
                    k, p = _varint(payload, p)
                    v, p = _varint(payload, p)
                    if k >> 3 == 1:
                        seconds = v
                    elif k >> 3 == 2:
                        nanos = v
                out["timestamp_ns"] = seconds * 1_000_000_000 + nanos
            elif number == 2:
                out["frame_id"] = payload.decode()
            elif number == 3:
                out["data"] = payload
            elif number == 4:
                out["format"] = payload.decode()
        elif wire == 0:
            _, pos = _varint(data, pos)
        else:
            raise VerifyError(f"Unexpected protobuf wire type {wire}")
    return out


# ---------------------------------------------------------------------------
# H.264 Annex B
# ---------------------------------------------------------------------------


def split_annexb(data: bytes) -> list[bytes]:
    starts: list[tuple[int, int]] = []
    i, n = 0, len(data)
    while i + 2 < n:
        if data[i] == 0 and data[i + 1] == 0:
            if data[i + 2] == 1:
                starts.append((i, 3))
                i += 3
                continue
            if i + 3 < n and data[i + 2] == 0 and data[i + 3] == 1:
                starts.append((i, 4))
                i += 4
                continue
        i += 1
    if not starts or starts[0][0] != 0:
        raise VerifyError("Access unit is not Annex B (no leading start code)")
    nals = []
    for k, (at, size) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else n
        if end <= at + size:
            raise VerifyError("Empty NAL unit")
        nals.append(data[at + size : end])
    return nals


def unescape(nal: bytes) -> bytes:
    out = bytearray()
    zeros = 0
    for b in nal:
        if zeros >= 2 and b == 3:
            zeros = 0
            continue
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
    return bytes(out)


class _Bits:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def bit(self) -> int:
        if self.pos >= len(self.data) * 8:
            raise VerifyError("Truncated H.264 header")
        v = (self.data[self.pos // 8] >> (7 - self.pos % 8)) & 1
        self.pos += 1
        return v

    def bits(self, n: int) -> int:
        v = 0
        for _ in range(n):
            v = (v << 1) | self.bit()
        return v

    def ue(self) -> int:
        zeros = 0
        while self.bit() == 0:
            zeros += 1
            if zeros > 31:
                raise VerifyError("Invalid Exp-Golomb code")
        return (1 << zeros) - 1 + self.bits(zeros)

    def se(self) -> int:
        k = self.ue()
        return (k + 1) // 2 if k % 2 else -(k // 2)


@dataclass(frozen=True)
class Sps:
    profile_idc: int
    constraint_flags: int
    level_idc: int
    width: int
    height: int
    max_num_ref_frames: int
    poc_type: int


HIGH_PROFILES = {100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135}


def parse_sps(nal: bytes) -> Sps:
    b = _Bits(unescape(nal[1:]))
    profile = b.bits(8)
    flags = b.bits(8)
    level = b.bits(8)
    b.ue()  # sps id
    chroma = 1
    if profile in HIGH_PROFILES:
        chroma = b.ue()
        if chroma == 3:
            b.bit()
        b.ue()
        b.ue()
        b.bit()
        if b.bit():
            for index in range(8 if chroma != 3 else 12):
                if b.bit():
                    last = nxt = 8
                    for _ in range(16 if index < 6 else 64):
                        if nxt:
                            nxt = (last + b.se()) % 256
                        last = last if nxt == 0 else nxt
    b.ue()  # log2_max_frame_num_minus4
    poc = b.ue()
    if poc == 0:
        b.ue()
    elif poc == 1:
        b.bit()
        b.se()
        b.se()
        for _ in range(b.ue()):
            b.se()
    max_refs = b.ue()
    b.bit()
    width_mbs = b.ue() + 1
    height_map_units = b.ue() + 1
    frame_mbs_only = b.bit()
    if not frame_mbs_only:
        b.bit()
    b.bit()
    crop = (0, 0, 0, 0)
    if b.bit():
        crop = (b.ue(), b.ue(), b.ue(), b.ue())
    sub_w, sub_h = (2, 2) if chroma in (1,) else (2, 1) if chroma == 2 else (1, 1)
    crop_unit_x = sub_w if chroma else 1
    crop_unit_y = (sub_h if chroma else 1) * (2 - frame_mbs_only)
    width = width_mbs * 16 - crop_unit_x * (crop[0] + crop[1])
    height = (2 - frame_mbs_only) * height_map_units * 16 - crop_unit_y * (
        crop[2] + crop[3]
    )
    return Sps(profile, flags, level, width, height, max_refs, poc)


def slice_header(nal: bytes) -> tuple[int, int]:
    """Return (first_mb_in_slice, slice_type % 5)."""
    b = _Bits(unescape(nal[1:])[:16])
    return b.ue(), b.ue() % 5


@dataclass
class AccessUnit:
    nal_types: list[int]
    is_idr: bool
    slice_types: list[int]
    sps: list[bytes]
    pps: list[bytes]
    parsed_sps: Sps | None


def analyse_access_unit(data: bytes) -> AccessUnit:
    nals = split_annexb(data)
    types = [n[0] & 31 for n in nals]
    if any(n[0] & 0x80 for n in nals):
        raise VerifyError("forbidden_zero_bit set")
    vcl = [(t, n) for t, n in zip(types, nals) if t in (1, 5)]
    if not vcl:
        raise VerifyError(
            "Access unit has no VCL slice (config-only packets are not frames)"
        )
    if len({t for t, _ in vcl}) != 1:
        raise VerifyError("Access unit mixes IDR and non-IDR slices")
    first_header = slice_header(vcl[0][1])
    if first_header[0] != 0:
        raise VerifyError(
            "First slice does not start at macroblock 0 (partial access unit)"
        )
    for _, slice_nal in vcl[1:]:
        if slice_header(slice_nal)[0] == 0:
            raise VerifyError("Second picture detected inside one access unit")
    first_vcl = types.index(vcl[0][0])
    if any(t in (7, 8) for t in types[first_vcl:]):
        raise VerifyError("SPS/PPS must precede the VCL slices")
    sps = [n for t, n in zip(types, nals) if t == 7]
    pps = [n for t, n in zip(types, nals) if t == 8]
    return AccessUnit(
        types,
        vcl[0][0] == 5,
        [slice_header(n)[1] for _, n in vcl],
        sps,
        pps,
        parse_sps(sps[0]) if sps else None,
    )


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


@dataclass
class Check:
    id: str
    section: str
    status: str  # pass | fail | pending
    detail: str = ""

    def as_dict(self) -> dict[str, str]:
        return {
            "id": self.id,
            "section": self.section,
            "status": self.status,
            "detail": self.detail,
        }


class Report:
    def __init__(self) -> None:
        self.checks: list[Check] = []
        self.metrics: dict[str, Any] = {}

    def add(self, section: str, ident: str, ok: bool | None, detail: str = "") -> None:
        status = "pending" if ok is None else "pass" if ok else "fail"
        self.checks.append(Check(ident, section, status, detail))

    def guarded(self, section: str, ident: str, fn) -> Any:
        try:
            return fn()
        except VerifyError as error:
            self.add(section, ident, False, str(error))
        return None

    def status_of(self, section: str) -> str:
        statuses = {c.status for c in self.checks if c.section == section}
        if not statuses:
            return "pending"
        return (
            "fail"
            if "fail" in statuses
            else "pending"
            if "pending" in statuses
            else "pass"
        )


def _json_rows(mcap: Mcap, topic: str) -> list[dict[str, Any]]:
    rows = []
    for message in mcap.topic_messages(topic):
        try:
            rows.append(json.loads(message.data))
        except ValueError as error:
            raise VerifyError(f"{topic} message is not JSON: {error}") from error
    return rows


def check_container(mcap: Mcap, report: Report) -> None:
    s = "container"
    report.add(
        s, "header_profile_generic", mcap.profile == "", f"profile={mcap.profile!r}"
    )
    report.add(s, "footer_and_data_end", mcap.footer is not None and mcap.data_end)
    stats = mcap.statistics
    if stats is None:
        report.add(s, "statistics_match_messages", False, "no statistics record")
    else:
        per: dict[int, int] = {}
        for m in mcap.messages:
            per[m.channel_id] = per.get(m.channel_id, 0) + 1
        report.add(
            s,
            "statistics_match_messages",
            stats["message_count"] == len(mcap.messages)
            and {c: n for c, n in stats["channel_message_counts"].items() if n} == per,
            f"stats={stats['message_count']} actual={len(mcap.messages)}",
        )
    report.add(s, "chunk_indexes_present", mcap.chunk_indexes > 0 or not mcap.messages)
    unknown = [m.channel_id for m in mcap.messages if m.channel_id not in mcap.channels]
    report.add(s, "messages_reference_known_channels", not unknown)
    video_schema = [
        v for v in mcap.schemas.values() if v[0] == "foxglove.CompressedVideo"
    ]
    report.add(
        s,
        "video_schema_is_protobuf_descriptor",
        bool(video_schema)
        and video_schema[0][1] == "protobuf"
        and len(video_schema[0][2]) > 100,
        "descriptor bytes=%d" % (len(video_schema[0][2]) if video_schema else 0),
    )
    bad_order = []
    last: dict[int, tuple[int, int]] = {}
    for m in mcap.messages:
        prev = last.get(m.channel_id)
        if prev and (m.log_time < prev[0] or m.sequence != prev[1] + 1):
            bad_order.append(m.channel_id)
        last[m.channel_id] = (m.log_time, m.sequence)
    report.add(s, "per_channel_log_time_and_sequence_monotonic", not bad_order)


def check_video(
    mcap: Mcap, report: Report, profile: dict[str, Any]
) -> list[tuple[Message, dict, AccessUnit]]:
    s = "video"
    out: list[tuple[Message, dict, AccessUnit]] = []
    messages = mcap.topic_messages(VIDEO_TOPIC)
    if not messages:
        report.add(s, "video_messages_present", False, "no video messages")
        return out
    report.add(s, "video_messages_present", True, f"{len(messages)} access units")
    problems: list[str] = []
    for index, message in enumerate(messages):
        try:
            video = decode_compressed_video(message.data)
            if video.get("format") != "h264":
                raise VerifyError(f"format={video.get('format')!r}")
            if "data" not in video or "timestamp_ns" not in video:
                raise VerifyError("missing data/timestamp")
            out.append((message, video, analyse_access_unit(video["data"])))
        except VerifyError as error:
            problems.append(f"message {index}: {error}")
    report.add(
        s,
        "annexb_complete_access_units",
        not problems,
        "; ".join(problems[:5]) or f"{len(out)} valid",
    )
    if problems or not out:
        return out
    aus = [a for _, _, a in out]
    report.add(s, "first_access_unit_is_idr", aus[0].is_idr)
    config_missing = [
        i for i, a in enumerate(aus) if a.is_idr and not (a.sps and a.pps)
    ]
    report.add(
        s,
        "sps_pps_precede_every_idr",
        not config_missing,
        f"IDRs missing config: {config_missing[:5]}",
    )
    first_config = next((a for a in aus if a.sps), None)
    identical = (
        all(
            a.sps == first_config.sps and a.pps == first_config.pps
            for a in aus
            if a.sps
        )
        if first_config
        else False
    )
    report.add(s, "configuration_packets_stable", identical)
    b_slices = [i for i, a in enumerate(aus) if any(t == 1 for t in a.slice_types)]
    report.add(
        s, "no_b_slices", not b_slices, f"B slices in access units {b_slices[:5]}"
    )
    sps = first_config.parsed_sps if first_config else None
    report.metrics["video"] = {
        "access_units": len(aus),
        "bytes": sum(len(v["data"]) for _, v, _ in out),
        "idr_count": sum(a.is_idr for a in aus),
    }
    if sps is None:
        report.add(s, "sps_parsed", False, "no SPS found")
    else:
        report.metrics["video"].update(
            profile_idc=sps.profile_idc,
            level_idc=sps.level_idc,
            width=sps.width,
            height=sps.height,
            max_num_ref_frames=sps.max_num_ref_frames,
            poc_type=sps.poc_type,
        )
        for name, actual in (
            ("profile_idc", sps.profile_idc),
            ("level_idc", sps.level_idc),
            ("width", sps.width),
            ("height", sps.height),
        ):
            want = profile[name]
            if want is None:
                report.add(
                    s,
                    f"sps_{name}_matches_profile",
                    None,
                    f"{profile['name']} does not constrain; observed {actual}",
                )
            else:
                report.add(
                    s,
                    f"sps_{name}_matches_profile",
                    actual == want,
                    f"observed {actual}, profile requires {want}",
                )
    # IDR cadence in frames and in capture time.
    stamps = [v["timestamp_ns"] for _, v, _ in out]
    idr_at = [i for i, a in enumerate(aus) if a.is_idr]
    max_gap = max((b - a for a, b in zip(idr_at, idr_at[1:])), default=0)
    limit_frames = math.ceil(profile["fps"] * profile["idr_interval_s"] * 1.5)
    tail = len(aus) - idr_at[-1] if idr_at else len(aus)
    report.add(
        s,
        "idr_cadence_within_bound",
        max(max_gap, tail if len(idr_at) > 1 else 0) <= limit_frames,
        f"max IDR gap {max_gap} frames (bound {limit_frames}), tail {tail}",
    )
    gaps_s = [(stamps[b] - stamps[a]) / 1e9 for a, b in zip(idr_at, idr_at[1:])]
    report.metrics["video"]["idr_interval_s"] = {
        "min": min(gaps_s, default=None),
        "max": max(gaps_s, default=None),
    }
    if len(stamps) > 1:
        deltas = sorted((b - a) / 1e9 for a, b in zip(stamps, stamps[1:]))
        median = deltas[len(deltas) // 2]
        report.metrics["video"]["frame_interval_s"] = {
            "median": median,
            "max": deltas[-1],
            "effective_fps": 1 / median if median > 0 else None,
        }
    time_ok = (
        None
        if not profile["enforce_time_cadence"]
        else (bool(gaps_s) and max(gaps_s) <= profile["max_idr_interval_s"])
    )
    report.add(
        s,
        "idr_interval_seconds_within_bound",
        time_ok,
        f"observed max {max(gaps_s, default=None)} s; {profile['name']} bound {profile['max_idr_interval_s'] or 'not enforced'}",
    )
    fps = report.metrics["video"].get("frame_interval_s", {}).get("effective_fps")
    fps_ok = (
        None
        if not profile["enforce_time_cadence"]
        else bool(fps and fps >= profile["min_effective_fps"])
    )
    report.add(
        s,
        "effective_frame_rate_within_bound",
        fps_ok,
        f"observed {fps} fps; provisional minimum {profile['min_effective_fps'] or 'not enforced'}",
    )
    report.add(
        s,
        "capture_timestamps_strictly_increasing",
        all(b > a for a, b in zip(stamps, stamps[1:])),
    )
    return out


def check_identity(
    mcap: Mcap, report: Report, video: list[tuple[Message, dict, AccessUnit]]
) -> None:
    s = "identity"
    rows = report.guarded(
        s, "frame_events_json", lambda: _json_rows(mcap, FRAMES_TOPIC)
    )
    if rows is None:
        return
    acquired = [r for r in rows if r.get("state") == "acquired"]
    written = [r for r in rows if r.get("state") == "written"]
    dropped = [r for r in rows if r.get("state") == "dropped"]
    report.metrics["frames"] = {
        "acquired": len(acquired),
        "written": len(written),
        "dropped": len(dropped),
    }
    if not acquired:
        report.add(s, "frame_events_present", False, "no acquired rows")
        return
    ids = [r["source_frame_id"] for r in acquired]
    report.add(s, "source_frame_ids_unique", len(set(ids)) == len(ids))
    terminal = [r["source_frame_id"] for r in written + dropped]
    report.add(
        s,
        "every_acquisition_has_exactly_one_outcome",
        sorted(terminal) == sorted(ids),
        f"acquired={len(ids)} outcomes={len(terminal)}",
    )
    report.add(
        s,
        "written_rows_match_video_messages",
        len(written) == len(video),
        f"written={len(written)} video={len(video)}",
    )
    # FramePts: pts = max(previous+1, (capture_ns - origin_ns) // 1000)
    previous, origin, bad_pts = -1, None, []
    native = {r["source_frame_id"]: r for r in acquired}
    for r in acquired:
        ns = int(r["native_timestamp_ns"])
        origin = ns if origin is None else origin
        expected = max(previous + 1, (ns - origin) // 1000)
        previous = expected
        if int(r["encoder_pts_us"]) != expected:
            bad_pts.append(r["source_frame_id"])
    report.add(
        s,
        "encoder_pts_derived_from_acquisition_time",
        not bad_pts,
        f"mismatched ids {bad_pts[:5]}",
    )
    pts = [int(r["encoder_pts_us"]) for r in acquired]
    report.add(
        s,
        "encoder_pts_strictly_increasing_unique",
        all(b > a for a, b in zip(pts, pts[1:])),
    )
    mismatches = []
    by_seq = {int(r["output_sequence"]): r for r in written}
    for index, (message, v, au) in enumerate(video):
        row = by_seq.get(message.sequence)
        if row is None:
            mismatches.append(f"seq {message.sequence}: no written row")
            continue
        origin_row = native.get(row["source_frame_id"])
        if origin_row is None:
            mismatches.append(f"seq {message.sequence}: unknown source frame")
        elif int(origin_row["encoder_pts_us"]) != int(row["encoder_pts_us"]):
            mismatches.append(
                f"seq {message.sequence}: PTS changed between acquisition and write"
            )
        if int(row["mapped_capture_time_ns"]) != v["timestamp_ns"]:
            mismatches.append(
                f"seq {message.sequence}: protobuf timestamp != mapped capture time"
            )
        if bool(row.get("is_idr")) != au.is_idr:
            mismatches.append(
                f"seq {message.sequence}: is_idr disagrees with bitstream"
            )
    report.add(
        s,
        "acquisition_to_pts_to_message_identity",
        not mismatches,
        "; ".join(mismatches[:5]),
    )
    report.add(
        s,
        "original_native_times_retained",
        all(
            "native_timestamp_ns" in r and int(r["native_timestamp_ns"]) > 0
            for r in acquired
        ),
    )
    info = mcap.topic_messages(CAMERA_INFO_TOPIC)
    report.add(
        s,
        "camera_info_per_acquired_frame",
        len(info) == len(acquired),
        f"info={len(info)} acquired={len(acquired)}",
    )
    unresolved = len(acquired) - len(written) - len(dropped)
    report.add(
        s,
        "no_unresolved_frames_after_close",
        unresolved == 0,
        f"unresolved={unresolved}",
    )


def check_sensors(
    mcap: Mcap, report: Report, profile: dict[str, Any], min_events: int
) -> None:
    s = "sensors"
    for name, topic, units, gravity in (
        ("accel", ACCEL_TOPIC, "m/s^2", True),
        ("gyro", GYRO_TOPIC, "rad/s", False),
    ):
        rows = report.guarded(s, f"{name}_json", lambda t=topic: _json_rows(mcap, t))
        if rows is None:
            continue
        report.add(
            s,
            f"{name}_events_present",
            len(rows) >= max(min_events, 1),
            f"{len(rows)} events (minimum {max(min_events, 1)})",
        )
        if len(rows) < 2:
            continue
        times = [int(r["native_timestamp_ns"]) for r in rows]
        report.add(
            s,
            f"{name}_native_times_strictly_increasing",
            all(b > a for a, b in zip(times, times[1:])),
        )
        report.add(
            s,
            f"{name}_event_ids_contiguous",
            [int(r["event_id"]) for r in rows] == list(range(len(rows))),
        )
        report.add(
            s,
            f"{name}_units_and_axes_recorded",
            all(
                r.get("units") == units
                and r.get("axes") == "android_device_native"
                and r.get("includes_gravity") is gravity
                and r.get("native_clock_id") == "android.elapsed_realtime"
                for r in rows
            ),
        )
        report.add(
            s,
            f"{name}_three_finite_axes",
            all(
                len(r["values"]) == 3
                and all(math.isfinite(float(x)) for x in r["values"])
                for r in rows
            ),
        )
        mapped = [int(r["mapped_capture_time_ns"]) for r in rows]
        report.add(
            s,
            f"{name}_mapped_times_monotonic",
            all(b >= a for a, b in zip(mapped, mapped[1:])),
        )
        deltas = sorted((b - a) / 1e9 for a, b in zip(times, times[1:]))
        median = deltas[len(deltas) // 2]
        hz = 1 / median if median > 0 else None
        span = (times[-1] - times[0]) / 1e9
        report.metrics[name] = {
            "events": len(rows),
            "median_hz": hz,
            "mean_hz": (len(rows) - 1) / span if span else None,
            "max_gap_s": deltas[-1],
            "sensor": rows[0].get("sensor_name"),
        }
        if profile["min_imu_hz"] > 0:
            report.add(
                s,
                f"{name}_rate_at_least_profile_minimum",
                bool(hz and hz >= profile["min_imu_hz"]),
                f"median {hz} Hz, provisional minimum {profile['min_imu_hz']} Hz",
            )
    report.add(
        s,
        "sensors_independent_of_video_channel",
        {c[0] for c in mcap.channels.values()} >= {ACCEL_TOPIC, GYRO_TOPIC},
        "accelerometer and gyroscope are separate channels",
    )


def verify(
    blob: bytes,
    profile_name: str,
    require: tuple[str, ...],
    min_sensor_events: int = 10,
) -> dict[str, Any]:
    profile = PROFILES[profile_name]
    report = Report()
    mcap = parse_mcap(blob)
    check_container(mcap, report)
    video = check_video(mcap, report, profile) or []
    if "identity" in require:
        check_identity(mcap, report, video)
    if "sensors" in require:
        check_sensors(mcap, report, profile, min_sensor_events)
    sections = {s: report.status_of(s) for s in SECTIONS}
    for s in SECTIONS:
        if s not in require:
            sections[s] = "not_requested"
    verdict = "fail" if "fail" in sections.values() else "pass"
    return {
        "verifier": "sa-60-capture-verify/1",
        "profile": profile,
        "physical_hardware_qualified": False,
        "note": "Structural verification of the supplied file only. Who produced it (emulator, synthetic or phone) is recorded by the caller, never inferred.",
        "mcap": {
            "sha256": hashlib.sha256(blob).hexdigest(),
            "bytes": len(blob),
            "library": mcap.library,
            "channels": sorted(c[0] for c in mcap.channels.values()),
        },
        "sections": sections,
        "verdict": verdict,
        "metrics": report.metrics,
        "checks": [c.as_dict() for c in report.checks],
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("mcap", type=Path)
    p.add_argument("--profile", choices=sorted(PROFILES), default="simulation")
    p.add_argument(
        "--require",
        default=",".join(SECTIONS),
        help="comma-separated sections: " + ",".join(SECTIONS),
    )
    p.add_argument("--min-sensor-events", type=int, default=10)
    p.add_argument(
        "--output",
        type=Path,
        help="write the JSON report here (ignored directories only)",
    )
    args = p.parse_args(argv)
    require = tuple(x for x in args.require.split(",") if x)
    if (
        not set(require) <= set(SECTIONS)
        or "container" not in require
        and "video" not in require
    ):
        p.error("invalid --require")
    try:
        result = verify(
            args.mcap.read_bytes(), args.profile, require, args.min_sensor_events
        )
    except VerifyError as error:
        result = {
            "verdict": "fail",
            "error": str(error),
            "physical_hardware_qualified": False,
        }
    text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    else:
        sys.stdout.write(text)
    return 0 if result["verdict"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
