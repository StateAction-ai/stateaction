"""Loopback task fixture for historical workflow rows and archived artifacts."""

from historical_controller import run_controller
from render import Retry, TaskContext, Workflows
from stateaction_contracts import parse_contract
from stateaction_controller.api import JobsApi
from stateaction_controller.config import load_settings, secret
from stateaction_controller.modal_executor import ModalExecutor

app = Workflows()


@app.task(
    name="process-recording",
    timeout_seconds=8 * 60 * 60,
    plan="flex",
    retry=Retry(max_retries=0, wait_duration_ms=30_000, backoff_scaling=1),
)
async def process_recording(ctx: TaskContext, value: dict) -> dict:
    parse_contract("jobs.controller-input.v1", value)
    run_ref = ctx.metadata.task_run_id
    if not run_ref:
        raise ValueError("Missing Render task identity")
    settings = load_settings()
    api = JobsApi(
        settings.api_url,
        secret("CONTROLLER_CAPABILITY"),
        loopback=settings.backend == "local",
        timeout=settings.timeout,
    )
    executor = None
    try:
        if settings.backend == "modal":
            import modal

            executor = ModalExecutor(settings, modal)
        return await run_controller(settings, api, value["jobId"], run_ref, executor)
    finally:
        try:
            if executor is not None:
                await executor.close()
        finally:
            await api.close()


if __name__ == "__main__":
    app.start()
