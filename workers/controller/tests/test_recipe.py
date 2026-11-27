import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from stateaction_contracts import request_sha256
from stateaction_controller.api import ApiRejection
from stateaction_controller.config import Settings
from stateaction_controller.journal import JournalStore, iso
from stateaction_controller.recipe import run_recipe
from test_modal_controller import JOB, NOW

FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "packages/contracts/conformance/fixtures/contracts"
)
OUTPUT = {"role": "segments_json", "fileId": "fixture-file", "sha256": "a" * 64}


class Scenario:
    def __init__(self, tmp_path, *, parallel=False, deadline=10000, errors=None):
        fixture = json.loads((FIXTURES / "jobs.recipe.v1.json").read_bytes())
        self.recipe = fixture["cases"][1]["input"]["document"]
        self.settings = Settings("local", "http://127.0.0.1:3000", tmp_path)
        self.api = self
        self.modal = None
        self.store = JournalStore(tmp_path)
        self.lease = SimpleNamespace(owner="test-owner", live=lambda: True)
        self.job_id = JOB
        self.events = []
        self.rows = {}
        self.parallel = parallel
        self.deadline = deadline
        self.errors = errors or {}
        self.bootstrap = {}
        self.sealed = False

    async def dag(self, job_id):
        assert job_id == JOB
        return {"recipeSha256": request_sha256(self.recipe), "stages": []}

    async def status(self, job_id):
        assert job_id == JOB
        return {"state": "running", "executionDeadline": iso(NOW + self.deadline)}

    async def act(self, job_id, action, **facts):
        assert job_id == JOB and facts["owner"] == self.lease.owner
        if action == "start_parallel_recipe":
            return {"recorded": self.parallel}
        if action == "seal_parallel_recipe":
            assert set(self.rows) == {"segment", "caption", "hand_pose"}
            self.sealed = True
            return {"recorded": True}
        assert action == "record_stage_run"
        if "receipt" in facts and self.errors.get(facts["stage"]) == "reject":
            raise ApiRejection(409, "receipt_mismatch")
        self.rows[facts["stage"]] = facts
        return {"recorded": True}

    async def prepare_rerun(self, job_id, owner):
        return {"state": "regular"}

    async def prior_stages(self, job_id):
        return {
            "stages": [
                {
                    "stage": stage,
                    "state": row["state"],
                    "errorCode": row.get("errorCode"),
                    "outputs": row.get("receipt", {}).get("outputs", []),
                    "counts": row.get("receipt", {}).get("counts", {}),
                }
                for stage, row in self.rows.items()
            ],
        }

    async def execute(self, status, spec):
        name = spec.stage
        self.events.append(name)
        self.bootstrap[name] = spec.bootstrap("fixture-token")
        error = self.errors.get(name)
        if error == "uncertain":
            return {"outcome": "submit_unknown", "reason": "spawn_outcome_uncertain"}
        result = {
            "outcome": "child_exited",
            "evidence": "recorded",
            "executionRef": f"local-{name}",
            "receipt": {"status": "succeeded", "counts": {}, "outputs": []},
        }
        if name == "segment":
            count = 0 if error == "zero" else 2
            result["receipt"].update(counts={"segments": count}, outputs=[OUTPUT])
        if error == "receipt_missing":
            result["receipt"] = None
        if error == "window_failed":
            result["receipt"]["counts"]["failed_windows"] = 1
        if error == "engine_timeout":
            result["receipt"] = {"status": "failed", "errorCode": error}
        if error == "budget_exceeded":
            result["termination"] = error
        return result

    def run(self):
        return asyncio.run(run_recipe(self, self.recipe, {"kind": "process_recording"}))


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr("stateaction_controller.recipe.time", lambda: NOW)


