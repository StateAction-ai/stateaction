import asyncio
from datetime import UTC, datetime

import pytest
from stateaction_controller.api import AmbiguousApiError
from stateaction_controller.journal import JournalStore, iso
from stateaction_controller.modal_controller import ModalExecution

JOB = "00000000-0000-4000-8000-000000000153"
CALL = "fc-ExactCall"
NOW = datetime(2026, 11, 26, tzinfo=UTC).timestamp()


class Api:
    def __init__(self):
        self.job = {
            "executionBackend": "modal",
            "executionRef": None,
            "state": "submitting",
            "startDeadline": iso(NOW + 10),
            "executionDeadline": iso(NOW + 60),
        }
        self.actions = []
        self.submitted = False

    async def status(self, job_id):
        assert job_id == JOB
        return self.job.copy()

    async def act(self, job_id, action, **body):
        assert job_id == JOB
        self.actions.append((action, body))
        if action == "record_worker_submission":
            assert not self.submitted
            self.submitted = True
            return {**self.job, "state": "recorded", "bootstrapToken": "local-test"}
        if action == "record_execution":
            assert body["executor"] == {"kind": "modal", "functionCallId": CALL}
            self.job["executionRef"] = CALL
        return {}


class Modal:
    def __init__(self, api, store):
        self.api = api
        self.store = store
        self.spawns = 0
        self.polled = []
        self.cancelled = []
        self.spawn_error = False
        self.observation_kind = "returned"
        self.observation = {"schemaVersion": 1, "functionCallId": CALL, "exitCode": 0}

    async def spawn(self, bootstrap, authorized, binding):
        assert self.api.submitted
        assert self.store.read_modal(JOB, None, None)["phase"] == "spawning"
        assert not self.store.reserve_spawn(JOB, None)
        assert bootstrap["bootstrapToken"] == "local-test"
        assert authorized()
        self.spawns += 1
        if self.spawn_error:
            raise TimeoutError()
        return CALL

    async def poll(self, call_id):
        assert self.store.read_modal(JOB, None, None)["callId"] == CALL
        self.polled.append(call_id)
        return {"kind": self.observation_kind, "value": self.observation}

    async def cancel(self, call_id):
        self.cancelled.append(call_id)


class Clock:
    now = NOW

    def __call__(self):
        return self.now

    async def sleep(self, delay):
        self.now += delay


def run(api, store, modal, *, clock=None, lease=lambda: True):
    clock = clock or Clock()
    execution = ModalExecution(
        api,
        store,
        modal,
        JOB,
        "test-run",
        "test-owner",
        lease,
        "https://example.test",
        "hand_pose_cpu_v1",
        1,
        1,
        2,
        clock=clock,
        sleep=clock.sleep,
    )

    async def drive():
        return await execution.run(await api.status(JOB))

    return asyncio.run(drive())


def test_one_spawn_and_exact_terminal_evidence(tmp_path):
    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    outcome = run(api, store, modal)
    assert outcome["evidence"] == "recorded"
    assert modal.spawns == 1
    assert modal.polled == [CALL]
    assert store.load_token(JOB, None) is None
    assert [action for action, _ in api.actions] == [
        "record_worker_submission",
        "record_execution",
        "record_execution_evidence",
    ]
    assert api.actions[-1][1]["evidence"]["executionRef"] == CALL
    assert api.actions[-1][1]["evidence"]["kind"] == "provider_call_terminal"


def test_lost_spawn_acknowledgement_is_fenced_on_reentry(tmp_path):
    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    modal.spawn_error = True
    assert run(api, store, modal)["outcome"] == "submit_unknown"
    reentry = JournalStore(tmp_path)
    assert run(api, reentry, modal)["outcome"] == "submit_unknown"
    assert modal.spawns == 1
    assert not modal.polled and not modal.cancelled
    assert [action for action, _ in api.actions] == [
        "record_worker_submission",
        "mark_submit_unknown",
        "mark_submit_unknown",
    ]


def test_known_call_is_adopted_by_a_restarted_controller(tmp_path):
    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    assert (
        run(api, store, modal, lease=lambda: modal.spawns == 0)["outcome"]
        == "lease_lost"
    )
    assert store.read_modal(JOB, None, None)["phase"] == "submitted"
    assert modal.polled == []
    reentry = JournalStore(tmp_path)
    assert run(api, reentry, modal)["evidence"] == "recorded"
    assert modal.spawns == 1
    assert modal.polled == [CALL]
    assert (
        api.actions[-1][1]["evidence"]["detail"]["recovery"] == "adopted_from_journal"
    )


