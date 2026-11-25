"""Exercise the hosted Render lifecycle with a local provider transport."""

import asyncio
from decimal import Decimal

import httpx
import pytest
from phase2_operator import (
    LIVE_WORKFLOW_ID,
    MANIFEST,
    NAME,
    WEB_ID,
    Hosted,
    RenderAPI,
    complete,
    execute,
)


class Provider:
    def __init__(self, failure):
        self.failure = failure
        self.workflow = None
        self.runs = {}
        self.deleted = []
        self.version = "wfv-Temporary"
        self.head = "a" * 40

    def handle(self, request):
        path = request.url.path.removeprefix("/v1/")
        method = request.method
        if path == f"workflows/{LIVE_WORKFLOW_ID}" and method == "GET":
            return self.ok(
                {
                    "ownerId": "tea-Fixture",
                    "defaultVersionId": MANIFEST["liveWorkflowVersion"],
                }
            )
        if path == f"services/{WEB_ID}/deploys" and method == "GET":
            return self.ok(
                [{"deploy": {"id": MANIFEST["webDeployment"], "status": "live"}}]
            )
        if path == "workflows" and method == "GET":
            assert request.url.params["name"] == NAME
            return self.ok([{"workflow": self.workflow}] if self.workflow else None)
        if path == "workflows" and method == "POST":
            import json

            settings = json.loads(request.content)
            assert settings["ownerId"] == "tea-Fixture"
            assert settings["name"] == NAME and settings["autoDeployTrigger"] == "off"
            assert settings["buildConfig"]["branch"] == "spike/python-plane"
            assert settings["buildConfig"]["runtime"] == "python"
            assert "plan" not in settings
            self.workflow = {
                "id": "wfl-Temporary",
                "slug": NAME,
                "defaultVersionId": self.version,
                **{
                    key: settings[key]
                    for key in ("ownerId", "name", "buildConfig", "autoDeployTrigger")
                },
            }
            if self.failure == "lost_create":
                raise httpx.ReadTimeout("Simulated acknowledgement loss")
            return self.ok(self.workflow)
        if path == "workflows/wfl-Temporary":
            if method == "DELETE":
                self.workflow = None
                self.deleted.append(path)
                return httpx.Response(204)
            return self.ok(self.workflow) if self.workflow else httpx.Response(404)
        if path == "workflowversions":
            return self.ok([{"workflowVersion": {"id": self.version}}])
        if path == "workflowversions/" + self.version:
            return self.ok({"id": self.version, "name": self.head, "status": "ready"})
        if path == "tasks":
            return self.ok(
                [
                    {
                        "task": {
                            "name": name,
                            "id": "tsk-CPU"
                            if name == "modal-cpu-probe"
                            else "tsk-Controller",
                        }
                    }
                    for name in ("process-recording", "modal-cpu-probe")
                ]
            )
        if path == "task-runs" and method == "GET":
            assert request.url.params["workflowId"] == "wfl-Temporary"
            return self.ok([{"taskRun": row} for row in self.runs.values()])
        if path == "task-runs" and method == "POST":
            ident = "trn-Modal"
            self.runs[ident] = {
                "id": ident,
                "taskId": "tsk-CPU",
                "status": "completed",
                "results": [{"runId": ident, "callId": "fc-Fixture", "terminal": True}],
            }
            if self.failure == "lost_start":
                self.runs[ident]["status"] = "running"
                raise httpx.ReadTimeout("Simulated start acknowledgement loss")
            return self.ok({"taskRunId": ident})
        if path.startswith("task-runs/"):
            row = self.runs[path.split("/")[1]]
            if method == "DELETE":
                row["status"] = "canceled"
                self.deleted.append(path)
                return httpx.Response(204)
            return self.ok(row)
        raise AssertionError(f"Unapproved simulated request {method} {path}")

    @staticmethod
    def ok(value):
        return httpx.Response(200, json=value)


@pytest.mark.parametrize("failure", [None, "lost_create", "lost_start"])
def test_hosted_transport_reads_and_removes_owned_resources(failure, monkeypatch):
    from unittest.mock import AsyncMock

    import modal.config
    import phase2_operator
    import redeploy_probe

    provider = Provider(failure)
    monkeypatch.setattr(
        modal.config, "config", {"token_id": "fixture", "token_secret": "fixture"}
    )
    monkeypatch.setattr(
        redeploy_probe, "gross", AsyncMock(return_value=Decimal("20.50"))
    )

    async def command(*args, **kwargs):
        ident = "trn-Controller"
        provider.runs[ident] = {
            "id": ident,
            "status": "completed",
            "results": [{"runId": ident, "journalFence": True, "pidfdTerminal": True}],
        }
        return ident

    monkeypatch.setattr(phase2_operator, "command", command)

    async def initiate():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(provider.handle),
            base_url="http://127.0.0.1/v1/",
        ) as client:
            adapter = Hosted(RenderAPI(client), "fixture", provider.head)
            monkeypatch.setattr(
                adapter,
                "deploy_modal",
                AsyncMock(return_value={"definition_sha256": "0" * 64}),
            )
            return await execute(adapter, {}, lambda state: None, hosted=False)

    state = asyncio.run(initiate())
    assert complete(state) == (failure is None)
    assert state["cleanup"]["live"] == {
        key: MANIFEST[key] for key in ("webDeployment", "liveWorkflowVersion")
    }
    assert state["cleanup"]["workflowRemoved"] and state["cleanup"]["modalStopped"]
    assert state["cleanup"]["grossWithinLimits"]
    assert provider.workflow is None
    assert provider.deleted == (
        ["task-runs/trn-Modal", "workflows/wfl-Temporary"]
        if failure == "lost_start"
        else ["workflows/wfl-Temporary"]
    )
