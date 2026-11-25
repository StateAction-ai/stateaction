"""No-data workflows for the temporary hosted service."""

import asyncio
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

from journal import Journal


def verify_recovery_primitives(job_id, run_id):
    """Use real fsync, subprocess and pidfd operations on synthetic state."""
    with tempfile.TemporaryDirectory(prefix="python-plane-") as temp:
        journal = Journal(Path(temp), job_id)
        if not journal.reserve(run_id):
            raise RuntimeError("unexpected journal reservation")
        journal.write(run_id, "spawning")
        # This child blocks on stdin and cannot create descendants or use data.
        child = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.buffer.read()"],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            fd = os.pidfd_open(child.pid)
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
                if (
                    not select.select([fd], [], [], 3)[0]
                    or child.wait(timeout=3) != -signal.SIGKILL
                ):
                    raise RuntimeError("exact child was not observed dead")
            finally:
                os.close(fd)
            saved = json.loads(journal.path.read_text())
            if saved["phase"] != "spawning" or journal.reserve(run_id):
                raise RuntimeError("ambiguous intent failed to fence reentry")
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
            if child.stdin:
                child.stdin.close()
    return {
        "mode": "hosted-no-data",
        "journalFence": True,
        "pidfdTerminal": True,
        "runId": run_id,
    }


async def call_modal(run_id):
    import modal
    from modal_executor import ModalExecutor, ModalTarget
    from modal_verifier import Bounds, verify_binding

    target = json.loads(os.environ["SPIKE_MODAL_BINDING"])
    bounds = Bounds(**target["bounds"])
    if bounds.gpu != "none" or bounds.max_containers != 1:
        raise RuntimeError("probe binding must be CPU-only")
    sdk = await modal.Client.from_env.aio()
    verifier = ModalExecutor(
        ModalTarget(
            bounds.app_name,
            bounds.object_tag,
            bounds.environment,
            target["function_id"],
        ),
        sdk=modal,
        client=sdk,
        api_timeout=8,
    )
    call_id = None
    deadline = asyncio.get_running_loop().time() + 40
    try:
        async with asyncio.timeout_at(deadline):
            definition = await verify_binding(
                sdk,
                bounds,
                {},
                code_revision=target["code_revision"],
                params_sha256=target["params_sha256"],
                function_id=target["function_id"],
                definition_id=target["definition_id"],
                definition_sha256=target["definition_sha256"],
                timeout=18,
            )
            call_id = await verifier.spawn(
                {"probe": "python-plane-cpu", "runId": run_id},
                lambda: asyncio.get_running_loop().time() < deadline,
            )
            while True:
                reply = await verifier.poll(call_id)
                if reply["kind"] == "returned":
                    if reply["value"] != {
                        "callId": call_id,
                        "probe": "python-plane-cpu",
                        "runId": run_id,
                    }:
                        raise RuntimeError("bad CPU proof")
                    return {
                        "callId": call_id,
                        "runId": run_id,
                        "definitionSha256": definition.definition_sha256,
                        "terminal": True,
                    }
                if reply["kind"] == "unavailable":
                    raise RuntimeError("CPU proof unavailable")
                await asyncio.sleep(0.1)
    except Exception:
        if call_id is not None:
            try:
                await verifier.cancel(call_id)
            except Exception:
                pass
        return {"runId": run_id, "callId": call_id, "terminal": False}
    finally:
        await sdk.close.aio()
