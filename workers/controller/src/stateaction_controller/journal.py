"""Private durable files for submission intent and exact execution identities."""

import json
import os
import re
import stat
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from stateaction_contracts.canonical import loads_strict

from .results import call_id_valid, parse_graph_result, parse_result

STAGES = {"segment", "caption", "hand_pose"}
NODE_ID = re.compile(r"[a-z][a-z0-9_]{0,31}")
MAX_BYTES = 1_052_672
PROVIDER_BINDING_FIELDS = {
    "appName",
    "codeRevision",
    "environment",
    "functionId",
    "definitionId",
    "paramsSha256",
    "definitionSha256",
}


class JournalCorrupt(ValueError):
    pass


def instant(value):
    if not isinstance(value, str):
        raise ValueError("Invalid journal deadline")
    dt = datetime.fromisoformat(value)
    if dt.utcoffset() is None:
        raise ValueError("Invalid journal deadline")
    return dt.timestamp()


def iso(value):
    return (
        datetime.fromtimestamp(value, UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def validate_modal(record, job_id, stage, module):
    if not isinstance(record, dict):
        raise JournalCorrupt("Invalid Modal journal")
    required = {
        "version",
        "executor",
        "jobId",
        "runRef",
        "phase",
        "startDeadline",
        "executionDeadline",
    }
    optional = {
        "stage",
        "budgetDeadline",
        "callId",
        "executionRecorded",
        "evidenceRecorded",
        "cancelRequestedAt",
        "termination",
        "exitCode",
        "receipt",
        "spawnBinding",
        "graph",
    }
    phase = record.get("phase")
    identified = phase in ("submitted", "terminal")
    if (
        not required <= record.keys() <= required | optional
        or type(record["version"]) is not int
        or record["version"] != 1
        or record["executor"] != "modal"
        or record["jobId"] != job_id
        or ("stage" in record) != (stage is not None)
        or record.get("stage") != stage
        or ("graph" in record and (record["graph"] is not True or stage is None))
        or not isinstance(record["runRef"], str)
        or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", record["runRef"])
        or phase not in ("intent", "spawning", "submitted", "terminal")
        or identified != ("callId" in record)
        or (identified and not call_id_valid(record["callId"]))
        or (phase == "terminal") != ("exitCode" in record)
        or ("receipt" in record and (phase != "terminal" or stage is None))
        or ("executionRecorded" in record and not identified)
        or ("cancelRequestedAt" in record and not identified)
        or ("termination" in record and not identified)
        or ("evidenceRecorded" in record and phase != "terminal")
        or ("budgetDeadline" in record and (stage is None or phase == "intent"))
    ):
        raise JournalCorrupt("Invalid Modal journal")
    if "spawnBinding" in record:
        binding = record["spawnBinding"]
        if (
            not identified
            or stage is None
            or not isinstance(binding, dict)
            or binding.keys() != PROVIDER_BINDING_FIELDS
            or not all(isinstance(value, str) and value for value in binding.values())
        ):
            raise JournalCorrupt("Invalid Modal spawn binding")
    for key in ("executionRecorded", "evidenceRecorded"):
        if key in record and type(record[key]) is not bool:
            raise JournalCorrupt("Invalid Modal journal flag")
    if "termination" in record and (
        not isinstance(record["termination"], str)
        or not re.fullmatch(r"[a-z_]{1,80}", record["termination"])
    ):
        raise JournalCorrupt("Invalid termination")
    try:
        for key in (
            "startDeadline",
            "executionDeadline",
            "budgetDeadline",
            "cancelRequestedAt",
        ):
            if key in record:
                instant(record[key])
        if instant(record["startDeadline"]) > instant(record["executionDeadline"]):
            raise ValueError("Start deadline follows execution deadline")
    except (ValueError, OverflowError) as error:
        raise JournalCorrupt("Invalid Modal journal deadline") from error
    if phase == "terminal":
        result = terminal_result(record)
        parsed = (
            parse_graph_result(result, record["callId"])
            if record.get("graph")
            else parse_result(
                result, record["callId"], (job_id, stage, module) if stage else None
            )
        )
        if parsed is None:
            raise JournalCorrupt("Invalid terminal result")
    return record


def terminal_result(record):
    result = {
        "schemaVersion": 3 if record.get("graph") else 2 if "stage" in record else 1,
        "functionCallId": record["callId"],
        "exitCode": record["exitCode"],
    }
    if "stage" in record:
        result["receipt"] = record.get("receipt")
    return result


class JournalStore:
    def __init__(self, root: Path):
        self.root = root

    @contextmanager
    def directory(self, job_id, stage, *, create=False):
        if str(UUID(job_id)) != job_id or (
            stage is not None and not NODE_ID.fullmatch(stage)
        ):
            raise JournalCorrupt("Invalid journal path")
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
        if create:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(self.root, flags)
        try:
            for part in (None, job_id, stage):
                if part is not None:
                    if create:
                        try:
                            os.mkdir(part, 0o700, dir_fd=fd)
                            os.fsync(fd)
                        except FileExistsError:
                            pass
                    child = os.open(part, flags, dir_fd=fd)
                    os.close(fd)
                    fd = child
                info = os.fstat(fd)
                if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                    raise JournalCorrupt("Journal directory is not private")
            yield fd
        finally:
            os.close(fd)

    def _read(self, job_id, stage, name):
        try:
            with self.directory(job_id, stage) as fd:
                file_fd = os.open(
                    name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd
                )
                with os.fdopen(file_fd, "rb") as file:
                    info = os.fstat(file.fileno())
                    if (
                        not stat.S_ISREG(info.st_mode)
                        or info.st_uid != os.getuid()
                        or stat.S_IMODE(info.st_mode) != 0o600
                    ):
                        raise JournalCorrupt("Journal file is not private")
                    content = file.read(MAX_BYTES + 1)
                    if len(content) > MAX_BYTES:
                        raise JournalCorrupt("Journal file exceeds its size limit")
                    return content
        except FileNotFoundError:
            return None
        except OSError as error:
            raise JournalCorrupt("Journal file is unreadable") from error

    def _write(self, job_id, stage, name, data):
        with self.directory(job_id, stage, create=True) as fd:
            tmp = f".{uuid4().hex}.tmp"
            output = os.open(
                tmp, os.O_EXCL | os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=fd
            )
            try:
                with os.fdopen(output, "wb") as file:
                    file.write(data)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
            finally:
                try:
                    os.unlink(tmp, dir_fd=fd)
                except FileNotFoundError:
                    pass

    def reserve_spawn(self, job_id, stage):
        with self.directory(job_id, stage, create=True) as fd:
            try:
                marker = os.open(
                    "spawn.reserved",
                    os.O_EXCL | os.O_CREAT | os.O_WRONLY,
                    0o600,
                    dir_fd=fd,
                )
            except FileExistsError:
                return False
            try:
                os.fsync(marker)
                os.fsync(fd)
            finally:
                os.close(marker)
            return True

    def read_modal(self, job_id, stage, module):
        raw = self._read(job_id, stage, "modal-journal.json")
        if raw is None:
            return None
        try:
            value = loads_strict(raw.decode("utf-8"))
        except (ValueError, RecursionError) as error:
            raise JournalCorrupt("Invalid Modal journal JSON") from error
        return validate_modal(value, job_id, stage, module)

    def write_modal(self, record, module):
        job_id, stage = record["jobId"], record.get("stage")
        validate_modal(record, job_id, stage, module)
        self._write(job_id, stage, "modal-journal.json", json.dumps(record).encode())

    def has_journal(self, job_id, stage):
        try:
            return any(
                self._read(job_id, stage, name) is not None
                for name in ("journal.json", "modal-journal.json", "spawn.reserved")
            )
        except JournalCorrupt:
            return True

    def read_local(self, job_id, stage):
        raw = self._read(job_id, stage, "journal.json")
        if raw is None:
            return None
        try:
            value = loads_strict(raw.decode("utf-8"))
        except (ValueError, RecursionError) as error:
            raise JournalCorrupt("Invalid local journal JSON") from error
        return validate_local(value, job_id, stage)

    def write_local(self, record):
        job_id, stage = record["jobId"], record.get("stage")
        validate_local(record, job_id, stage)
        self._write(job_id, stage, "journal.json", json.dumps(record).encode())

    def foreign_modal(self, job_id, stage):
        return self._read(job_id, stage, "modal-journal.json") is not None

    def foreign_local(self, job_id, stage):
        return self._read(job_id, stage, "journal.json") is not None

    def save_token(self, job_id, stage, token):
        self._write(job_id, stage, "bootstrap.token", token.encode())

    def load_token(self, job_id, stage):
        data = self._read(job_id, stage, "bootstrap.token")
        if data is None:
            return None
        try:
            return data.decode("ascii")
        except UnicodeDecodeError as error:
            raise JournalCorrupt("Invalid bootstrap token") from error

    def discard_token(self, job_id, stage):
        try:
            with self.directory(job_id, stage) as fd:
                os.unlink("bootstrap.token", dir_fd=fd)
                os.fsync(fd)
        except FileNotFoundError:
            pass


def validate_local(record, job_id, stage):
    required = {
        "version",
        "jobId",
        "runRef",
        "executionRef",
        "phase",
        "bootId",
        "startDeadline",
        "executionDeadline",
    }
    optional = {
        "stage",
        "threadedPipeline",
        "budgetDeadline",
        "pid",
        "pgid",
        "sid",
        "startTicks",
        "singleProcess",
        "pidNamespace",
        "exit",
        "termination",
        "evidenceRecorded",
    }
    if (
        not isinstance(record, dict)
        or not required <= record.keys() <= required | optional
    ):
        raise JournalCorrupt("Invalid local journal")
    phase = record["phase"]
    started = phase in ("running", "exited")
    if (
        type(record["version"]) is not int
        or record["version"] != 1
        or record["jobId"] != job_id
        or record.get("stage") != stage
        or ("stage" in record) != (stage is not None)
        or phase
        not in ("intent", "execution_recorded", "spawning", "running", "exited")
        or (stage is None and "budgetDeadline" in record)
        or any(
            ("exit" in record, "termination" in record, "evidenceRecorded" in record)
        )
        and phase != "exited"
        or (phase == "exited" and "exit" not in record)
    ):
        raise JournalCorrupt("Invalid local journal phase")
    for key, pattern in (
        ("runRef", r"[A-Za-z0-9._:-]{1,200}"),
        ("executionRef", r"[A-Za-z0-9._:-]{1,128}"),
        ("bootId", r"[a-f0-9-]{36}"),
        ("startTicks", r"[0-9]{1,20}"),
        ("pidNamespace", r"pid:\[[0-9]+\]"),
        ("termination", r"[a-z_]{1,80}"),
    ):
        if key in record and (
            not isinstance(record[key], str) or not re.fullmatch(pattern, record[key])
        ):
            raise JournalCorrupt("Invalid local identity")
    for key in ("pid", "pgid", "sid"):
        if started != (key in record) or (
            started
            and (type(record[key]) is not int or not 0 < record[key] <= 4_194_304)
        ):
            raise JournalCorrupt("Invalid local pid")
    if (
        (started and not record["pid"] == record["pgid"] == record["sid"])
        or (
            not started
            and any(
                key in record for key in ("singleProcess", "startTicks", "pidNamespace")
            )
        )
        or ("singleProcess" in record and record["singleProcess"] is not True)
        or ("threadedPipeline" in record and record["threadedPipeline"] is not True)
        or (
            record.get("singleProcess")
            and (record.get("threadedPipeline") or "startTicks" not in record)
        )
        or (
            "pidNamespace" in record
            and (not record.get("threadedPipeline") or "startTicks" not in record)
        )
        or (
            "evidenceRecorded" in record
            and type(record["evidenceRecorded"]) is not bool
        )
    ):
        raise JournalCorrupt("Invalid local proof")
    if phase == "exited":
        value = record["exit"]
        if not isinstance(value, dict) or value.keys() != {"code", "signal"}:
            raise JournalCorrupt("Invalid local exit")
        code, signal = value["code"], value["signal"]
        if (
            (code is None) == (signal is None)
            or (code is not None and (type(code) is not int or not 0 <= code <= 255))
            or (
                signal is not None
                and (
                    not isinstance(signal, str)
                    or not re.fullmatch(r"(?:SIG[A-Z0-9]+|not_observed)", signal)
                )
            )
        ):
            raise JournalCorrupt("Invalid local exit")
    try:
        for key in ("startDeadline", "executionDeadline", "budgetDeadline"):
            if key in record:
                instant(record[key])
        if instant(record["startDeadline"]) > instant(record["executionDeadline"]):
            raise ValueError("Start deadline follows execution deadline")
    except (ValueError, OverflowError) as error:
        raise JournalCorrupt("Invalid local deadline") from error
    return record
