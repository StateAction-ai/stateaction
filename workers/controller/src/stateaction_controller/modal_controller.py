"""Run a single Modal execution under the server's lease and deadlines."""

import asyncio
from contextlib import suppress
from dataclasses import dataclass, field
from time import time
from typing import Callable

from .api import AmbiguousApiError, ApiRejection
from .journal import (
    PROVIDER_BINDING_FIELDS,
    JournalCorrupt,
    instant,
    iso,
    terminal_result,
)
from .results import call_id_valid, parse_graph_result, parse_result

API_ERRORS = (AmbiguousApiError, ApiRejection)
GPU_WATCH_INTERVAL_SECONDS = 15


class SpawnNotSent(Exception):
    """The adapter proved no provider submission was attempted."""


class SpawnCancelled(SpawnNotSent):
    """The catalog recorded cancellation before the submission boundary."""


def outcome(kind, reason, **details):
    return {"outcome": kind, "reason": reason, **details}


async def record_modal_evidence(api, job_id, run_ref, result, termination, recovery):
    await api.act(
        job_id,
        "record_execution_evidence",
        evidence={
            "kind": "provider_call_terminal",
            "executionRef": result["functionCallId"],
            "detail": {
                "observation": "structured_result_observed",
                "exitCode": str(result["exitCode"]),
                "termination": termination,
                "recovery": recovery,
                "proof": "function_call_returned_structured_result",
                "runRef": run_ref,
            },
        },
    )


@dataclass
class ModalStage:
    stage: str
    module: str
    budget_seconds: int
    bootstrap: Callable
    node: dict | None = None
    binding: object = None
    gpu: bool = False
    refusal: str | None = None
    graph: bool = False


