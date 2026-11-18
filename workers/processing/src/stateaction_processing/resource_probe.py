"""Bounded worker resource facts (SA-45). Stdlib only; starts AFTER the claim is won.

One allowlisted JSON line per physical invocation, written to stderr (the local
0600 child log, or the container log on Modal). Every value that was not
measured is ``null`` (unknown), never 0. No raw exception text, path, URL,
token or source payload can enter the line: the line is built field by field
from typed values, and anything else is dropped.

Honest scopes:
* ``ru_maxrss`` of THIS process and of waited-for CHILDREN are two separate
  process high-water facts. They are never summed into an aggregate peak, and
  no container/cgroup peak is claimed.
* Scratch is a SAMPLED high-water lower bound from a bounded, symlink-free walk
  of the directories the pipeline explicitly registers with ``register_scratch``
  (its own invocation-owned scratch). The probe never scans the temp directory or
  any unrelated path, and never claims an exact peak.
"""

from __future__ import annotations

import json
import os
import re
import resource
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
MAX_LINE_BYTES = 2048
MAX_SCRATCH_DIRS = 4
JOIN_SECONDS = 2.0
MAX_WALK_ENTRIES = 20_000
MAX_WALK_DEPTH = 8
MAX_WALK_SECONDS = 0.25
SAMPLE_INTERVAL_SECONDS = 1.0
_INT_MAX = 2**53 - 1
_UUID_PART = r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
# Backend-specific KNOWN forms (a character class is not a secret boundary).
_REFS = {
    "local": re.compile(rf"^(local|fixture)-{_UUID_PART}$"),
    "modal": re.compile(r"^fc-[A-Za-z0-9]{1,77}$"),
}
_BACKENDS = ("local", "modal")
_BASES = ("declared", "uploaded", "verified")
_BYTE_ROLES = ("source", "output", "rrd", "failedOutput")


def _num(value: object, *, upper: int = _INT_MAX) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= upper else None


