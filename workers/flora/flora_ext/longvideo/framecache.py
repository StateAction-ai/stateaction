"""One forward decode -> on-disk cache of reference-preprocessed slot frames.

Per source frame the cache holds exactly what the reference path feeds the
processor: pyav RGB -> JPEG q98 4:4:4 round trip (`human_transport`) -> bicubic
resize to <= 40,000 px (the resize `temporal_inputs` performs). Frames are
stored raw (uint8 HxWx3) in one file; reads use `os.pread`, so resident memory
stays bounded by the decode window plus the thread-pool queue.
"""

import hashlib
import json
import os
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from PIL import Image

from .. import bootstrap
from ..media import InputError, decode_selected
from ..preprocessing import human_transport

MAX_PIXELS = 40000
CACHE_VERSION = 1


def target_size(width, height):
    """(w, h) after the reference regularize (<=512x512 px area) then the 40,000 px resize."""
    from flora_runtime.exact_frame_serving import regularized_resize_dims

    h, w = regularized_resize_dims(height=height, width=width)
    h, w = regularized_resize_dims(
        height=h, width=w, min_pixels=256, max_pixels=MAX_PIXELS
    )
    return w, h


def reference_preprocess(image):
    """Copy of the reference per-frame chain, for one image (transport + temporal_inputs resize)."""
    from flora_runtime.exact_frame_serving import regularized_resize_dims

    image = human_transport({0: image})[0].convert("RGB")
    height, width = regularized_resize_dims(
        height=image.height, width=image.width, min_pixels=256, max_pixels=MAX_PIXELS
    )
    if image.size != (width, height):
        image = image.resize((width, height), Image.Resampling.BICUBIC)
    return image


def wanted_frames(windows, pts_us):
    """Union of source frame indices the vendor frame plan selects for all windows."""
    plan_fn = bootstrap.production.temporal_frame_plan
    pts = list(pts_us)
    wanted = set()
    for w in windows:
        wanted.update(plan_fn(w, pts)["source_frame_indices"])
    return sorted(wanted)


def _digest(indices):
    return hashlib.sha256(json.dumps(list(indices)).encode()).hexdigest()


class FrameCache:
    def __init__(self, directory):
        self.dir = Path(directory)
        self.meta = json.loads((self.dir / "meta.json").read_text())
        self.row = {int(k): v for k, v in self.meta["rows"].items()}
        self.w, self.h = self.meta["width"], self.meta["height"]
        self.nbytes = self.w * self.h * 3
        self._fd = os.open(self.dir / "frames.u8", os.O_RDONLY)

    def close(self):
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None

    def raw(self, index):
        data = os.pread(self._fd, self.nbytes, self.row[index] * self.nbytes)
        if len(data) != self.nbytes:
            raise InputError("Frame cache is truncated.")
        return data

    def get(self, index):
        return Image.frombytes("RGB", (self.w, self.h), self.raw(index))

    def pixel_digest(self, indices):
        h = hashlib.sha256()
        for i in indices:
            h.update(self.raw(i))
        return h.hexdigest()

    @staticmethod
    def exists_for(directory, sha256, wanted):
        meta = Path(directory) / "meta.json"
        if not meta.is_file():
            return False
        m = json.loads(meta.read_text())
        return (
            m.get("complete")
            and m["version"] == CACHE_VERSION
            and m["source_sha256"] == sha256
            and m["wanted_sha256"] == _digest(wanted)
        )


def build_cache(video, wanted, directory, *, workers=2, inflight=16):
    """Decode `video` once, forward only, and write the cache. Returns stats dict."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    wanted = sorted(set(wanted))
    if not wanted:
        raise InputError("No frames requested.")
    if wanted[0] < 0 or wanted[-1] >= len(video.pts_us):
        raise InputError("A requested source frame is outside the video.")
    if FrameCache.exists_for(directory, video.sha256, wanted):
        return {"reused": True, "frames": len(wanted)}
    w, h = target_size(*video.size)
    nbytes = w * h * 3
    wanted_set = set(wanted)
    row_of = {i: r for r, i in enumerate(wanted)}
    started = time.monotonic()
    decode_s = 0.0
    done = 0
    fd = os.open(directory / "frames.u8", os.O_WRONLY | os.O_CREAT | os.O_TRUNC)

    def prep(image):
        out = reference_preprocess(image)
        if out.size != (w, h):
            raise InputError("Unexpected frame size while building cache.")
        return out.tobytes()

    pending = deque()

    def drain(limit):
        nonlocal done
        while len(pending) > limit:
            idx, fut = pending.popleft()
            os.pwrite(fd, fut.result(), row_of[idx] * nbytes)
            done += 1

    try:
        with (
            ThreadPoolExecutor(max_workers=workers) as pool,
            av.open(str(video.path), options={"err_detect": "explode"}) as container,
        ):
            stream = container.streams.video[0]
            stream.codec_context.thread_count = 2
            zero = None
            last = wanted[-1]
            t0 = time.monotonic()
            for i, frame in enumerate(container.decode(stream)):
                zero = frame.pts if zero is None else zero
                if i in wanted_set:
                    if (
                        Fraction(frame.pts - zero) * stream.time_base * 1000000
                        != video.pts_us[i]
                    ):
                        raise InputError(
                            "Source frame timestamps changed while decoding."
                        )
                    image = frame.to_image().convert("RGB")
                    decode_s += time.monotonic() - t0
                    pending.append((i, pool.submit(prep, image)))
                    drain(inflight)
                    t0 = time.monotonic()
                if i >= last:
                    break
            drain(0)
    finally:
        os.close(fd)
    if done != len(wanted):
        raise InputError("A requested source frame could not be decoded.")
    meta = dict(
        version=CACHE_VERSION,
        source_sha256=video.sha256,
        wanted_sha256=_digest(wanted),
        width=w,
        height=h,
        rows={str(i): r for i, r in row_of.items()},
        complete=True,
    )
    (directory / "meta.json").write_text(json.dumps(meta))
    return {
        "reused": False,
        "frames": len(wanted),
        "bytes": len(wanted) * nbytes,
        "elapsed_s": round(time.monotonic() - started, 3),
        "size": [w, h],
    }


def compare_with_reference(video, cache, indices):
    """Byte-compare cache frames with the reference path (decode_selected from frame 0 + transport + resize)."""
    indices = sorted(set(indices))
    reference = decode_selected(video, indices)
    mismatched, max_diff = [], 0
    for i in indices:
        ref = np.asarray(reference_preprocess(reference[i]))
        got = np.frombuffer(cache.raw(i), dtype=np.uint8).reshape(ref.shape)
        if not np.array_equal(ref, got):
            mismatched.append(i)
            max_diff = max(
                max_diff, int(np.abs(ref.astype(int) - got.astype(int)).max())
            )
    return {
        "compared": len(indices),
        "mismatched": len(mismatched),
        "mismatched_frames": mismatched[:20],
        "max_abs_diff": max_diff,
        "byte_equal": not mismatched,
    }
