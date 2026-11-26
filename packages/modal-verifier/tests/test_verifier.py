"""Real Python SDK to local HTTP/2 gRPC using the repository's Modal bytes."""

import asyncio
import base64
import copy
import hashlib
import inspect as reflection
import json
import unittest
import warnings
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from google.protobuf.message_factory import GetMessageClass
from grpclib.const import Cardinality, Handler, Status
from grpclib.exceptions import GRPCError
from grpclib.server import Server
from modal import Client
from modal.exception import InternalAPIWarning
from modal._grpc_client import UnaryUnaryWrapper
from modal._utils.async_utils import synchronizer
from modal_proto import api_pb2 as wire
from stateaction_modal_verifier.verifier import (
    Bounds,
    DefinitionRejected,
    ModalProtocolChanged,
    check_client,
    check_sdk,
    immutable_app_name,
    inspect,
    ReadPolicy,
    warm,
    probe_gpu_watch,
    read_manifest,
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
        self.schedule_gate = None
        self.schedule_error = None
        self.watch_error = None
        self.deadlines = {}

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
            self.deadlines[method] = stream.deadline
            self.received.append((method, request))
            if method == "AuthTokenGet":
                reply = wire.AuthTokenGetResponse(token="loopback-only")
            elif method == "ClientHello":
                reply = wire.ClientHelloResponse()
            else:
                reply = self.replies[method]
            if (
                method == "FunctionGetSchedulingParams"
                and self.schedule_gate is not None
            ):
                await self.schedule_gate.wait()
            if method == "FunctionGetSchedulingParams" and self.schedule_error:
                raise GRPCError(self.schedule_error, "private provider message")
            if method == "FunctionCallFetch" and self.watch_error:
                raise GRPCError(self.watch_error, "watchdog unavailable")
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
        self.client = await Client.from_env.aio(
            _override_config={
                "token_id": "fixture",
                "token_secret": "offline",
                "server_url": f"http://127.0.0.1:{port}",
            }
        )
        self.addAsyncCleanup(self.client.close.aio)
        self.filter = warnings.catch_warnings()
        self.filter.__enter__()
        warnings.filterwarnings(
            "ignore",
            message=r"^`modal\.Client\.stub` provides direct access",
            category=InternalAPIWarning,
        )
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
        result = await inspect.aio(self.client, bounds, self.pins)
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
        result = await inspect.aio(self.client, bounds, self.pins, reader=self.manifest)
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
            await probe_gpu_watch.aio(self.client, result.function_id, "fc-Fixture"),
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
            await inspect.aio(self.client, bounds, self.pins)

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
                    await inspect.aio(self.client, replace(bounds, **caps), self.pins)

    async def test_outer_variant_and_scheduling_fail_closed(self):
        def change_outer(fn, handle, label):
            if label == "schedule":
                fn.schedule.cron.cron_string = "0 0 * * *"
            elif label == "http":
                fn.http_config.port = 123
            elif label == "alternate":
                fn.is_class = True
            elif label == "warm":
                fn.autoscaler_settings.min_containers = 1
            elif label == "handle":
                handle.is_method = True
            else:
                fn.ranked_functions.add(rank=1)

        for change in ("schedule", "http", "alternate", "warm", "handle", "rank"):
            with self.subTest(change=change):
                _, bounds = self.load("handPose", CPU)
                response = self.fixture.replies["FunctionGet"]
                change_outer(response.function, response.handle_metadata, change)
                rejection = (
                    "function_identity" if change == "rank" else "execution_handle"
                )
                with self.assertRaisesRegex(DefinitionRejected, f"^{rejection}$"):
                    await inspect.aio(self.client, bounds, self.pins)

        for field, value in (
            ("cloud_provider_str", "fixture"),
            ("max_concurrent_inputs", 2),
            ("target_concurrent_inputs", 2),
            ("max_inputs", 2),
            ("batch_max_size", 2),
            ("batch_linger_ms", 1),
            ("function_serialized", b"fixture"),
            ("class_serialized", b"fixture"),
            ("checkpointing_enabled", True),
            ("i6pn_enabled", True),
            ("proxy_id", "pr-fixture"),
        ):
            with self.subTest(field=field):
                variant, bounds = self.load("handPose", CPU)
                setattr(variant, field, value)
                with self.assertRaisesRegex(DefinitionRejected, "^variant_execution$"):
                    await inspect.aio(self.client, bounds, self.pins)

        for field, value in (
            ("max_containers", 0),
            ("max_containers", 2),
            ("min_containers", 1),
            ("buffer_containers", 1),
            ("scaledown_window", None),
        ):
            with self.subTest(field=field, value=value):
                _, bounds = self.load("handPose", CPU)
                config = self.fixture.replies[
                    "FunctionGetSchedulingParams"
                ].autoscaler_configuration
                if value is None:
                    config.settings.ClearField(field)
                else:
                    setattr(config.settings, field, value)
                with self.assertRaisesRegex(
                    DefinitionRejected, "^effective_autoscaler$"
                ):
                    await inspect.aio(self.client, bounds, self.pins)

    async def test_gpu_verification_requires_the_watchdog_read(self):
        variant, bounds = self.load("tempseg", GPU)
        revision, params = "a" * 40, "b" * 64
        name = immutable_app_name(bounds.module, revision, params)
        variant.app_name = name
        bounds = replace(bounds, app_name=name)
        inspection = await inspect.aio(
            self.client, bounds, self.pins, reader=self.manifest
        )
        binding = dict(
            configured_app=name,
            configured_environment="main",
            code_revision=revision,
            params_sha256=params,
            function_id=inspection.function_id,
            definition_id=inspection.definition_id,
            definition_sha256=inspection.definition_sha256,
            reader=self.manifest,
        )
        self.fixture.replies["FunctionCallFetch"] = wire.FunctionCallFetchResponse()
        self.assertEqual(
            await verify_binding.aio(self.client, bounds, self.pins, **binding),
            inspection,
        )
        self.assertEqual(
            dict(self.fixture.received)["FunctionCallFetch"].function_id,
            inspection.function_id,
        )
        self.fixture.watch_error = Status.UNAVAILABLE
        with self.assertRaisesRegex(Exception, "watchdog unavailable"):
            await verify_binding.aio(self.client, bounds, self.pins, **binding)
        with self.assertRaisesRegex(DefinitionRejected, "^configured_environment$"):
            await verify_binding.aio(
                self.client,
                bounds,
                self.pins,
                **(binding | {"configured_environment": "other"}),
            )

    async def test_gpu_manifest_and_mount_fail_closed(self):
        variant, bounds = self.load("tempseg", GPU)
        variant.volume_mounts[0].read_only = False
        with self.assertRaisesRegex(DefinitionRejected, "^volume_mount$"):
            await inspect.aio(self.client, bounds, self.pins, reader=self.manifest)
        _, bounds = self.load("tempseg", GPU)
        self.pins["checkpoints"]["tempseg"]["manifestSha256"] = "0" * 64
        with self.assertRaisesRegex(DefinitionRejected, "^volume_digest$"):
            await inspect.aio(self.client, bounds, self.pins, reader=self.manifest)

    async def test_binding_tracks_same_id_drift_and_excludes_transport_address(self):
        variant, bounds = self.load("handPose", CPU)
        revision, params = "a" * 40, "b" * 64
        name = immutable_app_name(bounds.module, revision, params)
        variant.app_name = name
        bounds = replace(bounds, app_name=name)
        first = await inspect.aio(self.client, bounds, self.pins)
        args = dict(
            configured_app=name,
            configured_environment="main",
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
            await verify_binding.aio(self.client, bounds, self.pins, **args), first
        )
        variant.image_id = "im-ChangedUnderSameFunction"
        with self.assertRaisesRegex(DefinitionRejected, "^bound_deployment_drift$"):
            await verify_binding.aio(self.client, bounds, self.pins, **args)
        with self.assertRaisesRegex(DefinitionRejected, "^immutable_app_name$"):
            await verify_binding.aio(
                self.client, bounds, self.pins, **(args | {"code_revision": "c" * 40})
            )

    async def test_scrubbed_live_cpu_variant_and_unnamed_registration(self):
        shape = json.loads(
            (
                Path(__file__).parent / "fixtures/phase2-hosted-function-get.json"
            ).read_text()
        )
        reply = decode("FunctionGet", shape["FunctionGet"])
        # The live FunctionGet scheduling read timed out. Pair the observed
        # variant with the declared, simulated CPU autoscaler settings.
        scheduling = wire.FunctionGetSchedulingParamsResponse()
        scheduling.autoscaler_configuration.settings.max_containers = 1
        scheduling.autoscaler_configuration.settings.scaledown_window = 5
        self.fixture.replies.update(
            FunctionGet=reply, FunctionGetSchedulingParams=scheduling
        )
        bounds = replace(
            CPU,
            app_name=shape["appName"],
            object_tag="identity_probe",
            max_cpu_milli=500,
            max_billed_seconds=180,
            micro_usd_per_cpu_second=200,
        )
        result = await inspect.aio(self.client, bounds, self.pins)
        self.assertEqual(result.function_id, "fu-HostedFixture")
        self.assertEqual(result.image_id, "im-HostedFixture")
        self.assertEqual(result.cpu_milli, 500)
        getattr(reply.function.ranked_functions[0], "function").app_name = ""
        with self.assertRaisesRegex(DefinitionRejected, "^variant_identity$"):
            await inspect.aio(self.client, bounds, self.pins)

    async def test_delayed_scheduling_read_expires_the_aggregate_deadline(self):
        _, bounds = self.load("handPose", CPU)
        self.fixture.schedule_gate = asyncio.Event()
        results = []
        with self.assertRaises(TimeoutError):
            await inspect.aio(
                self.client,
                bounds,
                self.pins,
                policy=ReadPolicy(
                    rpc_seconds=2, total_seconds=0.25, report=results.append
                ),
            )
        self.assertEqual(results[-1].method, "FunctionGetSchedulingParams")
        self.assertEqual(results[-1].status, "CANCELLED")
        requests = dict(self.fixture.received)
        self.assertEqual(
            requests["FunctionGetSchedulingParams"].function_id,
            self.fixture.replies["FunctionGet"].function_id,
        )
        self.fixture.schedule_gate.set()
        proof = await inspect.aio(self.client, bounds, self.pins)
        self.assertEqual(proof.billed_seconds, 1240)

    async def test_volume_metadata_presigned_url_and_attachment_rejections(self):
        for reason, change in (
            (
                "volume_identity",
                lambda mount, details, listing: setattr(
                    listing.items[0].metadata, "name", "different-models"
                ),
            ),
            (
                "volume_identity",
                lambda mount, details, listing: setattr(
                    listing.items[0].metadata, "version", 0
                ),
            ),
            (
                "volume_descriptor",
                lambda mount, details, listing: details.get_urls.append(
                    "https://extra.invalid"
                ),
            ),
            (
                "volume_descriptor",
                lambda mount, details, listing: setattr(details, "size", 65537),
            ),
            (
                "volume_url",
                lambda mount, details, listing: details.get_urls.__setitem__(
                    0, "http://example.invalid"
                ),
            ),
            (
                "volume_url",
                lambda mount, details, listing: details.get_urls.__setitem__(
                    0, "https://user@example.invalid"
                ),
            ),
            (
                "attachment_closure",
                lambda mount, details, listing: mount.shared_volume_mounts.add(),
            ),
            (
                "attachment_closure",
                lambda mount, details, listing: mount.cloud_bucket_mounts.add(),
            ),
            (
                "attachment_closure",
                lambda mount, details, listing: mount.s3_mounts.add(),
            ),
        ):
            with self.subTest(reason=reason):
                variant, bounds = self.load("tempseg", GPU)
                change(
                    variant,
                    self.fixture.replies["VolumeGetFile2"],
                    self.fixture.replies["VolumeList"],
                )
                with self.assertRaisesRegex(DefinitionRejected, f"^{reason}$"):
                    await inspect.aio(
                        self.client, bounds, self.pins, reader=self.manifest
                    )

    async def test_gpu_resources_and_event_override_reject(self):
        for reason, change, tweaks in (
            (
                "gpu_resources",
                lambda variant, config: setattr(
                    variant.resources.gpu_config, "count", 2
                ),
                {},
            ),
            (
                "gpu_resources",
                lambda variant, config: setattr(
                    variant.resources.gpu_config, "gpu_type", "H100"
                ),
                {},
            ),
            (
                "gpu_resources",
                lambda variant, config: None,
                {"micro_usd_per_gpu_second": 841},
            ),
            (
                "variant_execution",
                lambda variant, config: variant.scheduler_placement.SetInParent(),
                {},
            ),
            (
                "effective_autoscaler",
                lambda variant, config: config.override_events["fixture"].SetInParent(),
                {},
            ),
        ):
            with self.subTest(reason=reason):
                variant, bounds = self.load("tempseg", GPU)
                change(
                    variant,
                    self.fixture.replies[
                        "FunctionGetSchedulingParams"
                    ].autoscaler_configuration,
                )
                with self.assertRaisesRegex(DefinitionRejected, f"^{reason}$"):
                    await inspect.aio(
                        self.client,
                        replace(bounds, **tweaks),
                        self.pins,
                        reader=self.manifest,
                    )

    async def test_wrong_loop_fails_before_any_rpc(self):
        with self.assertRaisesRegex(ModalProtocolChanged, "owning event loop"):
            check_client(synchronizer._translate_in(self.client))
        self.assertEqual(self.fixture.received, [])

    async def test_public_sdk_transport_runs_its_raw_calls_on_the_owning_loop(self):
        _, bounds = self.load("handPose", CPU)
        client = synchronizer._translate_in(self.client)
        owner = client._cancellation_context_event_loop
        self.assertIsNot(owner, asyncio.get_running_loop())
        await warm.aio(self.client)
        results = []

        def observe(result):
            self.assertIs(asyncio.get_running_loop(), owner)
            results.append(result)

        result = await inspect.aio(
            self.client, bounds, self.pins, policy=ReadPolicy(report=observe)
        )
        self.assertEqual(result.billed_seconds, 1240)
        self.assertEqual(
            [(row.method, row.status) for row in results],
            [("FunctionGet", "OK"), ("FunctionGetSchedulingParams", "OK")],
        )
        self.assertTrue(all(row.elapsed_ms >= 0 for row in results))

    async def test_each_rpc_carries_a_deadline_and_an_error_is_not_retried(self):
        _, bounds = self.load("handPose", CPU)
        self.fixture.schedule_error = Status.UNAVAILABLE
        results = []
        with self.assertRaisesRegex(Exception, "private provider message"):
            await inspect.aio(
                self.client, bounds, self.pins, policy=ReadPolicy(report=results.append)
            )
        target = ["FunctionGet", "FunctionGetSchedulingParams"]
        observed = [method for method, _ in self.fixture.received if method in target]
        self.assertEqual(observed, target)
        self.assertTrue(
            all(self.fixture.deadlines[method] is not None for method in target)
        )
        self.assertEqual([row.status for row in results], ["OK", "UNAVAILABLE"])
        self.assertNotIn("private", repr(results))

    async def test_rpc_deadline_expires_before_aggregate_deadline(self):
        _, bounds = self.load("handPose", CPU)
        await warm.aio(self.client)
        self.fixture.schedule_gate = asyncio.Event()
        results = []
        with self.assertRaises(TimeoutError):
            await inspect.aio(
                self.client,
                bounds,
                self.pins,
                policy=ReadPolicy(
                    rpc_seconds=0.25, total_seconds=2, report=results.append
                ),
            )
        self.assertEqual(
            [(row.method, row.status) for row in results],
            [
                ("FunctionGet", "OK"),
                ("FunctionGetSchedulingParams", "DEADLINE_EXCEEDED"),
            ],
        )

    async def test_private_stub_contract(self):
        raw = synchronizer._translate_in(self.client)
        for name in (
            "ClientHello",
            "FunctionGet",
            "FunctionGetSchedulingParams",
            "VolumeList",
            "VolumeGetFile2",
            "FunctionCallFetch",
        ):
            method = getattr(raw.stub, name)
            self.assertIsInstance(method, UnaryUnaryWrapper)
            self.assertEqual(
                tuple(reflection.signature(method).parameters),
                ("req", "retry", "timeout", "metadata"),
            )
            self.assertEqual(method.name, f"/modal.client.ModalClient/{name}")

    def test_exact_sdk_and_descriptor_contract(self):
        check_sdk()
        with patch(
            "stateaction_modal_verifier.verifier.PROTO_DESCRIPTOR_SHA256", "changed"
        ):
            with self.assertRaises(ModalProtocolChanged):
                check_sdk()
        with patch(
            "stateaction_modal_verifier.verifier.version", return_value="different"
        ):
            with self.assertRaises(ModalProtocolChanged):
                check_sdk()


if __name__ == "__main__":
    unittest.main()


class ManifestReaderTest(unittest.IsolatedAsyncioTestCase):
    async def test_exact_body_no_redirect_no_compression_and_scrubbed_failure(self):
        requests = []

        async def manifest(request):
            requests.append((request.path, request.headers["Accept-Encoding"]))
            if request.path == "/redirect":
                raise web.HTTPFound("/good")
            if request.path == "/error":
                return web.Response(status=500)
            return web.Response(body=b"abc")

        app = web.Application()
        app.router.add_get("/{path}", manifest)
        runner = web.AppRunner(app)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = runner.addresses[0][1]
        host = f"http://127.0.0.1:{port}"
        self.assertEqual(await read_manifest(f"{host}/good", 3), b"abc")
        for path, size, reason in (
            ("redirect", 3, "volume_http_status"),
            ("error", 3, "volume_http_status"),
            ("long", 2, "volume_manifest_size"),
            ("short", 4, "volume_http_read"),
        ):
            with (
                self.subTest(path=path),
                self.assertRaisesRegex(DefinitionRejected, f"^{reason}$"),
            ):
                await read_manifest(f"{host}/{path}?token=fixture", size)
        self.assertEqual(
            requests,
            [
                (f"/{name}", "identity")
                for name in ("good", "redirect", "error", "long", "short")
            ],
        )
