import json
import os
import platform
import selectors
import subprocess
import sys
import time
import unittest
from pathlib import Path

from stateaction_processing.local_signal import Request, status_worker


@unittest.skipUnless(
    sys.platform == "linux" and platform.machine() == "x86_64",
    "worker confinement requires Linux x86-64",
)
class ThreadedIsolationTests(unittest.TestCase):
    def test_process_wide_status_survives_leader_exit(self):
        with subprocess.Popen(
            [
                sys.executable,
                "-c",
                """
import ctypes
import os
import threading

from stateaction_processing.run_job import enforce_single_process

enforce_single_process(allow_threads=True)

for start in (os.fork, lambda: os.posix_spawn('/bin/true', ['true'], {})):
    try:
        pid = start()
    except PermissionError:
        continue
    if pid == 0:
        os._exit(0)
    os.waitpid(pid, 0)
    raise SystemExit(99)

def survive_leader():
    print("ready", flush=True)
    os.read(0, 1)
    os._exit(0)

threading.Thread(target=survive_leader).start()
ctypes.CDLL(None).syscall(60, 0)  # x86-64 SYS_exit: this task only.
raise AssertionError("leader exit returned")
""",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            start_new_session=True,
        ) as child:
            try:
                with selectors.DefaultSelector() as ready:
                    ready.register(child.stdout, selectors.EVENT_READ)
                    self.assertTrue(ready.select(5), "worker did not acknowledge")
                self.assertEqual(child.stdout.readline(), b"ready\n")
                proc = Path(f"/proc/{child.pid}/stat")
                deadline = time.monotonic() + 5
                while True:
                    fields = proc.read_text().rsplit(")", 1)[1].split()
                    if fields[0] == "Z":
                        break
                    self.assertLess(time.monotonic(), deadline, "leader did not exit")
                    time.sleep(0.01)
                request: Request = {
                    "bootId": Path("/proc/sys/kernel/random/boot_id")
                    .read_text()
                    .strip(),
                    "pidNamespace": os.readlink("/proc/self/ns/pid"),
                    "executionRef": "isolated-test",
                    "leader": {
                        "pid": child.pid,
                        "pgrp": child.pid,
                        "session": child.pid,
                        "startTicks": fields[19],
                    },
                    "leaseUntil": 0,
                }
                # A new observer has only the recovered identity and no inherited pidfd.
                observer = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "stateaction_processing.local_signal",
                        "--status",
                    ],
                    input=json.dumps(request),
                    text=True,
                    capture_output=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(observer.returncode, 1, observer.stderr)
                self.assertEqual(
                    status_worker({**request, "pidNamespace": "pid:[0]"}), 2
                )
                child.stdin.write(b"x")
                child.stdin.flush()
                self.assertEqual(child.wait(timeout=5), 0)
                self.assertEqual(status_worker(request), 0)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
