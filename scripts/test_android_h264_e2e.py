#!/usr/bin/env python3
"""Exercise the actual Stera recorder on an explicitly selected emulator only.

Source scripts/env.sh first. No physical serial, ADB default target, unscoped
app mutation, standalone capture activity or paid service is used.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import subprocess

from android_personal_device import PersonalDevice, SafetyError, apk_package, find_aapt2

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "open.fpvlabs.stera.ar_recorder.test"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", default="emulator-5582")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"emulator-\d+", args.serial):
        raise SafetyError("This harness only permits an explicit emulator serial")
    device = PersonalDevice(args.serial, 0)
    if device.adb("shell", "getprop", "ro.kernel.qemu", operation="Emulator check") != "1":
        raise SafetyError("The selected device is not an emulator")
    users = device.inventory()
    if len(users) != 1 or users[0].user_id != 0 or users[0].user_type != "full.SYSTEM":
        raise SafetyError("Only a dedicated single-user emulator is permitted")
    output = (args.output or ROOT / "artifacts/android-h264-e2e" /
              datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")).resolve()
    output.relative_to(ROOT / "artifacts")
    output.mkdir(parents=True, exist_ok=False)
    if not args.skip_build:
        with (output / "build.log").open("w") as log:
            subprocess.run(["./gradlew", ":stera_recorder:testDebugUnitTest",
                            ":stera_recorder:assembleDebugAndroidTest", "--console=plain"],
                           cwd=ROOT / "apps/mobile/android", stdout=log, stderr=subprocess.STDOUT, check=True)
    apk = ROOT / "apps/mobile/build/stera_recorder/outputs/apk/androidTest/debug/stera_recorder-debug-androidTest.apk"
    if apk_package(apk, find_aapt2(None), subprocess.run) != PACKAGE:
        raise SafetyError("Instrumentation APK package does not match the isolated test package")
    shutil.copyfile(apk, output / "tested-instrumentation.apk")
    install = device.operate("install", PACKAGE, ["install", "--user", "0", "-r", "-t", str(apk)])
    device.operate("grant", PACKAGE, ["shell", "pm", "grant", "--user", "0", PACKAGE, "android.permission.CAMERA"])
    device.scope(PACKAGE)
    log = device.adb("shell", "am", "instrument", "--user", "0", "-w", "-r", "-e", "class",
                     "open.fpvlabs.stera.ar_recorder.H264RecorderLifecycleInstrumentedTest",
                     PACKAGE + "/androidx.test.runner.AndroidJUnitRunner", operation="Scoped emulator instrumentation", timeout=240)
    device.scope(PACKAGE)
    (output / "instrumentation.log").write_text(log + "\n")
    diagnostics = device.adb("logcat", "-d", "-v", "threadtime", "System.out:I", "AndroidRuntime:E", "*:S",
                             operation="Read emulator-only recorder diagnostics")
    (output / "recorder.log").write_text(diagnostics + "\n")
    if not re.search(r"OK \(2 tests\)", log) or "FAILURES!!!" in log:
        raise RuntimeError(f"Actual recorder instrumentation failed; inspect {output / 'instrumentation.log'}")
    result = device.adb("exec-out", "run-as", PACKAGE, "--user", "0", "cat", "files/h264-lifecycle-result.json",
                        operation="Read exact test receipt")
    (output / "native-result.json").write_text(result + "\n")
    failures = device.adb("exec-out", "run-as", PACKAGE, "--user", "0", "cat", "files/h264-failure-result.json",
                          operation="Read exact injected-failure receipt")
    (output / "failure-result.json").write_text(failures + "\n")
    if json.loads(result).get("status") != "passed" or json.loads(failures).get("status") != "passed":
        raise RuntimeError("Both actual-controller receipts must explicitly report passed")
    subprocess.run(device.prefix + ["pull", f"/sdcard/Android/data/{PACKAGE}/files/ar_sessions", str(output / "sessions")],
                   check=True, capture_output=True, text=True)
    receipt = {"status": "passed_native_controller_emulator", "personalUser": 0, "emulator": args.serial,
               "install": install, "native": json.loads(result), "failureTests": json.loads(failures), "output": str(output),
               "physical_device_touched": False, "hardware_qualified": False}
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"status": receipt["status"], "output": str(output)}))


if __name__ == "__main__":
    main()
