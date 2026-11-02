"""The accelerated profile must never accept software rendering or a missing KVM."""

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import emulator_acceleration as ea

NVIDIA = "Google (NVIDIA Corporation), Android Emulator OpenGL ES Translator (NVIDIA GeForce RTX 3090/PCIe/SSE2), OpenGL ES 3.1"
GOOD = ["emu", "-avd", "a", "-port", "5582", "-accel", "on", "-gpu", "host"]


class ProfileTest(unittest.TestCase):
    def check(self, args=GOOD, kvm=True, renderer=NVIDIA, profile=ea.ACCELERATED):
        return ea.check_profile(profile, args, kvm, renderer, "NVIDIA")

    def test_host_gpu_with_kvm_passes(self):
        self.assertEqual(self.check(), [])

    def test_software_renderers_are_rejected(self):
        for name in (
            "Google (Google Inc.), Android Emulator OpenGL ES Translator (Google SwiftShader)",
            "llvmpipe (LLVM)",
            "Mesa lavapipe",
        ):
            self.assertTrue(self.check(renderer=name), name)

    def test_software_flag_and_missing_kvm_are_rejected(self):
        swift = GOOD[:-1] + ["swiftshader_indirect"]
        self.assertIn("-gpu swiftshader_indirect", " ".join(self.check(args=swift)))
        self.assertTrue(any("kvm" in p for p in self.check(kvm=False)))

    def test_other_host_gpu_does_not_satisfy_expected_vendor(self):
        self.assertTrue(self.check(renderer="Google (Intel), Mesa Intel UHD"))

    def test_software_profile_cannot_masquerade_or_hide_hardware(self):
        self.assertTrue(self.check(profile=ea.SOFTWARE))
        self.assertEqual(
            self.check(profile=ea.SOFTWARE, renderer="Google SwiftShader"), []
        )

    def test_missing_renderer_fails(self):
        self.assertTrue(self.check(renderer=None))

    def test_surfaceflinger_parse(self):
        self.assertEqual(ea.guest_renderer("x\nGLES: A, B\ny"), "A, B")
        self.assertIsNone(ea.guest_renderer("nothing"))


class ProcessTest(unittest.TestCase):
    def test_finds_only_dedicated_qemu_and_kvm_fd(self):
        with tempfile.TemporaryDirectory() as d:
            proc = Path(d)
            for pid, argv in {
                "10": ["/x/emulator", "-avd", "a", "-port", "5582"],
                "11": ["/x/qemu-system-x86_64", "-avd", "a", "-port", "5582"],
                "12": ["/x/qemu-system-x86_64", "-avd", "b", "-port", "5580"],
            }.items():
                (proc / pid / "fd").mkdir(parents=True)
                (proc / pid / "cmdline").write_bytes(("\0".join(argv) + "\0").encode())
            os.symlink("/dev/kvm", proc / "11" / "fd" / "7")
            os.symlink("/dev/null", proc / "12" / "fd" / "7")
            self.assertEqual(ea.find_qemu(5582, "a", proc), 11)
            self.assertIsNone(ea.find_qemu(5582, "b", proc))
            self.assertTrue(ea.has_kvm_fd(11, proc))
            self.assertFalse(ea.has_kvm_fd(12, proc))


class DisplayOutputTest(unittest.TestCase):
    def test_exports_are_quoted_and_stale_authority_unset(self):
        import contextlib
        import io
        import shlex
        from unittest import mock

        found = {
            "DISPLAY": ":0; touch /tmp/pwn",
            "XAUTHORITY": "/run/a b'$(x)",
            "source": "s",
        }
        with (
            mock.patch.object(ea, "discover_display", return_value=found),
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            ea.main(["display"])
        words = [w for line in out.getvalue().splitlines() for w in shlex.split(line)]
        self.assertIn("DISPLAY=:0; touch /tmp/pwn", words)
        self.assertIn("XAUTHORITY=/run/a b'$(x)", words)
        self.assertNotIn("touch", words)
        found["XAUTHORITY"] = None
        with (
            mock.patch.object(ea, "discover_display", return_value=found),
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            ea.main(["display"])
        self.assertIn("unset XAUTHORITY", out.getvalue())

    def test_boot_mode_reports_actual_flags(self):
        self.assertEqual(ea.boot_mode(GOOD + ["-no-snapshot"]), "cold")
        self.assertEqual(ea.boot_mode(GOOD), "snapshot-capable")


class DisplayTest(unittest.TestCase):
    def test_caller_environment_wins_and_bad_one_fails_closed(self):
        ok = ea.discover_display({"DISPLAY": ":5"}, 1, probe=lambda d, a: True)
        self.assertEqual(ok["source"], "caller-environment")
        with self.assertRaises(ea.VerificationError):
            ea.discover_display({"DISPLAY": ":5"}, 1, probe=lambda d, a: False)

    def test_discovery_uses_only_private_same_user_authority(self):
        uid = os.getuid()
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "x11").mkdir()
            (root / "x11" / "X0").touch()
            run = root / "run"
            run.mkdir()
            private = run / ".mutter-Xwaylandauth.AAAA"
            private.touch(mode=0o600)
            os.chmod(private, stat.S_IRUSR | stat.S_IWUSR)
            open_perm = run / ".mutter-Xwaylandauth.BBBB"
            open_perm.touch()
            os.chmod(open_perm, 0o644)
            seen = []

            def probe(display, authority):
                seen.append(authority)
                return authority == str(private)

            found = ea.discover_display({}, uid, probe, root / "x11", run)
            self.assertEqual(found["DISPLAY"], ":0")
            self.assertNotIn(str(open_perm), seen)
            with self.assertRaises(ea.VerificationError):
                ea.discover_display({}, uid, lambda d, a: False, root / "x11", run)


SCRIPTS = Path(__file__).resolve().parent.parent


@unittest.skipUnless(
    os.uname().sysname == "Linux"
    and os.uname().machine == "x86_64"
    and os.access("/dev/kvm", os.R_OK | os.W_OK),
    "launcher accelerated path needs Linux x86_64 with /dev/kvm",
)
class LauncherTest(unittest.TestCase):
    def test_display_helper_failure_exits_before_spawning_emulator(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "scripts" / "mobile").mkdir(parents=True)
            for name in ("start_capture_emulator.sh", "env.sh"):
                shutil.copy(SCRIPTS / name, root / "scripts" / name)
            (root / "scripts" / "mobile" / "emulator_acceleration.py").write_text(
                "import sys\nsys.exit(3)\n"
            )
            tools = root / "tools"
            sdk = tools / "android-sdk"
            (sdk / "emulator").mkdir(parents=True)
            (sdk / ".android" / "avd").mkdir(parents=True)
            (sdk / ".android" / "avd" / "stera_ar_api35.ini").touch()
            marker = root / "emulator-started"
            fake = sdk / "emulator" / "emulator"
            fake.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
            fake.chmod(0o755)
            bindir = root / "bin"
            bindir.mkdir()
            adb = bindir / "adb"
            adb.write_text("#!/bin/sh\nexit 1\n")  # no emulator is running
            adb.chmod(0o755)
            env = {
                "PATH": f"{bindir}:{os.environ['PATH']}",
                "HOME": d,
                "ROBOTICS_CAPTURE_TOOLS": str(tools),
            }
            result = subprocess.run(
                ["bash", str(root / "scripts" / "start_capture_emulator.sh")],
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Display discovery failed", result.stderr)
            self.assertFalse(
                marker.exists(), "emulator was spawned despite helper failure"
            )
            self.assertNotIn("Launched", result.stdout)


if __name__ == "__main__":
    unittest.main()
