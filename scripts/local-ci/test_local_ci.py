"""Tests for the local CI gate. They use throwaway Git repositories, a fake
guard proof and tiny stage files; they never start the real suites, Docker or
any service, and never touch the checkout they run from."""

from __future__ import annotations

import contextlib
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

os.environ["FLOWLOG"] = "off"  # never write the real flow database from a test
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import install as installer  # noqa: E402
import local_ci  # noqa: E402

GIB = local_ci.GIB
FAKE_GUARD = {
    "scope": "agent-lane-ci-0123abcd.scope",
    "slice": local_ci.SLICE,
    "memoryMaxBytes": 6 * GIB,
    "sliceMemoryMaxBytes": 12 * GIB,
    "swapMaxBytes": 0,
    "cgroup": "/nonexistent",
}
FAKE_SERVICE = lambda role, port: {  # noqa: E731
    "role": role,
    "port": port,
    "scope": f"agent-service-{role}.scope",
    "pids": 1,
    "memoryMaxBytes": GIB,
    "swapMaxBytes": 0,
}
SECRET = "synthetic-secret-value-123"
FIXTURE_ENV = f"""CATALOG_TEST_ADMIN_URL=postgresql://bootstrap@127.0.0.1:54340/postgres
CATALOG_TEST_OWNER_URL=postgresql://migration_owner:{SECRET}@127.0.0.1:54340/postgres
CATALOG_TEST_APP_URL=postgresql://stateaction_app:{SECRET}@127.0.0.1:54340/postgres
STORAGE_TEST_ENDPOINT=http://127.0.0.1:19000
STORAGE_TEST_ACCESS_KEY_ID=stateaction-local
STORAGE_TEST_SECRET_ACCESS_KEY={SECRET}
GITHUB_TOKEN=must-not-be-forwarded
"""


def sh(repo: Path, *args: str, check=True) -> str:
    result = subprocess.run(args, cwd=repo, capture_output=True, text=True)
    if check and result.returncode:
        raise AssertionError(f"{args}: {result.stderr}")
    return result.stdout.strip()


def stage(stage_id: str, code: str, **extra) -> dict:
    return {
        "id": stage_id,
        "title": stage_id,
        "timeoutSec": extra.pop("timeoutSec", 30),
        "argv": [sys.executable, "-c", textwrap.dedent(code)],
        **extra,
    }


class RepoCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="local-ci-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.home = self.tmp / "home"
        self.repo.mkdir()
        sh(self.repo, "git", "init", "-q", "-b", "main")
        sh(self.repo, "git", "config", "user.email", "t@example.invalid")
        sh(self.repo, "git", "config", "user.name", "T")
        sh(self.repo, "git", "config", "commit.gpgsign", "false")
        (self.repo / "scripts/local-ci").mkdir(parents=True)
        shutil.copy(HERE / "local_ci.py", self.repo / "scripts/local-ci/local_ci.py")
        (self.repo / "app.txt").write_text("one\n")
        self.set_stages([stage("ok", "print('ok')")])
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-qm", "base")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")

    def set_stages(self, stages, unautomated=None, **spec_extra):
        spec = {
            "schema": local_ci.STAGES_SCHEMA,
            "pins": {"node": "24.22.2", "pnpm": "10.33.0", "uv": ""},
            "stages": stages,
            "unautomated": unautomated or ["physical device"],
            **spec_extra,
        }
        (self.repo / local_ci.STAGES_PATH).write_text(json.dumps(spec))

    def commit_pending(self, message="change"):
        sh(self.repo, "git", "add", "-A")
        if sh(self.repo, "git", "diff", "--cached", "--name-only"):
            sh(self.repo, "git", "commit", "-qm", message)

    def run_tree(self, **kwargs):
        """Commit whatever the test staged, then gate the clean HEAD (tree mode)."""
        self.commit_pending()
        kwargs.setdefault("probe_fixtures", False)
        kwargs.setdefault(
            "probe_ports", False
        )  # never depend on real ports in unit tests
        kwargs.setdefault("log", lambda _m: None)
        # never share port-block locks with a real gate on this machine
        kwargs.setdefault("port_locks", self.tmp / "port-locks")
        return local_ci.run_pipeline(
            self.repo,
            home=self.home,
            guard=FAKE_GUARD,
            **kwargs,
        )

    def stage_change(self, text="two\n"):
        (self.repo / "app.txt").write_text(text)
        sh(self.repo, "git", "add", "app.txt")

    def receipts(self):
        return (
            sorted((self.home / "receipts").glob("*.json"))
            if (self.home / "receipts").exists()
            else []
        )


class ParallelSlotTests(RepoCase):
    """SA-108: concurrent gates on different trees share no mutable state."""

    def test_slots_are_exclusive_numbered_and_released(self):
        home = local_ci.private_dir(self.home)
        first = local_ci.acquire_slot(home)
        second = local_ci.acquire_slot(home)
        third = local_ci.acquire_slot(home)
        self.assertEqual([first[1], second[1], third[1]], [0, 1, 2])
        with self.assertRaisesRegex(local_ci.Refused, "owns this CI home"):
            local_ci.acquire_slot(home)
        os.close(second[0])  # a finished run frees exactly its own slot
        again = local_ci.acquire_slot(home)
        self.assertEqual(again[1], 1)
        for fd, _ in (first, third, again):
            os.close(fd)
        self.assertEqual(local_ci.acquire_slot(home, parallel=1)[1], 0)

    def test_slot_state_is_disjoint_and_slot_zero_keeps_the_historical_names(self):
        dirs = [local_ci.slot_dirs(self.home, n) for n in range(local_ci.MAX_PARALLEL)]
        self.assertEqual(dirs[0][0].name, "current")
        self.assertEqual(dirs[0][1].name, "nx-cache")
        self.assertEqual(dirs[0][2].name, "nx-workspace-data")
        flat = [str(path) for group in dirs for path in group]
        self.assertEqual(len(flat), len(set(flat)), "every slot owns its own dirs")
        for group in dirs:  # a slot's export and Nx state never nest inside another's
            for other in dirs:
                if group is not other:
                    for a in group:
                        for b in other:
                            self.assertNotIn(a, b.parents)

    def test_slot_ports_are_disjoint_below_the_ephemeral_range_and_avoid_dev_ports(
        self,
    ):
        seen: dict[str, int] = {}
        for slot in range(local_ci.MAX_PORT_BLOCKS):
            ports = local_ci.slot_ports(slot)
            self.assertEqual(ports["STATEACTION_CI_PORT_BLOCK"], str(slot))
            for key, value in ports.items():
                if not key.endswith("_PORT"):
                    continue
                number = int(value)
                self.assertLess(number, 32768, key)
                self.assertNotIn(number, (3000, 8120, 8150, 10050, 19000, 54340))
                self.assertNotIn(number, seen, f"{key} of slot {slot} collides")
                seen[number] = slot
        self.assertEqual(len(seen), 4 * local_ci.MAX_PORT_BLOCKS)

    def test_an_occupied_port_fails_the_run_before_any_stage(self):
        with socket.socket() as busy:
            busy.bind(("0.0.0.0", 0))
            busy.listen()
            port = busy.getsockname()[1]
            ports = {
                "STATEACTION_CI_PORT_BLOCK": "1",
                "STATEACTION_CI_PORT_BASE": str(port),
                "CI_SMOKE_WEB_PORT": str(port),
            }
            with self.assertRaisesRegex(local_ci.Refused, f"Port {port}.*port block 1"):
                local_ci.check_ports_free(ports)
        local_ci.check_ports_free(ports)  # free again once the foreign listener is gone

    def test_a_run_beside_another_gets_its_own_slot_export_tmp_cache_and_ports(self):
        seen = self.tmp / "env.json"
        code = f"""
            import json, os
            keys = ('TMPDIR', 'NX_CACHE_DIRECTORY', 'NX_WORKSPACE_DATA_DIRECTORY',
                    'STATEACTION_CI_PORT_BLOCK', 'HOSTED_SMOKE_WEB_PORT',
                    'HOSTED_SMOKE_RUNNER_PORT', 'CI_SMOKE_WEB_PORT', 'CI_SMOKE_RUNNER_PORT')
            data = {{k: os.environ[k] for k in keys}}
            data['cwd'] = os.getcwd()
            open({str(seen)!r}, 'a').write(json.dumps(data) + chr(10))
        """
        self.set_stages([stage("show", code)])
        alone = self.run_tree()
        beside_fd, beside_slot = local_ci.acquire_slot(local_ci.private_dir(self.home))
        beside_ports, beside_block = local_ci.acquire_port_block(
            self.tmp / "port-locks"
        )
        try:
            self.assertEqual((beside_slot, beside_block), (0, 0))
            second = (
                self.run_tree()
            )  # a gate holds slot 0 and block 0: this takes 1 and 1
        finally:
            os.close(beside_fd)
            os.close(beside_ports)
        self.assertEqual(alone["verdict"], "PASS")
        self.assertEqual(second["verdict"], "PASS")
        self.assertEqual(alone["isolation"]["slot"], 0)
        self.assertEqual(second["isolation"]["slot"], 1)
        one, two = (json.loads(line) for line in seen.read_text().splitlines())
        for key in one:
            self.assertNotEqual(one[key], two[key], f"{key} shared by both slots")
        self.assertEqual(two["STATEACTION_CI_PORT_BLOCK"], "1")
        self.assertEqual(second["isolation"]["portBlock"], 1)
        a, b = alone["isolation"], second["isolation"]
        for key in ("export", "tmp", "nxCache", "nxWorkspaceData"):
            self.assertNotEqual(a[key], b[key], key)
        self.assertFalse(set(a["ports"].values()) & set(b["ports"].values()))
        self.assertNotEqual(alone["runId"], second["runId"])
        self.assertNotEqual(alone["logDir"], second["logDir"])
        self.assertEqual(one["TMPDIR"], a["tmp"])
        self.assertEqual(two["TMPDIR"], b["tmp"])

    def test_port_blocks_are_machine_wide_and_exclusive_across_ci_homes(self):
        locks = self.tmp / "port-locks"
        held = [
            local_ci.acquire_port_block(locks) for _ in range(local_ci.MAX_PORT_BLOCKS)
        ]
        self.assertEqual(
            [block for _, block in held], list(range(local_ci.MAX_PORT_BLOCKS))
        )
        with self.assertRaisesRegex(local_ci.Refused, "port block"):
            local_ci.acquire_port_block(locks)
        os.close(held[2][0])
        fd, block = local_ci.acquire_port_block(locks)
        self.assertEqual(block, 2)
        for other in (fd, *(f for f, b in held if b != 2)):
            os.close(other)

    def test_the_same_tree_is_never_gated_twice_at_once_and_keeps_its_receipt(self):
        self.commit_pending()
        tree = local_ci.current_tree(self.repo, "HEAD")
        first = self.run_tree()
        self.assertEqual(first["verdict"], "PASS")
        receipt = self.home / "receipts" / f"{tree}.json"
        before = receipt.read_bytes()
        fd = local_ci.acquire_tree_lock(local_ci.private_dir(self.home), tree)
        try:
            with self.assertRaisesRegex(local_ci.Refused, "already being gated"):
                self.run_tree()
            # the refused run did not invalidate the receipt or touch the attempt record
            self.assertEqual(receipt.read_bytes(), before)
            attempt = json.loads((self.home / "attempts" / f"{tree}.json").read_text())
            self.assertEqual(attempt["runId"], first["runId"])
            self.assertEqual(
                local_ci.acquire_slot(local_ci.private_dir(self.home))[1], 0
            )  # and it gave its slot back
        finally:
            os.close(fd)
        self.assertEqual(self.run_tree()["verdict"], "PASS")  # free again

    def test_a_run_called_from_an_except_block_does_not_double_close_the_tree_lock(
        self,
    ):
        try:
            raise ValueError("an unrelated exception is being handled")
        except ValueError:
            record = (
                self.run_tree()
            )  # sys.exc_info() is set here, but nothing propagates
        self.assertEqual(record["verdict"], "PASS")
        probe = os.open(
            os.devnull, os.O_RDONLY
        )  # a double close could have freed/reused fds
        os.close(probe)
        tree = local_ci.current_tree(self.repo, "HEAD")
        os.close(local_ci.acquire_tree_lock(local_ci.private_dir(self.home), tree))

    def test_a_run_that_dies_while_preparing_releases_every_lock(self):
        with mock.patch.object(local_ci, "make_shims", side_effect=OSError("disk")):
            with self.assertRaisesRegex(OSError, "disk"):
                self.run_tree()
        tree = local_ci.current_tree(self.repo, "HEAD")
        home = local_ci.private_dir(self.home)
        for fd in (
            local_ci.acquire_slot(home)[0],
            local_ci.acquire_tree_lock(home, tree),
            local_ci.acquire_port_block(self.tmp / "port-locks")[0],
        ):
            os.close(fd)

    def test_db_connection_budget_is_shared_all_or_nothing_and_released(self):
        locks = self.tmp / "db-locks"
        cap = local_ci.DB_BUDGET
        first = local_ci.acquire_db_budget(cap // 2, locks)
        second = local_ci.acquire_db_budget(cap - cap // 2, locks)  # exactly the rest
        self.assertEqual(len(first) + len(second), cap)
        ticks = []
        with self.assertRaisesRegex(local_ci.Refused, "Timed out"):
            local_ci.acquire_db_budget(
                1,
                locks,
                timeout=1.0,
                clock=lambda: float(len(ticks)),
                pause=lambda _s: ticks.append(1),
            )
        for fd in first:
            os.close(fd)
        # a gate asking for more than is free holds NOTHING while it waits
        part = local_ci.acquire_db_budget(
            cap // 2, locks, timeout=0
        )  # takes the freed half
        for fd in part:
            os.close(fd)
        self.assertEqual(len(first), len(part))
        with self.assertRaisesRegex(local_ci.Refused, "budget is"):
            local_ci.acquire_db_budget(cap + 1, locks)
        for fd in second:
            os.close(fd)
        again = local_ci.acquire_db_budget(cap, locks)  # everything free again
        for fd in again:
            os.close(fd)

    def test_waiting_for_the_budget_can_be_cancelled(self):
        locks = self.tmp / "db-locks"
        held = local_ci.acquire_db_budget(local_ci.DB_BUDGET, locks)
        try:
            with self.assertRaises(local_ci.Interrupted):
                local_ci.acquire_db_budget(
                    1, locks, cancelled=lambda: True, pause=lambda _s: None
                )
        finally:
            for fd in held:
                os.close(fd)

    def test_every_fixture_stage_declares_a_connection_peak_within_the_budget(self):
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        total = 0
        for item in spec["stages"]:
            if item.get("fixtures"):
                units = item.get("dbConnections")
                self.assertIsInstance(units, int, item["id"])
                self.assertTrue(0 < units <= local_ci.DB_BUDGET, item["id"])
                total = max(total, units)
        # the shared fixture's definition is the limit: 3 reserved for superusers, and at least
        # 25 connections stay for other agents' Free runs
        source = (HERE.parent / "platform/bounded-fixtures.py").read_text()
        limit = int(re.search(r"^POSTGRES_MAX_CONNECTIONS = (\d+)$", source, re.M)[1])
        self.assertEqual(limit, 100)
        self.assertIn('f"max_connections={POSTGRES_MAX_CONNECTIONS}"', source)
        self.assertLessEqual(local_ci.DB_BUDGET, limit - 3 - 25)
        # three gates at the largest single-stage peak never wait on each other for connections
        self.assertGreaterEqual(local_ci.DB_BUDGET, 3 * total)

    def test_two_real_gate_processes_at_once_share_nothing_and_both_pass(self):
        """The two-slot dry run: two runner processes on two different trees overlap (each
        waits, bounded, until the other is inside its stage) and own disjoint resources."""
        marks = self.tmp / "marks"
        marks.mkdir()
        code = f"""
            import json, os, pathlib, time
            slot = os.environ['STATEACTION_CI_PORT_BLOCK']
            marks = pathlib.Path({str(marks)!r})
            (marks / ('in-' + slot)).write_text('1')
            end = time.monotonic() + 30
            while len(list(marks.glob('in-*'))) < 2:
                assert time.monotonic() < end, 'the other gate never overlapped'
                time.sleep(0.05)
            keys = ('TMPDIR', 'NX_CACHE_DIRECTORY', 'HOSTED_SMOKE_WEB_PORT', 'CI_SMOKE_WEB_PORT')
            (marks / ('env-' + slot)).write_text(json.dumps({{k: os.environ[k] for k in keys}}))
        """
        self.set_stages([stage("overlap", code)])
        self.commit_pending()
        other = self.tmp / "repo2"
        shutil.copytree(self.repo, other)
        (other / "app.txt").write_text("a different tree\n")
        sh(other, "git", "add", "-A")
        sh(other, "git", "commit", "-qm", "second tree")
        results = self.tmp / "results"
        results.mkdir()
        procs = []
        for n, repo in enumerate((self.repo, other)):
            script = (
                "import json, sys; sys.path.insert(0, %r); import local_ci; "
                "r = local_ci.run_pipeline(%r, home=%r, guard=%r, probe_ports=False, "
                "port_locks=%r, log=lambda m: None); "
                "open(%r, 'w').write(json.dumps({'v': r['verdict'], 'iso': r['isolation'], "
                "'run': r['runId'], 'tree': r['tree']}))"
            ) % (
                str(HERE),
                str(repo),
                str(self.home),
                FAKE_GUARD,
                str(self.tmp / "port-locks"),
                str(results / f"{n}.json"),
            )
            proc = subprocess.Popen([sys.executable, "-c", script])
            self.addCleanup(lambda p=proc: p.poll() is None and p.kill())
            procs.append(proc)
        self.assertEqual([p.wait(timeout=120) for p in procs], [0, 0])
        one, two = (json.loads((results / f"{n}.json").read_text()) for n in (0, 1))
        self.assertEqual((one["v"], two["v"]), ("PASS", "PASS"))
        self.assertEqual({one["iso"]["slot"], two["iso"]["slot"]}, {0, 1})
        self.assertEqual({one["iso"]["portBlock"], two["iso"]["portBlock"]}, {0, 1})
        for key in ("export", "tmp", "nxCache", "nxWorkspaceData"):
            self.assertNotEqual(one["iso"][key], two["iso"][key], key)
        self.assertFalse(
            set(one["iso"]["ports"].values()) & set(two["iso"]["ports"].values())
        )
        self.assertNotEqual((one["run"], one["tree"]), (two["run"], two["tree"]))
        env = [json.loads(p.read_text()) for p in sorted(marks.glob("env-*"))]
        for key in env[0]:
            self.assertNotEqual(env[0][key], env[1][key], key)

    def test_ci_smoke_uses_the_per_run_ports_not_3000_and_8120(self):
        source = (HERE.parents[1] / "scripts/platform/ci-smoke.sh").read_text()
        for needle in (
            'WEB_PORT="${CI_SMOKE_WEB_PORT:-3000}"',
            'RUNNER_PORT="${CI_SMOKE_RUNNER_PORT:-8120}"',
            'PORT="$WEB_PORT" setsid pnpm dev',
            'workflows dev --port "$RUNNER_PORT"',
            'tasks list --local --port "$RUNNER_PORT"',
        ):
            self.assertIn(needle, source)
        self.assertNotIn("127.0.0.1:3000/api", source)
        self.assertNotIn("for port in (3000, 8120)", source)

    def smoke_copy(self):
        """The script in a scratch tree whose `.env` already exists: it gets past the port
        probe and then refuses at the `.env` guard, touching nothing."""
        root = self.tmp / "smoke"
        script = root / "scripts/platform/ci-smoke.sh"
        script.parent.mkdir(parents=True)
        shutil.copy(HERE.parents[1] / "scripts/platform/ci-smoke.sh", script)
        (root / ".env").write_text("keep\n")
        return root, script

    def test_ci_smoke_probes_exactly_its_own_ports(self):
        root, script = self.smoke_copy()
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("STATEACTION_", "E2E_"))
        }

        def smoke(web, runner):
            env.update(CI_SMOKE_WEB_PORT=str(web), CI_SMOKE_RUNNER_PORT=str(runner))
            return subprocess.run(
                ["bash", str(script)], env=env, capture_output=True, text=True
            )

        with (
            socket.socket() as web,
            socket.socket() as runner,
            socket.socket() as spare,
        ):
            for sock in (web, runner, spare):
                sock.bind(("127.0.0.1", 0))
            wp, rp, sp = (s_.getsockname()[1] for s_ in (web, runner, spare))
            spare.close()  # sp is a free port now
            busy = smoke(wp, sp)
            self.assertNotEqual(busy.returncode, 0)
            self.assertIn(f"port {wp}", busy.stderr)
            busy = smoke(sp, rp)
            self.assertNotEqual(busy.returncode, 0)
            self.assertIn(f"port {rp}", busy.stderr)
        # Both ports free (the default 3000/8120 may be taken by anyone: not our business).
        free = smoke(wp, rp)
        self.assertIn("Refusing to replace an existing .env", free.stderr)
        self.assertEqual((root / ".env").read_text(), "keep\n")


