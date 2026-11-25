"""One CPU stage through existing API fences, stopping before a seal."""

import secrets
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from api import AmbiguousApiError, ApiRejection, JobsApi
from executor import Executor
from journal import Journal
from stateaction_contracts import request_sha256

ACTIVE = {"submitting", "running", "submit_unknown"}
STAGE = "hand_pose"
MODULE = "hand_pose_cpu_v1@1"


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


def needs_operator(reason: str, **facts) -> dict:
    return {"outcome": "needs_operator", "reason": reason, **facts}


def run_controller(
    api: JobsApi,
    executor: Executor,
    state_dir: Path,
    job_id: str,
    run_ref: str,
    *,
    checkpoint: Callable[[str], None] = lambda _: None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> dict:
    status = api.status(job_id)
    if status["state"] not in ACTIVE:
        return {"outcome": "not_admitted", "state": status["state"]}
    if status["executionBackend"] != executor.backend:
        return needs_operator("backend_mismatch")
    try:
        api.act(job_id, "record_workflow_run", runRef=run_ref)
    except ApiRejection:
        return {"outcome": "no_effect", "reason": "run_rejected"}

    owner = "ctl-" + secrets.token_urlsafe(18)
    grant = api.act(job_id, "claim_lease", owner=owner, runRef=run_ref)
    if not grant["granted"]:
        return {"outcome": "no_effect", "reason": grant["reason"]}
    lease_expires = timestamp(grant["expiresAt"])
    if now() >= lease_expires:
        return {"outcome": "lease_lost"}

    recipe = api.recipe(job_id)
    dag = api.dag(job_id)
    if dag["recipeSha256"] != request_sha256(recipe):
        return needs_operator("recipe_mismatch")
    enabled = [spec for spec in recipe["stages"] if spec["enabled"]]
    if (
        len(enabled) != 1
        or enabled[0]["stage"] != STAGE
        or enabled[0]["module"] != MODULE
        or enabled[0]["resources"]["gpu"] != "none"
        or enabled[0]["resources"]["maxContainers"] != 1
        or enabled[0]["resources"]["retries"] != 0
    ):
        return needs_operator("cpu_fixture_required")
    stage = next(row for row in dag["stages"] if row["stage"] == STAGE)
    if stage["state"] != "pending":
        return needs_operator("stage_already_recorded")
    if not api.act(job_id, "start_parallel_recipe", owner=owner)["recorded"]:
        return needs_operator("prepare_only_unavailable")

    journal = Journal(state_dir, job_id)
    if not journal.reserve(run_ref):
        return needs_operator("submission_intent_exists")

    def record(state: str, **facts):
        return api.act(
            job_id,
            "record_stage_run",
            owner=owner,
            stage=STAGE,
            module=MODULE,
            state=state,
            **facts,
        )

    try:
        checkpoint("intent")
        receipt = api.act(job_id, "issue_stage_claim", owner=owner, stage=STAGE)
        if receipt["state"] != "recorded":
            return needs_operator("stage_claim_already_issued")
        if receipt["executionBackend"] != executor.backend:
            return needs_operator("claim_backend_mismatch")

        ref = executor.reserve_ref()
        record("submitting", **({"callId": ref} if ref else {}))
        journal.write(run_ref, "spawning", ref)
        checkpoint("spawning")
        if now() >= lease_expires:
            return {"outcome": "lease_lost"}
        if now() >= timestamp(receipt["startDeadline"]):
            return needs_operator("start_deadline_elapsed")

        call = executor.spawn(
            {
                "schemaVersion": 1,
                "apiUrl": api.base,
                "jobId": job_id,
                "bootstrapToken": receipt["bootstrapToken"],
                "pipeline": "hand_pose_cpu_v1",
                "stage": STAGE,
                "module": MODULE,
                "recipeSha256": dag["recipeSha256"],
                "prepareOnly": True,
                "priorStages": [],
            },
            ref,
        )
        try:
            journal.write(run_ref, "spawned", call.ref)
            checkpoint("spawned")
            record("running", callId=call.ref)
            deadline = min(
                timestamp(receipt["executionDeadline"]).timestamp(),
                now().timestamp() + enabled[0]["resources"]["budgetSeconds"],
            )
            while now().timestamp() < deadline:
                if now() >= lease_expires:
                    return {"outcome": "lease_lost"}
                if (lease_expires - now()).total_seconds() <= 30:
                    renewal = api.act(job_id, "renew_lease", owner=owner)
                    if not renewal["renewed"]:
                        return {"outcome": "lease_lost"}
                    lease_expires = timestamp(renewal["expiresAt"])
                terminal = call.poll()
                if terminal is None:
                    time.sleep(0.1 if executor.backend == "local" else 1)
                    continue
                facts: dict[str, Any] = {"callId": call.ref}
                if terminal.error_code:
                    facts["errorCode"] = terminal.error_code
                if terminal.receipt:
                    facts["receipt"] = terminal.receipt
                if executor.backend != "local":
                    return needs_operator("provider_terminal_proof_unavailable")
                if now() >= lease_expires:
                    return {"outcome": "lease_lost"}
                api.act(
                    job_id,
                    "record_execution_evidence",
                    evidence={
                        "kind": "local_child_reaped",
                        "executionRef": call.ref,
                        "detail": {
                            "observation": "reaped_by_controller",
                            "proof": "pidfd_stub",
                            "runRef": run_ref,
                        },
                    },
                )
                record(terminal.state, **facts)
                journal.write(run_ref, "terminal", call.ref)
                return needs_operator(
                    "spike_stopped_before_seal", stageState=terminal.state
                )
            return needs_operator("stage_deadline_elapsed")
        finally:
            call.close()
    except AmbiguousApiError:
        # Neither an ambiguous API acknowledgement nor an uncertain spawn can
        # authorize a second call. The server claim and journal both fence reentry.
        return needs_operator("acknowledgement_lost")
