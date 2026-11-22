"""Full-recording native remux plus the frame map (MP4 index -> source frame identity).

The H.264 access units of the verified-so-far MCAP are muxed unchanged into one MP4 (no decode, no
encode, no frame-rate conversion), exactly as `artifact_clip.ClipWriter` does per clip. The frame
map keeps, per MP4 index, the native `source_frame_id`, the integer `timestamp_ns` in the native
clock domain and the PTS (microseconds from the first frame), so a module that reports MP4 frame
indices or seconds can be mapped back to the frame identities the contracts use.

The AU count must equal the MCAP's video message count and the demuxed MP4 packet count. Nothing is
complete before `require_accepted` proved the whole source (footer, CRC, SHA-256, Close).
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import BinaryIO, Callable

from .capture_stream import CaptureStream, StreamLimits

TIME_BASE = Fraction(1, 1_000_000)
MAX_FRAMES = 10_000_000


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
    """Coded raster of the first IDR (its SPS), read by decoding that one access unit only."""
    import av

    ctx = av.CodecContext.create("h264", "r")
    ctx.thread_count = 1
    frames = list(ctx.decode(av.Packet(idr))) or list(ctx.decode(None))
    _require(bool(frames), "raster_undeclared")
    return int(frames[0].width), int(frames[0].height)


def remux_source(
    raw: BinaryIO,
    out_path: Path,
    *,
    expected_profile: str | None = None,
    limits: StreamLimits | None = None,
    on_frame: Callable[[int], None] | None = None,
) -> FrameMap:
    """Mux every access unit natively into `out_path`; return the frame map. Raises on any mismatch."""
    import av

    from .artifact_clip import TIME_BASE as CLIP_TIME_BASE
    from .artifact_clip import _vcl_hashes_annexb, _vcl_hashes_avcc

    assert CLIP_TIME_BASE == TIME_BASE
    stream = CaptureStream(raw, limits, expected_profile=expected_profile)
    frames = FrameMap()
    hashes: list[tuple[int, list[str]]] = []
    container = av.open(str(out_path), "w", format="mp4")
    try:
        video = None
        origin = 0
        last_pts = -1
        for au in stream:
            _require(au.source_frame_id.isdigit(), "source_frame_id_not_int64")
            _require(len(frames) < MAX_FRAMES, "too_many_frames")
            if video is None:
                _require(au.is_idr, "first_access_unit_not_idr")
                video = container.add_stream("h264")
                video.width, video.height = _raster_of(au.data)
                video.time_base = TIME_BASE
                origin = au.encoder_pts_us
                frames.clock_domain = au.native_clock_id
            _require(au.native_clock_id == frames.clock_domain, "clock_changed")
            pts = au.encoder_pts_us - origin
            _require(pts > last_pts, "pts_not_increasing")
            last_pts = pts
            packet = av.Packet(au.data)
            packet.pts = packet.dts = pts
            packet.time_base = TIME_BASE
            packet.stream = video
            packet.is_keyframe = au.is_idr
            container.mux(packet)
            hashes.append((pts, _vcl_hashes_annexb(au.data)))
            frames.frame_ids.append(au.source_frame_id)
            frames.timestamps_ns.append(au.native_timestamp_ns)
            frames.pts_us.append(pts)
            if on_frame is not None:
                on_frame(len(frames))
    finally:
        container.close()
    _require(len(frames) > 0, "no_video_frames")
    stream_report = stream.report
    _require(stream.accepted, "source_not_accepted")
    frames.source_sha256 = stream_report.source.sha256
    _require(len(frames) == stream_report.video_messages, "au_count_mismatch")
    with av.open(str(out_path)) as src:
        track = src.streams.video[0]
        extra = track.codec_context.extradata
        _require(extra is not None and extra[0] == 1, "mp4_no_avcc")
        nal_len = (extra[4] & 3) + 1
        got = [
            (int(p.pts), _vcl_hashes_avcc(bytes(p), nal_len))
            for p in src.demux(track)
            if p.size
        ]
    _require(len(got) == len(frames), "mp4_packet_count_mismatch")
    _require(got == hashes, "mp4_remux_mismatch")
    return frames
