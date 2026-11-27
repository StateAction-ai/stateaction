"""Schedule the historical recipe when constructing local test records."""

import asyncio
from time import time

from stateaction_contracts import request_sha256
from stateaction_controller.api import ApiRejection
from stateaction_controller.journal import instant
from stateaction_controller.modal_controller import ModalStage, outcome
from stateaction_controller.modal_executor import MAX_BOOTSTRAP_BYTES, bootstrap_bytes

TERMINAL = {"succeeded", "failed", "cancelled", "not_run"}


def segment_output(prior):
    segment = next((row for row in prior if row["stage"] == "segment"), None)
    if segment and segment["state"] == "succeeded":
        return next(
            (item for item in segment["outputs"] if item["role"] == "segments_json"),
            None,
        )


def stage_gate(spec, prior, out_of_budget):
    if spec["stage"] == "hand_pose":
        return None
    if out_of_budget:
        return "budget"
    if spec["stage"] != "caption":
        return None
    segment = next((row for row in prior if row["stage"] == "segment"), None)
    if not segment or segment["state"] != "succeeded":
        return "upstream_failed"
    if segment["counts"].get("segments") == 0:
        return "no_segments"
    if not segment_output(prior):
        return "segments_unavailable"
    return None


def make_bootstrap(controller, spec, recipe_digest, parallel, prior, token):
    stage = spec["stage"]
    value = {
        "schemaVersion": 1 if stage == "hand_pose" else 2,
        "apiUrl": controller.settings.api_url,
        "jobId": controller.job_id,
        "bootstrapToken": token,
        "stage": stage,
        "module": spec["module"],
        "recipeSha256": recipe_digest,
    }
    if stage == "hand_pose":
        value.update(
            pipeline="hand_pose_cpu_v1",
            priorStages=[
                {
                    key: row[key]
                    for key in ("stage", "state", "errorCode", "counts", "outputs")
                    if key in row
                }
                for row in prior
            ],
        )
        if parallel:
            value["prepareOnly"] = True
    elif stage == "caption" and (segments := segment_output(prior)):
        value.update(
            segmentsFileId=segments["fileId"], segmentsSha256=segments["sha256"]
        )
    return value


def settle(termination, receipt):
    if termination == "cancel_requested":
        return {"state": "cancelled", "errorCode": termination}
    if termination != "natural_exit":
        return {"state": "failed", "errorCode": termination}
    if not receipt:
        return {"state": "failed", "errorCode": "receipt_missing"}
    if receipt["status"] == "succeeded":
        return {"state": "succeeded", "receipt": receipt}
    return {"state": "failed", "errorCode": receipt["errorCode"], "receipt": receipt}


