#!/usr/bin/env python3
"""Independently validate recorder-produced H.264 MCAP captures against the published SA-50 contract.

For each file this script, without using any recorder code:

1. reads it with the official ``mcap`` reader (``validate_crcs=True``), requires the generic (empty) header profile,
   a summary with chunk indexes and the exact v1.1 topic set;
2. flattens the chunked/indexed production layout into the portable layout (same Schema/Channel/Message records in
   file order, no chunks/indexes/metadata) and runs the SA-50 Python reference checker ``capture_conformance.check``,
   which applies the strict schemas, frame lifecycle, sequence, timestamp, calibration and Close-count rules;
3. writes the access units to an Annex B elementary stream and decodes it with ffprobe/ffmpeg, checking decoded frame
   count, picture types (no B), IDR spacing on the capture timeline, raster and AVC profile/level;
4. prints a JSON receipt with hashes and counts. Captures stay where they are; nothing is copied into Git.

Run with the contract's pinned readers::

    uv run --no-project --with mcap==1.6.0 --with jsonschema==4.25.1 --with protobuf==6.33.0 \\
        python -I scripts/validate_h264_capture.py --profile h264_mcap_simulation_v1 CAPTURE.mcap ...
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFORMANCE = ROOT / "packages/contracts/capture/conformance/python"
sys.path.insert(0, str(CONFORMANCE))

import capture_conformance as cc  # noqa: E402

OP_CHUNK = 6
CONTRACT_TOPICS = {
    "/stateaction/capture_profile",
    "/stateaction/clocks",
    "/stateaction/inventory",
    "/stateaction/frame_events",
    "/stateaction/sensor_events",
    "/stateaction/close",
    "/stateaction/imu/accel",
    "/stateaction/imu/gyro",
    "/camera/rgb/video",
    "/tracking/pose",
}
LEVELS = {"h264_mcap_v1": (1920, 1080, 40), "h264_mcap_simulation_v1": (640, 480, 31)}


class ValidationError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def records(data: bytes):
    """Top-level (opcode, body) records between the magics."""
    require(data.startswith(cc.MAGIC) and data.endswith(cc.MAGIC), "MCAP magic missing")
    pos, end = len(cc.MAGIC), len(data) - len(cc.MAGIC)
    while pos < end:
        op = data[pos]
        (length,) = struct.unpack_from("<Q", data, pos + 1)
        require(pos + 9 + length <= end, "record overruns file")
        yield op, data[pos + 9 : pos + 9 + length]
        pos += 9 + length


def chunk_records(body: bytes):
    """Inner records of an uncompressed Chunk; the chunk CRC was already verified by the official reader."""
    pos = 8 + 8 + 8 + 4
    (n,) = struct.unpack_from("<I", body, pos)
    compression = body[pos + 4 : pos + 4 + n].decode()
    require(compression == "", f"unsupported chunk compression {compression!r}")
    pos += 4 + n
    (size,) = struct.unpack_from("<Q", body, pos)
    inner = body[pos + 8 : pos + 8 + size]
    i = 0
    while i < len(inner):
        op = inner[i]
        (length,) = struct.unpack_from("<Q", inner, i + 1)
        yield op, inner[i + 9 : i + 9 + length]
        i += 9 + length


def flatten(data: bytes) -> bytes:
    """Production layout -> portable layout, preserving Schema/Channel/Message order and bytes."""
    kept = []
    for op, body in records(data):
        if op == cc.OP_HEADER:
            kept.append((op, body))
        elif op in (cc.OP_SCHEMA, cc.OP_CHANNEL, cc.OP_MESSAGE):
            kept.append((op, body))
        elif op == OP_CHUNK:
            kept.extend(
                (iop, ib)
                for iop, ib in chunk_records(body)
                if iop in (cc.OP_SCHEMA, cc.OP_CHANNEL, cc.OP_MESSAGE)
            )
        elif op == cc.OP_DATA_END:
            break
    out = bytearray(cc.MAGIC)

    def rec(op: int, body: bytes) -> bytes:
        return bytes([op]) + struct.pack("<Q", len(body)) + body

    for op, body in kept:
        out += rec(op, body)
    out += rec(cc.OP_DATA_END, struct.pack("<I", zlib.crc32(bytes(out))))
    out += rec(cc.OP_FOOTER, struct.pack("<QQI", 0, 0, 0))
    return bytes(out + cc.MAGIC)


def official(path: Path) -> dict:
    from mcap.reader import make_reader

    with path.open("rb") as source:
        reader = make_reader(source, validate_crcs=True)
        header = reader.get_header()
        summary = reader.get_summary()
        topics: dict[str, int] = {}
        video = []
        for schema, channel, message in reader.iter_messages(log_time_order=False):
            topics[channel.topic] = topics.get(channel.topic, 0) + 1
            if channel.topic == "/camera/rgb/video":
                video.append(message.data)
    require(header.profile == "", f"header profile {header.profile!r} is not generic")
    require(
        summary is not None and len(summary.chunk_indexes) > 0,
        "no indexed summary (chunk indexes)",
    )
    require(
        set(topics) <= CONTRACT_TOPICS,
        f"undeclared topics {sorted(set(topics) - CONTRACT_TOPICS)}",
    )
    return {
        "library": header.library,
        "chunk_indexes": len(summary.chunk_indexes),
        "topics": dict(sorted(topics.items())),
        "video": video,
    }


def decode(
    units: list[bytes], workdir: Path, expected: tuple[int, int, int] | None
) -> dict:
    stream = workdir / "video.h264"
    stream.write_bytes(b"".join(units))
    probe = json.loads(
        subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-count_frames",
                "-show_streams",
                "-show_frames",
                "-show_entries",
                "stream=codec_name,profile,level,width,height,pix_fmt,color_range,color_space,has_b_frames,nb_read_frames:frame=pict_type,key_frame",
                "-of",
                "json",
                str(stream),
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    st = probe["streams"][0]
    frames = probe.get("frames", [])
    errors = subprocess.run(
        ["ffmpeg", "-v", "error", "-xerror", "-i", str(stream), "-f", "null", "-"],
        capture_output=True,
        text=True,
    )
    require(
        errors.returncode == 0 and not errors.stderr.strip(),
        f"ffmpeg decode errors: {errors.stderr.strip()[:400]}",
    )
    require(st["codec_name"] == "h264", f"codec {st['codec_name']}")
    if expected is not None:
        width, height, level = expected
        require(
            st["profile"] == "Main" and st["level"] == level,
            f"stream {st['profile']} level {st['level']}",
        )
        require(
            (st["width"], st["height"]) == (width, height),
            f"raster {st['width']}x{st['height']}",
        )
    require(
        int(st["nb_read_frames"]) == len(units),
        f"decoded {st['nb_read_frames']} of {len(units)} access units",
    )
    types = [f["pict_type"] for f in frames]
    require("B" not in types, "decoded B pictures")
    return {
        "stream": {
            k: st.get(k)
            for k in (
                "codec_name",
                "profile",
                "level",
                "width",
                "height",
                "pix_fmt",
                "color_range",
                "color_space",
                "has_b_frames",
                "nb_read_frames",
            )
        },
        "pict_types": {t: types.count(t) for t in sorted(set(types))},
        "decoded_keyframes": sum(int(f["key_frame"]) for f in frames),
    }


def validate(path: Path, profile: str, synthetic: bool = False) -> dict:
    data = path.read_bytes()
    off = official(path)
    flat = flatten(data)
    result = cc.check(flat)
    require(
        result["outcome"] == "accept", f"SA-50 checker rejected: {result['errors']}"
    )
    facts = result["facts"]
    decoded = [cc.decode_video(v) for v in off["video"]]
    profile_msgs = [
        json.loads(m) for m in _json_topic(flat, "/stateaction/capture_profile")
    ]
    close = [json.loads(m) for m in _json_topic(flat, "/stateaction/close")][0]
    frames = [json.loads(m) for m in _json_topic(flat, "/stateaction/frame_events")]
    require(
        profile_msgs[0]["rgb_profile"] == profile,
        f"profile {profile_msgs[0]['rgb_profile']} != {profile}",
    )
    written = [f for f in frames if f["state"] == "written"]
    idr_times = [int(f["mapped_capture_time_ns"]) for f in written if f["is_idr"]]
    gaps = [b - a for a, b in zip(idr_times, idr_times[1:])]
    if decoded:
        with tempfile.TemporaryDirectory() as tmp:
            video = decode(
                [v["data"] for v in decoded],
                Path(tmp),
                None if synthetic else LEVELS[profile],
            )
        require(
            video["decoded_keyframes"] >= len(idr_times),
            "decoder found fewer keyframes than written IDR events",
        )
    else:
        # A take that ended before its first access unit has nothing to decode.
        video = {"stream": None, "pict_types": {}, "decoded_keyframes": 0}
    inventory = [json.loads(m) for m in _json_topic(flat, "/stateaction/inventory")][0]
    pose_events = [
        e
        for e in map(json.loads, _json_topic(flat, "/stateaction/sensor_events"))
        if e.get("stream_id") == "pose"
    ]
    written_ids = {f["source_frame_id"] for f in written}
    pts = [int(f["encoder_pts_us"]) for f in frames if f["state"] == "acquired"]
    require(
        len(pts) == len(set(pts)) and pts == sorted(pts),
        "encoder PTS not unique and increasing",
    )
    return {
        "path": str(path),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "official_reader": {k: v for k, v in off.items() if k != "video"},
        "sa50_checker": "accept",
        "close": close,
        "frame_event_counts": facts["frame_event_counts"],
        "video_messages": len(facts["video"]),
        "idr_written": len(idr_times),
        "max_idr_gap_ms": round(max(gaps) / 1e6, 1) if gaps else None,
        "capture_span_ms": round(
            (
                int(written[-1]["mapped_capture_time_ns"])
                - int(written[0]["mapped_capture_time_ns"])
            )
            / 1e6,
            1,
        )
        if written
        else 0,
        "inventory_calibrations": inventory["calibrations"],
        "acquired_frames": sum(1 for f in frames if f["state"] == "acquired"),
        "pose_events": {
            "valid": sum(1 for e in pose_events if e.get("pose_valid") is True),
            "invalid": sum(1 for e in pose_events if e.get("pose_valid") is False),
            "invalid_with_written_rgb": sum(
                1
                for e in pose_events
                if e.get("pose_valid") is False
                and e.get("association_source_frame_id") in written_ids
            ),
        },
        "tracking_states": sorted(
            {
                e["tracking_state"]
                for e in facts["sensor_events"]
                if e.get("tracking_state")
            }
        ),
        "encoder": profile_msgs[0].get("encoder"),
        "qualification": profile_msgs[0]["qualification"],
        "decode": video,
    }


def _json_topic(flat: bytes, topic: str) -> list[bytes]:
    model = cc.read_mcap(flat)
    ids = {cid for cid, c in model["channels"].items() if c["topic"] == topic}
    return [m["data"] for m in model["messages"] if m["channel"] in ids]


def check_completed_sidecar(path: Path, profile: str, video_messages: int) -> None:
    """Check the recorder sidecar against the independently decoded MCAP count."""
    require(
        not path.with_name("recovery_required.json").exists(),
        "session has a recovery marker",
    )
    metadata = json.loads(path.with_name("metadata.json").read_text())
    terminal = metadata["h264_terminal"]
    journal = json.loads(path.with_name("finalization_journal.json").read_text())
    require(
        journal["phase"] == "FINALIZED" and journal["final"] is True,
        "session journal did not finalize",
    )
    token = metadata["finalization_token"]
    require(
        isinstance(token, str)
        and bool(token)
        and journal["source_identity"]["finalizationToken"] == token
        and journal["recording_id"] == terminal["recording_id"],
        "session journal does not match sidecar",
    )
    require(
        metadata["finalization_complete"] is True, "capture finalization is incomplete"
    )
    require(
        metadata["capture_outcome"] == "completed", "sidecar capture was not completed"
    )
    require(metadata["container_state"] == "closed", "sidecar container is not closed")
    require(metadata["recovery_state"] == "none", "sidecar capture requires recovery")
    require(terminal["profile"] == profile, "sidecar profile does not match MCAP")
    if profile == "h264_mcap_v1":
        require(
            terminal["encoder"]["hardware"] is True,
            "sidecar lacks hardware AVC evidence",
        )
    for key in ("rgb_encoded_count", "total_video_frames_encoded", "rgb_written_count"):
        require(metadata[key] == video_messages, f"sidecar {key} disagrees with MCAP")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--profile", required=True, choices=sorted(LEVELS))
    outcome = parser.add_mutually_exclusive_group()
    outcome.add_argument(
        "--expect-outcome",
        default=None,
        help="require this Close outcome for every file",
    )
    parser.add_argument(
        "--synthetic-source",
        action="store_true",
        help="JVM fixtures built from the public Baseline golden stream: skip only AVC profile/level/raster checks",
    )
    outcome.add_argument(
        "--check-sidecar",
        action="store_true",
        help="require a completed recording and check adjacent metadata.json against MCAP video",
    )
    parser.add_argument("mcap", nargs="+", type=Path)
    args = parser.parse_args()
    receipts, failed = [], False
    for path in args.mcap:
        try:
            receipt = validate(path, args.profile, args.synthetic_source)
            expected_outcome = (
                "completed" if args.check_sidecar else args.expect_outcome
            )
            if expected_outcome:
                require(
                    receipt["close"]["outcome"] == expected_outcome,
                    f"outcome {receipt['close']['outcome']}",
                )
            if expected_outcome == "completed":
                require(receipt["video_messages"] > 0, "no RGB video messages in MCAP")
            if args.check_sidecar:
                if args.profile == "h264_mcap_v1":
                    require(
                        receipt["encoder"]["hardware"] is True,
                        "MCAP lacks hardware AVC evidence",
                    )
                check_completed_sidecar(path, args.profile, receipt["video_messages"])
            receipts.append({"status": "passed", **receipt})
        except (
            ValidationError,
            Exception,
        ) as error:  # report every file, fail at the end
            failed = True
            receipts.append(
                {
                    "status": "failed",
                    "path": str(path),
                    "error": f"{type(error).__name__}: {error}",
                }
            )
    print(
        json.dumps(
            {
                "validator": "scripts/validate_h264_capture.py",
                "profile": args.profile,
                "files": receipts,
            },
            indent=2,
        )
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
