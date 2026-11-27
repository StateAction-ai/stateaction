import asyncio

import pytest
from stateaction_controller.api import ApiRejection
from stateaction_controller.journal import JournalStore, iso
from stateaction_controller.modal_controller import ModalExecution, ModalStage
from test_modal_controller import CALL, JOB, NOW, Api, Clock

CATALOG = "fc-CatalogCall"


class StageApi(Api):
    def __init__(self):
        super().__init__()
        self.reject_record = False

    async def act(self, job_id, action, **body):
        assert job_id == JOB
        self.actions.append((action, body))
        if action == "issue_stage_claim":
            return {**self.job, "state": "recorded", "bootstrapToken": "local-test"}
        if (
            action == "record_stage_run"
            and body["state"] == "running"
            and self.reject_record
        ):
            raise ApiRejection(409, "conflict")
        return {}


class Provider:
    def __init__(self, store):
        self.store = store
        self.spawns = []
        self.polled = []
        self.cancelled = []
        self.watched = []
        self.watch_result = []
        self.cancel_error = False
        self.poll_error = False
        self.spawn_error = False
        self.terminal = True

    async def spawn(self, value, authorized, _binding):
        stage = value["stage"]
        assert authorized()
        assert self.store.read_modal(JOB, stage, value["module"])["phase"] == "spawning"
        self.spawns.append(stage)
        if self.spawn_error:
            raise TimeoutError()
        return CALL

    async def check_function(self, _binding, _module):
        return True

    async def watch(self, call_id, binding):
        self.watched.append((call_id, binding["functionId"]))
        if isinstance(self.watch_result, Exception):
            raise self.watch_result
        return self.watch_result

    async def cancel(self, call_id):
        self.cancelled.append(call_id)
        if self.cancel_error:
            raise TimeoutError()

    async def poll(self, call_id):
        self.polled.append(call_id)
        if self.poll_error:
            raise RuntimeError("Injected supervisor failure")
        if self.terminal:
            return {
                "kind": "returned",
                "value": {
                    "schemaVersion": 2,
                    "functionCallId": call_id,
                    "exitCode": 1,
                    "receipt": None,
                },
            }
        return {"kind": "pending"}


def scope(store, api, provider, *, node=None, name="segment", clock=None):
    clock = clock or Clock()
    module = "flora_tempseg_vllm_fp8@1"
    stage = ModalStage(
        name,
        module,
        3,
        lambda token: {"stage": name, "module": module, "bootstrapToken": token},
        node=node,
        binding={"functionId": "fu-Verified"},
        gpu=True,
    )
    ctl = ModalExecution(
        api,
        store,
        provider,
        JOB,
        "test-run",
        "owner",
        lambda: True,
        "https://example.test",
        "hand_pose_cpu_v1",
        1,
        1,
        2,
        stage=stage,
        clock=clock,
        sleep=clock.sleep,
    )
    return ctl


def run(ctl):
    async def execute():
        return await ctl.run(await ctl.api.status(JOB))

    return asyncio.run(execute())


@pytest.mark.parametrize(
    ("watch", "reason"),
    [
        (["ci-First", "ci-Second"], "provider_container_restarted"),
        (TimeoutError(), "gpu_watchdog_unavailable"),
    ],
)
def test_watchdog_cancels_the_exact_call_and_requires_terminal_evidence(
    tmp_path, watch, reason
):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    provider.watch_result = watch
    result = run(scope(store, api, provider))
    assert result["termination"] == reason
    assert result["outcome"] == "call_terminal" and result["evidence"] == "recorded"
    assert provider.watched == [(CALL, "fu-Verified")]
    assert provider.cancelled == provider.polled == [CALL]
    evidence = api.actions[-1][1]["evidence"]
    assert (
        evidence["executionRef"] == CALL and evidence["detail"]["termination"] == reason
    )


