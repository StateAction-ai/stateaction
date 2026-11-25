"""Phase 2 lifecycle shared by the real provider adapter and the rehearsal."""

import argparse
import asyncio
import hashlib
import json
import os
import re
import signal
import socket
import sys
import time
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import httpx

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PROVIDERS = HERE.parent / "providers"
sys.path.insert(0, str(PROVIDERS))

MANIFEST_BYTES = (HERE / "phase2-manifest.json").read_bytes()
MANIFEST = json.loads(MANIFEST_BYTES)
DIGEST = hashlib.sha256(MANIFEST_BYTES).hexdigest()
RECEIPT = Path("/home/wearaway/flora-work/handoff/python-plane-phase2.json")
SPEND = Path("/home/wearaway/flora-work/SPEND-LOG.md")
TICKETLOG = Path("/home/wearaway/flora-work/bin/ticketlog")
WEB_ID = "srv-dc2bfl6c6qcc73df90e0"
LIVE_WORKFLOW_ID = "wfl-dc2bermc6qcc73df6890"
NAME = MANIFEST["workflow"]
ENVIRONMENT = MANIFEST["modalEnvironment"]
END_STATES = {"completed", "succeeded", "failed", "canceled", "cancelled"}


class ProviderError(RuntimeError):
    pass


async def command(*args, env=None, timeout=15):
    proc = await asyncio.create_subprocess_exec(
        *map(str, args),
        cwd=ROOT,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        async with asyncio.timeout(timeout):
            response, _ = await proc.communicate()
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        raise
    if proc.returncode:
        raise ProviderError(f"{Path(args[0]).name}_exit_{proc.returncode}")
    return response.decode().strip()


def render_token():
    value = os.environ.get("RENDER_API_KEY")
    if value:
        return value
    config = (Path.home() / ".render/cli.yaml").read_text()
    parsed = re.search(r"^\s+key:\s+(\S+)$", config, re.M)
    if parsed is None:
        raise ProviderError("render_credential_unavailable")
    return parsed[1].strip('"')


def validated_id(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix + "-[A-Za-z0-9]+", value):
        raise ProviderError(f"invalid_{prefix}_identity")
    return value


def entries(value, key):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ProviderError(f"unexpected_{key}_list")
    return [row.get(key, row) for row in value]


class RenderAPI:
    def __init__(self, client):
        self.client = client

    async def request(self, method, path, *, query=None, body=None, missing=False):
        response = await self.client.request(method, path, params=query, json=body)
        if missing and response.status_code == 404:
            return None
        if response.status_code in (400, 402, 403):
            try:
                data = response.json()
                code = data.get("code", "")
                message = data.get("message", "").lower()
                requires_payment = any(
                    word in message
                    for word in ("upgrade", "paid plan", "payment", "billing")
                )
            except (ValueError, AttributeError):
                code, requires_payment = "", False
            if response.status_code == 402 or requires_payment:
                raise ProviderError("render_requires_payment_or_plan_change")
            if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{1,64}", code):
                raise ProviderError(f"render_{code}")
        if not response.is_success:
            raise ProviderError(
                f"render_{method.lower()}_{path.split('/')[0]}_{response.status_code}"
            )
        return response.json() if response.content else None

    async def wait_run(self, run_id, monitor, max_seconds):
        until = time.monotonic() + max_seconds
        while time.monotonic() < until:
            await monitor()
            run = await self.request("GET", f"task-runs/{run_id}")
            if run["status"] in END_STATES:
                return run
            await asyncio.sleep(1)
        raise ProviderError("render_task_wait_elapsed")


class Hosted:
    def __init__(self, api, token, head):
        self.api = api
        self.token = token
        self.head = head
        self.owner = None
        self.sdk = None
        self.modal_name = None
        self.modal_attempted = False
        self.render_attempted = False
        self.workflow = None
        self.known_runs = []
        self.create_params = None
        self.baseline = None
        self.last_meter = 0.0

    async def snapshot(self):
        workflow = await self.api.request("GET", f"workflows/{LIVE_WORKFLOW_ID}")
        deploys = entries(
            await self.api.request(
                "GET", f"services/{WEB_ID}/deploys", query={"limit": 20}
            ),
            "deploy",
        )
        self.owner = workflow["ownerId"]
        live = [row["id"] for row in deploys if row["status"] == "live"]
        return {
            "webDeployment": live[0] if len(live) == 1 else None,
            "liveWorkflowVersion": workflow.get("defaultVersionId"),
        }

    async def list_ours(self):
        rows = entries(
            await self.api.request(
                "GET",
                "workflows",
                query={"ownerId": self.owner, "name": NAME, "limit": 100},
            ),
            "workflow",
        )
        return [
            row
            for row in rows
            if row.get("ownerId") == self.owner and row.get("name") == NAME
        ]

    async def preflight(self):
        from redeploy_probe import gross

        baseline = await self.snapshot()
        if any(baseline[key] != MANIFEST[key] for key in baseline):
            raise ProviderError("live_releases_differ_from_authorized_baseline")
        if await self.list_ours():
            raise ProviderError("temporary_workflow_name_already_exists")
        latest_gross = await gross()
        prior = RECEIPT.with_name("python-plane-phase2-modal-preflight.json")
        self.baseline = (
            Decimal(json.loads(prior.read_text())["preflight"]["baselineGrossUsd"])
            if prior.exists()
            else latest_gross
        )
        if latest_gross - self.baseline > Decimal(MANIFEST["modalDeltaUsd"]):
            raise ProviderError("gross_headroom_used_during_previous_attempt")
        if self.baseline + Decimal(MANIFEST["modalDeltaUsd"]) >= Decimal(
            MANIFEST["modalGrossUsd"]
        ):
            raise ProviderError("gross_headroom_unavailable")
        return {
            **baseline,
            "baselineGrossUsd": str(self.baseline),
            "latestGrossUsd": str(latest_gross),
        }

    async def monitor(self, force=False):
        from redeploy_probe import gross

        if not force and time.monotonic() - self.last_meter < 10:
            return None
        observed = await gross()
        self.last_meter = time.monotonic()
        if observed >= Decimal(
            MANIFEST["modalGrossUsd"]
        ) or observed - self.baseline > Decimal(MANIFEST["modalDeltaUsd"]):
            raise ProviderError("modal_gross_cutoff")
        return observed

    @staticmethod
    def capture_shape(state, bounds, method, response):
        """Store only the provider's allowlisted CPU wire fields and synthetic IDs."""
        from modal_proto import api_pb2 as wire
        from modal_verifier import wire_b64

        shape = state.setdefault("modalShape", {})
        if method == "FunctionGetSchedulingParams":
            raw = response.autoscaler_configuration
            clean = wire.FunctionGetSchedulingParamsResponse()
            clean.autoscaler_configuration.settings.CopyFrom(raw.settings)
            if raw.HasField("override_settings"):
                clean.autoscaler_configuration.override_settings.CopyFrom(
                    raw.override_settings
                )
            shape["overrideEventCount"] = len(raw.override_events)
        else:
            src = response.function
            clean = wire.FunctionGetResponse(function_id="fu-HostedFixture")
            clean.handle_metadata.app_id = "ap-HostedFixture"
            clean.handle_metadata.base_function_id = "fu-HostedFixture"
            clean.handle_metadata.function_name = "identity_probe"
            clean.handle_metadata.function_type = response.handle_metadata.function_type
            clean.function.module_name = "hosted_fixture" if src.module_name else ""
            clean.function.function_name = "identity_probe"
            clean.function.function_type = src.function_type
            clean.function.timeout_secs = src.timeout_secs
            clean.function.startup_timeout_secs = src.startup_timeout_secs
            clean.function.task_idle_timeout_secs = src.task_idle_timeout_secs
            for rank in src.ranked_functions:
                out_rank = clean.function.ranked_functions.add(rank=rank.rank)
                if not rank.HasField("function"):
                    continue
                original = getattr(rank, "function")
                out = getattr(out_rank, "function")
                out.app_name = (
                    "hosted-cpu-fixture" if original.app_name == bounds.app_name else ""
                )
                out.function_name = "identity_probe" if original.function_name else ""
                out.image_id = "im-HostedFixture" if original.image_id else ""
                out.definition_type = original.definition_type
                out.function_type = original.function_type
                out.timeout_secs = original.timeout_secs
                out.startup_timeout_secs = original.startup_timeout_secs
                out.task_idle_timeout_secs = original.task_idle_timeout_secs
                if original.HasField("resources"):
                    out.resources.CopyFrom(original.resources)
                if original.HasField("scheduler_placement"):
                    out.scheduler_placement.CopyFrom(original.scheduler_placement)
                if original.HasField("autoscaler_settings"):
                    out.autoscaler_settings.CopyFrom(original.autoscaler_settings)
                if original.HasField("retry_policy"):
                    out.retry_policy.CopyFrom(original.retry_policy)
                for field in (
                    "concurrency_limit",
                    "max_inputs",
                    "max_concurrent_inputs",
                    "target_concurrent_inputs",
                ):
                    setattr(out, field, getattr(original, field))
            shape["variantAppNameMatched"] = bool(
                src.ranked_functions
                and getattr(src.ranked_functions[0], "function").app_name
                == bounds.app_name
            )
        shape[method] = wire_b64(clean)

    async def deploy_modal(self, state):
        import modal
        from modal.exception import NotFoundError
        from modal_verifier import Bounds, immutable_app_name, inspect
        from phase2_modal_app import build_app

        self.sdk = await modal.Client.from_env.aio()
        params = hashlib.sha256(f"{DIGEST}:{state['jobId']}".encode()).hexdigest()
        module = "hand_pose_cpu_v1@1"
        self.modal_name = immutable_app_name(module, self.head, params)
        try:
            await modal.App.lookup.aio(
                self.modal_name, environment_name=ENVIRONMENT, client=self.sdk
            )
        except NotFoundError:
            pass
        else:
            raise ProviderError("temporary_modal_name_already_exists")
        self.modal_attempted = True
        state["modalName"] = self.modal_name
        app = build_app(self.modal_name)
        async with asyncio.timeout(100):
            await app.deploy.aio(
                name=self.modal_name, environment_name=ENVIRONMENT, client=self.sdk
            )
        state["modalAppId"] = validated_id(app.app_id, "ap")
        bounds = Bounds(
            self.modal_name,
            ENVIRONMENT,
            "identity_probe",
            module,
            "none",
            1,
            MANIFEST["modalMaxCpuMilli"],
            MANIFEST["modalMaxMemoryMib"],
            MANIFEST["modalMaxBilledSeconds"],
            MANIFEST["modalCpuMicroUsdPerSecond"],
            0,
        )
        observed = await inspect(
            self.sdk,
            bounds,
            {},
            timeout=20,
            observer=lambda method, response: self.capture_shape(
                state, bounds, method, response
            ),
        )
        return {
            "bounds": asdict(bounds),
            "code_revision": self.head,
            "params_sha256": params,
            **asdict(observed),
        }

    def owns(self, row):
        if (
            row.get("name") != NAME
            or row.get("ownerId") != self.owner
            or row.get("buildConfig", {}).get("branch") != MANIFEST["branch"]
            or row.get("buildConfig", {}).get("runtime") != "python"
        ):
            raise ProviderError("refusing_non_spike_render_service")
        ident = validated_id(row.get("id"), "wfl")
        if ident == LIVE_WORKFLOW_ID:
            raise ProviderError("refusing_live_workflow")
        return ident

    async def create_render(self, binding):
        from modal.config import config

        values = {"SPIKE_MODE": "hosted-no-data", "PYTHON_VERSION": "3.12.13"}
        if binding is not None:
            values.update(
                SPIKE_MODAL_BINDING=json.dumps(binding, separators=(",", ":")),
                MODAL_TOKEN_ID=config["token_id"],
                MODAL_TOKEN_SECRET=config["token_secret"],
            )
            if not values["MODAL_TOKEN_ID"] or not values["MODAL_TOKEN_SECRET"]:
                raise ProviderError("modal_service_credential_unavailable")
        self.create_params = {
            "ownerId": self.owner,
            "name": NAME,
            "region": "oregon",
            "autoDeployTrigger": "off",
            "buildConfig": {
                "branch": MANIFEST["branch"],
                "repo": "https://github.com/StateAction-ai/stateaction",
                "runtime": "python",
                "buildCommand": "python -m pip install uv==0.13.6 && uv sync --locked --no-dev --project spikes/python-plane/controller",
            },
            "runCommand": "PYTHONPATH=spikes/python-plane/providers spikes/python-plane/controller/.venv/bin/python spikes/python-plane/controller/workflow.py",
            "envVars": [{"key": key, "value": value} for key, value in values.items()],
        }
        self.render_attempted = True
        created = await self.api.request("POST", "workflows", body=self.create_params)
        ident = validated_id(created.get("id"), "wfl")
        self.workflow = ident
        row = await self.api.request("GET", f"workflows/{ident}")
        self.workflow = self.owns(row)
        if row.get("slug") != NAME or row.get("autoDeployTrigger") != "off":
            raise ProviderError("unexpected_spike_slug_or_autodeploy")
        return ident

    async def register(self, workflow):
        # A create can arrange the initial build even with auto deploy off.
        versions = entries(
            await self.api.request(
                "GET", "workflowversions", query={"workflowID": workflow}
            ),
            "workflowVersion",
        )
        if not versions:
            await self.api.request(
                "POST",
                "workflowversions",
                body={"workflowId": workflow, "commit": self.head},
            )
        for _ in range(90):
            await self.monitor()
            row = await self.api.request("GET", f"workflows/{workflow}")
            version_id = row.get("defaultVersionId")
            if version_id:
                version = await self.api.request(
                    "GET", f"workflowversions/{validated_id(version_id, 'wfv')}"
                )
                if version["status"] == "ready":
                    commit = version.get("name", "")
                    if not re.fullmatch(
                        r"[0-9a-f]{7,40}", commit
                    ) or not self.head.startswith(commit):
                        raise ProviderError("render_version_commit_mismatch")
                    tasks = entries(
                        await self.api.request(
                            "GET", "tasks", query={"workflowVersionId": version_id}
                        ),
                        "task",
                    )
                    if {task["name"] for task in tasks} != {
                        "process-recording",
                        "modal-cpu-probe",
                    }:
                        raise ProviderError("render_task_registration_mismatch")
                    return {
                        "versionId": version_id,
                        "commit": commit,
                        "tasks": [task["name"] for task in tasks],
                        "taskIds": [
                            validated_id(task.get("id"), "tsk") for task in tasks
                        ],
                    }
            await asyncio.sleep(2)
        raise ProviderError("render_registration_elapsed")

    async def start(self, job_id, kind):
        if kind == "process-recording":
            ident = await command(
                "node",
                HERE / "phase2_dispatch.mjs",
                job_id,
                env={
                    "PATH": os.environ["PATH"],
                    "HOME": os.environ["HOME"],
                    "RENDER_API_KEY": self.token,
                },
            )
        else:
            response = await self.api.request(
                "POST",
                "task-runs",
                body={
                    "task": f"{NAME}/{kind}",
                    "input": [{"jobId": job_id}],
                    "idempotencyKey": f"cpu:{job_id}",
                },
            )
            ident = response.get("taskRunId") or response.get("id")
        self.known_runs.append(validated_id(ident, "trn"))
        return ident

    async def wait_run(self, ident):
        return await self.api.wait_run(
            ident, self.monitor, MANIFEST["renderRunWaitSeconds"]
        )

    async def cleanup(self, state):
        import modal
        from modal.exception import NotFoundError
        from redeploy_probe import gross

        async def render_cleanup():
            if not self.render_attempted:
                return {"workflowRemoved": True}
            # Lookup after lost create response. The exact name was absent at preflight.
            rows = await self.list_ours()
            if len(rows) > 1:
                raise ProviderError("ambiguous_temporary_workflow")
            if not rows and self.workflow:
                found = await self.api.request(
                    "GET", f"workflows/{self.workflow}", missing=True
                )
                if found is not None:
                    rows = [found]
            elif not rows:
                # The POST could have succeeded despite a lost response.
                for _ in range(12):
                    await asyncio.sleep(2)
                    rows = await self.list_ours()
                    if rows:
                        break
            if len(rows) > 1:
                raise ProviderError("ambiguous_temporary_workflow")
            if rows:
                ident = self.owns(rows[0])
                if self.workflow is not None and self.workflow != ident:
                    raise ProviderError("workflow_identity_changed")
                runs = entries(
                    await self.api.request(
                        "GET", "task-runs", query={"workflowId": ident}
                    ),
                    "taskRun",
                )
                for run in runs:
                    if run["status"] not in END_STATES:
                        run_id = validated_id(
                            run.get("id") or run.get("taskRunId"), "trn"
                        )
                        task_ids = state.get("registration", {}).get("taskIds", [])
                        if (
                            run_id not in self.known_runs
                            and run.get("taskId") not in task_ids
                        ):
                            raise ProviderError("refusing_unverified_task_cancellation")
                        await self.api.request(
                            "DELETE", f"task-runs/{run_id}", missing=True
                        )
                await self.api.request("DELETE", f"workflows/{ident}", missing=True)
                if (
                    await self.api.request("GET", f"workflows/{ident}", missing=True)
                    is not None
                ):
                    raise ProviderError("temporary_workflow_still_present")
            if await self.list_ours():
                raise ProviderError("temporary_workflow_still_listed")
            return {"workflowRemoved": True}

        async def modal_cleanup():
            if not self.modal_attempted:
                return {"modalStopped": True}
            exact = state.get("modalAppId")
            try:
                app = await modal.App.lookup.aio(
                    exact or self.modal_name,
                    environment_name=ENVIRONMENT,
                    client=self.sdk,
                )
            except NotFoundError:
                if exact is not None:
                    raise
                return {"modalStopped": True}
            ident = validated_id(app.app_id, "ap")
            await app.stop.aio(client=self.sdk)
            for _ in range(30):
                app = await modal.App.lookup.aio(ident, client=self.sdk)
                if (await app.info.aio()).lifecycle.state.name == "STOPPED":
                    try:
                        await modal.App.lookup.aio(
                            self.modal_name,
                            environment_name=ENVIRONMENT,
                            client=self.sdk,
                        )
                    except NotFoundError:
                        return {"modalStopped": True, "modalAppId": ident}
                await asyncio.sleep(2)
            raise ProviderError("temporary_modal_app_still_present")

        results = await asyncio.gather(
            render_cleanup(), modal_cleanup(), return_exceptions=True
        )
        checked = {"workflowRemoved": False, "modalStopped": False}
        for label, result in zip(("render", "modal"), results, strict=True):
            if isinstance(result, BaseException):
                checked[label + "CleanupError"] = safe_error(result)
            else:
                checked.update(result)
        checked["live"] = await self.snapshot()
        if self.baseline is not None:
            final = await gross()
            checked.update(
                finalGrossUsd=str(final),
                deltaUsd=str(final - self.baseline),
                grossWithinLimits=final < Decimal(MANIFEST["modalGrossUsd"])
                and final - self.baseline <= Decimal(MANIFEST["modalDeltaUsd"]),
            )
        return checked


def safe_error(error):
    if isinstance(error, ProviderError):
        return str(error)
    from modal_verifier import DefinitionRejected

    if isinstance(error, DefinitionRejected):
        return f"ModalDefinitionRejected:{error}"
    return type(error).__name__


def log(event, text):
    stamp = datetime.now(UTC).isoformat(timespec="seconds")
    with SPEND.open("a") as output:
        output.write(f"{stamp} Python-plane {event} {text}\n")


async def execute(adapter, state, save, *, hosted):
    state["jobId"] = str(uuid4())
    state["manifestSha256"] = DIGEST
    state["dispatches"] = {}
    preflight = await adapter.preflight()
    state["preflight"] = preflight
    save(state)
    if hosted:
        log(
            "HOSTED WINDOW START",
            f"manifest {DIGEST}, gross USD {preflight['baselineGrossUsd']}, USD 0.25 delta, USD 22 gross, one CPU call, zero GPU, no data.",
        )
        await command(TICKETLOG, "spike/python-plane", "hosted_start", DIGEST)
    try:
        await adapter.monitor(force=True)
        try:
            binding = await adapter.deploy_modal(state)
        except Exception as error:
            from modal_verifier import DefinitionRejected

            if not isinstance(error, (DefinitionRejected, TimeoutError)):
                raise
            state["modalError"] = safe_error(error)
            binding = None
        save(state)
        await adapter.monitor(force=True)
        workflow = await adapter.create_render(binding)
        state["temporaryWorkflowId"] = workflow
        save(state)
        state["registration"] = await adapter.register(workflow)
        save(state)
        task_kinds = (
            ("process-recording", "modal-cpu-probe")
            if binding is not None
            else ("process-recording",)
        )
        for kind in task_kinds:
            await adapter.monitor(force=True)
            ident = await adapter.start(state["jobId"], kind)
            state["dispatches"][kind] = {"runId": ident}
            save(state)
            run = await adapter.wait_run(ident)
            result = run.get("results", [])
            if run["status"] not in {"completed", "succeeded"} or len(result) != 1:
                raise ProviderError(f"{kind}_failed")
            state["dispatches"][kind]["result"] = result[0]
            save(state)
            if result[0].get("runId") != ident:
                raise ProviderError(f"{kind}_identity_mismatch")
            if kind == "process-recording":
                state["recoveryPrimitivesPassed"] = bool(
                    result[0].get("journalFence") and result[0].get("pidfdTerminal")
                )
            if kind == "modal-cpu-probe":
                validated_id(result[0].get("callId"), "fc")
                if not result[0].get("terminal") or (
                    hosted
                    and result[0].get("definitionSha256")
                    != binding["definition_sha256"]
                ):
                    raise ProviderError("modal_cpu_terminal_proof_failed")
    except BaseException as error:
        state["error"] = safe_error(error)
    finally:
        try:
            state["cleanup"] = await adapter.cleanup(state)
        except BaseException as error:
            state["cleanupError"] = safe_error(error)
        save(state)
        if hosted:
            cleanup = state.get("cleanup", {})
            log(
                "HOSTED WINDOW END",
                f"manifest {DIGEST}, gross {cleanup.get('finalGrossUsd', 'unverified')}, workflow removed {cleanup.get('workflowRemoved', False)}, Modal stopped {cleanup.get('modalStopped', False)}.",
            )
            await command(TICKETLOG, "spike/python-plane", "hosted_stop", DIGEST)
    return state


class Local:
    """Simulate provisioning, metering and Modal transport around the real local Render runner."""

    def __init__(self, failure):
        self.failure = failure
        self.proc = None
        self.modal_attempted = False
        self.client = None
        self.known_runs = []

    async def preflight(self):
        return {key: MANIFEST[key] for key in ("webDeployment", "liveWorkflowVersion")}

    async def monitor(self, force=False):
        return None

    async def deploy_modal(self, state):
        self.modal_attempted = True
        state["modalAppId"] = "ap-LocalFixture"
        return {"definition_sha256": "0" * 64}

    async def create_render(self, binding):
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        self.origin = f"http://127.0.0.1:{port}"
        self.client = httpx.AsyncClient(
            base_url=f"{self.origin}/v1/", trust_env=False, timeout=5
        )
        self.api = RenderAPI(self.client)
        render = ROOT / "artifacts/platform-tools/render/render"
        self.proc = await asyncio.create_subprocess_exec(
            render,
            "workflows",
            "dev",
            "--port",
            str(port),
            "--env-file",
            "/dev/null",
            "--",
            sys.executable,
            "workflow.py",
            cwd=HERE,
            env={
                "PATH": os.environ["PATH"],
                "HOME": os.environ["HOME"],
                "DO_NOT_TRACK": "1",
                "RENDER_CLI_CONFIG_DIR": str(HERE),
                "SPIKE_MODE": "local-phase2",
            },
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        if self.failure == "lost_create":
            raise ProviderError("injected_lost_create_ack")
        return "wfl-LocalFixture"

    async def register(self, workflow):
        for _ in range(45):
            try:
                response = await self.api.request("GET", "tasks")
                names = {row["name"] for row in entries(response, "task")}
                if names == {"process-recording", "modal-cpu-probe"}:
                    return {"versionId": "wfv-LocalFixture", "tasks": sorted(names)}
            except (httpx.RequestError, ProviderError):
                pass
            if self.proc.returncode is not None:
                raise ProviderError("local_runner_exited")
            await asyncio.sleep(0.25)
        raise ProviderError("local_registration_elapsed")

    async def start(self, job_id, kind):
        if kind == "process-recording":
            run_id = await command(
                "node",
                HERE / "phase2_dispatch.mjs",
                job_id,
                env={
                    "PATH": os.environ["PATH"],
                    "HOME": os.environ["HOME"],
                    "SPIKE_LOCAL_RENDER_URL": self.origin,
                },
            )
        else:
            response = await self.api.request(
                "POST",
                "task-runs",
                body={
                    "task": kind,
                    "input": [{"jobId": job_id}],
                    "idempotencyKey": f"cpu:{job_id}",
                },
            )
            run_id = response.get("taskRunId") or response.get("id")
        self.known_runs.append(run_id)
        if self.failure == "lost_start":
            raise ProviderError("injected_lost_start_ack")
        return run_id

    async def wait_run(self, ident):
        return await self.api.wait_run(ident, self.monitor, 25)

    async def cleanup(self, _state):
        if self.proc is not None:
            if self.proc.returncode is None:
                try:
                    self.proc.terminate()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except TimeoutError:
                self.proc.kill()
                await self.proc.wait()
        if self.client is not None:
            await self.client.aclose()
            try:
                async with httpx.AsyncClient(timeout=1, trust_env=False) as client:
                    await client.get(self.origin)
            except httpx.ConnectError:
                pass
            else:
                raise ProviderError("local_runner_still_listening")
        self.modal_attempted = False
        return {
            "workflowRemoved": self.proc is None or self.proc.returncode is not None,
            "modalStopped": not self.modal_attempted,
            "live": await self.preflight(),
        }


def complete(state):
    cleanup = state.get("cleanup", {})
    return (
        not state.get("error")
        and not state.get("modalError")
        and not state.get("cleanupError")
        and cleanup.get("workflowRemoved")
        and cleanup.get("modalStopped")
        and cleanup.get("grossWithinLimits", True)
        and all(
            cleanup.get("live", {}).get(key) == MANIFEST[key]
            for key in ("liveWorkflowVersion", "webDeployment")
        )
    )


async def hosted_run(digest):
    if DIGEST != digest:
        raise ProviderError("manifest_approval_does_not_match")
    code_pins = MANIFEST.get("codeSha256")
    if not code_pins or any(
        hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != expected
        for path, expected in code_pins.items()
    ):
        raise ProviderError("manifest_code_pin_mismatch")
    if RECEIPT.exists():
        raise ProviderError("hosted_receipt_already_exists")
    if await command("git", "branch", "--show-current") != MANIFEST["branch"]:
        raise ProviderError("unexpected_spike_branch")
    head = await command("git", "rev-parse", "HEAD")
    if await command("git", "status", "--porcelain"):
        raise ProviderError("dirty_spike_branch")

    def save(state):
        tmp = RECEIPT.with_suffix(".tmp")
        with tmp.open("w") as output:
            json.dump(state, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        tmp.replace(RECEIPT)

    token = render_token()
    async with httpx.AsyncClient(
        base_url="https://api.render.com/v1/",
        headers={"Authorization": f"Bearer {token}"},
        trust_env=False,
        follow_redirects=False,
        timeout=12,
    ) as client:
        adapter = Hosted(RenderAPI(client), token, head)
        task = asyncio.create_task(execute(adapter, {"head": head}, save, hosted=True))
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(signum, task.cancel)
        state = await task
    print(json.dumps(state))
    return 0 if complete(state) else 1


async def local_run(failure):
    state = await execute(Local(failure), {}, lambda state: None, hosted=False)
    expected = "injected_" + failure + "_ack" if failure else None
    if failure:
        valid = (
            state.get("error") == expected
            and state.get("cleanup", {}).get("workflowRemoved")
            and state["cleanup"]["modalStopped"]
        )
    else:
        valid = complete(state)
    print(json.dumps(state))
    return 0 if valid else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--hosted-manifest")
    modes.add_argument("--rehearse", action="store_true")
    modes.add_argument("--digest", action="store_true")
    parser.add_argument("--failure", choices=["lost_create", "lost_start"])
    args = parser.parse_args()
    try:
        if args.digest:
            print(DIGEST)
        elif args.rehearse:
            sys.exit(asyncio.run(local_run(args.failure)))
        else:
            sys.exit(asyncio.run(hosted_run(args.hosted_manifest)))
    except Exception as error:
        sys.exit(safe_error(error))
