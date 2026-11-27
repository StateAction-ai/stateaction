import asyncio
from dataclasses import replace
from pathlib import Path
from time import time
from types import SimpleNamespace

import pytest
from stateaction_controller.api import AmbiguousApiError
from stateaction_controller.config import Settings
from stateaction_controller.controller import Controller, Lease
from stateaction_controller.journal import JournalStore, iso
from stateaction_controller.local_process import boot_id

JOB = "00000000-0000-4000-8000-000000000153"
PROCESSING = str(Path(__file__).resolve().parents[2] / "processing/.venv/bin/python")


class Fixture:
    def __init__(self, path):
        self.now = time()
        self.store = JournalStore(path)
        self.settings = Settings(
            "local",
            "http://127.0.0.1:1",
            path,
            pipeline="local_fixture_noop",
            python=PROCESSING,
            poll=0.01,
            renew=0.02,
            grace=1,
        )
        self.catalog = {
            "executionBackend": "local",
            "executionRef": None,
            "state": "submitting",
            "startDeadline": iso(self.now + 15),
            "executionDeadline": iso(self.now + 25),
        }
        self.lease = Lease("owner", self.now + 60)
        self.actions = []
        self.controller = Controller(
            self.settings, self, self.store, self.lease, JOB, "run"
        )
        self.lost_ack = False

    async def status(self, job_id):
        assert job_id == JOB
        return self.catalog.copy()

    async def act(self, job_id, action, **facts):
        assert job_id == JOB
        self.actions.append((action, facts))
        if action == "record_worker_submission":
            if self.lost_ack:
                raise AmbiguousApiError()
            return {**self.catalog, "state": "recorded", "bootstrapToken": "synthetic"}
        if action == "record_execution":
            self.catalog["executionRef"] = facts["executor"]["localExecutionRef"]
        if action == "mark_submit_unknown":
            self.catalog["state"] = "submit_unknown"
        return {"recorded": True}

    def record(self, phase, **fields):
        return {
            "version": 1,
            "jobId": JOB,
            "runRef": "run",
            "executionRef": "local-synthetic",
            "bootId": boot_id(),
            "startDeadline": self.catalog["startDeadline"],
            "executionDeadline": self.catalog["executionDeadline"],
            "phase": phase,
            **fields,
        }

    def run(self):
        return asyncio.run(self.controller.execute(self.catalog.copy()))


@pytest.mark.parametrize("problem", ["none", "unproven", "different_run"])
def test_exited_journal_requires_isolation_and_original_run(tmp_path, problem):
    f = Fixture(tmp_path)
    record = f.record(
        "exited",
        pid=123,
        pgid=123,
        sid=123,
        startTicks="123",
        singleProcess=True,
        exit={"code": 0, "signal": None},
    )
    if problem == "unproven":
        del record["singleProcess"]
    if problem == "different_run":
        record["runRef"] = "other"
    f.store.write_local(record)
    decision = f.run()
    if problem == "none":
        assert decision["evidence"] == "recorded"
        assert [action for action, _ in f.actions] == ["record_execution_evidence"]
    else:
        assert decision["outcome"] == "needs_operator"
        assert [action for action, _ in f.actions] == ["mark_submit_unknown"]


def test_previous_boot_intent_cannot_spawn(tmp_path):
    f = Fixture(tmp_path)
    record = f.record("intent", bootId="00000000-0000-4000-8000-111111111111")
    f.store.write_local(record)
    f.store.save_token(JOB, None, "synthetic")
    assert f.run()["reason"] == "boot_changed"
    assert f.store.read_local(JOB, None) == record
    assert [action for action, _ in f.actions] == ["mark_submit_unknown"]


def test_absent_executable_preserves_consumed_spawn_reservation(tmp_path):
    f = Fixture(tmp_path)
    f.controller.settings = replace(f.settings, python=str(tmp_path / "missing"))
    with pytest.raises(RuntimeError, match="executable is unavailable"):
        f.run()
    assert f.run()["reason"] == "spawn_outcome_uncertain"
    assert f.store.read_local(JOB, None)["phase"] == "spawning"
    assert not f.store.reserve_spawn(JOB, None)
    assert [a for a, _ in f.actions].count("record_worker_submission") == 1
    assert [a for a, _ in f.actions].count("record_execution") == 1
    assert not any(a == "record_execution_evidence" for a, _ in f.actions)


def test_lost_local_submission_ack_is_fenced(tmp_path):
    f = Fixture(tmp_path)
    f.lost_ack = True
    assert f.run()["outcome"] == "submit_unknown"
    assert f.run()["outcome"] == "needs_operator"
    assert f.store.read_local(JOB, None) is None
    assert [action for action, _ in f.actions] == [
        "record_worker_submission",
        "mark_submit_unknown",
    ]


