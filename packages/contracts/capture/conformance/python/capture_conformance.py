"""Reference stateaction.capture.v1.1 MCAP conformance checker (Python).

The golden MCAP files are unchunked and uncompressed, so this module parses them with a tiny
record reader (no MCAP library) and the other language runners port the exact same rules.
Each runner must print a result byte-identical to golden/expected/<case>.json.

Result: {"outcome": accept|reject|legacy_jpeg, "errors": [sorted codes], "facts": {...}}
Large integers are always decimal strings.
"""

from __future__ import annotations

import hashlib
import json
import re
import struct
import zlib
from pathlib import Path

from strict_schema import MalformedJson, Schema, parse_json

CAPTURE_DIR = Path(__file__).resolve().parents[2]
VIDEO_CHANNEL = "/camera/rgb/video"
FRAME_ID = "camera_optical_frame"
CUSTOM = {
    "stateaction.capture.Profile.v1": "Profile.schema.json",
    "stateaction.capture.Clocks.v1": "Clocks.schema.json",
    "stateaction.capture.Inventory.v1": "Inventory.schema.json",
    "stateaction.capture.FrameEvent.v1": "FrameEvent.schema.json",
    "stateaction.capture.MotionEvent.v1": "MotionEvent.schema.json",
    "stateaction.capture.SensorEvent.v1": "SensorEvent.schema.json",
    "stateaction.capture.Close.v1": "Close.schema.json",
}
MAGIC = b"\x89MCAP0\r\n"


class Truncated(Exception):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- MCAP (unchunked) reader
# Supported layout (every reader): magic, Header, then only Schema/Channel/Message records, exactly one
# DataEnd whose data_section_crc is nonzero and equals CRC-32 of every byte before the DataEnd record
# (leading magic included, as the official MCAP readers compute it), then a Footer with no summary
# section (summary_start = summary_offset_start = summary_crc = 0) and the closing magic.
# Chunks, indexes, attachments, metadata, summary records or a missing DataEnd are E_UNSUPPORTED_LAYOUT;
# a zero or mismatched CRC is E_DATA_CRC.
# Definitions are checked while streaming, in file order (the MCAP rules the official readers rely on): a
# Channel's nonzero schema_id must name a Schema record already read, and a Message's channel_id a Channel
# already read (E_DEFINITION_ORDER). A repeated Schema/Channel id must repeat the identical record body
# (E_DEFINITION_CONFLICT); identical repeats are allowed. Schema id 0 is reserved for "no schema" and is
# never a valid Schema record id (E_DEFINITION_CONFLICT).
# Production chunked/indexed files are checked by verify.py --mcap with the official reader and
# validate_crcs=True, never reported complete by these readers.
OP_HEADER, OP_FOOTER, OP_SCHEMA, OP_CHANNEL, OP_MESSAGE, OP_DATA_END = 1, 2, 3, 4, 5, 15


class Unsupported(Exception):
    pass


class CrcMismatch(Exception):
    pass


class DefinitionOrder(Exception):
    """A Channel/Message refers to a Schema/Channel id that no earlier record defined."""


class DefinitionConflict(Exception):
    """A Schema/Channel id is redefined with different record bytes, or a Schema uses reserved id 0."""


def read_mcap(data: bytes) -> dict:
    try:
        out = _read_mcap(data)
    except (struct.error, UnicodeDecodeError, IndexError):
        raise Truncated("record fields") from None
    return out