def test_lost_submission_ack_never_spawns(tmp_path):
    class LostApi(Api):
        async def act(self, job_id, action, **body):
            result = await super().act(job_id, action, **body)
            if action == "record_worker_submission":
                raise AmbiguousApiError()
            return result

    api = LostApi()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    assert run(api, store, modal)["outcome"] == "submit_unknown"
    assert modal.spawns == 0 and modal.polled == []
    assert [action for action, _ in api.actions] == [
        "record_worker_submission",
        "mark_submit_unknown",
    ]


def test_foreign_terminal_value_does_not_settle_cancel(tmp_path):
    api = Api()
    api.job.update(state="cancel_requested", executionRef=CALL)
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    modal.observation["functionCallId"] = "fc-Different"
    outcome = run(api, store, modal)
    assert outcome["reason"] == "call_not_provably_terminal_after_cancel"
    assert modal.cancelled == [CALL]
    assert set(modal.polled) == {CALL}
    assert modal.spawns == 0
    assert api.actions == []
    assert store.read_modal(JOB, None, None)["phase"] == "submitted"


def test_adopts_catalog_call_without_local_disk_and_preserves_start_deadline(tmp_path):
    api = Api()
    api.job.update(state="running", executionRef=CALL)
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    result = run(api, store, modal)
    assert result["evidence"] == "recorded"
    assert modal.spawns == 0 and modal.polled == [CALL]
    assert [action for action, _ in api.actions] == ["record_execution_evidence"]
    record = store.read_modal(JOB, None, None)
    assert record["startDeadline"] == api.job["startDeadline"]
    assert record["executionDeadline"] == api.job["executionDeadline"]
    assert record["startDeadline"] != record["executionDeadline"]


def test_unknown_preexisting_submission_without_call_does_not_spawn(tmp_path):
    api = Api()
    api.job["state"] = "submit_unknown"
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    assert run(api, store, modal)["reason"] == "no_local_journal"
    assert modal.spawns == 0
    assert api.actions == []


def test_unrecorded_spawn_adopts_worker_claim_exact_id(tmp_path):
    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    modal.spawn_error = True
    assert run(api, store, modal)["outcome"] == "submit_unknown"
    api.job.update(state="running", executionRef=CALL)
    assert run(api, JournalStore(tmp_path), modal)["evidence"] == "recorded"
    assert modal.spawns == 1 and modal.polled == [CALL]
    assert [action for action, _ in api.actions] == [
        "record_worker_submission",
        "mark_submit_unknown",
        "record_execution_evidence",
    ]


def test_backend_mismatch_never_submits(tmp_path):
    api = Api()
    api.job["executionBackend"] = "local"
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    assert run(api, store, modal)["reason"] == "backend_mismatch"
    assert modal.spawns == 0
    assert api.actions == []


def test_execution_deadline_requests_cancel_and_withholds_proof(tmp_path):
    api = Api()
    api.job.update(
        state="running",
        executionRef=CALL,
        startDeadline=iso(NOW - 10),
        executionDeadline=iso(NOW - 1),
    )
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    modal.observation = None
    result = run(api, store, modal)
    assert result["outcome"] == "needs_operator"
    assert modal.cancelled == [CALL]
    assert api.actions == []
    assert store.read_modal(JOB, None, None)["termination"] == "execution_deadline"


def test_observed_cancel_records_provenance(tmp_path):
    api = Api()
    api.job.update(state="cancel_requested", executionRef=CALL)
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    assert run(api, store, modal)["evidence"] == "recorded"
    assert modal.cancelled == [CALL] and modal.polled == [CALL]
    assert api.actions[-1][1]["evidence"]["detail"]["termination"] == "cancel_requested"


def test_nonzero_exit_is_exact_terminal_evidence(tmp_path):
    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    modal.observation["exitCode"] = 75
    assert run(api, store, modal)["result"]["exitCode"] == 75
    assert api.actions[-1][1]["evidence"]["detail"]["exitCode"] == "75"


