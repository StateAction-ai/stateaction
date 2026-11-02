#!/usr/bin/env python3
"""Run the SA-60 spike's real recording classes on a dedicated emulator and verify the MCAP.

Emulator only. The serial must be ``emulator-NNNN`` with ``ro.kernel.qemu=1`` and a verified
current personal full user; every package mutation goes through ``scripts/android_personal_device.py``
and carries an explicit ``--user``. A physical phone is refused by construction.

Usage (after ``source scripts/env.sh`` and ``scripts/start_capture_emulator.sh --ar -no-window``)::

    python3 spikes/android/capture/harness/run_emulator_qualification.py --serial emulator-5582 --user 0 --build
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPIKE = HERE.parent
ROOT = SPIKE.parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(HERE))

import capture_verify  # noqa: E402
from android_personal_device import PersonalDevice, SafetyError  # noqa: E402

APP = "ai.stateaction.spike.capture"
TEST = f"{APP}.test"
TEST_CLASS = f"{APP}.EmulatorMcapPathTest"
APK = SPIKE / "app/build/outputs/apk/debug/app-debug.apk"
TEST_APK = SPIKE / "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
EMULATOR = re.compile(r"emulator-\d{4}")
REMOTE = "files/simulation-mcap"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_digest() -> str:
    """Digest of tracked and untracked-unignored spike sources (names + bytes)."""
    names = (
        subprocess.check_output(
            [
                "git",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                "spikes/android/capture/app/src",
                "spikes/android/capture/harness",
                "spikes/android/capture/build.gradle.kts",
                "spikes/android/capture/settings.gradle.kts",
            ],
            cwd=ROOT,
        )
        .decode()
        .split("\0")
    )
    digest = hashlib.sha256()
    for name in sorted(n for n in names if n and (ROOT / n).is_file()):
        digest.update(name.encode() + b"\0" + (ROOT / name).read_bytes() + b"\0")
    return digest.hexdigest()


class Qualification:
    def __init__(self, serial: str, user: int, adb: str = "adb", runner=subprocess.run):
        if not EMULATOR.fullmatch(serial):
            raise SafetyError(
                "Only a dedicated emulator-NNNN serial may run this harness"
            )
        self.serial, self.user, self.adb, self.runner = serial, user, adb, runner
        self.device = PersonalDevice(serial, user, adb, runner)

    def prop(self, name: str) -> str:
        return self.device.adb("shell", "getprop", name, operation=f"Read {name}")

    def preflight(self) -> dict[str, str]:
        if self.prop("ro.kernel.qemu") != "1":
            raise SafetyError("Target is not an emulator (ro.kernel.qemu != 1)")
        self.device.inventory()
        for package in (APP, TEST):
            self.device.scope(package)
        return {
            "avd_hardware": self.prop("ro.hardware"),
            "android_release": self.prop("ro.build.version.release"),
            "api_level": self.prop("ro.build.version.sdk"),
            "abi": self.prop("ro.product.cpu.abi"),
            "build_fingerprint": self.prop("ro.build.fingerprint"),
        }

    def install(self) -> None:
        u = str(self.user)
        self.device.operate("install", APP, ["install", "--user", u, "-r", str(APK)])
        self.device.operate(
            "install", TEST, ["install", "--user", u, "-r", "-t", str(TEST_APK)]
        )
        self.device.operate(
            "grant",
            APP,
            ["shell", "pm", "grant", "--user", u, APP, "android.permission.CAMERA"],
        )

    def instrument(self) -> str:
        out = self.device.adb(
            "shell",
            "am",
            "instrument",
            "--user",
            str(self.user),
            "-w",
            "-r",
            "-e",
            "class",
            TEST_CLASS,
            f"{TEST}/androidx.test.runner.AndroidJUnitRunner",
            operation="Emulator instrumentation",
            timeout=420,
        )
        if (
            "OK (1 test)" not in out
            or "FAILURES!!!" in out
            or "INSTRUMENTATION_FAILED" in out
        ):
            # Emulator output only: safe to surface for diagnosis.
            raise SafetyError(
                "Instrumentation did not report OK (1 test); exit status alone is insufficient:\n"
                + out[-3000:]
            )
        return "OK (1 test)"

    def pull(self, name: str) -> bytes:
        result = self.runner(
            [
                self.adb,
                "-s",
                self.serial,
                "exec-out",
                "run-as",
                APP,
                "--user",
                str(self.user),
                "cat",
                f"{REMOTE}/{name}",
            ],
            capture_output=True,
            timeout=120,
            check=False,
        )
        if result.returncode or not result.stdout:
            raise SafetyError(f"Could not pull {name} from the emulator app sandbox")
        return result.stdout


def build() -> None:
    subprocess.run(
        [
            str(SPIKE / "gradlew"),
            "-p",
            str(SPIKE),
            ":app:assembleDebug",
            ":app:assembleDebugAndroidTest",
            ":app:testDebugUnitTest",
            "--no-daemon",
            "--console=plain",
        ],
        check=True,
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--serial", required=True)
    p.add_argument("--user", required=True, type=int)
    p.add_argument(
        "--build", action="store_true", help="assemble APKs and run JVM tests first"
    )
    p.add_argument(
        "--out",
        type=Path,
        default=ROOT / "artifacts/android-capture-spike",
        help="ignored artifact directory",
    )
    p.add_argument(
        "--receipt", type=Path, help="also write the non-sensitive receipt JSON here"
    )
    args = p.parse_args(argv)
    if args.build:
        build()
    q = Qualification(args.serial, args.user)
    device = q.preflight()
    q.install()
    run_dir = args.out / time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    run_dir.mkdir(parents=True, exist_ok=False)
    try:
        outcome = q.instrument()
    except SafetyError:
        # Keep the emulator-only diagnostic report of a failed run for investigation.
        try:
            (run_dir / "instrumentation-report.json").write_bytes(q.pull("report.json"))
        except SafetyError:
            pass
        raise
    mcap = q.pull("capture.mcap")
    (run_dir / "capture.mcap").write_bytes(mcap)
    emulator_report = json.loads(q.pull("report.json"))
    (run_dir / "instrumentation-report.json").write_text(
        json.dumps(emulator_report, indent=2) + "\n"
    )
    verification = capture_verify.verify(
        mcap, "simulation", capture_verify.SECTIONS, min_sensor_events=10
    )
    (run_dir / "verification.json").write_text(
        json.dumps(verification, indent=2, sort_keys=True) + "\n"
    )
    receipt = {
        "ticket": "SA-60",
        "kind": "emulator_only_spike_class_qualification",
        "physical_hardware_qualified": False,
        "device": device,
        "instrumentation": outcome,
        "source_digest_sha256": source_digest(),
        "apk_sha256": sha256(APK),
        "test_apk_sha256": sha256(TEST_APK),
        "capture_mcap_sha256": verification["mcap"]["sha256"],
        "capture_mcap_bytes": verification["mcap"]["bytes"],
        "verifier_verdict": verification["verdict"],
        "sections": verification["sections"],
        "metrics": verification["metrics"],
        "encoder": {
            k: emulator_report.get(k)
            for k in ("sps_profile_idc", "sps_level_idc", "image_width", "image_height")
        },
        "counts": {
            k: emulator_report.get(k)
            for k in (
                "source_frames_acquired",
                "video_messages_written",
                "dropped",
                "accel_events",
                "gyro_events",
            )
        },
        "finding_camera_clock_gate": {
            "rejected_frames": emulator_report.get("clock_gate_rejection_count"),
            "meaning": "CameraTimestampGate rejected Frames whose same-Frame SENSOR_TIMESTAMP disagreed with Frame.androidCameraTimestamp (stale metadata). CaptureEngine aborts capture on this; the harness skips the frame and records it.",
        },
        "raw_artifacts": "ignored artifacts directory only; never committed",
    }
    (run_dir / "receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    )
    if args.receipt:
        args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "run_dir": str(run_dir),
                "verdict": verification["verdict"],
                "sections": verification["sections"],
            },
            indent=2,
        )
    )
    return 0 if verification["verdict"] == "pass" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SafetyError as error:
        print(f"refused: {error}", file=sys.stderr)
        raise SystemExit(2)
