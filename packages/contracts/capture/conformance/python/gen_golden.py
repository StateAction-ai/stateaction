"""Deterministically build the golden MCAP files and expected results.

Run from the repository root:
  uv run --no-project --with protobuf==6.33.0 python packages/contracts/capture/conformance/python/gen_golden.py

The source H.264 streams in golden/source were produced once with ffmpeg/libx264 (baseline,
no B-frames; and main with B-frames) and are committed, so regeneration needs no encoder.
The MCAPs use an unchunked, uncompressed generic layout (empty header profile) so every
language runner can parse them without an MCAP dependency. Synthetic data only.
"""

from __future__ import annotations

import json
import re
import struct
import sys
import zlib

import capture_conformance as cc

CAP = cc.CAPTURE_DIR
GOLD = CAP / "golden"
BASE_CAPTURE_NS = (
    1_800_000_000_000_000_007  # > 2**53: exercises decimal-string handling
)
BASE_NATIVE_NS = 1_000_000_007
STEP_NS = 33_333_333
REC = "0b6f5e1c-3d2a-4c8e-9f1a-5e2d7c4b3a19"  # domain recording ID: UUID
OTHER_REC = "7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def split_access_units(stream: bytes) -> list[bytes]:
    units = cc.nals(stream)
    aus, cur = [], []
    for n in units:
        t = n[0] & 31
        if (
            t in (1, 5)
            and cc.slice_header(n)[0] == 0
            and any((c[0] & 31) in (1, 5) for c in cur)
        ):
            aus.append(cur)
            cur = []
        cur.append(n)
    aus.append(cur)
    return [b"".join(b"\x00\x00\x00\x01" + n for n in au) for au in aus]


def rec(op: int, body: bytes) -> bytes:
    return struct.pack("<BQ", op, len(body)) + body


def s(text: str) -> bytes:
    raw = text.encode()
    return struct.pack("<I", len(raw)) + raw


class Writer:
    def __init__(
        self,
        profile: str = "",
        overrides=None,
        raw_patch=None,
        skip=(),
        json_patch=None,
    ):
        self.overrides = overrides or {}
        self.raw_patch = raw_patch
        self.skip = set(skip)
        self.json_patch = json_patch
        self.out = bytearray(cc.MAGIC)
        self.out += rec(0x01, s(profile) + s("stateaction-golden-gen"))
        self.schemas: dict[str, int] = {}
        self.channels: dict[str, int] = {}
        self.seq: dict[str, int] = {}

    def channel(
        self,
        topic: str,
        schema_name: str,
        schema_encoding: str,
        schema_data: bytes,
        msg_encoding: str,
    ):
        o = self.overrides.get(topic, {})
        schema_encoding = o.get("schema_encoding", schema_encoding)
        schema_data = o.get("schema_data", schema_data)
        msg_encoding = o.get("message_encoding", msg_encoding)
        if schema_name not in self.schemas:
            sid = self.schemas[schema_name] = len(self.schemas) + 1
            self.out += rec(
                0x03,
                struct.pack("<H", sid)
                + s(schema_name)
                + s(schema_encoding)
                + struct.pack("<I", len(schema_data))
                + schema_data,
            )
        cid = len(self.channels) + 1
        self.channels[topic] = cid
        self.out += rec(
            0x04,
            struct.pack("<HH", cid, self.schemas[schema_name])
            + s(topic)
            + s(msg_encoding)
            + struct.pack("<I", 0),
        )

    def message(
        self, topic: str, log_ns: int, data: bytes, sequence: int | None = None
    ):
        if topic in self.skip:
            return
        if self.json_patch and topic.startswith("/stateaction/"):
            # payload patch fn(topic, dict) -> dict; jb() is canonical so unpatched bytes are unchanged
            data = jb(self.json_patch(topic, json.loads(data)))
        n = self.seq.get(topic, 0) if sequence is None else sequence
        self.seq[topic] = n + 1
        if self.raw_patch:
            data = self.raw_patch(topic, n, data)
        self.out += rec(
            0x05, struct.pack("<HIQQ", self.channels[topic], n, log_ns, log_ns) + data
        )

    def finish(self, data_end: str = "crc", footer=(0, 0, 0)) -> bytes:
        """DataEnd carries CRC-32 of every preceding byte (leading magic included); no summary."""
        if data_end != "absent":
            crc = zlib.crc32(bytes(self.out)) if data_end == "crc" else 0
            self.out += rec(0x0F, struct.pack("<I", crc))
        self.out += rec(0x02, struct.pack("<QQI", *footer)) + cc.MAGIC
        return bytes(self.out)


def varint(v: int) -> bytes:
    out = bytearray()
    while v > 0x7F:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)
    return bytes(out)


def field(n: int, payload: bytes) -> bytes:
    return varint(n << 3 | 2) + varint(len(payload)) + payload


