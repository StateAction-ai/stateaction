import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import modal
import pytest
from modal._serialization import deserialize
from modal_proto import api_pb2 as wire
from stateaction_controller.config import Settings, modal_credentials
from stateaction_controller.modal_controller import SpawnCancelled, SpawnNotSent
from stateaction_controller.modal_executor import ModalExecutor
from stateaction_controller.results import parse_result
from test_modal_controller import CALL, JOB

PAYLOAD = {"schemaVersion": 2, "jobId": JOB, "module": "flora_tempseg_vllm_fp8@1"}


class Sdk:
    exception = modal.exception

    def __init__(self):
        self.lookups = []
        self.spawns = []
        self.maps = []
        self.puts = []
        self.put_required = False
        self.map_failure = None
        self.put_failure = None
        self.stub = SimpleNamespace(FunctionMap=self.map, FunctionPutInputs=self.put)
        self.cancels = []
        self.polls = []
        self.pause_lookup = False
        self.pause_spawn = False
        self.spawn_started = None
        self.pause_poll = False
        self.error = None
        self.result = {"schemaVersion": 1, "functionCallId": CALL, "exitCode": 0}
        self.Function = SimpleNamespace(from_name=self.from_name, from_id=self.from_id)
        self.FunctionCall = SimpleNamespace(from_id=self.from_call)

    def make_function(self, identity):
        async def hydrate():
            if self.pause_lookup:
                await asyncio.Event().wait()

        return SimpleNamespace(
            object_id=identity,
            hydrate=SimpleNamespace(aio=hydrate),
            _metadata=SimpleNamespace(
                supported_input_formats=[wire.DATA_FORMAT_PICKLE]
            ),
            _use_method_name="",
            _max_object_size_bytes=128_000,
            _max_async_object_size_bytes=128_000,
        )

    async def map(self, request, *, retry, timeout):
        assert retry is None and 0 < timeout <= 1
        self.maps.append(request)
        (item,) = request.pipelined_inputs
        args, kwargs = deserialize(item.input.args, None)
        assert kwargs == {}
        self.spawns.append(args)
        if self.spawn_started:
            self.spawn_started()
        if self.pause_spawn:
            await asyncio.Event().wait()
        if self.map_failure:
            raise self.map_failure
        reply = wire.FunctionMapResponse(function_call_id=CALL)
        if not self.put_required:
            reply.pipelined_inputs.add()
        return reply

    async def put(self, request, *, retry, timeout):
        assert retry is None and 0 < timeout <= 1
        self.puts.append(request)
        if self.put_failure:
            raise self.put_failure
        reply = wire.FunctionPutInputsResponse()
        reply.inputs.add()
        return reply

    def from_name(self, app, name, *, environment_name, client):
        self.lookups.append((app, name, environment_name, client))
        return self.make_function("fu-Synthetic")

    def from_id(self, identity, *, client):
        self.lookups.append((identity, client))
        return self.make_function(identity)

    def from_call(self, identity, *, client):
        async def get(*, timeout):
            self.polls.append((identity, timeout))
            if self.pause_poll:
                await asyncio.Event().wait()
            if self.error:
                raise self.error
            return self.result

        async def cancel(*, terminate_containers):
            self.cancels.append((identity, terminate_containers))

        return SimpleNamespace(
            get=SimpleNamespace(aio=get), cancel=SimpleNamespace(aio=cancel)
        )


@pytest.fixture
def adapter(tmp_path):
    sdk = Sdk()
    settings = Settings(
        "modal",
        "https://example.test",
        tmp_path,
        app="cpu-app",
        function="process",
        environment="development",
        targets={PAYLOAD["module"]: ("flora-app", "segment")},
        timeout=1,
    )
    return ModalExecutor(settings, sdk, sdk), sdk


def test_spawn_uses_module_app_and_one_json_argument(adapter):
    executor, sdk = adapter
    assert asyncio.run(executor.spawn(PAYLOAD, lambda: True, None)) == CALL
    assert sdk.lookups == [("flora-app", "segment", "development", executor.client)]
    assert len(sdk.spawns) == 1 and len(sdk.spawns[0]) == 1
    assert json.loads(sdk.spawns[0][0]) == PAYLOAD


