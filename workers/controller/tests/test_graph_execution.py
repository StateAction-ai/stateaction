"""The graph path keeps the exact submission fence across restart and cancellation."""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from time import time
from types import SimpleNamespace
from uuid import UUID

import pytest
from stateaction_controller import graph_controller, graph_local
from stateaction_controller.api import AmbiguousApiError
from stateaction_controller.graph_modal import GraphModalExecution
from stateaction_controller.journal import JournalStore, iso
from stateaction_controller.modal_controller import ModalStage

JOB = str(UUID(int=1))
NODE = "track_hands"
RUN = "render-run"
START, DEADLINE = "2026-11-27T12:00:00.000Z", "2026-11-27T13:00:00.000Z"
REF = "local-graph-original"
BOOT = str(UUID(int=2))


class Api:
    def __init__(self, cancel):
        self.cancel = cancel
        self.actions = []

    async def status(self, _):
        return {"state": "cancel_requested" if self.cancel else "running"}

    async def graph_action(self, job, action, **facts):
        assert (job, facts["nodeId"], facts["owner"]) == (JOB, NODE, "controller")
        self.actions.append(action)
        if action == "begin_node_submission":
            return {"state": "never_submitted" if self.cancel else "already_started"}
        raise AssertionError(f"Unexpected action {action}")


def setup(path, monkeypatch, *, cancel=False):
    monkeypatch.setattr(graph_local, "supports_threaded", lambda: True)
    monkeypatch.setattr(graph_local, "boot_id", lambda: BOOT)
    return SimpleNamespace(
        settings=SimpleNamespace(python="worker"),
        api=Api(cancel),
        store=JournalStore(path),
        lease=SimpleNamespace(live=lambda: True, owner="controller"),
        job_id=JOB,
        run_ref=RUN,
    )


def snapshot(state="outstanding", call=REF):
    return {"state": state, "executionRef": call, "binding": {}, "budgetSeconds": 60}


def journal(controller, phase):
    data = {
        "version": 1,
        "jobId": JOB,
        "stage": NODE,
        "runRef": RUN,
        "bootId": BOOT,
        "executionRef": REF,
        "phase": phase,
        "startDeadline": START,
        "executionDeadline": DEADLINE,
        "threadedPipeline": True,
    }
    if phase != "intent":
        data["budgetDeadline"] = DEADLINE
    if phase == "exited":
        data.update(
            exit={"code": 0, "signal": None},
            pid=101,
            pgid=101,
            sid=101,
            startTicks="100",
            pidNamespace="pid:[100]",
        )
    controller.store.write_local(data)


def run(controller, node):
    return asyncio.run(graph_local.run_local_node(controller, NODE, node, "1" * 64))


def test_pending_claim_cancelled_before_submitting(tmp_path, monkeypatch):
    controller = setup(tmp_path, monkeypatch, cancel=True)
    assert run(controller, snapshot("issued", None)) == {
        "outcome": "no_effect",
        "reason": "never_submitted",
    }
    assert controller.api.actions == ["begin_node_submission"]


def test_lost_submission_with_no_execution_identity_is_not_resent(
    tmp_path, monkeypatch
):
    controller = setup(tmp_path, monkeypatch)
    journal(controller, "spawning")
    assert (
        run(controller, snapshot("outstanding", None))["reason"]
        == "spawn_outcome_uncertain"
    )
    assert controller.api.actions == []


def test_restart_resumes_only_the_exact_journalled_child(tmp_path, monkeypatch):
    controller = setup(tmp_path, monkeypatch)
    journal(controller, "exited")

    async def adopt(current, record, stage, child, unknown, *, graph):
        assert current is controller and stage is None and child is None and graph
        assert record["executionRef"] == REF
        return {"outcome": "child_exited"}

    monkeypatch.setattr(graph_local, "supervise", adopt)
    assert (
        run(controller, snapshot(call="another-call"))["reason"]
        == "execution_ref_mismatch"
    )
    assert run(controller, snapshot())["outcome"] == "child_exited"
    assert controller.api.actions == []


NOW = datetime(2026, 11, 27, tzinfo=UTC).timestamp()
CALL = "fc-GraphNode"
MODULE = "hand_pose_cpu@1"