async def run_recipe(controller, recipe, admitted):
    settings, api, store = controller.settings, controller.api, controller.store
    job_id, owner = controller.job_id, controller.lease.owner
    live = controller.lease.live
    if settings.backend == "modal" and controller.modal is None:
        return outcome("no_effect", "modal_client_missing")
    digest = request_sha256(recipe)
    dag = await api.dag(job_id)
    if dag["recipeSha256"] != digest:
        return outcome("needs_operator", "recipe_mismatch")
    if not live():
        return outcome("lease_lost", "lease_expired")
    graph = await api.act(job_id, "start_parallel_recipe", owner=owner)
    if "recorded" not in graph:
        return outcome("needs_operator", "recipe_graph_invalid")
    parallel = graph["recorded"]
    specs = recipe["stages"]
    hand_spec = next(spec for spec in specs if spec["stage"] == "hand_pose")
    nodes = {
        node["stage"]: node for node in dag["stages"] if node["state"] != "pending"
    }
    summaries = {}
    execute = None
    functions = {}
    out_of_budget = False

    def finish(stopped=None):
        result = {
            "outcome": "recipe_run",
            "stages": [
                summaries[spec["stage"]] for spec in specs if spec["stage"] in summaries
            ],
        }
        if stopped:
            result["stopped"] = stopped
        return result

    if parallel:
        while live():
            prepared = await api.prepare_rerun(job_id, owner)
            if prepared["state"] != "copying":
                break
        if not live():
            return finish(outcome("lease_lost", "lease_expired"))
        if prepared["state"] == "failed":
            return finish(outcome("no_effect", "reuse_unavailable"))
        if prepared["state"] == "ready":
            if not prepared.get("execute"):
                return finish(outcome("needs_operator", "rerun_plan_invalid"))
            execute = set(prepared["execute"])
            functions = prepared.get("functions", {})

    async def record(spec, facts, call_id=None, binding=None):
        stage = spec["stage"]
        if not live():
            return outcome("lease_lost", "lease_expired")
        fields = {"owner": owner, "stage": stage, "module": spec["module"]}
        if call_id:
            fields["callId"] = call_id
        if (receipt := facts.get("receipt")) and call_id and binding:
            evidence = {
                key: binding[key]
                for key in (
                    "appName",
                    "codeRevision",
                    "environment",
                    "functionId",
                    "definitionId",
                    "paramsSha256",
                    "definitionSha256",
                )
            }
            evidence["workerReceiptSha256"] = request_sha256(receipt)
            facts = {
                **facts,
                "receipt": {**receipt, "schemaVersion": 2, "providerBinding": evidence},
            }
        try:
            await api.act(job_id, "record_stage_run", **fields, **facts)
        except ApiRejection:
            if not facts.get("receipt"):
                return outcome("needs_operator", f"{stage}_record_refused")
            return await record(
                spec, {"state": "failed", "errorCode": "receipt_rejected"}, call_id
            )
        summaries[stage] = {
            key: value
            for key, value in {"stage": stage, **facts, "callId": call_id}.items()
            if key != "receipt" and value is not None
        }
        return None

    async def run_stage(spec):
        nonlocal out_of_budget
        stage, module = spec["stage"], spec["module"]
        if not live():
            return outcome("lease_lost", "lease_expired")
        if execute is not None and stage not in execute:
            return None
        node = nodes.get(stage)
        if node and node["module"] != module:
            return outcome("needs_operator", "stage_module_mismatch")
        if not spec["enabled"]:
            return await record(
                spec, {"state": "not_run", "errorCode": "stage_disabled"}
            )
        if node and node["state"] in TERMINAL:
            summaries[stage] = {
                key: node[key]
                for key in ("stage", "state", "errorCode", "callId")
                if node.get(key) is not None
            }
            if stage != "hand_pose" and node.get("errorCode") == "budget":
                out_of_budget = True
            return None

        prior = []
        if stage == "caption" or (stage == "hand_pose" and not parallel):
            prior = (await api.prior_stages(job_id))["stages"]
        fresh = node is None and not store.has_journal(job_id, stage)
        if fresh and (reason := stage_gate(spec, prior, out_of_budget)):
            return await record(spec, {"state": "not_run", "errorCode": reason})

        resources = spec["resources"]
        budget = resources["budgetSeconds"]
        binding = None
        gpu = False
        refusal = None
        if settings.backend == "modal":
            if execute is not None:
                binding = functions.get("handPose" if stage == "hand_pose" else stage)
            elif settings.bindings is not None:
                binding = settings.bindings.get(module)
            gpu = resources["gpu"] != "none"
            clip_hand = admitted["kind"] == "clip_pipeline" and stage == "hand_pose"
            if (
                clip_hand
                and not (node and node.get("callId"))
                and (
                    not binding
                    or binding["gpu"] != "none"
                    or binding["codeRevision"] != admitted["codeRevision"]
                )
            ):
                refusal = "clip_hand_pose_binding_unavailable"
            if binding and (
                binding["gpu"] != resources["gpu"]
                or binding["maxContainers"] > resources["maxContainers"]
                or binding["paramsSha256"] != request_sha256(spec["params"])
                or (
                    gpu
                    and (
                        binding["maxContainers"] != 1
                        or binding["maxBilledSeconds"] <= 60
                        or not callable(getattr(controller.modal, "watch", None))
                        or settings.timeout > 5
                        or settings.poll > 3
                    )
                )
            ):
                refusal = refusal or "rerun_binding_unavailable"
            if gpu and binding and refusal is None:
                budget = min(budget, binding["maxBilledSeconds"] - 60)
            if not binding:
                if execute is not None or settings.bindings is not None:
                    refusal = refusal or "rerun_binding_unavailable"
                elif gpu and settings.target(module)[1]:
                    refusal = "rerun_binding_unavailable"
                elif gpu and fresh:
                    return await record(
                        spec, {"state": "not_run", "errorCode": "module_unbound"}
                    )

        if fresh and refusal:
            return outcome("needs_operator", refusal)
        status = await api.status(job_id)
        if fresh:
            if status["state"] not in ("submitting", "submit_unknown", "running"):
                return outcome("no_effect", "job_not_active")
            deadline = status["executionDeadline"]
            remaining = instant(deadline) - time() if deadline else 0
            reserve = 0 if parallel else hand_spec["resources"]["budgetSeconds"]
            if stage != "hand_pose" and remaining < budget + reserve:
                out_of_budget = True
                return await record(spec, {"state": "not_run", "errorCode": "budget"})
            if binding and not await controller.modal.check_function(binding, module):
                return outcome("needs_operator", "rerun_binding_unavailable")
            if reason := settings.module_refusal(stage, module):
                return await record(spec, {"state": "not_run", "errorCode": reason})

        def bootstrap(token):
            return make_bootstrap(controller, spec, digest, parallel, prior, token)

        worst = {
            **bootstrap("sa_svc_" + "x" * 43),
            "executionRef": "x" * 128,
            "executorKind": "modal",
        }
        if fresh and len(bootstrap_bytes(worst)) > MAX_BOOTSTRAP_BYTES:
            return await record(
                spec, {"state": "failed", "errorCode": "bootstrap_too_large"}
            )
        result = await controller.execute(
            status,
            ModalStage(stage, module, budget, bootstrap, node, binding, gpu, refusal),
        )
        if (
            result["outcome"] not in ("call_terminal", "child_exited")
            or result["evidence"] != "recorded"
        ):
            return result
        return await record(
            spec,
            settle(result.get("termination", "natural_exit"), result.get("receipt")),
            result["executionRef"],
            # Rerun preparation returns the database's immutable admission plan.
            result.get("spawnBinding") or (binding if execute is not None else None),
        )

    async def sequence(selected):
        for spec in selected:
            if stopped := await run_stage(spec):
                return stopped
        return None

    if not parallel:
        return finish(await sequence(specs))
    branches = await asyncio.gather(
        sequence(spec for spec in specs if spec["stage"] != "hand_pose"),
        run_stage(hand_spec),
        return_exceptions=True,
    )
    for branch in branches:
        if isinstance(branch, BaseException):
            raise branch
    if stopped := next((branch for branch in branches if branch), None):
        return finish(stopped)
    if not live():
        return finish(outcome("lease_lost", "lease_expired"))
    try:
        sealed = await api.act(job_id, "seal_parallel_recipe", owner=owner)
    except ApiRejection:
        sealed = {}
    if not sealed.get("recorded"):
        return finish(outcome("needs_operator", "recipe_seal_refused"))
    return finish()
