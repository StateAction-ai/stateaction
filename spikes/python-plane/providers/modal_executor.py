"""Public Modal SDK adapter for the offline Python-plane spike."""

import asyncio
import json
import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

CALL_ID = re.compile(r"fc-[A-Za-z0-9]{1,77}")
MAX_BOOTSTRAP_BYTES = 8192
POLL_WINDOW_SECONDS = 1


class ModalSpawnNotSent(Exception):
    """SDK spawn was never invoked."""


class ModalSpawnUncertain(Exception):
    """SDK spawn was invoked and the controller must preserve its intent."""


class Returned(TypedDict):
    kind: Literal["returned"]
    value: object


class Unresolved(TypedDict):
    kind: Literal["pending", "unavailable"]
    detail: str


type Observation = Returned | Unresolved


@dataclass(frozen=True)
class ModalTarget:
    app_name: str
    function_name: str
    environment_name: str
    function_id: str
    version: int | None = None

    def __post_init__(self) -> None:
        if not self.function_id.startswith("fu-"):
            raise ValueError("A pinned Modal function ID is required")
        if self.version is not None and self.version <= 0:
            raise ValueError("Explicit Modal versions must be positive")


class ModalExecutor:
    def __init__(
        self,
        target: ModalTarget,
        *,
        sdk: Any,
        client: Any,
        api_timeout: float = 5.0,
    ):
        if not math.isfinite(api_timeout) or api_timeout <= 0:
            raise ValueError("Modal API timeout must be positive and finite")
        if client is None:
            raise ValueError("An explicit Modal client is required")
        self.target = target
        self.sdk = sdk
        self.client = client
        self.api_timeout = api_timeout

    async def _function(self):
        target = self.target
        if target.version is None:
            fn = self.sdk.Function.from_id(target.function_id, client=self.client)
        else:
            fn = self.sdk.Function.from_name(
                target.app_name,
                target.function_name,
                version=target.version,
                environment_name=target.environment_name,
                client=self.client,
            )
        await fn.hydrate.aio()
        if fn.object_id != target.function_id:
            raise ValueError("Modal function ID differs from its pin")
        return fn

    def _call(self, call_id: str):
        if not CALL_ID.fullmatch(call_id):
            raise ValueError("Invalid Modal call ID")
        return self.sdk.FunctionCall.from_id(call_id, client=self.client)

    async def inspect(self) -> tuple[object, object]:
        """Return the SDK's function and autoscaler summaries for diagnostics."""
        async with asyncio.timeout(self.api_timeout):
            fn = await self._function()
            return await fn.info.aio(), await fn.autoscaler.settings.aio()

    async def spawn(
        self,
        bootstrap: Mapping[str, object],
        can_submit: Callable[[], bool],
    ) -> str:
        issued = False
        try:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + self.api_timeout
            async with asyncio.timeout_at(deadline):
                payload = json.dumps(
                    dict(bootstrap),
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                if len(payload.encode("utf-8")) > MAX_BOOTSTRAP_BYTES:
                    raise ValueError("Modal bootstrap exceeds the worker byte limit")
                fn = await self._function()
                if not can_submit() or loop.time() >= deadline:
                    raise ModalSpawnNotSent()
                issued = True
                call = await fn.spawn.aio(payload)
                call_id = call.object_id
                if not CALL_ID.fullmatch(call_id):
                    raise ValueError("Invalid Modal call acknowledgement")
                return call_id
        except Exception:  # noqa: BLE001 - any error after invocation is ambiguous
            if issued:
                raise ModalSpawnUncertain("Modal spawn outcome is unknown") from None
            raise ModalSpawnNotSent(
                "Modal spawn stopped before SDK invocation"
            ) from None

    async def poll(self, call_id: str) -> Observation:
        try:
            async with asyncio.timeout(self.api_timeout + POLL_WINDOW_SECONDS):
                call = self._call(call_id)
                value = await call.get.aio(timeout=POLL_WINDOW_SECONDS)
        except self.sdk.exception.FunctionTimeoutError:
            return {"kind": "unavailable", "detail": "function_timeout"}
        except self.sdk.exception.TimeoutError:
            return {"kind": "pending", "detail": "poll_timeout"}
        except TimeoutError:
            return {"kind": "unavailable", "detail": "operation_timeout"}
        except Exception as error:  # noqa: BLE001 - SDK result may raise a worker exception
            return {"kind": "unavailable", "detail": type(error).__name__}
        return {"kind": "returned", "value": value}

    async def watch(self, call_id: str) -> object:
        """Read best-effort lineage for diagnostics."""
        async with asyncio.timeout(self.api_timeout):
            return await self._call(call_id).get_call_graph.aio()

    async def cancel(self, call_id: str) -> None:
        async with asyncio.timeout(self.api_timeout):
            await self._call(call_id).cancel.aio(terminate_containers=True)
