"""Focused denial tests; no VM, camera, Gradle build or large allocations."""

import contextlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "resource_guard", Path(__file__).with_name("resource_guard.py")
)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ResourceGuardTest(unittest.TestCase):
    def test_emulator_control_has_an_independent_bounded_service_scope(self):
        # Its SDK supervisor must survive cleanup of a separate heavy job.
        # The actual warm-VM survival check is recorded separately.
        with (
            mock.patch.object(
                sys,
                "argv",
                [
                    "agent-resource",
                    "serve",
                    "--name",
                    "emulator-control",
                    "--",
                    "bash",
                    "supervise.sh",
                ],
            ),
            mock.patch.object(guard, "inside_guard", return_value=False),
            mock.patch.object(guard, "run_scope", return_value=0) as run,
        ):
            self.assertEqual(guard.main(), 0)
        run.assert_called_once_with(
            "agent-service-emulator-control.scope",
            ["bash", "supervise.sh"],
            emulator=False,
            service=True,
        )

    def test_emulator_control_refuses_a_transient_parent(self):
        with (
            mock.patch.object(
                sys,
                "argv",
                [
                    "agent-resource",
                    "serve",
                    "--name",
                    "emulator-control",
                    "--",
                    "bash",
                    "supervise.sh",
                ],
            ),
            mock.patch.object(guard, "inside_guard", return_value=True),
            mock.patch.object(guard, "run_scope") as run,
        ):
            self.assertEqual(guard.main(), 75)
        run.assert_not_called()

    def test_private_flutter_config_preserves_other_application_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "user-config"
            (source / "git").mkdir(parents=True)
            (source / "git/ignore").write_text("private-fixture\n")
            (source / "settings").write_text("original Flutter settings")
            install = root / "guard"
            with (
                mock.patch.object(guard, "INSTALL", install),
                mock.patch.dict(guard.os.environ, {"XDG_CONFIG_HOME": str(source)}),
            ):
                private = guard.shadow_user_config()
                self.assertEqual(
                    (private / "git/ignore").read_text(), "private-fixture\n"
                )
                self.assertFalse((private / "settings").exists())
                self.assertEqual(
                    (source / "settings").read_text(), "original Flutter settings"
                )

    def test_relaunch_waits_for_process_and_supervisor_lock(self):
        with mock.patch.object(guard, "android_processes", return_value=[123]):
            with self.assertRaises(guard.Refused):
                guard.wait_emulator_gone(timeout=0.01)
        with (
            mock.patch.object(guard, "android_processes", return_value=[]),
            mock.patch.object(
                guard, "singleton", side_effect=guard.Refused("still held")
            ),
        ):
            with self.assertRaises(guard.Refused):
                guard.wait_emulator_gone(timeout=0.01)

    def test_admission_floor_fails_closed(self):
        # 20% reserve (12 GiB at 60 GiB) + 8 GiB margin = the historical 20 GiB.
        total = 60 * guard.GIB
        with self.assertRaises(guard.Refused):
            guard.admit(20 * guard.GIB - 1, total)
        guard.admit(20 * guard.GIB, total)
        # A larger host scales the reserve: 64 GiB -> 12.8 GiB + 8 GiB.
        big = 64 * guard.GIB
        with self.assertRaises(guard.Refused):
            guard.admit(guard.admission_min(big) - 1, big)
        guard.admit(guard.admission_min(big), big)

    def test_global_slot_refuses_another_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with guard.singleton("emulator", directory):
                probe = (
                    "import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);"
                    "fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)"
                )
                result = subprocess.run(
                    [sys.executable, "-c", probe, str(directory / "emulator.lock")],
                    capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0)
            with guard.singleton("emulator", directory):
                pass

    def test_lock_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "target").touch()
            (directory / "emulator.lock").symlink_to(directory / "target")
            with self.assertRaises(OSError):
                with guard.singleton("emulator", directory):
                    self.fail("symlink admitted")

    def test_all_avds_and_ports_are_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for pid, port, avd in [(10, "5580", "one"), (11, "5582", "another")]:
                directory = root / str(pid)
                directory.mkdir()
                (directory / "cmdline").write_bytes(
                    f"/sdk/emulator/qemu-system-x86_64\0-avd\0{avd}\0-port\0{port}\0".encode()
                )
            self.assertEqual(sorted(guard.android_processes(root)), [10, 11])

    def test_non_android_vm_is_not_touched(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "42"
            directory.mkdir()
            (directory / "cmdline").write_bytes(
                b"/usr/bin/qemu-system-x86_64\0-hda\0disk\0"
            )
            self.assertEqual(guard.android_processes(Path(tmp)), [])

    def test_available_memory_requires_actual_field(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "meminfo"
            p.write_text("MemTotal: 99999999 kB\nMemAvailable: 12345 kB\n")
            self.assertEqual(guard.memory_available(p), 12345 * 1024)
            p.write_text("MemTotal: 99999999 kB\n")
            with self.assertRaises(guard.Refused):
                guard.memory_available(p)


GIB = guard.GIB
MIB = guard.MIB
TOTAL = 60 * GIB


class MemoryPolicyTest(unittest.TestCase):
    def test_reserve_is_exactly_twenty_percent_and_rounds_up(self):
        self.assertEqual(guard.host_reserve(TOTAL), 12 * GIB)
        self.assertEqual(guard.host_ceiling(TOTAL), 48 * GIB)
        self.assertEqual(guard.host_reserve(101), 21)  # ceil(20.2)
        self.assertEqual(guard.host_ceiling(101), 80)
        self.assertEqual(guard.host_reserve(100), 20)

    def test_only_anon_is_added_back_for_our_share(self):
        # Cache, slab (partly reclaimable) and shmem (accounting overlap) are
        # excluded so other apps are never understated.
        stat = {
            "anon": 4 * GIB,
            "shmem": GIB,
            "kernel": GIB // 2,
            "slab_reclaimable": GIB,
            "file": 30 * GIB,
        }
        self.assertEqual(guard.agent_hard_charge(stat), 4 * GIB)
        with self.assertRaises(guard.Refused):
            guard.agent_hard_charge({"file": 1})  # no anon field: fail closed

    def test_low_external_use_grants_the_aggregate_maximum(self):
        plan = guard.plan_cap(TOTAL, 40 * GIB, 0)  # other = 20 GiB, headroom 28
        self.assertEqual(plan["cap"], guard.AGG_MAX)
        self.assertEqual(plan["other"], 20 * GIB)

    def test_high_external_use_shrinks_the_grant_to_the_80_percent_ceiling(self):
        plan = guard.plan_cap(TOTAL, 25 * GIB, 0)  # other = 35, headroom 13
        self.assertEqual(plan["cap"], 13 * GIB)
        # Same thing in closed form: H + (available - reserve).
        self.assertEqual(plan["headroom"], 0 + 25 * GIB - 12 * GIB)

    def test_our_own_anonymous_use_is_not_billed_to_other_apps(self):
        # 48 GiB used in total, 8 GiB of it ours: other = 40, headroom = 8.
        plan = guard.plan_cap(TOTAL, 12 * GIB, 8 * GIB)
        self.assertEqual(plan["other"], 40 * GIB)
        self.assertEqual(plan["cap"], 8 * GIB)

    def test_exactly_eighty_percent_used_by_others_refuses(self):
        with self.assertRaises(guard.Refused):
            guard.plan_cap(TOTAL, 12 * GIB, 0)
        with self.assertRaises(guard.Refused):
            guard.plan_cap(TOTAL, 5 * GIB, 0)  # past the ceiling

    def test_smallest_workable_grant_is_one_job(self):
        guard.plan_cap(TOTAL, 18 * GIB, 0)  # headroom exactly 6 GiB
        with self.assertRaises(guard.Refused):
            guard.plan_cap(TOTAL, 18 * GIB - MIB, 0)

    def test_cap_never_exceeds_the_remaining_ceiling_or_aggregate_max(self):
        for available in range(0, 61):
            for hard in (0, 3, 9):
                try:
                    plan = guard.plan_cap(TOTAL, available * GIB, hard * GIB)
                except guard.Refused:
                    continue
                used_if_full = plan["other"] + plan["cap"]
                self.assertLessEqual(plan["cap"], guard.AGG_MAX)
                self.assertLessEqual(used_if_full, guard.host_ceiling(TOTAL))
                self.assertEqual(plan["cap"] % MIB, 0)
                self.assertLess(plan["high"], plan["cap"])

    def test_unsafe_shrink_keeps_the_current_cap_and_is_flagged(self):
        # Wanted cap 8 GiB, but our charges are 10 GiB (+1 GiB margin).
        plan = guard.plan_cap(TOTAL, 10 * GIB, 10 * GIB, current=24 * GIB)
        self.assertTrue(plan["deferred"])
        self.assertEqual(plan["cap"], 24 * GIB)
        self.assertEqual(plan["desired"], 8 * GIB)

    def test_shrink_floor_is_actual_memory_current_not_just_anon(self):
        # anon is only 2 GiB but dirty/unreclaimable cache makes memory.current 9 GiB.
        plan = guard.plan_cap(
            TOTAL, 18 * GIB, 2 * GIB, current=24 * GIB, charge=9 * GIB
        )
        self.assertTrue(plan["deferred"])
        self.assertEqual(plan["cap"], 24 * GIB)
        ok = guard.plan_cap(TOTAL, 18 * GIB, 2 * GIB, current=24 * GIB, charge=7 * GIB)
        self.assertFalse(ok["deferred"])
        self.assertEqual(ok["cap"], 8 * GIB)

    def test_safe_shrink_and_regrowth_are_applied(self):
        shrink = guard.plan_cap(TOTAL, 18 * GIB, 2 * GIB, current=24 * GIB)
        self.assertFalse(shrink["deferred"])
        self.assertEqual(shrink["cap"], 8 * GIB)
        grow = guard.plan_cap(TOTAL, 40 * GIB, 2 * GIB, current=12 * GIB)
        self.assertEqual(grow["cap"], guard.AGG_MAX)

    def test_watchdog_tightens_only_past_hysteresis_and_above_charges(self):
        # Plenty of room: nothing to do.
        self.assertIsNone(guard.tighten_target(TOTAL, 40 * GIB, 0, 24 * GIB))
        # Others grow: headroom 13 GiB -> shrink from 24 GiB to 13 GiB.
        self.assertEqual(guard.tighten_target(TOTAL, 25 * GIB, 0, 24 * GIB), 13 * GIB)
        # Within 1 GiB of the current cap: do not flap.
        self.assertIsNone(
            guard.tighten_target(TOTAL, 25 * GIB, 0, 13 * GIB + 512 * MIB)
        )
        # Never below hard charge + 1 GiB, even when headroom is smaller.
        self.assertEqual(
            guard.tighten_target(TOTAL, 10 * GIB, 10 * GIB, 24 * GIB), 11 * GIB
        )
        # Nor below actual memory.current + 1 GiB.
        self.assertEqual(
            guard.tighten_target(TOTAL, 25 * GIB, 0, 24 * GIB, 15 * GIB), 16 * GIB
        )
        # Never below one job.
        self.assertEqual(guard.tighten_target(TOTAL, 0, 0, 24 * GIB), guard.JOB_MAX)

    def test_pressure_stop_uses_the_dynamic_reserve(self):
        with (
            mock.patch.object(guard, "work_group", return_value=None),
            mock.patch.object(guard, "call") as call,
        ):
            # Stop threshold = 20% reserve + 1 GiB reaction margin.
            self.assertEqual(guard.stop_threshold(TOTAL), 13 * GIB)
            self.assertFalse(guard.stop_for_pressure(13 * GIB, TOTAL))
            call.assert_not_called()
            self.assertTrue(guard.stop_for_pressure(13 * GIB - 1, TOTAL))
            call.assert_called_once()
            # It scales with the host, not a fixed 12 GiB.
            at = guard.stop_threshold(64 * GIB)
            self.assertTrue(guard.stop_for_pressure(at - 1, 64 * GIB))
            self.assertFalse(guard.stop_for_pressure(at, 64 * GIB))

    def test_total_memory_is_read_from_meminfo(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "meminfo"
            p.write_text("MemTotal: 62914560 kB\nMemAvailable: 1 kB\n")
            self.assertEqual(guard.memory_total(p), 60 * GIB)
            p.write_text("MemAvailable: 1 kB\n")
            with self.assertRaises(guard.Refused):
                guard.memory_total(p)


class FakeSlice:
    """Stands in for the kernel/systemd; every file lives in a temp directory."""

    def __init__(self, root: Path, cap: int, anon: int, current: int | None = None):
        self.group = root / "user.slice/agent-work.slice"
        self.group.mkdir(parents=True)
        self.runtime = root / "run"
        self.runtime.mkdir(mode=0o700)
        self.write("memory.max", str(cap))
        self.write("memory.high", str(cap * 5 // 6))
        self.write("memory.swap.max", "0")
        self.write("cgroup.kill", "")
        self.write("memory.current", str(anon if current is None else current))
        self.write("memory.stat", f"anon {anon}\nkernel 0\nfile {40 * GIB}\n")
        self.commands = []
        self.tasks_max = str(guard.SLICE_TASKS_MAX)

    def write(self, name, value):
        (self.group / name).write_text(value)

    def call(self, *args, check=True):
        self.commands.append(args)
        if "set-property" in args:
            for item in args:
                if item.startswith("MemoryMax="):
                    self.write("memory.max", item.split("=")[1])
                if item.startswith("MemoryHigh="):
                    self.write("memory.high", item.split("=")[1])
                if item.startswith("TasksMax="):
                    self.tasks_max = item.split("=")[1]
        if "is-active" in args:
            return "active"
        return ""

    def properties(self, unit):
        return {
            "ControlGroup": "/user.slice/agent-work.slice",
            "MemoryMax": (self.group / "memory.max").read_text().strip(),
            "MemorySwapMax": "0",
            "TasksMax": self.tasks_max,
            "ActiveState": "active",
        }

    def patches(self, total, available, watchdog=True):
        return (
            mock.patch.object(guard, "new_watchdog_active", lambda: watchdog),
            mock.patch.object(guard, "CGROUP_ROOT", self.group.parents[1]),
            mock.patch.object(guard, "call", self.call),
            mock.patch.object(guard, "properties", self.properties),
            mock.patch.object(guard, "runtime_dir", lambda: self.runtime),
            mock.patch.object(guard, "memory_total", lambda *_: total),
            mock.patch.object(guard, "memory_available", lambda *_: available),
        )


class DynamicCapTest(unittest.TestCase):
    def run_enforce(self, cap, anon, available, watchdog=True):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeSlice(Path(tmp), cap, anon)
            with contextlib.ExitStack() as stack:
                for patch in fake.patches(TOTAL, available, watchdog):
                    stack.enter_context(patch)
                try:
                    plan = guard.enforce_slice()
                    error = None
                except guard.Refused as refusal:
                    plan, error = None, refusal
                after = int((fake.group / "memory.max").read_text())
                record = guard.read_record()
                report = guard.policy() if error is None else None
            return fake, plan, error, after, record, report

    def test_headroom_raises_the_live_cap_without_stopping_anything(self):
        fake, plan, error, after, record, report = self.run_enforce(
            12 * GIB, 0, 40 * GIB
        )
        self.assertIsNone(error)
        self.assertEqual(after, guard.AGG_MAX)
        self.assertEqual(record["capBytes"], after)
        self.assertTrue(report["ok"], report["problems"])
        verbs = {c[2] for c in fake.commands if c[:2] == ("systemctl", "--user")}
        self.assertNotIn("stop", verbs)
        self.assertNotIn("restart", verbs)
        runtime = [c for c in fake.commands if "set-property" in c]
        self.assertTrue(all("--runtime" in c for c in runtime))
        self.assertTrue(all("MemorySwapMax=0" in c for c in runtime))

    def test_cap_stays_at_boot_cap_until_the_new_watchdog_heartbeats(self):
        # The old watchdog's fixed 12 GiB stop is weaker than 20% of 60.4 GiB.
        fake, _, error, after, record, _ = self.run_enforce(
            12 * GIB, 0, 40 * GIB, watchdog=False
        )
        self.assertIsNone(error)
        self.assertEqual(after, guard.BOOT_CAP)
        self.assertEqual(record["capBytes"], guard.BOOT_CAP)

    def test_policy_flags_a_raised_cap_without_the_new_watchdog(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeSlice(Path(tmp), 24 * GIB, 0)
            with contextlib.ExitStack() as stack:
                for patch in fake.patches(TOTAL, 40 * GIB, watchdog=False):
                    stack.enter_context(patch)
                self.assertFalse(guard.policy()["ok"])

    def test_heartbeat_requires_current_policy_and_freshness(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp)
            with mock.patch.object(guard, "runtime_dir", lambda: runtime):
                self.assertFalse(guard.new_watchdog_active())
                guard.write_heartbeat()
                self.assertTrue(guard.new_watchdog_active())
                beat = runtime / "watchdog.json"
                data = json.loads(beat.read_text())
                beat.write_text(json.dumps({**data, "policy": 1}))
                self.assertFalse(guard.new_watchdog_active())
                beat.write_text(
                    json.dumps(
                        {**data, "time": data["time"] - guard.WATCHDOG_FRESH - 1}
                    )
                )
                self.assertFalse(guard.new_watchdog_active())

    def test_unsafe_shrink_refuses_admission_and_leaves_the_cap(self):
        fake, plan, error, after, _, _ = self.run_enforce(24 * GIB, 10 * GIB, 10 * GIB)
        self.assertIsNotNone(error)
        self.assertEqual(after, 24 * GIB)
        self.assertFalse([c for c in fake.commands if "set-property" in c])

    def test_exhausted_ceiling_refuses_admission(self):
        _, _, error, after, _, _ = self.run_enforce(12 * GIB, 0, 12 * GIB)
        self.assertIsNotNone(error)
        self.assertEqual(after, 12 * GIB)

    def test_policy_rejects_a_kernel_cap_that_differs_from_the_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeSlice(Path(tmp), 24 * GIB, 0)
            with contextlib.ExitStack() as stack:
                for patch in fake.patches(TOTAL, 40 * GIB):
                    stack.enter_context(patch)
                guard.enforce_slice()
                fake.write("memory.max", str(30 * GIB))
                report = guard.policy()
                self.assertFalse(report["ok"])
                fake.write("memory.max", str(24 * GIB))
                fake.write("memory.swap.max", "max")
                self.assertFalse(guard.policy()["ok"])

    def test_policy_without_a_record_accepts_only_the_boot_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeSlice(Path(tmp), 12 * GIB, 0)
            with contextlib.ExitStack() as stack:
                for patch in fake.patches(TOTAL, 40 * GIB):
                    stack.enter_context(patch)
                self.assertTrue(guard.policy()["ok"])
                fake.write("memory.max", str(13 * GIB))
                self.assertFalse(guard.policy()["ok"])
                fake.write("memory.max", "max")
                self.assertFalse(guard.policy()["ok"])

    def test_per_job_limits_are_unchanged_by_the_larger_aggregate(self):
        self.assertEqual(guard.JOB_MAX, 6 * GIB)
        self.assertEqual(guard.SERVICE_MAX, GIB)
        self.assertEqual(guard.AGG_MAX, 24 * GIB)
        self.assertLessEqual(guard.BOOT_CAP, guard.AGG_MAX)


class ReassertTest(unittest.TestCase):
    UNIT_DEFAULT = 12 * GIB  # what a daemon-reload restores from agent-work.slice

    def setup(self, stack, tmp, kernel=24 * GIB, props_max=24 * GIB, record=True):
        """Kernel cap `kernel`, recorded cap 24 GiB; systemd reports `props_max` until a
        set-property runs (then it follows the kernel files)."""
        fake = FakeSlice(Path(tmp), kernel, 0)
        for patch in fake.patches(TOTAL, 40 * GIB):
            stack.enter_context(patch)
        stack.enter_context(mock.patch.object(guard, "work_group", lambda: fake.group))
        if record:
            (fake.runtime / "aggregate-cap.json").write_text(
                json.dumps({"capBytes": 24 * GIB})
            )
        fake.stale = {"MemoryMax": str(props_max)}
        live = fake.properties

        def properties(unit):
            reported = live(unit)
            if fake.stale and not any("set-property" in c for c in fake.commands):
                reported.update(fake.stale)
            return reported

        stack.enter_context(mock.patch.object(guard, "properties", properties))
        return fake

    def sets(self, fake):
        return [c for c in fake.commands if "set-property" in c]

    def test_kernel_cap_drift_is_reapplied_through_apply_cap(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp, kernel=self.UNIT_DEFAULT)
            self.assertTrue(guard.reassert_slice())
            (command,) = self.sets(fake)
            self.assertIn(f"TasksMax={guard.SLICE_TASKS_MAX}", command)
            self.assertEqual((fake.group / "memory.max").read_text(), str(24 * GIB))
            self.assertNotIn("start", {c[2] for c in fake.commands})

    def test_systemd_unit_default_is_reapplied_at_the_property_check(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp, props_max=self.UNIT_DEFAULT)
            self.assertTrue(guard.reassert_slice())  # cheap check: kernel matches
            self.assertEqual(self.sets(fake), [])
            self.assertTrue(guard.reassert_slice(check_properties=True))
            self.assertEqual(len(self.sets(fake)), 1)

    def test_wrong_tasks_max_is_reapplied_at_the_property_check(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp)
            fake.stale = {"TasksMax": "512"}
            guard.reassert_slice(check_properties=True)
            self.assertEqual(len(self.sets(fake)), 1)

    def test_matching_limits_leave_the_slice_alone(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp)
            fake.stale = {}
            self.assertTrue(guard.reassert_slice(check_properties=True))
            self.assertEqual(fake.commands, [])

    def test_no_record_or_inactive_slice_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp, kernel=self.UNIT_DEFAULT, record=False)
            self.assertTrue(guard.reassert_slice(check_properties=True))
            self.assertEqual(fake.commands, [])
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp, props_max=self.UNIT_DEFAULT)
            fake.stale = {"ActiveState": "inactive"}
            self.assertTrue(guard.reassert_slice(check_properties=True))
            self.assertEqual(fake.commands, [])

    def test_failures_are_reported_and_never_stop_anything(self):
        errors = (
            guard.Refused("busy"),
            ValueError("bad"),
            OSError("gone"),
            subprocess.CalledProcessError(1, "systemctl"),
        )
        for error in errors:
            with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
                fake = self.setup(stack, tmp, kernel=self.UNIT_DEFAULT)
                stack.enter_context(
                    mock.patch.object(guard, "apply_cap", side_effect=error)
                )
                self.assertFalse(guard.reassert_slice())
                self.assertFalse([c for c in fake.commands if "stop" in c])

    def test_a_busy_cap_lock_skips_the_round(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp, kernel=self.UNIT_DEFAULT)
            stack.enter_context(
                mock.patch.object(guard, "cap_lock", side_effect=guard.Refused("busy"))
            )
            self.assertFalse(guard.reassert_slice())
            self.assertEqual(fake.commands, [])

    def test_unreadable_kernel_cap_does_not_raise(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp)
            fake.write("memory.max", "garbage")
            self.assertFalse(guard.reassert_slice())

    def test_enforce_slice_reapplies_when_systemd_reports_the_unit_default(self):
        # Kernel already at the recorded cap; only systemd's view regressed.
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp, props_max=self.UNIT_DEFAULT)
            guard.enforce_slice()
            (command,) = self.sets(fake)
            self.assertIn(f"TasksMax={guard.SLICE_TASKS_MAX}", command)

    def test_enforce_slice_skips_set_property_when_everything_matches(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp)
            fake.stale = {}
            guard.enforce_slice()
            self.assertEqual(self.sets(fake), [])

    def test_tasks_max_mismatch_warns_but_never_refuses_admission(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            fake = self.setup(stack, tmp, kernel=self.UNIT_DEFAULT)
            live = fake.properties
            stack.enter_context(
                mock.patch.object(
                    guard, "properties", lambda unit: {**live(unit), "TasksMax": "512"}
                )
            )
            guard.enforce_slice()  # set-property cannot fix tasks here: no Refused
            self.assertEqual(len(self.sets(fake)), 1)
            report = guard.policy()
            self.assertTrue(report["ok"], report["problems"])
            self.assertEqual(len(report["warnings"]), 1)
            self.assertIn("512", report["warnings"][0])
            self.assertEqual(guard.status_record()["warnings"], report["warnings"])


class WatchLoopTest(unittest.TestCase):
    class Stop(Exception):
        pass

    def run_watch(self, clocks, available=40 * GIB, reassert=True):
        clock = iter(clocks)
        sleeps = iter([None] * (len(clocks) - 1))

        def sleep(_):
            if next(sleeps, "stop") == "stop":
                raise self.Stop

        fake_time = SimpleNamespace(monotonic=lambda: next(clock), sleep=sleep)
        calls = []
        with contextlib.ExitStack() as stack:
            for name in ("reap_orphans", "write_heartbeat", "tighten_cap"):
                stack.enter_context(mock.patch.object(guard, name, mock.Mock()))
            self.pressure = mock.Mock()
            stack.enter_context(
                mock.patch.object(guard, "stop_for_pressure", self.pressure)
            )
            stack.enter_context(mock.patch.object(guard, "time", fake_time))
            stack.enter_context(
                mock.patch.object(guard, "memory_available", lambda *_: available)
            )
            stack.enter_context(
                mock.patch.object(guard, "memory_total", lambda *_: TOTAL)
            )
            stack.enter_context(
                mock.patch.object(guard, "call", lambda *a, **k: calls.append(a) or "")
            )
            mocked = stack.enter_context(
                mock.patch.object(
                    guard, "reassert_slice", mock.Mock(return_value=reassert)
                )
            )
            with self.assertRaises(self.Stop):
                guard.watch()
        return mocked, calls

    def test_cheap_check_every_loop_property_check_every_interval(self):
        mocked, _ = self.run_watch([100.0, 100.5, 101.0, 131.0])
        flags = [c.kwargs["check_properties"] for c in mocked.call_args_list]
        self.assertEqual(flags, [True, False, False, True])

    def test_a_failed_reassert_is_retried_only_after_the_interval_and_stops_nothing(
        self,
    ):
        mocked, calls = self.run_watch([100.0, 100.5, 101.0, 131.5], reassert=False)
        self.assertEqual(mocked.call_count, 2)
        self.assertFalse([c for c in calls if "stop" in c])

    def test_no_reassert_while_under_memory_pressure(self):
        mocked, _ = self.run_watch([100.0, 101.0], available=1 * GIB)
        mocked.assert_not_called()
        self.pressure.assert_called()


class PidsReportTest(unittest.TestCase):
    def test_reads_pid_and_memory_counters(self):
        with tempfile.TemporaryDirectory() as tmp:
            group = Path(tmp)
            (group / "pids.current").write_text("17\n")
            (group / "pids.max").write_text("max\n")
            (group / "pids.events").write_text("max 717\n")
            (group / "memory.events").write_text("low 0\nhigh 3\nmax 1\noom 1\n")
            report = guard.pids_report(group)
        self.assertEqual(report["pidsCurrent"], 17)
        self.assertEqual(report["pidsMax"], "max")
        self.assertEqual(report["pidsEvents"], {"max": 717})
        self.assertEqual(report["memoryEvents"]["high"], 3)

    def test_missing_files_give_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = guard.pids_report(Path(tmp))
        self.assertEqual(
            report,
            {
                "pidsCurrent": None,
                "pidsMax": None,
                "pidsEvents": None,
                "memoryEvents": None,
            },
        )

    def test_status_record_and_policy_include_the_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = FakeSlice(Path(tmp), 24 * GIB, 0)
            fake.write("pids.current", "5")
            fake.write("pids.max", "8192")
            fake.write("pids.events", "max 0")
            fake.write("memory.events", "oom 0")
            with contextlib.ExitStack() as stack:
                for patch in fake.patches(TOTAL, 40 * GIB):
                    stack.enter_context(patch)
                stack.enter_context(
                    mock.patch.object(guard, "android_processes", lambda: [])
                )
                record = guard.status_record()
                report = guard.policy()
        self.assertEqual(record["pids"]["pidsMax"], 8192)
        self.assertEqual(record["memoryEvents"], {"oom": 0})
        self.assertEqual(report["pids"]["pidsCurrent"], 5)


if __name__ == "__main__":
    unittest.main()
