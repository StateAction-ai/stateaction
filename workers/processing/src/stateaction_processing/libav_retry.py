"""Bounded libav/swscale thread count and a bounded retry for transient EAGAIN (SA-131).

swscale (`VideoFrame.reformat` / `to_ndarray`) starts its own worker threads unless told
otherwise. Under host or cgroup pressure `pthread_create` fails and PyAV raises
`av.error.BlockingIOError` ([Errno 11] EAGAIN). The codec contexts already pin `thread_count=1`;
every swscale conversion here pins `threads=1` too and retries a bounded number of times with
backoff. A persistent failure raises `LibavTransientError` (code `E_LIBAV_EAGAIN`) carrying the
libav message and the attempt count. It is never turned into an empty or skipped result.

Only pure conversions of an intact frame are retried. Codec send/receive calls are stateful
and are never replayed.
"""

from __future__ import annotations

import errno
import time
from collections.abc import Callable
from typing import Any, TypeVar

T = TypeVar("T")

SWS_THREADS = 1
MAX_ATTEMPTS = 5
BACKOFF_SECONDS = (0.05, 0.1, 0.2, 0.4)


class LibavTransientError(RuntimeError):
    """EAGAIN persisted after the bounded retries. Recorded as a failed result."""

    code = "E_LIBAV_EAGAIN"

    def __init__(self, what: str, attempts: int, message: str):
        super().__init__(
            f"{self.code}: {what} failed after {attempts} attempts: {message}"
        )
        self.what, self.attempts, self.message = what, attempts, message
        self.detail = {"what": what, "attempts": attempts, "message": message}


def is_eagain(error: BaseException) -> bool:
    return isinstance(error, OSError) and error.errno == errno.EAGAIN


def retry_eagain(
    what: str,
    call: Callable[[], T],
    *,
    max_attempts: int = MAX_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    last = ""
    for attempt in range(1, max_attempts + 1):
        try:
            return call()
        except Exception as error:
            if not is_eagain(error):
                raise
            last = f"{type(error).__name__}: {error}"
            if attempt < max_attempts:
                sleep(BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS)) - 1])
    raise LibavTransientError(what, max_attempts, last)


def reformat(frame: Any, what: str, **kwargs: Any) -> Any:
    """`frame.reformat` with one swscale thread and bounded EAGAIN retry."""
    return retry_eagain(what, lambda: frame.reformat(threads=SWS_THREADS, **kwargs))


def to_rgb24(frame: Any, what: str) -> Any:
    """`frame.to_ndarray(format="rgb24")` with one swscale thread and bounded retry."""
    return retry_eagain(
        what, lambda: frame.to_ndarray(format="rgb24", threads=SWS_THREADS)
    )