@pytest.mark.parametrize(
    ("problem", "spawns", "result"),
    [
        (
            {},
            ["segment", "caption", "hand_pose"],
            ("succeeded", "succeeded", "succeeded"),
        ),
        (
            {"segment": "window_failed"},
            ["segment", "caption", "hand_pose"],
            ("succeeded", "succeeded", "succeeded"),
        ),
        (
            {"caption": "engine_timeout"},
            ["segment", "caption", "hand_pose"],
            ("succeeded", "failed", "succeeded"),
        ),
        (
            {"segment": "zero"},
            ["segment", "hand_pose"],
            ("succeeded", "not_run", "succeeded"),
        ),
        (
            {"segment": "engine_timeout"},
            ["segment", "hand_pose"],
            ("failed", "not_run", "succeeded"),
        ),
        (
            {"segment": "reject"},
            ["segment", "hand_pose"],
            ("failed", "not_run", "succeeded"),
        ),
        (
            {"segment": "receipt_missing"},
            ["segment", "hand_pose"],
            ("failed", "not_run", "succeeded"),
        ),
    ],
)
def test_recipe_settles_only_what_each_stage_proves(tmp_path, problem, spawns, result):
    scenario = Scenario(tmp_path, errors=problem)
    decision = scenario.run()
    assert "stopped" not in decision
    assert scenario.events == spawns
    assert tuple(row["state"] for row in decision["stages"]) == result
    captured = scenario.rows
    if problem.get("segment") == "reject":
        assert captured["segment"]["errorCode"] == "receipt_rejected"
        assert "receipt" not in captured["segment"]
    if problem.get("segment") == "receipt_missing":
        assert captured["segment"]["errorCode"] == "receipt_missing"
    if problem.get("segment") == "zero":
        assert captured["caption"]["errorCode"] == "no_segments"
    if captured["segment"]["state"] == "failed":
        assert captured["caption"]["errorCode"] == "upstream_failed"
    if problem.get("caption") == "engine_timeout":
        assert captured["caption"]["errorCode"] == "engine_timeout"


def test_disabled_stage_is_recorded_without_execution(tmp_path):
    scenario = Scenario(tmp_path)
    scenario.recipe["stages"][1]["enabled"] = False
    scenario.run()
    assert scenario.events == ["segment", "hand_pose"]
    assert scenario.rows["caption"]["state"] == "not_run"
    assert scenario.rows["caption"]["errorCode"] == "stage_disabled"


@pytest.mark.parametrize("deadline", [10, 65])
def test_serial_stage_leaves_budget_for_sealing(tmp_path, deadline):
    scenario = Scenario(tmp_path, deadline=deadline)
    scenario.run()
    assert scenario.events == ["hand_pose"]
    for stage in ("segment", "caption"):
        assert scenario.rows[stage]["state"] == "not_run"
        assert scenario.rows[stage]["errorCode"] == "budget"


def test_stage_bootstrap_carries_digest_and_exact_segments(tmp_path):
    scenario = Scenario(tmp_path)
    scenario.run()
    digest = request_sha256(scenario.recipe)
    for stage in ("segment", "caption"):
        bootstrap = scenario.bootstrap[stage]
        assert bootstrap["schemaVersion"] == 2
        assert bootstrap["stage"] == stage
        assert bootstrap["bootstrapToken"] == "fixture-token"
        assert bootstrap["recipeSha256"] == digest
    assert scenario.bootstrap["caption"]["segmentsFileId"] == OUTPUT["fileId"]
    assert scenario.bootstrap["caption"]["segmentsSha256"] == OUTPUT["sha256"]


def test_parallel_sibling_settles_but_uncertain_stage_prevents_seal(tmp_path):
    scenario = Scenario(tmp_path, parallel=True, errors={"segment": "uncertain"})
    decision = scenario.run()
    assert decision["stopped"]["outcome"] == "submit_unknown"
    assert scenario.rows["hand_pose"]["state"] == "succeeded"
    assert "caption" not in scenario.events
    assert not scenario.sealed


def test_oversized_sealing_bootstrap_is_failed_before_spawn(tmp_path):
    scenario = Scenario(tmp_path)
    original = scenario.execute

    async def spawn(status, stage):
        result = await original(status, stage)
        if stage.stage == "segment":
            result["receipt"]["outputs"] += [
                {
                    "role": "diagnostic_blob",
                    "fileId": f"fixture-{i}",
                    "sha256": "d" * 64,
                    "sizeBytes": "1",
                }
                for i in range(80)
            ]
        return result

    scenario.execute = spawn
    assert "stopped" not in scenario.run()
    assert scenario.events == ["segment", "caption"]
    assert scenario.rows["hand_pose"]["state"] == "failed"
    assert scenario.rows["hand_pose"]["errorCode"] == "bootstrap_too_large"
    assert "callId" not in scenario.rows["hand_pose"]


def test_parallel_seal_waits_for_caption_and_earlier_hand_pose(tmp_path):
    scenario = Scenario(tmp_path, parallel=True)
    original = scenario.execute
    hand_done = asyncio.Event()

    async def spawn(status, stage):
        if stage.stage == "caption":
            await hand_done.wait()
            assert scenario.rows["hand_pose"]["state"] == "succeeded"
            assert not scenario.sealed
        return await original(status, stage)

    act = scenario.act

    async def record(job, action, **fields):
        result = await act(job, action, **fields)
        if action == "record_stage_run" and fields["stage"] == "hand_pose":
            hand_done.set()
        return result

    scenario.execute, scenario.act = spawn, record
    assert "stopped" not in scenario.run()
    assert scenario.events.index("hand_pose") < scenario.events.index("caption")
    assert scenario.sealed


