"""`iter_frames`: forward-only source -> verified-so-far decoded RGB frames (SA-29 seam for SA-30/31).

    stream = FrameStream(open(path, "rb"))
    for frame in stream:            # DecodedFrame: rgb ndarray + original AccessUnit identity
        process(frame)              # provisional: temporary, bounded artifacts only
    stream.require_accepted()       # requires a verified, decoded, publishable source
    stream.report                   # CaptureReport (source hash/bytes/reads, counts, peaks)

Each access unit is decoded once by one persistent decoder. The consumer receives the single RGB
array per frame and may feed inference and encoders from it. Success, publication and acceptance
wait for `require_accepted()`; iteration raising means the job failed.

`source_profile="stera_jpeg_mcap_v1"` selects the original Stera JPEG adapter explicitly.
It preserves original ROS/MCAP evidence and verifies the MCAP container through EOF.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path
from typing import BinaryIO

from .capture_stream import (
    AccessUnit,
    CaptureReport,
    CaptureStream,
    CaptureStreamError,
    StreamLimits,
)
from .h264_decode import DecodedFrame, DecodeError, DecodeStats, H264Decoder
from .jpeg_decode import JpegDecoder
from .jpeg_stream import JPEG_PROFILE, JpegCaptureStream
from .source_range import SourceRange, select_access_units


class FrameStream:
    def __init__(
        self,
        raw: BinaryIO,
        limits: StreamLimits | None = None,
        *,
        max_decoder_pending: int = 4,
        source_profile: str | None = None,
        source_range: SourceRange | None = None,
        work_dir: Path | None = None,
        on_preroll: Callable[[AccessUnit], None] | None = None,
    ):
        self.limits = limits or StreamLimits()
        if source_profile == JPEG_PROFILE:
            if source_range is not None:
                raise CaptureStreamError("E_SOURCE_PROFILE", source_profile)
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
        self.source_range = source_range
        self._work_dir = work_dir
        self._on_preroll = on_preroll
        self._selected = 0
        self.decode_stats: DecodeStats | None = None
        self._decoded_ok = False

    @property
    def report(self) -> CaptureReport:
        return self.capture.report

    @property
    def accepted(self) -> bool:
        """True after source verification and complete decode of the requested frames."""
        st, rep = self.decode_stats, self.report
        if not self._decoded_ok or not rep.auto_admissible or st is None:
            return False
        if st.packets_sent != st.frames_out:
            return False
        if self.source_range is None:
            return st.frames_out == rep.video_messages
        return (
            self.source_range.end_ordinal <= rep.video_messages
            and self._selected == self.source_range.frame_count
        )

    def require_accepted(self) -> CaptureReport:
        if self.capture.accepted:
            self.report.require_auto_admissible()
        if not self.accepted:
            raise CaptureStreamError(
                "E_NOT_ACCEPTED",
                "source not fully consumed, verified through the footer and decoded",
            )
        return self.report

    def _declared_raster(self) -> tuple[int, int] | None:
        enc = (self.capture.report.profile or {}).get("encoder", {})
        if "width" in enc and "height" in enc:
            return (int(enc["width"]), int(enc["height"]))
        return None

    def __iter__(self) -> Iterator[DecodedFrame]:
        self._decoded_ok = False
        capture = self.capture
        if isinstance(capture, JpegCaptureStream):
            jpeg = JpegDecoder(self.limits.max_pixels)
            self.decode_stats = jpeg.stats
            yield from jpeg.decode(iter(capture))
            self._decoded_ok = True
            return
        decoder = H264Decoder(
            max_pending=self._max_pending,
            max_pixels=self.limits.max_pixels,
            max_side=self.limits.max_raster_side,
        )
        self.decode_stats = decoder.stats

        def units() -> Iterator[AccessUnit]:
            for au, _, preroll in select_access_units(
                capture, self.source_range, self._work_dir
            ):
                if preroll and self._on_preroll is not None:
                    self._on_preroll(au)
                yield au

        self._selected = 0
        for frame in decoder.decode(units()):
            declared = self._declared_raster()  # Profile precedes every access unit
            if declared is not None and frame.transform.raster != declared:
                raise DecodeError(
                    "E_RASTER_MISMATCH",
                    {
                        "decoded": list(frame.transform.raster),
                        "declared": list(declared),
                    },
                )
            if (
                self.source_range is not None
                and frame.access_unit.index < self.source_range.start_ordinal
            ):
                continue
            self._selected += 1
            yield frame
        self._decoded_ok = True