def _read_mcap(data: bytes) -> dict:
    if not data.startswith(MAGIC):
        raise Truncated("magic")
    pos, end = len(MAGIC), len(data)
    out = {
        "profile": None,
        "schemas": {},
        "channels": {},
        "messages": [],
        "footer": False,
    }
    data_end = False
    raw = {
        OP_SCHEMA: {},
        OP_CHANNEL: {},
    }  # id -> exact record body, for redefinition checks

    def define(kind: int, ident: int, body: bytes) -> None:
        prior = raw[kind].get(ident)
        if prior is not None and prior != body:
            raise DefinitionConflict(f"record 0x{kind:02x} id {ident} redefined")
        raw[kind][ident] = body

    while True:
        if pos == end:
            raise Truncated("no footer")
        if pos + 9 > end:
            raise Truncated("record header")
        record_start = pos
        op = data[pos]
        (length,) = struct.unpack_from("<Q", data, pos + 1)
        body_start = pos + 9
        if length > end - body_start:
            raise Truncated("record body")
        body = data[body_start : body_start + length]
        pos = body_start + length
        if (op == OP_HEADER) != (record_start == len(MAGIC)):
            raise Unsupported("Header must be exactly the first record")
        if data_end and op != OP_FOOTER:
            raise Unsupported("summary section or records after DataEnd")
        if op == OP_HEADER:
            profile, _ = _string(body, 0)
            out["profile"] = profile
        elif op == OP_SCHEMA:
            (sid,) = struct.unpack_from("<H", body, 0)
            name, off = _string(body, 2)
            enc, off = _string(body, off)
            (n,) = struct.unpack_from("<I", body, off)
            if off + 4 + n > len(body):
                raise Truncated("schema data")
            if sid == 0:
                raise DefinitionConflict("schema id 0 is reserved")
            define(OP_SCHEMA, sid, body)
            out["schemas"][sid] = {
                "name": name,
                "encoding": enc,
                "data": body[off + 4 : off + 4 + n],
            }
        elif op == OP_CHANNEL:
            cid, sid = struct.unpack_from("<HH", body, 0)
            topic, off = _string(body, 4)
            menc, off = _string(body, off)
            if sid != 0 and sid not in out["schemas"]:
                raise DefinitionOrder("channel before its schema")
            define(OP_CHANNEL, cid, body)
            out["channels"][cid] = {"schema_id": sid, "topic": topic, "encoding": menc}
        elif op == OP_MESSAGE:
            cid, seq, log, pub = struct.unpack_from("<HIQQ", body, 0)
            if cid not in out["channels"]:
                raise DefinitionOrder("message before its channel")
            out["messages"].append(
                {
                    "channel": cid,
                    "sequence": seq,
                    "log_time": log,
                    "publish_time": pub,
                    "data": body[22:],
                }
            )
        elif op == OP_DATA_END:
            (crc,) = struct.unpack_from("<I", body, 0)
            data_end = True
            if crc == 0 or crc != zlib.crc32(data[:record_start]):
                raise CrcMismatch("data section CRC")
        elif op == OP_FOOTER:
            if not data_end:
                raise Unsupported("Footer without DataEnd")
            if struct.unpack_from("<QQI", body, 0) != (0, 0, 0):
                raise Unsupported("summary section/index not supported")
            out["footer"] = True
            if pos + len(MAGIC) != end or data[pos:] != MAGIC:
                raise Truncated("end magic")
            return out
        else:
            raise Unsupported(f"record opcode 0x{op:02x} outside the supported layout")


def _string(buf: bytes, off: int):
    (n,) = struct.unpack_from("<I", buf, off)
    if off + 4 + n > len(buf):
        raise Truncated("string")
    return buf[off + 4 : off + 4 + n].decode(), off + 4 + n


