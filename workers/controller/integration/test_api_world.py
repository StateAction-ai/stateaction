"""Exercise the real Next routes, fixture worker and Postgres admission state."""

import asyncio
import json
import os
import select
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from time import monotonic, sleep, time

import pytest
from historical_controller import run_controller
from stateaction_controller.api import JobsApi
from stateaction_controller.config import load_settings, secret

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


@pytest.fixture
def world(request):
    with subprocess.Popen(
        ["node", str(HERE / "api-world.mjs"), getattr(request, "param", "job")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        cwd=ROOT,
        env={**os.environ, "SA153_PYTHON": sys.executable},
    ) as child:

        def message():
            assert select.select([child.stdout], [], [], 60)[0], "world did not respond"
            return json.loads(child.stdout.readline())

        def call(command):
            print(command, file=child.stdin, flush=True)
            return message()

        try:
            yield message(), call
        finally:
            try:
                print("stop", file=child.stdin, flush=True)
                assert child.wait(timeout=45) == 0
                assert message() == {"stopped": True}
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
                raise
            finally:
                child.stdin.close()


def fixture_env(fixture):
    return {
        "PATH": os.environ.get("PATH", ""),
        "APP_ENV": "local",
        "EXECUTION_BACKEND": "local",
        "STATEACTION_API_URL": fixture["origin"],
        "JOBS_STATE_DIR": fixture["stateDir"],
        "CONTROLLER_CAPABILITY_FILE": fixture["tokenFile"],
        "PYTHON_EXECUTABLE": os.environ.get(
            "PYTHON_EXECUTABLE", str(ROOT / "workers/processing/.venv/bin/python")
        ),
        "WORKER_PIPELINE": "local_fixture_noop",
        "CONTROLLER_RENEW_MS": "1000",
        "CONTROLLER_POLL_MS": "50",
    }


def test_python_controller_claims_and_reaps_against_the_existing_api(world):
    fixture, call = world
    env = fixture_env(fixture)
    settings = load_settings(env)
    run_ref = "python-loopback-run"

    async def run():
        api = JobsApi(
            settings.api_url, secret("CONTROLLER_CAPABILITY", env), loopback=True
        )
        try:
            return await run_controller(settings, api, fixture["jobId"], run_ref)
        finally:
            await api.close()

    result = asyncio.run(run())
    assert result["outcome"] == "child_exited", result
    assert result["evidence"] == "recorded"
    assert result["exit"]["code"] == 0
    row = call("row")
    assert row["workflow_run_ref"] == run_ref
    assert row["execution_call_id"] == result["executionRef"]
    assert row["claimed_at"] is not None
    assert row["evidence"] == f"local_child_reaped:{result['executionRef']}"
    assert row["state"] == "running"
    assert row["slot_holder"] == fixture["jobId"]
    assert not list(Path(fixture["stateDir"]).rglob("bootstrap.token"))


def test_cancel_after_intent_dispatches_once_then_releases_with_exact_evidence(world):
    fixture, call = world
    env = fixture_env(fixture)
    settings = load_settings(env)
    job_id = fixture["jobId"]
    run_ref = "python-cancel-after-intent"
    submissions = []

    class CancelAfterIntent(JobsApi):
        async def act(self, target, action, **facts):
            response = await super().act(target, action, **facts)
            if action == "record_worker_submission":
                assert response["state"] == "recorded"
                submissions.append(target)
                assert call("cancel-after-intent") == {"cancelled": True}
                cancelled = call("row")
                assert cancelled["state"] == "cancel_requested"
                assert cancelled["evidence"] is None
                assert cancelled["slot_holder"] == job_id
            return response

    async def run():
        api = CancelAfterIntent(
            settings.api_url, secret("CONTROLLER_CAPABILITY", env), loopback=True
        )
        try:
            return await run_controller(settings, api, job_id, run_ref)
        finally:
            await api.close()

    result = asyncio.run(run())
    assert result["outcome"] == "child_exited" and result["evidence"] == "recorded"
    ref = result["executionRef"]
    journal = Path(fixture["stateDir"]) / job_id / "journal.json"
    saved = json.loads(journal.read_bytes())
    assert saved["phase"] == "exited" and saved["executionRef"] == ref
    assert saved["pid"] > 0 and (journal.parent / "spawn.reserved").exists()
    assert not (journal.parent / "bootstrap.token").exists()
    call("repair")
    row = call("row")
    assert row["state"] == "cancelled" and row["slot_holder"] is None
    assert row["execution_call_id"] == ref
    assert row["evidence"] == f"local_child_reaped:{ref}"
    asyncio.run(run())
    assert submissions == [job_id]
    assert json.loads(journal.read_bytes()) == saved


@pytest.mark.parametrize("world", ["job", "late", "ended"], indirect=True)
def test_same_run_adopts_exact_child_after_controller_process_dies(world, request):
    fixture, call = world
    mode = request.node.callspec.params["world"]
    late = mode == "late"
    ended = mode == "ended"
    env = {
        **fixture_env(fixture),
        "TEST_JOB_ID": fixture["jobId"],
        "TEST_RUN_REF": "python-restart-run",
        "WORKER_FIXTURE_HOLD_SECONDS": "60",
        "CONTROLLER_LEASE_WAIT_MS": "0",
    }
    command = [sys.executable, str(HERE / "run-controller.py")]
    journal_path = Path(fixture["stateDir"]) / fixture["jobId"] / "journal.json"
    worker_pid = None
    worker_ref = None
    try:
        with subprocess.Popen(
            command, env=env, cwd=ROOT, stdout=subprocess.PIPE
        ) as first:
            try:
                deadline = monotonic() + 30
                while True:
                    row = call("row")
                    if row["claimed_at"]:
                        running = json.loads(journal_path.read_bytes())
                        worker_pid = running["pid"]
                        worker_ref = running["executionRef"]
                        assert row["execution_call_id"] == worker_ref
                        assert worker_ref.encode() in Path(
                            f"/proc/{worker_pid}/cmdline"
                        ).read_bytes().split(b"\0")
                        break
                    assert first.poll() is None, (
                        "controller ended before the worker claimed"
                    )
                    assert monotonic() < deadline, "worker never claimed"
                    sleep(0.05)
            finally:
                first.kill()
                first.wait(timeout=5)
        assert call("expire")["expired"]
        foreign = subprocess.run(
            command,
            env={**env, "TEST_RUN_REF": "other-run"},
            cwd=ROOT,
            stdout=subprocess.PIPE,
            check=True,
            timeout=30,
        )
        assert json.loads(foreign.stdout)["outcome"] == "no_effect"
        assert json.loads(journal_path.read_bytes())["pid"] == worker_pid
        if late:
            deadline = datetime.fromisoformat(row["execution_deadline"]).timestamp()
            sleep(max(0, deadline - time()) + 0.1)
            call("lapse")
            interim = call("row")
            assert interim["state"] == "needs_attention"
            assert (
                interim["slot_holder"] == fixture["jobId"]
                and interim["evidence"] is None
            )
        else:
            # Exercise recovery when the child exited while no controller was alive.
            descriptor = os.pidfd_open(worker_pid)
            try:
                assert worker_ref.encode() in Path(
                    f"/proc/{worker_pid}/cmdline"
                ).read_bytes().split(b"\0")
                signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                if ended:
                    assert select.select([descriptor], [], [], 5)[0], (
                        "worker did not exit"
                    )
            finally:
                os.close(descriptor)
        if ended:
            assert call("fail-before-evidence")["failed"]
            before = call("row")
            assert before["state"] == "failed" and before["evidence"] is None
            assert before["slot_holder"] == fixture["jobId"]
        second = subprocess.run(
            command,
            env=env,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            check=True,
            timeout=30,
        )
        result = json.loads(second.stdout)
        if ended:
            assert result == {
                "outcome": "ended_evidence",
                "state": "failed",
                "recordedRefs": [worker_ref],
            }
            assert call("row")["slot_holder"] is None
        else:
            assert result["outcome"] == "child_exited", result
            assert result["evidence"] == "recorded"
            assert result["executionRef"] == worker_ref
            assert result["exit"] == {"code": None, "signal": "not_observed"}
        assert call("row")["evidence"] == f"local_child_reaped:{worker_ref}"
        assert json.loads(journal_path.read_bytes())["pid"] == worker_pid
        if late:
            call("repair")
            after = call("row")
            assert after["state"] == "failed" and after["slot_holder"] is None
            assert call("failure") == {
                "error_code": "worker_exited_without_result",
                "clips": 0,
            }
    finally:
        if worker_pid and worker_ref:
            try:
                descriptor = os.pidfd_open(worker_pid)
            except ProcessLookupError:
                pass
            else:
                try:
                    if worker_ref.encode() in Path(
                        f"/proc/{worker_pid}/cmdline"
                    ).read_bytes().split(b"\0"):
                        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except (ProcessLookupError, FileNotFoundError):
                    pass
                finally:
                    os.close(descriptor)


@pytest.mark.parametrize("world", ["recipe", "disabled-caption"], indirect=True)
def test_recipe_fails_truthfully_and_does_not_respawn(world, request):
    fixture, call = world
    env = {
        **fixture_env(fixture),
        "TEST_JOB_ID": fixture["jobId"],
        "TEST_RUN_REF": "python-recipe-run",
    }
    command = [sys.executable, str(HERE / "run-controller.py")]

    def run():
        process = subprocess.run(
            command, env=env, cwd=ROOT, stdout=subprocess.PIPE, check=True, timeout=60
        )
        return json.loads(process.stdout)

    result = run()
    assert result["outcome"] == "recipe_run", result
    assert "stopped" not in result
    rows = call("stages")
    by_stage = {row["stage"]: row for row in rows}
    assert list(by_stage) == ["segment", "caption", "hand_pose"]
    for stage in ("segment", "hand_pose"):
        row = by_stage[stage]
        assert row["state"] == "failed"
        assert row["error_code"] and row["error_code"] != "receipt_missing"
        assert row["call_id"].startswith("local-")
        assert row["call_id"] == row["claimed_call"] == row["proof"]
    assert by_stage["caption"]["state"] == "not_run"
    mode = request.node.callspec.params["world"]
    assert by_stage["caption"]["error_code"] == (
        "stage_disabled" if mode == "disabled-caption" else "upstream_failed"
    )
    assert by_stage["caption"]["call_id"] is None
    assert by_stage["caption"]["claimed_at"] is None
    row = call("row")
    assert row["state"] == "failed"
    assert row["evidence"] == f"local_child_reaped:{by_stage['hand_pose']['call_id']}"
    assert row["slot_holder"] is None
    assert run() == {"outcome": "not_admitted", "state": "failed"}
    assert call("stages") == rows
    assert not list(Path(fixture["stateDir"]).rglob("bootstrap.token"))
    if mode == "disabled-caption":
        policy = call("read-policy")
        assert set(policy) == {"recipe", "dag-run", "prior-stages"}
        for allowed, *denied in policy.values():
            assert allowed == 200
            assert len(denied) == 3 and set(denied) <= {401, 403}


@pytest.mark.parametrize("world", ["runner"], indirect=True)
def test_api_repair_dispatches_official_python_task_once(world):
    fixture, call = world
    task = call("runner")
    result = task["outcome"]
    assert task["stateMode"] == 0o700
    assert result["outcome"] == "child_exited", result
    assert result["evidence"] == "recorded" and result["exit"]["code"] == 0
    assert task["pending"] == 0
    row = call("row")
    assert row["workflow_run_ref"] == task["taskRunId"]
    assert row["execution_call_id"] == result["executionRef"]
    assert row["claimed_at"] is not None
    assert row["evidence"] == f"local_child_reaped:{result['executionRef']}"
    assert row["slot_holder"] == fixture["jobId"]
    assert call("terminal")["slot_holder"] is None


@pytest.mark.parametrize("uncertain", [False, True])
def test_lost_real_submission_ack_never_claims_or_releases_slot(world, uncertain):
    from stateaction_controller.journal import JournalStore
    from stateaction_controller.local_process import boot_id

    fixture, call = world
    run_ref = "python-lost-ack"
    job_id = fixture["jobId"]
    seeded = call("unknown-child" if uncertain else "forget-ack")
    assert seeded["fenced"]
    store = JournalStore(Path(fixture["stateDir"]))
    if uncertain:
        store.write_local(
            {
                "version": 1,
                "jobId": job_id,
                "runRef": run_ref,
                "executionRef": "local-uncertain",
                "bootId": boot_id(),
                "phase": "spawning",
                "startDeadline": seeded["startDeadline"],
                "executionDeadline": seeded["executionDeadline"],
            }
        )
    env = {**fixture_env(fixture), "TEST_JOB_ID": job_id, "TEST_RUN_REF": run_ref}
    command = [sys.executable, str(HERE / "run-controller.py")]
    for _ in range(2):
        process = subprocess.run(
            command, env=env, cwd=ROOT, stdout=subprocess.PIPE, check=True, timeout=30
        )
        decision = json.loads(process.stdout)
        if uncertain:
            assert decision["reason"] == "spawn_outcome_uncertain"
            assert store.read_local(job_id, None)["phase"] == "spawning"
        else:
            assert decision["outcome"] in ("submit_unknown", "needs_operator")
            assert store.read_local(job_id, None) is None
        assert not list(Path(fixture["stateDir"]).rglob("spawn.reserved"))
        assert call("expire")["expired"]
    row = call("row")
    assert row["state"] == "submit_unknown"
    assert row["claimed_at"] is None
    assert row["execution_call_id"] == ("local-uncertain" if uncertain else None)
    assert row["evidence"] is None and row["slot_holder"] == job_id
    if not uncertain:
        forged = {
            "schemaVersion": 1,
            "apiUrl": fixture["origin"],
            "jobId": job_id,
            "bootstrapToken": "sa_svc_" + "A" * 43,
            "pipeline": "local_fixture_noop",
            "executionRef": "local-forged",
        }
        attempt = subprocess.run(
            [
                env["PYTHON_EXECUTABLE"],
                "-m",
                "stateaction_processing",
                "run-job",
                "--execution-ref",
                "local-forged",
            ],
            input=json.dumps(forged).encode(),
            capture_output=True,
            env={"APP_ENV": "local", "PATH": env["PATH"]},
            timeout=15,
        )
        assert attempt.returncode == 75
        assert call("row")["claimed_at"] is None


@pytest.mark.parametrize("world", ["recipe"], indirect=True)
@pytest.mark.parametrize("where", ["before", "after"])
def test_recipe_restart_distinguishes_logged_receipt_from_missing_bootstrap(
    world, where
):
    fixture, call = world
    state = Path(fixture["stateDir"])
    env = {
        **fixture_env(fixture),
        "TEST_JOB_ID": fixture["jobId"],
        "TEST_RUN_REF": "python-recipe-recovery",
        "CONTROLLER_LEASE_WAIT_MS": "0",
    }
    command = [sys.executable, str(HERE / "run-controller.py")]
    journal = state / fixture["jobId"] / "hand_pose" / "journal.json"
    worker = None
    try:
        with subprocess.Popen(
            command,
            env={**env, "SA153_STALL_HAND": where},
            cwd=ROOT,
            stdout=subprocess.PIPE,
        ) as first:
            try:
                deadline = monotonic() + 30
                while not (state / "test-stalled").exists():
                    assert first.poll() is None, (
                        "controller exited before the interleaving"
                    )
                    assert monotonic() < deadline, (
                        "controller did not reach the interleaving"
                    )
                    sleep(0.02)
                worker = json.loads(journal.read_bytes())
                assert worker["phase"] == "running"
                stages = {row["stage"]: row["state"] for row in call("stages")}
                assert stages["segment"] == "failed"
                assert stages["caption"] == "not_run"
            finally:
                first.kill()
                first.wait(timeout=5)
        assert call("expire")["expired"]
        resumed = subprocess.run(
            command, env=env, cwd=ROOT, stdout=subprocess.PIPE, check=True, timeout=45
        )
        result = json.loads(resumed.stdout)
        assert result["outcome"] == "recipe_run", result
        if where == "before":
            assert result["stopped"] == {
                "outcome": "needs_operator",
                "reason": "recipe_seal_refused",
            }
        else:
            assert "stopped" not in result
        hand = next(row for row in call("stages") if row["stage"] == "hand_pose")
        assert hand["state"] == "failed"
        assert hand["call_id"] == hand["proof"] == worker["executionRef"]
        assert json.loads(journal.read_bytes())["pid"] == worker["pid"]
        assert not (journal.parent / "bootstrap.token").exists()
        assert call("hand-claims") == {"issued": 1, "claimed": int(where == "after")}
        if where == "before":
            assert hand["claimed_at"] is None
            assert hand["error_code"] == "receipt_missing"
        else:
            assert hand["claimed_at"] is not None
            assert hand["claimed_call"] == hand["call_id"]
            assert hand["error_code"] != "receipt_missing"
    finally:
        if worker:
            pid, ref = worker["pid"], worker["executionRef"]
            try:
                descriptor = os.pidfd_open(pid)
            except ProcessLookupError:
                pass
            else:
                try:
                    if ref.encode() in Path(f"/proc/{pid}/cmdline").read_bytes().split(
                        b"\0"
                    ):
                        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except (ProcessLookupError, FileNotFoundError):
                    pass
                finally:
                    os.close(descriptor)


@pytest.mark.parametrize("world", ["runner-loss"], indirect=True)
def test_official_runner_loss_keeps_worker_and_fences_replacement_run(world):
    from stateaction_controller.local_process import read_stat

    fixture, call = world
    path = Path(fixture["stateDir"]) / fixture["jobId"] / "journal.json"
    worker_fd = None
    controller_fd = None
    try:
        deadline = monotonic() + 30
        while True:
            row = call("row")
            if row["claimed_at"]:
                break
            assert monotonic() < deadline, "official runner worker did not claim"
            sleep(0.05)
        journal = json.loads(path.read_bytes())
        pid, ref = journal["pid"], journal["executionRef"]
        worker_fd = os.pidfd_open(pid)
        view = read_stat(pid)
        assert view.alive and view.ticks == journal["startTicks"]
        parent = view.parent
        controller_fd = os.pidfd_open(parent)
        workflow_path = (HERE / "historical-workflow.py").relative_to(ROOT)
        assert os.fsencode(workflow_path) in Path(
            f"/proc/{parent}/cmdline"
        ).read_bytes().split(b"\0")
        assert call("kill-runner")["stopped"]
        try:
            signal.pidfd_send_signal(controller_fd, signal.SIGKILL)
        except ProcessLookupError:
            pass
        assert read_stat(pid).alive
        assert call("expire")["expired"]
        rejected = call("new-runner")
        assert rejected["taskRunId"] != row["workflow_run_ref"]
        assert rejected["outcome"] == {"outcome": "no_effect", "reason": "run_rejected"}
        assert call("row")["evidence"] is None
        assert json.loads(path.read_bytes())["pid"] == pid
        assert read_stat(pid).alive
        signal.pidfd_send_signal(worker_fd, signal.SIGKILL)
        recovered = subprocess.run(
            [sys.executable, str(HERE / "run-controller.py")],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            env={
                **fixture_env(fixture),
                "TEST_JOB_ID": fixture["jobId"],
                "TEST_RUN_REF": row["workflow_run_ref"],
            },
            check=True,
            timeout=30,
        )
        result = json.loads(recovered.stdout)
        assert result["outcome"] == "child_exited"
        assert result["executionRef"] == ref and result["evidence"] == "recorded"
        assert call("row")["evidence"] == f"local_child_reaped:{ref}"
    finally:
        for descriptor in (controller_fd, worker_fd):
            if descriptor is not None:
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                finally:
                    os.close(descriptor)


def test_normal_controller_exit_after_lease_loss_leaves_verified_worker_alive(world):
    from stateaction_controller.local_process import read_stat

    fixture, call = world
    job_id = fixture["jobId"]
    env = {
        **fixture_env(fixture),
        "TEST_JOB_ID": job_id,
        "TEST_RUN_REF": "normal-lease-loss",
        "WORKER_FIXTURE_HOLD_SECONDS": "60",
        "CONTROLLER_RENEW_MS": "200",
    }
    command = [sys.executable, "-X", "dev", str(HERE / "run-controller.py")]
    descriptor = None
    with subprocess.Popen(command, env=env, cwd=ROOT, stdout=subprocess.PIPE) as first:
        try:
            deadline = monotonic() + 30
            while True:
                row = call("row")
                if row["claimed_at"]:
                    break
                assert first.poll() is None and monotonic() < deadline
                sleep(0.05)
            path = Path(fixture["stateDir"]) / job_id / "journal.json"
            record = json.loads(path.read_bytes())
            pid, ref = record["pid"], record["executionRef"]
            descriptor = os.pidfd_open(pid)
            assert read_stat(pid).ticks == record["startTicks"]
            assert ref.encode() in Path(f"/proc/{pid}/cmdline").read_bytes().split(
                b"\0"
            )
            assert call("expire")["expired"]
            out, _ = first.communicate(timeout=15)
            result = json.loads(out)
            assert first.returncode == 0 and result["outcome"] == "lease_lost"
            assert result["executionRef"] == ref
            assert read_stat(pid).alive
            assert read_stat(pid).ticks == record["startTicks"]
            assert call("row")["evidence"] is None
            assert json.loads(path.read_bytes()) == record
        finally:
            if first.poll() is None:
                first.kill()
                first.wait(timeout=5)
            if descriptor is not None:
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                finally:
                    os.close(descriptor)
