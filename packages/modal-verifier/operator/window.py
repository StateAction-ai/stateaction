"""Verify and re-read scheduling for a temporary function without invoking it."""

import asyncio
import json
import re
import sys
import warnings
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from time import monotonic

import modal
from google.protobuf.empty_pb2 import Empty
from modal._utils.async_utils import synchronize_api
from modal.config import config
from modal.exception import InternalAPIWarning, NotFoundError
from modal_proto import api_pb2 as wire
from probe_app import make_app
from stateaction_modal_verifier.verifier import (
    Bounds,
    ReadPolicy,
    Scheduling,
    check_client,
    inspect,
    warm,
)

ENVIRONMENT = "main"
TAG = "scheduling_probe"
OWNER_TAG = "stateaction-sa152"
CUTOFF = Decimal(22)
ALLOWANCE = Decimal("0.25")


class WindowFailed(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise WindowFailed(reason)


async def _lifecycle_read(client, method, request):
    check_client(client)
    async with asyncio.timeout(5):
        return await getattr(client.stub, method)(request, retry=None, timeout=5)


lifecycle_read = synchronize_api(_lifecycle_read)


async def _read_scheduling(client, policy, function_id):
    check_client(client)
    reply = await policy.call(
        client,
        "FunctionGetSchedulingParams",
        wire.FunctionGetSchedulingParamsRequest(function_id=function_id),
    )
    return Scheduling.from_wire(reply.autoscaler_configuration)


read_scheduling = synchronize_api(_read_scheduling)


async def _deploy(client, app, name, owner, record):
    check_client(client)
    stub = client.stub
    lookup = stub.AppGetByDeploymentName
    original = stub.AppCreate
    publish = stub.AppPublish
    create_attempted = publish_attempted = False
    created_app_id = None

    async def check_name(request):
        require(
            request.name == name and request.environment_name == ENVIRONMENT,
            "unexpected_app_lookup",
        )
        reply = await lookup(request, retry=None, timeout=5)
        require(not reply.app_id, "app_name_in_use")
        return reply

    async def create(request):
        nonlocal create_attempted, created_app_id
        require(
            not create_attempted
            and request.description == name
            and dict(request.tags) == {OWNER_TAG: owner}
            and request.environment_name == ENVIRONMENT,
            "unexpected_app_create",
        )
        create_attempted = True
        record(createAttempted=True)
        reply = await original(request, retry=None, timeout=5)
        require(re.fullmatch(r"ap-[A-Za-z0-9]+", reply.app_id), "app_id")
        created_app_id = reply.app_id
        record(appId=created_app_id)
        return reply

    async def deploy(request):
        nonlocal publish_attempted
        require(
            not publish_attempted
            and created_app_id
            and request.app_id == created_app_id
            and request.name == name
            and dict(request.tags) == {OWNER_TAG: owner}
            and request.app_state == wire.APP_STATE_DEPLOYED,
            "unexpected_app_publish",
        )
        publish_attempted = True
        record(publishAttempted=True)
        request.ClearField("commit_info")
        return await publish(request, retry=None, timeout=10)

    stub.AppGetByDeploymentName = check_name
    stub.AppCreate = create
    stub.AppPublish = deploy
    try:
        async with asyncio.timeout(85):
            await app.deploy(environment_name=ENVIRONMENT, client=client)
            require(created_app_id and app.app_id == created_app_id, "deployed_app")
    finally:
        stub.AppGetByDeploymentName = lookup
        stub.AppCreate = original
        stub.AppPublish = publish


deploy_once = synchronize_api(_deploy)


class ModalWindow:
    def __init__(self, client, name, policy, owner):
        self.client = client
        self.name = name
        self.policy = policy
        self.owner = owner
        self.cycle = datetime.now(UTC).replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )

    async def verify_workspace(self, expected):
        reply = await self.call("WorkspaceNameLookup", Empty())
        require(reply.username == expected, "modal_workspace")

    async def gross(self):
        request = wire.WorkspaceBillingSummaryRequest()
        request.start_timestamp.FromDatetime(self.cycle)
        reply = await self.call("WorkspaceBillingSummary", request)
        value = Decimal(reply.metered_cost)
        require(value.is_finite() and value >= 0, "gross_value")
        return value

    async def owns(self, app_id):
        require(re.fullmatch(r"ap-[A-Za-z0-9]+", app_id), "app_id")
        reply = await self.call("AppGetTags", wire.AppGetTagsRequest(app_id=app_id))
        return reply.tags.get(OWNER_TAG) == self.owner

    async def call(self, method, request):
        return await lifecycle_read.aio(self.client, method, request)

    async def matching_ids(self):
        reply = await self.call(
            "AppList", wire.AppListRequest(environment_name=ENVIRONMENT)
        )
        return {
            app.app_id
            for app in reply.apps
            if app.description == self.name or app.name == self.name
        }

    async def named_app(self):
        try:
            return (
                await self.call(
                    "AppGetByDeploymentName",
                    wire.AppGetByDeploymentNameRequest(
                        name=self.name, environment_name=ENVIRONMENT
                    ),
                )
            ).app_id
        except NotFoundError:
            return ""

    async def preflight(self):
        require(
            not await self.named_app() and not await self.matching_ids(),
            "app_name_in_use",
        )

    async def deploy(self, state, persist):
        def record(**changes):
            state.update(changes)
            persist()

        app = make_app(self.name, {OWNER_TAG: self.owner})
        await deploy_once.aio(self.client, app, self.name, self.owner, record)

    async def python_read(self):
        return await inspect.aio(
            self.client,
            Bounds(
                self.name,
                ENVIRONMENT,
                TAG,
                "scheduling_probe@1",
                "none",
                1,
                500,
                256,
                180,
                24,
                0,
            ),
            {},
            policy=self.policy,
        )

    async def read_scheduling(self, function_id):
        return await read_scheduling.aio(self.client, self.policy, function_id)

    async def restore(self, state, persist):
        if not state.get("createAttempted"):
            return
        async with asyncio.timeout(70):
            app_id = state.get("appId")
            if not app_id:
                while not (
                    ids := [
                        candidate
                        for candidate in await self.matching_ids()
                        if await self.owns(candidate)
                    ]
                ):
                    await asyncio.sleep(1)
                require(len(ids) == 1, "ambiguous_app_ids")
                app_id = state["appId"] = ids[0]
                persist()
            else:
                require(await self.owns(app_id), "app_ownership")

            async def app_state():
                reply = await self.call(
                    "AppGetLifecycle", wire.AppGetLifecycleRequest(app_id=app_id)
                )
                return reply.lifecycle.app_state

            if await app_state() not in (
                wire.APP_STATE_STOPPING,
                wire.APP_STATE_STOPPED,
            ):
                try:
                    await self.call(
                        "AppStop",
                        wire.AppStopRequest(
                            app_id=app_id, source=wire.APP_STOP_SOURCE_PYTHON_CLIENT
                        ),
                    )
                except Exception:
                    state["stopAcknowledged"] = False
            while True:
                if (
                    await app_state() == wire.APP_STATE_STOPPED
                    and not await self.named_app()
                ):
                    try:
                        reply = await self.call(
                            "FunctionGet",
                            wire.FunctionGetRequest(
                                app_name=self.name,
                                environment_name=ENVIRONMENT,
                                object_tag=TAG,
                            ),
                        )
                    except NotFoundError:
                        break
                    if not reply.function_id:
                        break
                await asyncio.sleep(1)
            state["appStoppedAndAbsent"] = True
            persist()