# ---------------------------------------------------------------- Protobuf CompressedVideo
def _varint(buf: bytes, pos: int):
    shift = value = 0
    while True:
        if pos >= len(buf) or shift > 63:
            raise ValueError("varint")
        b = buf[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, pos
        shift += 7


def decode_video(buf: bytes) -> dict:
    out, pos = {"sec": 0, "nanos": 0, "frame_id": "", "data": b"", "format": ""}, 0
    while pos < len(buf):
        key, pos = _varint(buf, pos)
        field, wire = key >> 3, key & 7
        if wire == 2:
            n, pos = _varint(buf, pos)
            if pos + n > len(buf):
                raise ValueError("length-delimited field overruns message")
            chunk, pos = buf[pos : pos + n], pos + n
            if field == 1:
                p = 0
                while p < len(chunk):
                    k, p = _varint(chunk, p)
                    v, p = _varint(chunk, p)
                    out["sec" if k >> 3 == 1 else "nanos"] = v
            elif field == 2:
                out["frame_id"] = chunk.decode()
            elif field == 3:
                out["data"] = chunk
            elif field == 4:
                out["format"] = chunk.decode()
        elif wire == 0:
            _, pos = _varint(buf, pos)
        else:
            raise ValueError("unsupported wire type")
    return out


# ---------------------------------------------------------------- Annex B
def nals(data: bytes):
    starts, i = [], 0
    while i + 2 < len(data):
        if data[i] == 0 and data[i + 1] == 0 and data[i + 2] == 1:
            starts.append((i, 3))
            i += 3
        elif (
            data[i] == 0
            and data[i + 1] == 0
            and i + 3 < len(data)
            and data[i + 2] == 0
            and data[i + 3] == 1
        ):
            starts.append((i, 4))
            i += 4
        else:
            i += 1
    if not starts or starts[0][0] != 0:
        return None
    out = []
    for n, (s, k) in enumerate(starts):
        e = starts[n + 1][0] if n + 1 < len(starts) else len(data)
        out.append(data[s + k : e])
    return out


def _unescape(b: bytes) -> bytes:
    out, zeros = bytearray(), 0
    for x in b:
        if zeros >= 2 and x == 3:
            zeros = 0
            continue
        out.append(x)
        zeros = zeros + 1 if x == 0 else 0
    return bytes(out)


def slice_header(nal: bytes):
    bits = "".join(f"{x:08b}" for x in _unescape(nal[1:12]))
    vals, p = [], 0
    for _ in range(2):
        z = 0
        while p + z < len(bits) and bits[p + z] == "0":
            z += 1
        if p + 2 * z + 1 > len(bits):
            return None
        vals.append(int(bits[p + z : p + 2 * z + 1], 2) - 1)
        p += 2 * z + 1
    return vals[0], vals[1]  # first_mb_in_slice, slice_type


def classify_au(data: bytes):
    """Return (errors, is_idr). Mirrors the Kotlin AnnexB.validateAccessUnit rules."""
    units = nals(data)
    if units is None:
        return ["E_NOT_ANNEXB"], False
    types = [n[0] & 31 for n in units]
    slices = [n for n in units if n[0] & 31 in (1, 5)]
    if not slices:
        return ["E_CONFIG_ONLY"], False
    errors = []
    headers = [slice_header(n) for n in slices]
    firsts = sum(1 for h in headers if h is not None and h[0] == 0)
    if any(h is None for h in headers) or firsts == 0:
        errors.append("E_PARTIAL_ACCESS_UNIT")  # no first slice: not a whole image
    elif firsts > 1:
        errors.append(
            "E_MULTIPLE_ACCESS_UNITS"
        )  # several complete images in one message
    elif any(h[1] % 5 == 1 for h in headers):
        errors.append("E_B_FRAME")
    idr = 5 in types
    if idr:
        before = types[: next(i for i, t in enumerate(types) if t in (1, 5))]
        if 7 not in before or 8 not in before:
            errors.append("E_MISSING_PARAMETER_SETS")
    return errors, idr


# ---------------------------------------------------------------- CDR (reviewed sensors)
def decode_cdr_pose(data: bytes) -> dict:
    """geometry_msgs/msg/PoseStamped, little-endian CDR."""
    if data[:4] != b"\x00\x01\x00\x00" or len(data) < 16:
        raise ValueError("CDR header")
    sec, nanos, n = struct.unpack_from("<iII", data, 4)
    frame = data[16 : 16 + n - 1].decode()
    pos = 16 + n
    pos += (-(pos - 4)) % 8
    values = struct.unpack_from("<7d", data, pos)
    return {
        "sec": sec,
        "nanosec": nanos,
        "frame_id": frame,
        "position": list(values[:3]),
        "orientation": list(values[3:]),
    }


# ---------------------------------------------------------------- Checker
VIDEO_SCHEMA = "foxglove.CompressedVideo"
POSE_SCHEMA = "geometry_msgs/msg/PoseStamped"
POSE_SCHEMA_FILE = "geometry_msgs-PoseStamped.ros2msg"
# topic -> (schema name, schema encoding, message encoding): the reviewed channel table.
CHANNELS = {
    "/stateaction/capture_profile": (
        "stateaction.capture.Profile.v1",
        "jsonschema",
        "json",
    ),
    "/stateaction/clocks": ("stateaction.capture.Clocks.v1", "jsonschema", "json"),
    "/stateaction/inventory": (
        "stateaction.capture.Inventory.v1",
        "jsonschema",
        "json",
    ),
    "/stateaction/frame_events": (
        "stateaction.capture.FrameEvent.v1",
        "jsonschema",
        "json",
    ),
    "/stateaction/imu/accel": (
        "stateaction.capture.MotionEvent.v1",
        "jsonschema",
        "json",
    ),
    "/stateaction/imu/gyro": (
        "stateaction.capture.MotionEvent.v1",
        "jsonschema",
        "json",
    ),
    "/stateaction/sensor_events": (
        "stateaction.capture.SensorEvent.v1",
        "jsonschema",
        "json",
    ),
    "/stateaction/close": ("stateaction.capture.Close.v1", "jsonschema", "json"),
    VIDEO_CHANNEL: (VIDEO_SCHEMA, "protobuf", "protobuf"),
    "/tracking/pose": (POSE_SCHEMA, "ros2msg", "cdr"),
}
TIME_BASE = {"numerator": 1, "denominator": 1_000_000}
DECIMAL = re.compile(r"^(0|[1-9][0-9]*)$")
IDENTITY_KEYS = (
    "recording_id",
    "stream_id",
    "native_timestamp_ns",
    "native_clock_id",
    "mapped_capture_time_ns",
    "clock_mapping_revision",
    "calibration_id",
    "encoder_pts_us",
    "encoder_time_base",
    "native_timestamps",
)
STATES = ("acquired", "submitted", "written", "dropped")


def _decimal(value) -> bool:
    return isinstance(value, str) and DECIMAL.match(value) is not None


_SCHEMAS: dict[str, Schema] = {}


def contract_schema(name: str) -> Schema:
    """The reviewed contract schema (never the file's embedded copy, which is only hash-compared)."""
    if name not in _SCHEMAS:
        _SCHEMAS[name] = Schema(json.loads((CAPTURE_DIR / CUSTOM[name]).read_bytes()))
    return _SCHEMAS[name]


SINGLETON_TOPICS = (
    "/stateaction/capture_profile",
    "/stateaction/clocks",
    "/stateaction/inventory",
    "/stateaction/close",
)


def check(data: bytes, manifest: dict | None = None) -> dict:
    manifest = (
        manifest or json.loads((CAPTURE_DIR / "manifest.json").read_text())["files"]
    )
    errors: set[str] = set()
    facts: dict = {}

    def reject():
        return {"outcome": "reject", "errors": sorted(errors), "facts": {}}

    try:
        f = read_mcap(data)
    except Truncated:
        return {"outcome": "reject", "errors": ["E_TRUNCATED"], "facts": {}}
    except Unsupported:
        return {"outcome": "reject", "errors": ["E_UNSUPPORTED_LAYOUT"], "facts": {}}
    except CrcMismatch:
        return {"outcome": "reject", "errors": ["E_DATA_CRC"], "facts": {}}
    except DefinitionOrder:
        return {"outcome": "reject", "errors": ["E_DEFINITION_ORDER"], "facts": {}}
    except DefinitionConflict:
        return {"outcome": "reject", "errors": ["E_DEFINITION_CONFLICT"], "facts": {}}
    if f["profile"] != "":
        errors.add("E_PROFILE_NOT_EMPTY")
    schemas = f["schemas"]
    chans = f["channels"]
    by_topic = {}
    for m in f["messages"]:
        by_topic.setdefault(chans[m["channel"]]["topic"], []).append(m)
    names = {s["name"] for s in schemas.values()}
    facts["channel_counts"] = {t: len(v) for t, v in sorted(by_topic.items())}
    if (
        "sensor_msgs/msg/CompressedImage" in names
        and "foxglove.CompressedVideo" not in names
    ):
        facts["legacy_images"] = len(by_topic.get("/camera/rgb/image/compressed", []))
        facts["legacy_log_times_ns"] = [
            str(m["log_time"]) for m in by_topic.get("/camera/rgb/image/compressed", [])
        ]
        return {"outcome": "legacy_jpeg", "errors": ["E_LEGACY_JPEG"], "facts": facts}

    # Exact per-channel encodings and reviewed schema identity.
    for ch in chans.values():
        schema = schemas.get(ch["schema_id"])
        want = CHANNELS.get(ch["topic"])
        if (
            schema is None
            or want is None
            or (schema["name"], schema["encoding"], ch["encoding"]) != want
        ):
            errors.add("E_CHANNEL_ENCODING")
        elif (
            schema["name"] == POSE_SCHEMA
            and sha256(schema["data"]) != manifest[POSE_SCHEMA_FILE]
        ):
            errors.add("E_CHANNEL_ENCODING")
    descriptor = manifest["foxglove-compressed-video.desc"]
    facts["schema_sha256"] = {}
    for s in schemas.values():
        digest = sha256(s["data"])
        facts["schema_sha256"][s["name"]] = digest
        if s["name"] == VIDEO_SCHEMA:
            if digest != descriptor:
                errors.add("E_DESCRIPTOR_HASH")
        elif s["name"] in CUSTOM:
            if digest != manifest[CUSTOM[s["name"]]]:
                errors.add("E_SCHEMA_MISMATCH")
    facts["schema_sha256"] = dict(sorted(facts["schema_sha256"].items()))

    # Decode every message once; an undecodable message is a defined reject.
    decoded: dict[str, list] = {}
    try:
        for topic, msgs in by_topic.items():
            want = CHANNELS.get(topic)
            if want is None:
                continue
            if want[2] == "json":
                decoded[topic] = [parse_json(m["data"]) for m in msgs]
            elif want[2] == "protobuf":
                decoded[topic] = [decode_video(m["data"]) for m in msgs]
            else:
                decoded[topic] = [decode_cdr_pose(m["data"]) for m in msgs]
    except (MalformedJson, ValueError, IndexError, struct.error, UnicodeDecodeError):
        errors.add("E_MALFORMED_MESSAGE")
        return reject()

    # Strict schema gate: every JSON message must satisfy its reviewed contract schema. Violations are
    # reported exactly (topic[index]pointer:keyword) and stop evaluation, so no rule reads unvalidated data.
    violations = []
    for topic in sorted(decoded):
        if CHANNELS[topic][2] != "json":
            continue
        validator = contract_schema(CHANNELS[topic][0])
        for i, value in enumerate(decoded[topic]):
            violations += [f"{topic}[{i}]{v}" for v in validator.validate(value)]
    if violations:
        errors.add("E_SCHEMA_MALFORMED")
        return {
            "outcome": "reject",
            "errors": sorted(errors),
            "facts": {"schema_violations": sorted(violations)},
        }
    if any(len(decoded.get(t, [])) != 1 for t in SINGLETON_TOPICS):
        errors.add("E_CHANNEL_CARDINALITY")
    recording_ids = {
        x["recording_id"]
        for t, v in decoded.items()
        if CHANNELS[t][2] == "json"
        for x in v
    }
    if len(recording_ids) > 1:
        errors.add("E_RECORDING_ID")

    def js(topic):
        return decoded.get(topic, [])

    clocks = (js("/stateaction/clocks") or [{}])[0].get("stream_clocks", {})
    inventory = (js("/stateaction/inventory") or [{}])[0]
    known_calibrations = {
        c.get("calibration_id")
        for c in inventory.get("calibrations", [])
        if isinstance(c, dict)
    }
    frames = js("/stateaction/frame_events")
    pts_seen, acquired, written_ev = set(), {}, {}
    counts = {"acquired": 0, "submitted": 0, "written": 0, "dropped": 0}
    state: dict[str, str] = {}
    submitted_ids: set[str] = set()
    drop_reasons: dict[str, int] = {}
    for e in frames:
        sid = e["source_frame_id"]
        st = e["state"]
        # Lifecycle: acquired once, then at most one submit and exactly one terminal outcome;
        # every later event repeats the acquired identity (clock, PTS, calibration, time base).
        if st == "acquired":
            if sid in acquired:
                errors.add("E_FRAME_IDENTITY")
        elif (
            sid not in acquired
            or state[sid] in ("written", "dropped")
            or (st == "submitted" and sid in submitted_ids)
        ):
            errors.add("E_FRAME_IDENTITY")
        else:
            original = acquired[sid]
            if any(e.get(k) != original.get(k) for k in IDENTITY_KEYS):
                errors.add("E_FRAME_IDENTITY")
        if clocks.get(e["stream_id"]) != e.get("native_clock_id") and st in (
            "acquired",
            "written",
        ):
            errors.add("E_CLOCK_MISMATCH")
        if st == "acquired":
            if e["encoder_pts_us"] in pts_seen:
                errors.add("E_DUPLICATE_PTS")
            pts_seen.add(e["encoder_pts_us"])
            if e["calibration_id"] not in known_calibrations:
                errors.add("E_CALIBRATION_UNKNOWN")
            acquired.setdefault(sid, e)
        if st == "submitted":
            submitted_ids.add(sid)
        if st == "written":
            written_ev.setdefault(sid, e)
        if st == "dropped":
            drop_reasons[e["reason"]] = drop_reasons.get(e["reason"], 0) + 1
        counts[st] += 1
        if sid in acquired:
            state[sid] = st
    facts["frame_event_counts"] = counts

    video = by_topic.get(VIDEO_CHANNEL, [])
    video_decoded = js(VIDEO_CHANNEL)
    written_seqs = [e["output_sequence"] for e in written_ev.values()]
    video_seqs = [m["sequence"] for m in video]
    if (
        len(set(written_seqs)) != len(written_seqs)
        or len(set(video_seqs)) != len(video_seqs)
        or set(written_seqs) != set(video_seqs)
    ):
        errors.add("E_SEQUENCE")
    by_seq = {e["output_sequence"]: e for e in written_ev.values()}
    video_facts = []
    for i, (m, v) in enumerate(zip(video, video_decoded)):
        au_errors, idr = classify_au(v["data"])
        errors.update(au_errors)
        if i == 0 and not idr and not au_errors:
            errors.add("E_FIRST_NOT_IDR")
        ts_ns = v["sec"] * 1_000_000_000 + v["nanos"]
        ev = by_seq.get(m["sequence"])
        if v["frame_id"] != FRAME_ID or v["format"] != "h264":
            errors.add("E_VIDEO_FIELDS")
        if ev is not None and (
            str(ts_ns) != ev["mapped_capture_time_ns"] or bool(ev["is_idr"]) != idr
        ):
            errors.add("E_VIDEO_TIMESTAMP_MISMATCH")
        video_facts.append(
            {
                "sequence": m["sequence"],
                "capture_time_ns": str(ts_ns),
                "log_time_ns": str(m["log_time"]),
                "frame_id": v["frame_id"],
                "format": v["format"],
                "bytes": len(v["data"]),
                "idr": idr,
                "sha256": sha256(v["data"]),
                "source_frame_id": ev["source_frame_id"] if ev else None,
                "encoder_pts_us": ev.get("encoder_pts_us") if ev else None,
            }
        )
    facts["video"] = video_facts

    motion = {}
    for topic in ("/stateaction/imu/accel", "/stateaction/imu/gyro"):
        evs = js(topic)
        motion[topic] = [
            {
                "event_id": e["event_id"],
                "native_timestamp_ns": e["native_timestamp_ns"],
                "mapped_capture_time_ns": e.get("mapped_capture_time_ns"),
            }
            for e in evs
        ]
        for e in evs:
            if clocks.get(topic.rsplit("/", 1)[1]) != e["native_clock_id"]:
                errors.add("E_CLOCK_MISMATCH")
    facts["motion"] = motion

    sensors = js("/stateaction/sensor_events")
    cals = {e["calibration_id"] for e in acquired.values()}
    reset_at = {}
    for e in sensors:
        if (
            e["source_kind"] == "arcore_pose"
            and e.get("tracking_state") != "tracking"
            and e.get("pose_valid")
        ):
            errors.add("E_TRACKING_LOSS_UNMARKED")
        if e["source_kind"] == "calibration_reset":
            reset_at[e["supersedes_calibration_id"]] = e["association_source_frame_id"]
    for e in acquired.values():
        if e["calibration_id"] in reset_at:
            # frames at or after the reset boundary may not keep the superseded calibration
            if reset_at[e["calibration_id"]] is not None and int(
                e["source_frame_id"]
            ) >= int(reset_at[e["calibration_id"]]):
                errors.add("E_CALIBRATION_RESET_UNMARKED")
    facts["sensor_events"] = [
        {
            "event_id": e["event_id"],
            "source_kind": e["source_kind"],
            "native_timestamp_ns": e["native_timestamp_ns"],
            "tracking_state": e.get("tracking_state"),
        }
        for e in sensors
    ]
    facts["calibrations_used"] = sorted(cals)

    poses = []
    for m, p in zip(by_topic.get("/tracking/pose", []), js("/tracking/pose")):
        poses.append(
            {
                "sec": p["sec"],
                "nanosec": p["nanosec"],
                "frame_id": p["frame_id"],
                "log_time_ns": str(m["log_time"]),
            }
        )
    facts["cdr_poses"] = poses

    close = (js("/stateaction/close") or [None])[-1]
    if close is not None:
        unresolved = (
            len(acquired)
            - len(written_ev)
            - sum(1 for s in state.values() if s == "dropped")
        )
        expect = {k: str(v) for k, v in counts.items()}
        expect["unresolved"] = str(unresolved)
        expect_motion = {t.rsplit("/", 1)[1]: str(len(js(t))) for t in motion}
        expect_drops = sorted(
            ({"reason": r, "count": str(n)} for r, n in drop_reasons.items()),
            key=lambda d: d["reason"],
        )
        if (
            close["frames"] != expect
            or close["video_messages"] != str(len(video))
            or close["motion_events"] != expect_motion
            or close["sensor_events"] != str(len(sensors))
            or sorted(close["drops"], key=lambda d: d["reason"]) != expect_drops
        ):
            errors.add("E_COUNT_MISMATCH")
        outcome = close["outcome"]
        if outcome == "completed" and unresolved != 0:
            errors.add("E_OUTCOME_MISMATCH")
        elif outcome == "failed" and close.get("failure_reason") is None:
            errors.add("E_OUTCOME_MISMATCH")
        facts["close_outcome"] = outcome
        facts["unresolved_frames"] = unresolved
    return {
        "outcome": "reject" if errors else "accept",
        "errors": sorted(errors),
        "facts": facts if not errors else {},
    }


# ---------------------------------------------------------------- Encoder buffer sequences
CODEC_CONFIG, PARTIAL_FRAME, END_OF_STREAM = 2, 8, 4  # MediaCodec buffer-flag values
START = b"\x00\x00\x00\x01"


def encoder_buffer_data(buf: dict, sources: dict) -> bytes:
    """Resolve a fixture buffer: NAL range of a public source stream, optional byte slice."""
    if "nals" not in buf:
        return b""
    first, last = buf["nals"]
    data = b"".join(START + n for n in sources[buf["source"]][first:last])
    if "bytes" in buf:
        data = data[buf["bytes"][0] : buf["bytes"][1]]
    return data


def assemble_encoder_buffers(buffers: list, sources: dict) -> dict:
    """Assemble MediaCodec-style output buffers into whole access units.

    CODEC_CONFIG buffers never become images; they are prepended to an IDR access unit that lacks
    SPS/PPS. PARTIAL_FRAME buffers (same PTS) accumulate until a buffer without the flag completes
    the access unit. Result: accept with the assembled units, or reject with sorted codes.
    """
    errors: set[str] = set()
    aus, config, pending = [], b"", None
    for buf in buffers:
        flags, data = buf["flags"], encoder_buffer_data(buf, sources)
        if flags & CODEC_CONFIG:
            if pending is not None:
                errors.add("E_INCOMPLETE_AU")
                break
            config = data
            continue
        if flags & END_OF_STREAM and not data:
            if pending is not None:
                errors.add("E_INCOMPLETE_AU")
            break
        pts = buf["pts_us"]
        if not _decimal(pts):
            errors.add("E_PTS_INVALID")
            break
        if pending is not None and pending[0] != pts:
            errors.add("E_PARTIAL_PTS_MISMATCH")
            break
        acc = (pending[1] if pending is not None else b"") + data
        if flags & PARTIAL_FRAME:
            pending = (pts, acc)
            continue
        pending = None
        units = nals(acc)
        if units is not None and any(n[0] & 31 == 5 for n in units):
            types = [n[0] & 31 for n in units]
            before = types[: next(i for i, t in enumerate(types) if t in (1, 5))]
            if (7 not in before or 8 not in before) and config:
                acc = config + acc
        au_errors, idr = classify_au(acc)
        if au_errors:
            errors.update(au_errors)
            break
        aus.append(
            {"pts_us": pts, "idr": idr, "bytes": len(acc), "sha256": sha256(acc)}
        )
    else:
        if pending is not None:
            errors.add("E_INCOMPLETE_AU")
    if errors:
        return {"outcome": "reject", "errors": sorted(errors), "aus": []}
    return {"outcome": "accept", "errors": [], "aus": aus}


def canonical(result: dict) -> str:
    return (
        json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    )


if __name__ == "__main__":
    import sys

    sys.stdout.write(canonical(check(Path(sys.argv[1]).read_bytes())))
