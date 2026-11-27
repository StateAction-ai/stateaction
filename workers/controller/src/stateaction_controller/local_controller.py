"""Execute the local fixture or threaded worker with verified exit evidence."""

import asyncio
from contextlib import suppress
from time import time
from uuid import uuid4

from .api import AmbiguousApiError, ApiRejection, reconcile_graph_request
from .journal import JournalCorrupt, instant, iso
from .local_process import (
    boot_id,
    exit_result,
    helper,
    inspect,
    last_graph_result,
    last_receipt,
    send_bootstrap,
    spawn,
    supports_threaded,
)
from .modal_controller import API_ERRORS, outcome
from .modal_executor import bootstrap_bytes
from .results import parse_receipt


async def run_local(controller, status, stage=None):
    api, settings, store = controller.api, controller.settings, controller.store
    job_id, run_ref, lease = controller.job_id, controller.run_ref, controller.lease
    stage_name = stage.stage if stage else None
    fixture = stage is None and settings.pipeline == "local_fixture_noop"

    async def act(action, **facts):
        return await api.act(job_id, action, owner=lease.owner, **facts)

    async def mark(state, **facts):
        return await act(
            "record_stage_run",
            stage=stage_name,
            state=state,
            module=stage.module,
            **facts,
        )

    async def unknown(reason, ref=None):
        if not lease.live():
            return outcome("lease_lost", "lease_expired")
        if stage and ref is None:
            with suppress(*API_ERRORS):
                await mark("submit_unknown")
        with suppress(*API_ERRORS):
            await act("mark_submit_unknown")
        if ref:
            return outcome("needs_operator", reason, executionRef=ref)
        return outcome("submit_unknown", reason)

    if status["executionBackend"] != "local":
        return outcome("needs_operator", "backend_mismatch")
    try:
        if store.foreign_modal(job_id, stage_name):
            return await unknown("foreign_modal_journal")
        journal = store.read_local(job_id, stage_name)
    except JournalCorrupt:
        return await unknown("journal_corrupt")
    if not lease.live():
        return outcome("lease_lost", "lease_expired")
    boot = boot_id()
    known = (stage.node or {}).get("callId") if stage else status["executionRef"]
    if journal:
        ref = journal["executionRef"]
        if journal["bootId"] != boot:
            return await unknown("boot_changed", ref)
        if journal["runRef"] != run_ref:
            return await unknown("journal_run_mismatch", ref)
        if known and known != ref:
            return outcome("needs_operator", "execution_ref_mismatch", executionRef=ref)
        if journal["phase"] == "spawning":
            store.discard_token(job_id, stage_name)
            return await unknown("spawn_outcome_uncertain", ref)
        if journal["phase"] in ("running", "exited"):
            store.discard_token(job_id, stage_name)
        if bool(journal.get("threadedPipeline")) == fixture:
            return await unknown("execution_isolation_unproven", ref)
    else:
        if known or (stage and stage.node):
            return await unknown("no_local_journal", known)
        if not stage and status["state"] != "submitting":
            return outcome("needs_operator", "no_local_journal")
        if not fixture and not supports_threaded():
            return outcome("needs_operator", "execution_isolation_unproven")
        try:
            sub = (
                await act("issue_stage_claim", stage=stage_name)
                if stage
                else await act("record_worker_submission")
            )
        except AmbiguousApiError:
            return await unknown("submission_acknowledgement_lost")
        if not lease.live():
            return outcome("lease_lost", "lease_expired")
        if sub.get("state") != "recorded":
            return await unknown("intent_recorded_without_token")
        if sub["executionBackend"] != "local":
            return await unknown("backend_mismatch_after_intent")
        ref = f"local-{uuid4()}"
        journal = {
            "version": 1,
            "jobId": job_id,
            "runRef": run_ref,
            "bootId": boot,
            "executionRef": ref,
            "phase": "intent",
            "startDeadline": sub["startDeadline"],
            "executionDeadline": sub["executionDeadline"],
        }
        if stage:
            journal["stage"] = stage_name
        if not fixture:
            journal["threadedPipeline"] = True
        store.save_token(job_id, stage_name, sub["bootstrapToken"])
        store.write_local(journal)

    child = None
    if journal["phase"] in ("intent", "execution_recorded"):
        if not fixture and not supports_threaded():
            return await unknown("execution_isolation_unproven", ref)
        token = store.load_token(job_id, stage_name)
        submit_by = min(
            instant(journal["startDeadline"]), instant(journal["executionDeadline"])
        )
        if not token or time() >= submit_by:
            return await unknown("no_token_or_deadline", ref)
        try:
            if stage:
                await mark("submitting", callId=ref)
            else:
                await act(
                    "record_execution",
                    executor={"kind": "local", "localExecutionRef": ref},
                )
        except ApiRejection:
            return await unknown("execution_ref_conflict", ref)
        current = await api.status(job_id)
        if not lease.live():
            return outcome("lease_lost", "lease_expired", executionRef=ref)
        # The existing API requires physical proof after intent. An authorized
        # intent can still dispatch once, then supervision settles cancellation.
        if current["state"] not in (
            "submitting",
            "submit_unknown",
            "running",
            "cancel_requested",
        ):
            store.discard_token(job_id, stage_name)
            return outcome("no_effect", "job_not_active")
        if time() >= submit_by:
            return await unknown("no_token_or_deadline", ref)
        if not store.reserve_spawn(job_id, stage_name):
            return outcome("needs_operator", "spawn_already_reserved", executionRef=ref)
        journal = dict(journal, phase="spawning")
        if stage:
            journal["budgetDeadline"] = iso(time() + stage.budget_seconds)
        store.write_local(journal)
        if not lease.live() or time() >= submit_by:
            return await unknown("no_token_or_deadline", ref)
        try:
            child, identity = await spawn(settings, store, journal, fixture)
        except FileNotFoundError:
            store.discard_token(job_id, stage_name)
            raise RuntimeError("The local worker executable is unavailable") from None
        except (OSError, RuntimeError, ValueError):
            store.discard_token(job_id, stage_name)
            return await unknown("spawn_outcome_uncertain", ref)
        try:
            journal = dict(journal, phase="running", **identity)
            store.write_local(journal)
            if not lease.live():
                return outcome("lease_lost", "lease_expired", executionRef=ref)
            if stage:
                payload = dict(
                    stage.bootstrap(token), executionRef=ref, executorKind="local"
                )
            else:
                payload = {
                    "schemaVersion": 1,
                    "apiUrl": settings.api_url,
                    "jobId": job_id,
                    "bootstrapToken": token,
                    "executionRef": ref,
                    "pipeline": settings.pipeline,
                }
                if fixture:
                    payload["fixtureHoldSeconds"] = settings.fixture_hold
            with suppress(BrokenPipeError, ConnectionResetError, TimeoutError):
                await send_bootstrap(child, bootstrap_bytes(payload))
        finally:
            child.stdin.close()
            store.discard_token(job_id, stage_name)
        if stage and lease.live():
            with suppress(*API_ERRORS):
                await mark("running", callId=ref)

    return await supervise(controller, journal, stage, child, unknown)