class ModalApi:
    def __init__(self, *, start_at=NOW + 10, submitted_at=NOW, lose_terminal_ack=False):
        self.job = {
            "state": "running",
            "executionBackend": "modal",
            "startDeadline": iso(start_at),
            "executionDeadline": iso(NOW + 90),
        }
        self.node = {
            "state": "pending",
            "callId": None,
            "startedAt": iso(submitted_at),
            "claimedAt": None,
        }
        self.actions = []
        self.lose_terminal_ack = lose_terminal_ack
        self.terminal_observed = None

    async def status(self, job):
        assert job == JOB
        return self.job.copy()

    async def graph(self, job):
        assert job == JOB
        return {"nodes": {NODE: self.node.copy()}}

    async def graph_action(self, job, action, **facts):
        assert (job, facts["nodeId"], facts["owner"]) == (JOB, NODE, "controller")
        self.actions.append((action, facts))
        if action == "issue_node_claim":
            assert self.node["state"] == "pending"
            self.node["state"] = "issued"
            return {**self.job, "state": "issued", "bootstrapToken": "fixture"}
        if action == "begin_node_submission":
            assert self.node["state"] == "issued"
            if self.job["state"] == "cancel_requested":
                return {"state": "never_submitted"}
            self.node["state"] = "outstanding"
            return {"state": "started"}
        if action == "record_node_call":
            self.node["callId"] = facts["executionRef"]
            return {"state": "recorded"}
        if action == "record_node_terminal":
            assert facts["executionRef"] == self.node["callId"]
            if self.terminal_observed is None:
                self.terminal_observed = facts["observed"]
                if self.lose_terminal_ack:
                    raise AmbiguousApiError(
                        "Terminal proof committed before reply loss"
                    )
            assert self.terminal_observed == facts["observed"]
            return {"state": "recorded"}
        raise AssertionError(f"Unexpected action {action}")


class ModalFixture:
    def __init__(self, api, *, lost=False, cancel_at_boundary=False):
        self.api = api
        self.lost = lost
        self.cancel_at_boundary = cancel_at_boundary
        self.accepted = 0
        self.polled = []
        self.cancelled = []
        self.returned_call = CALL
        self.receipt = None

    async def spawn(self, bootstrap, authorized, binding, *, before_submit):
        assert bootstrap["bootstrapToken"] == "fixture"
        assert authorized()
        if self.cancel_at_boundary:
            self.api.job["state"] = "cancel_requested"
        await before_submit()
        self.accepted += 1
        if self.lost:
            raise TimeoutError
        return CALL

    async def poll(self, call):
        self.polled.append(call)
        return {
            "kind": "returned",
            "value": {
                "schemaVersion": 3,
                "functionCallId": self.returned_call,
                "exitCode": 0 if self.receipt else 1,
                "receipt": self.receipt,
            },
        }

    async def cancel(self, call):
        self.cancelled.append(call)


async def modal_execution(path, api, modal, *, now=NOW, budget=15):
    async def sleep(seconds):
        nonlocal now
        now += seconds

    execution = GraphModalExecution(
        api,
        JournalStore(path),
        modal,
        JOB,
        RUN,
        "controller",
        lambda: True,
        "http://127.0.0.1:9",
        "graph",
        1,
        1,
        2,
        clock=lambda: now,
        sleep=sleep,
        stage=ModalStage(
            NODE,
            MODULE,
            budget,
            lambda token: {"bootstrapToken": token},
            node=api.node.copy(),
            binding={},
            graph=True,
        ),
    )
    return await execution.run(api.job.copy())


def modal_run(path, api, modal, **timing):
    return asyncio.run(modal_execution(path, api, modal, **timing))


def test_modal_graph_lost_ack_never_resubmits_after_restart(tmp_path):
    api = ModalApi()
    modal = ModalFixture(api, lost=True)
    assert modal_run(tmp_path, api, modal)["reason"] == "spawn_outcome_uncertain"
    assert modal_run(tmp_path, api, modal)["reason"] == "spawn_outcome_uncertain"
    assert modal.accepted == 1
    assert not modal.polled and not modal.cancelled
    assert [action for action, _ in api.actions] == [
        "issue_node_claim",
        "begin_node_submission",
    ]


def fixture_graph(kind, recipe="cpu_hand_canary"):
    repo = Path(__file__).resolve().parents[3]
    graph = json.loads((repo / "recipes/compiled" / f"{recipe}.json").read_text())
    return {
        "graph": graph,
        "task": {"kind": kind, "recipeSha256": graph["recipeSha256"]},
    }


