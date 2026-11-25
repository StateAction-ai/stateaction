"""Render workflow task using the server's fixed process-recording slug suffix."""

import os
from pathlib import Path

from api import JobsApi
from controller import run_controller
from executor import StubExecutor
from phase2_probe import call_modal, verify_recovery_primitives
from render import Retry, TaskContext, Workflows
from stateaction_contracts import parse_contract

app = Workflows()


@app.task(
    name="process-recording",
    timeout_seconds=8 * 60 * 60,
    plan="flex",
    retry=Retry(max_retries=2, wait_duration_ms=30_000, backoff_scaling=1),
)
def process_recording(ctx: TaskContext, value: dict) -> dict:
    parse_contract("jobs.controller-input.v1", value)
    run_id = ctx.metadata.task_run_id
    if not run_id:
        raise RuntimeError("Missing Render task identity")
    mode = os.environ.get("SPIKE_MODE")
    if mode in ("hosted-no-data", "local-phase2"):
        try:
            return verify_recovery_primitives(value["jobId"], run_id)
        except Exception as error:
            # Fail with safe evidence and avoid repeated infrastructure probes.
            return {
                "mode": "hosted-no-data",
                "runId": run_id,
                "failure": type(error).__name__,
            }
    if mode != "local-stub":
        raise RuntimeError("Unknown spike mode")
    api = JobsApi(
        os.environ["STATEACTION_API_URL"],
        Path(os.environ["CONTROLLER_CAPABILITY_FILE"]).read_text().strip(),
    )
    try:
        return run_controller(
            api,
            StubExecutor(),
            Path(os.environ["JOBS_STATE_DIR"]),
            value["jobId"],
            run_id,
        )
    finally:
        api.close()


@app.task(
    name="modal-cpu-probe",
    plan="flex",
    timeout_seconds=90,
    retry=Retry(max_retries=0, wait_duration_ms=1000),
)
async def modal_cpu_probe(ctx: TaskContext, value: dict) -> dict:
    parse_contract("jobs.controller-input.v1", value)
    run_id = ctx.metadata.task_run_id
    if not run_id:
        raise RuntimeError("Missing Render task identity")
    mode = os.environ.get("SPIKE_MODE")
    if mode == "local-phase2":
        return {"terminal": True, "runId": run_id, "callId": "fc-LoopbackFixture"}
    if mode != "hosted-no-data":
        raise RuntimeError("CPU probe requires an active spike service")
    return await call_modal(run_id)


if __name__ == "__main__":
    app.start()
