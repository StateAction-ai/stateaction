#!/usr/bin/env python3
"""Run the actual Stera recorder H.264 path on an explicitly selected emulator, then validate every take.

Source scripts/env.sh first and start the AR emulator (bash scripts/supervise_capture_emulator.sh --ar -no-window).
Only an ``emulator-NNNN`` serial of a dedicated single-user emulator is accepted; every app mutation is scoped to
its verified user 0 through scripts/android_personal_device.py. No physical device, paid service or upload is used.

Outputs (instrumentation log, receipts, pulled MCAPs, validator receipt, tested APK) go to a new ignored directory
under artifacts/android-h264-e2e/. The validator is scripts/validate_h264_capture.py, run with the contract's pinned
readers through ``uv``.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from android_personal_device import PersonalDevice, SafetyError, apk_package, find_aapt2

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "open.fpvlabs.stera.ar_recorder.test"
TEST = "open.fpvlabs.stera.ar_recorder.H264RecorderLifecycleInstrumentedTest"
APK = (
    ROOT
    / "apps/mobile/build/stera_recorder/outputs/apk/androidTest/debug/stera_recorder-debug-androidTest.apk"
)
VALIDATOR = [
    "uv",
    "run",
    "-q",
    "--no-project",
    "--with",
    "mcap==1.6.0",
    "--with",
    "jsonschema==4.25.1",
    "--with",
    "protobuf==6.33.0",
    "python",
    "-I",
    str(ROOT / "scripts/validate_h264_capture.py"),
]


def emulator(serial: str) -> PersonalDevice:
    if not re.fullmatch(r"emulator-\d+", serial):
        raise SafetyError("This harness only permits an explicit emulator serial")
    device = PersonalDevice(serial, 0)
    if (
        device.adb("shell", "getprop", "ro.kernel.qemu", operation="Emulator check")
        != "1"
    ):
        raise SafetyError("The selected device is not an emulator")
    users = device.inventory()
    if len(users) != 1 or users[0].user_id != 0 or users[0].user_type != "full.SYSTEM":
        raise SafetyError("Only a dedicated single-user emulator is permitted")
    return device


def validate(files: list[Path], outcome: str, output: Path, name: str) -> dict:
    run = subprocess.run(
        VALIDATOR
        + [
            "--profile",
            "h264_mcap_simulation_v1",
            "--expect-outcome",
            outcome,
            *map(str, files),
        ],
        capture_output=True,
        text=True,
    )
    (output / f"validator-{name}.json").write_text(run.stdout)
    if run.returncode != 0:
        raise RuntimeError(
            f"Independent validation failed for {name}: {run.stdout[-1500:]}{run.stderr[-800:]}"
        )
    return json.loads(run.stdout)


def check_calibration(sessions: Path, receipt: dict, validated: dict) -> dict:
    """Independently relates the persisted calibration to the decoded MCAP of the same take (ffprobe dimensions)."""
    by_path = {Path(f["path"]).parent.name: f for f in validated["files"]}
    checked = []
    for take in receipt["takes"]:
        metadata = json.loads(
            (sessions / take["directory"] / "metadata.json").read_text()
        )
        calibration = metadata["saved_calibration"]
        decoded = by_path[take["directory"]]
        stream = decoded["decode"]["stream"]
        revision = calibration["revisions"][0]
        k = revision["intrinsics"]
        source = revision["source_intrinsics"]
        inventory = decoded["inventory_calibrations"]
        problems = []
        if calibration["state"] != "yes" or inventory[0]["state"] != "yes":
            problems.append("calibration state is not yes")
        if (calibration["encoded_width"], calibration["encoded_height"]) != (
            stream["width"],
            stream["height"],
        ):
            problems.append("persisted encoded size differs from ffprobe")
        if (k["imageWidth"], k["imageHeight"]) != (stream["width"], stream["height"]):
            problems.append("K image size differs from decoded raster")
        if not (
            0 < k["principalPointX"] < stream["width"]
            and 0 < k["principalPointY"] < stream["height"]
        ):
            problems.append("principal point outside the decoded raster")
        if (
            revision["K_3x3_row_major"][0] != k["focalLengthX"]
            or revision["P_3x4_row_major"][5] != k["focalLengthY"]
        ):
            problems.append("K/P do not match intrinsics")
        if (
            not revision["saved_raster"]["is_identity"]
            or source.keys() != k.keys()
            or any(
                not math.isclose(source[key], k[key], rel_tol=1e-7, abs_tol=1e-7)
                for key in k
            )
        ):
            problems.append(
                "source and saved calibration differ for an identity raster"
            )
        if calibration["accepted_frames"] != decoded["acquired_frames"]:
            problems.append("accepted calibration frames differ from acquired frames")
        if calibration["rejected_frames"]:
            problems.append("rejected calibration frames")
        settings = metadata["capture_settings"]
        if settings["requested"]["imu_hz"] != take["requested_imu_hz"]:
            problems.append("requested IMU rate not persisted")
        if problems:
            raise RuntimeError(
                f"Calibration cross-check failed for {take['directory']}: {problems}"
            )
        checked.append(
            {
                "directory": take["directory"],
                "ffprobe_size": [stream["width"], stream["height"]],
                "K": k,
                "pose_events": decoded["pose_events"],
                "tracking_states": decoded["tracking_states"],
                "motion_events": decoded["close"]["motion_events"],
                "capture_settings": settings,
                "pose_missing_but_rgb_continued": decoded["pose_events"][
                    "invalid_with_written_rgb"
                ]
                > 0,
            }
        )
    if not any(
        f["pose_events"]["invalid_with_written_rgb"] for f in validated["files"]
    ):
        raise RuntimeError("No written RGB frame was associated with an invalid pose")
    return {"takes": checked}


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--serial", default="emulator-5582")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    device = emulator(args.serial)
    output = (
        args.output
        or ROOT
        / "artifacts/android-h264-e2e"
        / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    ).resolve()
    output.relative_to(ROOT / "artifacts")
    output.mkdir(parents=True, exist_ok=False)
    if not args.skip_build:
        with (output / "build.log").open("w") as log:
            subprocess.run(
                [
                    "./gradlew",
                    ":stera_recorder:assembleDebugAndroidTest",
                    "--no-daemon",
                    "--max-workers=2",
                    "--console=plain",
                ],
                cwd=ROOT / "apps/mobile/android",
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
            )
    if apk_package(APK, find_aapt2(None), subprocess.run) != PACKAGE:
        raise SafetyError(
            "Instrumentation APK package does not match the isolated test package"
        )
    shutil.copyfile(APK, output / "tested-instrumentation.apk")
    install = device.operate(
        "install", PACKAGE, ["install", "--user", "0", "-r", "-t", str(APK)]
    )
    device.operate(
        "grant",
        PACKAGE,
        ["shell", "pm", "grant", "--user", "0", PACKAGE, "android.permission.CAMERA"],
    )
    device.adb(
        "shell",
        "rm",
        "-rf",
        f"/sdcard/Android/data/{PACKAGE}/files/ar_sessions",
        operation="Clear prior emulator test sessions",
    )
    device.adb("logcat", "-c", operation="Clear emulator log")
    log = device.adb(
        "shell",
        "am",
        "instrument",
        "--user",
        "0",
        "-w",
        "-r",
        "-e",
        "class",
        TEST,
        PACKAGE + "/androidx.test.runner.AndroidJUnitRunner",
        operation="Scoped emulator instrumentation",
        timeout=420,
    )
    device.scope(PACKAGE)
    (output / "instrumentation.log").write_text(log + "\n")
    (output / "recorder.log").write_text(
        device.adb(
            "logcat",
            "-d",
            "-v",
            "threadtime",
            "System.out:I",
            "SteraCapture:E",
            "AndroidRuntime:E",
            "*:S",
            operation="Read emulator recorder diagnostics",
        )
        + "\n"
    )
    receipts = {}
    for name in (
        "h264-lifecycle-result.json",
        "h264-failure-result.json",
        "h264-calibration-result.json",
    ):
        text = device.adb(
            "exec-out",
            "run-as",
            PACKAGE,
            "--user",
            "0",
            "cat",
            f"files/{name}",
            operation="Read test receipt",
        )
        (output / name).write_text(text + "\n")
        receipts[name] = json.loads(text)
    if not re.search(r"OK \(3 tests\)", log) or "FAILURES!!!" in log:
        raise RuntimeError(
            f"Actual recorder instrumentation failed; inspect {output / 'instrumentation.log'}"
        )
    subprocess.run(
        device.prefix
        + [
            "pull",
            f"/sdcard/Android/data/{PACKAGE}/files/ar_sessions",
            str(output / "sessions"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    sessions = output / "sessions"

    def mcaps(directories: list[str]) -> list[Path]:
        return [next((sessions / d).glob("*.mcap")) for d in directories]

    completed = [t["directory"] for r in receipts.values() for t in r["takes"]]
    failed = [receipts["h264-failure-result.json"]["writer_failure_directory"]]
    startup = Path(
        receipts["h264-failure-result.json"]["startup_failure_mcap"]
    ).parent.name
    results = {
        "completed": validate(mcaps(completed), "completed", output, "completed"),
        "writer_failure": validate(mcaps(failed), "failed", output, "writer-failure"),
    }
    startup_run = subprocess.run(
        VALIDATOR
        + ["--profile", "h264_mcap_simulation_v1", *map(str, mcaps([startup]))],
        capture_output=True,
        text=True,
    )
    (output / "validator-startup-failure.json").write_text(startup_run.stdout)
    calibration = check_calibration(
        sessions, receipts["h264-calibration-result.json"], results["completed"]
    )
    receipt = {
        "status": "passed_native_controller_emulator",
        "calibration_cross_check": calibration,
        "emulator": args.serial,
        "personalUser": 0,
        "install": install,
        "instrumentation": receipts,
        "validation": results,
        "startup_failure_container": json.loads(startup_run.stdout)["files"][0],
        "output": str(output),
        "physical_device_touched": False,
        "hardware_qualified": False,
    }
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(
        json.dumps(
            {
                "status": receipt["status"],
                "output": str(output),
                "completed_takes": len(completed),
                "failed_takes": len(failed),
            }
        )
    )


if __name__ == "__main__":
    main()