def test_live_graph_recovers_lost_terminal_and_verification_replies(
    tmp_path, monkeypatch
):
    api = ModalApi(lose_terminal_ack=True)
    modal = ModalFixture(api)
    modal.receipt = {"receipt": "{}", "files": []}
    requests = []
    admission = JOB
    graph_action = api.graph_action
    graph = fixture_graph("clip_pipeline")

    async def control(job_id, action, **facts):
        nonlocal admission
        if action == "prepare_graph":
            return {"state": "regular"}
        if action == "record_node_result":
            assert api.terminal_observed is not None
            requests.append(facts)
            if len(requests) == 1:
                raise AmbiguousApiError("File digest committed before reply loss")
            if len(requests) == 2:
                return {"state": "verifying"}
            api.node["state"] = "succeeded"
        elif action == "seal_graph":
            assert api.node["state"] == "succeeded"
            admission = None
        else:
            return await graph_action(job_id, action, **facts)
        return {"state": "recorded"}

    async def snapshot(job_id):
        assert job_id == JOB
        return {
            **graph,
            "nodes": {
                NODE: {
                    **api.node,
                    "executionRef": api.node["callId"],
                    "budgetSeconds": 15,
                    "verifiedOutputs": [],
                }
            },
            "parentNodes": {
                "source_span": {
                    "state": "succeeded",
                    "verifiedOutputs": [
                        {"port": "plan", "artifactType": "clip_plan@1"},
                    ],
                }
            },
        }

    async def run_node(_controller, node_id, _node, _graph):
        assert node_id == NODE
        return await modal_execution(tmp_path, api, modal)

    api.graph_action = control
    api.graph = snapshot
    monkeypatch.setattr(graph_controller, "run_modal_node", run_node)
    monkeypatch.setattr(graph_controller, "time", lambda: NOW)
    controller = SimpleNamespace(
        job_id=JOB,
        api=api,
        lease=SimpleNamespace(live=lambda: True, owner="controller"),
        settings=SimpleNamespace(backend="modal", poll=0.01),
    )
    assert asyncio.run(graph_controller.run_graph(controller, graph)) == {
        "outcome": "sealed"
    }
    assert admission is None
    assert requests == [requests[0]] * 3
    assert requests[0]["state"] == "succeeded"
    assert modal.accepted == 1
    assert modal.polled == [CALL]
    assert [action for action, _ in api.actions].count("record_node_terminal") == 2


@pytest.mark.parametrize("lost_read", ["graph", "status"])
def test_lost_control_read_keeps_the_gpu_sibling_supervised(lost_read, monkeypatch):
    document = {
        **fixture_graph("clip_pipeline", "indego_hosted_canary"),
        "nodes": {
            node_id: {"state": state, "executionRef": ref, "verifiedOutputs": []}
            for node_id, state, ref in (
                ("hand_pose", "outstanding", "fc-Hands"),
                ("segment", "outstanding", CALL),
                ("caption", "pending", None),
            )
        },
        "parentNodes": {},
    }
    nodes = document["nodes"]
    gpu_started = asyncio.Event()
    reply_lost = asyncio.Event()
    supervised = []

    def maybe_lose(name):
        if (
            name == lost_read
            and nodes["hand_pose"]["state"] == "failed"
            and not reply_lost.is_set()
        ):
            reply_lost.set()
            raise AmbiguousApiError("One control read was interrupted")

    async def graph(_job_id):
        maybe_lose("graph")
        return document

    async def status(_job_id):
        maybe_lose("status")
        return {"state": "running", "executionDeadline": iso(time() + 3600)}

    async def control(_job_id, action, **facts):
        if action == "prepare_graph":
            return {"state": "regular"}
        if action == "seal_graph":
            assert all(
                node["state"] in graph_controller.SETTLED for node in nodes.values()
            )
        else:
            assert action == "record_node_result"
            nodes[facts["nodeId"]]["state"] = facts["state"]
        return {"state": "recorded"}

    async def run_node(_controller, node_id, _node, _graph):
        if node_id == "segment":
            supervised.append("started")
            gpu_started.set()
            await reply_lost.wait()
            supervised.append("terminal")
        else:
            assert node_id == "hand_pose"
            await gpu_started.wait()
        return {
            "outcome": "call_terminal",
            "evidence": "recorded",
            "termination": "natural_exit",
            "result": {"exitCode": 1},
            "receipt": None,
        }

    controller = SimpleNamespace(
        job_id=JOB,
        api=SimpleNamespace(graph=graph, status=status, graph_action=control),
        lease=SimpleNamespace(live=lambda: True, owner="controller"),
        settings=SimpleNamespace(backend="modal", poll=0.01),
    )
    monkeypatch.setattr(graph_controller, "run_modal_node", run_node)
    assert asyncio.run(graph_controller.run_graph(controller, document)) == {
        "outcome": "sealed"
    }
    assert supervised == ["started", "terminal"]
    assert nodes["caption"]["state"] == "skipped"


