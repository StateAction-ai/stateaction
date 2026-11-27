"""Run one controller entry in a process that a fixture can stop."""

import asyncio
import json
import os
import signal

from stateaction_controller import local_controller
from stateaction_controller.api import JobsApi
from stateaction_controller.config import load_settings, secret
from stateaction_controller.controller import run_controller


async def main():
    settings = load_settings()
    api = JobsApi(settings.api_url, secret("CONTROLLER_CAPABILITY"), loopback=True)
    where = os.environ.get("SA153_STALL_HAND")
    if where:
        sibling_settled = asyncio.Event()

        def stall():
            marker = settings.state_dir / "test-stalled"
            fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
            os.kill(os.getpid(), signal.SIGSTOP)

        real_act = api.act

        async def act(job, action, **facts):
            result = await real_act(job, action, **facts)
            if action == "record_stage_run":
                stage, state = facts["stage"], facts["state"]
                if stage == "caption" and state == "not_run":
                    sibling_settled.set()
                elif where == "after" and stage == "hand_pose" and state == "running":
                    await sibling_settled.wait()
                    stall()
            return result

        api.act = act
        if where == "before":
            real_send = local_controller.send_bootstrap

            async def send(child, payload):
                if json.loads(payload).get("stage") == "hand_pose":
                    # Stop only the intended interleaving. Freezing the controller
                    # while the sibling also spawns would make its outcome unknown.
                    await sibling_settled.wait()
                    stall()
                await real_send(child, payload)

            local_controller.send_bootstrap = send
    try:
        result = await run_controller(
            settings, api, os.environ["TEST_JOB_ID"], os.environ["TEST_RUN_REF"]
        )
        print(json.dumps(result))
    finally:
        await api.close()


asyncio.run(main())
