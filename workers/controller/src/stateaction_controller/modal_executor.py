"""Invoke and observe Modal with the controller's private SDK client."""

import asyncio
import json
import re
from functools import cache

from modal._utils.async_utils import synchronize_api
from modal._utils.function_utils import _create_input
from modal_proto import api_pb2 as wire
from stateaction_contracts.validate import _api_dir
from stateaction_modal_verifier.verifier import (
    Bounds,
    ReadPolicy,
    check_sdk,
    probe_gpu_watch,
    verify_binding,
)

from .config import HAND_POSE, modal_credentials
from .modal_controller import SpawnCancelled, SpawnNotSent
from .results import call_id_valid

MAX_BOOTSTRAP_BYTES = 8192
POLL_SECONDS = 1


def bootstrap_bytes(value):
    return json.dumps(
        value, allow_nan=False, ensure_ascii=False, separators=(",", ":")
    ).encode()


@cache
def checkpoint_pins():
    return json.loads((_api_dir() / "flora-checkpoints.v1.json").read_bytes())


async def _prepare_input(client, function, payload):
    # Modal 1.6.4's high-level spawn retries submission RPCs. Encode the input
    # on Modal's SDK event loop before running caller-loop submission hooks.
    check_sdk()
    invocation = wire.FUNCTION_CALL_INVOCATION_TYPE_ASYNC
    return await _create_input(
        (payload,),
        {},
        client.stub,
        function=function,
        function_call_invocation_type=invocation,
    )


async def _submit_prepared(client, function, item, before_send):
    check_sdk()
    stub = client.stub
    invocation = wire.FUNCTION_CALL_INVOCATION_TYPE_ASYNC
    request = wire.FunctionMapRequest(
        function_id=function.object_id,
        function_call_type=wire.FUNCTION_CALL_TYPE_UNARY,
        function_call_invocation_type=invocation,
        pipelined_inputs=[item],
    )
    response = await stub.FunctionMap(request, retry=None, timeout=before_send())
    call_id = response.function_call_id
    if not call_id_valid(call_id):
        raise ValueError("Modal returned an invalid call identity")
    if len(response.pipelined_inputs) == 1:
        return call_id
    if response.pipelined_inputs:
        raise ValueError("Modal returned more than one input for a unary call")
    request = wire.FunctionPutInputsRequest(
        function_id=function.object_id, function_call_id=call_id, inputs=[item]
    )
    response = await stub.FunctionPutInputs(request, retry=None, timeout=before_send())
    if len(response.inputs) != 1:
        raise ValueError("Modal did not acknowledge the unary input")
    return call_id


prepare_spawn_input = synchronize_api(_prepare_input)
submit_spawn_input = synchronize_api(_submit_prepared)


