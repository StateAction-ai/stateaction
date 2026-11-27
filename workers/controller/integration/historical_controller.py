"""Create historical execution records in disposable fixtures."""

from dataclasses import replace

from stateaction_controller.config import HAND_POSE
from stateaction_controller.controller import Controller as LeasedController
from stateaction_controller.controller import run_with_lease
from stateaction_controller.modal_controller import ModalExecution, outcome
from stateaction_controller.recovery import reconcile_ended_evidence


class Controller(LeasedController):
    async def execute(self, status, stage=None):
        if self.settings.backend == "local":
            from stateaction_controller.local_controller import run_local

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
    async def drive(leased, status):
        controller = Controller(**vars(leased))
        lease = controller.lease
        recipe = await api.recipe(job_id)
        if not lease.live():
            return outcome("lease_lost", "lease_expired")
        if status["kind"] == "clip_plan":
            if recipe:
                return outcome("needs_operator", "unexpected_clip_plan_recipe")
            controller.settings = replace(settings, pipeline="clip_plan_cpu_v1")
        if recipe:
            from historical_recipe import run_recipe

            return await run_recipe(controller, recipe, status)
        return await controller.execute(await api.status(job_id))

    return await run_with_lease(
        settings,
        api,
        job_id,
        run_ref,
        modal,
        drive,
        recover=reconcile_ended_evidence,
    )
