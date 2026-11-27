"""Bounded client for the existing machine-authenticated internal routes."""

import asyncio
import ipaddress
import re
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from stateaction_contracts import parse_contract
from stateaction_contracts.canonical import loads_strict
from stateaction_contracts.validate import _catalog


class AmbiguousApiError(Exception):
    """The server may have committed an action whose reply was lost."""


class ApiRejection(Exception):
    """The server returned a definite rejection."""

    def __init__(self, status: int, code: str):
        self.status = status
        self.code = code
        super().__init__(f"Jobs API rejected the request ({status}, {code})")


async def reconcile_graph_request(send, lease_live, pause, *, observed=None):
    for attempt in range(3):
        if not lease_live():
            raise AmbiguousApiError("Graph lease ended before acknowledgement")
        try:
            return await send()
        except AmbiguousApiError:
            if observed is not None and lease_live():
                try:
                    if await observed():
                        return {"state": "recorded"}
                except AmbiguousApiError:
                    pass
            if attempt == 2:
                raise
            await pause()


def check_base(base: str, *, loopback: bool) -> None:
    url = urlsplit(base)
    try:
        address = ipaddress.ip_address(url.hostname or "")
        is_loopback = address.is_loopback or address.is_unspecified
    except ValueError:
        is_loopback = (url.hostname or "").rstrip(".") == "localhost"
    if (
        url.username is not None
        or url.password is not None
        or url.path not in ("", "/")
        or "?" in base
        or "#" in base
        or not url.hostname
        or (
            loopback
            and (
                url.scheme not in ("http", "https")
                or url.hostname not in ("127.0.0.1", "localhost", "::1")
            )
        )
        or (not loopback and (url.scheme != "https" or is_loopback))
    ):
        raise ValueError("Invalid internal API origin")


class JobsApi:
    def __init__(self, base: str, token: str, *, loopback: bool, timeout: float = 10):
        check_base(base, loopback=loopback)
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
            follow_redirects=False,
            trust_env=False,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def _call(self, path: str, contract: str, body=None, *, timeout=None) -> Any:
        timeout = self.timeout if timeout is None else timeout
        limit = _catalog()["contracts"][contract]["maxBytes"] + 4096
        try:
            async with asyncio.timeout(timeout):
                async with self.client.stream(
                    "GET" if body is None else "POST",
                    self.base + path,
                    json=body,
                    timeout=timeout,
                ) as response:
                    if 300 <= response.status_code < 400 or response.status_code >= 500:
                        raise AmbiguousApiError("No acknowledgement from jobs API")
                    status = response.status_code
                    content = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=8192):
                        content.extend(chunk)
                        if len(content) > limit:
                            if status >= 400:
                                raise ApiRejection(status, "rejected")
                            raise AmbiguousApiError(
                                "Jobs API reply exceeded its size limit"
                            )
        except (httpx.HTTPError, TimeoutError):
            raise AmbiguousApiError("No acknowledgement from jobs API") from None

        if status >= 400:
            try:
                code = loads_strict(content.decode("utf-8"))["error"]["code"]
            except (ValueError, KeyError, TypeError, RecursionError):
                code = "rejected"
            if not isinstance(code, str) or not re.fullmatch(
                r"[a-z][a-z0-9_]{0,39}", code
            ):
                code = "rejected"
            raise ApiRejection(status, code)
        try:
            return parse_contract(
                contract, loads_strict(content.decode("utf-8"))["data"]
            )
        except (ValueError, KeyError, TypeError, RecursionError):
            raise AmbiguousApiError("Jobs API response violated its contract") from None

    async def status(self, job_id):
        return await self._call(self._path(job_id), "jobs.job-status.v3")

    async def graph(self, job_id):
        try:
            return await self._call(self._path(job_id, "/graph"), "jobs.graph-run.v1")
        except ApiRejection as error:
            if error.status != 404:
                raise
            return None

    async def graph_action(self, job_id, action, **facts):
        payload = {"action": action, **facts}
        parse_contract("jobs.graph-control.v1", payload)
        verifies_objects = action == "prepare_graph" or (
            action == "record_node_result" and facts["state"] == "succeeded"
        )
        return await self._call(
            self._path(job_id, "/graph"),
            "jobs.graph-control-result.v1",
            payload,
            timeout=56 * 60 if verifies_objects else None,
        )

    async def recipe(self, job_id):
        try:
            return await self._call(self._path(job_id, "/recipe"), "jobs.recipe.v1")
        except ApiRejection as error:
            if error.status != 404:
                raise
            return None

    async def dag(self, job_id):
        return await self._call(self._path(job_id, "/dag-run"), "http.dag-run.v1")

    async def prior_stages(self, job_id):
        return await self._call(
            self._path(job_id, "/prior-stages"), "jobs.prior-stages.v1"
        )

    async def act(self, job_id, action, **facts):
        payload = {"action": action, **facts}
        parse_contract("jobs.controller-action.v4", payload)
        return await self._call(
            self._path(job_id, "/controller"), "jobs.controller-result.v1", payload
        )

    async def claim(self, job_id, nonce, ref):
        payload = {
            "schemaVersion": 1,
            "jobId": job_id,
            "invocationNonce": nonce,
            "executor": {"kind": "local", "localExecutionRef": ref},
        }
        parse_contract("jobs.worker-claim.v1", payload)
        return await self._call(
            self._path(job_id, "/claim"), "jobs.claim-grant.v1", payload
        )

    @staticmethod
    def _path(job_id, suffix=""):
        return f"/internal/v1/jobs/{UUID(job_id)}{suffix}"

    async def prepare_rerun(self, job_id, owner):
        return await self._call(
            self._path(job_id, "/rerun-preparation"),
            "jobs.rerun-preparation.v1",
            {"owner": owner},
            timeout=56 * 60,
        )

    async def reconcile(self):
        return await self._call(
            "/internal/v1/jobs/reconcile", "jobs.reconcile-result.v1", {}
        )
