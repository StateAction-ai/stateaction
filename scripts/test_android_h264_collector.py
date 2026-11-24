#!/usr/bin/env python3
"""Run the no-auth H.264 Flutter collector on the guarded ARCore emulator."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from zipfile import ZipFile

from android_personal_device import SafetyError, apk_package, find_aapt2
from test_android_h264_e2e import VALIDATOR, emulator
from test_android_joined_app_e2e import ACTIVITY, PACKAGE, ROOT, SESSIONS, Ui


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--serial", default="emulator-5582")
    args = parser.parse_args()

    device = emulator(args.serial)
    subprocess.run(
        [
            "bash",
            str(ROOT / "scripts/start_capture_emulator.sh"),
            "--ar",
            "--verify-only",
        ],
        cwd=ROOT,
        check=True,
    )
    if apk_package(args.apk, find_aapt2(None), subprocess.run) != PACKAGE:
        raise SafetyError("Expected the isolated ai.stateaction.collector.dev APK")
    with ZipFile(args.apk) as bundle:
        if bundle.read("assets/flutter_assets/.env").strip() != b"NO_AUTH_MODE=true":
            raise SafetyError("Expected a NO_AUTH_MODE=true-only asset")

    out = (
        ROOT / "artifacts/sa59-collector" / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    )
    out.mkdir(parents=True)
    ui = Ui(device)

    def sessions() -> set[str]:
        listing = device.adb(
            "shell",
            f"if [ -d {SESSIONS} ]; then ls {SESSIONS}; fi",
            operation="List capture sessions",
        )
        return {
            name
            for name in listing.splitlines()
            if re.fullmatch(r"session_[\w]+", name)
        }

    device.operate("install", PACKAGE, ["install", "--user", "0", "-r", str(args.apk)])
    for permission in ("CAMERA", "RECORD_AUDIO"):
        device.operate(
            "grant",
            PACKAGE,
            [
                "shell",
                "pm",
                "grant",
                "--user",
                "0",
                PACKAGE,
                f"android.permission.{permission}",
            ],
        )
    device.operate(
        "launch", PACKAGE, ["shell", "am", "start", "--user", "0", "-n", ACTIVITY]
    )
    ui.wait("Recordings", 45)
    before = sessions()
    ui.tap("Start Recording")
    ui.wait("TRACKING", 45)
    ui.tap("Start Recording")
    ui.wait("Stop", 20)
    ui.wait(
        "s",
        20,
        where=lambda node: re.fullmatch(r"(?:[4-9]|[1-9][0-9])s", Ui.label(node)),
    )
    ui.tap("Stop")
    ui.wait("Recordings", 60)
    new = sessions() - before
    if len(new) != 1:
        raise RuntimeError(f"Expected exactly one new recording, found {len(new)}")
    session = new.pop()
    subprocess.run(
        device.prefix + ["pull", f"{SESSIONS}/{session}", str(out / session)],
        check=True,
        capture_output=True,
    )
    (mcap,) = (out / session).glob("*.mcap")
    with (out / "receipt.json").open("w") as receipt:
        subprocess.run(
            VALIDATOR
            + [
                "--profile",
                "h264_mcap_simulation_v1",
                "--check-sidecar",
                str(mcap),
            ],
            check=True,
            stdout=receipt,
        )
    facts = json.loads((out / "receipt.json").read_text())["files"][0]
    with args.apk.open("rb") as source:
        apk_hash = hashlib.file_digest(source, "sha256").hexdigest()
    print(
        json.dumps(
            {
                "video_messages": facts["video_messages"],
                "encoder": facts["encoder"]["name"],
                "hardware_qualified": False,
                "apk_sha256": apk_hash,
                "receipt": str(out / "receipt.json"),
            }
        )
    )


if __name__ == "__main__":
    main()
