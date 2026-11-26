import json
import os
import shutil
import sys
import unittest
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path
from unittest.mock import AsyncMock


from google.protobuf.empty_pb2 import Empty
from google.protobuf.message_factory import GetMessageClass
from modal import Client
from modal.exception import NotFoundError
from modal_proto import api_pb2 as wire

from test_verifier import FixtureWire, decode
from grpclib.server import Server
from grpclib.const import Cardinality, Handler, Status
from stateaction_modal_verifier.verifier import ReadPolicy, Scheduling

OPERATOR = Path(__file__).resolve().parents[1] / "operator"
sys.path.insert(0, str(OPERATOR))
from window import OWNER_TAG, ModalWindow, WindowFailed, deploy_once, run_window  # noqa: E402

SCHEDULE = Scheduling(1, None, None, 5, False, False)
APP_ID = "ap-Comparison"
FUNCTION_ID = "fu-Comparison"
NAME = "sa-152-probe-0000000000000000"
OWNER = "local-dispatch"
WORKSPACE = "fixture-workspace"


class WindowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        fixture = FixtureWire()
        fixture.load("handPose")
        shape = json.loads(
            (
                OPERATOR.parent / "tests/fixtures/phase2-hosted-function-get.json"
            ).read_text()
        )
        definition = decode("FunctionGet", shape["FunctionGet"])
        definition.function_id = FUNCTION_ID
        definition.handle_metadata.app_id = APP_ID
        definition.handle_metadata.function_name = "scheduling_probe"
        definition.handle_metadata.base_function_id = FUNCTION_ID
        definition.function.function_name = "scheduling_probe"
        variant = getattr(definition.function.ranked_functions[0], "function")
        variant.app_name = NAME
        variant.function_name = "scheduling_probe"
        fixture.replies["FunctionGet"] = definition
        scheduling = fixture.replies["FunctionGetSchedulingParams"]
        scheduling.autoscaler_configuration.Clear()
        scheduling.autoscaler_configuration.settings.max_containers = 1
        scheduling.autoscaler_configuration.settings.scaledown_window = 5
        self.fixture = fixture
        server = Server([fixture])
        await server.start("127.0.0.1", 0)

        async def close():
            server.close()
            await server.wait_closed()

        self.addAsyncCleanup(close)
        self.endpoint = f"http://127.0.0.1:{server._server.sockets[0].getsockname()[1]}"
        self.client = await Client.from_env.aio(
            _override_config={
                "server_url": self.endpoint,
                "token_id": "fixture",
                "token_secret": "offline",
            }
        )
        self.addAsyncCleanup(self.client.close.aio)
        self.provider = ModalWindow(
            self.client,
            NAME,
            ReadPolicy(),
            self.endpoint,
            os.environ
            | {
                "STATEACTION_MODAL_TEST": "loopback",
                "MODAL_CONFIG_PATH": "/dev/null",
                "MODAL_TOKEN_ID": "fixture",
                "MODAL_TOKEN_SECRET": "offline",
            },
            OWNER,
            shutil.which("node"),
        )
        self.state = {}
        self.provider.preflight = AsyncMock()
        self.provider.call = self.lifecycle
        self.calls = []
        self.current = wire.APP_STATE_DEPLOYED
        self.owner = OWNER

    async def lifecycle(self, method, request):
        self.calls.append((method, request))
        if method == "AppList":
            return wire.AppListResponse(
                apps=[
                    wire.AppListResponse.AppListItem(app_id=APP_ID, description=NAME),
                    wire.AppListResponse.AppListItem(
                        app_id="ap-Other", description="other"
                    ),
                ]
            )
        if method == "AppGetLifecycle":
            self.assertEqual(request.app_id, APP_ID)
            return wire.AppGetLifecycleResponse(
                lifecycle=wire.AppLifecycle(app_state=self.current)
            )
        if method == "AppStop":
            self.assertEqual(request.app_id, APP_ID)
            self.current = wire.APP_STATE_STOPPED
            return Empty()
        if method == "AppGetByDeploymentName":
            self.assertEqual(request.name, NAME)
            self.assertEqual(request.environment_name, "main")
            return wire.AppGetByDeploymentNameResponse()
        if method == "AppGetTags":
            self.assertEqual(request.app_id, APP_ID)
            return wire.AppGetTagsResponse(tags={OWNER_TAG: self.owner})
        if method == "WorkspaceNameLookup":
            return wire.WorkspaceNameLookupResponse(username=WORKSPACE)
        if method == "WorkspaceBillingSummary":
            self.assertEqual(request.start_timestamp.ToDatetime().day, 1)
            return wire.WorkspaceBillingSummaryResponse(metered_cost="20.01")
        if method == "FunctionGet":
            self.assertEqual(request.app_name, NAME)
            raise NotFoundError()
        self.fail(f"Unexpected method {method}")

    async def deploy(self, state, persist):
        state.update(createAttempted=True, appId=APP_ID)

    async def run_probe(self, expected_final="20"):
        meter = AsyncMock(side_effect=[Decimal("20"), Decimal(expected_final)])
        await run_window(self.provider, self.state, lambda: None, meter)
        self.assertEqual(meter.await_count, 2)

    async def test_compares_same_id_using_the_real_typescript_sdk(self):
        self.provider.deploy = self.deploy
        await self.run_probe()
        self.assertTrue(self.state["passed"])
        self.assertTrue(self.state["appStoppedAndAbsent"])
        self.assertEqual(self.state["typescriptSchedule"], asdict(SCHEDULE))
        self.assertEqual(self.state["typescriptRpc"]["status"], "OK")
        self.assertEqual(self.state["grossDeltaUsd"], "0")
        requests = [
            request.function_id
            for method, request in self.fixture.received
            if method == "FunctionGetSchedulingParams"
        ]
        self.assertEqual(requests, [FUNCTION_ID, FUNCTION_ID])

    async def test_preflight_reads_name_before_billing_and_refuses_collision(self):
        self.provider.preflight = ModalWindow.preflight.__get__(self.provider)
        meter = AsyncMock()
        with self.assertRaisesRegex(WindowFailed, "^app_name_in_use$"):
            await run_window(self.provider, self.state, lambda: None, meter)
        self.assertEqual(
            [method for method, _ in self.calls], ["AppGetByDeploymentName", "AppList"]
        )
        meter.assert_not_awaited()

    async def test_control_projection_drops_unexpected_fields_before_persisting(self):
        self.provider.deploy = self.deploy
        read_control = self.provider.typescript_read

        async def extra_fields(function_id):
            code, control = await read_control(function_id)
            control["rpc"].update(method="private", details="private")
            control["scheduling"]["private"] = "private"
            return code, control

        self.provider.typescript_read = extra_fields
        persisted = []
        meter = AsyncMock(return_value=Decimal("20"))
        await run_window(
            self.provider,
            self.state,
            lambda: persisted.append(json.dumps(self.state)),
            meter,
        )
        self.assertTrue(persisted)
        self.assertTrue(all("private" not in entry for entry in persisted))
        self.assertEqual(
            self.state["typescriptRpc"]["method"], "FunctionGetSchedulingParams"
        )

    async def test_stops_after_lost_create_acknowledgement(self):
        async def lost_ack(state, persist):
            state["createAttempted"] = True
            raise TimeoutError

        self.provider.deploy = lost_ack
        self.provider.python_read = AsyncMock()
        with self.assertRaises(TimeoutError):
            await self.run_probe()
        self.assertEqual(self.state["appId"], APP_ID)
        self.assertTrue(self.state["appStoppedAndAbsent"])
        self.assertEqual(self.state["grossAfterUsd"], "20")
        self.provider.python_read.assert_not_awaited()

    async def test_disagreement_still_stops_and_reads_gross(self):
        self.provider.deploy = self.deploy
        read_control = self.provider.typescript_read

        async def different_schedule(function_id):
            self.fixture.replies[
                "FunctionGetSchedulingParams"
            ].autoscaler_configuration.settings.scaledown_window = 6
            return await read_control(function_id)

        self.provider.typescript_read = different_schedule
        with self.assertRaisesRegex(WindowFailed, "^schedule_disagreement$"):
            await self.run_probe()
        self.assertTrue(self.state["appStoppedAndAbsent"])
        self.assertEqual(self.state["grossAfterUsd"], "20")

    async def test_gross_cutoff_still_restores_before_failure(self):
        self.provider.deploy = self.deploy
        with self.assertRaisesRegex(WindowFailed, "^gross_cutoff$"):
            await self.run_probe("20.26")
        self.assertTrue(self.state["appStoppedAndAbsent"])

    async def test_typescript_control_does_not_retry_unavailable(self):
        self.fixture.schedule_error = Status.UNAVAILABLE
        code, result = await self.provider.typescript_read(FUNCTION_ID)
        self.assertEqual(code, 1)
        self.assertEqual(result["rpc"]["status"], Status.UNAVAILABLE.value)
        schedule_requests = [
            method
            for method, _ in self.fixture.received
            if method == "FunctionGetSchedulingParams"
        ]
        self.assertEqual(schedule_requests, ["FunctionGetSchedulingParams"])

    async def test_cleanup_rejects_a_receipt_app_without_the_owner_tag(self):
        self.owner = "unrelated"
        with self.assertRaisesRegex(WindowFailed, "^app_ownership$"):
            await self.provider.restore(
                {"createAttempted": True, "appId": APP_ID}, lambda: None
            )
        self.assertEqual([method for method, _ in self.calls], ["AppGetTags"])

    async def test_workspace_and_gross_use_the_same_client(self):
        with self.assertRaisesRegex(WindowFailed, "^modal_workspace$"):
            await self.provider.verify_workspace("other")
        await self.provider.verify_workspace(WORKSPACE)
        self.assertEqual(await self.provider.gross(), Decimal("20.01"))