@pytest.mark.parametrize("unconfirmed", [False, True])
def test_refused_record_targets_only_its_own_call(tmp_path, unconfirmed):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    provider.cancel_error = unconfirmed
    api.reject_record = True
    result = run(scope(store, api, provider))
    assert result["reason"] == (
        "gpu_cancel_unconfirmed" if unconfirmed else "execution_ref_conflict"
    )
    assert provider.cancelled == [CALL] and not provider.polled
    assert not any(action == "record_execution_evidence" for action, _ in api.actions)
    assert (
        "cancelRequestedAt"
        in store.read_modal(JOB, "segment", "flora_tempseg_vllm_fp8@1")
    ) is not unconfirmed


def test_unexpected_supervisor_error_cancels_exact_known_call(tmp_path):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    provider.poll_error = True
    result = run(scope(store, api, provider))
    assert result["reason"] == "gpu_supervision_failed"
    assert provider.cancelled == [CALL]
    assert not any(action == "record_execution_evidence" for action, _ in api.actions)


@pytest.mark.parametrize("phase", ["acknowledged", "terminal", "uncancelled"])
def test_contradictory_journal_cannot_exempt_catalog_call(tmp_path, phase):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    ctl = scope(store, api, provider, node={"callId": CATALOG, "state": "running"})
    terminal = phase == "terminal"
    record = ctl.record(
        "terminal" if terminal else "submitted",
        api.job,
        callId=CALL,
        budgetDeadline=iso(NOW + 3),
        **({"exitCode": 1} if terminal else {}),
    )
    if phase == "acknowledged":
        record.update(cancelRequestedAt=iso(NOW), termination="budget_exceeded")
    ctl.save(record)
    result = run(ctl)
    assert result["reason"] == "execution_ref_mismatch"
    assert (
        result["executionRef"] == CATALOG and result["conflictingExecutionRef"] == CALL
    )
    assert provider.cancelled == (
        [CATALOG, CALL] if phase == "uncancelled" else [CATALOG]
    )
    assert not provider.polled and api.actions == []


@pytest.mark.parametrize("stage", ["segment", "caption", "hand_pose"])
def test_lost_stage_spawn_acknowledgement_never_respawns(tmp_path, stage):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    provider.spawn_error = True
    assert run(scope(store, api, provider, name=stage))["outcome"] == "submit_unknown"
    assert (
        run(scope(JournalStore(tmp_path), api, provider, name=stage))["outcome"]
        == "submit_unknown"
    )
    assert provider.spawns == [stage]
    assert not provider.polled and not provider.cancelled
    assert sum(act == "issue_stage_claim" for act, _ in api.actions) == 1
    assert not any(action == "record_execution_evidence" for action, _ in api.actions)


def test_budget_cancel_without_result_keeps_stage_unsettled(tmp_path):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    provider.terminal = False
    result = run(scope(store, api, provider))
    assert result["reason"] == "call_not_provably_terminal_after_cancel"
    assert provider.cancelled == [CALL] and set(provider.polled) == {CALL}
    record = store.read_modal(JOB, "segment", "flora_tempseg_vllm_fp8@1")
    assert record["phase"] == "submitted" and record["termination"] == "budget_exceeded"
    assert not any(action == "record_execution_evidence" for action, _ in api.actions)


def test_stage_intent_resumes_after_lost_submitting_response(tmp_path):
    from stateaction_controller.api import AmbiguousApiError

    class LostRecord(StageApi):
        lost = False

        async def act(self, job_id, action, **facts):
            response = await super().act(job_id, action, **facts)
            if (
                action == "record_stage_run"
                and facts["state"] == "submitting"
                and not self.lost
            ):
                self.lost = True
                raise AmbiguousApiError()
            return response

    store = JournalStore(tmp_path)
    api, provider = LostRecord(), Provider(store)
    with pytest.raises(AmbiguousApiError):
        run(scope(store, api, provider))
    initial = store.read_modal(JOB, "segment", "flora_tempseg_vllm_fp8@1")
    assert initial["phase"] == "intent" and provider.spawns == []
    result = run(
        scope(
            JournalStore(tmp_path),
            api,
            provider,
            node={"state": "submitting", "callId": None},
        )
    )
    assert result["evidence"] == "recorded"
    assert provider.spawns == ["segment"] and provider.polled == [CALL]
    assert sum(act == "issue_stage_claim" for act, _ in api.actions) == 1


