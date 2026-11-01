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
import struct

import capture_conformance as cc

CAP = cc.CAPTURE_DIR
GOLD = CAP / "golden"
BASE_CAPTURE_NS = (
    1_800_000_000_000_000_007  # > 2**53: exercises decimal-string handling
)
BASE_NATIVE_NS = 1_000_000_007
STEP_NS = 33_333_333
REC = "golden-fixture"


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
    def __init__(self, profile: str = "", overrides=None, raw_patch=None):
        self.overrides = overrides or {}
        self.raw_patch = raw_patch
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
        n = self.seq.get(topic, 0) if sequence is None else sequence
        self.seq[topic] = n + 1
        if self.raw_patch:
            data = self.raw_patch(topic, n, data)
        self.out += rec(
            0x05, struct.pack("<HIQQ", self.channels[topic], n, log_ns, log_ns) + data
        )

    def finish(self) -> bytes:
        self.out += rec(0x02, struct.pack("<QQI", 0, 0, 0)) + cc.MAGIC
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
    w = Writer(m.get("profile", ""), m.get("channel_overrides"), m.get("raw_patch"))

    def js(topic, key):
        return w.channel(
            topic,
            f"stateaction.capture.{key}.v1",
            "jsonschema",
            schema(f"{key}.schema.json"),
            "json",
        )

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
    w.channel(
        "/stateaction/close",
        "stateaction.capture.Close.v1",
        "jsonschema",
        schema("Close.schema.json"),
        "json",
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
    t0 = BASE_CAPTURE_NS
    w.message(
        "/stateaction/capture_profile",
        t0,
        jb(
            {
                "capture_schema": "stateaction.capture.v1",
                "rgb_profile": "h264_mcap_v1",
                "recording_id": REC,
                "wire_contract_revision": "stateaction.capture.v1.1",
                "production_qualified": False,
                "qualification": "unqualified",
                "encoder_time_base": {"numerator": 1, "denominator": 1000000},
                "limits": {"pending_frames": 4},
                "encoder": {"codec": "h264", "profile": "baseline"},
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
                ],
                "calibrations": [
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
    patch = m.get("patch")
    if patch:
        close = patch("/stateaction/close", close)
    last = max(e[0] for e in events) + 1_000_000
    events.sort(key=lambda e: e[0])
    for log_ns, topic, payload in events:
        if topic == cc.VIDEO_CHANNEL:
            seq, au, cap, fid = payload
            w.message(topic, log_ns, compressed_video(cap, au, fid), sequence=seq)
        elif isinstance(payload, bytes):
            w.message(topic, log_ns, payload)
        else:
            if patch:
                payload = patch(topic, payload)
            w.message(topic, log_ns, jb(payload))
    w.message("/stateaction/close", last, jb(close))
    return w.finish()


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
        "A frame event omits its encoder PTS.",
        mp,
        "reject",
        ["E_MISSING_PTS"],
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
        ["E_TIME_BASE"],
    )
    pi = patched(model(), frame_patch(2, ALL, encoder_pts_us="33333.5"))
    cases["pts_not_integer"] = (
        "Encoder PTS of source frame 2 is the non-integer string 33333.5 in every event.",
        pi,
        "reject",
        ["E_PTS_INVALID"],
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
        ["E_COUNT_MISMATCH", "E_SCHEMA_MALFORMED"],
    )
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
    return cases


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


def sync_contract():
    """Pin every contract file in manifest.json and refresh the byte-identical Android asset copies."""
    native = (
        CAP.parents[1] / "stera_recorder/android/src/main/assets/stateaction/capture"
    )
    names = sorted(
        p.name
        for p in CAP.iterdir()
        if p.name.endswith(".schema.json")
        or p.name.startswith("LICENSE")
        or p.suffix in (".desc", ".ros2msg")
        or p.name == "schema-provenance.json"
    )
    manifest = json.loads((CAP / "manifest.json").read_text())
    manifest["files"] = {n: cc.sha256((CAP / n).read_bytes()) for n in names}
    (CAP / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for n in names:
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
    for name, (desc, m, expect, declared) in cases.items():
        data = render(m)
        (GOLD / f"{name}.mcap").write_bytes(data)
        models[name] = m
        index[name] = {
            "description": desc,
            "expect": expect,
            "expected_errors": sorted(declared),
            "sha256": cc.sha256(data),
        }
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


if __name__ == "__main__":
    main()
