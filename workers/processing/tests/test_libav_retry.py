"""SA-131: bounded swscale threads and bounded EAGAIN retry with truthful exhaustion."""

import errno
import unittest
import unittest.mock
from unittest.mock import Mock

try:
    import av
    import numpy as np

    from stateaction_processing import artifact_rrd, artifact_types

    HAVE_AV = True
except ImportError:  # pragma: no cover
    HAVE_AV = False

from stateaction_processing import libav_retry


def eagain():
    return BlockingIOError(errno.EAGAIN, "Resource temporarily unavailable")


class Flaky:
    def __init__(self, failures, result="ok", error=eagain):
        self.failures, self.result, self.error, self.calls = failures, result, error, 0

    def __call__(self):
        self.calls += 1
        if self.calls <= self.failures:
            raise self.error()
        return self.result


class RetryTests(unittest.TestCase):
    def test_passes_after_transient_eagain(self):
        sleeps = []
        call = Flaky(libav_retry.MAX_ATTEMPTS - 1)
        out = libav_retry.retry_eagain("x", call, sleep=sleeps.append)
        self.assertEqual(out, "ok")
        self.assertEqual(call.calls, libav_retry.MAX_ATTEMPTS)
        self.assertEqual(len(sleeps), libav_retry.MAX_ATTEMPTS - 1)
        self.assertEqual(sleeps, sorted(sleeps))

    def test_fails_truthfully_after_the_bound(self):
        call = Flaky(10**6)
        with self.assertRaises(libav_retry.LibavTransientError) as ctx:
            libav_retry.retry_eagain("proxy convert", call, sleep=lambda _s: None)
        e = ctx.exception
        self.assertEqual(call.calls, libav_retry.MAX_ATTEMPTS)
        self.assertEqual(e.code, "E_LIBAV_EAGAIN")
        self.assertEqual(e.attempts, libav_retry.MAX_ATTEMPTS)
        self.assertIn("Resource temporarily unavailable", str(e))
        self.assertIn(f"{libav_retry.MAX_ATTEMPTS} attempts", str(e))

    def test_other_errors_are_not_retried(self):
        call = Flaky(3, error=lambda: ValueError("bad"))
        with self.assertRaises(ValueError):
            libav_retry.retry_eagain("x", call, sleep=lambda _s: None)
        self.assertEqual(call.calls, 1)
        other = Flaky(3, error=lambda: OSError(errno.EIO, "io"))
        with self.assertRaises(OSError):
            libav_retry.retry_eagain("x", other, sleep=lambda _s: None)
        self.assertEqual(other.calls, 1)

    def test_conversions_pin_one_swscale_thread(self):
        frame = Mock()
        libav_retry.reformat(frame, "x", width=2, height=2, format="yuv420p")
        frame.reformat.assert_called_once_with(
            threads=1, width=2, height=2, format="yuv420p"
        )
        libav_retry.to_rgb24(frame, "x")
        frame.to_ndarray.assert_called_once_with(format="rgb24", threads=1)


@unittest.skipUnless(HAVE_AV, "decode group not installed")
class EncoderTests(unittest.TestCase):
    rgb = np.full((48, 64, 3), (32, 120, 220), dtype=np.uint8) if HAVE_AV else None

    def encoder(self):
        return artifact_rrd.ProxyEncoder(64, 48, artifact_types.ExportLimits())

    def patched(self, failures):
        real = av.VideoFrame.reformat
        state = {"calls": 0}

        def flaky(frame, *a, **kw):
            state["calls"] += 1
            if state["calls"] <= failures:
                raise av.error.BlockingIOError(
                    errno.EAGAIN, "Resource temporarily unavailable"
                )
            return real(frame, *a, **kw)

        return flaky, state

    def test_encoder_recovers_from_injected_eagain(self):
        flaky, state = self.patched(3)
        enc = self.encoder()
        with unittest.mock.patch.object(av.VideoFrame, "reformat", flaky):
            packets = enc.encode(self.rgb, 0) + enc.flush()
        self.assertEqual(len(packets), 1)
        self.assertEqual(state["calls"], 4)

    def test_encoder_failure_after_the_bound_is_a_failed_result(self):
        flaky, _ = self.patched(10**6)
        enc = self.encoder()
        with unittest.mock.patch.object(av.VideoFrame, "reformat", flaky):
            with unittest.mock.patch.object(libav_retry.time, "sleep", lambda _s: None):
                with self.assertRaises(libav_retry.LibavTransientError) as ctx:
                    enc.encode(self.rgb, 0)
        self.assertEqual(ctx.exception.attempts, libav_retry.MAX_ATTEMPTS)
        self.assertEqual(enc.packets_out, 0)


class FailureLogTests(unittest.TestCase):
    def test_worker_log_carries_libav_message_and_attempt_count(self):
        import contextlib
        import io
        from pathlib import Path

        from stateaction_processing import hand_pose_cpu_v1

        error = libav_retry.LibavTransientError("proxy", 5, "BlockingIOError: EAGAIN")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = hand_pose_cpu_v1._fail(
                Mock(), Mock(), {}, {}, error, Path("/nonexistent")
            )
        self.assertEqual(code, hand_pose_cpu_v1.EXIT_UNREPORTED)
        text = out.getvalue()
        self.assertIn("Worker failed: libav_eagain", text)
        self.assertIn("5 attempts, BlockingIOError: EAGAIN", text)


if __name__ == "__main__":
    unittest.main()