def test_stage_reentry_at_submitted_only_adopts_call(tmp_path):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    ctl = scope(store, api, provider)
    ctl.save(ctl.record("submitted", api.job, callId=CALL, budgetDeadline=iso(NOW + 3)))
    result = run(scope(JournalStore(tmp_path), api, provider))
    assert result["evidence"] == "recorded"
    assert provider.spawns == [] and provider.polled == [CALL]
    assert [action for action, _ in api.actions] == [
        "record_stage_run",
        "record_execution_evidence",
    ]
    assert (
        api.actions[-1][1]["evidence"]["detail"]["recovery"] == "adopted_from_journal"
    )


def test_unconfirmed_terminal_proof_retries_without_new_spawn_or_poll(tmp_path):
    from stateaction_controller.api import AmbiguousApiError

    class LostEvidence(StageApi):
        lost = False

        async def act(self, job_id, action, **facts):
            response = await super().act(job_id, action, **facts)
            if action == "record_execution_evidence" and not self.lost:
                self.lost = True
                raise AmbiguousApiError()
            return response

    store = JournalStore(tmp_path)
    api, provider = LostEvidence(), Provider(store)
    assert run(scope(store, api, provider))["evidence"] == "unconfirmed"
    assert (
        store.read_modal(JOB, "segment", "flora_tempseg_vllm_fp8@1")["phase"]
        == "terminal"
    )
    result = run(scope(JournalStore(tmp_path), api, provider))
    assert result["evidence"] == "recorded"
    assert provider.spawns == ["segment"] and provider.polled == [CALL]
    assert all(
        facts["evidence"]["executionRef"] == CALL
        for act, facts in api.actions
        if act == "record_execution_evidence"
    )


def test_fresh_host_adopts_exact_server_stage_call(tmp_path):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    node = {"state": "running", "callId": CALL, "startedAt": iso(NOW)}
    result = run(scope(store, api, provider, node=node))
    assert result["evidence"] == "recorded"
    assert provider.spawns == [] and provider.polled == [CALL]
    assert [a for a, _ in api.actions] == ["record_execution_evidence"]


def test_already_issued_stage_claim_without_token_never_spawns(tmp_path):
    class Issued(StageApi):
        async def act(self, job_id, action, **facts):
            if action == "issue_stage_claim":
                self.actions.append((action, facts))
                return {"state": "already_recorded"}
            return await super().act(job_id, action, **facts)

    store = JournalStore(tmp_path)
    api, provider = Issued(), Provider(store)
    decision = run(scope(store, api, provider))
    assert decision["reason"] == "intent_recorded_without_token"
    assert not provider.spawns and not provider.polled
    assert [a for a, _ in api.actions] == [
        "issue_stage_claim",
        "record_stage_run",
        "mark_submit_unknown",
    ]


def test_gpu_requeue_under_same_call_does_not_reset_fixed_budget(tmp_path):
    class Requeued(Provider):
        async def poll(self, call_id):
            self.terminal = bool(self.cancelled)
            return await super().poll(call_id)

    store = JournalStore(tmp_path)
    api, provider = StageApi(), Requeued(store)
    result = run(scope(store, api, provider))
    assert result["termination"] == "budget_exceeded"
    assert result["evidence"] == "recorded"
    assert provider.spawns == ["segment"] and provider.cancelled == [CALL]
    assert len(provider.polled) > 1 and set(provider.polled) == {CALL}
    record = store.read_modal(JOB, "segment", "flora_tempseg_vllm_fp8@1")
    assert record["budgetDeadline"] == iso(NOW + 3)


def test_preexisting_stage_spawn_marker_without_call_fences_execution(tmp_path):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    ctl = scope(store, api, provider)
    ctl.save(ctl.record("spawning", api.job, budgetDeadline=iso(NOW + 3)))
    result = run(ctl)
    assert result["reason"] == "spawn_outcome_uncertain"
    assert provider.spawns == provider.polled == []
    assert not any(
        action in ("issue_stage_claim", "record_execution_evidence")
        for action, _ in api.actions
    )


