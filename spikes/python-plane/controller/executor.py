"""Injected executor contract and local subprocess fixture."""

import json
import os
import select
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import uuid4


@dataclass(frozen=True)
class Terminal:
    state: str
    error_code: str | None = None
    receipt: dict | None = None


class Call(Protocol):
    ref: str

    def poll(self) -> Terminal | None: ...
    def close(self) -> None: ...


class Executor(Protocol):
    backend: str

    def reserve_ref(self) -> str | None: ...
    def spawn(self, bootstrap: dict, ref: str | None) -> Call: ...


class StubCall:
    def __init__(self, ref: str, bootstrap: dict):
        self.ref = ref
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name("stub_worker.py"))],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={"PATH": os.defpath},
        )
        self.fd = os.pidfd_open(self.process.pid)
        try:
            assert self.process.stdin is not None
            self.process.stdin.write(json.dumps(bootstrap).encode())
            self.process.stdin.close()
        except BaseException:
            self.close()
            raise

    def poll(self) -> Terminal | None:
        if not select.select([self.fd], [], [], 0)[0]:
            return None
        exit_code = self.process.wait()
        if exit_code != 7:
            raise RuntimeError("Stub worker claim or execution failed")
        return Terminal("failed", "stub_fixture_failure")

    def close(self) -> None:
        try:
            if not select.select([self.fd], [], [], 0)[0]:
                try:
                    signal.pidfd_send_signal(self.fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.process.wait(timeout=5)
        finally:
            os.close(self.fd)


class StubExecutor:
    backend = "local"

    def reserve_ref(self) -> str:
        return f"local-{uuid4()}"

    def spawn(self, bootstrap: dict, ref: str | None) -> StubCall:
        if not ref:
            raise ValueError("Local call requires a reserved identity")
        return StubCall(ref, {**bootstrap, "executionRef": ref})
