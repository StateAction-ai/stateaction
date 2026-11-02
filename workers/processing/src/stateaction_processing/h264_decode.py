"""One persistent, bounded H.264 decoder: each frame is decoded exactly once (SA-29).

Optional `decode` dependency group (PyAV 19.0.2 with bundled FFmpeg, numpy). Software decode,
`thread_count=1`, `err_detect=explode`: any decoder error fails the job, never a skipped frame.
Decode order must equal presentation order (the capture reader already rejects B-frames and
non-increasing PTS), so at most `max_pending` access units are in the decoder; the PTS handed to the
decoder is the original encoder PTS (1/1_000_000 time base) and maps each output back to its
access unit exactly. A frame that cannot be mapped, a raster change that violates the bounds, or an
access unit left undecoded at end of stream is an error.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from fractions import Fraction  # noqa: E402
from typing import Any

from .capture_stream import AccessUnit

_TIME_BASE = Fraction(1, 1_000_000)


class DecodeError(ValueError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _req(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise DecodeError(code, detail)


@dataclass(frozen=True)
class FrameTransform:
    """Raster facts for one decoded frame.

    Contract v1 records no crop, rotation or mirror for the encoded raster, so those are explicitly
    unknown here (None). Consumers must not assume identity; any use that depends on display
    orientation needs a producer contract that proves it.
    """

    raster: tuple[int, int]  # (width, height) of `rgb`
    crop: None = None
    rotation_deg: None = None
    mirror: None = None
    basis: str = "decoder_output_raster; crop_rotation_mirror_unknown_in_contract_v1"


@dataclass(frozen=True)
class DecodedFrame:
    """RGB frame plus the unmodified identity of the access unit it came from."""

    rgb: Any  # numpy uint8 array [H, W, 3] (RGB24); one allocation per frame, owned by the caller
    access_unit: (
        AccessUnit  # original ids, PTS, native clocks/timestamps, sensor evidence, hash
    )
    transform: FrameTransform


@dataclass
class DecodeStats:
    packets_sent: int = 0
    frames_out: int = 0
    peak_pending: int = 0
    decoder_instances: int = 0
    rasters: tuple[tuple[int, int], ...] = ()


class H264Decoder:
    def __init__(
        self,
        *,
        max_pending: int = 4,
        max_pixels: int = 3840 * 2160,
        max_side: int = 16384,
        expected_raster: tuple[int, int] | None = None,
    ):
        try:
            import av
        except ImportError as e:  # pragma: no cover - optional dependency
            raise DecodeError(
                "E_DECODER_UNAVAILABLE", "install the 'decode' group"
            ) from e
        self._av = av
        self.max_pending, self.max_pixels, self.max_side = (
            max_pending,
            max_pixels,
            max_side,
        )
        self.expected_raster = expected_raster
        self.stats = DecodeStats(decoder_instances=1)
        ctx = av.CodecContext.create("h264", "r")
        ctx.thread_count = 1
        ctx.options = {"err_detect": "explode"}
        ctx.open()
        self._ctx = ctx
        self._pending: dict[int, AccessUnit] = {}
        self._rasters: list[tuple[int, int]] = []

    def decode(self, units: Iterable[AccessUnit]) -> Iterator[DecodedFrame]:
        av = self._av
        try:
            for au in units:
                _req(
                    len(self._pending) < self.max_pending,
                    "E_DECODER_BACKLOG",
                    self.max_pending,
                )
                _req(
                    au.encoder_pts_us not in self._pending,
                    "E_DECODER_PTS_DUPLICATE",
                    au.encoder_pts_us,
                )
                self._pending[au.encoder_pts_us] = au
                self.stats.peak_pending = max(
                    self.stats.peak_pending, len(self._pending)
                )
                pkt = av.Packet(au.data)
                pkt.pts = pkt.dts = au.encoder_pts_us
                pkt.time_base = _TIME_BASE
                self.stats.packets_sent += 1
                yield from self._emit(self._ctx.decode(pkt))
            yield from self._emit(self._ctx.decode(None))
        except av.error.FFmpegError as e:
            raise DecodeError("E_DECODE_FAILED", f"{type(e).__name__}: {e}") from None
        _req(not self._pending, "E_DECODER_UNDECODED", sorted(self._pending))

    def _emit(self, frames: Iterable[Any]) -> Iterator[DecodedFrame]:
        for fr in frames:
            _req(fr.pts is not None, "E_DECODER_PTS_MISSING")
            au = self._pending.pop(int(fr.pts), None)
            _req(au is not None, "E_DECODER_PTS_UNMAPPED", fr.pts)
            assert au is not None
            w, h = int(fr.width), int(fr.height)
            _req(
                0 < w <= self.max_side
                and 0 < h <= self.max_side
                and w * h <= self.max_pixels,
                "E_RASTER_BOUND",
                {"raster": [w, h], "max_pixels": self.max_pixels},
            )
            _req(
                self.expected_raster in (None, (w, h)),
                "E_RASTER_MISMATCH",
                {"decoded": [w, h], "declared": self.expected_raster},
            )
            if (w, h) not in self._rasters:
                self._rasters.append((w, h))
                self.stats.rasters = tuple(self._rasters)
            rgb = fr.to_ndarray(format="rgb24")
            self.stats.frames_out += 1
            yield DecodedFrame(rgb, au, FrameTransform((w, h)))