def test_resumed_stage_preflights_immutable_binding_before_consuming_reservation(
    tmp_path,
):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    ctl = scope(store, api, provider, node={"state": "submitting", "callId": None})
    initial = ctl.record("intent", api.job)
    ctl.save(initial)
    store.save_token(JOB, "segment", "synthetic")
    attempts = []

    async def drifted(binding, module):
        attempts.append((binding, module))
        return len(attempts) == 2

    provider.check_function = drifted
    assert run(ctl)["reason"] == "rerun_binding_unavailable"
    assert store.read_modal(JOB, "segment", "flora_tempseg_vllm_fp8@1") == initial
    assert not (tmp_path / JOB / "segment" / "spawn.reserved").exists()
    assert api.actions == [] and provider.spawns == []
    reentry = scope(JournalStore(tmp_path), api, provider)
    assert run(reentry)["evidence"] == "recorded"
    assert provider.spawns == ["segment"] and len(attempts) == 2


def test_existing_gpu_with_refused_binding_cancels_then_accepts_exact_proof(tmp_path):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    ctl = scope(
        store,
        api,
        provider,
        node={"state": "running", "callId": CALL, "startedAt": iso(NOW)},
    )
    ctl.stage.refusal = "rerun_binding_unavailable"
    decision = run(ctl)
    assert decision["evidence"] == "recorded"
    assert decision["termination"] == "rerun_binding_unavailable"
    assert provider.spawns == [] and provider.watched == []
    assert provider.cancelled == provider.polled == [CALL]


def test_gpu_watchdog_uses_fifteen_second_cadence(tmp_path):
    store = JournalStore(tmp_path)
    api, provider, clock = StageApi(), Provider(store), Clock()
    api.job["state"] = "running"
    times = []
    ctl = scope(store, api, provider, clock=clock)
    ctl.stage.budget_seconds = 34
    ctl.poll_seconds = 1

    async def watch(ref, binding):
        assert ref == CALL
        times.append(clock())
        return ["ci-Only"]

    provider.watch = watch
    provider.terminal = False
    result = run(ctl)
    assert result["reason"] == "call_not_provably_terminal_after_cancel"
    assert times == [NOW, NOW + 15, NOW + 30]
    assert provider.cancelled == [CALL]


@pytest.mark.parametrize("phase", ["submitted", "terminal"])
def test_recovery_records_exact_catalog_call_before_publishing_proof(tmp_path, phase):
    class CatalogApi(StageApi):
        recorded = None

        async def act(self, job_id, action, **facts):
            response = await super().act(job_id, action, **facts)
            if action == "record_stage_run" and facts["state"] == "running":
                self.recorded = facts["callId"]
            if action == "record_execution_evidence":
                assert self.recorded == facts["evidence"]["executionRef"] == CALL
            return response

    store = JournalStore(tmp_path)
    api, provider = CatalogApi(), Provider(store)
    ctl = scope(store, api, provider)
    ctl.stage.refusal = "rerun_binding_unavailable"
    fields = (
        {"exitCode": 1, "termination": "cancel_requested"}
        if phase == "terminal"
        else {}
    )
    ctl.save(
        ctl.record(phase, api.job, callId=CALL, budgetDeadline=iso(NOW - 1), **fields)
    )
    result = run(ctl)
    assert result["evidence"] == "recorded"
    assert [act for act, _ in api.actions] == [
        "record_stage_run",
        "record_execution_evidence",
    ]
    assert not provider.spawns
    if phase == "terminal":
        assert result["termination"] == "cancel_requested"
        assert not provider.polled and not provider.cancelled
    else:
        assert result["termination"] == "rerun_binding_unavailable"
        assert provider.polled == provider.cancelled == [CALL]


def test_binding_refusal_preserves_exact_proven_success_receipt(tmp_path):
    import json

    from test_recipe import FIXTURES

    source = json.loads((FIXTURES / "jobs.stage-receipt.v1.json").read_bytes())
    receipt = dict(source["cases"][0]["input"]["document"], jobId=JOB)
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    ctl = scope(store, api, provider, node={"state": "running", "callId": CALL})
    ctl.stage.refusal = "rerun_binding_unavailable"
    ctl.save(
        ctl.record(
            "terminal",
            api.job,
            callId=CALL,
            exitCode=0,
            receipt=receipt,
            termination="natural_exit",
        )
    )
    result = run(ctl)
    assert result["evidence"] == "recorded"
    assert result["result"]["exitCode"] == 0
    assert result["receipt"] == receipt and result["termination"] == "natural_exit"
    assert not provider.polled and not provider.cancelled and not provider.spawns


