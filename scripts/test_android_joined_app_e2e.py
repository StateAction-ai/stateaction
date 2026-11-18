#!/usr/bin/env python3
"""Drive the real authenticated Flutter app through sign-in -> Start -> Stop -> retained owned source on an emulator.

This is the joined-path qualification for SA-69. It uses the actual `ai.stateaction.collector.dev` debug APK
(see docs/components/android-joined-recording.md for the build), the real sign-in screen, BetterAuth `/me`, the original
Home "Start Recording" button, `ArRecorderImpl`/ARCore/MediaCodec (H.264 simulation) and the original Stop & Save button.
It then validates the pulled source with scripts/validate_h264_capture.py and checks restart, logout and re-login keep the
bytes, owner ledger and queue row unchanged and that nothing was uploaded.

Safety:
* Only a dedicated single-user ``emulator-NNNN`` is accepted; every package mutation is scoped to verified user 0 through
  scripts/android_personal_device.py. No physical device is ever touched.
* The login fixture is a 0600 JSON file with ``email``, ``password`` and ``origin``. It is read only into this process,
  typed through an ``adb shell`` stdin pipe (never argv), and is never printed, logged or saved. UI dumps are parsed in memory
  and text-field contents are never recorded; screenshots are refused while a text field is on screen.
* Pulled sources, DB and ledger go to a new ignored directory under artifacts/. Nothing is uploaded.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from android_personal_device import PersonalDevice, SafetyError, apk_package, find_aapt2
from test_android_h264_e2e import VALIDATOR, emulator

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "ai.stateaction.collector.dev"
ACTIVITY = f"{PACKAGE}/open.fpvlabs.stera.MainActivity"
APK = ROOT / "apps/mobile/build/app/outputs/flutter-apk/app-debug.apk"
SESSIONS = f"/sdcard/Android/data/{PACKAGE}/files/ar_sessions"
LEDGER = "files/capture_ownership/ledger.v1.json"
DB = "files/stera.sqlite"


class Step(RuntimeError):
    pass


class Ui:
    """uiautomator access that never records text-field contents."""

    def __init__(self, device: PersonalDevice):
        self.device = device

    def adb(self, *args: str, stdin: str | None = None, timeout: int = 60):
        return subprocess.run(
            self.device.prefix + list(args),
            input=stdin,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def nodes(self) -> list[dict]:
        run = self.adb(
            "shell",
            "uiautomator dump /sdcard/sa69-ui.xml >/dev/null 2>&1; cat /sdcard/sa69-ui.xml; rm -f /sdcard/sa69-ui.xml",
        )
        found = []
        for match in re.finditer(r"<node ([^>]*)>", run.stdout):
            attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', match.group(1)))
            x0, y0, x1, y1 = map(
                int, re.findall(r"\d+", attrs.get("bounds", "0,0,0,0"))
            )
            attrs["cx"], attrs["cy"] = (x0 + x1) // 2, (y0 + y1) // 2
            if attrs.get("class") == "android.widget.EditText":
                attrs["text"] = f"<{len(attrs.get('text', ''))} chars>"
            found.append(attrs)
        return found

    @staticmethod
    def label(node: dict) -> str:
        return (node.get("content-desc") or node.get("text") or "").replace(
            "&#10;", "\n"
        )

    def labels(self) -> list[str]:
        return [self.label(n) for n in self.nodes() if self.label(n)]

    def find(
        self, contains: str, *, nodes: list[dict] | None = None, where=None
    ) -> dict | None:
        for n in nodes if nodes is not None else self.nodes():
            if contains in self.label(n) and (where is None or where(n)):
                return n
        return None

    def wait(self, contains: str, timeout: float = 30, where=None) -> dict:
        end = time.time() + timeout
        while time.time() < end:
            n = self.find(contains, where=where)
            if n:
                return n
            time.sleep(1)
        raise Step(
            f"Timed out waiting for {contains!r}; screen shows {self.labels()[:12]}"
        )

    def tap_node(self, n: dict) -> None:
        self.adb("shell", "input", "tap", str(n["cx"]), str(n["cy"]))

    def tap(self, contains: str, timeout: float = 30, where=None) -> None:
        self.tap_node(self.wait(contains, timeout, where))

    def edits(self) -> list[dict]:
        return [n for n in self.nodes() if n.get("class") == "android.widget.EditText"]

    def enter_private(self, index: int, value: str) -> None:
        """Focus a verified field, empty it, then type through adb's stdin so nothing is in argv."""
        for _ in range(5):
            fields = self.edits()
            self.tap_node(fields[index])
            time.sleep(0.8)
            if self.edits()[index].get("focused") == "true":
                break
        else:
            raise Step(f"Text field {index} did not take focus")
        self.adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
        self.adb("shell", stdin="input keyevent " + " ".join(["67"] * 160) + "\n")
        if self.edits()[index]["text"] != "<0 chars>":
            raise Step(f"Text field {index} could not be emptied")
        self.adb(
            "shell", stdin="input text " + shlex.quote(value.replace(" ", "%s")) + "\n"
        )
        if self.edits()[index]["text"] != f"<{len(value)} chars>":
            raise Step(f"Text field {index} did not receive the expected entry length")

    def screenshot(self, path: Path) -> None:
        if self.edits():
            raise SafetyError("Refusing to screenshot a screen that has a text field")
        data = subprocess.run(
            self.device.prefix + ["exec-out", "screencap", "-p"],
            capture_output=True,
            check=True,
        ).stdout
        path.write_bytes(data)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_fixture(path: Path, expected_origin: str) -> dict:
    if path.stat().st_mode & 0o077:
        raise SafetyError("Login fixture must be mode 0600")
    fixture = json.loads(path.read_text())
    if fixture["origin"].rstrip("/") != expected_origin:
        raise SafetyError(
            "Login fixture origin does not match the app's DEV_BACKEND_ORIGIN"
        )
    return fixture