class ModalExecutor:
    def __init__(self, settings, sdk, client=None):
        self.settings = settings
        self.sdk = sdk
        self.client = client
        self._connection_lock = asyncio.Lock()

    async def _connect(self):
        if self.client is None:
            async with self._connection_lock:
                if self.client is None:
                    token_id, token_secret = modal_credentials()
                    self.client = await self.sdk.Client.from_credentials.aio(
                        token_id, token_secret
                    )
        return self.client

    async def close(self):
        if self.client is not None:
            try:
                async with asyncio.timeout(self.settings.timeout):
                    await self.client.close.aio()
            finally:
                self.client = None

    async def verify(self, module, binding):
        app, function = self.settings.target(module)
        if not app or not function or app != binding["appName"]:
            raise ValueError("Configured Modal target differs from the binding")
        verified = await verify_binding.aio(
            await self._connect(),
            Bounds(
                app,
                binding["environment"],
                function,
                module,
                binding["gpu"] or "none",
                binding["maxContainers"],
                binding["maxCpuMilli"],
                binding["maxMemoryMib"],
                binding["maxBilledSeconds"],
                binding["microUsdPerCpuSecond"],
                binding["microUsdPerGpuSecond"],
            ),
            checkpoint_pins(),
            configured_app=app,
            configured_environment=self.settings.environment,
            code_revision=binding["codeRevision"],
            params_sha256=binding["paramsSha256"],
            function_id=binding["functionId"],
            definition_id=binding["definitionId"],
            definition_sha256=binding["definitionSha256"],
        )
        if binding.get("imageId") and binding["imageId"] != verified.image_id:
            raise ValueError("Configured Modal image differs from the binding")
        return verified

    async def check_function(self, binding, module=HAND_POSE):
        try:
            async with asyncio.timeout(self.settings.timeout):
                await self.verify(module, binding)
            return True
        except Exception:
            return False

    async def spawn(self, bootstrap, authorized, binding, before_submit=None):
        issued = False
        try:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self.settings.timeout
            async with asyncio.timeout_at(deadline):
                payload = bootstrap_bytes(bootstrap)
                if len(payload) > MAX_BOOTSTRAP_BYTES:
                    raise SpawnNotSent()
                module = bootstrap.get("module")
                if bootstrap.get("pipeline") == "clip_plan_cpu_v1":
                    if not binding or binding["gpu"] != "none":
                        raise SpawnNotSent()
                    module = HAND_POSE
                client = await self._connect()
                if binding:
                    verified = await self.verify(module, binding)
                    if "nodeId" in bootstrap:
                        digest = verified.runtime_definition_sha256
                        if not re.fullmatch(r"[0-9a-f]{64}", digest):
                            raise SpawnNotSent()
                        payload = bootstrap_bytes(
                            {
                                **bootstrap,
                                "functionId": verified.function_id,
                                "runtimeDefinitionSha256": digest,
                            }
                        )
                        if len(payload) > MAX_BOOTSTRAP_BYTES:
                            raise SpawnNotSent()
                    function = self.sdk.Function.from_id(
                        verified.function_id, client=client
                    )
                else:
                    app, name = self.settings.target(module)
                    if not app or not name:
                        raise SpawnNotSent()
                    function = self.sdk.Function.from_name(
                        app,
                        name,
                        environment_name=self.settings.environment,
                        client=client,
                    )
                await function.hydrate.aio()
                if binding and function.object_id != binding["functionId"]:
                    raise SpawnNotSent()

                def before_send():
                    nonlocal issued
                    remaining = deadline - loop.time()
                    if remaining <= 0 or not authorized():
                        raise SpawnNotSent()
                    issued = True
                    return remaining

                item = await prepare_spawn_input.aio(client, function, payload.decode())
                if before_submit is not None:
                    await before_submit()
                return await submit_spawn_input.aio(client, function, item, before_send)
        except SpawnCancelled:
            raise
        except Exception:
            if issued:
                raise RuntimeError(
                    "Modal submission acknowledgement unavailable"
                ) from None
            raise SpawnNotSent() from None

    async def _call(self, call_id):
        if not call_id_valid(call_id):
            raise ValueError("Invalid Modal call identity")
        return self.sdk.FunctionCall.from_id(call_id, client=await self._connect())

    async def poll(self, call_id):
        try:
            async with asyncio.timeout(self.settings.timeout + POLL_SECONDS):
                call = await self._call(call_id)
                value = await call.get.aio(timeout=POLL_SECONDS)
        except self.sdk.exception.FunctionTimeoutError:
            return {"kind": "unavailable", "detail": "function_timeout"}
        except self.sdk.exception.TimeoutError:
            return {"kind": "pending", "detail": "poll_timeout"}
        except TimeoutError:
            return {"kind": "unavailable", "detail": "operation_timeout"}
        except Exception:
            return {"kind": "unavailable", "detail": "provider_error"}
        return {"kind": "returned", "value": value}

    async def watch(self, call_id, binding):
        if not call_id_valid(call_id):
            raise ValueError("Invalid Modal call identity")
        bound = min(self.settings.timeout, 5)
        async with asyncio.timeout(bound):
            return await probe_gpu_watch.aio(
                await self._connect(),
                binding["functionId"],
                call_id,
                policy=ReadPolicy(rpc_seconds=bound, total_seconds=bound),
            )

    async def cancel(self, call_id):
        async with asyncio.timeout(self.settings.timeout):
            call = await self._call(call_id)
            await call.cancel.aio(terminate_containers=True)
