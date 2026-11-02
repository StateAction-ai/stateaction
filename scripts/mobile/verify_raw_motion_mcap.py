#!/usr/bin/env python3
"""Independently verify raw motion in a recorder MCAP (SA-53).

Reads the file with the official `mcap` reader (requirements-inspection.txt), validates
every `/stateaction/imu/{accel,gyro}` message with the SA-50 strict MotionEvent schema and
checks independence semantics: one topic per sensor, contiguous per-sensor event IDs
(a gap is reported as loss), MCAP log time equal to the original native timestamp, no
clock mapping, and no paired `/device/imu` topic. With `--metadata`, the recorder's
`raw_motion` evidence must equal the file's counts exactly.

Prints a JSON summary without raw values; exits non-zero on any violation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CAPTURE = ROOT / "packages/contracts/capture"
sys.path.insert(0, str(CAPTURE / "conformance/python"))

from strict_schema import Schema, parse_json  # noqa: E402

TOPICS = {
    "/stateaction/imu/accel": ("accel", "m/s^2"),
    "/stateaction/imu/gyro": ("gyro", "rad/s"),
}
SCHEMA_NAME = "stateaction.capture.MotionEvent.v1"


def verify(path: Path, metadata: Path | None) -> dict:
    from mcap.reader import make_reader

    contract_bytes = (CAPTURE / "MotionEvent.schema.json").read_bytes()
    schema = Schema(json.loads(contract_bytes))
    errors: list[str] = []
    per: dict[str, dict] = {
        sensor: {
            "messages": 0,
            "first_event_id": None,
            "missing_event_ids": 0,
            "first_native_timestamp_ns": None,
            "last_native_timestamp_ns": None,
            "non_increasing_timestamps": 0,
        }
        for sensor, _ in TOPICS.values()
    }
    recording_ids: set[str] = set()
    last_id: dict[str, int] = {}
    last_ts: dict[str, int] = {}
    topics_seen: set[str] = set()
    with path.open("rb") as stream:
        reader = make_reader(stream)
        summary = reader.get_summary()
        if summary is not None:
            topics_seen = {channel.topic for channel in summary.channels.values()}
        for schema_record, channel, message in reader.iter_messages():
            topics_seen.add(channel.topic)
            if channel.topic not in TOPICS:
                continue
            sensor, unit = TOPICS[channel.topic]
            where = f"{channel.topic}#{message.sequence}"
            if (
                schema_record is None
                or schema_record.name != SCHEMA_NAME
                or schema_record.encoding != "jsonschema"
            ):
                errors.append(f"{where}: wrong schema identity")
            elif schema_record.data != contract_bytes:
                errors.append(
                    f"{where}: embedded schema differs from the published contract"
                )
            if channel.message_encoding != "json":
                errors.append(f"{where}: message encoding is not json")
            try:
                event = parse_json(message.data)
            except ValueError as error:
                errors.append(f"{where}: malformed JSON ({error})")
                continue
            violations = schema.validate(event)
            if violations:
                errors.append(f"{where}: schema violations {sorted(violations)[:5]}")
                continue
            if event["unit"] != unit:
                errors.append(f"{where}: unit {event['unit']} on {sensor} topic")
            if event["mapped_capture_time_ns"] is not None:
                errors.append(
                    f"{where}: mapped time present without a declared clock mapping"
                )
            native = int(event["native_timestamp_ns"])
            if message.log_time != native:
                errors.append(f"{where}: log_time is not the original native timestamp")
            recording_ids.add(event["recording_id"])
            stats = per[sensor]
            stats["messages"] += 1
            event_id = int(event["event_id"])
            if sensor in last_id:
                if event_id <= last_id[sensor]:
                    errors.append(f"{where}: event_id not increasing")
                stats["missing_event_ids"] += max(0, event_id - last_id[sensor] - 1)
            else:
                stats["first_event_id"] = event_id
                stats["missing_event_ids"] += event_id
            if sensor in last_ts and native <= last_ts[sensor]:
                stats["non_increasing_timestamps"] += 1
            last_id[sensor] = event_id
            last_ts[sensor] = max(native, last_ts.get(sensor, native))
            stats["first_native_timestamp_ns"] = stats[
                "first_native_timestamp_ns"
            ] or str(native)
            stats["last_native_timestamp_ns"] = str(native)
    if "/device/imu" in topics_seen:
        errors.append("paired /device/imu topic present")
    if len(recording_ids) > 1:
        errors.append("motion messages carry more than one recording_id")
    for sensor, stats in per.items():
        stats["effective_rate_hz"] = None
        if stats["messages"] > 1:
            span = int(stats["last_native_timestamp_ns"]) - int(
                stats["first_native_timestamp_ns"]
            )
            stats["effective_rate_hz"] = (
                (stats["messages"] - 1) * 1e9 / span if span > 0 else None
            )
    if metadata is not None:
        evidence = json.loads(metadata.read_text()).get("raw_motion")
        if not isinstance(evidence, dict):
            errors.append("metadata has no raw_motion evidence")
        else:
            for sensor, stats in per.items():
                block = evidence["sensors"][sensor]
                if block["written"] != stats["messages"]:
                    errors.append(
                        f"{sensor}: metadata written {block['written']} != file {stats['messages']}"
                    )
                dropped = sum(block["dropped"].values())
                if (
                    block["delivered"]
                    != block["written"] + dropped + block["queued_at_evidence"]
                ):
                    errors.append(f"{sensor}: delivered != written + dropped + queued")
    return {
        "file_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "file_bytes": path.stat().st_size,
        "topics": sorted(topics_seen),
        "recording_ids": len(recording_ids),
        "sensors": per,
        "errors": errors,
        "ok": not errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mcap", type=Path)
    parser.add_argument("--metadata", type=Path)
    parser.add_argument(
        "--require-both",
        action="store_true",
        help="fail unless both sensors have messages",
    )
    args = parser.parse_args()
    result = verify(args.mcap, args.metadata)
    if args.require_both and any(
        s["messages"] == 0 for s in result["sensors"].values()
    ):
        result["errors"].append("a required sensor has no messages")
        result["ok"] = False
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
