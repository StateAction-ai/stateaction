"""Safety contract tests use fake ADB only; never contact any Android device."""
from contextlib import redirect_stderr, redirect_stdout
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from android_personal_device import PersonalDevice, SafetyError, main, parse_users


PACKAGE = "ai.stateaction.spike.capture"
USERS = """2 users:

0: id=0, name=PERSONAL, type=full.SYSTEM, flags=ADMIN|FULL|INITIALIZED|MAIN|PRIMARY|SYSTEM (running) (current) (visible)
1: id=10, name=Work profile, type=profile.MANAGED, flags=INITIALIZED|MANAGED_PROFILE|PROFILE (parentId=0) (running) (profile-owner) (visible)
"""


class FakeAdb:
    def __init__(self, *, target_present=True, work_present=False):
        self.calls = []
        self.users = USERS
        self.current = "0"
        self.present = {0: {PACKAGE} if target_present else set(), 10: {PACKAGE} if work_present else set()}
        self.apk_package = PACKAGE
        self.mutations = []
        self.install_leaks = False
        self.user_output_after = None
        self.query_output = None
        self.diagnostics = ""
        self.install_output = "Performing Streamed Install\nSuccess\n"
        self.start_output = "Starting: Intent { cmp=ai.stateaction.spike.capture/.MainActivity }\n"
        self.grant_output = ""

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        if command[0] == "fake-aapt2":
            output = f"package: name='{self.apk_package}' versionCode='1'\n"
        else:
            if command[:3] != ["adb", "-s", "explicit-test-serial"]:
                raise AssertionError("ADB must always receive the explicit serial")
            args = command[3:]
            if args == ["shell", "cmd", "user", "list", "-v"]:
                output = self.user_output_after if self.mutations and self.user_output_after else self.users
            elif args == ["shell", "am", "get-current-user"]:
                output = self.current
            elif args[:4] == ["shell", "pm", "list", "packages"]:
                self.assert_scope(args[4:])
                if args[-1] != PACKAGE:
                    raise AssertionError("Only the exact requested package may be queried")
                user = int(args[5])
                output = self.query_output if self.query_output is not None else (f"package:{PACKAGE}\n" if PACKAGE in self.present.get(user, set()) else "")
            elif args[0] == "install":
                self.assert_scope(args[1:]); self.mutations.append(args)
                self.present.setdefault(int(args[2]), set()).add(self.apk_package)
                if self.install_leaks:
                    self.present[10].add(self.apk_package)
                output = self.install_output
            elif args[:3] == ["shell", "am", "start"]:
                self.assert_scope(args[3:]); self.mutations.append(args); output = self.start_output
            elif args[:3] == ["shell", "pm", "grant"]:
                self.assert_scope(args[3:]); self.mutations.append(args); output = self.grant_output
            else:
                raise AssertionError(f"Unexpected ADB operation: {args}")
        return subprocess.CompletedProcess(command, 0, stdout=output, stderr=self.diagnostics)

    @staticmethod
    def assert_scope(args):
        if len(args) < 2 or args[0] != "--user" or not args[1].isdigit() or "all" in args:
            raise AssertionError("Every package/app operation must use an explicit numeric user")


class PersonalDeviceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.apk = Path(self.directory.name) / "capture.apk"
        self.apk.write_bytes(b"fake APK: its identity is supplied by fake-aapt2")

    def invoke(self, fake, *args, user="0"):
        with redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
            code = main(["--serial", "explicit-test-serial", "--user", user, *args], runner=fake)
        return code, stdout.getvalue(), stderr.getvalue()

    def install(self, fake, *extra, user="0"):
        return self.invoke(fake, "install", "--apk", str(self.apk), "--package", PACKAGE, "--aapt2", "fake-aapt2", *extra, user=user)

    def test_verbose_pixel_inventory_has_full_personal_and_managed_work(self):
        users = parse_users(USERS)
        self.assertEqual([(u.user_id, u.user_type, u.current) for u in users], [(0, "full.SYSTEM", True), (10, "profile.MANAGED", False)])

    def test_unknown_incomplete_duplicate_and_ambiguous_inventory_fails_closed(self):
        cases = ["Users:\nUserInfo{0:Owner:c13} running", USERS.replace("2 users:", "3 users:"),
                 USERS.replace("id=10", "id=0"), USERS.replace("type=profile.MANAGED", "type=unknown.MANAGED"),
                 USERS.replace("type=profile.MANAGED", "type=profile.UNRECOGNIZED"),
                 USERS.replace("(current)", ""), USERS.replace("(parentId=0)", "(current) (parentId=0)"),
                 USERS.replace("name=PERSONAL", "name=PERSONAL, type=full.SYSTEM")]
        for output in cases:
            with self.subTest(output=output), self.assertRaises(SafetyError):
                parse_users(output)

    def test_work_profile_rejected_before_any_mutation(self):
        fake = FakeAdb()
        code, _, error = self.install(fake, user="10")
        self.assertEqual(code, 2)
        self.assertIn("work/managed profiles are forbidden", error)
        self.assertFalse(fake.mutations)

    def test_type_and_flag_disagreement_is_not_personal(self):
        fake = FakeAdb(); fake.users = USERS.replace("ADMIN|FULL", "MANAGED_PROFILE|FULL")
        self.assertEqual(self.install(fake)[0], 2)
        self.assertFalse(fake.mutations)

    def test_company_device_owner_full_user_is_rejected(self):
        fake = FakeAdb(); fake.users = USERS.replace("(current)", "(device-owner) (current)")
        self.assertEqual(self.install(fake)[0], 2)
        self.assertFalse(fake.mutations)

    def test_user_zero_is_not_assumed_for_another_verified_personal_user(self):
        fake = FakeAdb(target_present=False)
        fake.users = USERS.replace("id=0, name=PERSONAL, type=full.SYSTEM", "id=11, name=PERSONAL, type=full.SECONDARY")
        fake.current = "11"
        self.assertEqual(self.install(fake, user="11")[0], 0)
        self.assertEqual(fake.mutations[0][:4], ["install", "--user", "11", "-r"])
        self.assertEqual(fake.present.get(0), set())
        self.assertEqual(fake.present[10], set())

    def test_unscoped_current_all_or_missing_serial_user_never_calls_adb(self):
        for args in [["--user", "0", "check", "--package", PACKAGE],
                     ["--serial", "explicit-test-serial", "check", "--package", PACKAGE],
                     ["--serial", "explicit-test-serial", "--user", "all", "check", "--package", PACKAGE]]:
            fake = FakeAdb()
            with self.subTest(args=args), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                main(args, runner=fake)
            self.assertFalse(fake.calls)

    def test_check_only_identifies_profiles_and_exact_package(self):
        fake = FakeAdb()
        code, output, _ = self.invoke(fake, "check", "--package", PACKAGE)
        self.assertEqual(code, 0)
        self.assertIn('"targetInstalled": true', output)
        self.assertFalse(fake.mutations)
        self.assertEqual(len(fake.calls), 4)

    def test_existing_work_copy_blocks_even_personal_update(self):
        fake = FakeAdb(work_present=True)
        code, _, error = self.install(fake)
        self.assertEqual(code, 2)
        self.assertIn("non-target user 10", error)
        self.assertFalse(fake.mutations)

    def test_install_dry_run_has_explicit_user_but_never_mutates(self):
        fake = FakeAdb(target_present=False)
        code, output, _ = self.install(fake, "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn('"--user",\n    "0"', output)
        self.assertFalse(fake.mutations)
        self.assertFalse(fake.present[0])

    def test_install_targets_personal_only_keeps_existing_data(self):
        fake = FakeAdb()
        self.assertEqual(self.install(fake)[0], 0)
        self.assertEqual(fake.mutations, [["install", "--user", "0", "-r", str(self.apk.resolve())]])
        self.assertEqual(fake.present[0], {PACKAGE})
        self.assertEqual(fake.present[10], set())
        self.assertFalse(any("clear" in args or "uninstall" in args for args in fake.calls))

    def test_apk_identity_mismatch_cannot_bypass_package_preflight(self):
        fake = FakeAdb(); fake.apk_package = "ai.stateaction.different"
        self.assertEqual(self.install(fake)[0], 2)
        self.assertFalse(fake.mutations)
        self.assertFalse(any(call[0] == "adb" for call in fake.calls))

    def test_post_install_unexpected_profile_is_detected_without_auto_cleanup(self):
        fake = FakeAdb(); fake.install_leaks = True
        code, _, error = self.install(fake)
        self.assertEqual(code, 2)
        self.assertIn("non-target user 10", error)
        self.assertEqual(len(fake.mutations), 1)
        self.assertFalse(any("uninstall" in args for args in fake.calls))

    def test_current_user_must_agree_with_verbose_inventory(self):
        fake = FakeAdb(); fake.current = "10"
        self.assertEqual(self.invoke(fake, "start", "--component", PACKAGE + "/.MainActivity")[0], 2)
        self.assertFalse(fake.mutations)

    def test_start_has_explicit_personal_user(self):
        fake = FakeAdb()
        self.assertEqual(self.invoke(fake, "start", "--component", PACKAGE + "/.MainActivity")[0], 0)
        self.assertEqual(fake.mutations, [["shell", "am", "start", "--user", "0", "-n", PACKAGE + "/.MainActivity"]])

    def test_missing_target_package_cannot_launch_or_check_successfully(self):
        fake = FakeAdb(target_present=False)
        self.assertEqual(self.invoke(fake, "check", "--package", PACKAGE)[0], 2)
        self.assertEqual(self.invoke(fake, "start", "--component", PACKAGE + "/.MainActivity")[0], 2)
        self.assertFalse(fake.mutations)

    def test_grant_is_personal_only(self):
        fake = FakeAdb()
        self.assertEqual(self.invoke(fake, "grant", "--package", PACKAGE, "--permission", "android.permission.CAMERA")[0], 0)
        self.assertEqual(fake.mutations, [["shell", "pm", "grant", "--user", "0", PACKAGE, "android.permission.CAMERA"]])

    def test_no_unknown_query_output_is_treated_as_absence(self):
        fake = FakeAdb(); fake.query_output = "Security exception: not allowed"
        self.assertEqual(self.install(fake)[0], 2)
        self.assertFalse(fake.mutations)

    def test_unexpected_diagnostics_fail_closed_without_logging_them(self):
        fake = FakeAdb(); fake.diagnostics = "private device detail"
        code, output, error = self.install(fake)
        self.assertEqual(code, 2)
        self.assertNotIn("private device detail", output + error)
        self.assertFalse(fake.mutations)

    def test_install_uncertain_result_is_not_retried(self):
        fake = FakeAdb(); fake.install_output = "Performing Streamed Install"
        self.assertEqual(self.install(fake)[0], 2)
        self.assertEqual(len(fake.mutations), 1)
        self.assertEqual(sum(call[3:] == ["shell", "cmd", "user", "list", "-v"] for call in fake.calls if call[0] == "adb"), 2)

    def test_zero_exit_am_error_is_not_success(self):
        fake = FakeAdb(); fake.start_output = "Error type 3\nError: Activity class does not exist."
        self.assertEqual(self.invoke(fake, "start", "--component", PACKAGE + "/.MainActivity")[0], 2)
        self.assertEqual(len(fake.mutations), 1)

    def test_post_operation_profile_change_is_not_accepted(self):
        fake = FakeAdb(); fake.user_output_after = USERS.replace("(current)", "")
        self.assertEqual(self.install(fake)[0], 2)
        self.assertEqual(len(fake.mutations), 1)


if __name__ == "__main__":
    unittest.main()