def compressed_video(
    capture_ns: int, data: bytes, frame_id=cc.FRAME_ID, fmt="h264"
) -> bytes:
    stamp = b"\x08" + varint(capture_ns // 10**9) + b"\x10" + varint(capture_ns % 10**9)
    return (
        field(1, stamp)
        + field(2, frame_id.encode())
        + field(3, data)
        + field(4, fmt.encode())
    )


def cdr_pose(capture_ns: int, position, orientation, frame="world") -> bytes:
    body = (
        b"\x00\x01\x00\x00"
        + struct.pack("<iII", capture_ns // 10**9, capture_ns % 10**9, len(frame) + 1)
        + frame.encode()
        + b"\x00"
    )
    body += b"\x00" * ((-(len(body) - 4)) % 8)
    return body + struct.pack("<7d", *position, *orientation)


def jb(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True).encode()


def model(stream: bytes = None, drop_ids=(3,)):
    stream = stream or (GOLD / "source/baseline-5.h264").read_bytes()
    aus = split_access_units(stream)
    ids = [i for i in range(len(aus) + len(drop_ids)) if i not in drop_ids]
    assert len(ids) == len(aus)
    frames = []
    for seq, (sid, au) in enumerate(zip(ids, aus)):
        frames.append(
            {"sid": sid, "au": au, "seq": seq, "pts": sid * 33_333, "delay_ns": 0}
        )
    return {"frames": frames, "drop_ids": list(drop_ids), "extra": {}}


def native(i):
    return BASE_NATIVE_NS + i * STEP_NS


def render(m: dict) -> bytes:
    def schema(name):
        return (CAP / name).read_bytes()

    desc = (CAP / "foxglove-compressed-video.desc").read_bytes()
    w = Writer(
        m.get("profile", ""),
        m.get("channel_overrides"),
        m.get("raw_patch"),
        m.get("skip_topics", ()),
        m.get("patch"),
    )

    rev = m.get(
        "v12"
    )  # stateaction.capture.v1.2 additions (gen_golden_v12.py); None = frozen v1.1

    def js(topic, key):
        return w.channel(
            topic,
            f"stateaction.capture.{key}.v1",
            "jsonschema",
            schema(f"{key}.schema.json"),
            "json",
        )

    if rev:
        w.channel(
            "/stateaction/capture_profile",
            "stateaction.capture.Profile.v2",
            "jsonschema",
            schema("Profile.v2.schema.json"),
            "json",
        )
    else:
        js("/stateaction/capture_profile", "Profile")
    js("/stateaction/clocks", "Clocks")
    js("/stateaction/inventory", "Inventory")
    js("/stateaction/frame_events", "FrameEvent")
    js("/stateaction/imu/accel", "MotionEvent")
    js("/stateaction/imu/gyro", "MotionEvent")
    w.channel(
        "/stateaction/sensor_events",
        "stateaction.capture.SensorEvent.v1",
        "jsonschema",
        schema("SensorEvent.schema.json"),
        "json",
    )
    close_name, close_file = (
        rev.get(
            "close_schema", ("stateaction.capture.Close.v2", "Close.v2.schema.json")
        )
        if rev
        else ("stateaction.capture.Close.v1", "Close.schema.json")
    )
    w.channel(
        "/stateaction/close", close_name, "jsonschema", schema(close_file), "json"
    )
    w.channel(
        cc.VIDEO_CHANNEL,
        "foxglove.CompressedVideo",
        m.get("video_schema_encoding", "protobuf"),
        m.get("desc", desc),
        "protobuf",
    )
    w.channel(
        "/tracking/pose",
        "geometry_msgs/msg/PoseStamped",
        "ros2msg",
        (CAP / cc.POSE_SCHEMA_FILE).read_bytes(),
        "cdr",
    )
    for topic, name, file, encoding in rev.get("channels", ()) if rev else ():
        w.channel(topic, name, encoding[0], schema(file), encoding[1])
    w.out += m.get("extra_record", b"")
    t0 = BASE_CAPTURE_NS
    w.message(
        "/stateaction/capture_profile",
        t0,
        jb(
            {
                "capture_schema": "stateaction.capture.v1",
                "rgb_profile": "h264_mcap_v1",
                "recording_id": REC,
                "wire_contract_revision": "stateaction.capture.v1.2"
                if rev
                else "stateaction.capture.v1.1",
                "production_qualified": False,
                "qualification": "unqualified",
                "encoder_time_base": {"numerator": 1, "denominator": 1000000},
                "limits": {"pending_frames": 4},
                "encoder": {"codec": "h264", "profile": "baseline", **rev["encoder"]}
                if rev
                else {"codec": "h264", "profile": "baseline"},
            }
        ),
    )
    stream_clocks = {
        "rgb": "android.camera.sensor_timestamp",
        "accel": "android.elapsed_realtime",
        "gyro": "android.elapsed_realtime",
    }
    stream_clocks.update(m.get("stream_clocks", {}))
    w.message(
        "/stateaction/clocks",
        t0,
        jb(
            {
                "recording_id": REC,
                "stream_clocks": {**stream_clocks, **m.get("declared_clocks", {})},
                "recorder_transport": {
                    "clock_id": "android.elapsed_realtime",
                    "target_clock_id": "unix",
                    "native_anchor_ns": str(BASE_NATIVE_NS),
                    "epoch_anchor_ns": str(BASE_CAPTURE_NS),
                    "method": "fixed_host_anchor",
                    "revision": "android_elapsed_to_unix_v1",
                    "status": "unverified",
                    "uncertainty_ns": None,
                    "synchronization_accuracy": "unverified",
                },
            }
        ),
    )
    w.message(
        "/stateaction/inventory",
        t0,
        jb(
            {
                "recording_id": REC,
                "sensors": [
                    {
                        "sensor_id": "rgb",
                        "kind": "camera",
                        "requested": "yes",
                        "supported": "yes",
                        "enabled": "yes",
                        "observed": "yes",
                        "observed_count": str(len(m["frames"])),
                        "native_clock_id": stream_clocks["rgb"],
                        "unavailable_reason": None,
                    },
                    {
                        "sensor_id": "accel",
                        "kind": "imu",
                        "requested": "yes",
                        "supported": "yes",
                        "enabled": "yes",
                        "observed": "yes",
                        "observed_count": "2",
                        "native_clock_id": "android.elapsed_realtime",
                        "unavailable_reason": None,
                    },
                    {
                        "sensor_id": "gyro",
                        "kind": "imu",
                        "requested": "yes",
                        "supported": "yes",
                        "enabled": "yes",
                        "observed": "yes",
                        "observed_count": "2",
                        "native_clock_id": "android.elapsed_realtime",
                        "unavailable_reason": None,
                    },
                    {
                        "sensor_id": "depth",
                        "kind": "depth",
                        "requested": "yes",
                        "supported": "no",
                        "enabled": "no",
                        "observed": "unavailable",
                        "observed_count": None,
                        "native_clock_id": None,
                        "unavailable_reason": "device_reports_unsupported",
                    },
                    {
                        "sensor_id": "magnetometer",
                        "kind": "imu",
                        "requested": "unknown",
                        "supported": "unknown",
                        "enabled": "unknown",
                        "observed": "unknown",
                        "observed_count": None,
                        "native_clock_id": None,
                        "unavailable_reason": None,
                    },
                ]
                + (rev.get("inventory_sensors", []) if rev else []),
                "calibrations": rev["inventory_calibrations"]
                if rev and "inventory_calibrations" in rev
                else [
                    {
                        "calibration_id": "rgb_0",
                        "stream_id": "rgb",
                        "state": "yes",
                        "model": "pinhole",
                    },
                    {
                        "calibration_id": "rgb_1",
                        "stream_id": "rgb",
                        "state": "unknown",
                        "model": None,
                    },
                ],
            }
        ),
    )
    events = []  # (log_ns, topic, payload)
    frames = m["frames"]
    for f in m["frames"]:
        i = f["sid"]
        cap = BASE_CAPTURE_NS + i * STEP_NS
        idr = cc.classify_au(f["au"])[1]
        common = {
            "recording_id": REC,
            "stream_id": "rgb",
            "source_frame_id": str(i),
            "native_timestamp_ns": str(native(i)),
            "native_clock_id": stream_clocks["rgb"],
            "mapped_capture_time_ns": str(cap),
            "clock_mapping_revision": "android_elapsed_to_unix_v1",
            "calibration_id": f.get("calibration", "rgb_0"),
            "encoder_pts_us": str(f["pts"]),
            "encoder_time_base": {"numerator": 1, "denominator": 1000000},
            "native_timestamps": {
                "arcore_frame_timestamp_ns": str(native(i) - 16),
                "arcore_image_timestamp_ns": str(native(i) - 10),
                "metadata_sensor_timestamp_ns": str(native(i)),
            },
        }
        for key in f.get("omit", []):
            common.pop(key)
        d = f["delay_ns"]
        events.append(
            (cap + 1, "/stateaction/frame_events", {**common, "state": "acquired"})
        )
        events.append(
            (cap + 2 + d, "/stateaction/frame_events", {**common, "state": "submitted"})
        )
        if f.get("unresolved"):
            continue  # aborted before the encoder produced output: no written event, no video
        events.append(
            (
                cap + 3 + d,
                "/stateaction/frame_events",
                {
                    **common,
                    "state": "written",
                    "output_channel": cc.VIDEO_CHANNEL,
                    "output_sequence": f["seq"],
                    "is_idr": idr,
                },
            )
        )
        events.append(
            (
                cap + d,
                cc.VIDEO_CHANNEL,
                (f["seq"], f["au"], cap, f.get("video_frame_id", cc.FRAME_ID)),
            )
        )
    for i in m["drop_ids"]:
        cap = BASE_CAPTURE_NS + i * STEP_NS
        events.append(
            (
                cap + 1,
                "/stateaction/frame_events",
                {
                    "recording_id": REC,
                    "stream_id": "rgb",
                    "source_frame_id": str(i),
                    "native_timestamp_ns": str(native(i)),
                    "native_clock_id": stream_clocks["rgb"],
                    "mapped_capture_time_ns": str(cap),
                    "clock_mapping_revision": "android_elapsed_to_unix_v1",
                    "calibration_id": "rgb_0",
                    "encoder_pts_us": str(i * 33_333),
                    "encoder_time_base": {"numerator": 1, "denominator": 1000000},
                    "native_timestamps": {
                        "metadata_sensor_timestamp_ns": str(native(i))
                    },
                    "state": "acquired",
                },
            )
        )
        events.append(
            (
                cap + 2,
                "/stateaction/frame_events",
                {
                    "recording_id": REC,
                    "stream_id": "rgb",
                    "source_frame_id": str(i),
                    "native_timestamp_ns": str(native(i)),
                    "native_clock_id": stream_clocks["rgb"],
                    "mapped_capture_time_ns": str(cap),
                    "clock_mapping_revision": "android_elapsed_to_unix_v1",
                    "calibration_id": "rgb_0",
                    "encoder_pts_us": str(i * 33_333),
                    "encoder_time_base": {"numerator": 1, "denominator": 1000000},
                    "native_timestamps": {
                        "metadata_sensor_timestamp_ns": str(native(i))
                    },
                    "state": "dropped",
                    "reason": "codec_input_backpressure",
                },
            )
        )
    for k in range(2):
        for kind, unit, vals in (
            ("accel", "m/s^2", [0.0, 9.8, 0.0]),
            ("gyro", "rad/s", [0.01, 0.0, -0.01]),
        ):
            n = (
                2_000_000 + k * 5_000_000
            )  # independent sensor clocks: not frame timestamps
            events.append(
                (
                    BASE_CAPTURE_NS + n,
                    f"/stateaction/imu/{kind}",
                    {
                        "recording_id": REC,
                        "event_id": str(k),
                        "native_timestamp_ns": str(BASE_NATIVE_NS + n),
                        "native_clock_id": stream_clocks[kind],
                        "mapped_capture_time_ns": str(BASE_CAPTURE_NS + n),
                        "callback_elapsed_ns": str(BASE_NATIVE_NS + n + 11),
                        "accuracy": 3,
                        "values": vals,
                        "unit": unit,
                        "includes_gravity": kind == "accel",
                        "axes": "android_device",
                    },
                )
            )
    sensors = [
        (0, "arcore_pose", "tracking", True, "rgb_0", None, 0),
        (1, "arcore_pose", "lost", False, "rgb_0", None, 1),
    ]
    sensors += m["extra"].get("sensors", [])
    for k, (eid, kind, tracking, valid, cal, sup, assoc) in enumerate(sensors):
        cap = BASE_CAPTURE_NS + eid * STEP_NS + 5
        ev = {
            "recording_id": REC,
            "stream_id": "pose" if kind == "arcore_pose" else "calibration",
            "event_id": str(eid),
            "native_timestamp_ns": str(native(eid) + 5),
            "native_clock_id": "android.elapsed_realtime",
            "mapped_capture_time_ns": str(cap),
            "output_channel": "/tracking/pose"
            if kind == "arcore_pose"
            else "/stateaction/sensor_events",
            "output_sequence": k,
            "source_kind": kind,
            "calibration_id": cal,
            "association_source_frame_id": str(assoc) if assoc is not None else None,
        }
        if kind == "arcore_pose":
            ev.update(tracking_state=tracking, pose_valid=valid)
        if sup:
            ev["supersedes_calibration_id"] = sup
        events.append((cap, "/stateaction/sensor_events", ev))
        if kind == "arcore_pose" and valid:
            events.append(
                (
                    cap,
                    "/tracking/pose",
                    cdr_pose(cap, [0.1 * eid, 0.2, 0.3], [0.0, 0.0, 0.0, 1.0]),
                )
            )
    unresolved = sum(1 for f in frames if f.get("unresolved"))
    written = len(frames) - unresolved
    dropped = len(m["drop_ids"])
    close = {
        "recording_id": REC,
        "outcome": "completed",
        "frames": {
            "acquired": str(len(frames) + dropped),
            "submitted": str(len(frames)),
            "written": str(written),
            "dropped": str(dropped),
            "unresolved": str(unresolved),
        },
        "video_messages": str(written),
        "motion_events": {"accel": "2", "gyro": "2"},
        "sensor_events": str(len(sensors)),
        "drops": [{"reason": "codec_input_backpressure", "count": str(dropped)}]
        if dropped
        else [],
    }
    close.update(m["extra"].get("close", {}))
    if rev:
        close.update(rev["close"])
        events += rev.get("events", [])
    last = max(e[0] for e in events) + 1_000_000
    events.sort(key=lambda e: e[0])
    for log_ns, topic, payload in events:
        if topic == cc.VIDEO_CHANNEL:
            seq, au, cap, fid = payload
            w.message(topic, log_ns, compressed_video(cap, au, fid), sequence=seq)
        elif isinstance(
            payload, tuple
        ):  # (sequence, protobuf bytes) on a RawImage channel
            w.message(topic, log_ns, payload[1], sequence=payload[0])
        elif isinstance(payload, bytes):
            w.message(topic, log_ns, payload)
        else:
            w.message(topic, log_ns, jb(payload))
    w.message("/stateaction/close", last, jb(close))
    out = w.finish(m.get("data_end", "crc"), m.get("footer", (0, 0, 0)))
    return m["post_patch"](out) if "post_patch" in m else out


def patched(m, fn):
    """Attach a JSON payload patch fn(topic, payload) -> payload (must copy before changing)."""
    m["patch"] = fn
    return m


def frame_patch(sid, states, **changes):
    """Change fields of selected frame events for one source frame (None deletes the key)."""

    def apply(topic, payload):
        if (
            topic == "/stateaction/frame_events"
            and payload["source_frame_id"] == str(sid)
            and payload["state"] in states
        ):
            payload = dict(payload)
            for key, value in changes.items():
                if value is None:
                    payload.pop(key, None)
                else:
                    payload[key] = value
        return payload

    return apply


def close_patch(**changes):
    def apply(topic, payload):
        return {**payload, **changes} if topic == "/stateaction/close" else payload

    return apply


ALL = ("acquired", "submitted", "written", "dropped")


def case_models():
    """name -> (description, model, outcome, declared error codes).

    The error codes are declared here, by hand, from the rule each mutation violates.
    main() asserts that the reference checker agrees; it never copies the checker's output
    into cases.json.
    """
    cases = {}
    cases["valid"] = (
        "Baseline Annex B IDR+P stream, one dropped frame, independent IMU clocks, CDR pose, tracking-loss marked invalid.",
        model(),
        "accept",
        [],
    )
    d = model()
    for f in d["frames"]:
        f["delay_ns"] = 400_000_000 if f["sid"] >= 2 else 0
    cases["delayed"] = (
        "Same capture times; a 400 ms encoder/output stall after frame 1 delays delivery and terminal frame events (logged after later acquisitions). Capture time is preserved.",
        d,
        "accept",
        [],
    )
    one = model(drop_ids=())
    one["frames"] = one["frames"][:1]
    cases["idr_with_config"] = (
        "Single complete IDR access unit including SPS/PPS.",
        one,
        "accept",
        [],
    )
    ab = model()
    ab["frames"][-1]["unresolved"] = True
    ab["extra"]["close"] = {"outcome": "aborted"}
    cases["aborted_unresolved"] = (
        "Recording aborted while the last frame was still in the encoder: acquired+submitted with no terminal event and no video message; Close says aborted with unresolved=1.",
        ab,
        "accept",
        [],
    )
    fa = model()
    fa["frames"][-1]["unresolved"] = True
    fa["extra"]["close"] = {"outcome": "failed", "failure_reason": "encoder_error"}
    cases["failed_unresolved"] = (
        "Encoder failure left the last frame unresolved; Close says failed with a failure_reason.",
        fa,
        "accept",
        [],
    )
    c = model(drop_ids=())
    sps_pps = b"".join(
        b"\x00\x00\x00\x01" + n for n in cc.nals(c["frames"][0]["au"])[:2]
    )
    c["frames"][0]["au"] = sps_pps
    cases["config_only"] = (
        "First video message carries only SPS/PPS, not an image.",
        c,
        "reject",
        ["E_CONFIG_ONLY"],
    )
    p = model(drop_ids=())
    p["frames"][1]["au"] = p["frames"][1]["au"] + p["frames"][2]["au"]
    p["frames"][2]["au"] = p["frames"][3]["au"]
    p["frames"][3]["au"] = p["frames"][4]["au"]
    p["frames"] = p["frames"][:4]
    cases["multiple_access_units"] = (
        "One message carries two complete access units (an access unit must be exactly one image).",
        p,
        "reject",
        ["E_MULTIPLE_ACCESS_UNITS"],
    )
    mc = model(drop_ids=())
    units = cc.nals(mc["frames"][0]["au"])
    mc["frames"][0]["au"] = b"".join(
        b"\x00\x00\x00\x01" + n for n in units if (n[0] & 31) != 7
    )
    cases["missing_config"] = (
        "IDR access unit without SPS.",
        mc,
        "reject",
        ["E_MISSING_PARAMETER_SETS"],
    )
    b = model((GOLD / "source/bframes-6.h264").read_bytes(), drop_ids=())
    cases["b_frame"] = (
        "Real x264 main-profile stream containing B slices.",
        b,
        "reject",
        ["E_B_FRAME"],
    )
    dp = model()
    dp["frames"][2]["pts"] = dp["frames"][1]["pts"]
    cases["duplicate_pts"] = (
        "Two source frames share one encoder PTS.",
        dp,
        "reject",
        ["E_DUPLICATE_PTS"],
    )
    mp = model()
    mp["frames"][2]["omit"] = ["encoder_pts_us"]
    cases["missing_pts"] = (
        "Acquired/submitted/written events of source frame 2 omit the encoder PTS (required for acquired and written).",
        mp,
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/frame_events:required"] * 2,
    )
    uc = model()
    uc["declared_clocks"] = {"rgb": "android.elapsed_realtime"}
    cases["unequal_clock"] = (
        "Frame events use a native clock other than the declared rgb stream clock.",
        uc,
        "reject",
        ["E_CLOCK_MISMATCH"],
    )
    tl = model()
    tl["extra"]["sensors"] = [
        (0, "arcore_pose", "tracking", True, "rgb_0", None, 0),
        (1, "arcore_pose", "lost", True, "rgb_0", None, 1),
    ]
    cases["tracking_loss"] = (
        "A pose marked lost is still presented as valid.",
        tl,
        "reject",
        ["E_TRACKING_LOSS_UNMARKED"],
    )
    cr = model()
    cr["extra"]["sensors"] = [
        (0, "arcore_pose", "tracking", True, "rgb_0", None, 0),
        (1, "calibration_reset", None, None, "rgb_1", "rgb_0", 2),
    ]
    cases["calibration_reset"] = (
        "Calibration reset supersedes rgb_0 at frame 2 but later frames keep rgb_0.",
        cr,
        "reject",
        ["E_CALIBRATION_RESET_UNMARKED"],
    )
    cc_ = model()
    cc_["extra"]["close"] = {
        "frames": {
            "acquired": "6",
            "submitted": "5",
            "written": "4",
            "dropped": "1",
            "unresolved": "0",
        }
    }
    cases["close_count_mismatch"] = (
        "Final close frame counts disagree with observed lifecycle events.",
        cc_,
        "reject",
        ["E_COUNT_MISMATCH"],
    )
    mm = model()
    mm["extra"]["close"] = {"motion_events": {"accel": "3", "gyro": "2"}}
    cases["motion_count_mismatch"] = (
        "Close reports 3 accelerometer events but only 2 were recorded.",
        mm,
        "reject",
        ["E_COUNT_MISMATCH"],
    )
    sm = model()
    sm["extra"]["close"] = {"sensor_events": "5"}
    cases["sensor_count_mismatch"] = (
        "Close reports 5 sensor events but 2 were recorded.",
        sm,
        "reject",
        ["E_COUNT_MISMATCH"],
    )
    dm = model()
    dm["extra"]["close"] = {"drops": [{"reason": "encoder_error", "count": "1"}]}
    cases["drop_reason_mismatch"] = (
        "Close attributes the dropped frame to a different reason than its dropped event.",
        dm,
        "reject",
        ["E_COUNT_MISMATCH"],
    )
    cu = model()
    cu["frames"][-1]["unresolved"] = True
    cases["completed_with_unresolved"] = (
        "Close says completed although the last frame never reached a terminal state.",
        cu,
        "reject",
        ["E_OUTCOME_MISMATCH"],
    )
    fw = model()
    fw["extra"]["close"] = {"outcome": "failed"}
    cases["failed_without_reason"] = (
        "Close outcome failed without a failure_reason.",
        fw,
        "reject",
        ["E_OUTCOME_MISMATCH"],
    )
    bd = model()
    bd["desc"] = (CAP / "foxglove-compressed-video.desc").read_bytes()[:-1] + b"\x00"
    cases["descriptor_hash"] = (
        "Embedded Protobuf descriptor bytes differ from the pinned complete descriptor.",
        bd,
        "reject",
        ["E_DESCRIPTOR_HASH"],
    )
    np_ = model()
    np_["profile"] = "ros2"
    cases["ros2_profile"] = (
        "Mixed Protobuf/CDR/JSON file falsely claims the ROS2 MCAP profile.",
        np_,
        "reject",
        ["E_PROFILE_NOT_EMPTY"],
    )
    # --- exact per-channel encodings and reviewed schema identity
    for name, topic, key, value, desc in (
        (
            "channel_encoding_video_message",
            cc.VIDEO_CHANNEL,
            "message_encoding",
            "PROTOBUF",
            "Video channel message encoding is PROTOBUF, not protobuf.",
        ),
        (
            "channel_encoding_video_schema",
            cc.VIDEO_CHANNEL,
            "schema_encoding",
            "flatbuffer",
            "Video channel schema encoding is flatbuffer, not protobuf.",
        ),
        (
            "channel_encoding_json_message",
            "/stateaction/frame_events",
            "message_encoding",
            "JSON",
            "FrameEvent channel message encoding is JSON, not json.",
        ),
        (
            "channel_encoding_json_schema",
            "/stateaction/frame_events",
            "schema_encoding",
            "JSONSCHEMA",
            "FrameEvent channel schema encoding is JSONSCHEMA, not jsonschema.",
        ),
        (
            "channel_encoding_cdr_message",
            "/tracking/pose",
            "message_encoding",
            "CDR",
            "Pose channel message encoding is CDR, not cdr.",
        ),
        (
            "channel_encoding_cdr_schema",
            "/tracking/pose",
            "schema_encoding",
            "ros2idl",
            "Pose channel schema encoding is ros2idl, not ros2msg.",
        ),
    ):
        mod = model()
        mod["channel_overrides"] = {topic: {key: value}}
        cases[name] = (desc, mod, "reject", ["E_CHANNEL_ENCODING"])
    ps = model()
    ps["channel_overrides"] = {
        "/tracking/pose": {
            "schema_data": b"std_msgs/Header header\nPose pose\n",
        }
    }
    cases["pose_schema_identity"] = (
        "PoseStamped ros2msg text differs from the reviewed pinned definition.",
        ps,
        "reject",
        ["E_CHANNEL_ENCODING"],
    )
    # --- frame lifecycle identity, integer PTS and time base
    wp = patched(model(), frame_patch(1, ("written",), encoder_pts_us="33334"))
    cases["written_pts_mismatch"] = (
        "Written FrameEvent for source frame 1 carries encoder PTS 33334 instead of the acquired 33333.",
        wp,
        "reject",
        ["E_FRAME_IDENTITY"],
    )
    wt = patched(
        model(),
        frame_patch(
            1, ("written",), mapped_capture_time_ns=str(BASE_CAPTURE_NS + STEP_NS + 1)
        ),
    )
    cases["written_capture_time_mismatch"] = (
        "Written FrameEvent changes the mapped capture time by 1 ns; the video message still carries the acquired time.",
        wt,
        "reject",
        ["E_FRAME_IDENTITY", "E_VIDEO_TIMESTAMP_MISMATCH"],
    )
    wc = patched(model(), frame_patch(1, ("written",), calibration_id="rgb_1"))
    cases["written_calibration_mismatch"] = (
        "Written FrameEvent switches to calibration rgb_1 without a reset event.",
        wc,
        "reject",
        ["E_FRAME_IDENTITY"],
    )
    dc = patched(
        model(),
        frame_patch(3, ("dropped",), native_clock_id="android.elapsed_realtime"),
    )
    cases["dropped_identity_mismatch"] = (
        "Dropped FrameEvent for source frame 3 changes the native clock id of the acquired event.",
        dc,
        "reject",
        ["E_FRAME_IDENTITY"],
    )
    tb = patched(
        model(),
        frame_patch(2, ALL, encoder_time_base={"numerator": 1, "denominator": 90000}),
    )
    cases["time_base_mismatch"] = (
        "All events of source frame 2 declare time base 1/90000 instead of 1/1000000.",
        tb,
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/frame_events/encoder_time_base:const"] * 3,
    )
    pi = patched(model(), frame_patch(2, ALL, encoder_pts_us="33333.5"))
    cases["pts_not_integer"] = (
        "Encoder PTS of source frame 2 is the non-integer string 33333.5 in every event.",
        pi,
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/frame_events/encoder_pts_us:pattern"] * 3,
    )
    so = model()
    so["frames"][2]["seq"] = so["frames"][1]["seq"]
    cases["duplicate_output_sequence"] = (
        "Two written frames share MCAP output sequence 1 (and two video messages share it).",
        so,
        "reject",
        ["E_SEQUENCE", "E_VIDEO_TIMESTAMP_MISMATCH"],
    )
    # --- malformed messages and schema-malformed evidence
    sm_ = patched(model(), frame_patch(2, ("submitted",), native_timestamp_ns=1000))
    cases["schema_malformed_frame_event"] = (
        "A submitted FrameEvent carries native_timestamp_ns as a JSON number instead of a decimal string.",
        sm_,
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/frame_events/native_timestamp_ns:type"],
    )
    cases.update(strictness_cases())
    for name, fn, desc in (
        (
            "malformed_protobuf_wire_type",
            lambda topic, n, data: (
                b"\x0f" if topic == cc.VIDEO_CHANNEL and n == 1 else data
            ),
            "Video message uses the unsupported Protobuf wire type 7.",
        ),
        (
            "malformed_protobuf_length",
            lambda topic, n, data: (
                b"\x1a\xe8\x07\x00" if topic == cc.VIDEO_CHANNEL and n == 1 else data
            ),
            "Video message declares a 1000-byte data field but ends after one byte.",
        ),
        (
            "malformed_json",
            lambda topic, n, data: (
                b"{not json" if topic == "/stateaction/inventory" else data
            ),
            "Inventory evidence message is not valid JSON.",
        ),
        (
            "malformed_cdr",
            lambda topic, n, data: (
                b"\x00\x00\x00\x00junk" if topic == "/tracking/pose" else data
            ),
            "Pose message has an invalid CDR encapsulation header.",
        ),
    ):
        mm_ = model()
        mm_["raw_patch"] = fn
        cases[name] = (desc, mm_, "reject", ["E_MALFORMED_MESSAGE"])
    cases.update(layout_cases())
    cases.update(definition_cases())
    cases.update(json_text_cases())
    return cases


def topic_patch(topic, fn):
    """Patch one JSON channel's payloads: fn(payload copy) -> payload."""

    def apply(t, payload):
        return fn(json.loads(json.dumps(payload))) if t == topic else payload

    return apply


def setp(path, value):
    """Return fn(payload) that sets (or with value=None deletes) a nested key path."""

    def fn(payload):
        node = payload
        for k in path[:-1]:
            node = node[k]
        if value is None:
            node.pop(path[-1])
        else:
            node[path[-1]] = value
        return payload

    return fn


def strictness_cases():
    """Normative unknown-field / identifier / bound cases. Violations are declared without message index
    as "<topic><pointer>:<keyword>" (a multiset); expected/<case>.json pins the exact indexes."""
    C, P, CL, INV = (
        "/stateaction/close",
        "/stateaction/capture_profile",
        "/stateaction/clocks",
        "/stateaction/inventory",
    )
    out = {}

    def add(name, desc, fn_topic, fn, violations):
        out[name] = (
            desc,
            patched(model(), topic_patch(fn_topic, fn)),
            "reject",
            ["E_SCHEMA_MALFORMED"],
            violations,
        )

    add(
        "close_unknown_root_field",
        "Close carries an undeclared root field operator_note.",
        C,
        setp(["operator_note"], "looks fine"),
        [f"{C}:additionalProperties"],
    )
    add(
        "close_non_uuid_recording_id",
        "Close recording_id is the textual label golden-fixture, not a UUID.",
        C,
        setp(["recording_id"], "golden-fixture"),
        [f"{C}/recording_id:pattern"],
    )
    add(
        "close_uppercase_uuid",
        "Close recording_id is an uppercase UUID (domain IDs are canonical lowercase).",
        C,
        setp(["recording_id"], REC.upper()),
        [f"{C}/recording_id:pattern"],
    )
    add(
        "close_200_digit_count",
        "Close frames.acquired is a 200-digit decimal (far beyond int64).",
        C,
        setp(["frames", "acquired"], "1" * 200),
        [f"{C}/frames/acquired:pattern"],
    )
    add(
        "close_int64_overflow",
        "Close video_messages is 9223372036854775808 (int64 max + 1, still 19 digits).",
        C,
        setp(["video_messages"], str(2**63)),
        [f"{C}/video_messages:pattern"],
    )
    add(
        "close_unknown_frames_field",
        "Close frames object carries an undeclared counter.",
        C,
        setp(["frames", "encoded"], "4"),
        [f"{C}/frames:additionalProperties"],
    )
    add(
        "close_failure_reason_too_long",
        "Close failure_reason is 257 printable ASCII characters.",
        C,
        setp(["failure_reason"], "x" * 257),
        [f"{C}/failure_reason:anyOf"],
    )
    add(
        "profile_unknown_limit",
        "Profile limits carries an undeclared key.",
        P,
        setp(["limits", "max_frames"], 9),
        [f"{P}/limits:additionalProperties"],
    )
    add(
        "profile_pending_frames_bound",
        "Profile limits.pending_frames is 65 (bound 1..64).",
        P,
        setp(["limits", "pending_frames"], 65),
        [f"{P}/limits/pending_frames:maximum"],
    )
    add(
        "clocks_bad_stream_name",
        "Clocks stream_clocks key 'RGB camera' is not a label.",
        CL,
        setp(["stream_clocks", "RGB camera"], "android.elapsed_realtime"),
        [f"{CL}/stream_clocks:pattern"],
    )
    add(
        "clocks_unknown_transport_field",
        "Clocks recorder_transport carries an undeclared field.",
        CL,
        setp(["recorder_transport", "drift_ppm"], "3"),
        [f"{CL}/recorder_transport:additionalProperties"],
    )
    add(
        "inventory_too_many_sensors",
        "Inventory lists 65 sensors (bound 64).",
        INV,
        lambda p: {
            **p,
            "sensors": p["sensors"] + [p["sensors"][-1]] * (65 - len(p["sensors"])),
        },
        [f"{INV}/sensors:maxItems"],
    )
    add(
        "inventory_label_trailing_newline",
        "Inventory calibration model is 'pinhole\n': a trailing newline never satisfies an anchored pattern.",
        INV,
        lambda p: {
            **p,
            "calibrations": [{**p["calibrations"][0], "model": "pinhole\n"}]
            + p["calibrations"][1:],
        },
        [f"{INV}/calibrations/0/model:anyOf"],
    )
    out["frame_unknown_native_timestamp"] = (
        "Acquired FrameEvent of source frame 1 carries an undeclared native_timestamps key.",
        patched(
            model(),
            frame_patch(
                1,
                ("acquired",),
                native_timestamps={
                    "metadata_sensor_timestamp_ns": str(native(1)),
                    "vsync_ns": "1",
                },
            ),
        ),
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/frame_events/native_timestamps:additionalProperties"],
    )
    out["frame_reason_trailing_newline"] = (
        "Dropped FrameEvent reason ends in a newline.",
        patched(
            model(), frame_patch(3, ("dropped",), reason="codec_input_backpressure\n")
        ),
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/frame_events/reason:pattern"],
    )
    out["motion_value_string"] = (
        "First accelerometer sample value is the string '0.0' instead of a number.",
        patched(
            model(),
            lambda t, p: (
                {**p, "values": ["0.0"] + p["values"][1:]}
                if t == "/stateaction/imu/accel" and p["event_id"] == "0"
                else p
            ),
        ),
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/imu/accel/values/0:type"],
    )
    out["sensor_sequence_overflow"] = (
        "A SensorEvent output_sequence is 4294967296 (uint32 max + 1).",
        patched(
            model(),
            lambda t, p: (
                {**p, "output_sequence": 2**32}
                if t == "/stateaction/sensor_events" and p["event_id"] == "1"
                else p
            ),
        ),
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/sensor_events/output_sequence:maximum"],
    )
    bound = model()
    bound["patch"] = topic_patch(
        CL, setp(["recorder_transport", "uncertainty_ns"], str(2**63 - 1))
    )
    out["clocks_int64_max"] = (
        "Clocks uncertainty_ns is exactly int64 max 9223372036854775807 (accepted boundary).",
        bound,
        "accept",
        [],
    )
    mismatch = model()
    mismatch["patch"] = lambda t, p: (
        {**p, "recording_id": OTHER_REC}
        if t == "/stateaction/imu/gyro" and p["event_id"] == "1"
        else p
    )
    out["recording_id_mismatch"] = (
        "One gyroscope event carries a different (valid) recording UUID.",
        mismatch,
        "reject",
        ["E_RECORDING_ID"],
    )
    noprofile = model()
    noprofile["skip_topics"] = ["/stateaction/capture_profile"]
    out["missing_profile"] = (
        "The capture profile message is absent (profile/clocks/inventory/close must each appear exactly once).",
        noprofile,
        "reject",
        ["E_CHANNEL_CARDINALITY"],
    )
    for name, fn, desc in (
        (
            "duplicate_json_key",
            lambda topic, n, data: (
                data[:-1] + b',"outcome":"aborted"}' if topic == C else data
            ),
            "Close JSON repeats the outcome key (parsers disagree on duplicates, so it is malformed).",
        ),
        (
            "json_number_overflow",
            lambda topic, n, data: (
                data.replace(b"9.8", b"1e400")
                if topic == "/stateaction/imu/accel" and n == 0
                else data
            ),
            "Accelerometer value 1e400 overflows an IEEE-754 double.",
        ),
    ):
        raw = model()
        raw["raw_patch"] = fn
        out[name] = (desc, raw, "reject", ["E_MALFORMED_MESSAGE"])
    return out


def layout_cases():
    """Container integrity: DataEnd CRC and the single supported (unchunked, no summary) layout."""
    out = {}

    def corrupt(old, new):
        def fn(data):
            assert data.count(old) >= 1 and len(old) == len(new)
            return data.replace(old, new, 1)

        return fn

    for name, mutate, desc in (
        (
            "data_crc_header_corrupt",
            corrupt(b"stateaction-golden-gen", b"stateaction-golden-geN"),
            "One byte of the Header library string changed after the DataEnd CRC was computed.",
        ),
        (
            "data_crc_payload_corrupt",
            corrupt(b"[0.0,9.8,0.0]", b"[0.0,9.9,0.0]"),
            "One digit of a schema-valid accelerometer sample changed after the CRC was computed.",
        ),
    ):
        mod = model()
        mod["post_patch"] = mutate
        out[name] = (desc, mod, "reject", ["E_DATA_CRC"])
    zero = model()
    zero["data_end"] = "zero"
    out["data_crc_zero"] = (
        "DataEnd data_section_crc is 0 (CRC unavailable): the contract requires a nonzero CRC.",
        zero,
        "reject",
        ["E_DATA_CRC"],
    )
    absent = model()
    absent["data_end"] = "absent"
    out["data_end_missing"] = (
        "Footer follows the last message without a DataEnd record.",
        absent,
        "reject",
        ["E_UNSUPPORTED_LAYOUT"],
    )
    summary = model()
    summary["footer"] = (40, 0, 0)
    out["footer_summary_offset"] = (
        "Footer claims a summary section/index (summary_start != 0), outside the supported layout.",
        summary,
        "reject",
        ["E_UNSUPPORTED_LAYOUT"],
    )
    chunk = model()
    chunk["extra_record"] = rec(
        0x06, struct.pack("<QQQI", 0, 0, 0, 0) + s("") + struct.pack("<Q", 0)
    )
    out["chunk_record"] = (
        "An (empty) Chunk record appears in the data section: chunked files are not the portable layout.",
        chunk,
        "reject",
        ["E_UNSUPPORTED_LAYOUT"],
    )
    return out


def legacy_jpeg() -> bytes:
    w = Writer("")
    w.channel(
        "/camera/rgb/image/compressed",
        "sensor_msgs/msg/CompressedImage",
        "ros2msg",
        b"std_msgs/Header header\nstring format\nuint8[] data\n",
        "cdr",
    )
    for k in range(3):
        cap = BASE_CAPTURE_NS + k * STEP_NS
        fmt = b"jpeg\x00"
        body = (
            b"\x00\x01\x00\x00"
            + struct.pack("<iII", cap // 10**9, cap % 10**9, 6)
            + b"rgb_0\x00"
        )
        body += (
            b"\x00" * ((-(len(body) - 4)) % 4)
            + struct.pack("<I", len(fmt))
            + fmt
            + b"\x00" * ((-(len(body) + 4 + len(fmt) - 4)) % 4)
        )
        body += struct.pack("<I", 4) + b"\xff\xd8\xff\xd9"
        w.message("/camera/rgb/image/compressed", cap, body)
    return w.finish()


V12_FILES = {
    "Profile.v2.schema.json",
    "Close.v2.schema.json",
    "Calibration.schema.json",
    "DepthEvent.schema.json",
    "CameraMetadata.schema.json",
    "foxglove-raw-image.desc",
    "schema-provenance.raw-image.json",
}


def sync_contract():
    """Pin every contract file in the manifests and refresh the byte-identical Android asset copies.

    manifest.json (v1.1) is frozen: it never lists a v1.2 file. manifest.v1.2.json lists the reused v1.1
    files (without Profile/Close v1) plus the new files. Android copies of v1.2 files are added later by
    the integration owner (not by this generator).
    """
    native = (
        CAP.parents[1] / "stera_recorder/android/src/main/assets/stateaction/capture"
    )
    names = sorted(
        p.name
        for p in CAP.iterdir()
        if (
            p.name.endswith(".schema.json")
            or p.name.startswith("LICENSE")
            or p.suffix in (".desc", ".ros2msg")
            or p.name == "schema-provenance.json"
            or p.name == "schema-provenance.raw-image.json"
        )
    )
    v11 = [n for n in names if n not in V12_FILES]
    manifest = json.loads((CAP / "manifest.json").read_text())
    manifest["files"] = {n: cc.sha256((CAP / n).read_bytes()) for n in v11}
    (CAP / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    v12 = [n for n in names if n not in ("Profile.schema.json", "Close.schema.json")]
    (CAP / cc.MANIFEST_V12).write_text(
        json.dumps(
            {
                "wire_contract_revision": "stateaction.capture.v1.2",
                "files": {n: cc.sha256((CAP / n).read_bytes()) for n in v12},
            },
            indent=2,
        )
        + "\n"
    )
    for n in v11:
        (native / n).write_bytes((CAP / n).read_bytes())


def gen_encoder_buffers():
    """Encoder-output contract: MediaCodec-style buffer sequences -> expected whole access units.

    Expected units are sliced straight from the public source stream here, not produced by the
    assembler under test.
    """
    source = "golden/source/baseline-5.h264"
    units = cc.nals((CAP / source).read_bytes())  # 0 SPS,1 PPS,2 SEI,3 IDR,4..7 P

    def annexb(first, last):
        return b"".join(cc.START + n for n in units[first:last])

    def au(pts, idr, first_last_pairs):
        data = b"".join(annexb(a, b) for a, b in first_last_pairs)
        return {
            "pts_us": pts,
            "idr": idr,
            "bytes": len(data),
            "sha256": cc.sha256(data),
        }

    idr_len = len(annexb(2, 4))
    cut = 300
    config = {"flags": 2, "pts_us": "0", "source": "baseline", "nals": [0, 2]}
    cases = {
        "config_then_idr_then_p": (
            "CODEC_CONFIG buffer, then SEI+IDR without parameter sets, then a P frame: the IDR access unit gets the stored SPS/PPS.",
            [
                config,
                {"flags": 1, "pts_us": "0", "source": "baseline", "nals": [2, 4]},
                {"flags": 0, "pts_us": "33333", "source": "baseline", "nals": [4, 5]},
            ],
            {
                "outcome": "accept",
                "errors": [],
                "aus": [au("0", True, [(0, 4)]), au("33333", False, [(4, 5)])],
            },
        ),
        "inline_config": (
            "SPS/PPS inline in the IDR buffer; no separate CODEC_CONFIG buffer.",
            [
                {"flags": 1, "pts_us": "0", "source": "baseline", "nals": [0, 4]},
                {"flags": 0, "pts_us": "33333", "source": "baseline", "nals": [4, 5]},
            ],
            {
                "outcome": "accept",
                "errors": [],
                "aus": [au("0", True, [(0, 4)]), au("33333", False, [(4, 5)])],
            },
        ),
        "partial_idr_assembly": (
            "The IDR arrives in two chunks (PARTIAL_FRAME then final) with one PTS; one access unit results, with stored SPS/PPS prepended.",
            [
                config,
                {
                    "flags": 8,
                    "pts_us": "0",
                    "source": "baseline",
                    "nals": [2, 4],
                    "bytes": [0, cut],
                },
                {
                    "flags": 1,
                    "pts_us": "0",
                    "source": "baseline",
                    "nals": [2, 4],
                    "bytes": [cut, idr_len],
                },
            ],
            {"outcome": "accept", "errors": [], "aus": [au("0", True, [(0, 4)])]},
        ),
        "config_only_no_image": (
            "Only CODEC_CONFIG then end of stream: no access unit is emitted (configuration is not an image).",
            [config, {"flags": 4, "pts_us": "0"}],
            {"outcome": "accept", "errors": [], "aus": []},
        ),
        "partial_incomplete_at_eos": (
            "A PARTIAL_FRAME chunk is never completed before end of stream.",
            [
                config,
                {
                    "flags": 8,
                    "pts_us": "0",
                    "source": "baseline",
                    "nals": [2, 4],
                    "bytes": [0, cut],
                },
                {"flags": 4, "pts_us": "0"},
            ],
            {"outcome": "reject", "errors": ["E_INCOMPLETE_AU"], "aus": []},
        ),
        "partial_pts_mismatch": (
            "The completing chunk of a partial frame carries a different PTS.",
            [
                config,
                {
                    "flags": 8,
                    "pts_us": "0",
                    "source": "baseline",
                    "nals": [2, 4],
                    "bytes": [0, cut],
                },
                {
                    "flags": 1,
                    "pts_us": "5",
                    "source": "baseline",
                    "nals": [2, 4],
                    "bytes": [cut, idr_len],
                },
            ],
            {"outcome": "reject", "errors": ["E_PARTIAL_PTS_MISMATCH"], "aus": []},
        ),
        "idr_without_config": (
            "IDR buffer with no SPS/PPS inline and no CODEC_CONFIG ever received.",
            [{"flags": 1, "pts_us": "0", "source": "baseline", "nals": [2, 4]}],
            {"outcome": "reject", "errors": ["E_MISSING_PARAMETER_SETS"], "aus": []},
        ),
        "multiple_aus_in_buffer": (
            "One complete (non-partial) buffer holds two complete P access units.",
            [
                {"flags": 1, "pts_us": "0", "source": "baseline", "nals": [0, 4]},
                {"flags": 0, "pts_us": "33333", "source": "baseline", "nals": [4, 6]},
            ],
            {"outcome": "reject", "errors": ["E_MULTIPLE_ACCESS_UNITS"], "aus": []},
        ),
        "pts_not_integer": (
            "Buffer PTS 12.5 is not an integer microsecond count.",
            [{"flags": 1, "pts_us": "12.5", "source": "baseline", "nals": [0, 4]}],
            {"outcome": "reject", "errors": ["E_PTS_INVALID"], "aus": []},
        ),
    }
    fixture = {
        "contract": "stateaction.capture.encoder_buffers.v1",
        "description": "Encoder-output buffer sequences (MediaCodec CODEC_CONFIG=2, PARTIAL_FRAME=8, END_OF_STREAM=4, KEY_FRAME=1 flag values) and the whole access units a writer must assemble from them. Public synthetic sources only. Contract-level only: no MediaCodec producer is wired here (SA-51).",
        "sources": {"baseline": source},
        "cases": {},
    }
    for name, (desc, buffers, expect) in cases.items():
        fixture["cases"][name] = {
            "description": desc,
            "buffers": buffers,
            "expect": expect,
        }
        # the reference assembler must agree with the declared expectation
        got = cc.assemble_encoder_buffers(buffers, {"baseline": units})
        assert got == expect, (name, got)
    (CAP / "fixtures/encoder_buffers.json").write_text(
        json.dumps(fixture, indent=2, sort_keys=True) + "\n"
    )


def mcap_records(data: bytes) -> list[tuple[int, bytes]]:
    """Split an unchunked golden MCAP into (opcode, body) records between the two magics."""
    pos, out = len(cc.MAGIC), []
    while pos < len(data) - len(cc.MAGIC):
        op = data[pos]
        (n,) = struct.unpack_from("<Q", data, pos + 1)
        out.append((op, data[pos + 9 : pos + 9 + n]))
        pos += 9 + n
    return out


def mcap_rebuild(records: list[tuple[int, bytes]]) -> bytes:
    """Reassemble records, recomputing the DataEnd CRC so only the intended defect remains."""
    out = bytearray(cc.MAGIC)
    for op, body in records:
        if op == cc.OP_DATA_END:
            body = struct.pack("<I", zlib.crc32(bytes(out)))
        out += rec(op, body)
    return bytes(out + cc.MAGIC)


def _channel_index(records, topic: str) -> int:
    return next(
        i
        for i, (op, b) in enumerate(records)
        if op == cc.OP_CHANNEL
        and b[8 : 8 + struct.unpack_from("<I", b, 4)[0]] == topic.encode()
    )


def _schema_index(records, sid: int) -> int:
    return next(
        i
        for i, (op, b) in enumerate(records)
        if op == cc.OP_SCHEMA and struct.unpack_from("<H", b, 0)[0] == sid
    )


def _data_end_index(records) -> int:
    return next(i for i, (op, _) in enumerate(records) if op == cc.OP_DATA_END)


def definition_cases():
    """MCAP definition order and id consistency, enforced while streaming (official-reader semantics)."""
    topic = "/stateaction/frame_events"

    def records_patch(fn):
        def apply(data):
            out = mcap_rebuild(fn(mcap_records(data)))
            assert out != data
            return out

        return apply

    def channel_parts(records):
        ci = _channel_index(records, topic)
        body = records[ci][1]
        cid, sid = struct.unpack_from("<HH", body, 0)
        return ci, body, cid, sid

    def bogus_channel(body, cid, sid):
        (n,) = struct.unpack_from("<I", body, 4)
        return (
            cc.OP_CHANNEL,
            struct.pack("<HH", cid, sid) + s("/bogus/topic") + body[8 + n :],
        )

    def channel_after_messages(r):
        ci = channel_parts(r)[0]
        moved = r.pop(ci)
        r.insert(_data_end_index(r), moved)
        return r

    def schema_after_channel(r):
        ci, _, _, sid = channel_parts(r)
        si = _schema_index(r, sid)
        moved = r.pop(si)
        r.insert(_channel_index(r, topic) + 1, moved)
        return r

    def conflicting_channel(r):
        ci, body, cid, sid = channel_parts(r)
        r.insert(ci, bogus_channel(body, cid, sid))
        return r

    def conflicting_schema(r):
        _, _, _, sid = channel_parts(r)
        si = _schema_index(r, sid)
        body = r[si][1]
        (n,) = struct.unpack_from("<I", body, 2)
        name = body[6 : 6 + n].decode()
        data = b'{"type":"object"}'
        alt = (
            struct.pack("<H", sid)
            + s(name)
            + s("jsonschema")
            + struct.pack("<I", len(data))
            + data
        )
        r.insert(si, (cc.OP_SCHEMA, alt))
        return r

    def bogus_then_real(r):
        ci, body, cid, sid = channel_parts(r)
        real = r[ci]
        r[ci] = bogus_channel(body, cid, sid)
        r.insert(_data_end_index(r), real)
        return r

    def identical_duplicates(r):
        ci, _, _, sid = channel_parts(r)
        r.insert(ci + 1, r[ci])
        r.insert(ci + 2, r[_schema_index(r, sid)])
        return r

    def schema_id_zero(r):
        _, _, _, sid = channel_parts(r)
        si = _schema_index(r, sid)
        r.insert(si, (cc.OP_SCHEMA, struct.pack("<H", 0) + r[si][1][2:]))
        return r

    out = {}
    for name, fn, expect, codes, desc in (
        (
            "channel_after_messages",
            channel_after_messages,
            "reject",
            ["E_DEFINITION_ORDER"],
            "The frame_events Channel record is moved after its Messages (just before DataEnd); the official reader fails with 'no channel record found'.",
        ),
        (
            "schema_after_channel",
            schema_after_channel,
            "reject",
            ["E_DEFINITION_ORDER"],
            "The FrameEvent Schema record is moved to just after the Channel that refers to it.",
        ),
        (
            "conflicting_duplicate_channel",
            conflicting_channel,
            "reject",
            ["E_DEFINITION_CONFLICT"],
            "A Channel record with the frame_events channel id but topic /bogus/topic precedes the real definition.",
        ),
        (
            "conflicting_duplicate_schema",
            conflicting_schema,
            "reject",
            ["E_DEFINITION_CONFLICT"],
            "A Schema record with the FrameEvent schema id but different data precedes the real definition.",
        ),
        (
            "bogus_channel_redefined_after_messages",
            bogus_then_real,
            "reject",
            ["E_DEFINITION_CONFLICT"],
            "The frame_events channel id is first defined as /bogus/topic and redefined correctly only after its Messages; the official reader reads every FrameEvent on /bogus/topic.",
        ),
        (
            "schema_id_zero",
            schema_id_zero,
            "reject",
            ["E_DEFINITION_CONFLICT"],
            "A Schema record uses id 0, which MCAP reserves for channels without a schema.",
        ),
        (
            "identical_duplicate_definitions",
            identical_duplicates,
            "accept",
            [],
            "The frame_events Channel and FrameEvent Schema records are each repeated byte for byte (allowed by MCAP); facts equal valid.",
        ),
    ):
        mod = model()
        mod["post_patch"] = records_patch(fn)
        out[name] = (desc, mod, expect, codes)
    return out


def json_text_cases():
    """Strict JSON text rules (BOM, nesting bound, unpaired surrogates) inside an otherwise valid file."""
    topic = "/stateaction/inventory"

    def extra(member: bytes):
        def apply(t, n, data):
            if t != topic:
                return data
            assert data.endswith(b"}")
            return data[:-1] + b"," + member + b"}"

        return apply

    def nested(depth: int) -> bytes:
        return b'"deep":' + b"[" * depth + b"]" * depth

    def video_frame_bom(t, n, data):
        if t != cc.VIDEO_CHANNEL or n != 0:
            return data
        old = b"\x12" + bytes([len(cc.FRAME_ID)]) + cc.FRAME_ID.encode()
        new = (
            b"\x12"
            + bytes([len(cc.FRAME_ID) + 3])
            + b"\xef\xbb\xbf"
            + cc.FRAME_ID.encode()
        )
        assert data.count(old) == 1
        return data.replace(old, new)

    out = {}
    for name, patch, codes, viol, desc in (
        (
            "video_frame_id_bom",
            video_frame_bom,
            ["E_VIDEO_FIELDS"],
            None,
            "The first video frame_id is U+FEFF + camera_optical_frame: decoders must keep a leading BOM in every string.",
        ),
        (
            "json_bom",
            lambda t, n, data: b"\xef\xbb\xbf" + data if t == topic else data,
            ["E_MALFORMED_MESSAGE"],
            None,
            "The Inventory JSON message starts with a UTF-8 byte order mark (EF BB BF).",
        ),
        (
            "json_nesting_at_limit",
            extra(nested(31)),
            ["E_SCHEMA_MALFORMED"],
            ["/stateaction/inventory:additionalProperties"],
            "An unknown Inventory member holds 31 nested arrays: 32 open containers, the parse limit, so it parses and fails the closed schema.",
        ),
        (
            "json_nesting_over_limit",
            extra(nested(32)),
            ["E_MALFORMED_MESSAGE"],
            None,
            "An unknown Inventory member holds 32 nested arrays: 33 open containers exceed the 32 nesting limit.",
        ),
        (
            "json_lone_surrogate",
            extra(b'"\\ud800":1'),
            ["E_MALFORMED_MESSAGE"],
            None,
            "An unknown Inventory key is the unpaired surrogate escape \\ud800 (RFC 7493 I-JSON).",
        ),
    ):
        mod = model()
        mod["raw_patch"] = patch
        out[name] = (desc, mod, "reject", codes) + ((viol,) if viol else ())
    return out


def independent_video_facts(m: dict) -> list[dict]:
    """Expected video facts computed from the model alone (never from the checker)."""
    out = []
    for f in m["frames"]:
        if f.get("unresolved"):
            continue
        out.append(
            {
                "sequence": f["seq"],
                "capture_time_ns": str(BASE_CAPTURE_NS + f["sid"] * STEP_NS),
                "bytes": len(f["au"]),
                "sha256": cc.sha256(f["au"]),
                "source_frame_id": str(f["sid"]),
                "encoder_pts_us": str(f["pts"]),
            }
        )
    return out


def main():
    sync_contract()
    cases = case_models()
    index = {}
    models = {}
    for name, (desc, m, expect, declared, *viol) in cases.items():
        data = render(m)
        (GOLD / f"{name}.mcap").write_bytes(data)
        models[name] = m
        index[name] = {
            "description": desc,
            "expect": expect,
            "expected_errors": sorted(declared),
            "sha256": cc.sha256(data),
        }
        if viol:
            index[name]["expected_violations"] = sorted(viol[0])
    full = (GOLD / "valid.mcap").read_bytes()
    for name, cut, desc in (
        (
            "truncated_mid_record",
            len(full) - 40,
            "Cut inside the final record: no footer.",
        ),
        (
            "truncated_before_footer",
            full.rindex(cc.MAGIC) - 25,
            "Cut inside the footer record.",
        ),
    ):
        (GOLD / f"{name}.mcap").write_bytes(full[:cut])
        index[name] = {
            "description": desc,
            "expect": "reject",
            "expected_errors": ["E_TRUNCATED"],
            "sha256": cc.sha256(full[:cut]),
        }
    data = legacy_jpeg()
    (GOLD / "legacy_jpeg.mcap").write_bytes(data)
    index["legacy_jpeg"] = {
        "description": "Historical sensor_msgs CompressedImage JPEG capture; explicitly classified, never admitted as h264_mcap_v1.",
        "expect": "legacy_jpeg",
        "expected_errors": ["E_LEGACY_JPEG"],
        "sha256": cc.sha256(data),
    }
    for name, entry in index.items():
        result = cc.check((GOLD / f"{name}.mcap").read_bytes())
        # The declared outcome/errors are the oracle; the checker must agree with them.
        assert result["outcome"] == entry["expect"], (name, result)
        assert result["errors"] == entry["expected_errors"], (name, result["errors"])
        got_v = sorted(
            re.sub(r"\[[0-9]+\]", "", v, count=1)
            for v in result["facts"].get("schema_violations", [])
        )
        assert got_v == entry.get("expected_violations", []), (name, got_v)
        if result["outcome"] == "accept":
            got = [
                {
                    k: v[k]
                    for k in (
                        "sequence",
                        "capture_time_ns",
                        "bytes",
                        "sha256",
                        "source_frame_id",
                        "encoder_pts_us",
                    )
                }
                for v in result["facts"]["video"]
            ]
            assert got == independent_video_facts(models[name]), name
        (GOLD / "expected" / f"{name}.json").write_text(cc.canonical(result))
    (GOLD / "cases.json").write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")
    for n, e in index.items():
        print(n, e["expect"], e["expected_errors"])
    gen_encoder_buffers()
    import gen_golden_v12

    gen_golden_v12.generate(sys.modules[__name__])


if __name__ == "__main__":
    main()