def test_refused_record_of_call_produces_no_evidence(tmp_path):
    from stateaction_controller.api import ApiRejection

    class Conflict(Api):
        async def act(self, job_id, action, **body):
            if action == "record_execution":
                self.actions.append((action, body))
                self.job["executionRef"] = "fc-OtherCall"
                raise ApiRejection(409, "conflict")
            return await super().act(job_id, action, **body)

    api = Conflict()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    assert run(api, store, modal)["reason"] == "execution_ref_conflict"
    assert run(api, store, modal)["reason"] == "execution_ref_mismatch"
    assert modal.spawns == 1 and modal.polled == []
    assert [action for action, _ in api.actions] == [
        "record_worker_submission",
        "record_execution",
    ]


def test_invalid_catalog_id_never_polls(tmp_path):
    api = Api()
    api.job.update(executionRef="local-not-modal")
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    assert run(api, store, modal)["reason"] == "invalid_recorded_ref"
    assert not modal.polled and not modal.spawns
    assert api.actions == []


def test_reservation_crash_fails_closed(tmp_path):
    class CrashStore(JournalStore):
        def reserve_spawn(self, job_id, stage):
            assert super().reserve_spawn(job_id, stage)
            raise OSError("injected after reservation")

    api = Api()
    store = CrashStore(tmp_path)
    modal = Modal(api, store)
    with pytest.raises(OSError, match="injected"):
        run(api, store, modal)
    resumed = JournalStore(tmp_path)
    assert resumed.read_modal(JOB, None, None)["phase"] == "intent"
    assert run(api, resumed, modal)["outcome"] == "submit_unknown"
    assert modal.spawns == 0
    assert [action for action, _ in api.actions] == [
        "record_worker_submission",
        "mark_submit_unknown",
    ]


@pytest.mark.parametrize("reason", ["start", "execution", "token"])
def test_expired_bound_or_missing_token_prevents_paid_call(tmp_path, reason):
    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    record = {
        "version": 1,
        "executor": "modal",
        "phase": "intent",
        "jobId": JOB,
        "runRef": "test-run",
        "startDeadline": iso(NOW + 10),
        "executionDeadline": iso(NOW + 60),
    }
    if reason != "token":
        store.save_token(JOB, None, "local-test")
        record["startDeadline"] = iso(NOW - 2)
    if reason == "execution":
        record["executionDeadline"] = iso(NOW - 1)
    store.write_modal(record, None)
    assert run(api, store, modal)["outcome"] == "submit_unknown"
    assert modal.spawns == 0 and not modal.polled
    assert [action for action, _ in api.actions] == ["mark_submit_unknown"]


@pytest.mark.parametrize(
    ("kind", "value"),
    [
        ("unavailable", None),
        ("pending", None),
        ("returned", {"schemaVersion": 1, "functionCallId": "fc-Other", "exitCode": 0}),
        ("returned", {"schemaVersion": 1, "functionCallId": CALL, "exitCode": "0"}),
    ],
)
def test_unresolved_or_invalid_observation_cannot_prove_termination(
    tmp_path, kind, value
):
    api = Api()
    api.job.update(state="cancel_requested", executionRef=CALL)
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    modal.observation_kind, modal.observation = kind, value
    decision = run(api, store, modal)
    assert decision["outcome"] == "needs_operator"
    assert decision["reason"] == "call_not_provably_terminal_after_cancel"
    assert modal.cancelled == [CALL] and set(modal.polled) == {CALL}
    assert api.actions == []


@pytest.mark.parametrize("first", ["claim", "record"])
def test_worker_claim_and_execution_record_converge_on_same_call(tmp_path, first):
    class RacingApi(Api):
        def claim(self, identity):
            assert self.job["executionRef"] in (None, identity)
            self.job.update(executionRef=identity, state="running")

        async def act(self, job_id, action, **facts):
            if action == "record_execution":
                already = self.job["executionRef"] is not None
                assert already == (first == "claim")
                await super().act(job_id, action, **facts)
                if not already:
                    self.claim(facts["executor"]["functionCallId"])
                return {"recorded": not already}
            return await super().act(job_id, action, **facts)

    class ClaimingModal(Modal):
        async def spawn(self, bootstrap, authorized, binding):
            call_id = await super().spawn(bootstrap, authorized, binding)
            if first == "claim":
                self.api.claim(call_id)
            return call_id

    api = RacingApi()
    store = JournalStore(tmp_path)
    modal = ClaimingModal(api, store)
    assert run(api, store, modal)["evidence"] == "recorded"
    assert modal.spawns == 1 and modal.polled == [CALL]
    assert api.job["executionRef"] == CALL
    assert [action for action, _ in api.actions] == [
        "record_worker_submission",
        "record_execution",
        "record_execution_evidence",
    ]


