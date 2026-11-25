import asyncio
import base64
import json
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import modal
from modal.exception import FunctionTimeoutError
from modal.exception import TimeoutError as ModalTimeout
from modal.types import FunctionAutoscalerSettings, FunctionInfo, InputInfo
from modal_proto import api_pb2
from providers.modal_executor import (
    ModalExecutor,
    ModalSpawnNotSent,
    ModalSpawnUncertain,
    ModalTarget,
)

ROOT = Path(__file__).resolve().parents[3]
TARGET = ModalTarget("fixture-app", "process_recording", "main", "fu-Fixture")
CALL = "fc-Fixture"
BOOTSTRAP = {"pipeline": "hand_pose_cpu_v1", "schemaVersion": 1}


def aio(value=None):
    return SimpleNamespace(aio=AsyncMock(return_value=value))


class ExecutorTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.call = SimpleNamespace(
            object_id=CALL,
            get=aio({"schemaVersion": 1, "functionCallId": CALL, "exitCode": 7}),
            cancel=aio(),
            get_call_graph=aio([]),
        )
        self.function = SimpleNamespace(
            object_id=TARGET.function_id,
            hydrate=aio(),
            spawn=aio(self.call),
            info=aio("function summary"),
            autoscaler=SimpleNamespace(settings=aio("autoscaler summary")),
        )
        self.sdk = SimpleNamespace(
            Function=SimpleNamespace(
                from_id=Mock(return_value=self.function),
                from_name=Mock(return_value=self.function),
            ),
            FunctionCall=SimpleNamespace(from_id=Mock(return_value=self.call)),
            exception=modal.exception,
        )
        self.client = object()
        self.executor = ModalExecutor(TARGET, sdk=self.sdk, client=self.client)

    async def test_by_id_hydrates_then_checks_authorization_and_sends_single_json_arg(
        self,
    ):
        def allowed():
            self.function.hydrate.aio.assert_awaited_once()
            return True

        self.assertEqual(await self.executor.spawn(BOOTSTRAP, allowed), CALL)
        self.sdk.Function.from_id.assert_called_once_with(
            TARGET.function_id, client=self.client
        )
        self.function.spawn.aio.assert_awaited_once()
        args = self.function.spawn.aio.await_args.args
        self.assertEqual(len(args), 1)
        self.assertEqual(json.loads(args[0]), BOOTSTRAP)

    async def test_versioned_name_checks_hydrated_identity(self):
        executor = ModalExecutor(
            replace(TARGET, version=3), sdk=self.sdk, client=self.client
        )
        self.assertEqual(
            await executor.inspect(), ("function summary", "autoscaler summary")
        )
        self.sdk.Function.from_name.assert_called_once_with(
            TARGET.app_name,
            TARGET.function_name,
            version=3,
            environment_name="main",
            client=self.client,
        )
        self.function.object_id = "fu-other"
        with self.assertRaises(ModalSpawnNotSent):
            await executor.spawn(BOOTSTRAP, lambda: True)
        self.function.spawn.aio.assert_not_awaited()

    async def test_denied_lease_oversize_and_lookup_error_prevent_submission(self):
        for data, allowed in [(BOOTSTRAP, False), ({"x": "é" * 8192}, True)]:
            with self.assertRaises(ModalSpawnNotSent):
                await self.executor.spawn(data, lambda allowed=allowed: allowed)
        self.function.hydrate.aio.side_effect = RuntimeError("private")
        with self.assertRaises(ModalSpawnNotSent) as failed:
            await self.executor.spawn(BOOTSTRAP, lambda: True)
        self.assertNotIn("private", str(failed.exception))
        self.function.spawn.aio.assert_not_awaited()

    async def test_deadline_before_and_after_sdk_spawn(self):
        async def block(*args):
            await asyncio.Future()

        executor = ModalExecutor(
            TARGET, sdk=self.sdk, client=self.client, api_timeout=0.05
        )
        self.function.hydrate.aio.side_effect = block
        with self.assertRaises(ModalSpawnNotSent):
            await executor.spawn(BOOTSTRAP, lambda: True)
        self.function.spawn.aio.assert_not_awaited()

        self.function.hydrate.aio.side_effect = None
        self.function.spawn.aio.side_effect = block
        with self.assertRaises(ModalSpawnUncertain):
            await executor.spawn(BOOTSTRAP, lambda: True)
        self.function.spawn.aio.assert_awaited_once()

    async def test_lost_or_invalid_acknowledgement_is_uncertain(self):
        self.function.spawn.aio.side_effect = RuntimeError("private")
        with self.assertRaises(ModalSpawnUncertain) as failed:
            await self.executor.spawn(BOOTSTRAP, lambda: True)
        self.assertNotIn("private", str(failed.exception))
        self.function.spawn.aio.assert_awaited_once()

        self.function.spawn.aio.side_effect = None
        self.call.object_id = "fc-" + "Z" * 78
        with self.assertRaises(ModalSpawnUncertain):
            await self.executor.spawn(BOOTSTRAP, lambda: True)

    async def test_poll_adopts_by_id_and_errors_never_return_a_result(self):
        result = await self.executor.poll(CALL)
        self.assertEqual(result["kind"], "returned")
        self.assertEqual(result["value"]["functionCallId"], CALL)
        self.sdk.FunctionCall.from_id.assert_called_once_with(CALL, client=self.client)
        self.call.get.aio.assert_awaited_once_with(timeout=1)

        for error, kind, detail in [
            (FunctionTimeoutError("private"), "unavailable", "function_timeout"),
            (ModalTimeout("private"), "pending", "poll_timeout"),
            (TimeoutError("private"), "unavailable", "operation_timeout"),
            (RuntimeError("private"), "unavailable", "RuntimeError"),
        ]:
            with self.subTest(error=type(error).__name__):
                self.call.get.aio.side_effect = error
                self.assertEqual(
                    await self.executor.poll(CALL), {"kind": kind, "detail": detail}
                )

    async def test_cancel_requests_container_termination_and_graph_is_diagnostic(self):
        self.assertIsNone(await self.executor.cancel(CALL))
        self.call.cancel.aio.assert_awaited_once_with(terminate_containers=True)
        self.assertEqual(await self.executor.watch(CALL), [])
        self.call.get_call_graph.aio.assert_awaited_once()


