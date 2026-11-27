"""Start the existing isolated processing worker and inspect its kernel identity."""

import asyncio
import json
import os
import platform
import select
import signal
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from time import time

PROC = Path("/proc")
RECHECKS = 10
FD_LAUNCHER = (
    "import os,sys; fd=int(sys.argv[1]); os.dup2(fd,3,inheritable=True); "
    "os.close(fd) if fd!=3 else None; os.execvp(sys.argv[2],sys.argv[2:])"
)


def boot_id():
    return (PROC / "sys/kernel/random/boot_id").read_text().strip()


def namespace():
    return os.readlink(PROC / "self/ns/pid")


def supports_threaded():
    try:
        return (
            platform.system() == "Linux"
            and platform.machine() == "x86_64"
            and "/agent-work.slice/" in (PROC / "self/cgroup").read_text()
            and os.readlink(PROC / "self") == str(os.getpid())
        )
    except OSError:
        return False


@dataclass(frozen=True)
class Process:
    state: str
    parent: int
    group: int
    session: int
    ticks: str

    @property
    def alive(self):
        return self.state not in ("Z", "X")


def read_stat(pid):
    try:
        raw = (PROC / str(pid) / "stat").read_text()
    except (FileNotFoundError, ProcessLookupError):
        return None
    fields = raw[raw.rindex(")") + 2 :].split()
    return Process(
        fields[0], int(fields[1]), int(fields[2]), int(fields[3]), fields[19]
    )


def matches(process, record):
    return (process.group, process.session, process.ticks) == (
        record["pgid"],
        record["sid"],
        record["startTicks"],
    )


def command_has(pid, ref):
    try:
        return ref.encode() in (PROC / str(pid) / "cmdline").read_bytes().split(b"\0")
    except OSError:
        return False


async def helper(python, record, *, deadline=None):
    request = {
        "bootId": record["bootId"],
        "executionRef": record["executionRef"],
        "leader": {
            "pid": record["pid"],
            "pgrp": record["pgid"],
            "session": record["sid"],
            "startTicks": record["startTicks"],
        },
    }
    if record.get("pidNamespace"):
        request["pidNamespace"] = record["pidNamespace"]
    if deadline is not None:
        request["leaseUntil"] = int(deadline * 1000)
    timeout = min(1, deadline - time()) if deadline is not None else 1
    if timeout <= 0:
        return 2
    child = await asyncio.create_subprocess_exec(
        python,
        "-m",
        "stateaction_processing.local_signal",
        *(("--status",) if deadline is None else ()),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        env={"PATH": os.environ.get("PATH", ""), "PYTHONNOUSERSITE": "1"},
    )
    try:
        async with asyncio.timeout(timeout):
            await child.communicate(json.dumps(request).encode())
        return child.returncode
    except TimeoutError:
        return 2
    finally:
        if child.returncode is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
            await child.wait()


async def inspect(
    record, python=None, *, read=read_stat, command=command_has, sleep=asyncio.sleep
):
    try:
        if record["bootId"] != boot_id():
            return "boot_changed"
        if not all(key in record for key in ("pid", "pgid", "sid", "startTicks")):
            return "leader_identity_unconfirmed"
        pid = record["pid"]
        leader = read(pid)
        if leader and not matches(leader, record):
            return "leader_identity_changed"
        if leader and leader.alive and command(pid, record["executionRef"]):
            return "alive"
        if record.get("pidNamespace"):
            if not python:
                return "worker_exit_unproven"
            status = await helper(python, record)
            if status == 0:
                return "gone"
            if status == 1 and leader:
                return "alive"
            return "worker_exit_unproven"
        if leader and leader.alive:
            for attempt in range(RECHECKS + 1):
                if attempt:
                    await sleep(0.05)
                leader = read(pid)
                if leader and not matches(leader, record):
                    return "leader_identity_changed"
                if not leader or not leader.alive:
                    break
                if command(pid, record["executionRef"]):
                    return "alive"
            else:
                return "leader_identity_unconfirmed"
        return "gone" if record.get("singleProcess") else "execution_isolation_unproven"
    except (OSError, ValueError, IndexError):
        return "proc_unavailable"


def _proof(fd):
    try:
        ready, _, _ = select.select([fd], [], [], 5)
        return os.read(fd, 2) if ready else b""
    finally:
        os.close(fd)


