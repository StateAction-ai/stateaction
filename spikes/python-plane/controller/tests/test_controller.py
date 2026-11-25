"""Small ports of the existing TS failure cases, using the same controller entrypoint."""

import json
import multiprocessing
import os
import signal
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from api import AmbiguousApiError, JobsApi
from controller import MODULE, run_controller
from executor import StubExecutor
from stateaction_contracts import request_sha256

NOW = datetime(2026, 11, 25, tzinfo=UTC)


class FixtureApi(JobsApi):
    base = "http://127.0.0.1"

    def __init__(self, *, lost_ack=False):
        self.lost_ack = lost_ack
        self.actions = []
        self.document = {
            "stages": [
                {
                    "stage": "hand_pose",
                    "enabled": True,
                    "module": MODULE,
                    "resources": {
                        "gpu": "none",
                        "budgetSeconds": 60,
                        "maxContainers": 1,
                        "retries": 0,
                    },
                }
            ],
        }

    def status(self, _job_id):
        return {"state": "submitting", "executionBackend": "local"}

    def recipe(self, _job_id):
        return self.document

    def dag(self, _job_id):
        return {
            "recipeSha256": request_sha256(self.document),
            "stages": [{"stage": "hand_pose", "state": "pending"}],
        }

    def act(self, _job_id, action, **facts):
        self.actions.append((action, facts))
        if action == "claim_lease":
            return {
                "granted": True,
                "expiresAt": (NOW + timedelta(seconds=60)).isoformat(),
            }
        if action == "issue_stage_claim":
            if self.lost_ack:
                raise AmbiguousApiError
            return {
                "state": "recorded",
                "bootstrapToken": "test-credential",
                "executionBackend": "local",
                "startDeadline": (NOW + timedelta(seconds=45)).isoformat(),
                "executionDeadline": (NOW + timedelta(seconds=90)).isoformat(),
            }
        return {"recorded": True}


class NeverSpawn(StubExecutor):
    def spawn(self, bootstrap, ref):
        raise AssertionError("Spawn attempted after losing authority")


def run(api, directory, job_id, **kwargs):
    return run_controller(
        api, NeverSpawn(), directory, job_id, "run-test", now=lambda: NOW, **kwargs
    )


def test_lost_submission_ack_holds_fence_and_never_spawns(tmp_path):
    job_id = str(uuid4())
    api = FixtureApi(lost_ack=True)
    assert run(api, tmp_path, job_id)["reason"] == "acknowledgement_lost"
    assert run(api, tmp_path, job_id)["reason"] == "submission_intent_exists"
    assert [action for action, _ in api.actions].count("issue_stage_claim") == 1
    assert not any(action == "record_execution_evidence" for action, _ in api.actions)


def crash_in_spawning(directory, job_id):
    def checkpoint(phase):
        if phase == "spawning":
            os.kill(os.getpid(), signal.SIGKILL)

    run(FixtureApi(), directory, job_id, checkpoint=checkpoint)


def test_crash_with_spawn_reserved_blocks_reentry(tmp_path):
    job_id = str(uuid4())
    child = multiprocessing.get_context("spawn").Process(
        target=crash_in_spawning, args=(tmp_path, job_id)
    )
    child.start()
    try:
        child.join(5)
        assert child.exitcode == -signal.SIGKILL
    finally:
        if child.is_alive():
            child.kill()
            child.join()
        child.close()
    journal = (tmp_path / job_id / "journal.json").read_text()
    assert json.loads(journal)["phase"] == "spawning"
    assert "test-credential" not in journal
    api = FixtureApi()
    assert run(api, tmp_path, job_id)["reason"] == "submission_intent_exists"
    assert not any(action == "issue_stage_claim" for action, _ in api.actions)
    assert (tmp_path / job_id / "journal.json").read_text() == journal


def test_lease_expiry_at_spawn_boundary_withholds_effects(tmp_path):
    job_id = str(uuid4())
    clock = NOW

    def checkpoint(phase):
        nonlocal clock
        if phase == "spawning":
            clock = NOW + timedelta(seconds=60)

    api = FixtureApi()
    assert run_controller(
        api,
        NeverSpawn(),
        tmp_path,
        job_id,
        "run-test",
        checkpoint=checkpoint,
        now=lambda: clock,
    ) == {"outcome": "lease_lost"}
    assert [
        facts["state"] for action, facts in api.actions if action == "record_stage_run"
    ] == ["submitting"]