class GuardTests(RepoCase):
    def fake_cgroup(
        self,
        scope="agent-lane-ci-0123abcd.scope",
        memory="6442450944",
        swap="0",
        slice_memory="12884901888",
    ):
        root = Path(tempfile.mkdtemp(prefix="local-ci-cg-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        relative = f"user.slice/user@1.service/{local_ci.SLICE}/{scope}"
        group = root / "sys" / relative
        group.mkdir(parents=True)
        (group / "memory.max").write_text(memory + "\n")
        (group / "memory.swap.max").write_text(swap + "\n")
        (group.parent / "memory.max").write_text(slice_memory + "\n")
        (group.parent / "memory.swap.max").write_text("0\n")
        proc = root / "proc/self"
        proc.mkdir(parents=True)
        (proc / "cgroup").write_text(f"0::/{relative}\n")
        return root / "proc", root / "sys"

    def test_enforced_scope_is_accepted(self):
        proc, sys_root = self.fake_cgroup()
        proof = local_ci.guard_proof(proc, sys_root)
        self.assertEqual(proof["memoryMaxBytes"], 6 * GIB)
        self.assertEqual(proof["swapMaxBytes"], 0)

    def test_every_slot_scope_of_the_ci_lane_is_accepted(self):
        for scope in (
            "agent-lane-ci-0123abcd.scope",
            "agent-lane-ci-0123abcd-s1.scope",
            "agent-lane-ci-0123abcd-s2.scope",
        ):
            proc, sys_root = self.fake_cgroup(scope=scope)
            self.assertEqual(local_ci.guard_proof(proc, sys_root)["scope"], scope)
        for scope in (
            "agent-lane-ci-0123abcd-s0.scope",
            "agent-lane-ci-0123abcd-x.scope",
        ):
            proc, sys_root = self.fake_cgroup(scope=scope)
            with self.assertRaises(local_ci.GuardError, msg=scope):
                local_ci.guard_proof(proc, sys_root)

    def test_unenforced_limits_are_refused(self):
        for kwargs in (
            {"memory": "max"},
            {"memory": str(7 * GIB)},
            {"swap": "max"},
            {"scope": "other.scope"},
        ):
            proc, sys_root = self.fake_cgroup(**kwargs)
            with self.assertRaises(local_ci.GuardError, msg=str(kwargs)):
                local_ci.guard_proof(proc, sys_root)

    def policy_report(self, **changes):
        report = {
            "ok": True,
            "watchdogPolicyActive": True,
            "kernelSwapMax": "0",
            "kernelMemoryMaxBytes": 24 * GIB,
            "recordedCapBytes": 24 * GIB,
            "stopThresholdBytes": 5 * GIB,
        }
        return {**report, **changes}

    def test_a_cap_that_moved_between_the_kernel_read_and_the_policy_report_is_accepted(
        self,
    ):
        # The watchdog re-sizes the aggregate cap every few seconds (SA-130): a gate read 24.25
        # GiB from the cgroup and the report one second later said 24.40 GiB.
        proc, sys_root = self.fake_cgroup(slice_memory=str(24 * GIB))
        moved = self.policy_report(
            kernelMemoryMaxBytes=22 * GIB, recordedCapBytes=22 * GIB
        )
        proof = local_ci.guard_proof(proc, sys_root, policy_fetch=lambda: moved)
        self.assertEqual(proof["sliceMemoryMaxBytes"], 24 * GIB)
        self.assertEqual(
            proof["aggregatePolicy"]["capBytes"], 22 * GIB
        )  # the proven cap
        self.assertEqual(proof["aggregatePolicy"]["observedSliceMaxBytes"], 24 * GIB)
        for bad in (
            {"kernelMemoryMaxBytes": 25 * GIB, "recordedCapBytes": 25 * GIB},
            {"kernelMemoryMaxBytes": 5 * GIB, "recordedCapBytes": 5 * GIB},
            {"kernelMemoryMaxBytes": True, "recordedCapBytes": True},
            {"kernelMemoryMaxBytes": 22 * GIB, "recordedCapBytes": 23 * GIB},
        ):
            with self.assertRaisesRegex(local_ci.GuardError, "policy-2"):
                local_ci.guard_proof(
                    proc,
                    sys_root,
                    policy_fetch=lambda bad=bad: self.policy_report(**bad),
                )

    def test_cap_above_12_gib_needs_a_positive_policy_proof(self):
        proc, sys_root = self.fake_cgroup(slice_memory=str(24 * GIB))
        proof = local_ci.guard_proof(
            proc, sys_root, policy_fetch=lambda: self.policy_report()
        )
        self.assertEqual(proof["sliceMemoryMaxBytes"], 24 * GIB)
        self.assertEqual(proof["aggregatePolicy"]["stopThresholdBytes"], 5 * GIB)
        self.assertEqual(proof["aggregatePolicy"]["capBytes"], 24 * GIB)
        for bad in (
            {"ok": False},
            {"watchdogPolicyActive": False},  # stale or old watchdog
            {"kernelSwapMax": "max"},
            {"recordedCapBytes": 12 * GIB},  # record differs from the kernel
            {"recordedCapBytes": None},
            {"kernelMemoryMaxBytes": 20 * GIB},
        ):
            with self.assertRaisesRegex(local_ci.GuardError, "policy-2"):
                local_ci.guard_proof(
                    proc,
                    sys_root,
                    policy_fetch=lambda bad=bad: self.policy_report(**bad),
                )

    def test_missing_policy_command_or_over_24_gib_is_refused(self):
        proc, sys_root = self.fake_cgroup(slice_memory=str(24 * GIB))

        def no_policy():
            raise local_ci.GuardError("no policy proof")

        with self.assertRaises(local_ci.GuardError):
            local_ci.guard_proof(proc, sys_root, policy_fetch=no_policy)
        proc, sys_root = self.fake_cgroup(slice_memory=str(25 * GIB))
        with self.assertRaisesRegex(local_ci.GuardError, "24 GiB"):
            local_ci.guard_proof(
                proc,
                sys_root,
                policy_fetch=lambda: self.policy_report(
                    kernelMemoryMaxBytes=25 * GIB, recordedCapBytes=25 * GIB
                ),
            )

    def test_legacy_12_gib_guard_never_consults_policy(self):
        proc, sys_root = self.fake_cgroup()

        def forbidden():
            raise AssertionError("policy must not be called for the legacy cap")

        proof = local_ci.guard_proof(proc, sys_root, policy_fetch=forbidden)
        self.assertIsNone(proof["aggregatePolicy"])

    def test_missing_cgroup_files_are_refused(self):
        with self.assertRaises(local_ci.GuardError):
            local_ci.guard_proof(Path("/nonexistent-proc"), Path("/nonexistent-sys"))

    def test_missing_launcher_fails_closed_without_executing(self):
        execv = mock.Mock()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_CI_REEXEC", None)
            with self.assertRaisesRegex(local_ci.GuardError, "not installed"):
                local_ci.ensure_guard(
                    ["x.py"],
                    check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                    binary=lambda: None,
                    execv=execv,
                )
        execv.assert_not_called()

    def test_reexec_goes_through_launcher_once(self):
        execv = mock.Mock()
        launcher = Path("/fake/agent-resource")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_CI_REEXEC", None)
            local_ci.ensure_guard(
                ["x.py", "run"],
                check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                binary=lambda: launcher,
                execv=execv,
            )
            self.assertEqual(os.environ["STATEACTION_LOCAL_CI_REEXEC"], "1")
            with self.assertRaisesRegex(local_ci.GuardError, "re-execution"):
                local_ci.ensure_guard(
                    ["x.py"],
                    check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                    binary=lambda: launcher,
                    execv=execv,
                )
        args = execv.call_args[0][1]
        self.assertEqual(args[1:5], ["run", "--lane", "ci", "--"])
        self.assertEqual(execv.call_count, 1)

    def test_pipeline_refuses_without_proof(self):
        with self.assertRaises(local_ci.GuardError):
            local_ci.run_pipeline(self.repo, home=self.home, guard=None)
        self.assertFalse((self.home / "work").exists())

    def test_cli_refuses_when_guard_is_missing(self):
        cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, cwd)
        with mock.patch.object(
            local_ci, "ensure_guard", side_effect=local_ci.GuardError("no guard")
        ):
            with mock.patch.object(local_ci, "run_pipeline") as pipeline:
                self.assertEqual(local_ci.main(["run", "--tree", "HEAD"]), 75)
        pipeline.assert_not_called()


class PipelineTests(RepoCase):
    def test_pass_writes_receipt_bound_to_the_head_tree(self):
        self.stage_change()
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS")
        tree = sh(self.repo, "git", "rev-parse", "HEAD^{tree}")
        receipt = json.loads(Path(record["receipt"]).read_text())
        self.assertEqual(receipt["tree"], tree)
        self.assertEqual(receipt["mode"], "tree")
        self.assertEqual(receipt["head"], sh(self.repo, "git", "rev-parse", "HEAD"))
        self.assertEqual(receipt["stages"][0]["status"], "passed")
        self.assertEqual(receipt["unautomated"], ["physical device"])
        self.assertEqual(receipt["guard"]["swapMaxBytes"], 0)
        self.assertEqual(oct(Path(record["receipt"]).stat().st_mode & 0o777), "0o600")
        self.assertFalse(
            list((self.home / "work").iterdir()), "private export is removed"
        )

    def test_run_record_carries_guard_counters_and_reports_to_flowlog(self):
        self.stage_change()
        with (
            mock.patch.object(
                local_ci.flow_hook,
                "guard_counters",
                return_value={"slice": {"pidsMax": 8192}},
            ),
            mock.patch.object(local_ci.flow_hook, "report_ci_run") as report,
        ):
            record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS")
        counters = record["guard"]["counters"]
        self.assertEqual(counters["start"], counters["end"])
        self.assertEqual(counters["end"]["slice"]["pidsMax"], 8192)
        report.assert_called_once()
        self.assertEqual(report.call_args[0][0]["runId"], record["runId"])

    def test_a_crashing_flowlog_report_never_fails_the_gate(self):
        self.stage_change()
        with mock.patch.object(
            local_ci.flow_hook, "flowlog_binary", side_effect=OSError("no flowlog")
        ):
            self.assertEqual(self.run_tree()["verdict"], "PASS")

    def test_dirty_worktree_is_refused_not_stashed(self):
        (self.repo / "app.txt").write_text("three\n")
        with self.assertRaisesRegex(local_ci.Refused, "clean checkout"):
            local_ci.run_pipeline(
                self.repo,
                home=self.home,
                guard=FAKE_GUARD,
                log=lambda _m: None,
                probe_fixtures=False,
                probe_ports=False,
                port_locks=self.tmp / "port-locks",
            )
        self.assertEqual((self.repo / "app.txt").read_text(), "three\n")
        self.assertEqual(sh(self.repo, "git", "stash", "list"), "")
        self.assertEqual(self.receipts(), [])

    def test_tests_run_on_the_committed_tree_not_ignored_files(self):
        marker = self.tmp / "seen.txt"
        self.set_stages(
            [
                stage(
                    "read",
                    f"import pathlib, os; pathlib.Path({str(marker)!r}).write_text(open('app.txt').read() + str(os.path.exists('ignored.env')))",
                )
            ]
        )
        (self.repo / ".gitignore").write_text("ignored.env\n")
        (self.repo / "ignored.env").write_text("SECRET=1\n")
        self.stage_change("committed-content\n")
        self.run_tree()
        self.assertEqual(marker.read_text(), "committed-content\nFalse")

    def test_edit_during_run_invalidates_the_result(self):
        self.set_stages(
            [
                stage(
                    "edit",
                    f"import subprocess; open({str(self.repo / 'late.txt')!r}, 'w').write('x'); subprocess.run(['git', '-C', {str(self.repo)!r}, 'add', 'late.txt'], check=True); subprocess.run(['git', '-C', {str(self.repo)!r}, 'commit', '-qm', 'late'], check=True)",
                )
            ]
        )
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(record["stages"][0]["status"], "tree-changed")
        self.assertEqual(self.receipts(), [])

    def test_failed_child_blocks_later_stages_and_receipt(self):
        marker = self.tmp / "second.txt"
        self.set_stages(
            [
                stage("bad", "import sys; print('boom'); sys.exit(3)"),
                stage("later", f"open({str(marker)!r}, 'w').write('x')"),
            ]
        )
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual([s["status"] for s in record["stages"]], ["failed", "not-run"])
        self.assertFalse(marker.exists())
        self.assertEqual(self.receipts(), [])
        self.assertTrue((Path(record["logDir"]) / "run.json").exists())

    def test_keep_going_still_fails_overall(self):
        self.set_stages(
            [stage("bad", "import sys; sys.exit(1)"), stage("good", "print(1)")]
        )
        self.commit_pending()
        record = self.run_tree(keep_going=True)
        self.assertEqual([s["status"] for s in record["stages"]], ["failed", "passed"])
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])

    def test_partial_stage_selection_never_yields_a_receipt(self):
        record = self.run_tree(only=["ok"])
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])

    def test_timeout_reaps_the_whole_process_group(self):
        pidfile = self.tmp / "grandchild.pid"
        code = f"import subprocess, time; p = subprocess.Popen(['sleep', '60']); open({str(pidfile)!r}, 'w').write(str(p.pid)); time.sleep(60)"
        self.set_stages([stage("hang", code, timeoutSec=2)])
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "timeout")
        pid = int(pidfile.read_text())
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_timeout_does_not_wait_out_the_grace_periods_for_killed_grandchildren(
        self,
    ):
        # A killed grandchild is a zombie until reaped and keeps its group "alive"; the
        # timeout path must reap it instead of waiting the 8 s + 5 s kill grace periods.
        local_ci.set_subreaper()
        started = time.monotonic()
        result = local_ci.run_child(
            [
                sys.executable,
                "-c",
                "import subprocess, time; subprocess.Popen(['sleep', '60']); time.sleep(60)",
            ],
            cwd=self.tmp,
            env=os.environ.copy(),
            log=self.tmp / "timeout.log",
            timeout=1,
            output_cap=10000,
            secrets_=[],
            stop={},
        )
        self.assertEqual(result["status"], "timeout")
        self.assertLess(time.monotonic() - started, 6)

    def test_output_is_bounded(self):
        self.set_stages(
            [
                stage(
                    "noisy",
                    "import sys\nwhile True: sys.stdout.write('x' * 4096)",
                    maxOutputBytes=20000,
                )
            ]
        )
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "output-limit")
        self.assertLessEqual(record["stages"][0]["logBytes"], 20000)

    def test_cancellation_kills_runner_owned_children_and_leaves_no_receipt(self):
        pidfile = self.tmp / "child.pid"
        self.set_stages(
            [
                stage(
                    "hang",
                    f"import os, time; open({str(pidfile)!r}, 'w').write(str(os.getpid())); time.sleep(120)",
                    timeoutSec=120,
                )
            ]
        )
        self.commit_pending()
        script = (
            "import sys; sys.path.insert(0, %r); import local_ci; "
            "r = local_ci.run_pipeline(%r, home=%r, guard=%r, probe_ports=False, port_locks=%r, log=lambda m: None); "
            "sys.exit(0 if r['verdict'] == 'PASS' else 130 if r['verdict'] == 'INTERRUPTED' else 1)"
        ) % (
            str(HERE),
            str(self.repo),
            str(self.home),
            FAKE_GUARD,
            str(self.tmp / "port-locks"),
        )
        runner = subprocess.Popen([sys.executable, "-c", script])
        for _ in range(100):
            if pidfile.exists() and pidfile.read_text():
                break
            time.sleep(0.1)
        child = int(pidfile.read_text())
        runner.send_signal(signal.SIGTERM)
        self.assertEqual(runner.wait(timeout=30), 130)
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)
        self.assertEqual(self.receipts(), [])
        run = json.loads(next((self.home / "logs").glob("*/run.json")).read_text())
        self.assertEqual(run["verdict"], "INTERRUPTED")

    def test_stages_run_one_at_a_time_in_declared_order(self):
        log = self.tmp / "order.log"
        body = (
            "import time; f = open({log!r}, 'a'); f.write('start {n}\\n'); f.flush(); time.sleep(0.4); "
            "f.write('end {n}\\n'); f.close()"
        )
        self.set_stages(
            [stage(f"s{n}", body.format(log=str(log), n=n)) for n in (1, 2, 3)]
        )
        self.commit_pending()
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        self.assertEqual(
            log.read_text().split("\n")[:-1],
            ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"],
        )

    def test_environment_enforces_limits_and_blocks_docker_and_secrets(self):
        out = self.tmp / "env.json"
        code = f"""
            import json, os, subprocess
            docker = subprocess.run(['docker', 'version'], capture_output=True).returncode
            json.dump({{'env': dict(os.environ), 'docker': docker}}, open({str(out)!r}, 'w'))
        """
        self.set_stages([stage("env", code)])
        self.commit_pending()
        with mock.patch.dict(
            os.environ,
            {
                "STATEACTION_LOCAL_FIXTURES": "/x",
                "E2E_EXTERNAL_FIXTURES": "/x",
                "GH_TOKEN": "abc",
                "GIT_EDITOR": "/x",
                "NPM_PASSWORD": "p",
            },
        ):
            self.assertEqual(self.run_tree()["verdict"], "PASS")
        seen = json.loads(out.read_text())
        env = seen["env"]
        self.assertEqual(seen["docker"], 126)
        for key, value in {
            "NX_DAEMON": "false",
            "NX_PARALLEL": "1",
            "NX_NO_CLOUD": "true",
            "OMP_NUM_THREADS": "2",
            "CI": "true",
        }.items():
            self.assertEqual(env[key], value)
        for key in ("GH_TOKEN", "GIT_EDITOR", "NPM_PASSWORD"):
            self.assertNotIn(key, env)
        self.assertTrue(env["PATH"].split(os.pathsep)[0].endswith("shims"))
        self.assertNotIn("STATEACTION_LOCAL_FIXTURES", env)
        self.assertNotIn("E2E_EXTERNAL_FIXTURES", env)
        self.assertNotIn("LEFTHOOK", env)
        self.assertNotIn("STATEACTION_LOCAL_CI_ACTIVE", env)

    def test_runner_must_match_the_tree_under_test(self):
        with self.assertRaisesRegex(local_ci.Refused, "differs"):
            self.run_tree(runner_text=b"tampered")

    def detached_stage(self, pidfile, exit_code=0, sleep=False):
        code = (
            "import subprocess, sys, time; "
            "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], start_new_session=True); "
            f"open({str(pidfile)!r}, 'w').write(str(p.pid)); "
            + ("time.sleep(120)" if sleep else f"sys.exit({exit_code})")
        )
        return stage("detached", code, timeoutSec=120 if sleep else 30)

    def assertDead(self, pidfile):
        pid = int(pidfile.read_text())
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        self.fail(f"detached process {pid} survived")

    def test_detached_grandchild_after_success_fails_the_stage_and_is_reaped(self):
        pidfile = self.tmp / "d1.pid"
        self.set_stages([self.detached_stage(pidfile)])
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "leaked-process")
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])
        self.assertDead(pidfile)

    def test_descendant_that_exits_on_its_own_right_after_the_stage_is_not_a_leak(self):
        # server-tooling: Nx plugin workers were still exiting when the reaper looked (SA-126).
        pidfile = self.tmp / "exiting.pid"
        code = (
            "import subprocess, sys; "
            "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(0.4)'], "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, "
            "stderr=subprocess.DEVNULL, start_new_session=True); "
            f"open({str(pidfile)!r}, 'w').write(str(p.pid))"
        )
        self.set_stages([stage("exiting", code)])
        self.commit_pending()
        record = self.run_tree()
        entry = record["stages"][0]
        self.assertEqual(entry["status"], "passed")
        self.assertEqual(entry["settledProcesses"][0]["pid"], int(pidfile.read_text()))
        self.assertIn("time.sleep(0.4)", entry["settledProcesses"][0]["cmdline"])

    def test_real_leak_records_cmdline_and_parent(self):
        pidfile = self.tmp / "evidence.pid"
        self.set_stages([self.detached_stage(pidfile)])
        self.commit_pending()
        entry = self.run_tree()["stages"][0]
        self.assertEqual(entry["status"], "leaked-process")
        detail = entry["leakedDetails"][0]
        self.assertEqual(detail["pid"], int(pidfile.read_text()))
        self.assertIn("time.sleep(120)", detail["cmdline"])
        self.assertIn("ppid", detail)
        self.assertIn("ageSec", detail)
        self.assertEqual(entry.get("settledProcesses"), None)
        self.assertDead(pidfile)

    def test_leak_evidence_is_redacted_and_survives_unreaped(self):
        # run_child relies on the runner being a child subreaper (local_ci.run sets it);
        # state it here so the test does not depend on an earlier test having done so.
        local_ci.set_subreaper()
        result = local_ci.run_child(
            [
                sys.executable,
                "-c",
                "import subprocess, sys; subprocess.Popen([sys.executable, '-c', "
                "'import time; time.sleep(60)  # topsecret'], start_new_session=True)",
            ],
            cwd=self.tmp,
            env=os.environ.copy(),
            log=self.tmp / "evidence.log",
            timeout=30,
            output_cap=10000,
            secrets_=["topsecret"],
            stop={},
        )
        self.assertEqual(result["status"], "leaked-process")
        self.assertNotIn("topsecret", json.dumps(result["leakedDetails"]))
        self.assertIn("<redacted>", result["leakedDetails"][0]["cmdline"])

    def test_mobile_stage_allows_gradle_to_finish_shutdown(self):
        pidfile = self.tmp / "gradle.pid"
        code = (
            "import subprocess, sys; "
            "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(0.5)'], "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, "
            "stderr=subprocess.DEVNULL, start_new_session=True); "
            f"open({str(pidfile)!r}, 'w').write(str(p.pid))"
        )
        self.set_stages([stage("mobile", code)])
        self.commit_pending()
        with mock.patch.object(
            local_ci, "is_gradle_daemon", return_value=True
        ) as match:
            record = self.run_tree()
        match.assert_called_with(int(pidfile.read_text()))
        self.assertEqual(record["stages"][0]["status"], "passed")
        self.assertDead(pidfile)

    def test_mobile_stage_still_reaps_unrelated_detached_grandchild(self):
        pidfile = self.tmp / "unrelated.pid"
        self.set_stages([{**self.detached_stage(pidfile), "id": "mobile"}])
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "leaked-process")
        self.assertDead(pidfile)

    def test_detached_grandchild_after_failure_is_reaped(self):
        pidfile = self.tmp / "d2.pid"
        self.set_stages([self.detached_stage(pidfile, exit_code=2)])
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "failed")
        self.assertDead(pidfile)

    def test_detached_grandchild_is_reaped_on_cancellation(self):
        pidfile = self.tmp / "d3.pid"
        self.set_stages([self.detached_stage(pidfile, sleep=True)])
        self.commit_pending()
        script = (
            "import sys; sys.path.insert(0, %r); import local_ci; "
            "r = local_ci.run_pipeline(%r, home=%r, guard=%r, probe_ports=False, port_locks=%r, log=lambda m: None); "
            "sys.exit(130 if r['verdict'] == 'INTERRUPTED' else 1)"
        ) % (
            str(HERE),
            str(self.repo),
            str(self.home),
            FAKE_GUARD,
            str(self.tmp / "port-locks"),
        )
        runner = subprocess.Popen([sys.executable, "-c", script])
        for _ in range(100):
            if pidfile.exists() and pidfile.read_text():
                break
            time.sleep(0.1)
        runner.send_signal(signal.SIGTERM)
        self.assertEqual(runner.wait(timeout=30), 130)
        self.assertDead(pidfile)

    def test_export_is_a_private_git_repo_for_ls_files_based_stages(self):
        out = self.tmp / "ls.txt"
        code = (
            "import subprocess; "
            "r = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], "
            f"capture_output=True, text=True, check=True); open({str(out)!r}, 'w').write(r.stdout)"
        )
        self.set_stages([stage("ls", code)])
        self.commit_pending()
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        self.assertIn("app.txt", out.read_text().split())
        self.assertEqual(sh(self.repo, "git", "stash", "list"), "")

    def test_stage_rewriting_tracked_source_is_detected(self):
        self.set_stages(
            [stage("rewrite", "open('app.txt', 'w').write('changed by a stage')")]
        )
        self.commit_pending()
        record = self.run_tree()
        self.assertEqual(record["stages"][0]["status"], "source-modified")
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])

    def test_new_attempt_removes_old_pass_even_when_it_fails_or_is_refused(self):
        self.stage_change()
        first = self.run_tree()
        self.assertEqual(first["verdict"], "PASS")
        self.assertEqual(len(self.receipts()), 1)
        # The same tree, rerun with a failing stage list is impossible without changing the
        # tree, so simulate the failing attempt with a failing environment instead.
        with mock.patch.object(
            local_ci, "export_tree", side_effect=local_ci.Refused("export failed")
        ):
            second = self.run_tree()
        self.assertEqual(second["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])
        self.assertTrue(
            any(
                "no PASS receipt" in e
                for e in local_ci.verify_receipt(self.repo, "HEAD", home=self.home)
            )
        )

    def test_run_prints_a_per_stage_wall_time_table_for_pass_and_fail(self):
        self.set_stages(
            [stage("alpha", "print(1)"), stage("beta", "import sys; sys.exit(2)")]
        )
        lines = []
        record = self.run_tree(log=lines.append)
        self.assertEqual(record["verdict"], "FAIL")
        table = next(x for x in lines if "stage wall time" in x)
        self.assertRegex(table, r"stage\s+status\s+seconds\s+cache hits")
        self.assertRegex(table, r"alpha\s+passed\s+\d")
        self.assertRegex(table, r"beta\s+failed\s+\d")
        self.assertRegex(table, r"TOTAL\s+FAIL\s+\d")
        run = json.loads((Path(record["logDir"]) / "run.json").read_text())
        self.assertIn("durationSec", run["stages"][0])
        self.assertIn("totalDurationSec", run)
        lines.clear()
        self.set_stages([stage("alpha", "print(1)")])
        self.assertEqual(self.run_tree(log=lines.append)["verdict"], "PASS")
        self.assertRegex(next(x for x in lines if "wall time" in x), r"TOTAL\s+PASS")

    def test_interrupted_run_still_prints_the_table(self):
        self.set_stages([stage("hang", "import time; time.sleep(60)", timeoutSec=60)])
        self.commit_pending()
        script = (
            "import sys; sys.path.insert(0, %r); import local_ci; "
            "r = local_ci.run_pipeline(%r, home=%r, guard=%r, probe_ports=False, port_locks=%r, log=lambda m: print(m, flush=True)); "
            "sys.exit(130 if r['verdict'] == 'INTERRUPTED' else 1)"
        ) % (
            str(HERE),
            str(self.repo),
            str(self.home),
            FAKE_GUARD,
            str(self.tmp / "port-locks"),
        )
        out = self.tmp / "out.txt"
        with open(out, "w") as sink:
            runner = subprocess.Popen([sys.executable, "-c", script], stdout=sink)
            for _ in range(100):
                if "stage hang" in out.read_text():
                    break
                time.sleep(0.1)
            runner.send_signal(signal.SIGTERM)
            self.assertEqual(runner.wait(timeout=30), 130)
        self.assertRegex(out.read_text(), r"TOTAL\s+INTERRUPTED")

    def test_only_a_run_that_starts_supersedes_the_receipt(self):
        self.stage_change()
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        receipt = self.receipts()[0]
        before = receipt.read_text()
        # Refused before it starts (no guard proof): the PASS stays.
        with self.assertRaises(local_ci.GuardError):
            local_ci.run_pipeline(
                self.repo, home=self.home, guard=None, probe_fixtures=False
            )
        # Waiting for the slot (main never reaches run_pipeline) leaves it alone.
        cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, cwd)
        with mock.patch.object(
            local_ci, "ensure_guard", side_effect=SystemExit(130)
        ):  # cancelled while waiting
            with self.assertRaises(SystemExit):
                local_ci.main(["run", "--tree", "HEAD"])
        self.assertEqual(receipt.read_text(), before)
        self.assertEqual(local_ci.verify_receipt(self.repo, "HEAD", home=self.home), [])
        # A run that starts removes it, even if it then fails at the fixture probe.
        self.set_stages([stage("fx", "print(1)", fixtures=True)])
        self.commit_pending()
        tree = sh(self.repo, "git", "rev-parse", "HEAD^{tree}")
        # The stage fails for want of a fixture environment; a developer shell that has
        # one exported must not change that.
        with mock.patch.dict(os.environ):
            os.environ.pop("STATEACTION_LOCAL_FIXTURES", None)
            os.environ.pop("E2E_EXTERNAL_FIXTURES", None)
            started = local_ci.run_pipeline(
                self.repo,
                home=self.home,
                guard=FAKE_GUARD,
                probe_fixtures=False,
                probe_ports=False,
                port_locks=self.tmp / "port-locks",
                log=lambda _m: None,
            )
        self.assertEqual(started["verdict"], "FAIL")
        self.assertFalse((self.home / "receipts" / f"{tree}.json").exists())


class CiLaneEntryTests(RepoCase):
    """SA-124: ci:local and ci:merge enter the `ci` lane once; no heavy-slot wait path."""

    def test_the_heavy_slot_wait_path_and_legacy_lock_are_gone(self):
        for name in (
            "wait_and_spawn_guarded",
            "heavy_slot_holder",
            "heavy_lock_path",
            "describe_holder",
            "WAIT_TIMEOUT_EXIT",
        ):
            self.assertFalse(hasattr(local_ci, name), name)
        text = (HERE / "local_ci.py").read_text()
        self.assertNotIn("mobile-validation.lock", text)
        self.assertNotIn("heavy-job", text)

    def test_reexec_requests_exactly_the_ci_lane_once(self):
        execv = mock.Mock()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_CI_REEXEC", None)
            self.addCleanup(os.environ.pop, "STATEACTION_LOCAL_CI_REEXEC", None)
            local_ci.ensure_guard(
                ["x.py", "run"],
                check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                binary=lambda: Path("/fake/agent-resource"),
                execv=execv,
            )
        self.assertEqual(
            execv.call_args[0][1][:5],
            ["/fake/agent-resource", "run", "--lane", "ci", "--"],
        )

    def test_legacy_and_other_lane_scopes_do_not_prove_the_ci_lane(self):
        for scope in (
            "agent-mobile-build.scope",
            "agent-mobile-build-123-abcdef.scope",
            "agent-lane-android-build-0123abcd.scope",
            "agent-lane-emulator-00000000.scope",
            "agent-free-1-abc.scope",
        ):
            proc, sys_root = GuardTests.fake_cgroup(self, scope=scope)
            with self.assertRaises(local_ci.GuardError, msg=scope):
                local_ci.guard_proof(proc, sys_root)

    def test_merge_lock_is_exclusive_bounded_and_released(self):
        home = Path(tempfile.mkdtemp(prefix="local-ci-lock-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        clock = iter(range(0, 1000))
        with local_ci.merge_lock(home):
            with self.assertRaisesRegex(local_ci.Refused, "merge lock"):
                with local_ci.merge_lock(
                    home, timeout=3, sleep=lambda _s: None, clock=lambda: next(clock)
                ):
                    self.fail("second holder must not enter")
        with local_ci.merge_lock(home):  # released after the first holder left
            pass

    def test_merge_runs_inside_the_lock_and_merge_cli_enters_the_ci_lane(self):
        home = Path(tempfile.mkdtemp(prefix="local-ci-lock-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        seen = []

        def inner(*_a, **_k):
            with self.assertRaises(local_ci.Refused):  # lock is held by merge_pr
                with local_ci.merge_lock(home, timeout=0):
                    pass
            seen.append("locked")
            return 0

        with mock.patch.object(local_ci, "_merge_pr", side_effect=inner):
            self.assertEqual(
                local_ci.merge_pr(
                    Path("."), 1, github_repo="o/r", execute=True, home=home
                ),
                0,
            )
        self.assertEqual(seen, ["locked"])
        # a dry run is read-only: no lock and no ticket
        with (
            mock.patch.object(local_ci, "_merge_pr", return_value=0),
            mock.patch.object(
                local_ci, "merge_lock", side_effect=AssertionError("lock")
            ),
        ):
            self.assertEqual(
                local_ci.merge_pr(
                    Path("."), 1, github_repo="o/r", execute=False, home=home
                ),
                0,
            )
        with (
            mock.patch.object(local_ci, "ensure_guard") as guard,
            mock.patch.object(local_ci, "merge_pr", return_value=0),
            mock.patch.object(local_ci, "git", return_value="/tmp"),
        ):
            self.assertEqual(local_ci.main(["merge", "--pr", "1"]), 0)
            guard.assert_not_called()
            self.assertEqual(local_ci.main(["merge", "--pr", "1", "--execute"]), 0)
        guard.assert_called_once()
        self.assertTrue(guard.call_args[1]["key"].startswith("ci-merge-1-/tmp-"))

    def test_ticket_key_is_deterministic_and_separates_other_arguments(self):
        a = local_ci.ticket_key("ci-local", "t" * 40, ["x.py", "run", "--tree", "HEAD"])
        self.assertEqual(
            a,
            local_ci.ticket_key(
                "ci-local", "t" * 40, ["x.py", "run", "--tree", "HEAD"]
            ),
        )
        for other in (
            ["x.py", "run", "--tree", "HEAD", "--fresh"],
            ["y.py", "run", "--tree", "HEAD"],
        ):
            self.assertNotEqual(a, local_ci.ticket_key("ci-local", "t" * 40, other))
        self.assertNotEqual(
            a,
            local_ci.ticket_key(
                "ci-local", "u" * 40, ["x.py", "run", "--tree", "HEAD"]
            ),
        )

    def test_merge_refuses_when_main_moved_before_the_merge_call(self):
        policy = mock.Mock()
        policy.validate_pr.return_value = "SA-1"
        policy.primary_declaration.return_value = "Fixes SA-1"
        pr = {"draft": False, "title": "SA-1: x", "head": {"sha": "a" * 40}}

        def gh(*args):
            if args == ("api", "user"):
                return {"login": "timothywangdev"}
            return pr if "--paginate" not in args else [[pr]]

        def git(repo, *args, **_k):
            table = {
                ("rev-parse", "HEAD"): "a" * 40,
                ("rev-parse", "refs/remotes/origin/main"): "b" * 40,
                ("rev-parse", "HEAD^"): "c" * 40,  # head is above an older main
            }
            return table.get(args, "" if args[0] == "status" else "t" * 40)

        with (
            mock.patch.dict(sys.modules, {"github_policy": policy}),
            mock.patch.object(local_ci, "gh_json", side_effect=gh),
            mock.patch.object(local_ci, "git", side_effect=git),
            mock.patch.object(local_ci, "verify_receipt", return_value=[]),
            mock.patch.object(local_ci.subprocess, "run") as run,
        ):
            with self.assertRaisesRegex(local_ci.Refused, "origin/main moved"):
                local_ci._merge_pr(Path("."), 1, github_repo="o/r", execute=True)
            run.assert_not_called()

    def test_reexec_passes_the_deterministic_key(self):
        execv = mock.Mock()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_CI_REEXEC", None)
            self.addCleanup(os.environ.pop, "STATEACTION_LOCAL_CI_REEXEC", None)
            local_ci.ensure_guard(
                ["x.py"],
                check=mock.Mock(side_effect=local_ci.GuardError("outside")),
                binary=lambda: Path("/fake/ar"),
                execv=execv,
                key="ci-local-abc",
            )
        args = execv.call_args[0][1]
        self.assertEqual(args[args.index("--key") + 1], "ci-local-abc")


class FixtureTests(RepoCase):
    def fixture_file(self, text=FIXTURE_ENV):
        path = self.tmp / "fixtures.env"
        path.write_text(text)
        return str(path)

    def fixture_stage(self):
        return stage(
            "fx",
            "import os; path = os.environ['E2E_EXTERNAL_FIXTURES']; print(open(path).read()); print(oct(os.stat(path).st_mode & 0o777)); print('direct', os.environ.get('STORAGE_TEST_SECRET_ACCESS_KEY'))",
            fixtures=True,
        )

    def test_a_fixture_stage_holds_the_budget_while_it_runs_and_records_the_wait(self):
        code = f"""
            import os
            held = [n for n in os.listdir({str(self.tmp / "port-locks")!r}) if n.startswith('db-')]
            print(len(held))
        """
        self.set_stages(
            [stage("db", code, fixtures=True, dbConnections=3)],
        )
        record = self.run_tree(
            fixtures_path=self.fixture_file(), service_check=FAKE_SERVICE
        )
        entry = record["stages"][0]
        self.assertIn("dbBudgetWaitSec", entry)
        self.assertEqual(entry["status"], "passed", record.get("detail"))
        # released afterwards: the whole budget is free again
        for fd in local_ci.acquire_db_budget(
            local_ci.DB_BUDGET, self.tmp / "port-locks", timeout=0
        ):
            os.close(fd)

    def test_missing_fixture_file_fails_closed_without_docker(self):
        self.set_stages([self.fixture_stage()])
        self.commit_pending()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATEACTION_LOCAL_FIXTURES", None)
            os.environ.pop("E2E_EXTERNAL_FIXTURES", None)
            record = self.run_tree()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertIn("STATEACTION_LOCAL_FIXTURES", record["detail"])
        self.assertEqual(record["stages"], [])
        self.assertEqual(self.receipts(), [])

    def test_non_loopback_and_incomplete_fixtures_are_refused(self):
        with self.assertRaisesRegex(local_ci.Refused, "loopback"):
            local_ci.load_fixtures(
                self.fixture_file(
                    FIXTURE_ENV.replace("127.0.0.1:19000", "s3.example.com:9000")
                ),
                probe=False,
            )
        with self.assertRaisesRegex(local_ci.Refused, "missing"):
            local_ci.load_fixtures(
                self.fixture_file(
                    "CATALOG_TEST_ADMIN_URL=postgresql://127.0.0.1:1/x\n"
                ),
                probe=False,
            )

    def test_unreachable_fixture_is_refused(self):
        with self.assertRaisesRegex(local_ci.Refused, "not reachable"):
            local_ci.load_fixtures(
                self.fixture_file(
                    FIXTURE_ENV.replace("54340", "1").replace("19000", "1")
                )
            )

    def service_tree(
        self,
        scope="agent-service-postgres.scope",
        memory=str(GIB),
        swap="0",
        slice_memory=str(12 * GIB),
    ):
        root = Path(tempfile.mkdtemp(dir=self.tmp))
        relative = f"user.slice/user@1.service/{local_ci.SLICE}/{scope}"
        group = root / "sys" / relative
        group.mkdir(parents=True)
        (group / "memory.max").write_text(memory)
        (group / "memory.swap.max").write_text(swap)
        (group.parent / "memory.max").write_text(slice_memory)
        (group.parent / "memory.swap.max").write_text("0")
        (root / "proc/4242").mkdir(parents=True)
        (root / "proc/4242/cgroup").write_text(f"0::/{relative}\n")
        return root / "proc", root / "sys"

    def test_fixture_server_must_sit_in_a_finite_service_cgroup(self):
        proc, sys_root = self.service_tree()
        proof = local_ci.service_proof(
            "postgres", 54340, listeners=lambda _p: [4242], proc=proc, cgroup=sys_root
        )
        self.assertEqual(
            (proof["scope"], proof["memoryMaxBytes"], proof["swapMaxBytes"]),
            ("agent-service-postgres.scope", GIB, 0),
        )

    def test_storage_may_use_two_gib_but_never_more_and_postgres_stays_at_one(self):
        # SeaweedFS was throttled at 1 GiB (memory.peak 1.02 GiB under the gate): SA-108.
        proc, sys_root = self.service_tree(
            scope="agent-service-storage.scope", memory=str(2 * GIB)
        )
        proof = local_ci.service_proof(
            "storage", 19000, listeners=lambda _p: [4242], proc=proc, cgroup=sys_root
        )
        self.assertEqual(proof["memoryMaxBytes"], 2 * GIB)
        proc, sys_root = self.service_tree(
            scope="agent-service-storage.scope", memory=str(3 * GIB)
        )
        with self.assertRaisesRegex(local_ci.Refused, "2 GiB service cap"):
            local_ci.service_proof(
                "storage",
                19000,
                listeners=lambda _p: [4242],
                proc=proc,
                cgroup=sys_root,
            )
        self.assertGreaterEqual(local_ci.SERVICE_CAPS["storage"], int(1.5 * 1018462208))
        self.assertGreaterEqual(
            local_ci.SERVICE_CAPS["postgres"], int(1.4 * 1_820_733_440)
        )

    def test_a_service_scope_with_a_throttle_band_below_its_cap_is_refused(self):
        proc, sys_root = self.service_tree(
            scope="agent-service-postgres.scope", memory=str(GIB)
        )
        group = next(sys_root.glob("**/agent-service-postgres.scope"))
        (group / "memory.high").write_text(str(768 * 1024**2) + "\n")
        with self.assertRaisesRegex(local_ci.Refused, "throttle band"):
            local_ci.service_proof(
                "postgres",
                54340,
                listeners=lambda _p: [4242],
                proc=proc,
                cgroup=sys_root,
            )
        (group / "memory.high").write_text("max\n")
        local_ci.service_proof(
            "postgres", 54340, listeners=lambda _p: [4242], proc=proc, cgroup=sys_root
        )

    def test_the_gate_and_guard_service_caps_are_the_same_numbers(self):
        import importlib.util  # noqa: PLC0415

        spec = importlib.util.spec_from_file_location(
            "guard_for_caps", HERE.parent / "mobile/resource_guard.py"
        )
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        for role, cap in local_ci.SERVICE_CAPS.items():
            self.assertEqual(guard.SERVICE_CAPS[role], (cap, cap), role)

    def test_unbounded_or_wrong_fixture_server_is_refused_with_instructions(self):
        for kwargs, role in (
            ({"memory": "max"}, "postgres"),
            ({"memory": str(3 * GIB)}, "postgres"),
            ({"swap": "max"}, "postgres"),
            ({"scope": "agent-service-storage.scope"}, "postgres"),
        ):
            proc, sys_root = self.service_tree(**kwargs)
            with self.assertRaisesRegex(
                local_ci.Refused, "agent-resource serve|service cap|swap"
            ):
                local_ci.service_proof(
                    role, 54340, listeners=lambda _p: [4242], proc=proc, cgroup=sys_root
                )
        with self.assertRaisesRegex(local_ci.Refused, "No loopback listener"):
            local_ci.service_proof("postgres", 54340, listeners=lambda _p: [])

    def test_pipeline_fails_closed_when_service_proof_is_unavailable(self):
        self.set_stages([self.fixture_stage()])
        self.commit_pending()

        def refuse(role, port):
            raise local_ci.Refused("not in service scope")

        record = self.run_tree(fixtures_path=self.fixture_file(), service_check=refuse)
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(record["stages"], [])
        self.assertEqual(self.receipts(), [])

    def test_dead_fixture_or_missing_service_proof_fails_before_export_and_any_stage(
        self,
    ):
        marker = self.tmp / "ran.txt"
        self.set_stages(
            [
                stage("first", f"open({str(marker)!r}, 'w').write('x')"),
                self.fixture_stage(),
            ]
        )
        self.commit_pending()

        def refuse(role, port):
            raise local_ci.Refused("agent-resource serve --name postgres")

        with mock.patch.object(local_ci, "export_tree") as export:
            record = self.run_tree(
                fixtures_path=self.fixture_file(), service_check=refuse
            )
            export.assert_not_called()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertIn("agent-resource serve", record["detail"])
        self.assertEqual(record["stages"], [])
        self.assertFalse(marker.exists(), "no stage ran before the fixture check")
        # An unreachable fixture is refused by the probe the same way.
        record = self.run_tree(
            fixtures_path=self.fixture_file(
                FIXTURE_ENV.replace("54340", "1").replace("19000", "1")
            ),
            probe_fixtures=True,
        )
        self.assertIn("not reachable", record["detail"])
        self.assertFalse(marker.exists())

    def test_only_allow_listed_keys_reach_stages_and_secrets_stay_out_of_evidence(self):
        self.set_stages(
            [
                self.fixture_stage(),
                stage(
                    "plain",
                    "import os; assert 'STORAGE_TEST_SECRET_ACCESS_KEY' not in os.environ",
                ),
            ]
        )
        self.commit_pending()
        record = self.run_tree(
            fixtures_path=self.fixture_file(), service_check=FAKE_SERVICE
        )
        self.assertEqual(record["verdict"], "PASS", record)
        log = (Path(record["logDir"]) / "fx.log").read_text()
        self.assertNotIn(SECRET, log)
        self.assertIn("<redacted>", log)
        self.assertNotIn("must-not-be-forwarded", log)  # not allow-listed
        self.assertIn(
            "direct None", log
        )  # values are not injected into the environment
        self.assertIn("0o600", log)
        receipt_text = Path(record["receipt"]).read_text()
        self.assertNotIn(SECRET, receipt_text)
        self.assertIn("http://127.0.0.1:19000", receipt_text)
        self.assertIn("agent-service-postgres.scope", receipt_text)
        self.assertFalse(
            (self.home / "work" / "current").exists(), "temp fixture copy removed"
        )


class VerifyTests(RepoCase):
    def commit_passed(self, text="two\n"):
        self.stage_change(text)
        record = self.run_tree()  # commits the change, then gates that exact head
        self.assertEqual(record["verdict"], "PASS")
        return record

    def errors(self):
        return local_ci.verify_receipt(self.repo, "HEAD", home=self.home)

    def rewrite(self, record, mutate):
        path = Path(record["receipt"])
        data = json.loads(path.read_text())
        mutate(data)
        data["receiptSha256"] = local_ci.receipt_digest(data)
        path.write_text(json.dumps(data))

    def test_fresh_single_commit_receipt_is_valid(self):
        self.commit_passed()
        self.assertEqual(self.errors(), [])

    def test_head_without_receipt_is_rejected(self):
        self.commit_passed()
        (self.repo / "app.txt").write_text("other\n")
        sh(self.repo, "git", "commit", "-qam", "amend", "--amend")
        self.assertTrue(any("no PASS receipt" in e for e in self.errors()))

    def test_stale_base_is_rejected(self):
        self.commit_passed()
        sh(self.repo, "git", "checkout", "-q", "--detach", "origin/main")
        (self.repo / "main.txt").write_text("m")
        sh(self.repo, "git", "add", "main.txt")
        sh(self.repo, "git", "commit", "-qm", "main moved")
        newer = sh(self.repo, "git", "rev-parse", "HEAD")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", newer)
        sh(self.repo, "git", "checkout", "-q", "main")
        self.assertTrue(any("latest origin/main" in e for e in self.errors()))

    def test_more_than_one_commit_is_rejected(self):
        self.commit_passed()
        (self.repo / "x.txt").write_text("x")
        sh(self.repo, "git", "add", "x.txt")
        sh(self.repo, "git", "commit", "-qm", "second")
        errors = self.errors()
        self.assertTrue(
            any("no PASS receipt" in e or "exactly one commit" in e for e in errors)
        )

    def test_two_commits_with_the_same_final_tree_are_still_rejected(self):
        self.stage_change("two\n")
        (self.repo / "y.txt").write_text("y")
        sh(self.repo, "git", "add", "y.txt")
        sh(self.repo, "git", "commit", "-qm", "first")
        # Tree after a second commit that changes nothing observable: empty commit.
        record = self.run_tree()
        sh(self.repo, "git", "commit", "-q", "--allow-empty", "-m", "empty")
        self.assertEqual(record["verdict"], "PASS")
        self.assertTrue(any("exactly one commit" in e for e in self.errors()))

    def test_tampered_receipt_is_rejected(self):
        record = self.commit_passed()
        path = Path(record["receipt"])
        data = json.loads(path.read_text())
        data["stages"][0]["status"] = "failed"
        path.write_text(json.dumps(data))
        self.assertTrue(any("digest" in e for e in self.errors()))

    def test_failed_stage_even_with_valid_digest_is_rejected(self):
        record = self.commit_passed()
        self.rewrite(record, lambda d: d["stages"][0].update(status="failed"))
        self.assertTrue(any("did not pass" in e for e in self.errors()))

    def test_changed_stage_list_or_runner_invalidates_old_receipt(self):
        record = self.commit_passed()
        self.rewrite(
            record, lambda d: d.update(stagesSha256="0" * 64, runnerSha256="1" * 64)
        )
        errors = self.errors()
        self.assertTrue(any("stage list changed" in e for e in errors))
        self.assertTrue(any("runner changed" in e for e in errors))

    def test_staged_mode_receipt_is_rejected_even_with_a_valid_digest(self):
        record = self.commit_passed()
        self.assertEqual(self.errors(), [])
        self.rewrite(record, lambda d: d.update(mode="staged"))
        self.assertTrue(any("different commit context" in e for e in self.errors()))
        parent = sh(self.repo, "git", "rev-parse", "HEAD^")
        self.rewrite(record, lambda d: d.update(mode="staged", head=parent))
        self.assertTrue(any("different commit context" in e for e in self.errors()))

    def test_tree_receipt_for_the_head_directly_above_origin_main_is_accepted(self):
        self.commit_passed()
        self.assertEqual(
            sh(self.repo, "git", "rev-parse", "HEAD^"),
            sh(self.repo, "git", "rev-parse", "origin/main"),
        )
        self.assertEqual(self.errors(), [])

    def test_receipt_from_another_parent_context_is_rejected(self):
        record = self.commit_passed()
        self.rewrite(record, lambda d: d.update(head="0" * 40))
        self.assertTrue(any("different commit context" in e for e in self.errors()))

    def test_superseded_attempt_invalidates_the_receipt(self):
        self.commit_passed()
        tree = sh(self.repo, "git", "rev-parse", "HEAD^{tree}")
        local_ci.record_attempt(self.home, tree, "newer-run", "running")
        self.assertTrue(any("superseded" in e for e in self.errors()))

    def test_receipt_without_guard_limits_is_rejected(self):
        record = self.commit_passed()
        self.rewrite(record, lambda d: d["guard"].update(memoryMaxBytes=0))
        self.assertTrue(any("guard" in e for e in self.errors()))


class LaneTests(RepoCase):
    """SA-116: independent stage lanes inside one gate. Concurrency is proved with file
    handshakes (each lane waits, bounded, for the other), never with sleeps and timings."""

    def errors(self):
        return local_ci.verify_receipt(self.repo, "HEAD", home=self.home)

    def rewrite(self, record, mutate):
        path = Path(record["receipt"])
        data = json.loads(path.read_text())
        mutate(data)
        data["receiptSha256"] = local_ci.receipt_digest(data)
        path.write_text(json.dumps(data))

    def commit_passed(self):
        (self.repo / "app.txt").write_text("two\n")
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS")
        return record

    WAIT = """
        import os, sys, time
        def wait_for(path, secs=20):
            end = time.monotonic() + secs
            while not os.path.exists(path):
                if time.monotonic() > end:
                    sys.exit(9)
                time.sleep(0.02)
        def touch(path):
            open(path, "w").write(str(os.getpid()))
    """

    def lane_stage(self, stage_id, lane, code, memory=1000, **extra):
        body = textwrap.dedent(self.WAIT) + textwrap.dedent(code)
        return stage(stage_id, body, lane=lane, memoryMiB=memory, ports=[], **extra)

    def test_lanes_run_concurrently_and_the_receipt_keeps_declared_order(self):
        a, b = self.tmp / "a.up", self.tmp / "b.up"
        self.set_stages(
            [
                stage("setup", "print('setup')"),
                # declared first, but it can only finish after the later lane has started
                self.lane_stage(
                    "first", "x", f"touch({str(a)!r}); wait_for({str(b)!r})"
                ),
                self.lane_stage(
                    "second", "y", f"touch({str(b)!r}); wait_for({str(a)!r})"
                ),
                stage("after", "print('after the barrier')"),
            ]
        )
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS", record)
        self.assertEqual(
            [s["id"] for s in record["stages"]], ["setup", "first", "second", "after"]
        )
        by_id = {s["id"]: s for s in record["stages"]}
        first, second = by_id["first"], by_id["second"]
        self.assertLess(first["startOffsetSec"], second["endOffsetSec"])
        self.assertLess(second["startOffsetSec"], first["endOffsetSec"])
        self.assertLessEqual(by_id["setup"]["endOffsetSec"], first["startOffsetSec"])
        self.assertGreaterEqual(by_id["after"]["startOffsetSec"], first["endOffsetSec"])
        self.assertGreaterEqual(
            by_id["after"]["startOffsetSec"], second["endOffsetSec"]
        )
        self.assertEqual((first["lane"], second["lane"]), ("x", "y"))
        receipt = json.loads(Path(record["receipt"]).read_text())
        self.assertEqual(
            [s["id"] for s in receipt["stages"]], ["setup", "first", "second", "after"]
        )
        self.assertEqual(
            [lane["lane"] for lane in receipt["lanePlan"][0]["lanes"]], ["x", "y"]
        )
        self.assertEqual(receipt["lanePlan"][0]["memoryMiB"], 2000)
        self.assertEqual(
            receipt["lanes"][0]["admittedMemoryMiB"], local_ci.LANE_MEMORY_MIB
        )
        self.assertEqual(self.errors(), [])

    def test_entries_are_recorded_in_declared_order_whatever_finished_first(self):
        declared = [{"id": "setup"}, {"id": "slow"}, {"id": "quick"}]
        finished_first = {"quick": {"id": "quick"}, "slow": {"id": "slow"}}
        self.assertEqual(
            [e["id"] for e in local_ci.in_declared_order(finished_first, declared)],
            ["slow", "quick"],
        )

    def test_a_receipt_in_completion_order_is_not_the_declared_order(self):
        self.set_stages(
            [
                self.lane_stage("slow", "x", "print(1)"),
                self.lane_stage("quick", "y", "print(2)", memory=500),
            ]
        )
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS", record)
        self.assertEqual([s["id"] for s in record["stages"]], ["slow", "quick"])
        self.assertEqual(self.errors(), [])
        self.rewrite(record, lambda d: d["stages"].reverse())
        self.assertTrue(
            any("declared stages in order" in e for e in self.errors()),
        )

    def test_a_forced_failure_in_one_lane_stops_and_reaps_the_others(self):
        ready, pid_file, child_file = (
            self.tmp / "ready",
            self.tmp / "slow.pid",
            self.tmp / "child.pid",
        )
        self.set_stages(
            [
                stage("setup", "print('setup')"),
                self.lane_stage(
                    "bad",
                    "x",
                    f"wait_for({str(ready)!r}); print('boom'); sys.exit(3)",
                ),
                self.lane_stage(
                    "slow",
                    "y",
                    f"""
                    import subprocess
                    child = subprocess.Popen(["sleep", "300"])
                    open({str(child_file)!r}, "w").write(str(child.pid))
                    touch({str(pid_file)!r})
                    touch({str(ready)!r})
                    time.sleep(300)
                    """,
                ),
                self.lane_stage("later", "x", "touch(%r)" % str(self.tmp / "later")),
                stage("last", "open(%r, 'w').write('x')" % str(self.tmp / "last")),
            ]
        )
        record = self.run_tree()
        self.assertEqual(record["verdict"], "FAIL")
        by_id = {s["id"]: s for s in record["stages"]}
        self.assertEqual(by_id["bad"]["status"], "failed")
        self.assertEqual(by_id["slow"]["status"], "cancelled")
        self.assertEqual(by_id["later"]["status"], "not-run")
        self.assertEqual(by_id["last"]["status"], "not-run")
        self.assertEqual(
            [s["id"] for s in record["stages"]],
            ["setup", "bad", "slow", "later", "last"],
        )
        self.assertFalse((self.tmp / "later").exists())
        self.assertFalse((self.tmp / "last").exists())
        self.assertEqual(self.receipts(), [])
        self.assertTrue((Path(record["logDir"]) / "bad.log").exists())
        self.assertTrue((Path(record["logDir"]) / "slow.log").exists())
        for name in (pid_file, child_file):
            pid = int(name.read_text())
            self.assertFalse(
                Path(f"/proc/{pid}").exists(), f"{name.name} {pid} left over"
            )

    def test_not_run_and_cancelled_stages_never_verify(self):
        record = self.commit_passed()
        self.assertEqual(self.errors(), [])
        for status in ("not-run", "cancelled", "interrupted"):
            self.rewrite(record, lambda d, st=status: d["stages"][0].update(status=st))
            self.assertTrue(any("did not pass" in e for e in self.errors()), status)
        self.rewrite(record, lambda d: d["stages"].pop())
        self.assertTrue(any("declared stages in order" in e for e in self.errors()))

    def test_lane_membership_is_bound_by_the_receipt(self):
        self.set_stages(
            [
                self.lane_stage("one", "x", "print(1)"),
                self.lane_stage("two", "y", "print(2)"),
            ]
        )
        record = self.run_tree()
        self.assertEqual(self.errors(), [])
        self.rewrite(record, lambda d: d["stages"][0].update(lane="y"))
        self.assertTrue(any("lane 'y'" in e for e in self.errors()))

    def test_group_leak_is_attributed_and_one_stage_cannot_reap_its_sibling(self):
        sibling_up = self.tmp / "sibling.up"
        keeper = self.tmp / "keeper.pid"
        self.set_stages(
            [
                # stage A leaves a daemon of its own session behind and exits at once
                self.lane_stage(
                    "leaker",
                    "x",
                    f"""
                    import subprocess
                    wait_for({str(sibling_up)!r})
                    subprocess.Popen(["sleep", "300"], start_new_session=True)
                    """,
                ),
                # stage B is alive while A ends and must not be touched by A's reaping
                self.lane_stage(
                    "sibling",
                    "y",
                    f"""
                    touch({str(sibling_up)!r})
                    time.sleep(2)
                    touch({str(keeper)!r})
                    """,
                ),
            ]
        )
        record = self.run_tree()
        by_id = {s["id"]: s for s in record["stages"]}
        self.assertTrue(keeper.exists(), "the sibling stage must run to its own end")
        self.assertEqual(by_id["sibling"]["exitCode"], 0)
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(by_id["leaker"]["status"], "leaked-process")
        self.assertEqual(self.receipts(), [])

    def test_process_left_in_the_stage_session_fails_only_that_stage(self):
        sibling_up, sibling_done = self.tmp / "sibling.up", self.tmp / "sibling.done"
        self.set_stages(
            [
                self.lane_stage(
                    "leaker",
                    "x",
                    f"""
                    import subprocess
                    wait_for({str(sibling_up)!r})
                    subprocess.Popen(["sleep", "300"])
                    """,
                ),
                self.lane_stage(
                    "sibling",
                    "y",
                    f"""
                    touch({str(sibling_up)!r})
                    time.sleep(2)
                    touch({str(sibling_done)!r})
                    """,
                ),
            ]
        )
        record = self.run_tree()
        by_id = {s["id"]: s for s in record["stages"]}
        self.assertEqual(by_id["leaker"]["status"], "leaked-process")
        self.assertEqual(by_id["sibling"]["status"], "passed")
        self.assertTrue(sibling_done.exists())

    def test_ports_are_listed_per_stage_and_never_shared_between_lanes(self):
        out = self.tmp / "ports"
        out.mkdir()
        dump = (
            "import os, json; "
            "json.dump({k: v for k, v in os.environ.items() if k.endswith('_PORT')}, open(%r + '/' + %r, 'w'))"
        )
        self.set_stages(
            [
                stage(
                    "web",
                    dump % (str(out), "web"),
                    lane="x",
                    memoryMiB=500,
                    ports=["CI_SMOKE_WEB_PORT", "CI_SMOKE_RUNNER_PORT"],
                ),
                stage(
                    "hosted",
                    dump % (str(out), "hosted"),
                    lane="y",
                    memoryMiB=500,
                    ports=["HOSTED_SMOKE_WEB_PORT", "HOSTED_SMOKE_RUNNER_PORT"],
                ),
                stage("barrier", dump % (str(out), "barrier")),
            ]
        )
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS", record)
        seen = {
            n: json.loads((out / n).read_text()) for n in ("web", "hosted", "barrier")
        }
        self.assertEqual(
            sorted(seen["web"]), ["CI_SMOKE_RUNNER_PORT", "CI_SMOKE_WEB_PORT"]
        )
        self.assertEqual(
            sorted(seen["hosted"]),
            ["HOSTED_SMOKE_RUNNER_PORT", "HOSTED_SMOKE_WEB_PORT"],
        )
        self.assertFalse(set(seen["web"].values()) & set(seen["hosted"].values()))
        self.assertEqual(
            len(seen["barrier"]), 4
        )  # an unlaned stage keeps the whole block

    def test_a_lane_waiting_for_the_database_budget_is_cancelled_not_interrupted(self):
        locks = self.tmp / "port-locks"
        held = local_ci.acquire_db_budget(local_ci.DB_BUDGET, locks)  # a foreign gate
        self.addCleanup(lambda: [os.close(fd) for fd in held if fd >= 0])
        ready = self.tmp / "ready"
        fixture = self.tmp / "fixtures.env"
        fixture.write_text(FIXTURE_ENV)
        self.set_stages(
            [
                self.lane_stage(
                    "bad", "x", f"wait_for({str(ready)!r}); sys.exit(3)", memory=500
                ),
                self.lane_stage(
                    "db",
                    "y",
                    "print('must not run')",
                    fixtures=True,
                    dbConnections=3,
                ),
            ]
        )
        # the waiting stage is cancelled by the failing sibling; the failure is not lost
        threading_ready = threading.Timer(1.0, lambda: ready.write_text("x"))
        threading_ready.start()
        self.addCleanup(threading_ready.cancel)
        record = self.run_tree(fixtures_path=str(fixture), service_check=FAKE_SERVICE)
        self.assertEqual(record["verdict"], "FAIL", record.get("detail"))
        by_id = {s["id"]: s for s in record["stages"]}
        self.assertEqual(by_id["bad"]["status"], "failed")
        self.assertEqual(by_id["db"]["status"], "not-run")
        self.assertEqual(self.receipts(), [])

    def test_keep_going_runs_every_lane_to_its_end(self):
        later = self.tmp / "later"
        self.set_stages(
            [
                self.lane_stage("bad", "x", "sys.exit(3)", memory=500),
                self.lane_stage("good", "y", "time.sleep(1); print('ok')", memory=500),
                self.lane_stage("after-bad", "x", f"touch({str(later)!r})", memory=500),
            ]
        )
        record = self.run_tree(keep_going=True)
        by_id = {s["id"]: s for s in record["stages"]}
        self.assertEqual(
            (by_id["bad"]["status"], by_id["good"]["status"]), ("failed", "passed")
        )
        self.assertEqual(by_id["after-bad"]["status"], "passed")
        self.assertTrue(later.exists())
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])

    def test_an_exception_in_a_lane_keeps_the_other_lanes_records(self):
        real = local_ci.run_child

        def boom(argv, **kwargs):
            if "explode" in " ".join(argv):
                raise RuntimeError("synthetic lane crash")
            return real(argv, **kwargs)

        self.set_stages(
            [
                self.lane_stage("explode", "x", "print('explode')", memory=500),
                self.lane_stage("fine", "y", "print('fine')", memory=500),
            ]
        )
        with mock.patch.object(local_ci, "run_child", boom):
            with self.assertRaisesRegex(RuntimeError, "synthetic lane crash"):
                self.run_tree()
        run = json.loads(next(self.home.glob("logs/*/run.json")).read_text())
        self.assertEqual(run["verdict"], "FAIL")
        self.assertIn("synthetic lane crash", run["detail"])
        self.assertEqual(self.receipts(), [])

    def test_a_signal_during_the_lanes_ends_interrupted_and_reaps_everything(self):
        pid_a, pid_b = self.tmp / "a.pid", self.tmp / "b.pid"
        self.set_stages(
            [
                self.lane_stage(
                    "one", "x", f"touch({str(pid_a)!r}); time.sleep(300)", memory=500
                ),
                self.lane_stage(
                    "two", "y", f"touch({str(pid_b)!r}); time.sleep(300)", memory=500
                ),
            ]
        )
        self.commit_pending()
        script = (
            "import sys; sys.path.insert(0, %r); import local_ci; "
            "r = local_ci.run_pipeline(%r, home=%r, guard=%r, probe_ports=False, port_locks=%r, log=lambda m: print(m, flush=True)); "
            "print('verdict', r['verdict'], [s['status'] for s in r['stages']], flush=True); "
            "sys.exit(130 if r['verdict'] == 'INTERRUPTED' else 1)"
        ) % (
            str(HERE),
            str(self.repo),
            str(self.home),
            FAKE_GUARD,
            str(self.tmp / "port-locks"),
        )
        out = self.tmp / "out.txt"
        with open(out, "w") as sink:
            runner = subprocess.Popen([sys.executable, "-c", script], stdout=sink)
            end = time.monotonic() + 30
            while not (pid_a.exists() and pid_b.exists()):
                self.assertLess(time.monotonic(), end, "lanes did not start")
                time.sleep(0.05)
            runner.send_signal(signal.SIGTERM)
            self.assertEqual(runner.wait(timeout=60), 130, out.read_text())
        self.assertIn("verdict INTERRUPTED", out.read_text())
        for name in (pid_a, pid_b):
            self.assertFalse(Path(f"/proc/{int(name.read_text())}").exists())

    def test_a_receipt_with_another_lane_plan_is_rejected(self):
        self.set_stages(
            [
                self.lane_stage("one", "x", "print(1)", memory=500),
                self.lane_stage("two", "y", "print(2)", memory=500),
            ]
        )
        record = self.run_tree()
        self.assertEqual(self.errors(), [])
        self.rewrite(record, lambda d: d.update(lanePlan=[]))
        self.assertTrue(any("lane plan" in e for e in self.errors()))

    def test_the_timing_table_shows_lane_and_window_and_gate_wall_as_total(self):
        lines = []
        self.set_stages(
            [
                stage("setup", "print(1)"),
                self.lane_stage("one", "x", "print(1)", memory=500),
                self.lane_stage("two", "y", "print(2)", memory=500),
            ]
        )
        record = self.run_tree(log=lines.append)
        table = next(x for x in lines if "wall time" in x)
        self.assertRegex(table, r"one\s+passed\s+\S+\s+-\s+x\s+\d+-\d+")
        self.assertRegex(table, r"TOTAL\s+PASS\s+%.1f" % record["wallSec"])

    def test_a_private_nx_state_lane_gets_its_own_data_socket_and_tmp(self):
        seen = self.tmp / "seen"
        seen.mkdir()
        shared = local_ci.private_dir(
            local_ci.private_dir(self.home) / "nx-workspace-data"
        )
        (shared / "index.db").write_text("task index")
        dump = (
            "import os, json; keys = ['NX_WORKSPACE_DATA_DIRECTORY', 'NX_SOCKET_DIR', 'TMPDIR']; "
            "d = {k: os.environ.get(k) for k in keys}; "
            "d['copy'] = open(os.path.join(d['NX_WORKSPACE_DATA_DIRECTORY'], 'index.db')).read(); "
            "d['socketDirExists'] = os.path.isdir(d['NX_SOCKET_DIR'] or '/nonexistent'); "
            "json.dump(d, open(%r + '/' + %r, 'w'))"
        )
        self.set_stages(
            [
                stage("barrier", dump % (str(seen), "barrier")),
                stage(
                    "shared",
                    dump % (str(seen), "shared"),
                    lane="x",
                    memoryMiB=500,
                    ports=[],
                ),
                stage(
                    "private",
                    dump % (str(seen), "private"),
                    lane="y",
                    memoryMiB=500,
                    ports=[],
                    nxState="private",
                ),
            ]
        )
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS", record)
        got = {
            n: json.loads((seen / n).read_text())
            for n in ("barrier", "shared", "private")
        }
        self.assertEqual(
            got["shared"]["NX_WORKSPACE_DATA_DIRECTORY"],
            got["barrier"]["NX_WORKSPACE_DATA_DIRECTORY"],
        )
        self.assertIsNone(got["shared"]["NX_SOCKET_DIR"])
        private = got["private"]
        self.assertNotEqual(
            private["NX_WORKSPACE_DATA_DIRECTORY"],
            got["shared"]["NX_WORKSPACE_DATA_DIRECTORY"],
        )
        self.assertNotEqual(private["TMPDIR"], got["shared"]["TMPDIR"])
        self.assertEqual(private["copy"], "task index")
        self.assertTrue(private["socketDirExists"])
        # removed after the group, never left behind
        self.assertFalse(Path(private["NX_SOCKET_DIR"]).exists())
        self.assertFalse(Path(private["NX_WORKSPACE_DATA_DIRECTORY"]).exists())

    def test_lane_plan_refusals(self):
        def plan(*stages):
            return local_ci.lane_plan(list(stages))

        def laned(stage_id, lane, **extra):
            return {
                "id": stage_id,
                "lane": lane,
                "memoryMiB": 1000,
                "ports": [],
                **extra,
            }

        self.assertEqual(plan(laned("a", "x"), laned("b", "y"))[0]["memoryMiB"], 2000)
        # the lane budget is its largest stage, summed over lanes, and refused above 4.5 GiB
        self.assertEqual(
            plan(
                laned("a", "x"),
                laned("c", "x", memoryMiB=3000),
                laned("b", "y", memoryMiB=1500),
            )[0]["memoryMiB"],
            4500,
        )
        with self.assertRaisesRegex(local_ci.Refused, "budgeted for 4700 MiB"):
            plan(laned("a", "x", memoryMiB=3200), laned("b", "y", memoryMiB=1500))
        with self.assertRaisesRegex(local_ci.Refused, "memoryMiB"):
            plan(laned("a", "x"), {"id": "b", "lane": "y", "ports": []})
        with self.assertRaisesRegex(local_ci.Refused, "memoryMiB"):
            plan(laned("a", "x"), laned("b", "y", memoryMiB=True))
        with self.assertRaisesRegex(local_ci.Refused, "share port variable"):
            plan(
                laned("a", "x", ports=["CI_SMOKE_WEB_PORT"]),
                laned("b", "y", ports=["CI_SMOKE_WEB_PORT"]),
            )
        with self.assertRaisesRegex(local_ci.Refused, "share port variable"):
            plan(
                laned("a", "x", ports=None),
                laned("b", "y", ports=["HOSTED_SMOKE_WEB_PORT"]),
            )
        with self.assertRaisesRegex(local_ci.Refused, "connection budget"):
            plan(
                laned("a", "x", dbConnections=5, fixtures=True),
                laned("b", "y", dbConnections=5, fixtures=True),
            )
        # only fixture stages acquire units, so a bare number never counts
        self.assertEqual(
            plan(laned("a", "x", dbConnections=5), laned("b", "y", dbConnections=5))[0][
                "lanes"
            ][0]["dbConnections"],
            0,
        )
        with self.assertRaisesRegex(local_ci.Refused, "dbConnections must be"):
            plan(laned("a", "x", dbConnections="9"), laned("b", "y"))
        with self.assertRaisesRegex(local_ci.Refused, "invalid lane name"):
            plan(laned("a", "X y"), laned("b", "y"))
        with self.assertRaisesRegex(local_ci.Refused, "ports must be"):
            plan(laned("a", "x", ports=["NOT_A_PORT"]), laned("b", "y"))
        # one lane, or stages without a lane, are serial: nothing to budget
        self.assertEqual(plan(laned("a", "x"), laned("b", "x", memoryMiB=9000)), [])
        self.assertEqual(plan({"id": "a"}, {"id": "b"}), [])

    def test_barrier_stages_split_lane_groups(self):
        stages = [
            {"id": "setup"},
            {"id": "a", "lane": "x"},
            {"id": "b", "lane": "y"},
            {"id": "c", "lane": "x"},
            {"id": "build"},
            {"id": "d", "lane": "x"},
        ]
        steps = [
            [[s["id"] for s in lane] for lane in step]
            for step in local_ci.lane_groups(stages)
        ]
        self.assertEqual(
            steps, [[["setup"]], [["a", "c"], ["b"]], [["build"]], [["d"]]]
        )

    def test_shipped_lane_plan_fits_the_budget_and_shares_no_port_or_budget(self):
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        groups = local_ci.lane_plan(spec["stages"])
        self.assertEqual(len(groups), 1)
        self.assertLessEqual(groups[0]["memoryMiB"], local_ci.LANE_MEMORY_MIB)
        by_lane = {lane["lane"]: lane for lane in groups[0]["lanes"]}
        self.assertEqual(sorted(by_lane), ["checks", "fixtures"])
        owners: dict[str, str] = {}
        for lane in by_lane.values():
            for port in lane["ports"]:
                self.assertNotIn(port, owners, f"{port} shared between lanes")
                owners[port] = lane["lane"]
        self.assertEqual(by_lane["fixtures"]["stages"], ["integration"])
        self.assertEqual(by_lane["checks"]["dbConnections"], 0)
        # every build finishes before any lane starts; fixture stages never cache
        order = [s["id"] for s in spec["stages"]]
        build = next(s for s in spec["stages"] if s["id"] == "build")
        self.assertNotIn("lane", build)
        self.assertLess(order.index("build"), order.index("static"))
        self.assertNotIn(
            "build",
            next(s for s in spec["stages"] if s["id"] == "static")["affected"][
                "targets"
            ],
        )


REAL_RULE = json.loads((HERE / "stages.json").read_text())["docsOnly"]


class DocsClassifierTests(RepoCase):
    """The docs-only path rule (SA-117), applied to real `git diff --name-status -M`."""

    def classify(self, changes: dict[str, str | None], renames=(), **kwargs):
        base = sh(self.repo, "git", "rev-parse", "HEAD")
        for old, new in renames:
            (self.repo / new).parent.mkdir(parents=True, exist_ok=True)
            sh(self.repo, "git", "mv", old, new)
        for path, text in changes.items():
            target = self.repo / path
            if text is None:
                sh(self.repo, "git", "rm", "-q", path)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
                sh(self.repo, "git", "add", path)
        self.commit_pending()
        head = sh(self.repo, "git", "rev-parse", "HEAD")
        result = local_ci.classify_diff(
            self.repo, kwargs.get("base", base), head, kwargs.get("rule", REAL_RULE)
        )
        sh(self.repo, "git", "reset", "-q", "--hard", base)
        return result

    def test_docs_paths_are_docs_only(self):
        for path in (
            "README.md",
            "docs/foo.md",
            "docs/sub/x.png",
            "packages/x/README.md",
            "a/b/c.md",
        ):
            result = self.classify({path: "x\n"})
            self.assertTrue(result["docsOnly"], path)
            self.assertEqual(result["paths"], [path])

    def test_paths_that_change_ci_behaviour_or_code_force_the_full_suite(self):
        for path in (
            "AGENTS.md",
            "docs/local-ci.md",
            "scripts/local-ci/stages.json",
            "scripts/local-ci/anything.py",
            "scripts/local-ci/notes.md",
            "package.json",
            "src/code.ts",
            "docs-not/x.txt",
        ):
            self.assertFalse(self.classify({path: "x\n"})["docsOnly"], path)

    def test_one_non_docs_path_makes_the_whole_diff_a_code_change(self):
        result = self.classify(
            {"packages/x/README.md": "r\n", "packages/x/a.ts": "c\n"}
        )
        self.assertFalse(result["docsOnly"])
        self.assertIn("packages/x/a.ts", result["reason"])

    def test_rename_from_code_into_docs_is_not_docs_only(self):
        (self.repo / "src").mkdir()
        (self.repo / "src/code.ts").write_text("export const a = 1;\n" * 5)
        self.commit_pending("code")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        result = self.classify({}, renames=[("src/code.ts", "docs/code.md")])
        self.assertFalse(result["docsOnly"])
        self.assertEqual(result["paths"], ["docs/code.md", "src/code.ts"])
        self.assertEqual(result["entries"][0]["status"][0], "R")

    def test_rename_and_delete_inside_docs_check_both_sides(self):
        (self.repo / "docs").mkdir()
        (self.repo / "docs/a.md").write_text("alpha\n" * 5)
        (self.repo / "docs/b.md").write_text("beta\n" * 5)
        self.commit_pending("docs")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        result = self.classify(
            {"docs/b.md": None}, renames=[("docs/a.md", "docs/c.md")]
        )
        self.assertTrue(result["docsOnly"])
        self.assertEqual(result["paths"], ["docs/a.md", "docs/b.md", "docs/c.md"])

    def test_rename_out_of_docs_into_a_forced_path_is_not_docs_only(self):
        (self.repo / "docs").mkdir()
        (self.repo / "docs/a.md").write_text("alpha\n" * 5)
        self.commit_pending("docs")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        result = self.classify({}, renames=[("docs/a.md", "docs/local-ci.md")])
        self.assertFalse(result["docsOnly"])

    def test_new_symlinks_and_submodule_pointers_are_not_docs_only(self):
        base = sh(self.repo, "git", "rev-parse", "HEAD")
        (self.repo / "docs").mkdir()
        (self.repo / "docs/link.md").symlink_to("../app.txt")
        self.commit_pending("symlink")
        head = sh(self.repo, "git", "rev-parse", "HEAD")
        result = local_ci.classify_diff(self.repo, base, head, REAL_RULE)
        self.assertFalse(result["docsOnly"])
        self.assertIn("symlink or submodule", result["reason"])
        sh(self.repo, "git", "reset", "-q", "--hard", base)
        sh(
            self.repo,
            "git",
            "update-index",
            "--add",
            "--cacheinfo",
            f"160000,{base},docs/sub",
        )
        sh(self.repo, "git", "commit", "-qm", "gitlink")
        head = sh(self.repo, "git", "rev-parse", "HEAD")
        # A local ignore setting must not hide the pointer from the classifier.
        sh(self.repo, "git", "config", "diff.ignoreSubmodules", "all")
        result = local_ci.classify_diff(self.repo, base, head, REAL_RULE)
        self.assertFalse(result["docsOnly"])

    def test_a_type_change_is_not_docs_only(self):
        (self.repo / "docs").mkdir()
        (self.repo / "docs/a.md").write_text("alpha\n")
        self.commit_pending("docs")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        base = sh(self.repo, "git", "rev-parse", "HEAD")
        (self.repo / "docs/a.md").unlink()
        (self.repo / "docs/a.md").symlink_to("../app.txt")
        self.commit_pending("symlink")
        head = sh(self.repo, "git", "rev-parse", "HEAD")
        result = local_ci.classify_diff(self.repo, base, head, REAL_RULE)
        self.assertFalse(result["docsOnly"])
        self.assertIn("unrecognized diff entry", result["reason"])

    def test_fail_closed_cases_run_the_full_suite(self):
        (self.repo / "README.md").write_text("x\n")
        self.commit_pending()
        head = sh(self.repo, "git", "rev-parse", "HEAD")
        base = sh(self.repo, "git", "rev-parse", "HEAD^")
        ok = local_ci.classify_diff(self.repo, base, head, REAL_RULE)
        self.assertTrue(ok["docsOnly"])
        cases = {
            "no rule": (base, head, None),
            "no base": (None, head, REAL_RULE),
            "unresolvable base": ("0" * 40, head, REAL_RULE),
            "unresolvable head": (base, "", REAL_RULE),
            "empty diff": (head, head, REAL_RULE),
        }
        for name, (b, h, rule) in cases.items():
            result = local_ci.classify_diff(self.repo, b, h, rule)
            self.assertFalse(result["docsOnly"], name)
            self.assertTrue(result["reason"], name)

    def test_shallow_clone_runs_everything(self):
        (self.repo / "README.md").write_text("x\n")
        self.commit_pending()
        shallow = self.tmp / "shallow"
        sh(
            self.tmp,
            "git",
            "clone",
            "-q",
            "--depth",
            "1",
            f"file://{self.repo}",
            str(shallow),
        )
        head = sh(shallow, "git", "rev-parse", "HEAD")
        result = local_ci.classify_diff(shallow, head, head, REAL_RULE)
        self.assertFalse(result["docsOnly"])
        self.assertIn("shallow", result["reason"])

    def test_unusual_path_names_run_the_full_suite(self):
        for path in ("docs/a,b.md", "docs/a\\b.md"):
            self.assertFalse(self.classify({path: "x\n"})["docsOnly"], path)

    def test_glob_semantics(self):
        match = local_ci.path_matches
        self.assertTrue(match("README.md", "**/*.md"))
        self.assertTrue(match("a/b/c.md", "**/*.md"))
        self.assertFalse(match("a/b/c.mdx", "**/*.md"))
        self.assertTrue(match("docs/x/y.png", "docs/**"))
        self.assertFalse(match("docs", "docs/**"))
        self.assertFalse(match("xdocs/a", "docs/**"))
        self.assertTrue(match("scripts/local-ci/a/b.py", "scripts/local-ci/**"))
        self.assertFalse(match("scripts/local-cix/a.py", "scripts/local-ci/**"))
        self.assertTrue(match("AGENTS.md", "AGENTS.md"))
        self.assertFalse(match("sub/AGENTS.md", "AGENTS.md"))


class DocsOnlyRunTests(RepoCase):
    """A docs-only diff runs setup plus the fast docs checks and records the rest skipped."""

    def setUp(self):
        super().setUp()
        rule = {
            "version": 1,
            "docsPaths": ["**/*.md", "docs/**"],
            "forceFullPaths": ["AGENTS.md", "docs/local-ci.md", "scripts/local-ci/**"],
            "setupStages": ["setup"],
            "guardedTargets": ["integration"],
            "checks": [
                stage(
                    "docs-checks",
                    "import os; print('CHANGED=' + repr(os.environ['STATEACTION_DOCS_CHANGED']))",
                    docsChanged="env",
                ),
                stage(
                    "docs-affected",
                    "import sys; print('ARGS=' + repr(sys.argv[1:]))",
                    docsChanged="files-arg",
                ),
            ],
        }
        self.rule = rule
        self.set_stages(
            [
                stage("setup", "print('setup')"),
                stage("full-suite", "raise SystemExit('the full suite must not run')"),
                stage(
                    "fixture-suite",
                    "raise SystemExit('the fixture suite must not run')",
                ),
            ],
        )
        spec = json.loads((self.repo / local_ci.STAGES_PATH).read_text())
        spec["docsOnly"] = rule
        (self.repo / local_ci.STAGES_PATH).write_text(json.dumps(spec))
        self.commit_pending("stages")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        self.affected = mock.patch.object(
            local_ci, "affected_projects", return_value=["infra"]
        )
        self.affected_mock = self.affected.start()
        self.addCleanup(self.affected.stop)
        self.guarded = mock.patch.object(local_ci, "guarded_tasks", return_value=[])
        self.guarded_mock = self.guarded.start()
        self.addCleanup(self.guarded.stop)

    def use_stages(self, stages):
        self.set_stages(stages)
        spec = json.loads((self.repo / local_ci.STAGES_PATH).read_text())
        spec["docsOnly"] = self.rule
        (self.repo / local_ci.STAGES_PATH).write_text(json.dumps(spec))
        self.commit_pending("stages")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")

    def docs_change(self, path="docs/guide.md", text="guide\n"):
        (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / path).write_text(text)
        sh(self.repo, "git", "add", path)

    def passed(self, **kwargs):
        record = self.run_tree(**kwargs)
        self.assertEqual(record["verdict"], "PASS", record)
        return record

    def receipt(self, record):
        return json.loads(Path(record["receipt"]).read_text())

    def errors(self, **kwargs):
        kwargs.setdefault("affected", lambda repo, paths: ["infra"])
        kwargs.setdefault("guarded", lambda repo, paths: [])
        return local_ci.verify_receipt(self.repo, "HEAD", home=self.home, **kwargs)

    def transplant(self, record, mutate=None):
        """Re-bind the receipt of the current head to a new head with the same spec."""
        data = self.receipt(record)
        head = sh(self.repo, "git", "rev-parse", "HEAD")
        tree = sh(self.repo, "git", "rev-parse", "HEAD^{tree}")
        data.update(tree=tree, head=head)
        if mutate:
            mutate(data)
        data["receiptSha256"] = local_ci.receipt_digest(data)
        path = self.home / "receipts" / f"{tree}.json"
        path.write_text(json.dumps(data))
        local_ci.record_attempt(self.home, tree, data["runId"], "finished", "PASS")

    def test_docs_only_diff_runs_setup_and_docs_checks_only(self):
        self.docs_change()
        record = self.passed()
        self.assertEqual(
            [s["id"] for s in record["stages"]],
            ["setup", "docs-checks", "docs-affected"],
        )
        receipt = self.receipt(record)
        self.assertEqual(receipt["mode"], "docs-only")
        info = receipt["docsOnly"]
        self.assertEqual(info["changedPaths"], ["docs/guide.md"])
        self.assertEqual(info["affectedProjects"], ["infra"])
        self.assertEqual(info["ruleSha256"], local_ci.rule_sha256(self.rule))
        self.assertEqual(
            info["mergeBase"], sh(self.repo, "git", "rev-parse", "origin/main")
        )
        self.assertEqual(
            [(s["id"], s["status"]) for s in receipt["skipped"]],
            [
                ("full-suite", "skipped: unaffected"),
                ("fixture-suite", "skipped: unaffected"),
            ],
        )
        for item in receipt["skipped"]:
            self.assertEqual(
                item["evidence"],
                {"changedPaths": ["docs/guide.md"], "affectedProjects": ["infra"]},
            )
        self.assertEqual(
            [s["id"] for s in receipt["stages"]],
            ["setup", "docs-checks", "docs-affected"],
        )
        log = (Path(record["logDir"]) / "docs-checks.log").read_text()
        self.assertIn("CHANGED='docs/guide.md'", log)
        log = (Path(record["logDir"]) / "docs-affected.log").read_text()
        self.assertIn("--files=docs/guide.md", log)
        self.assertEqual(self.errors(), [])

    def test_a_rename_checks_the_new_path_and_passes_both_sides_to_nx(self):
        self.docs_change("docs/old.md", "old\n" * 5)
        self.commit_pending("old")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        sh(self.repo, "git", "mv", "docs/old.md", "docs/new.md")
        record = self.passed()
        log = (Path(record["logDir"]) / "docs-checks.log").read_text()
        self.assertIn("CHANGED='docs/new.md'", log)
        self.assertIn(
            "--files=docs/new.md,docs/old.md",
            (Path(record["logDir"]) / "docs-affected.log").read_text(),
        )

    def test_a_diff_that_mixes_docs_and_code_runs_the_full_suite(self):
        self.use_stages(
            [stage("setup", "print('setup')"), stage("full-suite", "print('full')")]
        )
        self.docs_change()
        (self.repo / "app.txt").write_text("code change\n")
        record = self.passed()
        self.assertEqual([s["id"] for s in record["stages"]], ["setup", "full-suite"])
        receipt = self.receipt(record)
        self.assertEqual(receipt["mode"], "tree")
        self.assertNotIn("skipped", receipt)
        self.assertEqual(self.errors(), [])

    def test_full_flag_forces_the_full_suite_even_for_docs_only_diffs(self):
        self.use_stages(
            [stage("setup", "print('setup')"), stage("full-suite", "print('full')")]
        )
        self.docs_change()
        record = self.passed(docs_only=False)
        self.assertEqual([s["id"] for s in record["stages"]], ["setup", "full-suite"])
        self.assertEqual(self.receipt(record)["mode"], "tree")

    def test_a_failing_docs_check_leaves_no_receipt(self):
        self.rule["checks"][0]["argv"][-1] = "raise SystemExit('broken link')"
        spec = json.loads((self.repo / local_ci.STAGES_PATH).read_text())
        spec["docsOnly"] = self.rule
        (self.repo / local_ci.STAGES_PATH).write_text(json.dumps(spec))
        self.commit_pending("stages")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        self.docs_change()
        record = self.run_tree()
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual(self.receipts(), [])

    def test_the_affected_set_is_computed_for_the_changed_paths_only(self):
        self.docs_change("docs/components/render-deployment.md", "doc\n")
        self.passed()
        args = self.affected_mock.call_args.args
        self.assertEqual(args[1], ["docs/components/render-deployment.md"])

    def test_verify_rejects_a_tampered_changed_path_list(self):
        self.docs_change()
        record = self.passed()
        data = self.receipt(record)
        for field, value in (
            ("changedPaths", ["docs/other.md"]),
            ("changed", [{"status": "A", "paths": ["docs/other.md"]}]),
        ):
            copy = json.loads(json.dumps(data))
            copy["docsOnly"][field] = value
            copy["receiptSha256"] = local_ci.receipt_digest(copy)
            Path(record["receipt"]).write_text(json.dumps(copy))
            errors = self.errors()
            self.assertTrue(
                any("changed-path list" in e for e in errors), (field, errors)
            )
        Path(record["receipt"]).write_text(json.dumps(data))
        self.assertEqual(self.errors(), [])

    def test_verify_rejects_a_docs_only_receipt_on_a_diff_that_touches_code(self):
        self.docs_change()
        record = self.passed()
        (self.repo / "app.txt").write_text("code\n")
        sh(self.repo, "git", "add", "app.txt")
        sh(self.repo, "git", "commit", "-q", "--amend", "-m", "now with code")
        self.transplant(record)
        errors = self.errors()
        self.assertTrue(any("not docs-only" in e for e in errors), errors)

    def test_verify_rejects_a_skipped_stage_the_recomputed_set_selects(self):
        self.docs_change()
        self.passed()
        errors = self.errors(affected=lambda repo, paths: ["infra", "web"])
        self.assertTrue(
            any("selects tasks the receipt skipped" in e for e in errors), errors
        )

    def test_a_changed_doc_that_a_skipped_task_reads_falls_back_to_the_full_suite(self):
        self.use_stages(
            [stage("setup", "print('setup')"), stage("full-suite", "print('full')")]
        )
        self.guarded_mock.return_value = ["web:auth-e2e"]
        self.docs_change("packages/server/test-auth/notes.md")
        record = self.passed()
        self.assertEqual([s["id"] for s in record["stages"]], ["setup", "full-suite"])
        self.assertEqual(self.receipt(record)["mode"], "tree")
        self.assertEqual(len(self.receipts()), 1)

    def test_verify_rejects_changed_docs_that_select_a_skipped_task(self):
        self.docs_change()
        self.passed()
        errors = self.errors(guarded=lambda repo, paths: ["jobs:integration"])
        self.assertTrue(
            any(
                "select tasks the receipt skipped: jobs:integration" in e
                for e in errors
            ),
            errors,
        )

    def test_verify_fails_closed_when_the_affected_set_cannot_be_recomputed(self):
        self.docs_change()
        self.passed()

        def broken(repo, paths):
            raise local_ci.Refused("no node_modules")

        errors = self.errors(affected=broken)
        self.assertTrue(
            any("cannot recompute the affected set" in e for e in errors), errors
        )

    def test_verify_rejects_a_wrong_or_stale_base(self):
        self.docs_change()
        record = self.passed()
        data = self.receipt(record)
        original = json.dumps(data)
        data["docsOnly"]["mergeBase"] = "0" * 40
        data["receiptSha256"] = local_ci.receipt_digest(data)
        Path(record["receipt"]).write_text(json.dumps(data))
        self.assertTrue(any("base other than" in e for e in self.errors()))
        Path(record["receipt"]).write_text(original)
        self.assertEqual(self.errors(), [])
        # origin/main moves on after the run: the head is no longer directly above it.
        self.commit_pending()
        head = sh(self.repo, "git", "rev-parse", "HEAD")
        sh(self.repo, "git", "checkout", "-q", "--detach", "HEAD^")
        (self.repo / "later.txt").write_text("m")
        sh(self.repo, "git", "add", "later.txt")
        sh(self.repo, "git", "commit", "-qm", "main moved")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        sh(self.repo, "git", "checkout", "-q", head)
        errors = self.errors()
        self.assertTrue(
            any("parent is not the latest origin/main" in e for e in errors), errors
        )

    def test_verify_rejects_a_changed_rule_or_skipped_list(self):
        self.docs_change()
        record = self.passed()
        data = self.receipt(record)
        for mutate, text in (
            (lambda d: d["docsOnly"].update(ruleSha256="0" * 64), "rule changed"),
            (lambda d: d["skipped"].pop(), "skipped stages are not exactly"),
            (lambda d: d["skipped"][0].update(status="passed"), "unaffected evidence"),
            (
                lambda d: d["skipped"][0]["evidence"].update(changedPaths=[]),
                "unaffected evidence",
            ),
        ):
            copy = json.loads(json.dumps(data))
            mutate(copy)
            copy["receiptSha256"] = local_ci.receipt_digest(copy)
            Path(record["receipt"]).write_text(json.dumps(copy))
            errors = self.errors()
            self.assertTrue(any(text in e for e in errors), (text, errors))

    def test_docs_receipt_does_not_count_for_a_later_code_change_on_the_branch(self):
        self.docs_change()
        self.passed()
        self.assertEqual(self.errors(), [])
        (self.repo / "app.txt").write_text("code later\n")
        sh(self.repo, "git", "commit", "-qam", "code", "--amend")
        errors = self.errors()
        self.assertTrue(any("no PASS receipt" in e for e in errors), errors)

    def test_a_tree_receipt_still_verifies_for_a_docs_only_diff(self):
        self.use_stages(
            [stage("setup", "print('setup')"), stage("full-suite", "print('full')")]
        )
        self.docs_change()
        record = self.passed(docs_only=False)
        self.assertEqual(self.receipt(record)["mode"], "tree")
        self.assertEqual(self.errors(), [])


class AmendVerifyTests(RepoCase):
    """An amend changes the tree or head: the receipt never carries over."""

    commit_passed = VerifyTests.commit_passed
    errors = VerifyTests.errors

    def test_amended_head_needs_a_new_run(self):
        self.commit_passed()
        sh(self.repo, "git", "commit", "-q", "--amend", "-m", "amended")
        self.assertTrue(
            any(
                "different commit context" in e or "no PASS receipt" in e
                for e in self.errors()
            ),
            self.errors(),
        )
        record = self.run_tree()
        self.assertEqual(record["verdict"], "PASS")
        self.assertEqual(self.errors(), [])

    def test_amend_with_different_content_than_tested_is_rejected(self):
        self.commit_passed()
        (self.repo / "app.txt").write_text("untested\n")
        sh(self.repo, "git", "commit", "-qa", "--amend", "-m", "again")
        self.assertTrue(any("no PASS receipt" in e for e in self.errors()))


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="local-ci-install-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.main = self.tmp / "main"
        self.main.mkdir()
        sh(self.main, "git", "init", "-q", "-b", "main")
        sh(self.main, "git", "config", "user.email", "t@example.invalid")
        sh(self.main, "git", "config", "user.name", "T")
        (self.main / "f").write_text("1")
        sh(self.main, "git", "add", "f")
        sh(self.main, "git", "commit", "-qm", "init")
        self.linked = self.tmp / "linked"
        sh(self.main, "git", "worktree", "add", "-q", "-b", "other", str(self.linked))

    def worktree_value(self, repo):
        return sh(
            repo, "git", "config", "--worktree", "--get", "core.hooksPath", check=False
        )

    def test_install_is_idempotent_and_worktree_scoped(self):
        first = installer.install(self.linked)
        self.assertIn("core.hooksPath(worktree)", first["changed"])
        self.assertEqual(installer.install(self.linked)["changed"], [])
        self.assertEqual(self.worktree_value(self.linked), first["hooksPath"])
        self.assertEqual(self.worktree_value(self.main), "")
        self.assertEqual(
            sh(
                self.main,
                "git",
                "config",
                "--local",
                "--get",
                "core.hooksPath",
                check=False,
            ),
            "",
        )
        shared = Path(sh(self.main, "git", "rev-parse", "--git-common-dir"))
        shared = shared if shared.is_absolute() else self.main / shared
        self.assertEqual(
            [
                p.name
                for p in (shared / "hooks").glob("*")
                if not p.name.endswith(".sample")
            ],
            [],
        )
        self.assertIn("worktrees/linked/stateaction-hooks", first["hooksPath"])
        for name in installer.HOOKS:
            self.assertTrue(os.access(Path(first["hooksPath"]) / name, os.X_OK))

    def test_uninstall_restores_only_our_own_setting(self):
        previous = self.tmp / "theirs"
        previous.mkdir()
        sh(self.linked, "git", "config", "extensions.worktreeConfig", "true")
        sh(self.linked, "git", "config", "--worktree", "core.hooksPath", str(previous))
        installer.install(self.linked)
        installer.install(self.main)
        result = installer.uninstall(self.linked)
        self.assertTrue(result["removed"])
        self.assertEqual(self.worktree_value(self.linked), str(previous))
        self.assertNotEqual(self.worktree_value(self.main), "")
        # A hooks path installed by someone else afterwards must survive uninstall.
        sh(
            self.linked,
            "git",
            "config",
            "--worktree",
            "core.hooksPath",
            "/someone/else",
        )
        again = installer.uninstall(self.linked)
        self.assertFalse(again["removed"])
        self.assertEqual(self.worktree_value(self.linked), "/someone/else")

    def test_wrappers_quote_hostile_paths_and_never_execute_them(self):
        hostile = self.tmp / 'we\'ird $(touch PWNED1) `touch PWNED2` "x"'
        sh(self.main, "git", "worktree", "add", "-q", "-b", "hostile", str(hostile))
        info = installer.install(hostile)
        (hostile / "scripts/local-ci/hooks").mkdir(parents=True)
        marker = self.tmp / "ran"
        hook = hostile / "scripts/local-ci/hooks/pre-commit"
        hook.write_text(f"#!/bin/sh\necho ran > {shlex.quote(str(marker))}\n")
        hook.chmod(0o755)
        result = subprocess.run(
            [str(Path(info["hooksPath"]) / "pre-commit")], cwd=hostile
        )
        self.assertEqual(result.returncode, 0)
        self.assertTrue(marker.exists())
        for name in ("PWNED1", "PWNED2"):
            self.assertFalse(list(self.tmp.rglob(name)))

    def test_wrapper_fails_closed_when_tracked_hook_is_missing(self):
        info = installer.install(self.linked)
        result = subprocess.run(
            [str(Path(info["hooksPath"]) / "pre-commit")],
            cwd=self.linked,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing", result.stderr)

    def shim_bin(self):
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir(exist_ok=True)
        self.trace = self.tmp / "trace"
        for name, code in (
            ("node", "${NODE_EXIT:-0}"),
            ("python3", "${PYTHON_EXIT:-0}"),
        ):
            shim = bin_dir / name
            shim.write_text(
                f'#!/bin/sh\necho "{name} $@" >> {self.trace}\nexit {code}\n'
            )
            shim.chmod(0o755)
        # A worktree wrapper exports STATEACTION_PREVIOUS_HOOKS to its hook; when
        # this suite runs from inside such a commit it must not redirect the
        # temporary repository's hook chain.
        env = {k: v for k, v in os.environ.items() if k != "STATEACTION_PREVIOUS_HOOKS"}
        return {**env, "PATH": f"{bin_dir}:{os.environ['PATH']}"}

    def test_pre_commit_runs_only_the_staged_checks_and_never_local_ci(
        self,
    ):
        hooks = self.linked / "scripts/local-ci/hooks"
        hooks.mkdir(parents=True)
        shutil.copy(HERE / "hooks/pre-commit", hooks / "pre-commit")
        (self.linked / "scripts/platform").mkdir(parents=True)
        (self.linked / "scripts/platform/check-staged.mjs").write_text("")
        env = self.shim_bin()
        ok = subprocess.run([str(hooks / "pre-commit")], cwd=self.linked, env=env)
        self.assertEqual(ok.returncode, 0)
        self.assertEqual(
            self.trace.read_text().split("\n")[:-1],
            ["node scripts/platform/check-staged.mjs"],
        )
        self.assertNotIn("local_ci.py", self.trace.read_text())
        self.assertNotIn("local_ci.py", (HERE / "hooks/pre-commit").read_text())
        self.trace.unlink()
        failing = subprocess.run(
            [str(hooks / "pre-commit")],
            cwd=self.linked,
            env={**env, "NODE_EXIT": "1"},
        )
        self.assertEqual(
            failing.returncode, 1, "a staged-content failure still blocks the commit"
        )

    def test_pre_commit_chains_the_previous_worktree_hooks_directory(self):
        previous = self.tmp / "prev-hooks"
        previous.mkdir()
        trace = self.tmp / "prev-trace"
        old = previous / "pre-commit"
        old.write_text(
            f"#!/bin/sh\necho previous >> {shlex.quote(str(trace))}\nexit ${{PREV_EXIT:-0}}\n"
        )
        old.chmod(0o755)
        sh(self.linked, "git", "config", "extensions.worktreeConfig", "true")
        sh(self.linked, "git", "config", "--worktree", "core.hooksPath", str(previous))
        info = installer.install(self.linked)
        hooks = self.linked / "scripts/local-ci/hooks"
        hooks.mkdir(parents=True)
        shutil.copy(HERE / "hooks/pre-commit", hooks / "pre-commit")
        env = self.shim_bin()
        self.assertEqual(
            subprocess.run(
                [str(Path(info["hooksPath"]) / "pre-commit")], cwd=self.linked, env=env
            ).returncode,
            0,
        )
        self.assertEqual(trace.read_text(), "previous\n")
        self.assertFalse(self.trace.exists(), "the hook never starts local_ci.py")
        blocked = subprocess.run(
            [str(Path(info["hooksPath"]) / "pre-commit")],
            cwd=self.linked,
            env={**env, "PREV_EXIT": "1"},
        )
        self.assertEqual(blocked.returncode, 1)
        self.assertFalse(self.trace.exists())

    def push(self, hook, lines, env=None):
        return subprocess.run(
            [str(hook), "origin", "url"],
            input=lines,
            text=True,
            capture_output=True,
            env=env,
        )

    def test_pre_push_blocks_main_even_without_or_with_a_previous_hook(self):
        hook = HERE / "hooks/pre-push"
        main_update = "refs/heads/x aaaa refs/heads/main bbbb\n"
        branch_update = "refs/heads/x aaaa refs/heads/ticket bbbb\n"
        delete_main = "(delete) 0000 refs/heads/main bbbb\n"
        base_env = {**os.environ, "STATEACTION_PREVIOUS_HOOKS": str(self.tmp / "none")}
        self.assertEqual(self.push(hook, main_update, base_env).returncode, 1)
        self.assertEqual(self.push(hook, delete_main, base_env).returncode, 1)
        self.assertEqual(self.push(hook, branch_update, base_env).returncode, 0)
        previous = self.tmp / "prev"
        previous.mkdir()
        seen = self.tmp / "seen"
        old = previous / "pre-push"
        old.write_text(f"#!/bin/sh\ncat > {shlex.quote(str(seen))}\nexit 0\n")
        old.chmod(0o755)
        env = {**os.environ, "STATEACTION_PREVIOUS_HOOKS": str(previous)}
        self.assertEqual(
            self.push(hook, main_update, env).returncode,
            1,
            "a permissive previous hook cannot waive main protection",
        )
        self.assertEqual(self.push(hook, branch_update, env).returncode, 0)
        self.assertEqual(seen.read_text(), branch_update)


class MergePostconditionTests(unittest.TestCase):
    BASE, HEAD_TREE, SHA = "a" * 40, "b" * 40, "c" * 40

    def api(self, parents, tree, merged=True):
        def call(*args):
            if "pulls" in args[1]:
                return {"merged": merged, "merge_commit_sha": self.SHA}
            return {
                "parents": [{"sha": p} for p in parents],
                "commit": {"tree": {"sha": tree}},
            }

        return call

    def check(self, **kwargs):
        return local_ci.check_merged_commit(
            "o/r", 7, self.BASE, self.HEAD_TREE, api=self.api(**kwargs)
        )

    def test_squash_on_the_tested_base_and_tree_is_accepted(self):
        result = self.check(parents=[self.BASE], tree=self.HEAD_TREE)
        self.assertEqual(result["mergeSha"], self.SHA)

    def test_base_race_tree_mismatch_or_extra_parent_is_fatal(self):
        for parents, tree in (
            (["d" * 40], self.HEAD_TREE),  # main moved in the final interval
            ([self.BASE], "e" * 40),  # content differs
            ([self.BASE, "d" * 40], self.HEAD_TREE),  # a merge commit
            ([], self.HEAD_TREE),
        ):
            with self.assertRaisesRegex(
                local_ci.MergedOnUntestedBase, "nothing was retried"
            ):
                self.check(parents=parents, tree=tree)

    def test_unreported_merge_is_fatal(self):
        with self.assertRaises(local_ci.MergedOnUntestedBase):
            self.check(parents=[self.BASE], tree=self.HEAD_TREE, merged=False)

    def test_merge_refuses_without_a_valid_receipt_and_never_calls_gh_merge(self):
        policy = mock.Mock()
        policy.validate_pr.return_value = "SA-1"
        policy.primary_declaration.return_value = "Fixes SA-1"
        pr = {"draft": False, "title": "SA-1: x", "head": {"sha": "a" * 40}}

        def gh(*args):
            return (
                {"login": "timothywangdev"}
                if args == ("api", "user")
                else (
                    pr if "pulls/1" in args[1] and "--paginate" not in args else [[pr]]
                )
            )

        with mock.patch.dict(sys.modules, {"github_policy": policy}):
            with mock.patch.object(local_ci, "gh_json", side_effect=gh):
                with mock.patch.object(local_ci, "git", return_value="a" * 40):
                    with mock.patch.object(
                        local_ci,
                        "verify_receipt",
                        return_value=["no PASS receipt for tree t"],
                    ):
                        with mock.patch.object(local_ci.subprocess, "run") as run:
                            with self.assertRaisesRegex(
                                local_ci.Refused, "Local receipt rejected"
                            ):
                                local_ci._merge_pr(
                                    Path("."), 1, github_repo="o/r", execute=True
                                )
                            run.assert_not_called()

    def test_merge_is_not_blocked_by_a_running_ci_run_lock_and_the_cli_reports_fatal(
        self,
    ):
        home = Path(tempfile.mkdtemp(prefix="local-ci-merge-"))
        self.addCleanup(shutil.rmtree, home, ignore_errors=True)
        fd = local_ci.acquire_lock(local_ci.private_dir(home))  # a ci:local is running
        try:
            with mock.patch.object(local_ci, "_merge_pr", return_value=0) as inner:
                self.assertEqual(
                    local_ci.merge_pr(
                        Path("."), 1, github_repo="o/r", execute=False, home=home
                    ),
                    0,
                )
                inner.assert_called_once()
        finally:
            os.close(fd)
        with (
            mock.patch.object(
                local_ci,
                "merge_pr",
                side_effect=local_ci.MergedOnUntestedBase("FATAL x"),
            ),
            mock.patch.object(local_ci, "ensure_guard"),
        ):
            with mock.patch.object(local_ci, "git", return_value="/tmp"):
                self.assertEqual(local_ci.main(["merge", "--pr", "1"]), 3)


class SubmoduleExportTests(RepoCase):
    def test_pinned_commit_is_exported_even_when_a_hook_sets_git_dir(self):
        source = self.tmp / "sources" / "stera-sdk"
        source.mkdir(parents=True)
        sh(source, "git", "init", "-q", "-b", "main")
        sh(source, "git", "config", "user.email", "t@example.invalid")
        sh(source, "git", "config", "user.name", "T")
        (source / "README.md").write_text("pinned\n")
        sh(source, "git", "add", "README.md")
        sh(source, "git", "commit", "-qm", "pin")
        pinned = sh(source, "git", "rev-parse", "HEAD")
        (source / "README.md").write_text("dirty worktree, never exported\n")
        sh(source, "git", "commit", "-qam", "newer")
        destination = self.tmp / "export"
        destination.mkdir()
        hook_env = {
            "GIT_DIR": str(self.repo / ".git"),
            "GIT_INDEX_FILE": str(self.repo / ".git" / "index"),
            "STATEACTION_LOCAL_CI_SUBMODULES": str(self.tmp / "sources"),
        }
        with mock.patch.dict(os.environ, hook_env):
            self.assertTrue(
                local_ci.export_submodule(self.repo, "stera-sdk", pinned, destination)
            )
            missing = "0" * 40
            self.assertFalse(
                local_ci.export_submodule(self.repo, "stera-sdk", missing, destination)
            )
        self.assertEqual((destination / "stera-sdk/README.md").read_text(), "pinned\n")


class CacheTests(RepoCase):
    NX_STAGE = {"argv": ["pnpm", "exec", "nx", "run-many", "-t", "test"], "cache": "nx"}

    def test_nx_cache_is_decided_by_each_target_and_only_fresh_bypasses_it(self):
        argv, skip = local_ci.effective_argv(self.NX_STAGE, fresh=False)
        self.assertFalse(skip)
        self.assertNotIn("--skip-nx-cache", argv)
        argv, skip = local_ci.effective_argv(self.NX_STAGE, fresh=True)
        self.assertTrue(skip)
        self.assertEqual(argv.count("--skip-nx-cache"), 1)
        # A fixture stage no longer gets the flag: its target declares cache=false.
        undeclared = {"argv": ["pnpm", "exec", "nx", "run", "web:auth-e2e"]}
        argv, skip = local_ci.effective_argv(undeclared, fresh=False)
        self.assertFalse(skip)
        self.assertNotIn("--skip-nx-cache", argv)
        again, _ = local_ci.effective_argv({"argv": argv}, fresh=True)
        self.assertEqual(again.count("--skip-nx-cache"), 1)
        other = {"argv": ["python3", "-m", "unittest"], "cache": "nx"}
        self.assertEqual(
            local_ci.effective_argv(other, fresh=False),
            (["python3", "-m", "unittest"], False),
        )

    FIXTURE = {
        "fixtures": True,
        "argv": ["pnpm", "exec", "nx", "run", "web:auth-e2e", "--outputStyle=static"],
    }

    def test_a_fixture_task_replayed_or_unreported_is_detected(self):
        stage = self.FIXTURE
        ran = {"executedTasks": ["web:build", "web:auth-e2e"], "hitTasks": []}
        self.assertIsNone(local_ci.cached_fixture_task(stage, stage["argv"], ran))
        hit = {"hitTasks": ["web:auth-e2e"], "executedTasks": []}
        self.assertEqual(
            local_ci.cached_fixture_task(stage, stage["argv"], hit), "web:auth-e2e"
        )
        # Fails closed when the Nx output has no record at all.
        self.assertEqual(
            local_ci.cached_fixture_task(stage, stage["argv"], None), "web:auth-e2e"
        )
        other = {**stage, "fixtures": False}
        self.assertIsNone(local_ci.cached_fixture_task(other, stage["argv"], None))

    def test_receipt_verification_requires_proof_that_fixture_tasks_executed(self):
        item = {
            "fixtureBacked": True,
            "cacheMode": "none-by-target",
            "cache": {"executedTasks": ["web:auth-e2e"]},
        }
        self.assertIsNone(local_ci.receipt_fixture_problem(self.FIXTURE, item))
        for broken in (
            {**item, "cache": {"executedTasks": [], "hitTasks": ["web:auth-e2e"]}},
            {**item, "cache": None},
            {**item, "cacheMode": "nx"},
            {**item, "fixtureBacked": False},
        ):
            self.assertIn(
                "lacks proof", local_ci.receipt_fixture_problem(self.FIXTURE, broken)
            )

    def test_environment_shares_one_private_cache_and_scopes_gradle_caching(self):
        shim = self.tmp / "shim"
        shim.mkdir()
        cache = self.tmp / "nx-cache"

        def env_for(**kwargs):
            return local_ci.stage_env(
                {"PATH": "/usr/bin", "HOME": str(self.tmp)},
                shim_dir=shim,
                node_version="24.22.2",
                stage={},
                tmp=self.tmp,
                cache_dir=cache,
                workspace_data_dir=self.tmp / "nx-data",
                **kwargs,
            )

        warm = env_for(skip_nx_cache=False, gradle_cache=True)
        self.assertEqual(warm["NX_CACHE_DIRECTORY"], str(cache))
        self.assertEqual(warm["NX_WORKSPACE_DATA_DIRECTORY"], str(self.tmp / "nx-data"))
        self.assertNotIn("NX_SKIP_NX_CACHE", warm)
        self.assertEqual(warm["NX_NO_CLOUD"], "true")
        self.assertEqual(warm["NX_DAEMON"], "false")
        self.assertIn("-Dorg.gradle.caching=true", warm["GRADLE_OPTS"])
        self.assertNotIn("configuration-cache", warm["GRADLE_OPTS"])
        self.assertIn("-XX:ActiveProcessorCount=2", warm["JAVA_TOOL_OPTIONS"])
        self.assertEqual((warm["UV_THREADPOOL_SIZE"], warm["GOMAXPROCS"]), ("2", "2"))
        cold = env_for(skip_nx_cache=True, gradle_cache=False)
        self.assertEqual(cold["NX_SKIP_NX_CACHE"], "true")
        self.assertIn("-Dorg.gradle.caching=false", cold["GRADLE_OPTS"])

    def test_cache_hits_and_executed_tasks_are_distinguished_in_the_receipt(self):
        code = """
            print('> nx run contracts:build  [local cache]')
            print('> nx run server:test')
            print('> nx run web:format  [existing outputs match the cache, left as is]')
        """
        spec = stage("fake-nx", code, cache="nx")
        self.set_stages([spec])
        self.commit_pending()
        record = self.run_tree()
        entry = record["stages"][0]
        self.assertEqual(entry["status"], "passed")
        # The fake is not an nx invocation, so it is neither scanned nor given cache mode.
        self.assertEqual(entry["cacheMode"], "none")
        scan = local_ci.CacheScan()
        scan.feed(
            b"> nx run contracts:build  [local cache]\n> nx run server:test\n> nx run web:format  [existing outputs ma"
        )
        scan.feed(b"tch the cache, left as is]\nnoise\n")
        summary = scan.summary()
        self.assertEqual(summary["hitTasks"], ["contracts:build", "web:format"])
        self.assertEqual(summary["executedTasks"], ["server:test"])
        self.assertEqual((summary["tasks"], summary["hits"]), (3, 2))
        colored = local_ci.CacheScan()
        colored.feed(
            b"\x1b[2m> \x1b[22m\x1b[2mnx run\x1b[22m contracts:build  \x1b[2m[local cache]\x1b[22m\n"
        )
        self.assertEqual(colored.summary()["hitTasks"], ["contracts:build"])

    def test_fresh_run_is_recorded_and_still_passes_every_stage(self):
        self.stage_change()
        record = self.run_tree(fresh=True)
        receipt = json.loads(Path(record["receipt"]).read_text())
        self.assertTrue(receipt["fresh"])
        self.assertEqual(receipt["stages"][0]["status"], "passed")
        # Informational metrics are present, and dropping them leaves the receipt verifiable.
        self.assertIn("metrics", receipt["stages"][0])
        for stage in receipt["stages"]:
            stage.pop("metrics", None)
        receipt["receiptSha256"] = local_ci.receipt_digest(receipt)
        self.assertEqual(local_ci.receipt_digest(receipt), receipt["receiptSha256"])
        self.assertGreaterEqual(receipt["totalDurationSec"], 0)
        self.assertEqual(
            receipt["toolchainSha256"],
            local_ci.sha256_bytes(
                json.dumps(receipt["toolchain"], sort_keys=True).encode()
            ),
        )

    def test_changed_inputs_never_reuse_an_old_receipt_or_attempt(self):
        self.stage_change("one\n")
        first = self.run_tree()
        self.assertEqual(first["verdict"], "PASS")
        self.stage_change("source changed\n")
        second = self.run_tree()
        self.assertNotEqual(first["tree"], second["tree"])
        self.assertEqual(len(self.receipts()), 2)
        self.assertEqual(local_ci.verify_receipt(self.repo, "HEAD", home=self.home), [])
        # Tampering with the recorded toolchain (stale compiler/runtime) is detected.
        receipt_path = Path(second["receipt"])
        data = json.loads(receipt_path.read_text())
        data["toolchain"] = {"node": "v0.0.0"}
        data["receiptSha256"] = local_ci.receipt_digest(data)
        receipt_path.write_text(json.dumps(data))
        self.assertTrue(
            any(
                "toolchain" in e
                for e in local_ci.verify_receipt(self.repo, "HEAD", home=self.home)
            )
        )

    def test_one_run_per_slot_of_the_ci_home_and_fixed_export_path(self):
        held = [
            local_ci.acquire_slot(local_ci.private_dir(self.home))[0]
            for _ in range(local_ci.MAX_PARALLEL)
        ]
        try:
            with self.assertRaisesRegex(local_ci.Refused, "owns this CI home"):
                self.run_tree()
        finally:
            for fd in held:
                os.close(fd)
        paths = self.tmp / "paths.txt"
        code = f"import os; open({str(paths)!r}, 'a').write(os.getcwd() + chr(10))"
        self.set_stages([stage("where", code)])
        self.commit_pending()
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        self.assertEqual(self.run_tree()["verdict"], "PASS")
        first, second = paths.read_text().split()
        self.assertEqual(
            first, second, "stable export path keeps path-sensitive caches valid"
        )

    def test_warm_stage_list_declares_cache_only_for_deterministic_stages(self):
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        for item in spec["stages"]:
            if item.get("fixtures"):
                self.assertNotIn("cache", item, item["id"])
                self.assertFalse(item.get("gradleBuildCache"), item["id"])
        self.assertEqual(
            [s["id"] for s in spec["stages"] if s.get("gradleBuildCache")],
            ["mobile"],
        )
        gradle = (
            HERE.parents[1] / "spikes/android/capture/app/build.gradle.kts"
        ).read_text()
        self.assertIn(
            'outputs.dir(layout.buildDirectory.dir("spike-fixtures"))', gradle
        )
        for item in spec["stages"]:
            self.assertLessEqual(item["timeoutSec"], 3600, item["id"])
            if item.get("cache") == "nx":
                self.assertIn("--nxBail", item["affected"]["args"])
        cached = [s["id"] for s in spec["stages"] if s.get("cache") == "nx"]
        self.assertEqual(cached, ["build", "static", "mobile"])
        for item in spec["stages"]:
            self.assertNotIn("--skip-nx-cache", item.get("argv", []))
            self.assertNotIn(
                "--skip-nx-cache", item.get("affected", {}).get("args", [])
            )

    def test_nx_hashes_include_toolchain_runtime_and_never_use_cloud(self):
        nx = json.loads((HERE.parents[1] / "nx.json").read_text())
        runtime = {
            i["runtime"]
            for name in ("jsToolchain", "pythonToolchain", "flutterToolchain")
            for i in nx["namedInputs"][name]
            if isinstance(i, dict) and "runtime" in i
        }
        for command in (
            "node --version",
            "pnpm --version",
            "python3 --version",
            "uv --version",
        ):
            self.assertIn(command, runtime)
        # The Flutter version is read from the SDK file: `flutter --version` waits for the
        # startup lock a running flutter task holds and made the task hashes flaky (SA-113).
        self.assertTrue(any("flutter.version.json" in c for c in runtime))
        self.assertFalse(any("flutter --version" in c for c in runtime))
        self.assertTrue(nx["neverConnectToCloud"])
        self.assertFalse(nx["targetDefaults"]["integration"]["cache"])
        js = nx["pluginsConfig"]["@nx/js"]
        self.assertEqual(js["projectsAffectedByDependencyUpdates"], "auto")
        self.assertFalse(js["analyzeSourceFiles"])


class StageOpenFileLimitTests(unittest.TestCase):
    def test_stage_child_gets_the_hard_open_file_limit_when_started_at_1024(self):
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if hard != resource.RLIM_INFINITY and hard <= 1024:
            self.skipTest("hard limit is already 1024")
        resource.setrlimit(resource.RLIMIT_NOFILE, (1024, hard))
        self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, (soft, hard))
        with tempfile.TemporaryDirectory() as raw:
            result = local_ci.run_child(
                [
                    sys.executable,
                    "-c",
                    "import resource;print(resource.getrlimit(resource.RLIMIT_NOFILE)[0])",
                ],
                cwd=Path(raw),
                env=os.environ.copy(),
                log=Path(raw) / "log",
                timeout=30,
                output_cap=100000,
                secrets_=[],
                stop={"requested": False},
                capture=True,
            )
            self.assertEqual(result["status"], "passed")
            self.assertEqual(
                int(result["captured"]),
                hard if hard != resource.RLIM_INFINITY else int(result["captured"]),
            )
            self.assertGreater(int(result["captured"]), 1024)


class StageMetricsTests(unittest.TestCase):
    def test_nx_task_timings_follow_task_lines(self):
        scan = local_ci.CacheScan()
        scan.feed(b"> nx run a:build  [local cache]\n> nx run b:test\n")
        timings = scan.summary()["taskTimings"]
        self.assertEqual([t["task"] for t in timings], ["a:build", "b:test"])
        self.assertEqual([t["cacheHit"] for t in timings], [True, False])
        self.assertTrue(all(t["spanSec"] >= 0 for t in timings))

    def test_cpu_and_memory_read_from_cgroup_files(self):
        with tempfile.TemporaryDirectory() as raw:
            group = Path(raw)
            (group / "cpu.stat").write_text("usage_usec 2500000\nuser_usec 1\n")
            (group / "memory.current").write_text("12345\n")
            self.assertEqual(local_ci.cpu_seconds(group), 2.5)
            self.assertEqual(local_ci.memory_current(group), 12345)
        self.assertIsNone(local_ci.cpu_seconds(Path("/nonexistent-cgroup")))
        self.assertIsNone(local_ci.memory_current(None))

    def test_run_child_reports_cpu_delta_and_sampled_peak(self):
        with tempfile.TemporaryDirectory() as raw:
            group = Path(raw) / "cg"
            group.mkdir()
            (group / "cpu.stat").write_text("usage_usec 1000000\n")
            (group / "memory.current").write_text("4096\n")
            (group / "memory.peak").write_text("8192\n")
            result = local_ci.run_child(
                [
                    sys.executable,
                    "-c",
                    "import pathlib,sys;g=pathlib.Path(sys.argv[1]);"
                    "g.joinpath('cpu.stat').write_text('usage_usec 3500000\\n')",
                    str(group),
                ],
                cwd=Path(raw),
                env=os.environ.copy(),
                log=Path(raw) / "log",
                timeout=30,
                output_cap=100000,
                secrets_=[],
                stop={"requested": False},
                cgroup=group,
            )
            self.assertEqual(result["metrics"]["cpuSeconds"], 2.5)
            self.assertEqual(result["metrics"]["peakMemorySampledBytes"], 4096)
            self.assertEqual(result["metrics"]["scopePeakBytesAfter"], 8192)

    def test_metrics_are_none_without_a_cgroup(self):
        with tempfile.TemporaryDirectory() as raw:
            result = local_ci.run_child(
                [sys.executable, "-c", "pass"],
                cwd=Path(raw),
                env=os.environ.copy(),
                log=Path(raw) / "log",
                timeout=30,
                output_cap=1000,
                secrets_=[],
                stop={"requested": False},
            )
            metrics = result["metrics"]
            self.assertIsNone(metrics["cpuSeconds"])
            self.assertIsNone(metrics["cpuPerWall"])
            self.assertIsNone(metrics["peakMemorySampledBytes"])
            self.assertIsNone(metrics["scopePeakBytesAfter"])
            self.assertGreater(metrics["wallSeconds"], 0)

    def _write_run(self, home, name, verdict, stages):
        run = home / "logs" / name
        run.mkdir(parents=True)
        (run / "run.json").write_text(
            json.dumps({"verdict": verdict, "stages": stages})
        )

    def test_timing_report_medians_and_not_recorded(self):
        def stage(sid, wall, cpu=None, peak=None):
            metrics = {
                "cpuSeconds": cpu,
                "cpuPerWall": None if cpu is None else round(cpu / wall, 2),
                "peakMemorySampledBytes": peak,
                "scopePeakBytesAfter": None,
            }
            return {"id": sid, "durationSec": wall, "metrics": metrics}

        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            # Old run: no metrics field at all.
            self._write_run(home, "1", "PASS", [{"id": "a", "durationSec": 10.0}])
            self._write_run(home, "2", "PASS", [stage("a", 10.0, 10.0, 1048576 * 100)])
            self._write_run(home, "3", "PASS", [stage("a", 20.0, 10.0, 1048576 * 300)])
            self._write_run(home, "4", "PASS", [stage("a", 30.0, 10.0, 1048576 * 200)])
            self._write_run(home, "5", "FAIL", [stage("a", 999.0, 1.0, 1)])
            text = local_ci.timing_report(home, 5)
            row = [r for r in text.splitlines() if r.startswith("a ")][0].split()
            self.assertEqual(row[1:], ["15.0", "10.0", "0.50", "200", "4"])
            self.assertIn("over 4 PASS run(s)", text)
            # Only old runs: not recorded, never zero.
            old = Path(raw) / "old"
            self._write_run(old, "1", "PASS", [{"id": "a", "durationSec": 10.0}])
            text = local_ci.timing_report(old, 3)
            self.assertIn("not recorded", text)
            self.assertNotIn(" 0.0", text)
            self.assertIn("no PASS runs", local_ci.timing_report(Path(raw) / "none"))

    def test_missing_cgroup_counter_is_not_available_not_zero(self):
        with tempfile.TemporaryDirectory() as raw:
            group = Path(raw)
            (group / "cpu.stat").write_text("user_usec 5\n")
            (group / "memory.current").write_text("garbage\n")
            self.assertIsNone(local_ci.cpu_seconds(group))
            self.assertIsNone(local_ci.memory_current(group))


class StageFileTests(unittest.TestCase):
    def test_mobile_projects_are_selected_by_tag_not_by_name(self):
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        stages = {
            item["id"]: local_ci.stage_argv(
                spec, item, base="b" * 40, head="h" * 40, run_all=False
            )
            for item in spec["stages"]
        }
        self.assertIn("--exclude=tag:mobile-toolchain", stages["static"])
        self.assertIn("--exclude=*,!tag:mobile-toolchain", stages["mobile"])
        self.assertIn("affected", stages["mobile"])
        for item in spec["stages"]:
            self.assertNotIn(
                "android-upload-spike-native", " ".join(stages[item["id"]]), item["id"]
            )

    def test_shipped_stage_file_has_five_stages_and_no_project_list(self):
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        self.assertEqual(
            [s["id"] for s in spec["stages"]],
            ["setup", "build", "static", "mobile", "integration"],
        )
        by_id = {s["id"]: s for s in spec["stages"]}
        self.assertEqual(
            by_id["integration"]["affected"]["targets"],
            [
                "catalog-integration",
                "auth-integration",
                "auth-e2e",
                "integration",
                "e2e",
            ],
        )
        self.assertTrue(by_id["integration"]["fixtures"])
        for stage_id in ("build", "static", "mobile", "integration"):
            self.assertNotIn("argv", by_id[stage_id])
            self.assertNotIn("projects", json.dumps(by_id[stage_id]["affected"]))
        for item in spec["stages"]:
            argv = local_ci.stage_argv(
                spec, item, base="b" * 40, head="h" * 40, run_all=False
            )
            joined = " ".join(argv)
            self.assertNotIn("docker", joined)
            self.assertNotIn("--skip-nx-cache", joined)
            if item.get("affected"):
                self.assertIn("--base=" + "b" * 40, joined, item["id"])
                self.assertIn("--head=" + "h" * 40, joined, item["id"])
                # Only the light static stage parallelises (3 x ~0.6 GB: tsc, prettier, unit,
                # syntax; web:build is parallelism:false, SA-118); the native toolchains and
                # the fixture stage stay serial.
                want = (
                    "--parallel=3"
                    if item["id"] in ("build", "static")
                    else "--parallel=1"
                )
                self.assertIn(want, joined, item["id"])
                self.assertNotIn("run-many", joined, item["id"])
        self.assertNotIn("cache", by_id["integration"])
        required = {
            "scripts/local-ci/**",
            "scripts/local-ci/stages.json",
            "nx.json",
            "pnpm-lock.yaml",
            "uv.lock",
            "workers/*/uv.lock",
            "package.json",
            "packages/server/migrations/**",
            "AGENTS.md",
            "docs/local-ci.md",
        }
        self.assertTrue(required <= set(spec["alwaysRunAll"]))
        # root files that no Nx project owns, so no task would ever select them
        for extra in (".gitattributes", ".gitmodules", "pnpm-workspace.yaml"):
            self.assertIn(extra, spec["alwaysRunAll"])
        self.assertTrue(spec["unautomated"])

    def test_parallel_worker_counts_are_declared_once_and_fit_the_connection_budget(
        self,
    ):
        """SA-114: each fixture suite's worker count lives only in
        scripts/platform/test-workers.json; every consumer reads it from there; the
        counts fit the shared fixture PostgreSQL connection budget now and the
        target counts fit the budget of the max_connections the fixture definition
        will use after its next restart; fixture suites are never cacheable."""
        root = HERE.parents[1]
        config = json.loads((root / "scripts/platform/test-workers.json").read_text())
        fixture = config["fixture"]
        spec = local_ci.load_stages((HERE / "stages.json").read_bytes())
        suites = set(config["suites"])
        for item in spec["stages"]:
            if item["id"] in suites:
                self.assertFalse(
                    [a for a in item["argv"] if "concurrency" in a or "workers" in a],
                    f"{item['id']}: worker counts live in test-workers.json",
                )
        for name, suite in config["suites"].items():
            self.assertGreaterEqual(suite["targetWorkers"], suite["workers"], name)
            for key, limit in (
                ("workers", fixture["liveMaxConnections"]),
                ("targetWorkers", fixture["definitionMaxConnections"]),
            ):
                budget = (
                    limit - fixture["superuserReserved"] - fixture["otherUsersReserve"]
                )
                used = suite[key] * suite["peakConnectionsPerWorker"]
                self.assertLessEqual(
                    used, budget, f"{name}: {key} x peak connections exceeds {budget}"
                )
        definition = (root / "scripts/platform/bounded-fixtures.py").read_text()
        self.assertIn(
            f"POSTGRES_MAX_CONNECTIONS = {fixture['definitionMaxConnections']}\n",
            definition,
        )
        self.assertEqual(definition.count("max_connections="), 1)

        consumers = {
            "web-auth-e2e": ("apps/web/project.json", "test-e2e/*.test.mjs"),
            "jobs-controller-integration": (
                "apps/jobs/package.json",
                "test-integration",
            ),
            "server-auth-integration": ("packages/server/package.json", "test-auth/"),
            "catalog-integration": (
                "packages/server/scripts/catalog-integration.sh",
                "default_concurrency=$(node",
            ),
        }
        for suite, (file, marker) in consumers.items():
            text = (root / file).read_text()
            self.assertRegex(text, rf"test-workers\.mjs\"? {suite}", suite)
            self.assertIn(marker, text, suite)
            for line in (x for x in text.splitlines() if marker in x):
                self.assertIsNone(re.search(r"test-concurrency=\d", line), suite)
        launcher = (root / consumers["catalog-integration"][0]).read_text()
        self.assertEqual(launcher.count("default_concurrency="), 1)
        self.assertNotIn(
            "test:catalog", (root / "packages/server/package.json").read_text()
        )
        self.assertEqual(
            sorted(
                p.name
                for p in (root / "apps/jobs/test-integration").glob("controller*")
            ),
            [
                "controller-dispatch.e2e.test.mjs",
                "controller-loss.e2e.test.mjs",
                "controller-process.mjs",
                "controller-recipe.e2e.test.mjs",
                "controller-support.mjs",
            ],
        )
        for project_file, name in (
            ("apps/web/project.json", "auth-e2e"),
            ("apps/jobs/project.json", "integration"),
            ("packages/server/project.json", "auth-integration"),
            ("packages/server/project.json", "catalog-integration"),
        ):
            target = json.loads((root / project_file).read_text())["targets"][name]
            self.assertIs(target["cache"], False, name)
            self.assertIs(target["parallelism"], False, name)


FAKE_NX = r"""
import json, os, subprocess, sys

fx = json.load(open("nxfixture.json"))
args = sys.argv[1:]
projects = fx["projects"]


def opt(name):
    for a in args:
        if a.startswith(name + "="):
            return a.split("=", 1)[1]


def excluded():
    gone = set()
    for item in (opt("--exclude") or "").split(","):
        if not item:
            continue
        neg = item.startswith("!")
        item = item.lstrip("!")
        hit = (
            set(projects)
            if item == "*"
            else {n for n, p in projects.items() if item[4:] in p.get("tags", [])}
        )
        gone = gone - hit if neg else gone | hit
    return gone


def affected():
    if fx.get("failAffected"):
        sys.exit(3)
    out = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", opt("--base"), opt("--head")],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    return [
        n for n, p in projects.items()
        if any(f.startswith(pre) for f in out for pre in p["paths"])
    ]


with open(fx["log"], "a") as log:
    log.write(" ".join(args) + "\n")
if fx.get("requireMarker") and not os.path.exists(fx["requireMarker"]):
    sys.exit(9)  # a query before setup finished
if os.getcwd() != fx["repo"] and not os.path.exists(".git/objects/info/alternates"):
    sys.exit(10)  # the export cannot read the real history
cmd = args[0]
if cmd == "graph":
    if fx.get("failGraph"):
        sys.exit(4)
    nodes = {
        n: {"data": {"tags": p.get("tags", []), "targets": {t: {} for t in p["targets"]}}}
        for n, p in projects.items()
    }
    json.dump({"graph": {"nodes": nodes}}, open(opt("--file"), "w"))
elif cmd == "show":
    if fx.get("failShow"):
        sys.exit(5)
    print(json.dumps(affected()))
elif cmd == "affected" and opt("--explain"):
    targets = args[args.index("-t") + 1].split(",")
    hit = {f"{n}:{t}": [] for n in affected() for t in targets if t in projects[n]["targets"]}
    if fx.get("extraIds"):
        hit[fx["extraIds"]] = []
    json.dump({} if fx.get("badExplain") else {"affected": hit}, open(opt("--explain"), "w"))
else:
    targets = args[args.index("-t") + 1].split(",")
    names = affected() if cmd == "affected" else list(projects)
    for n in names:
        if n in excluded():
            continue
        for t in targets:
            if t in projects[n]["targets"]:
                if f"{n}:{t}" in fx.get("silent", []):
                    continue
                mark = " [local cache]" if f"{n}:{t}" in fx.get("cached", []) else ""
                print(f"> nx run {n}:{t}{mark}")
"""


FIXTURE_STAGE_TIMEOUT_SEC = (
    600  # fake stages do ~0.1 s of work; only a hung child should hit it
)


class AffectedTests(RepoCase):
    ALWAYS = [
        "scripts/local-ci/**",
        "scripts/local-ci/stages.json",
        "nx.json",
        "pnpm-lock.yaml",
        "uv.lock",
        "workers/*/uv.lock",
        "package.json",
        "packages/server/migrations/**",
        "AGENTS.md",
        "docs/local-ci.md",
        ".gitattributes",
        ".gitmodules",
        ".gitignore",
        ".nxignore",
        ".npmrc",
        ".nvmrc",
        "pnpm-workspace.yaml",
        "requirements-inspection.txt",
        "requirements-stera.txt",
    ]

    def fixture_projects(self):
        contracts = "packages/contracts/"
        return {
            "server": {
                "targets": ["build", "test", "catalog-integration"],
                "paths": ["packages/server/", contracts],
            },
            "web": {
                "targets": ["build", "test", "auth-e2e"],
                "paths": ["apps/web/", contracts],
            },
            "jobs": {
                "targets": ["build", "integration"],
                "paths": [
                    "apps/jobs/",
                    "packages/server/",
                    "workers/processing/",
                    contracts,
                ],
            },
            "processing": {
                "targets": ["build", "test"],
                "paths": ["workers/processing/", contracts],
            },
            "mobile": {
                "tags": ["mobile-toolchain"],
                "targets": ["build", "test"],
                "paths": ["apps/mobile/", contracts],
            },
        }

    def build(self, *, nxfixture=None, fixtures=False, always=None):
        # The fake gate's descendants exit at once; on a host whose memory.high throttling
        # stalls processes for seconds (SA-106 r2: 191 tests took 601 s instead of 130 s) the
        # real 2 s settle window must not decide the verdict of a test about the affected set.
        patcher = mock.patch.object(local_ci, "LEAK_SETTLE_SEC", 60.0)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.wait_for_no_strays()
        tools = self.repo / "tools"
        tools.mkdir(exist_ok=True)
        (tools / "fake_nx.py").write_text(FAKE_NX)
        self.nxlog = self.tmp / "nx-calls.log"
        (self.repo / "nxfixture.json").write_text(
            json.dumps(
                {
                    "log": str(self.nxlog),
                    "repo": str(self.repo),
                    "projects": self.fixture_projects(),
                    **(nxfixture or {}),
                }
            )
        )
        flags = ["--parallel=1"]
        self.set_stages(
            [
                stage("setup", "print('setup')"),
                {
                    "id": "static",
                    "title": "static",
                    "timeoutSec": FIXTURE_STAGE_TIMEOUT_SEC,
                    "cache": "nx",
                    "affected": {
                        "targets": ["build", "test"],
                        "exclude": "tag:mobile-toolchain",
                        "args": flags,
                    },
                },
                {
                    "id": "mobile",
                    "title": "mobile",
                    "timeoutSec": FIXTURE_STAGE_TIMEOUT_SEC,
                    "affected": {
                        "targets": ["build", "test"],
                        "exclude": "*,!tag:mobile-toolchain",
                        "args": flags,
                    },
                },
                {
                    "id": "integration",
                    "title": "integration",
                    "timeoutSec": FIXTURE_STAGE_TIMEOUT_SEC,
                    "fixtures": fixtures,
                    "affected": {
                        "targets": ["catalog-integration", "auth-e2e", "integration"],
                        "args": flags,
                    },
                },
            ],
            nx=[sys.executable, "tools/fake_nx.py"],
            alwaysRunAll=self.ALWAYS if always is None else always,
        )
        self.commit_pending("fake nx workspace")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")

    def change(self, *paths):
        for path in paths:
            target = self.repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(target.read_text() + "x\n" if target.exists() else "x\n")

    def wait_for_no_strays(self, limit=60.0):
        """The runner reaps every descendant of this process (it is its subreaper), so a process
        an earlier test orphaned and a loaded host is still killing would fail this test's
        stage as a leak. Wait until none is left; name the survivor instead of guessing."""
        deadline = time.monotonic() + limit
        while True:
            for pid, state in local_ci.descendants(os.getpid()):
                if state == "Z":
                    with contextlib.suppress(ChildProcessError, OSError):
                        os.waitpid(pid, os.WNOHANG)
            left = [
                local_ci.describe_process(pid)
                for pid, state in local_ci.descendants(os.getpid())
                if state != "Z"
            ]
            if not left:
                return
            if time.monotonic() > deadline:
                self.fail(f"processes of earlier tests are still alive: {left}")
            time.sleep(0.05)

    def run_tree(self, **kwargs):
        """Keep the runner's messages so a failed verdict names its cause in the assertion."""
        self.run_log = []
        kwargs.setdefault("log", self.run_log.append)
        return super().run_tree(**kwargs)

    def assert_passed(self, record):
        stages = [
            (s["id"], s["status"], s.get("durationSec")) for s in record["stages"]
        ]
        self.assertEqual(
            record["verdict"],
            "PASS",
            f"stages={stages} detail={record.get('detail')} log={self.run_log[-8:]}",
        )

    def gate(self, *paths, **kwargs):
        self.change(*paths)
        return self.run_tree(**kwargs)

    def statuses(self, record):
        return {s["id"]: s["status"] for s in record["stages"]}

    def affected_block(self, record):
        return json.loads(Path(record["receipt"]).read_text())["affected"]

    def nx_runs(self):
        if not self.nxlog.exists():
            return []
        return [
            line
            for line in self.nxlog.read_text().splitlines()
            if "--explain" not in line
            and line.split()[0] != "show"
            and line.split()[0] != "graph"
        ]

    def test_backend_only_change_skips_mobile_with_the_reason(self):
        self.build()
        record = self.gate("packages/server/src/cli.ts")
        self.assert_passed(record)
        self.assertEqual(
            self.statuses(record),
            {
                "setup": "passed",
                "static": "passed",
                "mobile": "skipped",
                "integration": "passed",
            },
        )
        entry = next(s for s in record["stages"] if s["id"] == "mobile")
        self.assertEqual(entry["reason"], "skipped: unaffected")
        block = self.affected_block(record)
        base = sh(self.repo, "git", "rev-parse", "origin/main")
        self.assertEqual(block["base"], base)
        self.assertEqual(block["head"], sh(self.repo, "git", "rev-parse", "HEAD"))
        self.assertEqual(block["projects"], ["jobs", "server"])
        self.assertFalse(block["runAll"])
        self.assertEqual(block["matchedAlwaysRunPaths"], [])
        stages = block["stages"]
        self.assertEqual(
            stages["integration"]["selectedTasks"],
            ["jobs:integration", "server:catalog-integration"],
        )
        self.assertEqual(
            stages["mobile"]["skippedTasks"],
            [
                {"task": "mobile:build", "reason": "skipped: unaffected"},
                {"task": "mobile:test", "reason": "skipped: unaffected"},
            ],
        )
        self.assertIn(
            {"task": "web:auth-e2e", "reason": "skipped: unaffected"},
            stages["integration"]["skippedTasks"],
        )
        runs = self.nx_runs()
        self.assertEqual(len([r for r in runs if r.startswith("affected")]), 2)
        self.assertTrue(all(f"--base={base}" in r for r in runs))
        self.assertFalse(any("!tag:mobile-toolchain" in r for r in runs))
        self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])

    def test_worker_only_change_runs_processing_and_jobs_not_mobile_or_web_e2e(self):
        self.build()
        record = self.gate("workers/processing/src/pipeline.py")
        self.assert_passed(record)
        block = self.affected_block(record)
        self.assertEqual(block["projects"], ["jobs", "processing"])
        self.assertEqual(
            block["stages"]["integration"]["selectedTasks"], ["jobs:integration"]
        )
        self.assertEqual(self.statuses(record)["mobile"], "skipped")
        self.assertNotIn(
            "web:auth-e2e", block["stages"]["integration"]["selectedTasks"]
        )
        self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])

    def test_contracts_change_runs_every_stage_through_the_graph(self):
        self.build()
        record = self.gate("packages/contracts/src/index.ts")
        self.assert_passed(record)
        self.assertEqual(set(self.statuses(record).values()), {"passed"})
        block = self.affected_block(record)
        self.assertFalse(block["runAll"])
        self.assertIn("mobile", block["projects"])
        self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])

    def test_web_only_change_skips_mobile_and_its_e2e(self):
        self.build()
        record = self.gate("apps/web/app/page.tsx")
        self.assert_passed(record)
        self.assertEqual(self.statuses(record)["mobile"], "skipped")
        selected = self.affected_block(record)["stages"]["integration"]["selectedTasks"]
        self.assertEqual(selected, ["web:auth-e2e"])
        self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])

    def test_every_always_run_path_runs_everything_and_is_named_in_the_receipt(self):
        self.build()
        paths = [
            "scripts/local-ci/helper.py",
            "scripts/local-ci/stages.json",
            "nx.json",
            "pnpm-lock.yaml",
            "uv.lock",
            "workers/processing/uv.lock",
            "package.json",
            "packages/server/migrations/009_new.sql",
            "AGENTS.md",
            "docs/local-ci.md",
            ".gitattributes",
            ".gitmodules",
            "pnpm-workspace.yaml",
            "requirements-stera.txt",
        ]
        for path in paths:
            with self.subTest(path=path):
                sh(self.repo, "git", "reset", "-q", "--hard", "origin/main")
                before = len(self.nx_runs())
                if path == "scripts/local-ci/stages.json":
                    # the stage list itself is under test, so change it harmlessly
                    spec = json.loads((self.repo / local_ci.STAGES_PATH).read_text())
                    spec["unautomated"] = ["physical device", "note"]
                    (self.repo / local_ci.STAGES_PATH).write_text(json.dumps(spec))
                else:
                    self.change(path)
                record = self.run_tree()
                self.assert_passed(record)
                self.assertEqual(set(self.statuses(record).values()), {"passed"})
                block = self.affected_block(record)
                self.assertTrue(block["runAll"])
                self.assertEqual(block["matchedAlwaysRunPaths"], [path])
                self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])
                runs = self.nx_runs()[before:]
                self.assertEqual(len(runs), 3, runs)
                for run in runs:
                    self.assertTrue(run.startswith("run-many"), run)
                    self.assertNotIn("--base", run)

    def test_failed_nx_computation_runs_everything_never_narrows(self):
        for fixture in (
            {"failAffected": True},
            {"failGraph": True},
            {"failShow": True},
            {"badExplain": True},
            {"extraIds": "server:build:production"},
        ):
            with self.subTest(fixture=fixture):
                self.build(nxfixture=fixture)
                record = self.gate("apps/web/app/page.tsx")
                self.assert_passed(record)
                block = self.affected_block(record)
                self.assertEqual(block["computation"], "failed")
                self.assertTrue(block["runAll"])
                self.assertEqual(set(self.statuses(record).values()), {"passed"})
                self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])

    def test_unresolvable_base_runs_everything(self):
        self.build()
        sh(self.repo, "git", "update-ref", "-d", "refs/remotes/origin/main")
        record = self.gate("apps/web/app/page.tsx")
        self.assert_passed(record)
        block = self.affected_block(record)
        self.assertEqual(block["computation"], "base-unresolved")
        self.assertIsNone(block["base"])
        self.assertEqual(set(self.statuses(record).values()), {"passed"})
        self.assertTrue(local_ci.verify_receipt(self.repo, home=self.home))

    def test_shallow_clone_is_never_trusted_for_a_base(self):
        self.build()
        self.change("apps/web/app/page.tsx")
        self.commit_pending()
        clone = self.tmp / "shallow"
        sh(
            self.tmp,
            "git",
            "clone",
            "-q",
            "--depth",
            "1",
            f"file://{self.repo}",
            str(clone),
        )
        head = sh(clone, "git", "rev-parse", "HEAD")
        self.assertEqual(local_ci.resolve_affected_base(clone, head), (None, "shallow"))
        base = sh(self.repo, "git", "rev-parse", "origin/main")
        self.assertEqual(
            local_ci.resolve_affected_base(self.repo, "HEAD"), (base, "ok")
        )
        spec = local_ci.load_stages((self.repo / local_ci.STAGES_PATH).read_bytes())
        nx = local_ci.make_nx(local_ci.nx_command(spec), self.repo, dict(os.environ))
        self.addCleanup(shutil.rmtree, nx.scratch, ignore_errors=True)
        plan = local_ci.plan_affected(
            spec, nx=nx, repo=clone, head=head, base=None, base_problem="shallow"
        )
        self.assertEqual(plan["computation"], "shallow")
        self.assertTrue(plan["runAll"])
        self.assertTrue(all(st["run"] for st in plan["stages"].values()))
        self.assertTrue(plan["stages"]["mobile"]["selectedTasks"])

    def rewrite_affected(self, record, mutate, *, reseal=True):
        def apply(data):
            mutate(data)
            if reseal:
                data["affected"]["evidenceSha256"] = local_ci.evidence_digest(
                    data["affected"]
                )

        VerifyTests.rewrite(self, record, apply)

    def test_verify_rejects_a_tampered_affected_set(self):
        self.build()
        record = self.gate("apps/web/app/page.tsx")
        self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])
        original = Path(record["receipt"]).read_text()

        def restore():
            Path(record["receipt"]).write_text(original)

        for name, mutate, expect in (
            (
                "unsealed projects",
                lambda d: d["affected"].__setitem__("projects", ["web", "mobile"]),
                "evidence hash",
            ),
            (
                "resealed projects",
                lambda d: d["affected"].__setitem__("projects", ["web", "mobile"]),
                "recomputed affected set differs",
            ),
            (
                "wrong base",
                lambda d: d["affected"].__setitem__("base", "0" * 40),
                "latest origin/main",
            ),
            (
                "skipped task the recomputed set selects",
                lambda d: (
                    d["affected"]["stages"]["integration"].update(
                        run=False, selectedTasks=[]
                    ),
                    d["stages"][3].update(
                        status="skipped", reason="skipped: unaffected"
                    ),
                ),
                "recomputed affected set differs",
            ),
            (
                "foreign skip reason",
                lambda d: d["stages"][2].__setitem__("reason", "skipped: slow"),
                "unaffected reason",
            ),
            (
                "changed files",
                lambda d: d["affected"].__setitem__("changedFilesSha256", "0" * 64),
                "changed files",
            ),
        ):
            with self.subTest(name):
                self.rewrite_affected(
                    record, mutate, reseal=name != "unsealed projects"
                )
                errors = local_ci.verify_receipt(self.repo, home=self.home)
                self.assertTrue(any(expect in e for e in errors), (name, errors))
                restore()
        self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])

    def test_verify_rejects_contradictory_stage_records(self):
        self.build()
        record = self.gate("apps/web/app/page.tsx")
        original = Path(record["receipt"]).read_text()
        for name, mutate, expect in (
            (
                "skipped but the record says run",
                lambda d: d["stages"][2].update(status="passed", reason=None),
                "contradicts",
            ),
            (
                "passed but the record says skip",
                lambda d: d["affected"]["stages"]["static"].update(run=False),
                "contradicts",
            ),
            (
                "missing stage record",
                lambda d: d["affected"]["stages"].pop("mobile"),
                "differ from the declared stages",
            ),
            (
                "skipped setup",
                lambda d: d["stages"][0].update(
                    status="skipped", reason="skipped: unaffected"
                ),
                "did not pass",
            ),
        ):
            with self.subTest(name):
                self.rewrite_affected(record, mutate)
                errors = local_ci.verify_receipt(self.repo, home=self.home)
                self.assertTrue(any(expect in e for e in errors), (name, errors))
                Path(record["receipt"]).write_text(original)

    def test_verify_needs_a_clean_copy_of_the_head(self):
        self.build()
        self.gate("apps/web/app/page.tsx")
        (self.repo / "stray.txt").write_text("untracked\n")
        errors = local_ci.verify_receipt(self.repo, home=self.home)
        self.assertTrue(any("clean copy" in e for e in errors), errors)

    def test_a_planned_task_nx_never_reported_fails_the_stage(self):
        self.build(nxfixture={"silent": ["server:build"]})
        record = self.gate("packages/server/src/cli.ts")
        self.assertEqual(record["verdict"], "FAIL")
        entry = next(s for s in record["stages"] if s["id"] == "static")
        self.assertEqual(entry["status"], "plan-mismatch")
        self.assertIn("server:build", entry["detail"])

    def test_a_replayed_fixture_task_is_found_even_without_a_plan(self):
        stage_ = {"fixtures": True, "affected": {"targets": ["integration"]}}
        hit = {"hitTasks": ["jobs:integration", "web:build"], "executedTasks": []}
        self.assertEqual(
            local_ci.cached_fixture_task(stage_, [], hit, []), "jobs:integration"
        )

    def test_unsupported_exclude_patterns_are_rejected(self):
        base = {
            "schema": local_ci.STAGES_SCHEMA,
            "pins": {},
            "stages": [
                {"id": "a", "affected": {"targets": ["t"], "exclude": "tag:mob*"}}
            ],
        }
        with self.assertRaisesRegex(local_ci.Refused, "unsupported exclude"):
            local_ci.load_stages(json.dumps(base).encode())

    def test_verify_rejects_narrowing_after_failure_or_an_always_run_path(self):
        self.build(nxfixture={"failAffected": True})
        record = self.gate("apps/web/app/page.tsx")

        def narrow(data):
            data["affected"]["runAll"] = False
            data["affected"]["stages"]["mobile"].update(run=False, selectedTasks=[])
            data["stages"][2].update(status="skipped", reason="skipped: unaffected")

        self.rewrite_affected(record, narrow)
        errors = local_ci.verify_receipt(self.repo, home=self.home)
        self.assertTrue(any("narrowed" in e for e in errors), errors)

    def test_verify_rejects_a_skipped_stage_when_an_always_run_path_matched(self):
        self.build()
        record = self.gate("docs/local-ci.md")

        def skip(data):
            data["affected"]["matchedAlwaysRunPaths"] = []
            data["affected"]["runAll"] = False
            data["stages"][2].update(status="skipped", reason="skipped: unaffected")
            data["affected"]["stages"]["mobile"].update(run=False)

        self.rewrite_affected(record, skip)
        errors = local_ci.verify_receipt(self.repo, home=self.home)
        self.assertTrue(any("always-run paths differ" in e for e in errors), errors)

    def test_verify_fails_closed_when_the_affected_set_cannot_be_reproduced(self):
        self.build()
        self.gate("apps/web/app/page.tsx")
        broken = mock.Mock(side_effect=local_ci.Refused("nx is gone"))
        broken.scratch = self.tmp / "nx-scratch"
        errors = local_ci.verify_receipt(self.repo, home=self.home, nx=broken)
        self.assertTrue(any("could not be reproduced" in e for e in errors), errors)

    def test_receipt_without_the_affected_set_is_rejected(self):
        self.build()
        record = self.gate("apps/web/app/page.tsx")
        VerifyTests.rewrite(self, record, lambda d: d.pop("affected"))
        errors = local_ci.verify_receipt(self.repo, home=self.home)
        self.assertTrue(any("lacks the affected set" in e for e in errors), errors)

    def fixture_file(self):
        path = self.tmp / "fixtures.env"
        path.write_text(FIXTURE_ENV)
        return str(path)

    def test_fixture_stage_never_accepts_a_cached_task(self):
        self.build(fixtures=True, nxfixture={"cached": ["server:catalog-integration"]})
        record = self.gate(
            "packages/server/src/cli.ts",
            fixtures_path=self.fixture_file(),
            service_check=FAKE_SERVICE,
        )
        self.assertEqual(record["verdict"], "FAIL")
        entry = next(s for s in record["stages"] if s["id"] == "integration")
        self.assertEqual(entry["status"], "cached-fixture")
        self.assertIn("server:catalog-integration", entry["detail"])
        self.assertEqual(self.receipts(), [])

    def test_fixture_stage_with_no_known_task_is_never_proven_executed(self):
        # The graph cannot be read: everything runs, but no fixture task is known to have
        # executed, so the stage must fail instead of passing on an empty proof.
        self.build(fixtures=True, nxfixture={"failGraph": True})
        record = self.gate(
            "packages/server/src/cli.ts",
            fixtures_path=self.fixture_file(),
            service_check=FAKE_SERVICE,
        )
        self.assertEqual(record["verdict"], "FAIL")
        entry = next(s for s in record["stages"] if s["id"] == "integration")
        self.assertEqual(entry["status"], "cached-fixture")
        self.assertEqual(self.receipts(), [])
        self.assertIsNotNone(
            local_ci.receipt_fixture_problem(
                {"fixtures": True, "affected": {"targets": ["integration"]}},
                {"fixtureBacked": True, "cacheMode": "none-by-target", "cache": {}},
                [],
            )
        )

    def test_fixture_stage_receipt_proves_every_selected_task_executed(self):
        self.build(fixtures=True)
        record = self.gate(
            "packages/server/src/cli.ts",
            fixtures_path=self.fixture_file(),
            service_check=FAKE_SERVICE,
        )
        self.assert_passed(record)
        entry = next(s for s in record["stages"] if s["id"] == "integration")
        self.assertEqual(entry["cacheMode"], "none-by-target")
        self.assertEqual(local_ci.verify_receipt(self.repo, home=self.home), [])

        def forge(data):
            data["stages"][3]["cache"] = {"executedTasks": [], "hitTasks": ["x"]}

        VerifyTests.rewrite(self, record, forge)
        errors = local_ci.verify_receipt(self.repo, home=self.home)
        self.assertTrue(any("executed uncached" in e for e in errors), errors)

    def test_nx_queries_run_after_setup_inside_the_export_with_the_real_history(self):
        marker = self.tmp / "setup-done"
        self.build(nxfixture={"requireMarker": str(marker)})
        specpath = self.repo / local_ci.STAGES_PATH
        spec = json.loads(specpath.read_text())
        spec["stages"][0] = stage("setup", f"open({str(marker)!r}, 'w').write('x')")
        specpath.write_text(json.dumps(spec))
        self.commit_pending("setup marker")
        sh(self.repo, "git", "update-ref", "refs/remotes/origin/main", "HEAD")
        record = self.gate("apps/web/app/page.tsx")
        # The stub exits 9 before the marker exists and 10 without the alternates file in
        # the export, either of which would turn the computation into `failed`.
        self.assert_passed(record)
        block = self.affected_block(record)
        self.assertEqual(block["computation"], "ok", block["computationDetail"])
        self.assertFalse(block["runAll"])

    def test_stage_file_validation(self):
        base = {
            "schema": local_ci.STAGES_SCHEMA,
            "pins": {},
            "stages": [{"id": "a", "affected": {"targets": []}}],
        }
        with self.assertRaises(local_ci.Refused):
            local_ci.load_stages(json.dumps(base).encode())
        base["stages"] = [{"id": "a", "affected": {"targets": ["t"]}}]
        base["alwaysRunAll"] = "nx.json"
        with self.assertRaises(local_ci.Refused):
            local_ci.load_stages(json.dumps(base).encode())

    def test_always_run_globs(self):
        match = local_ci.glob_match
        self.assertTrue(match("scripts/local-ci/**", "scripts/local-ci/a/b.py"))
        self.assertTrue(match("workers/*/uv.lock", "workers/processing/uv.lock"))
        self.assertFalse(match("workers/*/uv.lock", "workers/a/b/uv.lock"))
        self.assertTrue(match("package.json", "package.json"))
        self.assertFalse(match("package.json", "apps/web/package.json"))
        self.assertFalse(match("uv.lock", "workers/processing/uv.lock"))
        self.assertTrue(
            match("packages/server/migrations/**", "packages/server/migrations/001.sql")
        )


if __name__ == "__main__":
    unittest.main()
