"""Build a bounded diagnostic archive from allowlisted job and worker facts."""

import io
import json
import os
import re
import stat
import tarfile
from pathlib import Path
from tempfile import NamedTemporaryFile
from uuid import UUID

from .config import modules
from .journal import JournalCorrupt
from .local_process import last_receipt
from .results import parse_receipt

MAX_BUNDLE = 8 * 1024 * 1024
MAX_BLOB = 256 * 1024
CREDENTIAL = re.compile(
    r"([A-Za-z0-9_.-]*(?:token|secret|password|passwd|authorization|signature|credential|"
    r"api[_-]?key|access[_-]?key|private[_-]?key|session|cookie|x-amz-[a-z-]+)[A-Za-z0-9_.-]*)"
    r"""(["']?\s*[:=]\s*)(["']?)(?:Bearer\s+|Basic\s+)?[^\s"',}]+""",
    re.I,
)
SIGNED = re.compile(r"""https?://[^\s"']*[?&](?:X-Amz-|token=)[^\s"']*""", re.I)


def scrub_text(value):
    value = SIGNED.sub("[redacted-url]", value)
    value = re.sub(r"sa_svc_[A-Za-z0-9_-]+", "[redacted]", value)
    value = CREDENTIAL.sub(r"\1\2\3[redacted]", value)
    return re.sub(
        r"\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", value, flags=re.I
    )


def read_regular(file, limit):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Expected a regular file")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Diagnostic input exceeds its size limit")
        return data


def select(record, keys):
    return {key: record[key] for key in keys if key in record}


async def collect(api, store, job_id, cache_dir=None):
    if str(UUID(job_id)) != job_id:
        raise ValueError("Expected a job UUID")
    entries = {}

    def cleaned(value):
        if isinstance(value, dict):
            return {
                key: "[redacted]" if CREDENTIAL.match(key + "=x") else cleaned(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [cleaned(item) for item in value]
        return scrub_text(value) if isinstance(value, str) else value

    def add(path, value):
        entries[path] = (json.dumps(cleaned(value), indent=2) + "\n").encode()

    add("job-status.json", await api.status(job_id))
    recipe = await api.recipe(job_id)
    prior = []
    if recipe:
        add("recipe.json", recipe)
        add("dag-run.json", await api.dag(job_id))
        prior = (await api.prior_stages(job_id))["stages"]
        add("outputs.json", prior)

    stage_modules = (
        {spec["stage"]: spec["module"] for spec in recipe["stages"]} if recipe else {}
    )
    for stage in ("segment", "caption", "hand_pose"):
        facts = {"stage": stage}
        try:
            local = store.read_local(job_id, stage)
            if local:
                facts["local"] = select(
                    local,
                    (
                        "phase",
                        "executionRef",
                        "pid",
                        "exit",
                        "termination",
                        "startDeadline",
                        "executionDeadline",
                        "budgetDeadline",
                    ),
                )
            modal = store.read_modal(job_id, stage, stage_modules.get(stage))
            if modal:
                facts["modal"] = select(
                    modal, ("phase", "callId", "exitCode", "termination")
                )
        except JournalCorrupt:
            facts["unreadable"] = True
        add(f"journals/{stage}.json", facts)
        raw = last_receipt(store, {"jobId": job_id, "stage": stage})
        receipt = None
        if raw and raw.get("module") in modules():
            receipt = parse_receipt(raw, (job_id, stage, raw["module"]), None)
        add(f"logs/{stage}.json", {"stage": stage, "receipt": receipt})
    blobs = []
    for stage in prior:
        for output in stage["outputs"]:
            item = {
                "stage": stage["stage"],
                **select(output, ("fileId", "role", "slot", "sizeBytes")),
            }
            if cache_dir and item["role"] == "diagnostic_blob":
                slot = item["slot"]
                parent = (Path(cache_dir) / job_id / "outputs").resolve()
                path = parent / slot
                if Path(slot).is_absolute() or not path.resolve().is_relative_to(
                    parent
                ):
                    raise ValueError("Invalid diagnostic slot")
                try:
                    data = read_regular(path, MAX_BLOB)
                except FileNotFoundError:
                    pass
                else:
                    file_id = str(UUID(item["fileId"]))
                    entries[f"blobs/{file_id}.txt"] = scrub_text(
                        data.decode("utf-8", errors="replace")
                    ).encode()
                    item["included"] = True
            blobs.append(item)
    add("blobs.json", blobs)
    if sum(map(len, entries.values())) > MAX_BUNDLE:
        raise ValueError("Diagnostic bundle exceeds its size limit")
    return entries


def write_bundle(entries, path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Output path must not be a symlink")
    temp = None
    try:
        with NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temp = Path(stream.name)
            with tarfile.open(fileobj=stream, mode="w:gz") as archive:
                for name, value in entries.items():
                    member = tarfile.TarInfo(name)
                    member.size, member.mode = len(value), 0o600
                    archive.addfile(member, io.BytesIO(value))
        temp.replace(path)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)
    return {"files": len(entries), "bytes": path.stat().st_size}