class DeployStubFixture(FixtureWire):
    def __mapping__(self):
        standard = super().__mapping__()
        service = wire.DESCRIPTOR.services_by_name["ModalClient"]
        for method in ("AppGetByDeploymentName", "AppCreate", "AppPublish"):
            descriptor = service.methods_by_name[method]
            standard[f"/{service.full_name}/{method}"] = Handler(
                self.handle(method),
                Cardinality.UNARY_UNARY,
                GetMessageClass(descriptor.input_type),
                GetMessageClass(descriptor.output_type),
            )
        return standard


class DeploymentFixture:
    async def deploy(self, environment_name, client):
        await client.stub.AppGetByDeploymentName(
            wire.AppGetByDeploymentNameRequest(
                name=NAME, environment_name=environment_name
            )
        )
        result = await client.stub.AppCreate(
            wire.AppCreateRequest(
                description=NAME,
                environment_name=environment_name,
                tags={OWNER_TAG: OWNER},
            )
        )
        self.app_id = result.app_id
        await client.stub.AppPublish(
            wire.AppPublishRequest(
                name=NAME,
                app_id=self.app_id,
                app_state=wire.APP_STATE_DEPLOYED,
                tags={OWNER_TAG: OWNER},
            )
        )


class DeployFenceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = DeployStubFixture()
        self.fixture.replies = {
            "AppGetByDeploymentName": wire.AppGetByDeploymentNameResponse(),
            "AppCreate": wire.AppCreateResponse(app_id=APP_ID),
            "AppPublish": wire.AppPublishResponse(),
        }
        server = Server([self.fixture])
        await server.start("127.0.0.1", 0)
        port = server._server.sockets[0].getsockname()[1]

        async def close():
            server.close()
            await server.wait_closed()

        self.addAsyncCleanup(close)
        self.client = await Client.from_env.aio(
            _override_config={
                "server_url": f"http://127.0.0.1:{port}",
                "token_id": "fixture",
                "token_secret": "offline",
            }
        )
        self.addAsyncCleanup(self.client.close.aio)

    async def test_deploy_records_exact_app_in_caller_receipt(self):
        state = {}
        records = []

        def record(**changes):
            state.update(changes)
            records.append(dict(state))

        await deploy_once.aio(self.client, DeploymentFixture(), NAME, OWNER, record)
        self.assertEqual(
            records,
            [
                {"createAttempted": True},
                {"createAttempted": True, "appId": APP_ID},
                {"createAttempted": True, "appId": APP_ID, "publishAttempted": True},
            ],
        )
        self.assertEqual(
            [method for method, _ in self.fixture.received],
            ["AppGetByDeploymentName", "AppCreate", "AppPublish"],
        )
        self.assertTrue(
            all(deadline is not None for deadline in self.fixture.deadlines.values())
        )

    async def test_collision_inside_sdk_deploy_sends_no_mutation(self):
        self.fixture.replies["AppGetByDeploymentName"].app_id = APP_ID
        state = {}
        with self.assertRaisesRegex(WindowFailed, "^app_name_in_use$"):
            await deploy_once.aio(
                self.client, DeploymentFixture(), NAME, OWNER, state.update
            )
        self.assertEqual(state, {})
        self.assertEqual(
            [method for method, _ in self.fixture.received], ["AppGetByDeploymentName"]
        )