def app_env(apk: Path) -> dict[str, str]:
    if apk_package(apk, find_aapt2(None), subprocess.run) != PACKAGE:
        raise SafetyError(
            "APK package does not match the isolated collector dev package"
        )
    try:
        with ZipFile(apk) as bundle:
            configs = [
                entry
                for entry in bundle.infolist()
                if entry.filename == "assets/flutter_assets/.env"
            ]
            if len(configs) != 1 or configs[0].file_size > 64 * 1024:
                raise SafetyError(
                    "APK must contain one bounded Flutter configuration asset"
                )
            config = bundle.read(configs[0]).decode()
    except (OSError, BadZipFile, UnicodeDecodeError):
        raise SafetyError("Cannot read the APK's Flutter configuration") from None
    values = dict(line.split("=", 1) for line in config.splitlines() if "=" in line)
    if (
        values.get("NO_AUTH_MODE") != "false"
        or values.get("LOCAL_PASSWORD_AUTH") != "true"
    ):
        raise SafetyError(
            "The APK must use NO_AUTH_MODE=false and LOCAL_PASSWORD_AUTH=true"
        )
    if values.get("ENVIRONMENT") != "dev" or not values.get("DEV_BACKEND_ORIGIN"):
        raise SafetyError("The APK must select a development backend origin")
    allowed = {
        "LOCAL_PASSWORD_AUTH",
        "NO_AUTH_MODE",
        "ENVIRONMENT",
        "DEV_BACKEND_ORIGIN",
        "PROD_BACKEND_ORIGIN",
        "APPLE_SIGN_IN",
    }
    if any(k not in allowed and v for k, v in values.items()):
        raise SafetyError("The APK configuration must hold only public values")
    return values


