"""Recover independently verifiable execution evidence for the original run."""

import hashlib
from secrets import token_urlsafe
from uuid import UUID

from stateaction_contracts import request_sha256

from .api import ApiRejection
from .journal import STAGES, JournalCorrupt, JournalStore, terminal_result
from .modal_controller import outcome, record_modal_evidence
from .results import call_id_valid, parse_result

OPEN = {"submitting", "submit_unknown", "running"}


def recovery_binding(job_id, api_url, bootstrap_sha256, identity=None):
    stage, module = identity[1:] if identity else ("", "")
    return hashlib.sha256(
        "\n".join((api_url, job_id, stage, module, bootstrap_sha256)).encode()
    ).hexdigest()


async def recover_modal(
    api, modal, bootstrap_hash, *, job_id, call_id, run_ref, api_url, stage=None
):
    if (
        str(UUID(job_id)) != job_id
        or not call_id_valid(call_id)
        or (stage and stage not in STAGES)
    ):
        raise ValueError("Invalid recovery identity")
    status = await api.status(job_id)
    if (
        status["jobId"] != job_id
        or status["state"] != "cancel_requested"
        or status["executionBackend"] != "modal"
        or status["startDeadline"] is None
    ):
        raise ValueError("Recovery requires a cancelled Modal submission")
    recipe = await api.recipe(job_id)
    identity = None
    known = status["executionRef"]
    if recipe:
        spec = next((spec for spec in recipe["stages"] if spec["stage"] == stage), None)
        dag = await api.dag(job_id)
        node = next((node for node in dag["stages"] if node["stage"] == stage), None)
        if (
            not spec
            or not spec["enabled"]
            or not node
            or node["state"] not in OPEN
            or node["module"] != spec["module"]
        ):
            raise ValueError("Recovery requires an open stage of the admitted recipe")
        identity = (job_id, stage, spec["module"])
        known = node["callId"]
    elif stage is not None:
        raise ValueError("Recovery stage requires an admitted recipe")
    if known is not None and known != call_id:
        raise ValueError("A different Modal call is already recorded")
    seen = await modal.poll(call_id)
    result = (
        parse_result(seen["value"], call_id, identity)
        if seen["kind"] == "returned"
        else None
    )
    if result is None:
        raise ValueError("Modal has no exact terminal proof")
    if "callBinding" in result:
        expected = recovery_binding(job_id, api_url, await bootstrap_hash(), identity)
        if expected != result["callBinding"]:
            raise ValueError("Modal result binding differs")
    elif known != call_id:
        raise ValueError("An unknown call requires bound proof")

    owner = token_urlsafe(32)
    grant = await api.act(job_id, "claim_lease", runRef=run_ref, owner=owner)
    if not grant.get("granted"):
        raise ValueError("Controller lease refused")
    if identity and known is None:
        await api.act(
            job_id,
            "record_stage_run",
            owner=owner,
            stage=stage,
            module=identity[2],
            state="running",
            callId=call_id,
        )
    elif identity is None:
        await api.act(
            job_id,
            "record_execution",
            owner=owner,
            executor={"kind": "modal", "functionCallId": call_id},
        )
    await api.act(
        job_id,
        "record_execution_evidence",
        evidence={
            "kind": "provider_call_terminal",
            "executionRef": call_id,
            "detail": {
                "proof": "function_call_returned_structured_result",
                "recovery": "operator_observed_modal_result",
                "exitCode": str(result["exitCode"]),
                "runRef": run_ref,
            },
        },
    )
    if identity:
        await api.act(
            job_id,
            "record_stage_run",
            owner=owner,
            stage=stage,
            module=identity[2],
            state="cancelled",
            callId=call_id,
            errorCode="cancel_requested",
        )


async def reconcile_ended_evidence(settings, api, job_id, run_ref, modal, status):
    unchanged = {"outcome": "not_admitted", "state": status["state"]}
    if settings.backend != status["executionBackend"]:
        return unchanged
    recipe = await api.recipe(job_id)
    if recipe:
        dag = await api.dag(job_id)
        if dag["recipeSha256"] != request_sha256(recipe):
            return outcome("needs_operator", "recipe_mismatch")
        enabled = {
            spec["stage"]: spec["module"]
            for spec in recipe["stages"]
            if spec["enabled"]
        }
        calls = [
            (node["stage"], node["module"], node["callId"])
            for node in dag["stages"]
            if node.get("callId") and enabled.get(node["stage"]) == node["module"]
        ]
    elif status["executionRef"]:
        calls = [(None, None, status["executionRef"])]
    else:
        return unchanged
    if not calls:
        return unchanged

    # The existing endpoint can only confirm the recorded run after a job ends.
    try:
        await api.act(job_id, "record_workflow_run", runRef=run_ref)
    except ApiRejection:
        return outcome("no_effect", "run_rejected")

    store = JournalStore(settings.state_dir)
    recovered = []
    for stage, module, call_id in calls:
        try:
            if settings.backend == "modal":
                new_evidence = await ended_modal_evidence(
                    api, store, modal, job_id, run_ref, stage, module, call_id
                )
            else:
                new_evidence = await ended_local_evidence(
                    api, store, settings.python, job_id, run_ref, stage, call_id
                )
        except (ApiRejection, JournalCorrupt):
            continue
        if new_evidence:
            recovered.append(call_id)
    if recovered:
        return {
            "outcome": "ended_evidence",
            "state": status["state"],
            "recordedRefs": recovered,
        }
    return unchanged


async def ended_modal_evidence(
    api, store, modal, job_id, run_ref, stage, module, call_id
):
    if not call_id_valid(call_id):
        return False
    journal = store.read_modal(job_id, stage, module)
    if journal and (journal["runRef"] != run_ref or journal.get("callId") != call_id):
        return False
    termination = "natural_exit"
    if journal and journal["phase"] == "terminal":
        result = terminal_result(journal)
        termination = journal.get("termination", termination)
    elif modal is not None:
        seen = await modal.poll(call_id)
        identity = (job_id, stage, module) if stage else None
        result = (
            parse_result(seen["value"], call_id, identity)
            if seen["kind"] == "returned"
            else None
        )
        if journal:
            termination = journal.get("termination", termination)
    else:
        return False
    if result is None:
        return False
    await record_modal_evidence(
        api, job_id, run_ref, result, termination, "adopted_after_job_end"
    )
    # A replay can promote stage proof after job end. An acknowledged
    # journal entry is already recorded, so it is not a new recovery result.
    return not (journal and journal.get("evidenceRecorded"))


async def ended_local_evidence(api, store, python, job_id, run_ref, stage, call_id):
    from .local_controller import record_local_evidence
    from .local_process import boot_id, exit_result, inspect

    journal = store.read_local(job_id, stage)
    if (
        not journal
        or journal["runRef"] != run_ref
        or journal["executionRef"] != call_id
        or journal["bootId"] != boot_id()
        or not (journal.get("singleProcess") or journal.get("pidNamespace"))
    ):
        return False
    if journal["phase"] != "exited":
        if journal["phase"] != "running" or (await inspect(journal, python) != "gone"):
            return False
        journal = dict(journal, exit=exit_result(None))
    await record_local_evidence(
        api,
        run_ref,
        journal,
        journal.get("termination", "natural_exit"),
        "adopted_after_job_end",
    )
    return not journal.get("evidenceRecorded", False)
