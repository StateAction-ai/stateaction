"""Native recording or clip remux plus the frame map (MP4 index -> source identity).

The H.264 access units of the verified-so-far MCAP are muxed unchanged into one MP4 (no decode, no
encode, no frame-rate conversion), exactly as `artifact_clip.ClipWriter` does per clip. The frame
map keeps, per MP4 index, the native `source_frame_id`, the integer `timestamp_ns` in the native
clock domain and the PTS (microseconds from the first frame), so a module that reports MP4 frame
indices or seconds can be mapped back to the frame identities the contracts use.

A clip can start between keyframes. The MP4 edit list hides the preceding decode context.
Success requires whole-source verification (footer, CRC, SHA-256 and Close) and a completed
capture, even when only part of the source is muxed.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import BinaryIO, Callable

from .capture_stream import CaptureStream, StreamLimits
from .source_range import MAX_FRAMES, SourceRange, select_access_units

TIME_BASE = Fraction(1, 1_000_000)


class StageMediaError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _require(ok: bool, code: str) -> None:
    if not ok:
        raise StageMediaError(code)


@dataclass
class FrameMap:
    """Parallel per-frame lists in MP4 (== MCAP video message) order."""

    clock_domain: str = ""
    source_sha256: str = ""  # verified sha256 of the whole source MCAP
    frame_ids: list[str] = field(default_factory=list)
    timestamps_ns: list[str] = field(default_factory=list)
    pts_us: list[int] = field(default_factory=list)  # relative to the first frame

    source_origin_pts_us: int = 0

    def __len__(self) -> int:
        return len(self.frame_ids)

    def ref(self, index: int) -> dict[str, str]:
        """`frameRef` of the decoded frame at MP4 index `index` (0 <= index < len)."""
        _require(0 <= index < len(self), "frame_index_out_of_range")
        return {
            "source_frame_id": self.frame_ids[index],
            "timestamp_ns": self.timestamps_ns[index],
        }

    def end_ref(self, index: int) -> dict[str, str | None]:
        """`endFrameRef` of an exclusive end index; `len(self)` is the end-of-stream sentinel."""
        if index == len(self):
            return {"source_frame_id": None, "timestamp_ns": None}
        return dict(self.ref(index))

    def index_at_or_after(self, seconds: float) -> int:
        """First frame at or after `seconds` from the first frame (FLORA's clock), like FLORA."""
        return bisect_left(self.pts_us, round(seconds * 1e6))


def _raster_of(idr: bytes) -> tuple[int, int]:
    """Get the coded raster from the keyframe headers without decoding pixels."""
    import av

    ctx = av.CodecContext.create("h264", "r")
    ctx.parse(idr)
    ctx.parse(b"")
    _require(ctx.width > 0 and ctx.height > 0, "raster_undeclared")
    return int(ctx.width), int(ctx.height)


def remux_source(
    raw: BinaryIO,
    out_path: Path,
    *,
    expected_profile: str | None = None,
    limits: StreamLimits | None = None,
    on_frame: Callable[[int], None] | None = None,
    source_range: SourceRange | None = None,
) -> FrameMap:
    """Mux a verified source range natively and return its visible frame map."""
    import av

    from .artifact_clip import TIME_BASE as CLIP_TIME_BASE
    from .artifact_clip import _vcl_hashes_annexb, _vcl_hashes_avcc

    assert CLIP_TIME_BASE == TIME_BASE
    stream = CaptureStream(raw, limits, expected_profile=expected_profile)
    frames = FrameMap()
    hashes: list[tuple[int, bool, list[str]]] = []
    options = (
        {
            "use_editlist": "1",
            "avoid_negative_ts": "disabled",
            "movie_timescale": "1000000",
        }
        if source_range is not None
        else {}
    )
    container = av.open(str(out_path), "w", format="mp4", options=options)
    try:
        video = None
        last_pts: int | None = None
        for au, origin, discard in select_access_units(
            stream, source_range, out_path.parent
        ):
            _require(au.source_frame_id.isdigit(), "source_frame_id_not_int64")
            _require(len(frames) < MAX_FRAMES, "too_many_frames")
            if video is None:
                _require(au.is_idr, "first_access_unit_not_idr")
                video = container.add_stream("h264")
                video.width, video.height = _raster_of(au.data)
                video.time_base = TIME_BASE
                frames.source_origin_pts_us = origin
                frames.clock_domain = au.native_clock_id
            _require(
                au.calibration_raster in (None, (video.width, video.height)),
                "calibration_raster_mismatch",
            )
            _require(au.native_clock_id == frames.clock_domain, "clock_changed")
            pts = au.encoder_pts_us - origin
            _require(last_pts is None or pts > last_pts, "pts_not_increasing")
            last_pts = pts
            packet = av.Packet(au.data)
            packet.pts = packet.dts = pts
            packet.time_base = TIME_BASE
            packet.stream = video
            packet.is_keyframe = au.is_idr
            container.mux(packet)
            hashes.append((pts, discard, _vcl_hashes_annexb(au.data)))
            if discard:
                continue
            frames.frame_ids.append(au.source_frame_id)
            frames.timestamps_ns.append(au.native_timestamp_ns)
            frames.pts_us.append(pts)
            if on_frame is not None:
                on_frame(len(frames))
    finally:
        container.close()
    stream_report = stream.report
    stream_report.require_auto_admissible()
    if source_range is not None:
        _require(
            source_range.end_ordinal <= stream_report.video_messages,
            "clip_range_not_in_source",
        )
        expected = source_range.frame_count
    else:
        expected = stream_report.video_messages
    _require(len(frames) > 0, "no_video_frames")
    frames.source_sha256 = stream_report.source.sha256
    _require(len(frames) == expected, "au_count_mismatch")
    with av.open(str(out_path)) as src:
        track = src.streams.video[0]
        extra = track.codec_context.extradata
        _require(extra is not None and extra[0] == 1, "mp4_no_avcc")
        nal_len = (extra[4] & 3) + 1
        got = [
            (int(p.pts), p.is_discard, _vcl_hashes_avcc(bytes(p), nal_len))
            for p in src.demux(track)
            if p.size
        ]
    _require(len(got) == len(hashes), "mp4_packet_count_mismatch")
    _require(got == hashes, "mp4_remux_mismatch")
    return frames
