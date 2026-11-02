#!/usr/bin/env python3
"""SA-55: check that H.264 takes declare depth explicitly in the Inventory and never carry a depth payload.

Usage: check_depth_declaration.py <take.mcap>... . Run with ``uv run --no-project --with mcap==1.6.0 python -I``.
Emulator output is simulation evidence only; this proves declarations, not depth quality or physical support.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from mcap.reader import make_reader

ALLOWED_REASONS = {
    None,
    "device_reports_unsupported",
    "depth_payload_not_in_contract_revision",
}


def check(path: Path) -> dict:
    inventory = None
    topics = set()
    with path.open("rb") as handle:
        reader = make_reader(handle)
        for _schema, channel, message in reader.iter_messages():
            topics.add(channel.topic)
            if channel.topic == "/stateaction/inventory":
                inventory = json.loads(message.data)
    assert inventory is not None, f"{path}: no inventory"
    sensors = {s["sensor_id"]: s for s in inventory["sensors"]}
    depth = sensors.get("depth")
    assert depth is not None, f"{path}: depth entry omitted from inventory"
    assert depth["enabled"] == "no" and depth["observed"] == "no", depth
    assert depth["observed_count"] is None and depth.get("native_clock_id") is None, depth
    assert depth.get("unavailable_reason") in ALLOWED_REASONS, depth
    assert depth["requested"] in {"yes", "no"} and depth["supported"] in {"yes", "no"}, depth
    if depth["requested"] == "yes":
        assert depth.get("unavailable_reason") is not None, "requested depth needs a reason"
    assert not [t for t in topics if "depth" in t], f"unexpected depth channel: {topics}"
    assert sensors["rgb"]["observed"] == "yes" and sensors["rgb"]["observed_count"] not in (None, "0")
    for imu in ("accel", "gyro"):
        assert imu in sensors, f"{imu} missing"
    return {
        "file": path.name,
        "depth": depth,
        "rgb_observed_count": sensors["rgb"]["observed_count"],
        "imu": {k: sensors[k]["observed"] for k in ("accel", "gyro")},
    }


if __name__ == "__main__":
    print(json.dumps([check(Path(p)) for p in sys.argv[1:]], indent=2))
