"""Reuse the pinned verifier's loopback transport with the captured definition pair."""

import base64
import copy
import importlib.util
import json
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from google.protobuf.json_format import ParseDict
from modal_proto import api_pb2 as wire
from pytest import raises
from stateaction_modal_verifier.verifier import DefinitionRejected, inspect

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "_sa152_verifier_fixture",
    ROOT / "packages/modal-verifier/tests/test_verifier.py",
)
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
CAPTURE = ROOT / "packages/modal-verifier/tests/fixtures/modal-deployment-window-3.json"


class SpawnWire(suite.FixtureWire):
    def __mapping__(self):
        methods = super().__mapping__()
        service = suite.wire.DESCRIPTOR.services_by_name["ModalClient"]
        name = "FunctionMap"
        method = service.methods_by_name[name]
        methods[f"/{service.full_name}/{name}"] = suite.Handler(
            self.handle(name),
            suite.Cardinality.UNARY_UNARY,
            suite.GetMessageClass(method.input_type),
            suite.GetMessageClass(method.output_type),
        )
        return methods

    def handle(self, method):
        if method != "FunctionMap":
            return super().handle(method)

        async def answer(stream):
            request = await stream.recv_message()
            self.received.append((method, request))
            reply = self.replies[method]
            if isinstance(reply, Exception):
                raise reply
            await stream.send_message(reply)

        return answer


def captured_message(raw, message):
    fields = {
        key: field for field in message.fields for key in (field.name, field.json_name)
    }
    for name, value in raw.items():
        item = fields.get(name)
        if item and item.type == item.TYPE_BYTES and isinstance(value, list):
            raw[name] = base64.b64encode(bytes(value)).decode()
        if item and item.message_type and isinstance(value, list):
            for child in value:
                captured_message(child, item.message_type)
        elif item and item.message_type and isinstance(value, dict):
            captured_message(value, item.message_type)
    return raw


def run_with_verifier_fixture(check):
    class Fixture(suite.VerifierTest):
        async def runTest(self):
            await check(self)

    with patch.object(suite, "FixtureWire", SpawnWire):
        result = Fixture().run()
    assert result.wasSuccessful(), "\n".join(
        trace for _, trace in result.errors + result.failures
    )


def test_scrubbed_live_pair_preserves_definition_and_resource_fences():
    run_with_verifier_fixture(verify)


async def verify(self):
    captures = json.loads(CAPTURE.read_bytes())

    def configure(key, bounds):
        self.fixture.load(
            key
        )  # include the corresponding volume and file-read responses
        loaded = captures[key]
        lookup = wire.FunctionGetResponse()
        schedule = wire.FunctionGetSchedulingParamsResponse()
        for name, payload, message in (
            ("FunctionGet", loaded["lookup"], lookup),
            ("FunctionGetSchedulingParams", loaded["schedule"], schedule),
        ):
            self.fixture.replies[name] = ParseDict(
                captured_message(copy.deepcopy(payload), message.DESCRIPTOR),
                message,
            )
        variant = getattr(lookup.function.ranked_functions[0], "function")
        return lookup, variant, replace(bounds, app_name=variant.app_name)

    async def read(bounds):
        return await inspect.aio(self.client, bounds, self.pins, reader=self.manifest)

    lookup, variant, gpu = configure("tempseg", suite.GPU)
    accepted = await read(gpu)
    assert accepted.function_id == lookup.function_id
    assert accepted.definition_id == f"definition-sha256-{accepted.definition_sha256}"
    mount = variant.volume_mounts[0]
    assert mount.allow_background_commits and mount.read_only
    mount.allow_background_commits = False
    assert (await read(gpu)).definition_sha256 != accepted.definition_sha256
    mount.read_only = False
    with raises(DefinitionRejected):
        await read(gpu)
    mount.read_only = mount.allow_background_commits = True
    for key, value in (
        ("proxy_id", "px-Fixture"),
        ("routing_region", "eu-west"),
        ("cloud_provider_str", "gcp"),
        ("max_concurrent_inputs", 2),
        ("_experimental_buffer_containers", 1),
        ("_experimental_task_templates_enabled", True),
    ):
        setattr(variant, key, value)
        with raises(DefinitionRejected):
            await read(gpu)
        variant.ClearField(key)
    for mounts in ("cloud_bucket_mounts", "shared_volume_mounts", "s3_mounts"):
        getattr(variant, mounts).add()
        with raises(DefinitionRejected):
            await read(gpu)
        variant.ClearField(mounts)
    variant.single_use_containers = False
    assert (await read(gpu)).definition_sha256 != accepted.definition_sha256
    variant.single_use_containers = True
    lookup.function.http_config.proxy_regions.append("eu-west")
    with raises(DefinitionRejected):
        await read(gpu)
    lookup.function.http_config.ClearField("proxy_regions")
    with raises(DefinitionRejected):
        await read(replace(gpu, micro_usd_per_gpu_second=841))

    _, _, cpu = configure("handPose", replace(suite.CPU, max_billed_seconds=1350))
    assert await read(cpu)
    for change in ({"max_memory_mib": 8192}, {"micro_usd_per_cpu_second": 327}):
        with raises(DefinitionRejected):
            await read(replace(cpu, **change))
    self.fixture.replies[
        "FunctionGetSchedulingParams"
    ].autoscaler_configuration.settings.scaledown_window = 71
    with raises(DefinitionRejected):
        await read(cpu)


