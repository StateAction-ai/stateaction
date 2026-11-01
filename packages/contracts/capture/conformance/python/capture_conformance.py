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
import struct
from pathlib import Path

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
def read_mcap(data: bytes) -> dict:
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
    while True:
        if pos == end:
            raise Truncated("no footer")
        if pos + 9 > end:
            raise Truncated("record header")
        op = data[pos]
        (length,) = struct.unpack_from("<Q", data, pos + 1)
        body_start = pos + 9
        if body_start + length > end:
            raise Truncated("record body")
        body = data[body_start : body_start + length]
        pos = body_start + length
        if op == 0x01:
            profile, _ = _string(body, 0)
            out["profile"] = profile
        elif op == 0x03:
            (sid,) = struct.unpack_from("<H", body, 0)
            name, off = _string(body, 2)
            enc, off = _string(body, off)
            (n,) = struct.unpack_from("<I", body, off)
            out["schemas"][sid] = {
                "name": name,
                "encoding": enc,
                "data": body[off + 4 : off + 4 + n],
            }
        elif op == 0x04:
            cid, sid = struct.unpack_from("<HH", body, 0)
            topic, off = _string(body, 4)
            menc, off = _string(body, off)
            out["channels"][cid] = {"schema_id": sid, "topic": topic, "encoding": menc}
        elif op == 0x05:
            cid, seq, log, pub = struct.unpack_from("<HIQQ", body, 0)
            out["messages"].append(
                {
                    "channel": cid,
                    "sequence": seq,
                    "log_time": log,
                    "publish_time": pub,
                    "data": body[22:],
                }
            )
        elif op == 0x02:
            out["footer"] = True
            if pos + len(MAGIC) != end or data[pos:] != MAGIC:
                raise Truncated("end magic")
            return out


def _string(buf: bytes, off: int):
    (n,) = struct.unpack_from("<I", buf, off)
    if off + 4 + n > len(buf):
        raise Truncated("string")
    return buf[off + 4 : off + 4 + n].decode(), off + 4 + n


# ---------------------------------------------------------------- Protobuf CompressedVideo
def _varint(buf: bytes, pos: int):
    shift = value = 0
    while True:
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
            raise ValueError("wire type")
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
    if any(h is None for h in headers) or sum(1 for h in headers if h[0] == 0) != 1:
        errors.append("E_PARTIAL_ACCESS_UNIT")
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
    if data[:4] != b"\x00\x01\x00\x00":
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
def check(data: bytes, manifest: dict | None = None) -> dict:
    manifest = (
        manifest or json.loads((CAPTURE_DIR / "manifest.json").read_text())["files"]
    )
    errors: set[str] = set()
    facts: dict = {}
    try:
        f = read_mcap(data)
    except Truncated:
        return {"outcome": "reject", "errors": ["E_TRUNCATED"], "facts": {}}
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

    descriptor = manifest["foxglove-compressed-video.desc"]
    facts["schema_sha256"] = {}
    for s in schemas.values():
        digest = sha256(s["data"])
        facts["schema_sha256"][s["name"]] = digest
        if s["name"] == "foxglove.CompressedVideo":
            if digest != descriptor or s["encoding"] != "protobuf":
                errors.add("E_DESCRIPTOR_HASH")
        elif s["name"] in CUSTOM:
            if digest != manifest[CUSTOM[s["name"]]] or s["encoding"] != "jsonschema":
                errors.add("E_SCHEMA_MISMATCH")
    facts["schema_sha256"] = dict(sorted(facts["schema_sha256"].items()))

    def js(topic):
        return [json.loads(m["data"]) for m in by_topic.get(topic, [])]

    clocks = (js("/stateaction/clocks") or [{}])[0].get("stream_clocks", {})
    frames = js("/stateaction/frame_events")
    pts_seen, pts_by_frame, acquired, written_ev = set(), {}, {}, {}
    counts = {"acquired": 0, "submitted": 0, "written": 0, "dropped": 0}
    state: dict[str, str] = {}
    for e in frames:
        sid = e["source_frame_id"]
        if clocks.get(e["stream_id"]) != e.get("native_clock_id") and e["state"] in (
            "acquired",
            "written",
        ):
            errors.add("E_CLOCK_MISMATCH")
        if e["state"] in ("acquired", "written") and "encoder_pts_us" not in e:
            errors.add("E_MISSING_PTS")
        if e["state"] == "acquired":
            if "encoder_pts_us" in e:
                if e["encoder_pts_us"] in pts_seen:
                    errors.add("E_DUPLICATE_PTS")
                pts_seen.add(e["encoder_pts_us"])
                pts_by_frame[sid] = e["encoder_pts_us"]
            acquired[sid] = e
        if e["state"] == "written":
            written_ev[sid] = e
        counts[e["state"]] += 1
        state[sid] = e["state"]
    facts["frame_event_counts"] = counts

    video = by_topic.get(VIDEO_CHANNEL, [])
    by_seq = {e["output_sequence"]: e for e in written_ev.values()}
    video_facts = []
    for i, m in enumerate(video):
        v = decode_video(m["data"])
        au_errors, idr = classify_au(v["data"])
        errors.update(au_errors)
        if i == 0 and not idr and not au_errors:
            errors.add("E_FIRST_NOT_IDR")
        ts_ns = v["sec"] * 1_000_000_000 + v["nanos"]
        ev = by_seq.get(m["sequence"])
        if v["frame_id"] != FRAME_ID or v["format"] != "h264":
            errors.add("E_VIDEO_FIELDS")
        if ev is None:
            errors.add("E_MISSING_PTS")
        elif str(ts_ns) != ev["mapped_capture_time_ns"] or bool(ev["is_idr"]) != idr:
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
    if len(video) != counts["written"]:
        errors.add("E_MISSING_PTS")

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
    cals = {e["calibration_id"] for e in frames if e["state"] == "acquired"}
    superseded = set()
    reset_at = {}
    for e in sensors:
        if (
            e["source_kind"] == "arcore_pose"
            and e.get("tracking_state") != "tracking"
            and e.get("pose_valid")
        ):
            errors.add("E_TRACKING_LOSS_UNMARKED")
        if e["source_kind"] == "calibration_reset":
            superseded.add(e["supersedes_calibration_id"])
            reset_at[e["supersedes_calibration_id"]] = e["association_source_frame_id"]
    for e in frames:
        if e["state"] == "acquired" and e["calibration_id"] in reset_at:
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
    for m in by_topic.get("/tracking/pose", []):
        p = decode_cdr_pose(m["data"])
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
        expect = {k: str(v) for k, v in counts.items()}
        expect["unresolved"] = str(
            len(acquired)
            - len(written_ev)
            - sum(1 for s in state.values() if s == "dropped")
        )
        if close["frames"] != expect or close["video_messages"] != str(len(video)):
            errors.add("E_COUNT_MISMATCH")
        facts["close_outcome"] = close["outcome"]
    else:
        errors.add("E_COUNT_MISMATCH")
    return {
        "outcome": "reject" if errors else "accept",
        "errors": sorted(errors),
        "facts": facts if not errors else {},
    }


def canonical(result: dict) -> str:
    return (
        json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    )


if __name__ == "__main__":
    import sys

    sys.stdout.write(canonical(check(Path(sys.argv[1]).read_bytes())))