def _seconds(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not (0.0 <= float(value) < 10**9):
        return None
    return round(float(value), 3)


def walk_bytes(root: Path) -> tuple[int, bool]:
    """Sum regular-file sizes under ``root``. Never follows symlinks.

    Returns ``(bytes, complete)``; ``complete`` is False when an entry, depth or
    wall bound stopped the walk or an entry could not be read (a lower bound).
    """
    deadline = time.monotonic() + MAX_WALK_SECONDS
    total, seen, complete = 0, 0, True
    stack: list[tuple[str, int]] = [(str(root), 0)]
    while stack:
        path, depth = stack.pop()
        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    seen += 1
                    if seen > MAX_WALK_ENTRIES or time.monotonic() > deadline:
                        return total, False
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if depth + 1 > MAX_WALK_DEPTH:
                                complete = False
                            else:
                                stack.append((entry.path, depth + 1))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        complete = False
        except OSError:
            complete = False
    return total, complete


def _process_age_seconds() -> float | None:
    """Seconds since THIS process started (Linux /proc); None when unreadable."""
    try:
        stat = Path("/proc/self/stat").read_text()
        ticks = int(stat.rsplit(")", 1)[1].split()[19])
        uptime = float(Path("/proc/uptime").read_text().split()[0])
        return max(0.0, uptime - ticks / os.sysconf("SC_CLK_TCK"))
    except (OSError, ValueError, IndexError):
        return None


def _is_uuid(value: object) -> bool:
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _ru_bytes(value: int) -> int:
    """``ru_maxrss`` is KiB on Linux and bytes on macOS."""
    return value if sys.platform == "darwin" else value * 1024


class ResourceProbe:
    """Start after the claim; call ``emit`` exactly once from a ``finally``."""

    def __init__(self, *, job_id: str, backend: str, execution_ref: str) -> None:
        self.job_id, self.backend, self.execution_ref = job_id, backend, execution_ref
        self._born = time.monotonic()
        self.startup_seconds = _seconds(_process_age_seconds())
        self.import_seconds: float | None = None
        self._lock = threading.Lock()
        self._paths: list[str] = []
        self._high = 0
        self._complete = True
        self._sampled = False
        self._bytes: dict[str, dict[str, int]] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._finished = False

    # -- scratch: ONLY directories the pipeline registers for this invocation ------
    def register_scratch(self, path: Path | str) -> bool:
        """Register the invocation-owned scratch directory (call right after creating it).

        Accepts only an existing, non-symlink directory; at most ``MAX_SCRATCH_DIRS``.
        Starts the sampler. Returns False (and registers nothing) otherwise.
        """
        try:
            text = os.fspath(path)
            if not os.path.isabs(text) or os.path.islink(text):
                return False
            if not os.path.isdir(text):
                return False
            with self._lock:
                if self._finished or len(self._paths) >= MAX_SCRATCH_DIRS:
                    return False
                if self._thread is None:
                    thread = threading.Thread(
                        target=self._sample_loop, name="sa-probe", daemon=True
                    )
                    thread.start()
                    self._thread = thread
                if text not in self._paths:
                    self._paths.append(text)
            self.sample_now()
            return True
        except Exception:
            return False

    def sample_now(self) -> None:
        """One bounded sample of the registered directories (safe from any thread)."""
        try:
            with self._lock:
                if self._finished:
                    return
                paths = list(self._paths)
            if not paths:
                return
            total, complete, any_present = 0, True, False
            for path in paths:
                if os.path.islink(path) or not os.path.isdir(path):
                    continue  # already cleaned up: keep the earlier high-water
                any_present = True
                size, ok = walk_bytes(Path(path))
                total, complete = total + size, complete and ok
            if not any_present:
                return
            with self._lock:
                self._sampled = True
                self._high = max(self._high, total)
                self._complete = self._complete and complete
        except Exception:  # sampling must never affect processing
            with self._lock:
                self._complete = False

    def _sample_loop(self) -> None:
        while not self._stop.wait(SAMPLE_INTERVAL_SECONDS):
            self.sample_now()

    # -- optional facts a pipeline may report (distinct bases, never merged) --------
    def note_bytes(self, role: str, basis: str, value: object) -> None:
        count = _num(value)
        if role in _BYTE_ROLES and basis in _BASES and count is not None:
            with self._lock:
                self._bytes.setdefault(role, {})[basis] = count

    def _finish(self) -> None:
        """Stop and join the sampler (bounded); idempotent."""
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(JOIN_SECONDS)
        self.sample_now()
        with self._lock:
            self._finished = True

    # -- the line -------------------------------------------------------------------
    def record(self, exit_code: int | None, outcome: str) -> dict[str, Any]:
        self._finish()
        children = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        own = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        ref_ok = self.backend in _REFS and bool(
            _REFS[self.backend].fullmatch(self.execution_ref)
        )
        with self._lock:
            sampled, high, complete = self._sampled, self._high, self._complete
            noted = {r: dict(b) for r, b in self._bytes.items()}
        return {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "sa_metrics",
            "jobId": self.job_id if _is_uuid(self.job_id) else None,
            "backend": self.backend if self.backend in _BACKENDS else None,
            "executionRef": self.execution_ref if ref_ok else None,
            "stage": "worker",
            "outcome": outcome if outcome in ("returned", "raised") else None,
            "exitCode": exit_code if _num(exit_code, upper=255) is not None else None,
            "startupSeconds": self.startup_seconds,
            "importSeconds": _seconds(self.import_seconds),
            "wallSeconds": _seconds(time.monotonic() - self._born),
            # Two separate process high-water facts; never summed; no cgroup peak.
            "peakRssSelfBytes": _num(_ru_bytes(own)),
            "peakRssChildrenBytes": _num(_ru_bytes(children)) if children else None,
            "rssScope": "process_high_water_not_aggregate",
            "scratchHighWaterBytes": high if sampled else None,
            "scratchStatus": (
                "unknown"
                if not sampled
                else "sampled_lower_bound"
                if complete
                else "sampled_incomplete"
            ),
            "bytes": noted,
        }

    def emit(self, exit_code: int | None, outcome: str, stream: Any = None) -> None:
        """Write one bounded line. Any failure is swallowed: metrics never decide a result."""
        try:
            line = json.dumps(
                self.record(exit_code, outcome), separators=(",", ":"), sort_keys=True
            )
            if len(line.encode()) > MAX_LINE_BYTES:
                return
            out = stream or sys.stderr
            out.write(f"sa_metrics {line}\n")
            out.flush()
        except Exception:
            return
