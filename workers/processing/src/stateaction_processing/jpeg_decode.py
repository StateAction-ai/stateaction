"""Decode each independently bounded JPEG once; never send JPEG bytes to the H264 decoder."""

from __future__ import annotations

from collections.abc import Iterable, Iterator

from .h264_decode import DecodedFrame, DecodeError, DecodeStats, FrameTransform
from .jpeg_stream import JpegImage


class JpegDecoder:
    def __init__(self, max_pixels: int) -> None:
        try:
            import av
        except ImportError as error:  # pragma: no cover
            raise DecodeError(
                "E_DECODER_UNAVAILABLE", "install the decode group"
            ) from error
        self._av = av
        self._ctx = av.CodecContext.create("mjpeg", "r")
        self._ctx.thread_count = 1
        self._ctx.options = {"err_detect": "explode", "max_pixels": str(max_pixels)}
        self._ctx.open()
        if "max_pixels" in self._ctx.options:
            raise DecodeError("E_DECODER_LIMIT_UNAVAILABLE")
        self.stats = DecodeStats(decoder_instances=1)

    def decode(self, images: Iterable[JpegImage]) -> Iterator[DecodedFrame]:
        try:
            for image in images:
                self.stats.packets_sent += 1
                self.stats.peak_pending = 1
                frames = self._ctx.decode(self._av.Packet(image.data))
                if len(frames) != 1:
                    raise DecodeError("E_JPEG_DECODE_COUNT", len(frames))
                frame = frames[0]
                raster = (int(frame.width), int(frame.height))
                if raster != image.raster:
                    raise DecodeError("E_RASTER_MISMATCH", (raster, image.raster))
                self.stats.rasters = (raster,)
                self.stats.frames_out += 1
                yield DecodedFrame(
                    frame.to_ndarray(format="rgb24"),
                    image,
                    FrameTransform(
                        raster,
                        basis="stera_jpeg_saved_raster; crop_rotation_mirror_unverified",
                    ),
                )
            if self._ctx.decode(None):
                raise DecodeError("E_JPEG_DECODE_COUNT", "unexpected delayed frames")
        except self._av.error.FFmpegError:
            raise DecodeError("E_DECODE_FAILED", "invalid JPEG") from None