def test_before_submit_runs_on_caller_event_loop_not_synchronicity_loop(adapter):
    executor, sdk = adapter
    seen = []

    async def run():
        caller_loop = asyncio.get_running_loop()
        ready = asyncio.Event()

        async def before_submit():
            assert asyncio.get_running_loop() is caller_loop
            caller_loop.call_soon(ready.set)
            await ready.wait()
            seen.append("before_submit")
            assert sdk.maps == []

        call_id = await executor.spawn(
            PAYLOAD, lambda: True, None, before_submit=before_submit
        )
        assert call_id == CALL

    asyncio.run(run())
    assert seen == ["before_submit"]
    assert len(sdk.maps) == 1


def test_before_submit_errors_do_not_submit_to_modal(adapter):
    executor, sdk = adapter

    async def fail_cancelled():
        raise SpawnCancelled("cancelled before submit")

    async def fail_runtime():
        raise RuntimeError("hook failed before submit")

    with pytest.raises(SpawnCancelled, match="cancelled before submit"):
        asyncio.run(
            executor.spawn(PAYLOAD, lambda: True, None, before_submit=fail_cancelled)
        )
    assert sdk.maps == []

    with pytest.raises(SpawnNotSent):
        asyncio.run(
            executor.spawn(PAYLOAD, lambda: True, None, before_submit=fail_runtime)
        )
    assert sdk.maps == []


def test_explicit_modal_credentials_are_required_before_client_creation():
    for env in ({}, {"MODAL_TOKEN_ID": "id"}, {"MODAL_TOKEN_SECRET": "secret"}):
        with pytest.raises(ValueError):
            modal_credentials(env)
    assert modal_credentials(
        {"MODAL_TOKEN_ID": "id", "MODAL_TOKEN_SECRET": "secret"}
    ) == ("id", "secret")


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (modal.exception.TimeoutError(), "pending"),
        (modal.exception.FunctionTimeoutError(), "unavailable"),
        (ConnectionResetError(), "unavailable"),
        (None, "returned"),
    ],
)
def test_poll_classifies_pending_provider_errors_and_returned_values(
    adapter, error, expected
):
    executor, sdk = adapter
    sdk.error = error
    observed = asyncio.run(executor.poll(CALL))
    assert observed["kind"] == expected
    assert ("value" in observed) == (expected == "returned")
    assert sdk.polls == [(CALL, 1)]


def test_never_answering_spawn_is_uncertain_and_not_retried(adapter, monkeypatch):
    executor, sdk = adapter
    sdk.pause_spawn = True
    real_timeout = asyncio.timeout_at

    async def run():
        loop = asyncio.get_running_loop()
        timer = None

        def capture_timeout(deadline):
            nonlocal timer
            timer = real_timeout(deadline)
            return timer

        def expire_after_dispatch():
            assert timer is not None
            loop.call_soon_threadsafe(timer.reschedule, loop.time())

        monkeypatch.setattr(asyncio, "timeout_at", capture_timeout)
        sdk.spawn_started = expire_after_dispatch
        with pytest.raises(RuntimeError, match="acknowledgement") as caught:
            await executor.spawn(PAYLOAD, lambda: True, None)
        assert isinstance(caught.value.__context__, TimeoutError)
        assert timer is not None and timer.expired()

    asyncio.run(run())
    assert len(sdk.spawns) == 1


def test_expired_lookup_cannot_spawn(adapter):
    executor, sdk = adapter
    executor.settings = replace(executor.settings, timeout=0.01)
    sdk.pause_lookup = True
    with pytest.raises(SpawnNotSent):
        asyncio.run(executor.spawn(PAYLOAD, lambda: True, None))
    assert len(sdk.lookups) == 1
    assert sdk.spawns == []


def test_authority_is_checked_after_lookup(adapter):
    executor, sdk = adapter

    def authorized():
        assert sdk.lookups
        return False

    with pytest.raises(SpawnNotSent):
        asyncio.run(executor.spawn(PAYLOAD, authorized, None))
    assert sdk.spawns == []


def test_a_poll_without_a_reply_is_unavailable(adapter, monkeypatch):
    executor, sdk = adapter
    executor.settings = replace(executor.settings, timeout=0.01)
    sdk.pause_poll = True
    monkeypatch.setattr("stateaction_controller.modal_executor.POLL_SECONDS", 0.01)
    observed = asyncio.run(executor.poll(CALL))
    assert observed == {"kind": "unavailable", "detail": "operation_timeout"}


def test_cancel_requests_termination_for_only_the_exact_call(adapter):
    executor, sdk = adapter
    asyncio.run(executor.cancel(CALL))
    assert sdk.cancels == [(CALL, True)]
    assert sdk.polls == []


