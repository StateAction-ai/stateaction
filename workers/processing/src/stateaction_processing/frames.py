"""`iter_frames`: forward-only source -> verified-so-far decoded RGB frames (SA-29 seam for SA-30/31).

    stream = FrameStream(open(path, "rb"))
    for frame in stream:            # DecodedFrame: rgb ndarray + original AccessUnit identity
        process(frame)              # provisional: temporary, bounded artifacts only
    stream.require_accepted()       # raises unless footer/CRC/SHA/Close checks all passed
    stream.report                   # CaptureReport (source hash/bytes/reads, counts, peaks)

Each access unit is decoded once by one persistent decoder. The consumer receives the single RGB
array per frame and may feed inference and encoders from it. Success, publication and acceptance
wait for `require_accepted()`; iteration raising means the job failed.

`source_profile="stera_jpeg_mcap_v1"` selects the original Stera JPEG adapter explicitly.
It preserves original ROS/MCAP evidence and verifies the MCAP container through EOF.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import BinaryIO

from .capture_stream import (
    CaptureReport,
    CaptureStream,
    CaptureStreamError,
    StreamLimits,
)
from .h264_decode import DecodedFrame, DecodeError, DecodeStats, H264Decoder
from .jpeg_decode import JpegDecoder
from .jpeg_stream import JPEG_PROFILE, JpegCaptureStream


class FrameStream:
    def __init__(
        self,
        raw: BinaryIO,
        limits: StreamLimits | None = None,
        *,
        max_decoder_pending: int = 4,
        source_profile: str | None = None,
    ):
        self.limits = limits or StreamLimits()
        if source_profile == JPEG_PROFILE:
            self.capture: CaptureStream | JpegCaptureStream = JpegCaptureStream(
                raw, self.limits
            )
        elif source_profile in (None, "h264_mcap_v1", "h264_mcap_simulation_v1"):
            self.capture = CaptureStream(
                raw, self.limits, expected_profile=source_profile
            )
        else:
            raise CaptureStreamError("E_SOURCE_PROFILE", source_profile)
        self._max_pending = max_decoder_pending
        self.decode_stats: DecodeStats | None = None
        self._decoded_ok = False

    @property
    def report(self) -> CaptureReport:
        return self.capture.report

    @property
    def accepted(self) -> bool:
        """True only after capture verification AND the decoder flushed with matching counts."""
        st, rep = self.decode_stats, self.capture.report
        return (
            self._decoded_ok
            and self.capture.accepted
            and st is not None
            and st.packets_sent == st.frames_out == rep.video_messages
        )

    def require_accepted(self) -> CaptureReport:
        if not self.accepted:
            raise CaptureStreamError(
                "E_NOT_ACCEPTED",
                "source not fully consumed, verified through the footer and decoded",
            )
        return self.capture.report

    def _declared_raster(self) -> tuple[int, int] | None:
        enc = (self.capture.report.profile or {}).get("encoder", {})
        if "width" in enc and "height" in enc:
            return (int(enc["width"]), int(enc["height"]))
        return None

    def __iter__(self) -> Iterator[DecodedFrame]:
        self._decoded_ok = False
        if isinstance(self.capture, JpegCaptureStream):
            jpeg = JpegDecoder(self.limits.max_pixels)
            self.decode_stats = jpeg.stats
            yield from jpeg.decode(iter(self.capture))
            self._decoded_ok = True
            return
        decoder = H264Decoder(
            max_pending=self._max_pending,
            max_pixels=self.limits.max_pixels,
            max_side=self.limits.max_raster_side,
        )
        self.decode_stats = decoder.stats
        for frame in decoder.decode(iter(self.capture)):
            declared = self._declared_raster()  # Profile precedes every access unit
            if declared is not None and frame.transform.raster != declared:
                raise DecodeError(
                    "E_RASTER_MISMATCH",
                    {
                        "decoded": list(frame.transform.raster),
                        "declared": list(declared),
                    },
                )
            yield frame
        self._decoded_ok = True