def test_controller_uses_real_binding_verification_and_fences_definition_or_app_drift(
    tmp_path,
):
    from stateaction_controller.config import Settings
    from stateaction_controller.modal_controller import SpawnNotSent
    from stateaction_controller.modal_executor import ModalExecutor
    from test_modal_executor import Sdk

    async def check(fixture):
        variant, bounds = fixture.load("handPose", suite.CPU)
        revision, params = "a" * 40, "b" * 64
        name = suite.immutable_app_name(bounds.module, revision, params)
        variant.app_name = name
        bounds = replace(bounds, app_name=name)
        definition = await inspect.aio(fixture.client, bounds, fixture.pins)
        binding = {
            "appName": name,
            "environment": bounds.environment,
            "gpu": "none",
            "codeRevision": revision,
            "paramsSha256": params,
            "functionId": definition.function_id,
            "definitionId": definition.definition_id,
            "definitionSha256": definition.definition_sha256,
            "maxContainers": 1,
            "maxCpuMilli": bounds.max_cpu_milli,
            "maxMemoryMib": bounds.max_memory_mib,
            "maxBilledSeconds": bounds.max_billed_seconds,
            "microUsdPerCpuSecond": bounds.micro_usd_per_cpu_second,
            "microUsdPerGpuSecond": 0,
        }
        settings = Settings(
            "modal",
            "https://example.test",
            tmp_path,
            app=name,
            function=bounds.object_tag,
            environment=bounds.environment,
            timeout=5,
        )
        sdk = Sdk()
        executor = ModalExecutor(settings, sdk, fixture.client)
        payload = {"schemaVersion": 1, "pipeline": "clip_plan_cpu_v1"}
        reply = suite.wire.FunctionMapResponse(function_call_id="fc-OfflineDispatch")
        reply.pipelined_inputs.add()
        fixture.fixture.replies["FunctionMap"] = reply
        assert (
            await executor.spawn(payload, lambda: True, binding)
            == reply.function_call_id
        )
        assert sdk.lookups == [(binding["functionId"], fixture.client)]
        fixture.fixture.replies["FunctionMap"] = suite.GRPCError(
            suite.Status.UNAVAILABLE, "synthetic lost acknowledgement"
        )
        with raises(RuntimeError, match="acknowledgement"):
            await executor.spawn(payload, lambda: True, binding)
        with raises(SpawnNotSent):
            await executor.spawn(
                payload, lambda: True, dict(binding, appName="wrong-app")
            )
        with raises(SpawnNotSent):
            await executor.spawn(payload, lambda: True, dict(binding, maxMemoryMib=100))
        variant.image_id = "im-ChangedUnderSameFunction"
        with raises(SpawnNotSent):
            await executor.spawn(payload, lambda: True, binding)
        assert len(sdk.lookups) == 2
        requests = [
            request
            for method, request in fixture.fixture.received
            if method == "FunctionMap"
        ]
        assert len(requests) == 2
        assert all(request.function_id == binding["functionId"] for request in requests)

    run_with_verifier_fixture(check)
