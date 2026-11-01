#!/usr/bin/env python3
"""Read real recorder emulator outputs through the local CPU processing adapter.

Use the pinned processing Python environment. Every raw output stays under
ignored artifacts. A compact safe summary may be copied to docs/validation.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "spikes/android/processing"))
from spike import digest, dump, process, read_access_units, InvalidCapture


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path, help="Successful native controller test artifact directory")
    parser.add_argument("output", type=Path, help="New ignored processing artifact directory")
    args = parser.parse_args()
    capture = args.capture.resolve()
    capture.relative_to(ROOT / "artifacts")
    output = args.output.resolve()
    output.relative_to(ROOT / "spikes/android/processing/artifacts")
    native = json.loads((capture / "native-result.json").read_text())
    assert native["status"] == "passed" and native["cancel_deleted_session"]
    assert len(native["takes"]) == 3
    output.mkdir(parents=True, exist_ok=False)
    results = []
    for index, take in enumerate(native["takes"]):
        directory = capture / "sessions" / Path(take["outputDirectory"]).name
        sources = list(directory.glob("*.mcap"))
        assert len(sources) == 1
        source = sources[0]
        try:
            list(read_access_units(source, {}))
        except InvalidCapture as error:
            assert "simulation_profile_requires_explicit_opt_in" in str(error), str(error)
        else:
            raise AssertionError("Simulation recording was admitted without explicit opt-in")
        result = process(source, output / f"take-{index}", max_clip_seconds=2.5,
                         expected_sha256=digest(source), allow_simulation_profile=True)
        assert result["frames"] == take["framesRecorded"]
        assert result["profile"]["production_qualified"] is False
        assert "/camera/rgb/compressed" not in result["channels"], "JPEG messages leaked into H264 path"
        assert result["channels"].get("/stateaction/imu/accel", 0) > 0
        assert result["channels"].get("/stateaction/imu/gyro", 0) > 0
        assert all(c["decoded_mp4_pts_exact"] and c["decoded_mp4_pixels_exact"] and
                   c["encoded_mp4_vcl_nals_exact"] for c in result["clips"])
        results.append(result)
    safe = {"status": "passed_existing_recorder_emulator_cpu_pipeline", "takes": results,
            "physical_device_touched": False, "paid_resources_created": False,
            "hardware_qualified": False, "cross_sensor_clock_mapping_qualified": False,
            "flutter_ui_qualified": False}
    dump(output / "e2e-result.json", safe)
    print(json.dumps({"status": safe["status"], "frames": [r["frames"] for r in results],
                      "receipt": str(output / "e2e-result.json")}))


if __name__ == "__main__":
    main()
