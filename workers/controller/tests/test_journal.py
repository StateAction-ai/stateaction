import pytest
from stateaction_controller.journal import JournalCorrupt, JournalStore
from stateaction_controller.local_process import boot_id
from test_modal_controller import CALL, JOB, Api, Modal, run


@pytest.fixture
def local():
    return {
        "version": 1,
        "jobId": JOB,
        "runRef": "test-run",
        "executionRef": "local-case",
        "phase": "exited",
        "startDeadline": "2026-11-26T00:01:00Z",
        "executionDeadline": "2026-11-26T00:10:00Z",
        "bootId": boot_id(),
        "pid": 123,
        "pgid": 123,
        "sid": 123,
        "startTicks": "123",
        "singleProcess": True,
        "exit": {"code": 0, "signal": None},
        "evidenceRecorded": True,
    }


def test_complete_journal_round_trips(tmp_path, local):
    JournalStore(tmp_path).write_local(local)
    assert JournalStore(tmp_path).read_local(JOB, None) == local


def test_symlinked_journal_or_unsafe_directory_withholds_recovery(tmp_path, local):
    store = JournalStore(tmp_path)
    store.write_local(local)
    directory = tmp_path / JOB
    directory.chmod(0o755)
    with pytest.raises(JournalCorrupt):
        store.read_local(JOB, None)
    directory.chmod(0o700)
    path = directory / "journal.json"
    saved = directory / "saved.json"
    path.rename(saved)
    path.symlink_to(saved)
    with pytest.raises(JournalCorrupt):
        store.read_local(JOB, None)


@pytest.mark.parametrize(
    "problem",
    [
        "phase",
        "malformed_deadline",
        "deadline_order",
        "no_pid",
        "partial_pid",
        "negative_pid",
        "unsafe_pid",
        "ticks",
        "missing_exit",
        "spawning_pid",
        "early_evidence",
        "extra",
        "other_job",
        "not_object",
        "torn",
    ],
)
def test_journal_corruption_preserves_original(tmp_path, local, problem):
    import json

    store = JournalStore(tmp_path)
    store.write_local(local)
    path = tmp_path / JOB / "journal.json"
    running = {
        key: value
        for key, value in local.items()
        if key not in ("exit", "evidenceRecorded")
    }
    running["phase"] = "running"
    if problem == "phase":
        running["phase"] = "future"
    elif problem == "malformed_deadline":
        running["executionDeadline"] = "not-a-date"
    elif problem == "deadline_order":
        running["startDeadline"] = "2026-11-26T01:00:00Z"
    elif problem == "no_pid":
        for key in ("pid", "pgid", "sid"):
            del running[key]
    elif problem == "partial_pid":
        del running["sid"]
    elif problem == "negative_pid":
        running["pid"] = -1
    elif problem == "unsafe_pid":
        running["pid"] = 2**60
    elif problem == "ticks":
        running["startTicks"] = "12 34"
    elif problem == "missing_exit":
        running["phase"] = "exited"
    elif problem == "spawning_pid":
        running["phase"] = "spawning"
    elif problem == "early_evidence":
        running["evidenceRecorded"] = True
    elif problem == "extra":
        running["token"] = "synthetic"
    elif problem == "other_job":
        running["jobId"] = "00000000-0000-4000-8000-000000000154"
    original = {"not_object": "[1]", "torn": '{"version":1,"jobI'}.get(
        problem, json.dumps(running)
    )
    path.write_text(original)
    with pytest.raises(JournalCorrupt):
        store.read_local(JOB, None)
    assert path.read_text() == original


def test_corrupt_modal_phase_is_preserved_and_withholds_calls_and_evidence(tmp_path):
    store = JournalStore(tmp_path)
    api = Api()
    api.job.update(executionRef=CALL, state="running")
    provider = Modal(api, store)
    torn = b'{"phase":"future"}'
    store._write(JOB, None, "modal-journal.json", torn)
    assert run(api, store, provider)["reason"] == "journal_corrupt"
    assert store._read(JOB, None, "modal-journal.json") == torn
    assert provider.spawns == 0 and provider.polled == []
    assert [action for action, _ in api.actions] == ["mark_submit_unknown"]


def test_local_journal_blocks_modal_submission(tmp_path, local):
    store = JournalStore(tmp_path)
    store.write_local(local)
    api = Api()
    provider = Modal(api, store)
    assert run(api, store, provider)["reason"] == "foreign_local_journal"
    assert provider.spawns == 0 and provider.polled == []
    assert not store.foreign_modal(JOB, None)


@pytest.mark.parametrize(
    "change",
    [
        {"callId": None},
        {"callId": "local-child"},
        {"phase": "spawning"},
        {"extra": 1},
        {"exitCode": 256},
        {"exitCode": True},
    ],
)
def test_modal_journal_phase_identity_and_exit_are_strict(tmp_path, change):
    api = Api()
    store = JournalStore(tmp_path)
    assert run(api, store, Modal(api, store))["evidence"] == "recorded"
    terminal = store.read_modal(JOB, None, None)
    with pytest.raises(JournalCorrupt):
        store.write_modal({**terminal, **change}, None)
    assert store.read_modal(JOB, None, None) == terminal


def test_valid_json_local_unknown_phase_never_records_evidence_or_overwrites(
    tmp_path, local
):
    import json

    from test_local_controller import Fixture

    fixture = Fixture(tmp_path)
    original = json.dumps({**local, "phase": "future"}).encode()
    fixture.store._write(JOB, None, "journal.json", original)
    decision = fixture.run()
    assert decision["reason"] == "journal_corrupt"
    assert fixture.store._read(JOB, None, "journal.json") == original
    assert [a for a, _ in fixture.actions] == ["mark_submit_unknown"]