class PinnedSdkTest(unittest.TestCase):
    def test_pinned_sdk_has_the_expected_public_methods(self):
        self.assertEqual(modal.__version__, "1.6.4")
        self.assertTrue(issubclass(FunctionTimeoutError, ModalTimeout))
        self.assertTrue(callable(modal.Function.hydrate.aio))
        self.assertTrue(callable(modal.Function.spawn.aio))
        self.assertTrue(callable(modal.Function.info.aio))
        self.assertTrue(callable(modal.FunctionCall.get.aio))
        self.assertTrue(callable(modal.FunctionCall.cancel.aio))
        self.assertTrue(callable(modal.FunctionCall.get_call_graph.aio))
        self.assertIn("task_id", InputInfo.__dataclass_fields__)
        self.assertNotIn("container_id", InputInfo.__dataclass_fields__)

    def test_ts_wire_fixture_loses_billing_and_override_evidence_in_public_summaries(
        self,
    ):
        fixture = ROOT / "apps/jobs/test/fixtures/modal-deployment-wire.json"
        wire = json.loads(fixture.read_text())["handPose"]
        lookup = api_pb2.FunctionGetResponse.FromString(
            base64.b64decode(wire["FunctionGet"])
        )
        variant = lookup.function.ranked_functions[0].function
        info = FunctionInfo._from_function_proto(lookup.function)
        self.assertGreater(variant.resources.memory_mb, variant.resources.memory_mb_max)
        self.assertEqual(info.memory_mib, variant.resources.memory_mb_max)
        self.assertGreater(variant.startup_timeout_secs, 0)
        self.assertEqual(info.startup_timeout, 0)
        self.assertFalse(hasattr(info, "definition_id"))

        normal, changed = [
            api_pb2.FunctionGetSchedulingParamsResponse.FromString(
                base64.b64decode(wire[key])
            ).autoscaler_configuration
            for key in ("FunctionGetSchedulingParams", "DefinedZeroOverride")
        ]
        self.assertFalse(normal.override_settings.ListFields())
        self.assertTrue(changed.override_settings.HasField("min_containers"))
        self.assertEqual(changed.override_settings.min_containers, 0)
        project = FunctionAutoscalerSettings._from_proto
        self.assertEqual(project(normal.settings), project(changed.settings))
