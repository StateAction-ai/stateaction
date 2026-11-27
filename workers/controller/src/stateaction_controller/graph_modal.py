"""Attach the graph control protocol to the exact Modal call supervisor."""

from contextlib import suppress

from stateaction_contracts import request_sha256

from .api import reconcile_graph_request
from .journal import instant
from .modal_controller import (
    API_ERRORS,
    ModalExecution,
    ModalStage,
    SpawnCancelled,
    SpawnNotSent,
    outcome,
)


class GraphModalExecution(ModalExecution):
    async def graph_action(self, action, **facts):
        return await self.api.graph_action(
            self.job_id, action, owner=self.owner, nodeId=self.stage_name, **facts
        )

    async def act(self, action, **facts):
        if action != "issue_stage_claim":
            return await super().act(action, **facts)
        claim = await self.graph_action(
            "issue_node_claim", bindingSha256=request_sha256(self.stage.binding)
        )
        if claim["state"] != "issued":
            return {"state": "already_issued"}
        return dict(claim, state="recorded", executionBackend="modal")

    async def unknown(self, reason, ref=None):
        if not self.lease_live():
            return outcome("lease_lost", "lease_expired", executionRef=ref)
        return outcome("needs_operator", reason, executionRef=ref)

    async def stage_record(self, state, **facts):
        if state != "submitting":
            raise ValueError("Unexpected graph submission state")

    async def spawn_provider(self, bootstrap, authorized, binding):
        async def before_submit():
            if not authorized():
                raise SpawnNotSent()
            result = await self.graph_action("begin_node_submission")
            if result["state"] == "never_submitted":
                raise SpawnCancelled()
            if result["state"] != "started":
                raise SpawnNotSent()

        node_deadline = min(
            (self.journal["budgetDeadline"], self.journal["executionDeadline"]),
            key=instant,
        )
        return await self.modal.spawn(
            {**bootstrap, "nodeDeadline": node_deadline},
            authorized,
            binding,
            before_submit=before_submit,
        )

    async def record_call(self, call_id):
        return await self.graph_action("record_node_call", executionRef=call_id)

    async def start_confirmed(self, status):
        snapshot = await self.api.graph(self.job_id)
        return bool(snapshot and snapshot["nodes"][self.stage_name]["claimedAt"])

    async def record_terminal(self, result, termination, _recovery):
        await reconcile_graph_request(
            lambda: self.graph_action(
                "record_node_terminal",
                executionRef=result["functionCallId"],
                kind="provider_call_terminal",
                observed={
                    "termination": termination,
                    "exitCode": result["exitCode"],
                },
            ),
            self.lease_live,
            lambda: self.sleep(self.poll_seconds),
        )


async def run_modal_node(controller, node_id, node, graph):
    binding = node["binding"]
    module = graph.node(node_id)["module"]
    if controller.modal is None:
        return outcome("needs_operator", "modal_client_missing")
    status = await controller.api.status(controller.job_id)
    if node["startDeadline"] is not None:
        status = {**status, "startDeadline": node["startDeadline"]}
    if node["state"] == "pending" and not await controller.modal.check_function(
        binding, module
    ):
        return outcome("needs_operator", "node_binding_unavailable")
    settings = controller.settings

    def bootstrap(token):
        return {
            "schemaVersion": 1,
            "apiUrl": settings.api_url,
            "jobId": controller.job_id,
            "nodeId": node_id,
            "recipeSha256": graph.sha256,
            "bindingSha256": request_sha256(binding),
            "module": module,
            "codeRevision": binding["codeRevision"],
            "imageSha256": binding["imageSha256"],
            "paramsSha256": binding["paramsSha256"],
            "gpu": binding["gpu"],
            "bootstrapToken": token,
        }

    execution = GraphModalExecution(
        controller.api,
        controller.store,
        controller.modal,
        controller.job_id,
        controller.run_ref,
        controller.lease.owner,
        controller.lease.live,
        settings.api_url,
        settings.pipeline,
        settings.poll,
        settings.renew,
        settings.grace,
        stage=ModalStage(
            node_id,
            module,
            node["budgetSeconds"],
            bootstrap,
            node={**node, "callId": node["executionRef"]},
            binding=binding,
            gpu=binding["gpu"] is not None,
            graph=True,
        ),
    )
    if node["state"] == "issued" and status["state"] == "cancel_requested":
        with suppress(*API_ERRORS):
            proof = await execution.graph_action("begin_node_submission")
            if proof["state"] == "never_submitted":
                controller.store.discard_token(controller.job_id, node_id)
                return outcome("no_effect", "never_submitted")
    return await execution.run(status)
