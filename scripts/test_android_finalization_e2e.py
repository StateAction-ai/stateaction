#!/usr/bin/env python3
"""SA-56 finalization proof on the actual Stera recorder (ArRecorderImpl/ARCore/MediaCodec) on an emulator.

Stages (each its own ``am instrument`` run of FinalizationLifecycleInstrumentedTest):
  reasoned   low-storage / critical-heat controlled stops close cleanly as ``interrupted``
  phases     a stop that dies at each journaled phase stays recovery-required; reopen works
  crash      the OS process is halted mid-capture (genuine unclosed container)
  reopen     a fresh process quarantines the dead take, salvages by byte copy, records anew

Then every pulled container is validated independently (official ``mcap`` reader + the SA-50 reference checker
through scripts/validate_h264_capture.py). Emulator serial only, user 0 only, never a physical device.
Use the verified accelerated emulator (scripts/start_capture_emulator.sh --ar --verify-only).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from android_personal_device import SafetyError, apk_package, find_aapt2
from test_android_h264_e2e import APK, PACKAGE, ROOT, emulator, validate

TEST = "open.fpvlabs.stera.ar_recorder.FinalizationLifecycleInstrumentedTest"
RUNNER = PACKAGE + "/androidx.test.runner.AndroidJUnitRunner"
READER_CHECK = (
    "import sys\n"
    "from mcap.reader import make_reader\n"
    "p=sys.argv[1]\n"
    "try:\n"
    "    s=make_reader(open(p,'rb')).get_summary()\n"
    "    print('closed' if s is not None and s.statistics is not None else 'unclosed')\n"
    "except Exception as e:\n"
    "    print('unclosed:'+type(e).__name__)\n"
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
        / "artifacts/android-finalization-e2e"
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

    logs = {}
    for stage, method, tolerate_crash in (
        ("reasoned", "reasonedStopsCloseCleanlyAndStayInterrupted", False),
        (
            "phases",
            "stopFaultsAtEveryPhaseStayRecoveryRequiredAndReopenSucceeds",
            False,
        ),
        ("crash", "crashDuringCapture", True),
        ("reopen", "reopenAfterCrashQuarantinesSalvagesAndRecordsAgain", False),
    ):
        text = device.adb(
            "shell",
            "am",
            "instrument",
            "--user",
            "0",
            "-w",
            "-r",
            "-e",
            "class",
            f"{TEST}#{method}",
            RUNNER,
            operation=f"Scoped emulator instrumentation: {stage}",
            timeout=420,
        )
        (output / f"instrumentation-{stage}.log").write_text(text + "\n")
        logs[stage] = text
        ok = re.search(r"OK \(1 test\)", text) is not None and "FAILURES!!!" not in text
        if tolerate_crash:
            if ok:
                raise RuntimeError(
                    "The crash stage must kill the process; it returned normally"
                )
        elif not ok:
            raise RuntimeError(
                f"Stage {stage} failed; inspect {output / f'instrumentation-{stage}.log'}"
            )
    device.scope(PACKAGE)
    (output / "recorder.log").write_text(
        device.adb(
            "logcat",
            "-d",
            "-v",
            "threadtime",
            "System.out:I",
            "AndroidRuntime:E",
            "*:S",
            operation="Read emulator recorder diagnostics",
        )
        + "\n"
    )

    receipts = {}
    for name in (
        "finalization-reasoned-stops.json",
        "finalization-phase-faults.json",
        "finalization-crash-target.json",
        "finalization-crash-reopen.json",
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

    def mcap(directory: str) -> Path:
        return next((sessions / directory).glob("*.mcap"))

    interrupted = [
        t["directory"] for t in receipts["finalization-reasoned-stops.json"]["takes"]
    ]
    completed = [
        p["reopen_take"] for p in receipts["finalization-phase-faults.json"]["phases"]
    ]
    completed.append(receipts["finalization-crash-reopen.json"]["reopen_take"])
    validation = {
        "interrupted_aborted_with_reason": validate(
            [mcap(d) for d in interrupted], "aborted", output, "interrupted"
        ),
        "completed_reopen_takes": validate(
            [mcap(d) for d in completed], "completed", output, "completed"
        ),
    }
    reopen = receipts["finalization-crash-reopen.json"]
    dead = sessions / reopen["dead_session"]
    check = subprocess.run(
        [
            "uv",
            "run",
            "-q",
            "--no-project",
            "--with",
            "mcap==1.6.0",
            "python",
            "-I",
            "-c",
            READER_CHECK,
            str(next(dead.glob("*.mcap"))),
        ],
        capture_output=True,
        text=True,
    )
    state = check.stdout.strip()
    if not state.startswith("unclosed"):
        raise RuntimeError(
            f"Crashed original was not an unclosed container: {state} {check.stderr[-300:]}"
        )
    original_hashes = reopen["original_hashes"]
    for name, digest in original_hashes.items():
        if sha256(dead / name) != digest:
            raise RuntimeError(f"Original {name} differs from its pre-reopen hash")
    salvage = sessions / reopen["salvage_directory"]
    manifest = json.loads((salvage / "salvage_manifest.json").read_text())
    if (
        manifest["auto_admit"]
        or manifest["derived_recording_id"] == reopen["original_recording_id"]
    ):
        raise RuntimeError(
            "Salvage must derive a new identity and refuse automatic admission"
        )
    for name, digest in original_hashes.items():
        if sha256(salvage / name) != digest:
            raise RuntimeError(
                f"Salvage copy of {name} differs from the original bytes"
            )
    marker = json.loads((dead / "recovery_required.json").read_text())
    quarantined = {
        "directory": dead.name,
        "mcap_reader_state": state,
        "marker": marker,
        "salvage_manifest": {
            k: manifest[k]
            for k in (
                "derived_recording_id",
                "derivation",
                "capture_outcome",
                "auto_admit",
            )
        },
    }
    receipt = {
        "status": "passed_actual_recorder_emulator_finalization",
        "emulator": args.serial,
        "personalUser": 0,
        "install": install,
        "stages": list(logs),
        "instrumentation": receipts,
        "validation": validation,
        "quarantined_crash": quarantined,
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
                "interrupted": len(interrupted),
                "completed": len(completed),
            }
        )
    )


if __name__ == "__main__":
    main()