def hosted_scenario(tmp_path):
    scenario = Scenario(tmp_path)
    segment = scenario.recipe["stages"][0]
    segment["module"] = "flora_tempseg_vllm_fp8@1"
    segment["resources"]["gpu"] = "RTX-PRO-6000"
    scenario.recipe["stages"][1]["enabled"] = False
    binding = {
        "appName": "bound-app",
        "codeRevision": "a" * 40,
        "environment": "test",
        "functionId": "fu-Exact",
        "definitionId": "def-exact",
        "definitionSha256": "b" * 64,
        "paramsSha256": request_sha256(segment["params"]),
        "gpu": segment["resources"]["gpu"],
        "maxContainers": 1,
        "maxBilledSeconds": 120,
    }
    hand = {
        **binding,
        "gpu": "none",
        "paramsSha256": request_sha256({}),
    }
    scenario.settings = Settings(
        "modal",
        "https://example.test",
        tmp_path,
        timeout=5,
        poll=2,
        function="hand",
        targets={segment["module"]: ("bound-app", "segment")},
        bindings={segment["module"]: binding, "hand_pose_cpu_v1@1": hand},
    )

    async def check_binding(_binding, _module):
        return True

    scenario.modal = SimpleNamespace(check_function=check_binding, watch=lambda *_: [])
    return scenario, binding


def test_gpu_stage_requires_watchdog_before_claim(tmp_path):
    scenario, _ = hosted_scenario(tmp_path)
    del scenario.modal.watch
    assert scenario.run()["stopped"]["reason"] == "rerun_binding_unavailable"
    assert not scenario.events and not scenario.rows


@pytest.mark.parametrize("changed", [False, True])
def test_bound_stage_catalog_records_original_receipt_digest(tmp_path, changed):
    scenario, binding = hosted_scenario(tmp_path)
    original = scenario.execute
    receipts = {}
    spawn_binding = dict(binding)
    if changed:
        binding["definitionSha256"] = "e" * 64

    async def execute(status, stage):
        result = await original(status, stage)
        receipts[stage.stage] = result["receipt"]
        result["outcome"] = "call_terminal"
        result["executionRef"] = "fc-" + stage.stage.replace("_", "")
        result["spawnBinding"] = spawn_binding if stage.stage == "segment" else None
        return result

    scenario.execute = execute
    assert "stopped" not in scenario.run()
    persisted = scenario.rows["segment"]["receipt"]
    assert persisted["schemaVersion"] == 2
    provider = persisted["providerBinding"]
    assert provider == {
        **{
            key: spawn_binding[key]
            for key in (
                "appName",
                "codeRevision",
                "environment",
                "functionId",
                "definitionId",
                "paramsSha256",
                "definitionSha256",
            )
        },
        "workerReceiptSha256": request_sha256(receipts["segment"]),
    }
    assert "providerBinding" not in receipts["segment"]


@pytest.mark.parametrize("problem", ["missing", "gpu", "stale"])
def test_clip_hand_pose_binding_is_required_before_claim(tmp_path, problem):
    scenario, _ = hosted_scenario(tmp_path)
    scenario.recipe["stages"][0]["enabled"] = False
    binding = scenario.settings.bindings["hand_pose_cpu_v1@1"]
    if problem == "missing":
        del scenario.settings.bindings["hand_pose_cpu_v1@1"]
    elif problem == "gpu":
        binding["gpu"] = "RTX-PRO-6000"
    else:
        binding["codeRevision"] = "b" * 40
    result = asyncio.run(
        run_recipe(
            scenario,
            scenario.recipe,
            {"kind": "clip_pipeline", "codeRevision": "a" * 40},
        )
    )
    assert result["stopped"]["reason"] == "clip_hand_pose_binding_unavailable"
    assert "hand_pose" not in scenario.rows and not scenario.events


def test_unbound_gpu_is_not_run_before_claim_and_hand_pose_runs(tmp_path):
    from dataclasses import replace

    scenario, _ = hosted_scenario(tmp_path)
    scenario.settings = replace(scenario.settings, targets={}, bindings=None)
    result = scenario.run()
    assert "stopped" not in result
    assert scenario.events == ["hand_pose"]
    assert scenario.rows["segment"]["state"] == "not_run"
    assert scenario.rows["segment"]["errorCode"] == "module_unbound"
    assert "callId" not in scenario.rows["segment"]