def test_verified_spawn_uses_only_the_verified_identity(adapter):
    executor, sdk = adapter
    calls = []
    binding = {"functionId": "fu-Pinned"}

    async def verify(module, facts):
        calls.append((module, facts))
        return SimpleNamespace(function_id=binding["functionId"])

    executor.verify = verify
    assert asyncio.run(executor.spawn(PAYLOAD, lambda: True, binding)) == CALL
    assert calls == [(PAYLOAD["module"], binding)]
    assert sdk.lookups == [(binding["functionId"], executor.client)]
    assert sdk.maps[0].function_id == binding["functionId"]


@pytest.mark.parametrize("phase", ["map", "put"])
def test_submission_rpcs_do_not_retry_after_ambiguous_transport_failure(adapter, phase):
    executor, sdk = adapter
    sdk.put_required = phase == "put"
    setattr(sdk, f"{phase}_failure", ConnectionResetError())
    with pytest.raises(RuntimeError, match="acknowledgement"):
        asyncio.run(executor.spawn(PAYLOAD, lambda: True, None))
    assert len(sdk.maps) == 1
    assert len(sdk.puts) == int(phase == "put")
    if phase == "put":
        assert sdk.puts[0].function_call_id == CALL
        assert list(sdk.puts[0].inputs) == list(sdk.maps[0].pipelined_inputs)


def test_submission_fallback_rechecks_authority_for_the_exact_call(adapter):
    executor, sdk = adapter
    sdk.put_required = True
    with pytest.raises(RuntimeError, match="acknowledgement"):
        asyncio.run(executor.spawn(PAYLOAD, lambda: not sdk.maps, None))
    assert len(sdk.maps) == 1
    assert sdk.puts == []


@pytest.mark.parametrize(
    "patch",
    [
        {"functionCallId": "fc-Other"},
        {"schemaVersion": 2},
        {"exitCode": True},
        {"exitCode": 256},
        {"exitCode": None},
        {"callBinding": "unsafe"},
        {"extra": 1},
    ],
)
def test_result_requires_exact_call_and_strict_shape(patch):
    result = {"schemaVersion": 1, "functionCallId": CALL, "exitCode": 0}
    assert parse_result(result, CALL) == result
    assert parse_result({**result, **patch}, CALL) is None


def test_missing_credentials_make_poll_unavailable_and_close_releases_client(
    adapter, monkeypatch
):
    executor, sdk = adapter
    executor.client = None
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    monkeypatch.delenv("MODAL_TOKEN_SECRET", raising=False)
    assert asyncio.run(executor.poll(CALL))["kind"] == "unavailable"
    assert sdk.polls == []
    connections = []
    closed = []

    async def close():
        closed.append(True)

    async def connect(token_id, token_secret):
        connections.append((token_id, token_secret))
        return SimpleNamespace(close=SimpleNamespace(aio=close))

    sdk.Client = SimpleNamespace(from_credentials=SimpleNamespace(aio=connect))
    monkeypatch.setenv("MODAL_TOKEN_ID", "local-id")
    monkeypatch.setenv("MODAL_TOKEN_SECRET", "local-test")

    async def run():
        assert (await executor.poll(CALL))["kind"] == "returned"
        await executor.close()

    asyncio.run(run())
    assert connections == [("local-id", "local-test")]
    assert executor.client is None and closed == [True]


def test_v2_result_requires_matching_job_stage_module_and_receipt():
    from test_recipe import FIXTURES

    source = json.loads((FIXTURES / "jobs.stage-receipt.v1.json").read_bytes())
    receipt = source["cases"][0]["input"]["document"]
    identity = (receipt["jobId"], receipt["stage"], receipt["module"])
    result = {
        "schemaVersion": 2,
        "functionCallId": CALL,
        "exitCode": 0,
        "receipt": receipt,
    }
    assert parse_result(result, CALL, identity) == result
    assert parse_result(dict(result, receipt=None), CALL, identity)["receipt"] is None
    for raw in (
        dict(result, schemaVersion=1),
        dict(result, exitCode=1),
        dict(result, receipt={}),
        dict(result, extra=1),
    ):
        assert parse_result(raw, CALL, identity) is None
    for wrong in (
        ("00000000-0000-4000-8000-000000000100", *identity[1:]),
        (identity[0], "caption", identity[2]),
        (*identity[:2], "stub_segmenter@1"),
    ):
        assert parse_result(result, CALL, wrong) is None
