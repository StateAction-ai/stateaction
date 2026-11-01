"""Exercise runner-only cleanup guards and real small reserved child processes."""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import runner_disk

HOSTED = {
    "GITHUB_ACTIONS": "true",
    "RUNNER_ENVIRONMENT": "github-hosted",
    "RUNNER_OS": "Linux",
    "ImageOS": "ubuntu24",
    "GITHUB_JOB": "android",
}
UBUNTU = {"ID": "ubuntu", "VERSION_ID": "24.04"}


class RunnerDiskTests(unittest.TestCase):
    def test_grandchild_group_stops_after_parent_has_already_exited(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            pid_file = directory / "grandchild.pid"
            script = "import subprocess,sys; from pathlib import Path; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); Path(sys.argv[1]).write_text(str(child.pid))"
            status = runner_disk.guarded_build(
                directory,
                directory,
                [sys.executable, "-c", script, str(pid_file)],
                minimum_free=0,
                reserve_bytes=65536,
                stop_free=0,
                poll_seconds=0.01,
            )
            self.assertEqual(status, 0)
            self.assertFalse(list(directory.glob("stateaction-android-logs-*")))
            pid = int(pid_file.read_text())
            # A reparented zombie has stopped writing even before init reaps it.
            for _ in range(100):
                proc = Path(f"/proc/{pid}/stat")
                if not proc.exists() or proc.read_text().split()[2] == "Z":
                    break
                time.sleep(0.01)
            else:
                os.kill(pid, 9)
                self.fail(
                    "Owned grandchild remained alive after its group leader exited"
                )

    def test_local_self_hosted_and_other_jobs_cannot_cleanup(self):
        for changed in (
            {"GITHUB_ACTIONS": "false"},
            {"RUNNER_ENVIRONMENT": "self-hosted"},
            {"GITHUB_JOB": "checks"},
            {"ImageOS": "ubuntu22"},
        ):
            with (
                self.subTest(changed=changed),
                patch.dict(os.environ, HOSTED | changed, clear=True),
                patch.object(runner_disk.subprocess, "run") as command,
            ):
                with self.assertRaisesRegex(SystemExit, "Refusing disk changes"):
                    runner_disk.prepare(Path("/"))
                command.assert_not_called()

    def test_operating_system_must_match(self):
        with (
            patch.dict(os.environ, HOSTED, clear=True),
            patch.object(
                runner_disk.platform,
                "freedesktop_os_release",
                return_value={"ID": "debian", "VERSION_ID": "12"},
            ),
        ):
            with self.assertRaisesRegex(SystemExit, "different operating system"):
                runner_disk.require_ephemeral_android_job()

    def test_only_fixed_unused_tools_are_deleted_even_with_hostile_cache_variable(self):
        with (
            patch.dict(
                os.environ, HOSTED | {"RUNNER_TOOL_CACHE": "/do-not-delete"}, clear=True
            ),
            patch.object(
                runner_disk.platform, "freedesktop_os_release", return_value=UBUNTU
            ),
            patch.object(Path, "exists", return_value=True),
            patch.object(runner_disk.subprocess, "run") as command,
        ):
            runner_disk.prepare(Path("/workspace"))
        deletion = [
            call.args[0] for call in command.call_args_list if call.args[0][0] == "sudo"
        ]
        self.assertEqual(
            deletion,
            [
                [
                    "sudo",
                    "-n",
                    "rm",
                    "-rf",
                    "--",
                    "/usr/share/dotnet",
                    "/usr/local/.ghcup",
                    "/opt/hostedtoolcache/CodeQL",
                    "/usr/share/swift",
                ]
            ],
        )

    def test_absent_unused_tools_do_not_trigger_delete(self):
        with (
            patch.dict(os.environ, HOSTED, clear=True),
            patch.object(
                runner_disk.platform, "freedesktop_os_release", return_value=UBUNTU
            ),
            patch.object(Path, "exists", return_value=False),
            patch.object(Path, "is_symlink", return_value=False),
            patch.object(runner_disk.subprocess, "run") as command,
        ):
            runner_disk.prepare(Path("/workspace"))
        self.assertFalse(
            any(call.args[0][0] == "sudo" for call in command.call_args_list)
        )

    def test_low_initial_space_refuses_before_starting_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with (
                patch.object(
                    runner_disk.shutil,
                    "disk_usage",
                    return_value=shutil._ntuple_diskusage(100, 95, 5),
                ),
                patch.object(runner_disk.subprocess, "Popen") as child,
            ):
                with self.assertRaisesRegex(
                    SystemExit, "Insufficient Android build space"
                ):
                    runner_disk.guarded_build(
                        directory,
                        directory,
                        [sys.executable, "-c", "pass"],
                        minimum_free=10,
                        reserve_bytes=10,
                    )
                child.assert_not_called()
            self.assertFalse(list(directory.iterdir()))

    def test_real_reserve_is_allocated_and_removed_after_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            script = "from pathlib import Path; import sys; p=next(Path(sys.argv[1]).glob('stateaction-android-logs-*')); assert p.stat().st_size == 65536; assert p.stat().st_blocks*512 >= 65536"
            status = runner_disk.guarded_build(
                directory,
                directory,
                [sys.executable, "-c", script, temporary],
                minimum_free=0,
                reserve_bytes=65536,
                stop_free=0,
                poll_seconds=0.01,
            )
            self.assertEqual(status, 0)
            self.assertFalse(list(directory.iterdir()))

    def test_real_child_failure_preserved_and_reserve_removed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            status = runner_disk.guarded_build(
                directory,
                directory,
                [sys.executable, "-c", "raise SystemExit(7)"],
                minimum_free=0,
                reserve_bytes=65536,
                stop_free=0,
                poll_seconds=0.01,
            )
            self.assertEqual(status, 7)
            self.assertFalse(list(directory.iterdir()))

    def test_low_space_monitor_stops_real_child_and_releases_reserve(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            usage = [
                shutil._ntuple_diskusage(100, 0, 100),
                shutil._ntuple_diskusage(100, 0, 100),
                shutil._ntuple_diskusage(100, 99, 1),
            ]
            with patch.object(runner_disk.shutil, "disk_usage", side_effect=usage):
                status = runner_disk.guarded_build(
                    directory,
                    directory,
                    [sys.executable, "-c", "import time; time.sleep(60)"],
                    minimum_free=10,
                    reserve_bytes=10,
                    stop_free=2,
                    poll_seconds=0.01,
                )
            self.assertEqual(status, 1)
            self.assertFalse(list(directory.iterdir()))

    def test_launch_failure_releases_reserve(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaises(FileNotFoundError):
                runner_disk.guarded_build(
                    directory,
                    directory,
                    ["/nonexistent-stateaction-program"],
                    minimum_free=0,
                    reserve_bytes=65536,
                )
            self.assertFalse(list(directory.iterdir()))

    def test_actual_cli_rejects_local_cleanup(self):
        result = subprocess.run(
            [sys.executable, runner_disk.__file__, "prepare"],
            env=os.environ | {"GITHUB_ACTIONS": "false"},
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing disk changes", result.stderr)


if __name__ == "__main__":
    unittest.main()