@pytest.mark.parametrize("recorded", ["spawning", "torn"])
def test_unproven_local_identity_never_spawns_or_records_evidence(tmp_path, recorded):
    f = Fixture(tmp_path)
    if recorded == "torn":
        f.store._write(JOB, None, "journal.json", b'{"phase":')
    else:
        f.store.write_local(f.record("spawning"))
    before = f.store._read(JOB, None, "journal.json")
    assert f.run()["outcome"] in ("submit_unknown", "needs_operator")
    assert f.store._read(JOB, None, "journal.json") == before
    assert [a for a, _ in f.actions] == ["mark_submit_unknown"]


def test_crash_after_local_spawn_reservation_cannot_repeat_spawn(tmp_path):
    f = Fixture(tmp_path)
    real = f.store.reserve_spawn

    def crash(*args):
        assert real(*args)
        raise OSError("after reservation")

    f.store.reserve_spawn = crash
    with pytest.raises(OSError, match="after reservation"):
        f.run()
    f.controller.store = JournalStore(tmp_path)
    assert f.run()["reason"] == "spawn_already_reserved"
    assert f.controller.store.read_local(JOB, None)["phase"] == "intent"
    assert not any(a == "record_execution_evidence" for a, _ in f.actions)


def test_local_refuses_modal_admission_or_foreign_modal_journal(tmp_path):
    f = Fixture(tmp_path)
    f.catalog["executionBackend"] = "modal"
    assert f.run()["reason"] == "backend_mismatch"
    assert not f.actions
    f.catalog["executionBackend"] = "local"
    record = f.record("intent", executor="modal")
    record.pop("bootId")
    record.pop("executionRef")
    f.store.write_modal(record, None)
    assert f.run()["reason"] == "foreign_modal_journal"
    assert [a for a, _ in f.actions] == ["mark_submit_unknown"]


def test_lease_lost_while_reading_cancel_status_leaves_child_for_takeover(
    tmp_path, monkeypatch
):
    f = Fixture(tmp_path)
    record = f.record(
        "running", pid=123, pgid=123, sid=123, startTicks="123", singleProcess=True
    )
    f.store.write_local(record)

    async def inspect(*_):
        return "alive"

    async def status(_):
        f.lease.revoked = True
        return {"state": "cancel_requested"}

    async def helper(*_, **__):
        pytest.fail("Stale owner must not signal the worker")

    f.status = status
    monkeypatch.setattr("stateaction_controller.local_controller.inspect", inspect)
    monkeypatch.setattr("stateaction_controller.local_controller.helper", helper)
    assert f.run()["outcome"] == "lease_lost"
    assert f.store.read_local(JOB, None) == record
    assert not f.actions


def test_running_pid_with_changed_ticks_withholds_evidence(tmp_path, monkeypatch):
    f = Fixture(tmp_path)
    record = f.record(
        "running", pid=123, pgid=123, sid=123, startTicks="123", singleProcess=True
    )
    f.store.write_local(record)

    async def inspect(*_):
        return "leader_identity_changed"

    monkeypatch.setattr("stateaction_controller.local_controller.inspect", inspect)
    assert f.run()["reason"] == "leader_identity_changed"
    assert [a for a, _ in f.actions] == ["mark_submit_unknown"]


def test_immutable_deadline_signals_only_verified_child_and_records_exit(tmp_path):
    from stateaction_controller.local_process import spawn

    f = Fixture(tmp_path)

    async def run():
        intent = f.record(
            "spawning",
            startDeadline=iso(f.now - 20),
            executionDeadline=iso(f.now - 10),
        )
        f.store.write_local(intent)
        assert f.store.reserve_spawn(JOB, None)
        child, identity = await spawn(f.settings, f.store, intent, fixture=True)
        try:
            f.store.write_local(dict(intent, phase="running", **identity))
            f.catalog.update(state="running", executionRef=intent["executionRef"])
            result = await f.controller.execute(f.catalog)
            assert result["executionRef"] == intent["executionRef"]
            assert result["exit"] == {"code": None, "signal": "not_observed"}
            assert result["evidence"] == "recorded"
            assert await asyncio.to_thread(child.wait, 5) == -9
        finally:
            child.stdin.close()
            if child.returncode is None:
                child.kill()
                await asyncio.to_thread(child.wait, 5)

    asyncio.run(run())
    action, facts = f.actions[-1]
    assert action == "record_execution_evidence"
    assert facts["evidence"]["detail"]["termination"] == "execution_deadline"
    assert f.store.read_local(JOB, None)["phase"] == "exited"