async def run_window(provider, state, persist, meter):
    await provider.preflight()
    baseline = await meter()
    state["grossBeforeUsd"] = str(baseline)
    persist()
    require(baseline + ALLOWANCE < CUTOFF, "gross_headroom")
    try:
        await warm.aio(provider.client, provider.policy)
        await provider.deploy(state, persist)
        proof = await provider.python_read()
        require(proof.app_id == state["appId"], "function_app_id")
        state["functionId"] = proof.function_id
        state["pythonSchedule"] = asdict(proof.scheduling)
        persist()
        scheduling = await provider.read_scheduling(proof.function_id)
        state["recheckedSchedule"] = asdict(scheduling)
        persist()
        require(proof.scheduling == scheduling, "schedule_disagreement")
    finally:
        try:
            await provider.restore(state, persist)
        finally:
            final = await meter()
            state["grossAfterUsd"] = str(final)
            state["grossDeltaUsd"] = str(final - baseline)
            persist()
            require(
                baseline <= final < CUTOFF and final - baseline <= ALLOWANCE,
                "gross_cutoff",
            )
    state["passed"] = True
    persist()


async def main(receipt, manifest_digest, name, workspace, cleanup):
    endpoints = config["server_url"].split(",")
    require(
        all(re.fullmatch(r"https://api\.modal2?\.com/?", url) for url in endpoints),
        "modal_endpoint",
    )
    token_id, token_secret = config["token_id"], config["token_secret"]
    require(token_id and token_secret, "modal_token_pair")
    require(re.fullmatch(r"sa-152-probe-[a-f0-9]{16}", name), "probe_name")
    if cleanup:
        state = json.loads(receipt.read_text())
        require(
            (state["manifestDigest"], state["name"]) == (manifest_digest, name),
            "receipt_scope",
        )
    else:
        state = {
            "manifestDigest": manifest_digest,
            "name": name,
            "passed": False,
            "pythonRpcs": [],
        }
        with receipt.open("x") as output:
            json.dump(state, output)

    def persist():
        temp = receipt.with_suffix(".tmp")
        temp.write_text(json.dumps(state, indent=2) + "\n")
        temp.replace(receipt)

    def report(row):
        state["pythonRpcs"].append(asdict(row))
        persist()

    client = await modal.Client.from_credentials.aio(token_id, token_secret)
    provider = ModalWindow(
        client, name, ReadPolicy(report=report), manifest_digest[:32]
    )
    try:
        started = monotonic()
        await provider.verify_workspace(workspace)
        state["workspace"] = workspace
        if cleanup:
            await provider.restore(state, persist)
            state["cleanupGrossUsd"] = str(await provider.gross())
        else:
            await run_window(provider, state, persist, provider.gross)
    except (Exception, asyncio.CancelledError) as exc:
        state["error"] = (
            str(exc) if isinstance(exc, WindowFailed) else type(exc).__name__
        )
        return 1
    finally:
        state["elapsedSeconds"] = monotonic() - started
        persist()
        await client.close.aio()
    return 0


if __name__ == "__main__":
    warnings.filterwarnings(
        "ignore",
        message=r"^`modal\.Client\.stub` provides direct access",
        category=InternalAPIWarning,
    )
    try:
        receipt_path, digest, app_name, workspace, mode = sys.argv[1:]
        require(mode in ("run", "cleanup"), "operator_mode")
        sys.exit(
            asyncio.run(
                main(
                    Path(receipt_path),
                    digest,
                    app_name,
                    workspace,
                    mode == "cleanup",
                )
            )
        )
    except Exception as error:
        # Provider errors may include private payloads.
        sys.exit(type(error).__name__)
