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
from typing import TypedDict, cast


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


def live(fd: int) -> bool:
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return not poll.poll(0)


def pin(stack: ExitStack, target: Target, execution_ref: str | None = None) -> int:
    pid = target["pid"]
    fd = os.pidfd_open(pid)
    stack.callback(os.close, fd)
    proc = Path("/proc") / str(pid)
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
        or not live(fd)
    ):
        # Check liveness after /proc so those facts belong to this handle.
        raise ProcessLookupError(pid)
    return fd


def signal_worker(request: Request) -> bool:
    def lease_current() -> bool:
        return time.time_ns() // 1_000_000 < request["leaseUntil"]

    leader = request["leader"]
    if (
        not lease_current()
        or leader["pid"] != leader["pgrp"]
        or leader["pid"] != leader["session"]
        or Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        != request["bootId"]
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
            return 1
        return 0 if signal_worker(cast(Request, json.loads(raw))) else 1
    except (AttributeError, OSError, ValueError, TypeError, KeyError, IndexError):
        return 1  # Absent pidfd support or unproven identity means no numeric fallback.


if __name__ == "__main__":
    raise SystemExit(main())
