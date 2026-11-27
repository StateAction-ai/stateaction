"""Validate the identity reported by the local processing executable."""

import asyncio
import json
import os

MAX_OUTPUT = 65536


async def _read(stream):
    result = bytearray()
    while chunk := await stream.read(8192):
        result.extend(chunk)
        if len(result) > MAX_OUTPUT:
            raise ValueError("Local worker health output exceeds its limit")
    return bytes(result)


async def verify_local(request, python, env=os.environ):
    if env.get("APP_ENV") != "local" or env.get("EXECUTION_BACKEND") != "local":
        raise ValueError("Worker health requires explicit local configuration")
    child = await asyncio.create_subprocess_exec(
        python,
        "-m",
        "stateaction_processing",
        "health",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={
            "PATH": env.get("PATH", ""),
            "PYTHONNOUSERSITE": "1",
            "PYTHONUNBUFFERED": "1",
        },
    )
    try:
        async with asyncio.timeout(10):
            child.stdin.write(json.dumps(request).encode())
            await child.stdin.drain()
            child.stdin.close()
            async with asyncio.TaskGroup() as tasks:
                stdout = tasks.create_task(_read(child.stdout))
                tasks.create_task(_read(child.stderr))
            if await child.wait() != 0:
                raise ValueError("Local worker health failed")
            response = json.loads(stdout.result())
            if (
                not isinstance(response, dict)
                or response.keys()
                != {"protocolVersion", "requestId", "status", "python", "workerVersion"}
                or type(response["protocolVersion"]) is not int
                or response["protocolVersion"] != 1
                or response["requestId"] != request["requestId"]
                or response["status"] != "ok"
                or not isinstance(response["python"], str)
                or not isinstance(response["workerVersion"], str)
            ):
                raise ValueError("Invalid local worker health identity")
            return response
    finally:
        child.stdin.close()
        if child.returncode is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
            await child.wait()
