import asyncio
from time import time

import pytest
from historical_controller import run_controller
from stateaction_controller.config import Settings
from stateaction_controller.journal import JournalStore, iso
from test_modal_controller import CALL, JOB, Modal


class Api:
    def __init__(self, *, clip_plan=False):
        self.current = {
            "kind": "clip_plan" if clip_plan else "process_recording",
            "state": "submitting",
            "executionBackend": "modal",
            "executionRef": None,
            "startDeadline": iso(time() + 20),
            "executionDeadline": iso(time() + 60),
            "codeRevision": "a" * 40,
        }
        self.actions = []
        self.submitted = False
        self.renewal = asyncio.Event()

    async def status(self, job):
        assert job == JOB
        return self.current.copy()

    async def recipe(self, job):
        assert job == JOB

    async def act(self, job, action, **facts):
        assert job == JOB
        self.actions.append((action, facts))
        if action == "claim_lease":
            return {"granted": True, "expiresAt": iso(time() + 20)}
        if action == "renew_lease":
            self.renewal.set()
            return {"renewed": False}
        if action == "record_worker_submission":
            assert not self.submitted
            self.submitted = True
            return {**self.current, "state": "recorded", "bootstrapToken": "local-test"}
        return {"recorded": True}


def config(tmp_path, **fields):
    return Settings("modal", "https://example.test", tmp_path, poll=0.01, **fields)


@pytest.mark.parametrize(
    "binding_state", ["verified", "definition_drift", "stale_revision"]
)
def test_clip_plan_only_uses_verified_cpu_binding_for_admitted_revision(
    tmp_path, binding_state
):
    api = Api(clip_plan=True)
    binding = {
        "functionId": "fu-CPU",
        "codeRevision": "a" * 40 if binding_state != "stale_revision" else "b" * 40,
        "gpu": "none",
    }
    settings = config(tmp_path, bindings={"hand_pose_cpu_v1@1": binding})
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    check = []

    async def verify(candidate):
        check.append(candidate)
        return binding_state == "verified"

    real_spawn = modal.spawn

    async def spawn(value, authorized, candidate):
        assert candidate == binding
        assert value["pipeline"] == "clip_plan_cpu_v1"
        return await real_spawn(value, authorized, candidate)

    modal.check_function = verify
    modal.spawn = spawn
    result = asyncio.run(run_controller(settings, api, JOB, "test-run", modal))
    if binding_state == "verified":
        assert result["evidence"] == "recorded"
        assert modal.spawns == 1
    else:
        assert result["reason"] == "clip_plan_binding_unavailable"
        assert modal.spawns == 0
        assert not api.submitted
    assert len(check) == (0 if binding_state == "stale_revision" else 1)


def test_without_modal_client_nothing_submits(tmp_path):
    api = Api()
    result = asyncio.run(run_controller(config(tmp_path), api, JOB, "test-run"))
    assert result == {"outcome": "no_effect", "reason": "modal_client_missing"}
    assert [action for action, _ in api.actions] == [
        "record_workflow_run",
        "claim_lease",
    ]


def test_job_without_recipe_uses_v1_only(tmp_path):
    api = Api()
    modal = Modal(api, JournalStore(tmp_path))
    original = modal.spawn

    async def spawn(value, authorized, binding):
        assert value["schemaVersion"] == 1
        assert "stage" not in value and "recipeSha256" not in value
        return await original(value, authorized, binding)

    modal.spawn = spawn
    result = asyncio.run(run_controller(config(tmp_path), api, JOB, "test-run", modal))
    assert result["evidence"] == "recorded"
    assert [action for action, _ in api.actions] == [
        "record_workflow_run",
        "claim_lease",
        "record_worker_submission",
        "record_execution",
        "record_execution_evidence",
    ]


@pytest.mark.parametrize("terminal", [False, True])
def test_refused_renewal_revokes_only_if_job_is_still_open(tmp_path, terminal):
    api = Api()
    api.current.update(state="running", executionRef=CALL)
    modal = Modal(api, JournalStore(tmp_path))
    original = modal.poll

    async def poll(ref):
        assert ref == CALL
        if terminal:
            api.current["state"] = "succeeded"
        async with asyncio.timeout(1):
            await api.renewal.wait()
        if terminal:
            return await original(ref)
        return {"kind": "pending"}

    modal.poll = poll
    result = asyncio.run(
        run_controller(config(tmp_path, renew=0.01), api, JOB, "test-run", modal)
    )
    assert modal.spawns == 0
    if terminal:
        assert result["evidence"] == "recorded"
        assert api.actions[-1][0] == "record_execution_evidence"
    else:
        assert result["outcome"] == "lease_lost"
        assert not any(
            action == "record_execution_evidence" for action, _ in api.actions
        )


def test_terminal_status_read_cannot_revive_expired_lease(tmp_path, monkeypatch):
    from stateaction_controller.controller import Lease, renew_lease

    now = 10
    monkeypatch.setattr("stateaction_controller.controller.time", lambda: now)
    lease = Lease("owner", 11)

    class LateStatus(Api):
        async def status(self, _):
            nonlocal now
            now = 12
            return {"state": "succeeded"}

    asyncio.run(renew_lease(config(tmp_path, renew=0), LateStatus(), JOB, lease))
    assert not lease.live()
    assert lease.expires == 11