def test_local_only_stubs_are_refused_in_modal(tmp_path):
    scenario = Scenario(tmp_path)
    scenario.settings = Settings(
        "modal", "https://example.test", tmp_path, app="cpu", function="process"
    )
    scenario.modal = SimpleNamespace()
    assert "stopped" not in scenario.run()
    assert scenario.events == ["hand_pose"]
    assert scenario.rows["segment"]["errorCode"] == "module_local_only"
    assert "callId" not in scenario.rows["segment"]


def test_gpu_target_without_verified_binding_needs_operator_before_claim(tmp_path):
    from dataclasses import replace

    scenario, _ = hosted_scenario(tmp_path)
    scenario.settings = replace(scenario.settings, bindings=None)
    result = scenario.run()
    assert result["stopped"]["reason"] == "rerun_binding_unavailable"
    assert scenario.events == [] and scenario.rows == {}


def test_clip_hand_pose_with_missing_binding_allows_exact_journal_reconciliation(
    tmp_path,
):
    scenario, _ = hosted_scenario(tmp_path)
    for item in scenario.recipe["stages"][:2]:
        item["enabled"] = False
    del scenario.settings.bindings["hand_pose_cpu_v1@1"]
    scenario.store.write_modal(
        {
            "version": 1,
            "executor": "modal",
            "jobId": JOB,
            "stage": "hand_pose",
            "runRef": "original-run",
            "phase": "submitted",
            "startDeadline": iso(NOW + 10),
            "executionDeadline": iso(NOW + 60),
            "callId": "fc-ExactCall",
        },
        "hand_pose_cpu_v1@1",
    )

    async def recover(status, spec):
        assert spec.stage == "hand_pose" and spec.node is None
        assert spec.refusal == "clip_hand_pose_binding_unavailable"
        assert spec.binding is None
        journal = scenario.store.read_modal(JOB, spec.stage, spec.module)
        return {
            "outcome": "call_terminal",
            "evidence": "recorded",
            "executionRef": journal["callId"],
            "termination": "natural_exit",
            "receipt": {"schemaVersion": 1, "status": "succeeded"},
        }

    scenario.execute = recover
    result = asyncio.run(
        run_recipe(
            scenario,
            scenario.recipe,
            {"kind": "clip_pipeline", "codeRevision": "a" * 40},
        )
    )
    assert "stopped" not in result
    assert scenario.rows["hand_pose"]["callId"] == "fc-ExactCall"
    assert scenario.rows["hand_pose"]["state"] == "succeeded"


def test_adopted_hosted_rerun_receipt_uses_immutable_plan_without_local_ack(tmp_path):
    scenario, binding = hosted_scenario(tmp_path)
    scenario.parallel = True
    scenario.recipe["stages"][2]["enabled"] = False

    async def prepare(job_id, owner):
        assert job_id == scenario.job_id and owner == scenario.lease.owner
        return {
            "state": "ready",
            "execute": ["segment"],
            "functions": {"segment": binding},
        }

    async def dag(job_id):
        return {
            "recipeSha256": request_sha256(scenario.recipe),
            "stages": [
                {
                    "stage": "segment",
                    "state": "running",
                    "module": scenario.recipe["stages"][0]["module"],
                    "callId": "fc-Original",
                }
            ],
        }

    async def recover(status, spec):
        assert spec.binding == binding
        assert spec.node["callId"] == "fc-Original"
        return {
            "outcome": "call_terminal",
            "evidence": "recorded",
            "executionRef": "fc-Original",
            "receipt": {"schemaVersion": 1, "status": "succeeded"},
        }

    original_act = scenario.act

    async def act(job_id, action, **facts):
        if action == "seal_parallel_recipe":
            assert list(scenario.rows) == ["segment"]
            return {"recorded": True}
        return await original_act(job_id, action, **facts)

    scenario.prepare_rerun, scenario.dag = prepare, dag
    scenario.execute, scenario.act = recover, act
    assert "stopped" not in scenario.run()
    row = scenario.rows["segment"]
    assert row["state"] == "succeeded"
    assert row["callId"] == "fc-Original"
    assert row["receipt"]["schemaVersion"] == 2
    assert (
        row["receipt"]["providerBinding"]["definitionSha256"]
        == binding["definitionSha256"]
    )
