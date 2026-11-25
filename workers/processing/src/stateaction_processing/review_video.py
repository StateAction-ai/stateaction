"""Standalone playback from only the selected source pixels."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import BinaryIO

from .artifact_rrd import TIME_BASE, ProxyEncoder, proxy_shape
from .artifact_types import ExportLimits, require
from .frames import FrameStream
from .h264_decode import DecodedFrame
from .source_range import ClipBinding

REVIEW_VIDEO_SLOT = "review-clip.mp4"
MAX_BYTES = 4 * 1024**3


class ReviewVideo:
    def __init__(
        self, path: Path, clip: ClipBinding, first: DecodedFrame, limits: ExportLimits
    ) -> None:
        import av

        self.path = path
        self.clip = clip
        self.origin = first.access_unit.encoder_pts_us
        self.clock = first.access_unit.native_clock_id
        self.frames = 0
        self.last_pts = -1
        self._digest = hashlib.sha256()
        w, h, _ = proxy_shape(*first.transform.raster, limits)
        self._encoder = ProxyEncoder(w, h, limits)
        self._av = av
        self._container = av.open(
            str(path), "w", format="mp4", options={"movflags": "+faststart"}
        )
        self._track = self._container.add_stream("h264", rate=limits.proxy_nominal_fps)
        self._track.width, self._track.height = w, h
        self._track.time_base = TIME_BASE

    def _mux(self, samples: list[tuple[bytes, bool, int]]) -> None:
        for data, key, pts in samples:
            packet = self._av.Packet(data)
            packet.pts = packet.dts = pts
            packet.is_keyframe = key
            packet.time_base = TIME_BASE
            packet.stream = self._track
            self._container.mux(packet)

    def add(self, frame: DecodedFrame) -> None:
        au = frame.access_unit
        count = self.clip.source_range.frame_count
        edge = (au.source_frame_id, au.native_timestamp_ns)
        pts = au.encoder_pts_us - self.origin
        require(
            self.frames < count
            and au.index == self.clip.source_range.start_ordinal + self.frames
            and (self.frames > 0 or edge == self.clip.first)
            and (self.frames + 1 < count or edge == self.clip.last)
            and au.native_clock_id == self.clock
            and pts > self.last_pts,
            "E_REVIEW_VIDEO_SOURCE_MISMATCH",
        )
        self._digest.update(pts.to_bytes(8, "big"))
        self._mux(self._encoder.encode(frame.rgb, pts))
        self.frames += 1
        self.last_pts = pts
        if self.frames % 30 == 0:
            require(self.path.stat().st_size < MAX_BYTES, "E_REVIEW_VIDEO_TOO_LARGE")

    def close(self) -> None:
        require(
            self.frames == self.clip.source_range.frame_count, "E_REVIEW_VIDEO_COUNT"
        )
        self._mux(self._encoder.flush())
        self._container.close()
        require(0 < self.path.stat().st_size <= MAX_BYTES, "E_REVIEW_VIDEO_TOO_LARGE")
        actual = hashlib.sha256()
        count = 0
        with self._av.open(str(self.path)) as container:
            require(
                len(container.streams) == 1 and len(container.streams.video) == 1,
                "E_REVIEW_VIDEO_TRACK",
            )
            for packet in container.demux(video=0):
                if not packet.size:
                    continue
                require(
                    packet.pts is not None
                    and packet.pts >= 0
                    and packet.pts == packet.dts
                    and packet.time_base == TIME_BASE
                    and not packet.is_discard
                    and (count > 0 or packet.is_keyframe),
                    "E_REVIEW_VIDEO_PACKET",
                )
                actual.update(int(packet.pts).to_bytes(8, "big"))
                count += 1
        require(
            count == self.frames and actual.digest() == self._digest.digest(),
            "E_REVIEW_VIDEO_PTS_MISMATCH",
        )

    def abort(self) -> None:
        self._container.close()


def materialize(
    raw: BinaryIO, output: Path, clip: ClipBinding, source_sha256: str, profile: str
) -> None:
    with TemporaryDirectory(prefix="review-video-", dir=output.parent) as work:
        scratch = Path(work)
        stream = FrameStream(
            raw,
            source_profile=profile,
            source_range=clip.source_range,
            work_dir=scratch,
        )
        video = None
        try:
            for frame in stream:
                if video is None:
                    video = ReviewVideo(
                        scratch / REVIEW_VIDEO_SLOT, clip, frame, ExportLimits()
                    )
                video.add(frame)
            report = stream.require_accepted()
            require(report.source.sha256 == source_sha256, "E_SOURCE_SHA_MISMATCH")
            require(video is not None, "E_REVIEW_VIDEO_COUNT")
            assert video is not None
            video.close()
            video.path.replace(output)
        finally:
            if video is not None:
                video.abort()


def main() -> None:
    from stateaction_contracts import validate_value

    task, source_sha256, output = sys.argv[1:]
    parsed = json.loads(task)
    require(validate_value("jobs.task-input.v4", parsed).valid, "E_REVIEW_VIDEO_TASK")
    materialize(
        sys.stdin.buffer,
        Path(output),
        ClipBinding.from_task(parsed),
        source_sha256,
        parsed["rgbProfile"],
    )


if __name__ == "__main__":
    main()