def test_same_run_takeover_reserves_spawn_before_paused_owner_can_start(
    tmp_path, monkeypatch
):
    f = Fixture(tmp_path)
    f.store.write_local(f.record("intent"))
    f.store.save_token(JOB, None, "synthetic")
    real_act = f.act
    spawned = []

    async def run():
        own = f.controller
        successor = Controller(
            f.settings,
            f,
            JournalStore(tmp_path),
            Lease("next-owner", time() + 10),
            JOB,
            "run",
        )
        start = asyncio.Event()
        resume = asyncio.Event()

        async def act(job, action, **facts):
            if action == "record_execution" and facts["owner"] == "owner":
                start.set()
                await resume.wait()
            return await real_act(job, action, **facts)

        async def spawn(_settings, _store, journal, _fixture):
            spawned.append(journal["executionRef"])
            raise RuntimeError("Injected after the winning reservation")

        f.act = act
        monkeypatch.setattr("stateaction_controller.local_controller.spawn", spawn)
        stale = asyncio.create_task(own.execute(f.catalog.copy()))
        try:
            async with asyncio.timeout(2):
                await start.wait()
                winner = await successor.execute(f.catalog.copy())
                assert winner["reason"] == "spawn_outcome_uncertain"
                persisted = f.store.read_local(JOB, None)
                assert persisted["phase"] == "spawning"
                resume.set()
                loser = await stale
                assert loser["reason"] in (
                    "no_token_or_deadline",
                    "spawn_already_reserved",
                )
                assert f.store.read_local(JOB, None) == persisted
        finally:
            stale.cancel()

    asyncio.run(run())
    assert spawned == ["local-synthetic"]
    assert not any(act == "record_execution_evidence" for act, _ in f.actions)


def test_real_worker_is_adopted_while_still_live_without_a_second_spawn(
    tmp_path, monkeypatch
):
    from stateaction_controller import local_controller
    from stateaction_controller.local_process import spawn

    f = Fixture(tmp_path)

    async def forbidden(*_args):
        pytest.fail("Recovery attempted a second spawn")

    async def run():
        initial = f.record("spawning")
        f.store.write_local(initial)
        assert f.store.reserve_spawn(JOB, None)
        child, identity = await spawn(f.settings, f.store, initial, fixture=True)
        original_inspect = local_controller.inspect
        observed = asyncio.Event()

        async def inspect(*args):
            seen = await original_inspect(*args)
            if seen == "alive":
                observed.set()
            return seen

        f.store.write_local(dict(initial, phase="running", **identity))
        f.catalog.update(state="running", executionRef=initial["executionRef"])
        f.controller.store = JournalStore(tmp_path)
        monkeypatch.setattr(local_controller, "spawn", forbidden)
        monkeypatch.setattr(local_controller, "inspect", inspect)
        try:
            async with asyncio.timeout(5):
                task = asyncio.create_task(f.controller.execute(f.catalog))
                await observed.wait()
                assert not task.done() and f.actions == []
                child.stdin.close()
                result = await task
            assert result["executionRef"] == initial["executionRef"]
            assert result["evidence"] == "recorded"
            assert [action for action, _ in f.actions] == ["record_execution_evidence"]
            assert f.store.read_local(JOB, None)["pid"] == child.pid
        finally:
            child.stdin.close()
            if child.returncode is None:
                child.kill()
                await asyncio.to_thread(child.wait, 5)

    asyncio.run(run())


def test_adopted_stage_uses_last_matching_receipt_despite_mixed_log(tmp_path):
    import json

    from stateaction_controller.modal_controller import ModalStage
    from test_recipe import FIXTURES

    f = Fixture(tmp_path)
    f.controller.settings = replace(f.settings, pipeline="hand_pose_cpu_v1")
    receipt_file = FIXTURES / "jobs.stage-receipt.v1.json"
    receipt = json.loads(receipt_file.read_bytes())["cases"][0]["input"]["document"]
    receipt["jobId"] = JOB
    stage = ModalStage("segment", receipt["module"], 30, lambda _: None)
    record = f.record(
        "exited",
        stage="segment",
        pid=123,
        pgid=123,
        sid=123,
        startTicks="123",
        pidNamespace="pid:[456]",
        threadedPipeline=True,
        exit={"code": None, "signal": "not_observed"},
    )
    f.store.write_local(record)
    earlier = dict(receipt, status="failed", errorCode="old_failure")
    log = (
        f"noise\n{json.dumps(earlier)}\n{json.dumps(receipt)}\nsa_metrics no-receipt\n"
    )
    f.store._write(JOB, "segment", "child.log", log.encode())

    result = asyncio.run(f.controller.execute(f.catalog, stage))
    assert result["evidence"] == "recorded"
    assert result["receipt"] == receipt
    assert result["exit"]["signal"] == "not_observed"


