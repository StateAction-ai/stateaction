import signal
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from stateaction_processing import local_signal


class LocalSignalTests(unittest.TestCase):
    def request(self) -> local_signal.Request:
        return {
            "bootId": "boot",
            "executionRef": "local-test",
            "leader": {"pid": 10, "pgrp": 10, "session": 10, "startTicks": "100"},
            "leaseUntil": time.time_ns() // 1_000_000 + 60_000,
        }

    def test_lease_expiry_during_handle_acquisition_withholds_signal(self):
        request = self.request()
        with (
            patch.object(Path, "read_text", return_value="boot"),
            patch.object(local_signal, "pin", return_value=110),
            patch.object(
                time, "time_ns", side_effect=[0, request["leaseUntil"] * 1_000_000]
            ),
            patch.object(signal, "pidfd_send_signal") as send,
        ):
            self.assertFalse(local_signal.signal_worker(request))
        send.assert_not_called()

    def test_worker_is_signalled_by_corroborated_handle(self):
        request = self.request()
        with (
            patch.object(Path, "read_text", return_value="boot"),
            patch.object(local_signal, "pin", return_value=110) as pin,
            patch.object(signal, "pidfd_send_signal") as send,
        ):
            self.assertTrue(local_signal.signal_worker(request))
        self.assertEqual(
            pin.call_args_list[0].args[1:], (request["leader"], "local-test")
        )
        send.assert_called_once_with(110, signal.SIGKILL)

    def test_exited_handle_does_not_identify_a_recycled_proc_entry(self):
        target = self.request()["leader"]
        fields = b"S 1 10 10 " + b"0 " * 15 + b"100"
        with (
            ExitStack() as stack,
            patch.object(local_signal.os, "pidfd_open", return_value=110),
            patch.object(local_signal.os, "close") as close,
            patch.object(Path, "read_bytes", return_value=b"10 (test) " + fields),
            patch.object(local_signal, "live", return_value=False),
        ):
            with self.assertRaises(ProcessLookupError):
                local_signal.pin(stack, target)
            stack.close()
        close.assert_called_once_with(110)