@pytest.mark.parametrize("unresolved", [False, True])
def test_graph_recovery_only_skips_after_outstanding_unknown_submit_settles(
    unresolved, monkeypatch
):
    video = {"state": "pending", "verifiedOutputs": []}
    document = {
        **fixture_graph("clip_plan"),
        "nodes": {
            "source_span": {
                "state": "outstanding" if unresolved else "failed",
                "executionRef": None,
                "verifiedOutputs": [],
            },
            "original_video": video,
        },
        "parentNodes": {},
    }
    actions = []

    async def graph_run(job_id):
        assert job_id == JOB
        return document

    async def status(job_id):
        assert job_id == JOB
        return {"state": "submit_unknown", "executionDeadline": iso(time() + 3600)}

    async def action(job_id, name, **facts):
        assert (job_id, facts["owner"]) == (JOB, "controller")
        actions.append(name)
        if name == "record_node_result":
            assert facts == {
                "owner": "controller",
                "nodeId": "original_video",
                "state": "skipped",
                "errorCode": "submission_unconfirmed",
                "receipt": None,
                "files": [],
            }
            video["state"] = "skipped"
        else:
            assert name == "seal_graph"
        return {"state": "recorded"}

    controller = SimpleNamespace(
        job_id=JOB,
        lease=SimpleNamespace(live=lambda: True, owner="controller"),
        api=SimpleNamespace(graph=graph_run, status=status, graph_action=action),
        settings=SimpleNamespace(backend="modal"),
    )

    async def unresolved_call(_controller, node_id, _node, _graph):
        assert node_id == "source_span"
        return {"outcome": "needs_operator", "reason": "spawn_outcome_uncertain"}

    monkeypatch.setattr(graph_controller, "run_modal_node", unresolved_call)
    result = asyncio.run(graph_controller.run_graph(controller, document))
    if unresolved:
        assert result == {
            "outcome": "needs_operator",
            "reason": "spawn_outcome_uncertain",
        }
        assert actions == []
        assert video["state"] == "pending"
    else:
        assert result == {"outcome": "sealed"}
        assert actions == ["record_node_result", "seal_graph"]


def test_modal_graph_cancellation_at_submission_boundary_never_sends(tmp_path):
    api = ModalApi()
    modal = ModalFixture(api, cancel_at_boundary=True)
    assert modal_run(tmp_path, api, modal)["reason"] == "never_submitted"
    assert modal.accepted == 0
    assert not modal.polled and not modal.cancelled
    assert [action for action, _ in api.actions] == [
        "issue_node_claim",
        "begin_node_submission",
    ]


def test_modal_graph_adopts_exact_call_with_original_node_budget(tmp_path):
    api = ModalApi()
    api.node.update(state="outstanding", callId=CALL, claimedAt=iso(NOW + 1))
    modal = ModalFixture(api)
    modal.returned_call = "fc-AnotherNode"
    refused = modal_run(tmp_path, api, modal, now=NOW + 20)
    assert refused["reason"] == "call_not_provably_terminal_after_cancel"
    assert modal.cancelled == [CALL]
    assert api.actions == []
    modal.returned_call = CALL
    settled = modal_run(tmp_path, api, modal, now=NOW + 30)
    assert settled["evidence"] == "recorded"
    assert settled["termination"] == "budget_exceeded"
    assert modal.accepted == 0 and set(modal.polled) == {CALL}
    assert [action for action, _ in api.actions] == ["record_node_terminal"]


def test_other_node_running_does_not_extend_graph_start_deadline(tmp_path):
    api = ModalApi(start_at=NOW + 5)
    api.node.update(state="outstanding", callId=CALL)
    modal = ModalFixture(api)
    outcome = modal_run(tmp_path, api, modal, now=NOW + 6)
    assert outcome["evidence"] == "recorded"
    assert outcome["termination"] == "start_deadline"
    assert modal.cancelled == [CALL] and modal.accepted == 0