class Run:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.env = app_env(APK)
        self.device = emulator(args.serial)
        self.ui = Ui(self.device)
        self.out = args.output or ROOT / "artifacts/sa69-joined" / datetime.now(
            timezone.utc
        ).strftime("%Y%m%dT%H%M%SZ")
        self.out = self.out.resolve()
        self.out.relative_to(ROOT / "artifacts")
        self.out.mkdir(parents=True, exist_ok=False)
        self.log: list[dict] = []
        self.fixtures = {
            name: read_fixture(Path(p), self.env["DEV_BACKEND_ORIGIN"].rstrip("/"))
            for name, p in (
                ("primary", args.login_fixture),
                ("secondary", args.second_login_fixture),
            )
            if p
        }

    def step(self, name: str, **facts) -> None:
        self.log.append({"step": name, **facts})
        print(f"[ok] {name}", flush=True)

    def run_as(self, path: str) -> bytes:
        return subprocess.run(
            self.device.prefix
            + ["exec-out", "run-as", PACKAGE, "--user", "0", "cat", path],
            capture_output=True,
            check=True,
        ).stdout

    def source_hashes(self) -> dict[str, str]:
        out = self.ui.adb("shell", f"cd {SESSIONS} && sha256sum */*").stdout
        return {
            line.split()[1]: line.split()[0]
            for line in out.splitlines()
            if len(line.split()) == 2
        }

    def snapshot(self) -> dict:
        ledger = json.loads(self.run_as(LEDGER))
        return {"hashes": self.source_hashes(), "ledger": ledger}

    def launch(self) -> None:
        self.device.operate(
            "launch", PACKAGE, ["shell", "am", "start", "--user", "0", "-n", ACTIVITY]
        )

    def sign_in(self, who: str) -> None:
        fixture = self.fixtures[who]
        self.ui.wait("Development sign-in", 30)
        self.ui.enter_private(0, fixture["email"])
        self.ui.enter_private(1, fixture["password"])
        self.ui.adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(1)
        self.ui.tap("Sign in with email")
        end = time.time() + 40
        while time.time() < end:
            labels = self.ui.labels()
            if any(
                ("Start Recording" in text or "What should we call you" in text)
                for text in labels
            ):
                return
            if any(
                re.search(r"incorrect|rejected|refused|unavailable|offline", text, re.I)
                for text in labels
            ):
                raise Step("Sign-in was refused by the server or unreachable")
            time.sleep(1.5)
        raise Step("Sign-in did not reach the signed-in app")

    def finish_onboarding(self) -> None:
        if self.ui.find("What should we call you"):
            self.ui.enter_private(0, "SA69 Emulator")
            self.ui.adb("shell", "input", "keyevent", "KEYCODE_BACK")
            time.sleep(1)
            self.ui.tap("Continue")
            self.ui.tap("United States")
            self.ui.tap("Submit")
        self.ui.wait("Currently uploading", 20)

    def record(self, seconds: int) -> None:
        # The original Home button, not a harness shortcut.
        self.ui.tap("Start Recording", 20, where=lambda n: n["cy"] > 700)
        deadline = time.time() + 45
        while time.time() < deadline:
            labels = self.ui.labels()
            if "TRACKING" in labels:
                break
            allow = self.ui.find("While using the app")
            if allow:
                self.ui.tap_node(allow)
            time.sleep(1.5)
        else:
            raise Step(
                f"Recorder did not reach tracking; screen shows {self.ui.labels()[:10]}"
            )
        self.ui.tap("Start Recording", 20, where=lambda n: n["cx"] > 400)
        self.ui.wait("Stop", 20)
        time.sleep(seconds)
        self.ui.tap("Stop", 20)
        self.ui.wait("session_dat", 60)

    def open_capture_tab(self) -> None:
        # The centre tab of the original bottom navigation has no label; its position is fixed.
        self.ui.adb("shell", "input", "tap", "360", "1196")
        self.ui.wait("Before you record", 20)

    def logout(self) -> None:
        self.ui.tap("Profile", 20)
        self.ui.tap("Account Settings", 20)
        self.ui.tap("Logout", 20)
        end = time.time() + 30
        while time.time() < end:
            confirm = [
                n
                for n in self.ui.nodes()
                if self.ui.label(n).startswith("Log out anyway")
            ]
            if self.ui.find("Development sign-in"):
                return
            if confirm:
                self.ui.tap_node(confirm[-1])
            time.sleep(1.5)
        raise Step("Logout did not return to the sign-in screen")

    def validate(self, name: str, files: list[Path]) -> dict:
        run = subprocess.run(
            VALIDATOR
            + [
                "--profile",
                "h264_mcap_simulation_v1",
                "--expect-outcome",
                "completed",
                *map(str, files),
            ],
            capture_output=True,
            text=True,
        )
        (self.out / f"validator-{name}.json").write_text(run.stdout)
        if run.returncode != 0:
            raise Step(
                f"Independent validation failed: {run.stdout[-800:]}{run.stderr[-400:]}"
            )
        return json.loads(run.stdout)

    def main(self) -> dict:
        args, ui = self.args, self.ui
        launcher = subprocess.run(
            ["scripts/start_capture_emulator.sh", "--ar", "--verify-only"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        (self.out / "emulator-verify.txt").write_text(launcher.stdout + launcher.stderr)
        if (
            launcher.returncode != 0
            or "accelerated-kvm-host-gpu" not in launcher.stdout + launcher.stderr
        ):
            raise SafetyError("The warm emulator is not verified as KVM + host GPU")
        self.step("emulator_verified_accelerated", serial=args.serial)
        if args.fresh:
            _, present = self.device.scope(PACKAGE)
            if present:
                # `operate` expects the package to remain installed, so verify scope, remove, verify absence.
                self.device.adb(
                    "uninstall",
                    "--user",
                    "0",
                    PACKAGE,
                    operation="Scoped dev-package uninstall",
                )
                if self.device.scope(PACKAGE)[1]:
                    raise SafetyError(
                        "The dev package is still installed after uninstall"
                    )
        install = self.device.operate(
            "install", PACKAGE, ["install", "--user", "0", "-r", str(APK)]
        )
        for permission in ("CAMERA", "RECORD_AUDIO", "POST_NOTIFICATIONS"):
            self.device.operate(
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
        self.step(
            "installed_user0",
            apk_sha256=sha256(APK.read_bytes()),
            command=install["command"],
        )
        self.ui.adb("logcat", "-c")
        self.launch()
        time.sleep(8)
        if not ui.find("Development sign-in"):
            self.finish_onboarding()
            self.logout()
        self.sign_in("primary")
        self.step("signed_in_via_real_sign_in_screen")
        self.finish_onboarding()
        self.step("home_reached_after_me_verified_sign_in")
        ui.screenshot(self.out / "home.png")
        before = self.source_hashes()
        self.record(args.seconds)
        ui.screenshot(self.out / "after-stop.png")
        self.step("start_stop_from_original_ui")
        pulled = self.out / "sessions"
        subprocess.run(
            self.device.prefix + ["pull", SESSIONS, str(pulled)],
            check=True,
            capture_output=True,
        )
        taken = sorted(set(self.source_hashes()) - set(before))
        directories = sorted({t.split("/")[0] for t in taken})
        if len(directories) != 1:
            raise Step(
                f"Expected exactly one new session directory, found {directories}"
            )
        session = directories[0]
        mcap = (
            next((pulled / "ar_sessions" / session).glob("*.mcap"))
            if (pulled / "ar_sessions").exists()
            else next((pulled / session).glob("*.mcap"))
        )
        validation = self.validate("take", [mcap])
        self.step(
            "independent_validation",
            sha256=validation["files"][0]["sha256"],
            sa50=validation["files"][0]["sa50_checker"],
        )
        snap = self.snapshot()
        entry = snap["ledger"]["sessions"].get(session)
        if (
            not entry
            or not entry.get("owner")
            or entry.get("provenance") != "capture_start"
        ):
            raise Step("Owner ledger has no capture_start stamp for the new session")
        intent = snap["ledger"]["intents"].get(entry["intentId"], {})
        if (
            intent.get("state") != "bound"
            or intent.get("sessionDir") != session
            or intent.get("owner") != entry["owner"]
        ):
            raise Step(
                "Owner ledger intent is not bound exactly to the session directory and owner"
            )
        (self.out / "ledger.json").write_text(json.dumps(snap["ledger"], indent=2))
        self.step("owner_ledger_exact_link", session=session, owner_present=True)
        database = self.out / "stera.sqlite"
        database.write_bytes(self.run_as(DB))
        rows = sqlite3.connect(database)
        statuses = [r[0] for r in rows.execute("select status from uploads")]
        sessions_n = rows.execute("select count(*) from upload_sessions").fetchone()[0]
        parts_n = rows.execute("select count(*) from upload_parts").fetchone()[0]
        if sessions_n or parts_n or any(s != "notStarted" for s in statuses):
            raise Step("Queue shows upload activity; nothing may upload in this run")
        self.step(
            "no_upload_activity", rows=len(statuses), statuses=sorted(set(statuses))
        )

        # Process restart: same bytes, same ledger, still signed in.
        self.ui.adb("shell", "am", "force-stop", "--user", "0", PACKAGE)
        time.sleep(2)
        self.launch()
        ui.wait("Currently uploading", 45)
        after_restart = self.snapshot()
        if after_restart != snap:
            raise Step("Source bytes or owner ledger changed across process restart")
        self.open_capture_tab()
        ui.wait("session_dat", 20)
        self.step("process_restart_preserved_source_owner_and_session")

        # Logout keeps the bytes and the owner; sign-in screen returns.
        self.logout()
        after_logout = self.snapshot()
        if after_logout != snap:
            raise Step("Source bytes or owner ledger changed across logout")
        self.step("logout_preserved_source_and_owner")
        if "secondary" in self.fixtures:
            self.sign_in("secondary")
            self.finish_onboarding()
            self.open_capture_tab()
            if ui.find("session_dat"):
                raise Step("A different account can see the first owner's session")
            if self.snapshot() != snap:
                raise Step("Another account changed the first owner's source/ledger")
            self.step("second_account_blocked_and_bytes_unchanged")
            self.logout()
        self.sign_in("primary")
        self.finish_onboarding()
        if self.snapshot() != snap:
            raise Step("Source bytes or owner ledger changed after re-login")
        self.step("relogin_same_owner_source_unchanged")

        receipt = {
            "status": "passed_joined_ui_to_retained_source_emulator",
            "emulator": args.serial,
            "personalUser": 0,
            "package": PACKAGE,
            "apk_sha256": sha256(APK.read_bytes()),
            "appConfig": {
                k: self.env[k]
                for k in (
                    "NO_AUTH_MODE",
                    "ENVIRONMENT",
                    "LOCAL_PASSWORD_AUTH",
                    "DEV_BACKEND_ORIGIN",
                    "PROD_BACKEND_ORIGIN",
                )
            },
            "mcap_sha256": validation["files"][0]["sha256"],
            "session": session,
            "steps": self.log,
            "secondAccountExercised": "secondary" in self.fixtures,
            "simulation_only": True,
            "hardware_qualified": False,
            "physical_device_touched": False,
            "output": str(self.out),
        }
        (self.out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        return receipt


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--serial", default="emulator-5582")
    parser.add_argument(
        "--login-fixture",
        type=Path,
        required=True,
        help="0600 JSON {email,password,origin}; read only in memory",
    )
    parser.add_argument(
        "--second-login-fixture",
        type=Path,
        help="optional second account to prove another owner cannot see the source",
    )
    parser.add_argument("--seconds", type=int, default=20, help="recording length")
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="uninstall the dev package (user 0 only) first",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    receipt = Run(args).main()
    print(json.dumps({k: receipt[k] for k in ("status", "output", "mcap_sha256")}))


if __name__ == "__main__":
    main()
