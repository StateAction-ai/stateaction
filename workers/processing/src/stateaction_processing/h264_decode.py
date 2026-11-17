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

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from fractions import Fraction  # noqa: E402
from typing import TYPE_CHECKING, Any

from .capture_stream import AccessUnit

if TYPE_CHECKING:
    from .jpeg_stream import JpegImage

_TIME_BASE = Fraction(1, 1_000_000)
_ANNEX_B_START = re.compile(rb"\x00\x00\x01")
_EMULATION_PREVENTION = re.compile(rb"(?<=\x00\x00)\x03")
_MAX_SPS_PREFIX = 16 * 1024
# Profiles with chroma, bit-depth and scaling-list fields before the raster.
_EXTENDED_SPS_PROFILES = {44, 83, 86, 100, 110, 118, 122, 128, 138, 144, 244}


class DecodeError(ValueError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _req(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise DecodeError(code, detail)


class _SpsBits:
    def __init__(self, data: bytes):
        self.data = _EMULATION_PREVENTION.sub(b"", data)
        self.pos = 0

    def read(self, n: int) -> int:
        _req(self.pos + n <= len(self.data) * 8, "E_SPS_TRUNCATED")
        value = 0
        for pos in range(self.pos, self.pos + n):
            value = (value << 1) | ((self.data[pos // 8] >> (7 - pos % 8)) & 1)
        self.pos += n
        return value

    def ue(self) -> int:
        zeros = 0
        while not self.read(1):
            zeros += 1
            _req(zeros <= 31, "E_SPS_GOLOMB")
        return (1 << zeros) - 1 + self.read(zeros)

    def se(self) -> int:
        value = self.ue()
        return (value + 1) // 2 if value % 2 else -(value // 2)


def _coded_raster(sps: bytes) -> tuple[int, int]:
    """Read the SPS through its coded dimensions, before display cropping."""
    # Uses the SPS field order from the Android capture verifier. The decoder
    # needs the full macroblock surface, including pixels cropped from output.
    bits = _SpsBits(sps)
    profile = bits.read(8)
    bits.read(16)  # constraint flags and level
    bits.ue()  # sequence parameter set ID
    if profile in _EXTENDED_SPS_PROFILES:
        chroma = bits.ue()
        _req(chroma <= 3, "E_SPS_CHROMA")
        if chroma == 3:
            bits.read(1)  # separate_colour_plane_flag
        bits.ue()  # bit depth, luma
        bits.ue()  # bit depth, chroma
        bits.read(1)  # transform bypass
        if bits.read(1):  # seq_scaling_matrix_present_flag
            for index in range(12 if chroma == 3 else 8):
                if bits.read(1):
                    scale = 8
                    for _ in range(16 if index < 6 else 64):
                        if not scale:
                            break
                        scale = (scale + bits.se()) % 256
    bits.ue()  # log2_max_frame_num_minus4
    order_type = bits.ue()
    _req(order_type <= 2, "E_SPS_PICTURE_ORDER")
    if order_type == 0:
        bits.ue()  # log2_max_pic_order_cnt_lsb_minus4
    elif order_type == 1:
        bits.read(1)  # delta_pic_order_always_zero_flag
        bits.se()
        bits.se()
        cycle = bits.ue()
        _req(cycle < 256, "E_SPS_PICTURE_ORDER")
        for _ in range(cycle):
            bits.se()
    bits.ue()  # max_num_ref_frames
    bits.read(1)  # gaps_in_frame_num_value_allowed_flag
    width = 16 * (bits.ue() + 1)
    height = 16 * (bits.ue() + 1)
    return width, height * (2 - bits.read(1))  # frame_mbs_only_flag


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
    access_unit: AccessUnit | JpegImage  # original source evidence; JPEG PTS is derived
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

    def _check_raster(self, w: int, h: int) -> None:
        _req(
            0 < w <= self.max_side
            and 0 < h <= self.max_side
            and w * h <= self.max_pixels,
            "E_RASTER_BOUND",
            {"raster": [w, h], "max_pixels": self.max_pixels},
        )

    def _check_parameter_sets(self, data: bytes) -> None:
        # Check new SPS NALs anywhere in the stream, including midstream changes.
        for match in _ANNEX_B_START.finditer(data):
            header = match.end()
            if header == len(data) or data[header] & 31 != 7:
                continue
            start = header + 1
            end = min(len(data), start + _MAX_SPS_PREFIX)
            next_nal = _ANNEX_B_START.search(data, start, end)
            if next_nal is not None:
                end = next_nal.start()
            self._check_raster(*_coded_raster(data[start:end]))

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
                self._check_parameter_sets(au.data)
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
            self._check_raster(w, h)
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
