"""Fake-ADB tests for the emulator driver's safety contract. No device is contacted."""

import subprocess
import unittest

import run_emulator_qualification as driver
from android_personal_device import SafetyError

USERS = """2 users:

0: id=0, name=PERSONAL, type=full.SYSTEM, flags=ADMIN|FULL|INITIALIZED|MAIN|PRIMARY|SYSTEM (running) (current) (visible)
1: id=10, name=Work profile, type=profile.MANAGED, flags=INITIALIZED|MANAGED_PROFILE|PROFILE (parentId=0) (running) (profile-owner) (visible)
"""
SERIAL = "emulator-5582"


class Fake:
    def __init__(self, qemu="1", instrumentation="OK (1 test)\n"):
        self.calls, self.qemu, self.instrumentation = [], qemu, instrumentation
        self.installed = {0: set(), 10: set()}

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        assert command[:3] == ["adb", "-s", SERIAL], "explicit serial required"
        args = command[3:]
        out = ""
        if args == ["shell", "getprop", "ro.kernel.qemu"]:
            out = self.qemu
        elif args[:2] == ["shell", "getprop"]:
            out = "value"
        elif args == ["shell", "cmd", "user", "list", "-v"]:
            out = USERS
        elif args == ["shell", "am", "get-current-user"]:
            out = "0"
        elif args[:4] == ["shell", "pm", "list", "packages"]:
            user, package = int(args[5]), args[6]
            out = (
                f"package:{package}\\n".replace("\\n", "\n")
                if package in self.installed[user]
                else ""
            )
        elif args[0] == "install":
            self.installed[int(args[2])].add(
                "ai.stateaction.spike.capture.test"
                if "-t" in args
                else "ai.stateaction.spike.capture"
            )
            out = "Success\n"
        elif args[:3] == ["shell", "pm", "grant"]:
            out = ""
        elif args[:3] == ["shell", "am", "instrument"]:
            out = self.instrumentation
        elif args[0] == "exec-out":
            return subprocess.CompletedProcess(command, 0, stdout=b"bytes", stderr=b"")
        return subprocess.CompletedProcess(command, 0, stdout=out, stderr="")


class DriverSafety(unittest.TestCase):
    def test_physical_serials_are_refused_before_any_adb_call(self):
        for serial in (
            "R5CT1234567",
            "emulator-5582x",
            "192.168.1.5:5555",
            "emulator-all",
        ):
            fake = Fake()
            with self.assertRaises(SafetyError):
                driver.Qualification(serial, 0, runner=fake)
            self.assertEqual(fake.calls, [])

    def test_non_qemu_target_is_refused(self):
        with self.assertRaises(SafetyError):
            driver.Qualification(SERIAL, 0, runner=Fake(qemu="0")).preflight()

    def test_work_profile_user_is_refused(self):
        q = driver.Qualification(SERIAL, 10, runner=Fake())
        with self.assertRaises(SafetyError):
            q.preflight()

    def test_every_mutation_is_explicitly_scoped_to_the_personal_user(self):
        fake = Fake()
        q = driver.Qualification(SERIAL, 0, runner=fake)
        q.preflight()
        q.install()
        self.assertEqual(q.instrument(), "OK (1 test)")
        q.pull("capture.mcap")
        mutating = [
            c[3:]
            for c in fake.calls
            if c[3] in ("install", "exec-out")
            or c[3:6] in (["shell", "pm", "grant"], ["shell", "am", "instrument"])
        ]
        self.assertGreaterEqual(len(mutating), 5)
        for args in mutating:
            self.assertIn("--user", args)
            self.assertEqual(args[args.index("--user") + 1], "0")
        flat = [a for c in fake.calls for a in c]
        self.assertNotIn("all", flat)
        self.assertNotIn("10", [a for c in mutating for a in c])
        self.assertEqual(fake.installed[10], set())

    def test_instrumentation_without_ok_is_not_success(self):
        fake = Fake(instrumentation="FAILURES!!!\nTests run: 1,  Failures: 1\n")
        q = driver.Qualification(SERIAL, 0, runner=fake)
        with self.assertRaises(SafetyError):
            q.instrument()


if __name__ == "__main__":
    unittest.main()
