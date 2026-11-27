import asyncio
from contextlib import suppress
from pathlib import Path
from time import time

from stateaction_contracts.recipe_graph import (
    MODULES,
    NodeState,
    VerifiedGraph,
    VerifiedPort,
    read_json,
)

from .api import AmbiguousApiError, ApiRejection, reconcile_graph_request
from .graph_local import run_local_node
from .graph_modal import run_modal_node
from .journal import instant
from .modal_controller import API_ERRORS, outcome

SETTLED = {"succeeded", "failed", "cancelled", "skipped"}


def verify(snapshot):
    repo = Path(__file__).resolve().parents[4]
    return VerifiedGraph(
        snapshot["graph"],
        snapshot["task"]["recipeSha256"],
        read_json(
            repo / "packages/contracts/recipe/compiled-graph.v1.schema.json", 524288
        ),
        {
            ref: read_json(
                repo / "modules" / ref.split("@")[0] / "module.lock.json", 524288
            )
            for ref in MODULES
        },
    )


def state_snapshot(document):
    states = {}
    for node_id, node in (document["parentNodes"] | document["nodes"]).items():
        ports = {}
        for file in node["verifiedOutputs"]:
            key = file["port"]
            if key not in ports:
                ports[key] = VerifiedPort(file["artifactType"], [])
            ports[key].value.append(file)
        status = node["state"]
        if status in ("issued", "outstanding"):
            status = "outstanding" if node["executionRef"] else "unknown"
        if status == "cancelled":
            status = "failed"
        states[node_id] = NodeState(status, ports)
    return states


async def run_graph(controller, document):
    api, lease = controller.api, controller.lease
    job_id = controller.job_id
    graph = verify(document)
    scope = "recording" if document["task"]["kind"] == "clip_plan" else "clip"
    builtin = (
        {"recording.source": VerifiedPort("recording_source@2", None)}
        if scope == "recording"
        else {"clip.video": VerifiedPort("video_range@1", None)}
    )
    active = {}
    stopped = None
    prepared = False

    def pause():
        return asyncio.sleep(max(0.5, controller.settings.poll))

    async def read_activity():
        current = await api.graph(job_id)
        return current, await api.status(job_id) if current is not None else None

    async def record(node_id, state, code=None, *, result=None):
        def write():
            return api.graph_action(
                job_id,
                "record_node_result",
                owner=lease.owner,
                nodeId=node_id,
                state=state,
                errorCode=code,
                receipt=result["receipt"] if result else None,
                files=result["files"] if result else [],
            )

        async def settled():
            current = await api.graph(job_id)
            return current is not None and current["nodes"][node_id]["state"] in SETTLED

        while lease.live():
            reply = await reconcile_graph_request(
                write, lease.live, pause, observed=settled
            )
            if reply["state"] != "verifying":
                return
            await pause()

    async def run_node(node_id, node):
        if controller.settings.backend == "local":
            result = await run_local_node(controller, node_id, node, graph.sha256)
            completed = "child_exited"
        else:
            result = await run_modal_node(controller, node_id, node, graph)
            completed = "call_terminal"
        if result["outcome"] == "no_effect" and result["reason"] == "never_submitted":
            return None
        if result["outcome"] != completed or result["evidence"] != "recorded":
            return result
        exit_code = (
            result["exit"]["code"]
            if completed == "child_exited"
            else result["result"]["exitCode"]
        )
        if result["termination"] == "cancel_requested":
            await record(node_id, "cancelled", "cancel_requested")
        elif result["termination"] != "natural_exit":
            await record(node_id, "failed", result["termination"])
        elif result["receipt"] and exit_code in (0, None):
            await record(node_id, "succeeded", result=result["receipt"])
        else:
            await record(node_id, "failed", "node_receipt_unavailable")
        return None

    try:
        while lease.live():
            try:
                document, status = await reconcile_graph_request(
                    read_activity, lease.live, pause
                )
            except AmbiguousApiError:
                if not lease.live():
                    return outcome("lease_lost", "lease_expired")
                return outcome("needs_operator", "graph_control_unconfirmed")
            if document is None:
                return outcome("needs_operator", "graph_snapshot_unavailable")
            nodes = document["nodes"]
            state = status["state"]
            deadline = instant(status["executionDeadline"])
            dispatch_block = {
                "cancel_requested": "cancel_requested",
                "submit_unknown": "submission_unconfirmed",
                "needs_attention": "execution_needs_attention",
            }.get(state)
            if dispatch_block is None and time() >= deadline:
                dispatch_block = "execution_deadline"
            if not prepared and not dispatch_block:
                preparation = await reconcile_graph_request(
                    lambda: api.graph_action(
                        job_id, "prepare_graph", owner=lease.owner
                    ),
                    lease.live,
                    pause,
                )
                if preparation["state"] == "copying":
                    await asyncio.sleep(controller.settings.poll)
                    continue
                if preparation["state"] == "failed":
                    return outcome("no_effect", "retained_outputs_unavailable")
                prepared = True
                if preparation["state"] == "ready":
                    continue
            if all(node["state"] in SETTLED for node in nodes.values()):
                await reconcile_graph_request(
                    lambda: api.graph_action(job_id, "seal_graph", owner=lease.owner),
                    lease.live,
                    pause,
                )
                return {"outcome": "sealed"}
            if not stopped:
                for node_id, node in nodes.items():
                    if (
                        node["state"] == "outstanding"
                        or (node["state"] == "issued" and not dispatch_block)
                    ) and node_id not in active:
                        active[node_id] = asyncio.create_task(run_node(node_id, node))
            states = state_snapshot(document)
            for node_id in active:
                if states[node_id].status == "pending":
                    states[node_id] = NodeState("outstanding")
            changed = False
            if dispatch_block and not active:
                if dispatch_block == "submission_unconfirmed" and any(
                    node["state"] == "outstanding" for node in nodes.values()
                ):
                    return stopped or outcome(
                        "needs_operator", "submission_unconfirmed"
                    )
                for node_id, node in nodes.items():
                    if node["state"] in ("pending", "issued"):
                        await record(node_id, "skipped", dispatch_block)
                        changed = True
            elif not dispatch_block and not stopped:
                while decision := graph.next(scope, states, builtin, set(nodes)):
                    node_id = decision.node_id
                    if decision.action == "ready":
                        if time() + nodes[node_id]["budgetSeconds"] >= deadline:
                            await record(node_id, "skipped", "execution_deadline")
                            states[node_id] = NodeState("skipped")
                            changed = True
                            continue
                        active[node_id] = asyncio.create_task(
                            run_node(node_id, nodes[node_id])
                        )
                        states[node_id] = NodeState("outstanding")
                    else:
                        await record(node_id, "skipped", decision.reason.split(":")[0])
                        states[node_id] = NodeState("skipped")
                        changed = True
            if not active:
                if changed:
                    continue
                return stopped or outcome("needs_operator", "unsettled_graph")
            done, _ = await asyncio.wait(
                active.values(), return_when=asyncio.FIRST_COMPLETED
            )
            for node_id, future in list(active.items()):
                if future in done:
                    del active[node_id]
                    try:
                        stopped = future.result() or stopped
                    except ApiRejection as error:
                        stopped = outcome(
                            "needs_operator", "node_control_rejected", code=error.code
                        )
                    except API_ERRORS:
                        stopped = outcome("needs_operator", "node_control_unconfirmed")
        return outcome("lease_lost", "lease_expired")
    finally:
        for task in active.values():
            task.cancel()
        with suppress(asyncio.CancelledError):
            await asyncio.gather(*active.values(), return_exceptions=True)
