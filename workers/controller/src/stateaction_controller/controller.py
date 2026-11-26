"""Claim a workflow run and supervise it under the last confirmed lease."""

import asyncio
from contextlib import suppress
from dataclasses import dataclass, replace
from secrets import token_urlsafe
from time import time

from .api import ApiRejection
from .config import HAND_POSE
from .journal import JournalStore, instant
from .modal_controller import API_ERRORS, ModalExecution, outcome

ACTIVE = {
    "submitting",
    "submit_unknown",
    "running",
    "cancel_requested",
    "needs_attention",
    "result_pending",
}
TERMINAL = {"succeeded", "failed", "cancelled"}


@dataclass
class Lease:
    owner: str
    expires: float
    revoked: bool = False

    def deadline(self):
        if not self.revoked and time() < self.expires:
            return self.expires

    def live(self):
        return self.deadline() is not None


async def claim_lease(settings, api, job_id, run_ref):
    owner = "ctl-" + token_urlsafe(18)
    limit = asyncio.get_running_loop().time() + settings.lease_wait
    while True:
        grant = await api.act(job_id, "claim_lease", runRef=run_ref, owner=owner)
        if grant.get("granted"):
            return Lease(owner, instant(grant["expiresAt"]))
        if grant.get("reason") == "not_active":
            return outcome("no_effect", "job_not_active")
        if grant.get("reason") != "live_owner":
            return outcome("no_effect", "lease_refused")
        remaining = limit - asyncio.get_running_loop().time()
        if remaining <= 0:
            return outcome("no_effect", "lease_wait_exhausted")
        await asyncio.sleep(min(2, settings.renew, remaining))


async def renew_lease(settings, api, job_id, lease):
    while lease.live():
        await asyncio.sleep(settings.renew)
        if not lease.live():
            return
        try:
            renewal = await api.act(job_id, "renew_lease", owner=lease.owner)
            if not lease.live():
                return
            if renewal.get("renewed"):
                lease.expires = instant(renewal["expiresAt"])
                continue
            status = await api.status(job_id)
            if not lease.live():
                return
            if status["state"] in TERMINAL:
                lease.expires = max(lease.expires, time() + 300)
            else:
                lease.revoked = True
            return
        except API_ERRORS:
            # An unreadable response cannot extend authority.
            pass


@dataclass
class Controller:
    settings: object
    api: object
    store: JournalStore
    lease: Lease
    job_id: str
    run_ref: str
    modal: object = None

    async def execute(self, status, stage=None):
        if self.settings.backend == "local":
            from .local_controller import run_local

            return await run_local(self, status, stage)
        if self.modal is None:
            return outcome("no_effect", "modal_client_missing")
        binding = None
        if self.settings.pipeline == "clip_plan_cpu_v1":
            binding = (self.settings.bindings or {}).get(HAND_POSE)
            if binding and (
                binding["codeRevision"] != status["codeRevision"]
                or binding["gpu"] != "none"
            ):
                binding = None
        return await ModalExecution(
            self.api,
            self.store,
            self.modal,
            self.job_id,
            self.run_ref,
            self.lease.owner,
            self.lease.live,
            self.settings.api_url,
            self.settings.pipeline,
            self.settings.poll,
            self.settings.renew,
            self.settings.grace,
            stage=stage,
            plan_binding=binding,
        ).run(status)


async def run_controller(settings, api, job_id, run_ref, modal=None):
    from .recovery import reconcile_ended_evidence

    status = await api.status(job_id)
    if status["state"] in TERMINAL:
        return await reconcile_ended_evidence(
            settings, api, job_id, run_ref, modal, status
        )
    if status["state"] not in ACTIVE:
        return {"outcome": "not_admitted", "state": status["state"]}
    try:
        await api.act(job_id, "record_workflow_run", runRef=run_ref)
    except ApiRejection:
        return outcome("no_effect", "run_rejected")
    lease = await claim_lease(settings, api, job_id, run_ref)
    if not isinstance(lease, Lease):
        if lease["reason"] == "job_not_active":
            status = await api.status(job_id)
            if status["state"] in TERMINAL:
                return await reconcile_ended_evidence(
                    settings, api, job_id, run_ref, modal, status
                )
            return outcome("no_effect", "lease_refused")
        return lease
    renewer = asyncio.create_task(renew_lease(settings, api, job_id, lease))
    try:
        recipe = await api.recipe(job_id)
        if not lease.live():
            return outcome("lease_lost", "lease_expired")
        if status["kind"] == "clip_plan":
            if recipe:
                return outcome("needs_operator", "unexpected_clip_plan_recipe")
            settings = replace(settings, pipeline="clip_plan_cpu_v1")
        controller = Controller(
            settings,
            api,
            JournalStore(settings.state_dir),
            lease,
            job_id,
            run_ref,
            modal,
        )
        if recipe:
            from .recipe import run_recipe

            return await run_recipe(controller, recipe, status)
        return await controller.execute(await api.status(job_id))
    finally:
        renewer.cancel()
        with suppress(asyncio.CancelledError):
            await renewer