def test_refused_current_cpu_binding_preserves_exact_acknowledged_call(tmp_path):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    ctl = scope(store, api, provider, name="hand_pose")
    ctl.stage.gpu = False
    ctl.stage.module = "hand_pose_cpu_v1@1"
    ctl.stage.refusal = "clip_hand_pose_binding_unavailable"
    ctl.stage.binding = None
    ctl.save(ctl.record("submitted", api.job, callId=CALL))
    api.job["state"] = "running"

    result = run(ctl)

    assert result["outcome"] == "call_terminal" and result["evidence"] == "recorded"
    assert result["termination"] == "natural_exit"
    assert provider.polled == [CALL]
    assert not provider.cancelled and not provider.spawns


@pytest.mark.parametrize("cancel_at", ["reentry", "stage_record"])
def test_cancelled_gpu_intent_dispatches_once_and_proves_exact_call_exit(
    tmp_path, cancel_at
):
    class Cancelling(StageApi):
        async def act(self, job_id, action, **body):
            reply = await super().act(job_id, action, **body)
            if (
                cancel_at == "stage_record"
                and action == "record_stage_run"
                and body["state"] == "submitting"
            ):
                self.job["state"] = "cancel_requested"
            return reply

    store = JournalStore(tmp_path)
    api, provider = Cancelling(), Provider(store)
    ctl = scope(store, api, provider)
    ctl.save(ctl.record("intent", api.job))
    store.save_token(JOB, "segment", "local-test")
    if cancel_at == "reentry":
        api.job["state"] = "cancel_requested"

    result = run(ctl)
    assert result["outcome"] == "call_terminal" and result["evidence"] == "recorded"
    assert result["termination"] == "cancel_requested"
    assert provider.spawns == ["segment"]
    assert provider.cancelled == provider.polled == [CALL]
    assert store.load_token(JOB, "segment") is None
    assert not store.reserve_spawn(JOB, "segment")
    assert not any(action == "issue_stage_claim" for action, _ in api.actions)
    evidence = api.actions[-1][1]["evidence"]
    assert evidence["executionRef"] == CALL
    assert evidence["kind"] == "provider_call_terminal"
    assert evidence["detail"]["termination"] == "cancel_requested"


def test_catalog_publication_does_not_restart_a_gpu_budget(tmp_path):
    store = JournalStore(tmp_path)
    api, provider = StageApi(), Provider(store)
    api.job["state"] = "running"
    ctl = scope(
        store,
        api,
        provider,
        node={"state": "running", "callId": CALL, "startedAt": iso(NOW)},
    )
    result = run(ctl)
    assert (
        result["termination"] == "budget_exceeded" and result["evidence"] == "recorded"
    )
    assert provider.cancelled == provider.polled == [CALL]
    assert not provider.spawns and not provider.watched


def test_transient_pre_dispatch_status_failure_leaves_intent_for_native_retry(tmp_path):
    from stateaction_controller.api import AmbiguousApiError

    class TransientFailure(StageApi):
        failed = False

        async def status(self, job_id):
            if self.actions and not self.failed:
                self.failed = True
                raise AmbiguousApiError()
            return await super().status(job_id)

    store = JournalStore(tmp_path)
    api, provider = TransientFailure(), Provider(store)
    with pytest.raises(AmbiguousApiError):
        run(scope(store, api, provider))
    assert not provider.spawns
    assert store.load_token(JOB, "segment") == "local-test"
    assert (
        store.read_modal(JOB, "segment", "flora_tempseg_vllm_fp8@1")["phase"]
        == "intent"
    )
    assert run(scope(store, api, provider))["evidence"] == "recorded"
    assert provider.spawns == ["segment"]
    assert [action for action, _ in api.actions].count("issue_stage_claim") == 1