def _log(fd, flags):
    log = os.open("child.log", flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
    info = os.fstat(log)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        os.close(log)
        raise ValueError("Unsafe local worker log")
    return os.fdopen(log, "rb" if flags == os.O_RDONLY else "ab")


async def spawn(settings, store, record, fixture, *, graph=False):
    stage = record.get("stage")
    ref = record["executionRef"]
    argv = ["-m", "stateaction_processing"]
    if graph:
        argv = ["-m", "stateaction_processing.graph_worker", ref]
    elif stage in (None, "hand_pose"):
        argv += ["run-job", "--execution-ref", ref]
    else:
        argv += ["run-stage", ref]
    env = {
        "PATH": os.environ.get("PATH", ""),
        "APP_ENV": "local",
        "PYTHONNOUSERSITE": "1",
        "PYTHONUNBUFFERED": "1",
        "WORKER_PIPELINE": "hand_pose_cpu_v1"
        if stage == "hand_pose"
        else settings.pipeline,
        (
            "STATEACTION_FIXTURE_ISOLATION_FD"
            if fixture
            else "STATEACTION_THREADED_ISOLATION_FD"
        ): "3",
    }
    if stage and (replay := os.environ.get("STATEACTION_REPLAY_DIR")):
        env["STATEACTION_REPLAY_DIR"] = replay
    read_fd, write_fd = os.pipe()
    child = None
    owns_read = True
    try:
        try:
            with store.directory(record["jobId"], stage) as directory:
                with _log(directory, os.O_WRONLY | os.O_CREAT | os.O_APPEND) as log:
                    # A detached Popen child survives the controller's event-loop shutdown.
                    child = subprocess.Popen(
                        [
                            settings.python,
                            "-c",
                            FD_LAUNCHER,
                            str(write_fd),
                            settings.python,
                            *argv,
                        ],
                        stdin=subprocess.PIPE,
                        stdout=log,
                        stderr=log,
                        env=env,
                        start_new_session=True,
                        pass_fds=(write_fd,),
                        bufsize=0,
                    )
        finally:
            os.close(write_fd)
        owns_read = False
        if await asyncio.to_thread(_proof, read_fd) != (b"1" if fixture else b"2"):
            raise RuntimeError("Local worker isolation was not confirmed")
        pid = child.pid
        leader = read_stat(pid)
        if (
            not leader
            or not leader.alive
            or leader.parent != os.getpid()
            or leader.group != pid
            or leader.session != pid
            or not command_has(pid, ref)
            or read_stat(pid) != leader
        ):
            raise RuntimeError("Local worker identity was not confirmed")
        identity = {
            "pid": pid,
            "pgid": leader.group,
            "sid": leader.session,
            "startTicks": leader.ticks,
            **({"singleProcess": True} if fixture else {"pidNamespace": namespace()}),
        }
        return child, identity
    except BaseException:
        if child:
            child.stdin.close()
        raise
    finally:
        if owns_read:
            os.close(read_fd)


async def send_bootstrap(child, payload):
    fd = child.stdin.fileno()
    os.set_blocking(fd, False)
    remaining = memoryview(payload)
    loop = asyncio.get_running_loop()
    while remaining:
        try:
            remaining = remaining[os.write(fd, remaining) :]
        except BlockingIOError:
            ready = asyncio.Event()
            loop.add_writer(fd, ready.set)
            try:
                async with asyncio.timeout(2):
                    await ready.wait()
            finally:
                loop.remove_writer(fd)


def exit_result(returncode):
    if returncode is None:
        return {"code": None, "signal": "not_observed"}
    if returncode < 0:
        return {"code": None, "signal": signal.Signals(-returncode).name}
    return {"code": returncode, "signal": None}


def last_receipt(store, record):
    try:
        with store.directory(record["jobId"], record.get("stage")) as directory:
            with _log(directory, os.O_RDONLY) as log:
                size = os.fstat(log.fileno()).st_size
                log.seek(max(0, size - 128 * 1024))
                for line in reversed(log.read(128 * 1024).splitlines()):
                    try:
                        value = json.loads(line)
                    except (ValueError, RecursionError):
                        continue
                    if (
                        isinstance(value, dict)
                        and {"schemaVersion", "jobId", "stage", "status"}
                        <= value.keys()
                    ):
                        return value
    except (OSError, ValueError):
        pass
    return None


def last_graph_result(store, record):
    try:
        with store.directory(record["jobId"], record["stage"]) as directory:
            with _log(directory, os.O_RDONLY) as log:
                limit = 1024 * 1024
                size = os.fstat(log.fileno()).st_size
                log.seek(max(0, size - limit))
                for line in reversed(log.read(limit).splitlines()):
                    try:
                        value = json.loads(line)
                    except (ValueError, RecursionError):
                        continue
                    if isinstance(value, dict) and "stateactionNodeResult" in value:
                        return value["stateactionNodeResult"]
    except (OSError, ValueError):
        pass
    return None