def assert_evidence_last(actions):
    index = actions.index("record_execution_evidence")
    assert actions.count("record_execution_evidence") == 1
    assert actions.index("record_execution") < index
    assert set(actions[index + 1 :]) <= {"renew_lease"}


def test_evidence_order_allows_late_renewal():
    assert_evidence_last(
        [
            "record_worker_submission",
            "record_execution",
            "renew_lease",
            "record_execution_evidence",
            "renew_lease",
        ]
    )


@pytest.mark.parametrize(
    "actions",
    [
        ["record_execution"],
        ["record_execution", "record_execution_evidence", "record_execution_evidence"],
        ["record_execution_evidence", "record_execution"],
        ["record_execution", "record_execution_evidence", "record_worker_submission"],
        ["record_execution", "record_execution_evidence", "renew_lease", "release"],
    ],
)
def test_evidence_order_assertion_rejects_invalid_sequences(actions):
    with pytest.raises((AssertionError, ValueError)):
        assert_evidence_last(actions)


def test_preexisting_spawning_phase_without_identity_never_submits(tmp_path):
    api = Api()
    store = JournalStore(tmp_path)
    initial = {
        "version": 1,
        "executor": "modal",
        "jobId": JOB,
        "runRef": "test-run",
        "phase": "spawning",
        "startDeadline": iso(NOW + 10),
        "executionDeadline": iso(NOW + 60),
    }
    store.write_modal(initial, None)
    modal = Modal(api, store)
    result = run(api, store, modal)
    assert result["reason"] == "spawn_outcome_uncertain"
    assert modal.spawns == 0 and modal.polled == []
    assert [action for action, _ in api.actions] == ["mark_submit_unknown"]
    assert store.read_modal(JOB, None, None) == initial


def test_exact_proof_observed_during_lease_loss_is_sent_with_original_run(tmp_path):
    api = Api()
    api.job.update(state="running", executionRef=CALL)
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    live = True
    original = modal.poll

    async def poll(ref):
        nonlocal live
        live = False
        return await original(ref)

    modal.poll = poll
    result = run(api, store, modal, lease=lambda: live)
    assert result["evidence"] == "recorded"
    assert modal.polled == [CALL] and not modal.spawns
    action, facts = api.actions[0]
    assert action == "record_execution_evidence"
    assert len(api.actions) == 1
    assert facts["evidence"]["executionRef"] == CALL
    assert facts["evidence"]["detail"]["runRef"] == "test-run"


@pytest.mark.parametrize("phase", ["submitted", "terminal"])
def test_reopening_identified_journal_removes_leftover_bootstrap(tmp_path, phase):
    api = Api()
    api.job.update(state="running", executionRef=CALL)
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    initial = {
        "version": 1,
        "executor": "modal",
        "jobId": JOB,
        "runRef": "test-run",
        "phase": phase,
        "startDeadline": api.job["startDeadline"],
        "executionDeadline": api.job["executionDeadline"],
        "callId": CALL,
        "executionRecorded": True,
    }
    if phase == "terminal":
        initial["exitCode"] = 0
    store.write_modal(initial, None)
    store.save_token(JOB, None, "synthetic")
    assert run(api, JournalStore(tmp_path), modal)["evidence"] == "recorded"
    assert store.load_token(JOB, None) is None
    assert modal.spawns == 0


@pytest.mark.parametrize("identity", ["local-not-modal", "fc-bad-id", None])
def test_malformed_provider_acknowledgement_is_never_evidence_or_retried(
    tmp_path, identity
):
    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    spawn = modal.spawn

    async def invalid(*args):
        await spawn(*args)
        return identity

    modal.spawn = invalid
    assert run(api, store, modal)["reason"] == "invalid_call_id"
    assert run(api, JournalStore(tmp_path), modal)["outcome"] == "submit_unknown"
    assert modal.spawns == 1 and not modal.polled
    assert [a for a, _ in api.actions] == [
        "record_worker_submission",
        "mark_submit_unknown",
        "mark_submit_unknown",
    ]
    assert store.load_token(JOB, None) is None


