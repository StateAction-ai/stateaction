"""Bounded client for the existing machine-authenticated internal routes."""

import json
import re
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from stateaction_contracts import parse_contract


class AmbiguousApiError(Exception):
    """The server may have committed an action whose reply was lost."""


class ApiRejection(Exception):
    """The server returned a definite rejection."""


def check_base(base: str, *, loopback: bool) -> None:
    url = urlsplit(base)
    if (
        url.username
        or url.password
        or url.path not in ("", "/")
        or url.query
        or url.fragment
        or not url.hostname
        or (loopback and (url.scheme != "http" or url.hostname != "127.0.0.1"))
        or (not loopback and url.scheme != "https")
    ):
        raise ValueError("Invalid internal API origin")


class JobsApi:
    def __init__(self, base: str, token: str, *, loopback: bool = True):
        check_base(base, loopback=loopback)
        self.base = base.rstrip("/")
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
            follow_redirects=False,
            trust_env=False,
        )

    def close(self) -> None:
        self.client.close()

    def _call(self, job_id: str, suffix: str, contract: str, body=None) -> Any:
        path = f"/internal/v1/jobs/{UUID(job_id)}{suffix}"
        try:
            with self.client.stream(
                "GET" if body is None else "POST", self.base + path, json=body
            ) as response:
                if response.is_redirect or response.status_code >= 500:
                    raise AmbiguousApiError("No acknowledgement from jobs API")
                status = response.status_code
                content = bytearray()
                for chunk in response.iter_bytes(chunk_size=8192):
                    content.extend(chunk)
                    if len(content) > 1_052_672:
                        raise AmbiguousApiError(
                            "Jobs API reply exceeded the spike limit"
                        )
        except httpx.HTTPError:
            raise AmbiguousApiError("No acknowledgement from jobs API") from None

        if status >= 400:
            try:
                code = json.loads(content)["error"]["code"]
            except (ValueError, KeyError, TypeError):
                code = "rejected"
            if not isinstance(code, str) or not re.fullmatch(
                r"[a-z][a-z0-9_]{0,39}", code
            ):
                code = "rejected"
            raise ApiRejection(
                f"{status} {code} in {body.get('action') if suffix == '/controller' else suffix}"
            )
        try:
            return parse_contract(contract, json.loads(content)["data"])
        except (ValueError, KeyError, TypeError):
            raise AmbiguousApiError("Jobs API response violated its contract") from None

    def status(self, job_id):
        return self._call(job_id, "", "jobs.job-status.v3")

    def recipe(self, job_id):
        return self._call(job_id, "/recipe", "jobs.recipe.v1")

    def dag(self, job_id):
        return self._call(job_id, "/dag-run", "http.dag-run.v1")

    def act(self, job_id, action, **facts):
        payload = {"action": action, **facts}
        parse_contract("jobs.controller-action.v4", payload)
        return self._call(job_id, "/controller", "jobs.controller-result.v1", payload)

    def claim(self, job_id, nonce, ref):
        payload = {
            "schemaVersion": 1,
            "jobId": job_id,
            "invocationNonce": nonce,
            "executor": {"kind": "local", "localExecutionRef": ref},
        }
        parse_contract("jobs.worker-claim.v1", payload)
        return self._call(job_id, "/claim", "jobs.claim-grant.v1", payload)
