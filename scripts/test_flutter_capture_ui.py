#!/usr/bin/env python3
"""Build and run the real Flutter capture UI on one verified emulator user.

No flutter/Gradle device installer or ADB default target is used. The test app
and instrumentation use isolated package IDs; all installs, grants and stops
explicitly select the emulator's verified personal full user0. Source env.sh.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

from android_personal_device import PersonalDevice, SafetyError, apk_package, find_aapt2

ROOT = Path(__file__).resolve().parents[1]
APP = "ai.stateaction.capture.integration"
TEST = APP + ".test"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_private(device: PersonalDevice, filename: str) -> bytes | None:
    result = subprocess.run(device.prefix + ["exec-out", "run-as", APP, "--user", "0", "cat", "files/" + filename],
                            capture_output=True, timeout=10)
    if result.returncode != 0:
        return None
    # adb exec-out may return zero even when the remote cat reports a missing
    # file; only a complete JSON object is usable screen/result telemetry.
    try:
        if not isinstance(json.loads(result.stdout), dict):
            return None
    except ValueError:
        return None
    return result.stdout


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", default="emulator-5582")
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"emulator-\d+", args.serial):
        raise SafetyError("Only an explicit emulator serial is permitted")
    device = PersonalDevice(args.serial, 0)
    if device.adb("shell", "getprop", "ro.kernel.qemu", operation="Emulator verification") != "1":
        raise SafetyError("Selected device is not an emulator")
    users = device.inventory()
    if len(users) != 1 or users[0].user_type != "full.SYSTEM" or users[0].user_id != 0:
        raise SafetyError("A dedicated single-user emulator is required")
    run = ROOT / "artifacts/flutter-ui-e2e" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run.mkdir(parents=True, exist_ok=False)
    if not args.skip_build:
        defines = ",".join(base64.b64encode(value.encode()).decode() for value in
                           ["STATEACTION_RGB_CODEC=h264", "STATEACTION_H264_SIMULATION=true"])
        command = ["./gradlew", ":app:assembleDebug", ":app:assembleDebugAndroidTest",
                   "-PstateactionUiIntegration=true", "-Ptarget-platform=android-x64",
                   "-Ptarget=" + str(ROOT / "apps/mobile/integration_test/capture_ui_test.dart"),
                   "-Pdart-defines=" + defines, "--console=plain"]
        with (run / "build.log").open("w") as log:
            subprocess.run(command, cwd=ROOT / "apps/mobile/android", stdout=log,
                           stderr=subprocess.STDOUT, check=True)
    packages = [(APP, ROOT / "apps/mobile/build/app/outputs/apk/debug/app-debug.apk"),
                (TEST, ROOT / "apps/mobile/build/app/outputs/apk/androidTest/debug/app-debug-androidTest.apk")]
    sealed = []
    for package, apk in packages:
        if apk_package(apk, find_aapt2(None), subprocess.run) != package:
            raise SafetyError("APK package does not match the isolated UI test target")
        target = run / (package + ".apk")
        shutil.copyfile(apk, target)
        device.operate("install", package, ["install", "--user", "0", "-r", "-t", str(target)])
        sealed.append({"package": package, "bytes": target.stat().st_size, "sha256": digest(target)})
    device.operate("grant", APP, ["shell", "pm", "grant", "--user", "0", APP, "android.permission.CAMERA"])
    old_result = read_private(device, "flutter-ui-result.json")
    old_stage = read_private(device, "flutter-ui-stage.json")
    old_run_id = json.loads(old_stage).get("run_id") if old_stage else None
    run_id = None
    seen = set()
    with (run / "instrumentation.log").open("wb") as log:
        command = device.prefix + ["shell", "am", "instrument", "--user", "0", "-w", "-r", "-e", "class",
            "open.fpvlabs.stera.CaptureUiIntegrationTest", TEST + "/androidx.test.runner.AndroidJUnitRunner"]
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 420
        try:
            while process.poll() is None and time.monotonic() < deadline:
                raw = read_private(device, "flutter-ui-stage.json")
                if raw:
                    message = json.loads(raw)
                    stage = message["stage"]
                    candidate = message.get("run_id")
                    if run_id is None and stage == "capture_home" and candidate != old_run_id:
                        if isinstance(candidate, str) and re.fullmatch(r"[0-9]+", candidate):
                            run_id = candidate
                    if run_id is not None and candidate == run_id and re.fullmatch(r"[a-z0-9_]+", stage) and stage not in seen:
                        screenshot = subprocess.run(device.prefix + ["exec-out", "screencap", "-p"],
                                                    capture_output=True, check=True, timeout=10).stdout
                        (run / (stage + ".png")).write_bytes(screenshot)
                        device.adb("shell", "run-as", APP, "--user", "0", "touch",
                                   f"files/flutter-ui-ack-{run_id}-{stage}", operation="Acknowledge emulator test screenshot")
                        seen.add(stage)
                time.sleep(0.3)
            if process.poll() is None:
                raise TimeoutError("Flutter UI instrumentation timed out; inspect local evidence")
        finally:
            if process.poll() is None:
                device.operate("force-stop", APP, ["shell", "am", "force-stop", "--user", "0", APP])
                process.terminate()
                process.wait(timeout=15)
    for package, _ in packages:
        device.scope(package)
    diagnostics = device.adb("logcat", "-d", "-v", "threadtime", "flutter:I", "System.out:I", "AndroidRuntime:E", "*:S",
                             operation="Read emulator-only test diagnostics")
    (run / "app.log").write_text(diagnostics + "\n")
    result = read_private(device, "flutter-ui-result.json")
    if result:
        (run / "flutter-result.json").write_bytes(result)
    log = (run / "instrumentation.log").read_text(errors="replace")
    if result == old_result or not result:
        raise RuntimeError(f"No fresh Flutter test receipt: inspect {run}")
    parsed = json.loads(result)
    if parsed.get("run_id") != run_id or set(parsed.get("stages", [])) != seen:
        raise RuntimeError(f"Missing fresh screen evidence: inspect {run}")
    if parsed["status"] != "passed" or not re.search(r"OK \([1-9][0-9]* tests?\)", log) or "FAILURES!!!" in log:
        raise RuntimeError(f"Actual Flutter UI test failed: inspect {run}")
    for output in parsed["outputs"]:
        name = output["directory"]
        if not re.fullmatch(r"session_\d{8}_\d{6}_\d{3}_[0-9a-f]{8}", name):
            raise SafetyError("Unexpected recording identity in test result")
        subprocess.run(device.prefix + ["pull", f"/sdcard/Android/data/{APP}/files/ar_sessions/{name}", str(run / name)],
                       check=True, capture_output=True)
    receipt = {"status": "passed_actual_flutter_ui_emulator", "emulator": args.serial, "personal_user": 0,
               "isolated_packages": sealed, "screenshots": sorted(seen), "flutter": parsed,
               "physical_devices_touched": False, "hardware_qualified": False,
               "paid_resources_created": False}
    (run / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"status": receipt["status"], "output": str(run)}))


if __name__ == "__main__":
    main()