def test_clip_plan_binding_drift_does_not_consume_resumed_intent(tmp_path):
    from stateaction_controller.modal_controller import ModalExecution

    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    binding = {"gpu": "none"}
    checks = []

    async def verify(candidate):
        assert candidate is binding
        checks.append(candidate)
        return False

    modal.check_function = verify
    clock = Clock()
    controller = ModalExecution(
        api,
        store,
        modal,
        JOB,
        "test-run",
        "owner",
        lambda: True,
        "https://example.test",
        "clip_plan_cpu_v1",
        1,
        1,
        2,
        plan_binding=binding,
        clock=clock,
        sleep=clock.sleep,
    )
    record = controller.record("intent", api.job)
    store.write_modal(record, None)
    store.save_token(JOB, None, "synthetic")
    assert (
        asyncio.run(controller.run(api.job))["reason"]
        == "clip_plan_binding_unavailable"
    )
    assert checks == [binding] and not api.actions and modal.spawns == 0
    assert store.read_modal(JOB, None, None) == record
    assert not (tmp_path / JOB / "spawn.reserved").exists()


def test_expired_cpu_call_cancels_and_keeps_exact_terminal_evidence_when_record_refused(
    tmp_path,
):
    from stateaction_controller.api import ApiRejection

    class EndedJob(Api):
        async def act(self, job_id, action, **body):
            if action == "record_execution":
                assert modal.cancelled == [CALL]
                self.actions.append((action, body))
                raise ApiRejection(409, "job_ended")
            return await super().act(job_id, action, **body)

    api = EndedJob()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    api.job.update(
        state="running",
        startDeadline=iso(NOW - 20),
        executionDeadline=iso(NOW - 1),
    )
    store.write_modal(
        {
            "version": 1,
            "executor": "modal",
            "phase": "submitted",
            "jobId": JOB,
            "runRef": "test-run",
            "startDeadline": api.job["startDeadline"],
            "executionDeadline": api.job["executionDeadline"],
            "callId": CALL,
        },
        None,
    )
    result = run(api, store, modal)
    assert result["outcome"] == "call_terminal"
    assert result["result"] == modal.observation
    assert result["evidence"] == "recorded"
    assert result["termination"] == "execution_deadline"
    assert modal.cancelled == [CALL] and modal.polled == [CALL] and not modal.spawns
    assert [action for action, _ in api.actions] == [
        "record_execution",
        "record_execution_evidence",
    ]


def test_expired_pending_cpu_call_is_published_for_adoption_after_cancel(tmp_path):
    api = Api()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    api.job.update(
        state="running",
        startDeadline=iso(NOW - 20),
        executionDeadline=iso(NOW - 1),
    )
    store.write_modal(
        {
            "version": 1,
            "executor": "modal",
            "phase": "submitted",
            "jobId": JOB,
            "runRef": "test-run",
            "startDeadline": api.job["startDeadline"],
            "executionDeadline": api.job["executionDeadline"],
            "callId": CALL,
        },
        None,
    )
    modal.observation_kind = "pending"
    assert run(api, store, modal)["reason"] == "call_not_provably_terminal_after_cancel"
    assert modal.cancelled == [CALL]
    assert api.job["executionRef"] == CALL
    assert [action for action, _ in api.actions] == ["record_execution"]
    fresh = JournalStore(tmp_path / "other")
    modal.store = fresh
    modal.observation_kind = "returned"
    result = run(api, fresh, modal)
    assert result["outcome"] == "call_terminal" and result["evidence"] == "recorded"
    assert result["executionRef"] == CALL and modal.spawns == 0


def test_ended_job_catalog_refusal_still_attempts_exact_claim_proof(tmp_path):
    from stateaction_controller.api import ApiRejection

    class EndedJob(Api):
        async def act(self, job_id, action, **body):
            if action == "record_execution":
                self.actions.append((action, body))
                self.job["state"] = "succeeded"
                raise ApiRejection(409, "conflict")
            return await super().act(job_id, action, **body)

    api = EndedJob()
    store = JournalStore(tmp_path)
    modal = Modal(api, store)
    result = run(api, store, modal)
    assert result["evidence"] == "recorded" and result["executionRef"] == CALL
    assert result["termination"] == "natural_exit"
    assert modal.spawns == 1 and modal.polled == [CALL] and not modal.cancelled
