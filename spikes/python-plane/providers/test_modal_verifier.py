"""Real Python SDK to local HTTP/2 gRPC using the repository's Modal bytes."""

import base64
import copy
import hashlib
import json
import unittest
import warnings
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from google.protobuf.message_factory import GetMessageClass
from grpclib.const import Cardinality, Handler
from grpclib.server import Server
from modal.client import _Client
from modal_proto import api_pb2 as wire
from providers.modal_verifier import (
    Bounds,
    DefinitionRejected,
    ModalProtocolChanged,
    check_sdk,
    immutable_app_name,
    inspect,
    probe_gpu_watch,
    verify_binding,
)

ROOT = Path(__file__).resolve().parents[3]
RECORDS = json.loads(
    (ROOT / "apps/jobs/test/fixtures/modal-deployment-wire.json").read_text()
)
PINS = json.loads(
    (ROOT / "packages/contracts/api/flora-checkpoints.v1.json").read_text()
)
MANIFEST = b"published checkpoint"


def decode(method, data):
    method_desc = wire.DESCRIPTOR.services_by_name["ModalClient"].methods_by_name[
        method
    ]
    return GetMessageClass(method_desc.output_type).FromString(base64.b64decode(data))


CPU = Bounds(
    "unused",
    "main",
    "process_recording",
    "hand_pose_cpu_v1@1",
    "none",
    1,
    4000,
    26215,
    1250,
    328,
    0,
)
GPU = Bounds(
    "unused",
    "main",
    "flora_tempseg",
    "flora_tempseg_vllm_fp8@1",
    "RTX-PRO-6000",
    1,
    8000,
    65536,
    930,
    247,
    842,
)


class FixtureWire:
    def __init__(self):
        self.replies = {}
        self.received = []

    def __mapping__(self):
        service = wire.DESCRIPTOR.services_by_name["ModalClient"]
        methods = {
            "AuthTokenGet",
            "ClientHello",
            "FunctionGet",
            "FunctionGetSchedulingParams",
            "VolumeList",
            "VolumeGetFile2",
            "FunctionCallFetch",
        }
        return {
            f"/{service.full_name}/{name}": Handler(
                self.handle(name),
                Cardinality.UNARY_UNARY,
                GetMessageClass(service.methods_by_name[name].input_type),
                GetMessageClass(service.methods_by_name[name].output_type),
            )
            for name in methods
        }

    def handle(self, method):
        async def answer(stream):
            request = await stream.recv_message()
            self.received.append((method, request))
            if method == "AuthTokenGet":
                reply = wire.AuthTokenGetResponse(token="loopback-only")
            elif method == "ClientHello":
                reply = wire.ClientHelloResponse()
            else:
                reply = self.replies[method]
            await stream.send_message(reply)

        return answer

    def load(self, key):
        self.replies = {
            method: decode(method, value)
            for method, value in RECORDS[key].items()
            if method != "DefinedZeroOverride"
        }
        return getattr(
            self.replies["FunctionGet"].function.ranked_functions[0], "function"
        )


class VerifierTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = FixtureWire()
        self.server = Server([self.fixture])
        await self.server.start("127.0.0.1", 0)
        port = self.server._server.sockets[0].getsockname()[1]
        self.addAsyncCleanup(self.close_server)
        self.client = _Client(
            f"http://127.0.0.1:{port}", wire.CLIENT_TYPE_CLIENT, ("fixture", "offline")
        )
        await self.client.__aenter__()
        self.addAsyncCleanup(self.client.close)
        self.filter = warnings.catch_warnings()
        self.filter.__enter__()
        warnings.filterwarnings("ignore", message=".*Client.stub.*")
        self.addCleanup(self.filter.__exit__, None, None, None)
        self.pins = copy.deepcopy(PINS)
        self.pins["checkpoints"]["tempseg"]["manifestSha256"] = hashlib.sha256(
            MANIFEST
        ).hexdigest()

    async def close_server(self):
        self.server.close()
        await self.server.wait_closed()

    async def manifest(self, url, size):
        self.assertEqual(url, "https://volume.example.test/checkpoint")
        self.assertEqual(size, len(MANIFEST))
        return MANIFEST

    def load(self, key, bounds):
        variant = self.fixture.load(key)
        return variant, replace(bounds, app_name=variant.app_name)

    async def test_cpu_raw_identity_bounds_and_exact_request(self):
        variant, bounds = self.load("handPose", CPU)
        result = await inspect(self.client, bounds, self.pins)
        self.assertEqual(result.image_id, variant.image_id)
        self.assertEqual(result.memory_mib, 26215)
        self.assertEqual(result.cpu_milli, 4000)
        self.assertEqual(result.billed_seconds, 1240)
        self.assertEqual(
            result.definition_id, f"definition-sha256-{result.definition_sha256}"
        )
        calls = dict(self.fixture.received)
        lookup = calls["FunctionGet"]
        self.assertEqual(
            (
                lookup.app_name,
                lookup.object_tag,
                lookup.environment_name,
                lookup.app_version,
            ),
            (bounds.app_name, bounds.object_tag, "main", 0),
        )
        self.assertEqual(
            calls["FunctionGetSchedulingParams"].function_id, result.function_id
        )

    async def test_gpu_volume_and_exact_call_watchdog(self):
        variant, bounds = self.load("tempseg", GPU)
        result = await inspect(self.client, bounds, self.pins, reader=self.manifest)
        self.assertEqual(result.image_id, variant.image_id)
        calls = dict(self.fixture.received)
        self.assertEqual(calls["VolumeList"].environment_name, "main")
        manifest = calls["VolumeGetFile2"]
        self.assertEqual(manifest.volume_id, variant.volume_mounts[0].volume_id)
        self.assertEqual(
            manifest.path,
            f"flora/{self.pins['checkpoints']['tempseg']['checkpointId']}/MANIFEST.json",
        )
        self.fixture.replies["FunctionCallFetch"] = wire.FunctionCallFetchResponse(
            function_call_inputs=[
                wire.FunctionCallInputInfo(
                    container_id="ta-exact", function_call_id="fc-Fixture"
                ),
                wire.FunctionCallInputInfo(
                    container_id="ta-other", function_call_id="fc-Other"
                ),
            ],
        )
        self.assertEqual(
            await probe_gpu_watch(self.client, result.function_id, "fc-Fixture"),
            ["ta-exact"],
        )
        request = dict(self.fixture.received)["FunctionCallFetch"]
        self.assertTrue(request.all_variants)
        self.assertEqual(request.tail.count, 10)
        self.assertEqual(request.function_id, result.function_id)

    async def test_defined_zero_override_is_rejected(self):
        _, bounds = self.load("handPose", CPU)
        self.fixture.replies["FunctionGetSchedulingParams"] = decode(
            "FunctionGetSchedulingParams",
            RECORDS["handPose"]["DefinedZeroOverride"],
        )
        with self.assertRaisesRegex(DefinitionRejected, "^effective_autoscaler$"):
            await inspect(self.client, bounds, self.pins)

    async def test_effective_bounds_and_attachments_reject(self):
        def set_field(target, name, value):
            setattr(target, name, value)

        cases = [
            (
                "cpu_memory_disk",
                lambda v, r: set_field(v.resources, "ephemeral_disk_mb", 2_000_000),
                {},
            ),
            (
                "cpu_memory_disk",
                lambda v, r: set_field(v.resources, "milli_cpu_max", 0),
                {},
            ),
            (
                "gpu_resources",
                lambda v, r: set_field(v.resources.gpu_config, "count", 1),
                {},
            ),
            ("cpu_rate", lambda v, r: None, {"micro_usd_per_cpu_second": 327}),
            ("billed_wall", lambda v, r: None, {"max_billed_seconds": 1239}),
            (
                "variant_execution",
                lambda v, r: set_field(v.retry_policy, "retries", 1),
                {},
            ),
            (
                "variant_execution",
                lambda v, r: v.scheduler_placement.regions.append("fixture"),
                {},
            ),
            ("variant_identity", lambda v, r: set_field(v, "image_id", ""), {}),
            (
                "execution_handle",
                lambda v, r: set_field(
                    r.handle_metadata, "base_function_id", "fu-other"
                ),
                {},
            ),
            ("attachment_closure", lambda v, r: v.secret_ids.append("st-fixture"), {}),
            (
                "unexpected_volume",
                lambda v, r: v.volume_mounts.add(volume_id="vo-fixture"),
                {},
            ),
        ]
        for label, change, caps in cases:
            with self.subTest(label=label):
                variant, bounds = self.load("handPose", CPU)
                change(variant, self.fixture.replies["FunctionGet"])
                with self.assertRaisesRegex(DefinitionRejected, f"^{label}$"):
                    await inspect(self.client, replace(bounds, **caps), self.pins)

    async def test_gpu_manifest_and_mount_fail_closed(self):
        variant, bounds = self.load("tempseg", GPU)
        variant.volume_mounts[0].read_only = False
        with self.assertRaisesRegex(DefinitionRejected, "^volume_mount$"):
            await inspect(self.client, bounds, self.pins, reader=self.manifest)
        _, bounds = self.load("tempseg", GPU)
        self.pins["checkpoints"]["tempseg"]["manifestSha256"] = "0" * 64
        with self.assertRaisesRegex(DefinitionRejected, "^volume_digest$"):
            await inspect(self.client, bounds, self.pins, reader=self.manifest)

    async def test_binding_tracks_same_id_drift_and_excludes_transport_address(self):
        variant, bounds = self.load("handPose", CPU)
        revision, params = "a" * 40, "b" * 64
        name = immutable_app_name(bounds.module, revision, params)
        variant.app_name = name
        bounds = replace(bounds, app_name=name)
        first = await inspect(self.client, bounds, self.pins)
        args = dict(
            code_revision=revision,
            params_sha256=params,
            function_id=first.function_id,
            definition_id=first.definition_id,
            definition_sha256=first.definition_sha256,
        )
        handle = self.fixture.replies["FunctionGet"].handle_metadata
        handle.input_plane_url = "https://example.invalid"
        handle.input_plane_region = "fixture"
        self.assertEqual(
            await verify_binding(self.client, bounds, self.pins, **args), first
        )
        variant.image_id = "im-ChangedUnderSameFunction"
        with self.assertRaisesRegex(DefinitionRejected, "^bound_deployment_drift$"):
            await verify_binding(self.client, bounds, self.pins, **args)
        with self.assertRaisesRegex(DefinitionRejected, "^immutable_app_name$"):
            await verify_binding(
                self.client, bounds, self.pins, **(args | {"code_revision": "c" * 40})
            )

    def test_exact_sdk_and_descriptor_contract(self):
        check_sdk()
        with patch("providers.modal_verifier.PROTO_DESCRIPTOR_SHA256", "changed"):
            with self.assertRaises(ModalProtocolChanged):
                check_sdk()
        with patch("providers.modal_verifier.version", return_value="different"):
            with self.assertRaises(ModalProtocolChanged):
                check_sdk()


if __name__ == "__main__":
    unittest.main()