async def supervise(controller, journal, stage, child, unknown, *, graph=False):
    settings, store, lease = controller.settings, controller.store, controller.lease
    job_id, ref = controller.job_id, journal["executionRef"]
    if not journal.get("singleProcess") and not journal.get("pidNamespace"):
        return await unknown("execution_isolation_unproven", ref)
    last_status = float("-inf")
    termination = journal.get("termination", "natural_exit")
    recovery = "spawned_by_this_run" if child else "adopted_from_journal"

    if journal["phase"] != "exited":
        while True:
            if not lease.live():
                return outcome("lease_lost", "lease_expired", executionRef=ref)
            status = await inspect(journal, settings.python)
            if not lease.live():
                return outcome("lease_lost", "lease_expired", executionRef=ref)
            if status == "gone":
                break
            if status != "alive":
                return await unknown(status, ref)
            if time() - last_status >= settings.renew:
                last_status = time()
                with suppress(*API_ERRORS):
                    state = (await controller.api.status(job_id))["state"]
                    if state == "cancel_requested":
                        termination = "cancel_requested"
                    elif state == "submitting" and time() >= instant(
                        journal["startDeadline"]
                    ):
                        termination = "start_deadline"
            if time() >= instant(journal["executionDeadline"]):
                termination = "execution_deadline"
            elif (
                termination == "natural_exit"
                and journal.get("budgetDeadline")
                and time() >= instant(journal["budgetDeadline"])
            ):
                termination = "budget_exceeded"
            if termination != "natural_exit":
                deadline = lease.deadline()
                if deadline is None:
                    return outcome("lease_lost", "lease_expired", executionRef=ref)
                until = time() + settings.grace
                while lease.live():
                    deadline = lease.deadline()
                    if deadline is None:
                        break
                    killed = await helper(
                        settings.python, journal, deadline=min(until, deadline)
                    )
                    state = await inspect(journal, settings.python)
                    if state == "gone":
                        break
                    if killed != 0 or state != "alive" or time() >= until:
                        return outcome(
                            "needs_operator",
                            "worker_exit_unproven_after_kill",
                            executionRef=ref,
                        )
                    await asyncio.sleep(min(settings.poll, 0.05))
                break
            await asyncio.sleep(settings.poll)
        if not lease.live():
            return outcome("lease_lost", "lease_expired", executionRef=ref)
        journal = dict(
            journal, phase="exited", exit=exit_result(child.poll() if child else None)
        )
        if stage or graph:
            journal["termination"] = termination
        store.write_local(journal)

    if not lease.live():
        return outcome("lease_lost", "lease_expired", executionRef=ref)
    exit = journal["exit"]
    evidence = "recorded" if journal.get("evidenceRecorded") else "unconfirmed"
    if evidence != "recorded":
        try:
            if graph:
                await reconcile_graph_request(
                    lambda: controller.api.graph_action(
                        job_id,
                        "record_node_terminal",
                        nodeId=journal["stage"],
                        owner=lease.owner,
                        executionRef=ref,
                        kind="local_child_reaped",
                        observed={
                            "termination": journal.get("termination", "natural_exit"),
                            "exit": exit,
                        },
                    ),
                    lease.live,
                    lambda: asyncio.sleep(settings.poll),
                )
            else:
                await record_local_evidence(
                    controller.api,
                    controller.run_ref,
                    journal,
                    termination,
                    recovery,
                    child,
                )
        except API_ERRORS:
            pass
        else:
            store.write_local(dict(journal, evidenceRecorded=True))
            evidence = "recorded"
    receipt = (
        parse_receipt(
            last_receipt(store, journal),
            (job_id, stage.stage, stage.module),
            exit["code"],
        )
        if stage
        else None
    )
    if graph:
        receipt = last_graph_result(store, journal)
    return {
        "outcome": "child_exited",
        "executionRef": ref,
        "exit": exit,
        "evidence": evidence,
        "receipt": receipt,
        "termination": termination,
    }


async def record_local_evidence(
    api, run_ref, journal, termination, recovery, child=None
):
    threaded = journal.get("pidNamespace")
    exit = journal["exit"]
    observed = bool(child) or exit["signal"] != "not_observed"
    observation = (
        "reaped_by_controller"
        if observed
        else (
            "adopted_thread_group_exited"
            if threaded
            else "adopted_single_process_exited"
        )
    )

    def stringify(value):
        return str(value) if value is not None else "null"

    await api.act(
        journal["jobId"],
        "record_execution_evidence",
        evidence={
            "kind": "local_child_reaped",
            "executionRef": journal["executionRef"],
            "detail": {
                "observation": observation,
                "exitCode": stringify(exit["code"]),
                "exitSignal": stringify(exit["signal"]),
                "termination": termination,
                "recovery": recovery,
                "runRef": run_ref,
                "proof": "seccomp_pidfd_thread_group_exited"
                if threaded
                else "seccomp_single_process_exited",
            },
        },
    )
