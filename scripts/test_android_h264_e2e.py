#!/usr/bin/env python3
"""Run the actual Stera recorder H.264 path on an explicitly selected emulator, then validate every take.

Source scripts/env.sh first and start the AR emulator (scripts/start_capture_emulator.sh --ar -no-window).
Only an ``emulator-NNNN`` serial of a dedicated single-user emulator is accepted; every app mutation is scoped to
its verified user 0 through scripts/android_personal_device.py. No physical device, paid service or upload is used.

Outputs (instrumentation log, receipts, pulled MCAPs, validator receipt, tested APK) go to a new ignored directory
under artifacts/android-h264-e2e/. The validator is scripts/validate_h264_capture.py, run with the contract's pinned
readers through ``uv``.
"""

from __future__ import annotations

import argparse
import json
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
    for name in ("h264-lifecycle-result.json", "h264-failure-result.json"):
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
    if not re.search(r"OK \(2 tests\)", log) or "FAILURES!!!" in log:
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
    depth_take = [
        t["directory"]
        for t in receipts["h264-lifecycle-result.json"]["takes"]
        if t["label"] == "depth_requested_declared"
    ]
    depth_run = subprocess.run(
        [
            "uv", "run", "-q", "--no-project", "--with", "mcap==1.6.0", "python", "-I",
            str(ROOT / "scripts/check_depth_declaration.py"),
            *map(str, mcaps(depth_take)),
        ],
        capture_output=True,
        text=True,
    )
    (output / "depth-declaration.json").write_text(depth_run.stdout)
    if depth_run.returncode != 0:
        raise RuntimeError(f"Depth declaration check failed: {depth_run.stderr[-1500:]}")
    startup_run = subprocess.run(
        VALIDATOR
        + ["--profile", "h264_mcap_simulation_v1", *map(str, mcaps([startup]))],
        capture_output=True,
        text=True,
    )
    (output / "validator-startup-failure.json").write_text(startup_run.stdout)
    receipt = {
        "status": "passed_native_controller_emulator",
        "emulator": args.serial,
        "personalUser": 0,
        "install": install,
        "instrumentation": receipts,
        "validation": results,
        "depth_declaration": json.loads(depth_run.stdout),
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
