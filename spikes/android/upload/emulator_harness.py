#!/usr/bin/env python3
"""Reproducible EMULATOR-ONLY run of the SA-62 native upload spike against the local fixture.

Refuses every serial that is not an Android emulator, verifies the personal full user with the
repository's guarded helper, scopes all app mutations to that verified user and never touches a
physical phone, company profile or the production collector. Fixture auth/provider are simulated;
nothing here qualifies Google, Better Auth, R2 or a physical device.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from android_personal_device import PersonalDevice, SafetyError  # noqa: E402

PACKAGE = "ai.stateaction.spike.upload"
TEST_PACKAGE = PACKAGE + ".test"
EMULATOR_SERIAL = re.compile(r"emulator-\d+")
APP_APK = HERE / "app/build/outputs/apk/debug/app-debug.apk"
TEST_APK = HERE / "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
SOURCE_BYTES = 2 * 64 * 1024 * 1024 + 12345


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Fixture:
    def __init__(self, directory: Path, **environment: str) -> None:
        self.port = free_port()
        self.directory = directory
        env = {
            "PATH": subprocess.os.environ["PATH"],
            "SPIKE_DATA_DIR": str(directory),
            "PORT": str(self.port),
            **environment,
        }
        self.process = subprocess.Popen(
            ["node", "--experimental-strip-types", str(HERE / "fixture.ts")],
            env=env,
            stdout=subprocess.PIPE,
            text=True,
        )
        assert self.process.stdout is not None
        json.loads(self.process.stdout.readline())  # listening banner

    def health(self) -> dict:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}/health", timeout=10
        ) as response:
            return json.load(response)

    def state(self) -> dict:
        return json.loads((self.directory / "state.json").read_text())

    def stop(self) -> None:
        self.process.terminate()
        try:
            self.process.wait(10)
        except subprocess.TimeoutExpired:
            self.process.kill()


class Harness:
    def __init__(self, serial: str, user: int, adb: str) -> None:
        if not EMULATOR_SERIAL.fullmatch(serial):
            raise SafetyError(
                "This harness only runs on an Android emulator serial (emulator-NNNN)"
            )
        self.serial, self.user, self.adb_path = serial, user, adb
        self.device = PersonalDevice(serial, user, adb)

    def adb(self, *arguments: str, operation: str, timeout: int = 60) -> str:
        return self.device.adb(*arguments, operation=operation, timeout=timeout)

    def verify_emulator(self) -> dict:
        qemu = self.adb(
            "shell", "getprop", "ro.kernel.qemu", operation="Emulator verification"
        )
        if qemu != "1":
            raise SafetyError("Target is not an emulator; refusing")
        self.device.inventory()  # personal full current user check
        api = int(
            self.adb("shell", "getprop", "ro.build.version.sdk", operation="API level")
        )
        if api < 34:
            raise SafetyError("API 34+ emulator required")
        return {
            "serial": self.serial,
            "api": api,
            "model": self.adb(
                "shell", "getprop", "ro.product.model", operation="Model"
            ),
            "abi": self.adb("shell", "getprop", "ro.product.cpu.abi", operation="ABI"),
        }

    def install(self) -> None:
        for apk, package, flags in (
            (APP_APK, PACKAGE, []),
            (TEST_APK, TEST_PACKAGE, ["-t"]),
        ):
            command = ["install", "--user", str(self.user), "-r", *flags, str(apk)]
            self.device.operate("install", package, command)
        self.grant_notifications()

    def grant_notifications(self) -> None:
        self.device.operate(
            "grant",
            PACKAGE,
            [
                "shell",
                "pm",
                "grant",
                "--user",
                str(self.user),
                PACKAGE,
                "android.permission.POST_NOTIFICATIONS",
            ],
        )

    def reverse(self, port: int) -> None:
        self.adb(
            "reverse",
            f"tcp:{port}",
            f"tcp:{port}",
            operation="Fixture port forward",
        )

    def clear_app_data(self) -> None:
        self.device.scope(PACKAGE)
        self.adb(
            "shell",
            "pm",
            "clear",
            "--user",
            str(self.user),
            PACKAGE,
            operation="Clear spike data",
        )
        self.grant_notifications()  # pm clear also revokes runtime permissions

    def journal(self) -> dict:
        text = self.adb(
            "shell",
            "run-as",
            PACKAGE,
            "--user",
            str(self.user),
            "cat",
            "no_backup/upload-journal.json",
            operation="Read spike journal",
        )
        return json.loads(text)

    def instrument(self, fixture: Fixture, scenario: str, timeout: int) -> dict:
        self.device.scope(PACKAGE)
        output = self.adb(
            "shell",
            "am",
            "instrument",
            "--user",
            str(self.user),
            "-w",
            "-r",
            "-e",
            "fixtureUrl",
            f"http://127.0.0.1:{fixture.port}",
            "-e",
            "scenario",
            scenario,
            f"{TEST_PACKAGE}/{PACKAGE}.SpikeInstrumentation",
            operation=f"Instrumentation {scenario}",
            timeout=timeout,
        )
        values = dict(re.findall(r"INSTRUMENTATION_RESULT: (\w+)=(.*)", output))
        return {"output": values, "passed": values.get("result") == "PASS"}

    def uidt_home(self, fixture: Fixture) -> dict:
        self.device.operate(
            "start",
            PACKAGE,
            [
                "shell",
                "am",
                "start",
                "--user",
                str(self.user),
                "-n",
                f"{PACKAGE}/.MainActivity",
                "--ez",
                "spikeAuto",
                "true",
                "--ez",
                "requireCharging",
                "false",
                "--es",
                "fixtureUrl",
                f"http://127.0.0.1:{fixture.port}",
            ],
        )
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if self.journal().get("state") == "uploading":
                    break
            except (SafetyError, json.JSONDecodeError):
                pass
            time.sleep(0.5)
        else:
            raise SafetyError("UIDT never reached uploading")
        self.adb("shell", "input", "keyevent", "KEYCODE_HOME", operation="Send HOME")
        job_dump = ""
        deadline = time.time() + 300
        while time.time() < deadline:
            state = self.journal().get("state")
            if not job_dump:
                job_dump = self.adb(
                    "shell", "dumpsys", "jobscheduler", PACKAGE, operation="Job dump"
                )
            if state in ("uploaded", "attention"):
                break
            time.sleep(1)
        journal = self.journal()
        return {
            "passed": journal.get("state") == "uploaded"
            and journal.get("executionMode") == "uidt",
            "userInitiatedApproved": "userInitiatedApproved: true" in job_dump
            or "started as UIJ: true" in job_dump,
            "journalState": journal.get("state"),
            "executionMode": journal.get("executionMode"),
            "metrics": journal.get("metrics"),
            "sha256": journal.get("sha256"),
            "sizeBytes": journal.get("sizeBytes"),
        }


def run(args: argparse.Namespace) -> dict:
    harness = Harness(args.serial, args.user, args.adb)
    device = harness.verify_emulator()
    harness.install()
    scenarios: dict[str, dict] = {}
    plan = [
        ("native_engine_direct", "direct", {}, 600),
        (
            "interrupt_account_switch_resume",
            "interrupt",
            {"SPIKE_CHUNK_DELAY_MS": "12"},
            600,
        ),
        ("uidt_home", None, {"SPIKE_CHUNK_DELAY_MS": "2"}, 600),
    ]
    for name, instrument, environment, timeout in plan:
        harness.clear_app_data()
        with tempfile.TemporaryDirectory(
            prefix="stateaction-spike-fixture-"
        ) as directory:
            fixture = Fixture(Path(directory), **environment)
            try:
                harness.reverse(fixture.port)
                try:
                    result = (
                        harness.instrument(fixture, instrument, timeout)
                        if instrument
                        else harness.uidt_home(fixture)
                    )
                except SafetyError as error:
                    result = {"passed": False, "error": str(error)}
                state = fixture.state()
                counters = state["counters"]
                result.update(
                    fixtureCounters=counters,
                    fixtureUploads=[
                        {
                            "state": u["state"],
                            "sizeBytes": u["sizeBytes"],
                            "sha256": u["sha256"],
                        }
                        for u in state["uploads"].values()
                    ],
                )
                exactly_once = (
                    counters.get("api_completions") == 1
                    and counters.get("provider_puts") == 3
                )
                result["passed"] = bool(result["passed"] and exactly_once)
                result["exactlyOneCompletionThreePuts"] = exactly_once
                scenarios[name] = result
            finally:
                fixture.stop()
    return {
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "executionMode": "emulator",
        "simulated": {
            "auth": "synthetic_fixture_not_better_auth",
            "provider": "local_files_not_s3_or_r2",
        },
        "realGoogle": False,
        "realBetterAuth": False,
        "realProvider": False,
        "physicalDevice": False,
        "personalUser": args.user,
        "device": device,
        "sourceBytes": SOURCE_BYTES,
        "apks": {
            "app": {"sha256": sha256(APP_APK), "bytes": APP_APK.stat().st_size},
            "instrumentation": {
                "sha256": sha256(TEST_APK),
                "bytes": TEST_APK.stat().st_size,
            },
        },
        "scenarios": scenarios,
        "passed": all(item["passed"] for item in scenarios.values()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--serial", required=True, help="Android emulator serial, e.g. emulator-5580"
    )
    parser.add_argument(
        "--user",
        type=int,
        default=0,
        help="Verified personal full user on the emulator",
    )
    parser.add_argument("--adb", default="adb")
    parser.add_argument(
        "--output", type=Path, required=True, help="Ignored evidence JSON (not for Git)"
    )
    args = parser.parse_args()
    try:
        evidence = run(args)
    except SafetyError as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        return 2
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"passed": evidence["passed"], "output": str(args.output)}))
    return 0 if evidence["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