@pytest.mark.parametrize(
    "mode", ["live", "exact", "wrong_call", "wrong_run", "ended_before_lease"]
)
def test_failed_job_retry_only_records_proof_for_exact_call_and_run(tmp_path, mode):
    from stateaction_controller.api import ApiRejection

    class EndedApi(Api):
        async def act(self, job, action, **facts):
            self.actions.append((action, facts))
            assert job == JOB
            if action == "record_workflow_run":
                if facts["runRef"] != "test-run":
                    raise ApiRejection(409, "different run")
                return {"recorded": False}
            if action == "claim_lease" and mode == "ended_before_lease":
                self.current["state"] = "failed"
                return {"granted": False, "reason": "not_active"}
            assert action == "record_execution_evidence"
            return {"recorded": True, "slotReleased": True}

    class Provider:
        def __init__(self):
            self.calls = []

        async def poll(self, call_id):
            self.calls.append(call_id)
            if mode == "live":
                return {"kind": "pending"}
            reported = "fc-Another" if mode == "wrong_call" else call_id
            return {
                "kind": "returned",
                "value": {
                    "schemaVersion": 1,
                    "functionCallId": reported,
                    "exitCode": 1,
                },
            }

    api, modal = EndedApi(), Provider()
    api.current.update(
        state="running" if mode == "ended_before_lease" else "failed", executionRef=CALL
    )
    run_ref = "another-run" if mode == "wrong_run" else "test-run"
    result = asyncio.run(run_controller(config(tmp_path), api, JOB, run_ref, modal))
    if mode in ("exact", "ended_before_lease"):
        assert result == {
            "outcome": "ended_evidence",
            "state": "failed",
            "recordedRefs": [CALL],
        }
        evidence = api.actions[-1][1]["evidence"]
        assert (
            evidence["executionRef"] == CALL and evidence["detail"]["runRef"] == run_ref
        )
    elif mode == "wrong_run":
        assert result == {"outcome": "no_effect", "reason": "run_rejected"}
        assert modal.calls == []
    else:
        assert result == {"outcome": "not_admitted", "state": "failed"}
    if mode == "ended_before_lease":
        assert [action for action, _ in api.actions] == [
            "record_workflow_run",
            "claim_lease",
            "record_workflow_run",
            "record_execution_evidence",
        ]
    elif mode != "exact":
        assert [action for action, _ in api.actions] == ["record_workflow_run"]
    assert modal.calls == ([] if mode == "wrong_run" else [CALL])


def test_ended_job_evidence_transport_failure_requests_same_run_retry(tmp_path):
    from stateaction_controller.api import AmbiguousApiError

    class EndedApi(Api):
        durable_proof = None
        lost = False

        async def act(self, job, action, **facts):
            assert job == JOB
            assert action in ("record_workflow_run", "record_execution_evidence")
            if action == "record_workflow_run":
                assert facts["runRef"] == "test-run"
                return {"recorded": False}
            if not self.lost:
                self.lost = True
                raise AmbiguousApiError()
            self.durable_proof = facts["evidence"]
            return {"recorded": True, "slotReleased": True}

    class Provider:
        async def poll(self, call_id):
            assert call_id == CALL
            return {
                "kind": "returned",
                "value": {"schemaVersion": 1, "functionCallId": call_id, "exitCode": 1},
            }

    api = EndedApi()
    api.current.update(state="failed", executionRef=CALL)

    def run():
        return asyncio.run(
            run_controller(config(tmp_path), api, JOB, "test-run", Provider())
        )

    with pytest.raises(AmbiguousApiError):
        run()
    assert api.durable_proof is None
    assert run() == {
        "outcome": "ended_evidence",
        "state": "failed",
        "recordedRefs": [CALL],
    }
    assert api.durable_proof["executionRef"] == CALL
    assert api.durable_proof["detail"]["runRef"] == "test-run"


def test_ended_job_replay_of_acknowledged_proof_is_not_new_recovery(tmp_path):
    api = Api()
    api.current.update(state="failed", executionRef=CALL)
    store = JournalStore(tmp_path)
    store.write_modal(
        {
            "version": 1,
            "executor": "modal",
            "phase": "terminal",
            "jobId": JOB,
            "runRef": "test-run",
            "startDeadline": api.current["startDeadline"],
            "executionDeadline": api.current["executionDeadline"],
            "callId": CALL,
            "exitCode": 0,
            "evidenceRecorded": True,
        },
        None,
    )
    assert asyncio.run(run_controller(config(tmp_path), api, JOB, "test-run")) == {
        "outcome": "not_admitted",
        "state": "failed",
    }
    assert [name for name, _ in api.actions] == [
        "record_workflow_run",
        "record_execution_evidence",
    ]
    assert api.actions[-1][1]["evidence"]["executionRef"] == CALL