@dataclass
class ModalExecution:
    api: object
    store: object
    modal: object
    job_id: str
    run_ref: str
    owner: str
    lease_live: Callable[[], bool]
    api_url: str
    pipeline: str
    poll_seconds: float
    status_seconds: float
    grace_seconds: float
    stage: ModalStage | None = None
    plan_binding: object = None
    clock: Callable[[], float] = time
    sleep: Callable = asyncio.sleep
    journal: dict | None = field(default=None, init=False)
    catalog_id: str | None = field(default=None, init=False)

    @property
    def stage_name(self):
        return self.stage.stage if self.stage else None

    async def act(self, action, **facts):
        return await self.api.act(self.job_id, action, **facts)

    async def spawn_provider(self, bootstrap, authorized, binding):
        return await self.modal.spawn(bootstrap, authorized, binding)

    async def record_terminal(self, result, termination, recovery):
        await record_modal_evidence(
            self.api, self.job_id, self.run_ref, result, termination, recovery
        )

    async def start_confirmed(self, status):
        return status["state"] != "submitting"

    def save(self, journal):
        self.store.write_modal(journal, self.stage.module if self.stage else None)
        self.journal = journal

    async def unknown(self, reason, ref=None):
        if not self.lease_live():
            return outcome(
                "lease_lost", "lease_expired", **({"executionRef": ref} if ref else {})
            )
        if self.stage and ref is None:
            with suppress(*API_ERRORS):
                await self.stage_record("submit_unknown")
        with suppress(*API_ERRORS):
            await self.act("mark_submit_unknown", owner=self.owner)
        if ref is not None:
            return outcome("needs_operator", reason, executionRef=ref)
        return outcome("submit_unknown", reason)

    async def stage_record(self, state, **facts):
        return await self.act(
            "record_stage_run",
            owner=self.owner,
            stage=self.stage.stage,
            module=self.stage.module,
            state=state,
            **facts,
        )

    async def record_call(self, call_id):
        if self.stage:
            return await self.stage_record("running", callId=call_id)
        return await self.act(
            "record_execution",
            owner=self.owner,
            executor={"kind": "modal", "functionCallId": call_id},
        )

    def record(self, phase, source, **facts):
        result = {
            "version": 1,
            "executor": "modal",
            "jobId": self.job_id,
            "runRef": self.run_ref,
            "phase": phase,
            "startDeadline": source["startDeadline"],
            "executionDeadline": source["executionDeadline"],
            **facts,
        }
        if self.stage:
            result["stage"] = self.stage.stage
            if self.stage.graph:
                result["graph"] = True
        return result

    def budget(self, started):
        if self.stage is None:
            return {}
        return {"budgetDeadline": iso(started + self.stage.budget_seconds)}

    async def run(self, status):
        gpu = self.stage is not None and self.stage.gpu
        known = (
            self.stage.node.get("callId") if self.stage and self.stage.node else None
        )
        if not self.stage:
            known = status["executionRef"]
        if call_id_valid(known):
            self.catalog_id = known
        try:
            result = await self.drive(status, known)
        except asyncio.CancelledError:
            if gpu:
                await self.fence_gpu(outcome("needs_operator", "controller_cancelled"))
            raise
        except Exception:
            if not gpu or not self.refs():
                raise
            result = outcome("needs_operator", "gpu_supervision_failed")
        if gpu:
            result = await self.fence_gpu(result)
        return result

    def refs(self):
        return list(
            dict.fromkeys(
                ref
                for ref in (self.catalog_id, (self.journal or {}).get("callId"))
                if ref
            )
        )

    async def fence_gpu(self, result):
        refs = self.refs()
        if not refs:
            return result
        journal = self.journal or {}
        journal_id = journal.get("callId")
        unconfirmed = []
        for ref in refs:
            if result["outcome"] == "call_terminal" and result["executionRef"] == ref:
                continue
            if ref == journal_id and (
                journal["phase"] == "terminal" or journal.get("cancelRequestedAt")
            ):
                continue
            try:
                await self.modal.cancel(ref)
            except Exception:
                unconfirmed.append(ref)
                continue
            if ref == journal_id and journal["phase"] == "submitted":
                with suppress(OSError, JournalCorrupt):
                    self.save(
                        dict(
                            journal,
                            cancelRequestedAt=iso(self.clock()),
                            termination="gpu_supervision_stopped",
                        )
                    )
        if len(refs) > 1:
            return outcome(
                "needs_operator",
                "execution_ref_mismatch",
                executionRef=refs[0],
                conflictingExecutionRef=refs[1],
                **({"unconfirmedCancellationRefs": unconfirmed} if unconfirmed else {}),
            )
        if unconfirmed:
            return outcome(
                "needs_operator", "gpu_cancel_unconfirmed", executionRef=refs[0]
            )
        if result["outcome"] == "needs_operator":
            return {"executionRef": refs[0], **result}
        return result

    async def drive(self, status, known):
        if status["executionBackend"] != "modal":
            return outcome("needs_operator", "backend_mismatch")
        if known is not None and not call_id_valid(known):
            return outcome("needs_operator", "invalid_recorded_ref")
        try:
            if self.store.foreign_local(self.job_id, self.stage_name):
                return await self.unknown("foreign_local_journal", known)
            self.journal = self.store.read_modal(
                self.job_id, self.stage_name, self.stage.module if self.stage else None
            )
        except JournalCorrupt:
            return await self.unknown("journal_corrupt", known)
        journal = self.journal
        if journal and journal["runRef"] != self.run_ref:
            self.journal = None
            return outcome("needs_operator", "journal_run_mismatch")
        if journal and known and journal.get("callId", known) != known:
            return outcome(
                "needs_operator",
                "execution_ref_mismatch",
                executionRef=journal["callId"],
            )

        if journal and journal["phase"] == "spawning" and not known:
            self.store.discard_token(self.job_id, self.stage_name)
            return await self.unknown("spawn_outcome_uncertain")
        if self.stage and self.stage.refusal and not self.refs():
            return outcome("needs_operator", self.stage.refusal)
        issued_claim = False
        if known and (journal is None or journal["phase"] in ("intent", "spawning")):
            if not status["startDeadline"] or not status["executionDeadline"]:
                return outcome("needs_operator", "no_deadline")
            fields = self.budget(self.clock())
            if self.stage:
                started = (self.stage.node or {}).get("startedAt")
                if self.stage.gpu:
                    # Catalog timestamps can be later than dispatch. Without the
                    # original budget, observe and cancel the exact call immediately.
                    fields = {"budgetDeadline": iso(self.clock())}
                elif started:
                    fields = self.budget(instant(started))
                if journal and "budgetDeadline" in journal:
                    fields = {"budgetDeadline": journal["budgetDeadline"]}
            journal = self.record(
                "submitted", status, callId=known, executionRecorded=True, **fields
            )
            self.save(journal)
            self.store.discard_token(self.job_id, self.stage_name)
        elif journal is None:
            if self.stage and self.stage.node and self.stage.node["state"] != "pending":
                return await self.unknown("intent_recorded_without_token")
            if not self.stage and status["state"] != "submitting":
                return outcome("needs_operator", "no_local_journal")
            if not self.lease_live():
                return outcome("lease_lost", "lease_expired")
            if not self.stage and self.pipeline == "clip_plan_cpu_v1":
                if not self.plan_binding or not await self.modal.check_function(
                    self.plan_binding
                ):
                    return outcome("needs_operator", "clip_plan_binding_unavailable")
            try:
                action = (
                    "issue_stage_claim" if self.stage else "record_worker_submission"
                )
                fields = {"stage": self.stage_name} if self.stage else {}
                sub = await self.act(action, owner=self.owner, **fields)
            except AmbiguousApiError:
                return await self.unknown("submission_acknowledgement_lost")
            if sub.get("state") != "recorded":
                return await self.unknown("intent_recorded_without_token")
            if sub["executionBackend"] != "modal":
                return await self.unknown("backend_mismatch_after_intent")
            issued_claim = True
            journal = self.record("intent", sub)
            self.store.save_token(self.job_id, self.stage_name, sub["bootstrapToken"])
            self.save(journal)

        if (
            known
            and journal.get("callId") == known
            and not journal.get("executionRecorded")
        ):
            journal = dict(journal, executionRecorded=True)
            self.save(journal)

        recovery = "adopted_from_journal"
        if journal["phase"] in ("submitted", "terminal"):
            self.store.discard_token(self.job_id, self.stage_name)
        if journal["phase"] == "intent":
            decision = await self.spawn(journal, recheck=not issued_claim)
            if decision is not None:
                return decision
            recovery = "spawned_by_this_run"
        return await self.supervise(recovery)

    async def spawn(self, journal, *, recheck):
        if not self.lease_live():
            return outcome("lease_lost", "lease_expired")
        token = self.store.load_token(self.job_id, self.stage_name)
        submit_by = min(
            instant(journal["startDeadline"]), instant(journal["executionDeadline"])
        )

        def authorized():
            return self.lease_live() and self.clock() < submit_by

        if not token or not authorized():
            return await self.unknown("no_token_or_deadline")
        binding = self.stage.binding if self.stage else self.plan_binding
        if self.stage and self.stage.gpu and not binding:
            return outcome("needs_operator", "rerun_binding_unavailable")
        if (
            recheck
            and self.stage
            and binding
            and not await self.modal.check_function(binding, self.stage.module)
        ):
            return outcome("needs_operator", "rerun_binding_unavailable")
        if (
            recheck
            and not self.stage
            and self.pipeline == "clip_plan_cpu_v1"
            and (not binding or not await self.modal.check_function(binding))
        ):
            return outcome("needs_operator", "clip_plan_binding_unavailable")
        if not authorized():
            return await self.unknown("no_token_or_deadline")
        if self.stage:
            try:
                await self.stage_record("submitting")
            except ApiRejection:
                return await self.unknown("stage_submission_refused")
        current = await self.api.status(self.job_id)
        if not authorized():
            return await self.unknown("no_token_or_deadline")
        # Once intent is recorded, the existing API needs exact-call evidence
        # even when cancelled. Consume the existing reservation and supervise it.
        if current["state"] not in (
            "submitting",
            "submit_unknown",
            "running",
            "cancel_requested",
        ):
            self.store.discard_token(self.job_id, self.stage_name)
            return outcome("no_effect", "job_not_active")
        if not self.store.reserve_spawn(self.job_id, self.stage_name):
            return await self.unknown("spawn_outcome_uncertain")
        journal = dict(journal, phase="spawning", **self.budget(self.clock()))
        if "budgetDeadline" in journal:
            submit_by = min(submit_by, instant(journal["budgetDeadline"]))
        self.save(journal)
        bootstrap = (
            self.stage.bootstrap(token)
            if self.stage
            else {
                "schemaVersion": 1,
                "apiUrl": self.api_url,
                "jobId": self.job_id,
                "bootstrapToken": token,
                "pipeline": self.pipeline,
            }
        )
        try:
            call_id = await self.spawn_provider(bootstrap, authorized, binding)
        except SpawnCancelled:
            self.store.discard_token(self.job_id, self.stage_name)
            return outcome("no_effect", "never_submitted")
        except SpawnNotSent:
            self.store.discard_token(self.job_id, self.stage_name)
            return await self.unknown("spawn_not_sent")
        except Exception:
            self.store.discard_token(self.job_id, self.stage_name)
            return await self.unknown("spawn_outcome_uncertain")
        except asyncio.CancelledError:
            self.store.discard_token(self.job_id, self.stage_name)
            raise
        if not call_id_valid(call_id):
            self.store.discard_token(self.job_id, self.stage_name)
            return await self.unknown("invalid_call_id")
        submitted = dict(journal, phase="submitted", callId=call_id)
        if self.stage and binding and PROVIDER_BINDING_FIELDS <= binding.keys():
            submitted["spawnBinding"] = {
                key: binding[key] for key in PROVIDER_BINDING_FIELDS
            }
        self.journal = submitted
        try:
            self.save(submitted)
            self.store.discard_token(self.job_id, self.stage_name)
        except (JournalCorrupt, OSError):
            with suppress(*API_ERRORS):
                await self.record_call(call_id)
            raise
        return None

    async def confirm_call_record(self, journal, call_id):
        if journal.get("executionRecorded") or not self.lease_live():
            return journal
        try:
            await self.record_call(call_id)
        except AmbiguousApiError:
            return journal
        updated = dict(journal, executionRecorded=True)
        self.save(updated)
        return updated

    async def supervise(self, recovery):
        journal = self.journal
        call_id = journal["callId"]
        stage_id = (
            (self.job_id, self.stage.stage, self.stage.module) if self.stage else None
        )
        refusal = (
            self.stage.refusal
            if self.stage and self.stage.gpu and journal["phase"] != "terminal"
            else None
        )
        termination = journal.get("termination") or refusal or "natural_exit"
        result = terminal_result(journal) if journal["phase"] == "terminal" else None
        last_status = last_watch = float("-inf")
        containers = set()
        grace_until = None
        catalog_refused = False

        def check_bounds():
            if self.clock() >= instant(journal["executionDeadline"]):
                return "execution_deadline"
            if "budgetDeadline" in journal and self.clock() >= instant(
                journal["budgetDeadline"]
            ):
                return "budget_exceeded"
            return "natural_exit"

        while result is None:
            if not self.lease_live():
                return outcome("lease_lost", "lease_expired", executionRef=call_id)
            if termination == "natural_exit":
                termination = check_bounds()
            if termination == "natural_exit" and not catalog_refused:
                try:
                    journal = await self.confirm_call_record(journal, call_id)
                except ApiRejection:
                    if not self.lease_live():
                        return outcome(
                            "lease_lost", "lease_expired", executionRef=call_id
                        )
                    catalog_state = None
                    with suppress(*API_ERRORS):
                        catalog_state = (await self.api.status(self.job_id))["state"]
                    if catalog_state not in ("succeeded", "failed", "cancelled"):
                        return outcome(
                            "needs_operator",
                            "execution_ref_conflict",
                            executionRef=call_id,
                        )
                    catalog_refused = True
                    grace_until = self.clock() + self.grace_seconds
            if (
                self.stage
                and self.stage.gpu
                and termination == "natural_exit"
                and self.clock() - last_watch >= GPU_WATCH_INTERVAL_SECONDS
            ):
                last_watch = self.clock()
                try:
                    containers.update(
                        await self.modal.watch(
                            call_id, journal.get("spawnBinding") or self.stage.binding
                        )
                    )
                    if len(containers) > 1:
                        termination = "provider_container_restarted"
                except Exception:
                    termination = "gpu_watchdog_unavailable"
            if (
                termination == "natural_exit"
                and self.clock() - last_status >= self.status_seconds
            ):
                last_status = self.clock()
                with suppress(*API_ERRORS):
                    current = await self.api.status(self.job_id)
                    if current["state"] == "cancel_requested":
                        termination = "cancel_requested"
                    elif self.clock() >= instant(
                        journal["startDeadline"]
                    ) and not await self.start_confirmed(current):
                        termination = "start_deadline"
            if termination == "natural_exit":
                termination = check_bounds()
            if not self.lease_live():
                return outcome("lease_lost", "lease_expired", executionRef=call_id)
            if termination != "natural_exit":
                if grace_until is None:
                    grace_until = self.clock() + self.grace_seconds
                if not journal.get("cancelRequestedAt"):
                    try:
                        await self.modal.cancel(call_id)
                    except Exception:
                        pass
                    else:
                        journal = dict(
                            journal,
                            cancelRequestedAt=iso(self.clock()),
                            termination=termination,
                        )
                        self.save(journal)
                if not catalog_refused:
                    try:
                        journal = await self.confirm_call_record(journal, call_id)
                    except ApiRejection:
                        catalog_refused = True
            if grace_until is not None and self.clock() >= grace_until:
                reason = (
                    "call_not_provably_terminal_after_cancel"
                    if termination != "natural_exit"
                    else "call_not_provably_terminal_after_job_end"
                )
                return outcome("needs_operator", reason, executionRef=call_id)
            observation = await self.modal.poll(call_id)
            if self.stage and self.stage.gpu and termination == "natural_exit":
                termination = check_bounds()
            if observation["kind"] == "returned":
                result = (
                    parse_graph_result(observation["value"], call_id)
                    if self.stage and self.stage.graph
                    else parse_result(observation["value"], call_id, stage_id)
                )
            if result is None:
                await self.sleep(self.poll_seconds)

        if journal["phase"] != "terminal":
            journal = dict(
                journal,
                phase="terminal",
                exitCode=result["exitCode"],
                termination=termination,
            )
            if receipt := result.get("receipt"):
                journal["receipt"] = receipt
            self.save(journal)
        evidence = "recorded" if journal.get("evidenceRecorded") else "unconfirmed"
        if evidence != "recorded":
            # The worker may have claimed this call even if the catalog write
            # was lost or the job closed before this controller could record it.
            if not catalog_refused:
                with suppress(ApiRejection):
                    journal = await self.confirm_call_record(journal, call_id)
            # The route checks that the exact call belongs to this job.
            try:
                await self.record_terminal(result, termination, recovery)
            except API_ERRORS:
                pass
            else:
                self.save(dict(journal, evidenceRecorded=True))
                evidence = "recorded"
        return {
            "outcome": "call_terminal",
            "executionRef": call_id,
            "result": result,
            "evidence": evidence,
            "termination": termination,
            "receipt": result.get("receipt"),
            "spawnBinding": journal.get("spawnBinding"),
        }
