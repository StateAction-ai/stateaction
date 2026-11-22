"""Demux-only probe: timestamp table without decoding a single frame.

Produces the same `media.Video` the reference `probe` builds, with the same
checks but configurable limits. Hashing runs in a second thread.
"""

import hashlib
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

import av

from ..media import InputError, Video
from .limits import Limits


def _sha256(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def _table(path, limits):
    with av.open(str(path), options={"err_detect": "explode"}) as container:
        if len(container.streams.video) != 1:
            raise InputError("Use a file containing one video stream.")
        stream = container.streams.video[0]
        rate = stream.average_rate
        if not rate or rate < limits.min_fps:
            raise InputError(
                f"The input needs at least {limits.min_fps} source frames per second."
            )
        size = (stream.codec_context.width, stream.codec_context.height)
        if min(size) <= 0 or max(size) > limits.max_dimension:
            raise InputError(
                f"Video dimensions must be at most {limits.max_dimension} pixels per side."
            )
        pts, durations = [], {}
        for packet in container.demux(stream):
            if packet.pts is None:
                if packet.size == 0:  # flush packet
                    continue
                raise InputError("Every source frame needs a presentation timestamp.")
            pts.append(packet.pts)
            durations[packet.pts] = packet.duration
            if len(pts) > limits.max_frame_count:
                raise InputError(f"Video exceeds {limits.max_frame_count} frames.")
        time_base = stream.time_base
    pts.sort()
    if len(pts) < 2:
        raise InputError("The video contains too few source frames.")
    zero = pts[0]
    times = []
    for p in pts:
        t = Fraction(p - zero) * time_base * 1000000
        if times and t <= times[-1]:
            raise InputError("Source timestamps must be strictly increasing.")
        times.append(t)
    last = durations.get(pts[-1])
    tail = Fraction(last) * time_base * 1000000 if last else Fraction(1000000) / rate
    duration = round(times[-1] + tail)
    if duration > limits.max_duration_s * 1000000:
        raise InputError(f"Video exceeds {limits.max_duration_s:g} seconds.")
    cfr = all(abs(t - Fraction(i * 1000000, rate)) <= 1 for i, t in enumerate(times))
    return rate, tuple(times), duration, size, cfr


def fast_probe(path, limits=None):
    limits = limits or Limits()
    path = Path(path).expanduser().resolve(strict=True)
    size_bytes = path.stat().st_size
    if not 0 < size_bytes <= limits.max_upload_bytes:
        raise InputError(
            f"Input must be a nonempty file of at most {limits.max_upload_bytes} bytes."
        )
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="probe") as pool:
        digest = pool.submit(_sha256, path)
        table = pool.submit(_table, path, limits)
        rate, times, duration, size, cfr = table.result()
        return Video(path, digest.result(), rate, times, duration, size, cfr)