def test_dead_session_leader_with_live_orphan_never_proves_exit_or_signals(
    tmp_path, monkeypatch
):
    import ctypes
    import os
    import select
    import signal
    import subprocess
    import sys

    from stateaction_controller.local_process import read_stat

    f = Fixture(tmp_path)
    libc = ctypes.CDLL(None, use_errno=True)
    previous = ctypes.c_int()
    assert libc.prctl(37, ctypes.byref(previous), 0, 0, 0) == 0
    assert libc.prctl(36, 1, 0, 0, 0) == 0
    orphan = None
    try:
        source = """
import os, signal
pid = os.fork()
if pid == 0:
    signal.pause()
else:
    print(pid, flush=True)
    input()
"""
        with subprocess.Popen(
            [sys.executable, "-c", source],
            start_new_session=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        ) as leader:
            os_fd = leader.stdout.fileno()
            assert select.select([os_fd], [], [], 5)[0]
            orphan = int(leader.stdout.readline())
            identity = read_stat(leader.pid)
            assert identity and identity.group == identity.session == leader.pid
            leader.stdin.write(b"\n")
            leader.stdin.close()
            assert leader.wait(timeout=5) == 0
            orphan_state = read_stat(orphan)
            assert orphan_state.alive and orphan_state.session == leader.pid
            f.store.write_local(
                f.record(
                    "running",
                    pid=leader.pid,
                    pgid=leader.pid,
                    sid=leader.pid,
                    startTicks=identity.ticks,
                )
            )
            f.catalog.update(state="cancel_requested", executionRef="local-synthetic")

            async def forbidden(*_args, **_options):
                pytest.fail("Ambiguous group cannot be signalled")

            monkeypatch.setattr(
                "stateaction_controller.local_controller.helper", forbidden
            )
            result = f.run()
            assert result["outcome"] == "needs_operator"
            assert [action for action, _ in f.actions] == ["mark_submit_unknown"]
            assert read_stat(orphan).alive
    finally:
        if orphan is not None:
            fd = os.pidfd_open(orphan)
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                os.waitpid(orphan, 0)
            finally:
                os.close(fd)
        assert libc.prctl(36, previous.value, 0, 0, 0) == 0


@pytest.mark.parametrize("cancel_at", ["reentry", "record_execution"])
def test_cancelled_local_intent_dispatches_once_and_proves_exact_child_exit(
    tmp_path, monkeypatch, cancel_at
):
    f = Fixture(tmp_path)
    intent = f.record("intent")
    f.store.write_local(intent)
    f.store.save_token(JOB, None, "synthetic")
    original_act = f.act
    spawned = []
    signalled = []

    async def act(job_id, action, **facts):
        reply = await original_act(job_id, action, **facts)
        if cancel_at == "record_execution" and action == "record_execution":
            f.catalog["state"] = "cancel_requested"
        return reply

    async def spawn(settings, store, journal, fixture):
        assert fixture and journal["phase"] == "spawning"
        spawned.append(journal["executionRef"])
        child = SimpleNamespace(
            stdin=SimpleNamespace(close=lambda: None), poll=lambda: -9
        )
        return child, dict(
            pid=123, pgid=123, sid=123, startTicks="123", singleProcess=True
        )

    async def send_bootstrap(child, payload):
        assert not signalled

    async def inspect(journal, _python):
        assert journal["executionRef"] == intent["executionRef"]
        return "gone" if signalled else "alive"

    async def helper(_python, journal, *, deadline):
        assert deadline > time() and journal["pid"] == 123
        assert journal["startTicks"] == "123"
        signalled.append(journal["executionRef"])
        return 0

    f.act = act
    monkeypatch.setattr("stateaction_controller.local_controller.spawn", spawn)
    monkeypatch.setattr(
        "stateaction_controller.local_controller.send_bootstrap", send_bootstrap
    )
    monkeypatch.setattr("stateaction_controller.local_controller.inspect", inspect)
    monkeypatch.setattr("stateaction_controller.local_controller.helper", helper)
    if cancel_at == "reentry":
        f.catalog["state"] = "cancel_requested"

    result = f.run()
    assert result["outcome"] == "child_exited" and result["evidence"] == "recorded"
    assert result["termination"] == "cancel_requested"
    assert spawned == signalled == [intent["executionRef"]]
    assert f.store.load_token(JOB, None) is None
    assert not f.store.reserve_spawn(JOB, None)
    assert [action for action, _ in f.actions] == [
        "record_execution",
        "record_execution_evidence",
    ]
    evidence = f.actions[-1][1]["evidence"]
    assert evidence["executionRef"] == intent["executionRef"]
    assert evidence["kind"] == "local_child_reaped"
    assert evidence["detail"]["termination"] == "cancel_requested"
