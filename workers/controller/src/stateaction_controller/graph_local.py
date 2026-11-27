import json
from time import time
from uuid import uuid4

from stateaction_contracts import request_sha256

from .journal import JournalCorrupt, instant, iso
from .local_controller import supervise
from .local_process import boot_id, send_bootstrap, spawn, supports_threaded
from .modal_controller import API_ERRORS, outcome


async def run_local_node(controller, node_id, node, recipe_sha256):
    api, settings, store, lease = (
        controller.api,
        controller.settings,
        controller.store,
        controller.lease,
    )
    job_id, run_ref = controller.job_id, controller.run_ref

    async def act(action, **facts):
        return await api.graph_action(
            job_id, action, nodeId=node_id, owner=lease.owner, **facts
        )

    async def unknown(reason, ref=None):
        return outcome("needs_operator", reason, executionRef=ref)

    if not supports_threaded() or not settings.python:
        return await unknown("execution_isolation_unproven")
    if not lease.live():
        return outcome("lease_lost", "lease_expired")
    try:
        if store.foreign_modal(job_id, node_id):
            return await unknown("foreign_modal_journal")
        journal = store.read_local(job_id, node_id)
    except JournalCorrupt:
        return await unknown("journal_corrupt")
    call = node["executionRef"]
    if journal and (
        journal["bootId"] != boot_id()
        or journal["runRef"] != run_ref
        or (call and journal["executionRef"] != call)
    ):
        return await unknown("execution_ref_mismatch", call)
    if journal and journal["phase"] == "spawning":
        return await unknown("spawn_outcome_uncertain", journal["executionRef"])
    binding_sha256 = request_sha256(node["binding"])
    if journal is None:
        if node["state"] == "issued":
            if (await api.status(job_id))["state"] == "cancel_requested":
                cancelled = await act("begin_node_submission")
                if cancelled["state"] == "never_submitted":
                    return outcome("no_effect", "never_submitted")
            return await unknown("intent_recorded_without_token", call)
        if node["state"] != "pending" or call:
            return await unknown("no_local_journal", call)
        try:
            claim = await act("issue_node_claim", bindingSha256=binding_sha256)
        except API_ERRORS:
            return await unknown("claim_unconfirmed")
        if claim["state"] != "issued":
            return await unknown("intent_recorded_without_token")
        journal = {
            "version": 1,
            "jobId": job_id,
            "stage": node_id,
            "runRef": run_ref,
            "bootId": boot_id(),
            "executionRef": f"local-{uuid4()}",
            "phase": "intent",
            "startDeadline": claim["startDeadline"],
            "executionDeadline": claim["executionDeadline"],
            "threadedPipeline": True,
        }
        store.save_token(job_id, node_id, claim["bootstrapToken"])
        store.write_local(journal)

    child = None
    ref = journal["executionRef"]
    if journal["phase"] == "intent":
        if not lease.live():
            return outcome("lease_lost", "lease_expired", executionRef=ref)
        try:
            admission = await act("begin_node_submission")
        except API_ERRORS:
            return await unknown("submission_authority_unconfirmed", ref)
        if admission["state"] == "never_submitted":
            store.discard_token(job_id, node_id)
            return outcome("no_effect", "never_submitted")
        if admission["state"] != "started":
            return await unknown("spawn_outcome_uncertain", ref)
        token = store.load_token(job_id, node_id)
        if not token or not lease.live() or time() >= instant(journal["startDeadline"]):
            return await unknown("submission_authority_expired", ref)
        journal = dict(
            journal,
            phase="spawning",
            budgetDeadline=iso(
                min(
                    instant(journal["executionDeadline"]),
                    time() + node["budgetSeconds"],
                )
            ),
        )
        store.write_local(journal)
        try:
            await act("record_node_call", executionRef=ref)
        except API_ERRORS:
            return await unknown("call_record_unconfirmed", ref)
        try:
            child, identity = await spawn(settings, store, journal, False, graph=True)
            journal = dict(journal, **identity, phase="running")
            store.write_local(journal)
            if lease.live():
                await send_bootstrap(
                    child,
                    json.dumps(
                        {
                            "apiUrl": settings.api_url,
                            "jobId": job_id,
                            "nodeId": node_id,
                            "recipeSha256": recipe_sha256,
                            "bindingSha256": binding_sha256,
                            "bootstrapToken": token,
                        }
                    ).encode(),
                )
        except (OSError, ValueError, RuntimeError):
            if child is None:
                return await unknown("worker_isolation_unconfirmed", ref)
        finally:
            if child is not None and child.stdin is not None:
                child.stdin.close()
            store.discard_token(job_id, node_id)
    return await supervise(controller, journal, None, child, unknown, graph=True)
