import asyncio

import pytest
from stateaction_controller.recovery import recover_modal, recovery_binding
from test_modal_controller import CALL, JOB

URL = "https://example.test"
RUN = "original-workflow-run"
HASH = "b" * 64
MODULE = "flora_tempseg_vllm_fp8@1"


class Recovery:
    def __init__(self, *, stage=None):
        self.stage = stage
        self.known = None if stage else CALL
        self.proof = {
            "schemaVersion": 2 if stage else 1,
            "functionCallId": CALL,
            "exitCode": 1,
            "callBinding": recovery_binding(
                JOB, URL, HASH, (JOB, stage, MODULE) if stage else None
            ),
            **({"receipt": None} if stage else {}),
        }
        self.polls = []
        self.actions = []
        self.granted = True

    async def status(self, job_id):
        assert job_id == JOB
        return {
            "jobId": JOB,
            "state": "cancel_requested",
            "executionBackend": "modal",
            "startDeadline": "2026-11-26T00:01:00Z",
            "executionRef": self.known,
        }

    async def recipe(self, _):
        return (
            {"stages": [{"stage": self.stage, "module": MODULE, "enabled": True}]}
            if self.stage
            else None
        )

    async def dag(self, _):
        return {
            "stages": [
                {
                    "stage": self.stage,
                    "module": MODULE,
                    "state": "submit_unknown",
                    "callId": self.known,
                }
            ]
        }

    async def poll(self, call_id):
        self.polls.append(call_id)
        return (
            {"kind": "returned", "value": self.proof}
            if self.proof
            else {"kind": "pending"}
        )

    async def act(self, job_id, action, **facts):
        assert job_id == JOB
        self.actions.append((action, facts))
        return {"granted": self.granted}

    async def hash(self):
        return HASH

    def run(self):
        return asyncio.run(
            recover_modal(
                self,
                self,
                self.hash,
                job_id=JOB,
                call_id=CALL,
                run_ref=RUN,
                api_url=URL,
                stage=self.stage,
            )
        )


def test_recovers_only_the_bound_terminal_call_under_original_workflow_run():
    recovery = Recovery()
    recovery.run()
    assert recovery.polls == [CALL]
    assert [action for action, _ in recovery.actions] == [
        "claim_lease",
        "record_execution",
        "record_execution_evidence",
    ]
    assert recovery.actions[0][1]["runRef"] == RUN
    assert recovery.actions[1][1]["executor"] == {
        "kind": "modal",
        "functionCallId": CALL,
    }
    assert recovery.actions[2][1]["evidence"]["executionRef"] == CALL


def test_lost_stage_call_is_bound_then_settled_cancelled():
    recovery = Recovery(stage="segment")
    recovery.run()
    assert [action for action, _ in recovery.actions] == [
        "claim_lease",
        "record_stage_run",
        "record_execution_evidence",
        "record_stage_run",
    ]
    assert recovery.actions[1][1]["callId"] == CALL
    assert recovery.actions[-1][1]["state"] == "cancelled"
    assert recovery.actions[-1][1]["callId"] == CALL


@pytest.mark.parametrize(
    "problem", ["call_alone", "conflict", "wrong_binding", "pending"]
)
def test_ambiguous_or_conflicting_operator_observation_never_mutates(problem):
    recovery = Recovery(stage="segment")
    if problem == "call_alone":
        del recovery.proof["callBinding"]
    elif problem == "conflict":
        recovery.known = "fc-Foreign"
    elif problem == "wrong_binding":
        recovery.proof["callBinding"] = "0" * 64
    else:
        recovery.proof = None
    with pytest.raises(ValueError):
        recovery.run()
    assert recovery.actions == []


def test_occupied_lease_stops_operator_before_any_writes():
    recovery = Recovery()
    recovery.granted = False
    with pytest.raises(ValueError, match="lease"):
        recovery.run()
    assert [action for action, _ in recovery.actions] == ["claim_lease"]
