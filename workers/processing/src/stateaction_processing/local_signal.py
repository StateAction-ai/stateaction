"""Linux-only pidfd signalling for the local processing controller."""

from __future__ import annotations

import json
import os
import select
import signal
import sys
import time
from contextlib import ExitStack
from pathlib import Path
from typing import NotRequired, TypedDict, cast


class Target(TypedDict):
    pid: int
    pgrp: int
    session: int
    startTicks: str


class Request(TypedDict):
    bootId: str
    executionRef: str
    leader: Target
    leaseUntil: int
    pidNamespace: NotRequired[str]


def live(fd: int) -> bool:
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    events = poll.poll(0)
    if not events:
        return True
    if events[0][1] & select.POLLIN:
        return False
    raise OSError("pidfd poll returned an unexpected event")


def pin(stack: ExitStack, target: Target, execution_ref: str | None = None) -> int:
    pid = target["pid"]
    fd = os.pidfd_open(pid)
    stack.callback(os.close, fd)
    verify_identity(target, execution_ref)
    if not live(fd):
        # /proc could already contain a reused PID.
        raise ProcessLookupError(pid)
    return fd


def verify_identity(target: Target, execution_ref: str | None = None) -> None:
    proc = Path("/proc") / str(target["pid"])
    raw = (proc / "stat").read_bytes()
    fields = raw[raw.rindex(b")") + 2 :].split()
    if (
        int(fields[2]) != target["pgrp"]
        or int(fields[3]) != target["session"]
        or fields[19].decode("ascii") != target["startTicks"]
        or (
            execution_ref is not None
            and execution_ref.encode()
            not in (proc / "cmdline").read_bytes().split(b"\0")
        )
    ):
        raise ValueError("Worker identity changed")


def same_kernel(request: Request) -> bool:
    if Path("/proc/sys/kernel/random/boot_id").read_text().strip() != request["bootId"]:
        return False
    namespace = request.get("pidNamespace")
    return namespace is None or (
        os.readlink("/proc/self") == str(os.getpid())
        and os.readlink("/proc/self/ns/pid") == namespace
    )


def status_worker(request: Request) -> int:
    """0: whole thread group exited, 1: live, 2: identity unavailable."""
    leader = request["leader"]
    if not request.get("pidNamespace") or not same_kernel(request):
        return 2
    if leader["pid"] != leader["pgrp"] or leader["pid"] != leader["session"]:
        return 2
    with ExitStack() as stack:
        try:
            # No PIDFD_THREAD: readiness is process-wide. The same-namespace
            # ESRCH is authoritative only when opening the descriptor.
            fd = os.pidfd_open(leader["pid"])
        except ProcessLookupError:
            return 0
        stack.callback(os.close, fd)
        verify_identity(leader)
        return 1 if live(fd) else 0


def signal_worker(request: Request) -> bool:
    def lease_current() -> bool:
        return time.time_ns() // 1_000_000 < request["leaseUntil"]

    leader = request["leader"]
    if (
        not lease_current()
        or leader["pid"] != leader["pgrp"]
        or leader["pid"] != leader["session"]
        or not same_kernel(request)
    ):
        return False
    with ExitStack() as stack:
        fd = pin(stack, leader, request["executionRef"])
        if not lease_current():
            return False
        signal.pidfd_send_signal(fd, signal.SIGKILL)
    return True


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            return 2
        request = cast(Request, json.loads(raw))
        if sys.argv[1:] == ["--status"]:
            return status_worker(request)
        return 0 if signal_worker(request) else 1
    except (AttributeError, OSError, ValueError, TypeError, KeyError, IndexError):
        return 2  # Absent pidfd support or unproven identity means no numeric fallback.


if __name__ == "__main__":
    raise SystemExit(main())
