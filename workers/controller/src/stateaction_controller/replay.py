"""Replay a local CPU stage using cached fixtures without claiming a job."""

import asyncio
import json
import os
import re
from hashlib import sha256
from pathlib import Path
from shutil import copyfile
from uuid import UUID

from stateaction_contracts import request_sha256

from .config import modules
from .diagnostics import read_regular


async def replay(
    api,
    job_id,
    stage,
    io_dir,
    cache_dir,
    python,
    *,
    module=None,
    allow_spend=False,
    run=None,
):
    if str(UUID(job_id)) != job_id or stage not in ("segment", "caption"):
        raise ValueError("Expected job UUID and segment or caption stage")
    recipe = await api.recipe(job_id)
    if not recipe:
        raise ValueError("Job has no recipe")
    spec = next((row for row in recipe["stages"] if row["stage"] == stage), None)
    if not spec:
        raise ValueError("Recipe does not contain the stage")
    module = module or spec["module"]
    if "@" not in module:
        module += "@1"
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,5}", module):
        raise ValueError("Invalid replay module")
    if spec["resources"]["gpu"] != "none" or module.startswith("flora_"):
        if not allow_spend:
            raise ValueError("GPU stage requires --allow-spend and the Modal harness")
        if module.startswith("flora_"):
            raise ValueError("FLORA runs through the Modal harness")
    manifest = modules().get(module)
    if (
        not manifest
        or manifest["stage"] != stage
        or manifest["gpu"]["minimum"] != "none"
    ):
        raise ValueError("Invalid local replay module")
    recipe = dict(
        recipe,
        stages=[
            {**row, "module": module} if row is spec else row
            for row in recipe["stages"]
        ],
    )
    digest = request_sha256(recipe)
    cache = Path(cache_dir) / job_id
    task = json.loads(read_regular(cache / "task-input.json", 1024 * 1024))
    io_dir = Path(io_dir)
    io_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    copyfile(cache / "source.mcap", io_dir / "source.mcap")
    bootstrap = {
        "schemaVersion": 2,
        "jobId": job_id,
        "executionRef": f"replay-{job_id}",
        "stage": stage,
        "module": module,
        "recipeSha256": digest,
        "taskInput": {
            **task,
            "schemaVersion": 3,
            "recipe": recipe,
            "recipeSha256": digest,
        },
    }
    if stage == "caption":
        segments = read_regular(cache / "outputs/segments.json", 64 * 1024 * 1024)
        (io_dir / "segments.json").write_bytes(segments)
        bootstrap["segmentsSha256"] = sha256(segments).hexdigest()
    (io_dir / "bootstrap.json").write_text(json.dumps(bootstrap))
    argv = [
        python,
        "-m",
        "stateaction_processing",
        "run-stage",
        "--io-dir",
        str(io_dir),
    ]
    env = {
        "PATH": os.environ.get("PATH", ""),
        "APP_ENV": "local",
        "PYTHONNOUSERSITE": "1",
    }
    if run:
        code = await run(argv, env)
    else:
        child = await asyncio.create_subprocess_exec(*argv, env=env)
        try:
            async with asyncio.timeout(spec["resources"]["budgetSeconds"]):
                code = await child.wait()
        finally:
            if child.returncode is None:
                child.kill()
                await child.wait()
    receipt_path = io_dir / "receipt.json"
    receipt = (
        json.loads(read_regular(receipt_path, 128 * 1024))
        if receipt_path.exists()
        else None
    )
    return {"exitCode": code, "module": module, "receipt": receipt}
