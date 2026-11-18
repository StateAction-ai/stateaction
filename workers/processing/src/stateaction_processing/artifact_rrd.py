"""Customer-safe, bounded Rerun 0.41.0 RRD for one clip (SA-31).

Entities (the whole allowlist): `rgb` (H.264 VideoStream), `rgb/hands/{hand0,hand1}` (image-pixel
joints and bones), `model_relative_3d/{hand0,hand1}` (explicitly model-relative 3D; slots are
detection order, never handedness) and `notes`.
Nothing else is logged: no MCAP, sensor, QC, path or unrelated clip data. The RRD is a separate
spatial proxy that never replaces the native MP4:

VideoStream samples are independently encoded with libx264 from decoded RGB pixels. This keeps
source H.264 metadata out of the preview. Rasters are scaled down to fit the proxy bound
(default 1280x720, either orientation) and rounded to even dimensions for yuv420p. Overlays use
the same scale, and the encoder preserves each frame's clip PTS.

Timeline `clip_time` is a duration in ns equal to clip_pts (= source_pts - first included source
pts, microsecond ticks) and `source_frame` is the original source_frame_id.
"""

from __future__ import annotations

import os
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np

from .artifact_types import ExportError, ExportLimits, require

TIME_BASE = Fraction(1, 1_000_000)
HAND_EDGES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10),
              (10, 11), (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18),
              (18, 19), (19, 20)]  # fmt: skip
# Entities are detector SLOTS (detection order), never handedness: two hands may carry the same label.
SLOTS = ("hand0", "hand1")
SLOT_COLORS = {"hand0": [80, 200, 255], "hand1": [255, 160, 40]}
HANDEDNESS_NOTE = (
    "model handedness label under a mirrored-input assumption; capture mirror unknown"
)
ALLOWED_ENTITIES = ("rgb", "model_relative_3d", "notes")
APPLICATION_ID = "stateaction-clip-review"


def proxy_shape(width: int, height: int, limits: ExportLimits) -> tuple[int, int, bool]:
    """(proxy_w, proxy_h, reencode). Portrait rasters use the swapped bound."""
    mw, mh = limits.proxy_max_width, limits.proxy_max_height
    if height > width:
        mw, mh = mh, mw
    scale = min(1.0, mw / width, mh / height)
    pw, ph = int(width * scale) & ~1, int(height * scale) & ~1  # even for yuv420p
    return max(pw, 2), max(ph, 2), True


class ProxyEncoder:
    """Bounded libx264 proxy encoder fed with the already-decoded RGB frame (no second decode)."""

    def __init__(self, width: int, height: int, limits: ExportLimits):
        import av

        self._av = av
        self.width, self.height, self.limits = width, height, limits
        ctx = av.CodecContext.create("libx264", "w")
        ctx.width, ctx.height = width, height
        ctx.pix_fmt = "yuv420p"
        ctx.time_base = TIME_BASE
        # Rate control needs an explicit nominal frame rate. A microsecond
        # time base alone makes libx264 assume 1,000,000 fps and quantize the
        # proxy to near-flat grey. This does not resample or change source PTS.
        ctx.framerate = Fraction(limits.proxy_nominal_fps, 1)
        ctx.bit_rate = limits.proxy_bitrate_bps
        ctx.thread_count = 1
        ctx.options = {
            "preset": "veryfast",
            "tune": "zerolatency",
            "bf": "0",
            "x264-params": (
                f"keyint={limits.proxy_keyint}:min-keyint={limits.proxy_keyint}"
                ":scenecut=0:repeat-headers=1:annexb=1"
            ),
        }
        ctx.open()
        self._ctx = ctx
        self.frames_in = 0
        self.packets_out = 0

    def encode(self, rgb: Any, clip_pts: int) -> list[tuple[bytes, bool, int]]:
        av = self._av
        frame = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(
            width=self.width, height=self.height, format="yuv420p"
        )
        frame.pts = clip_pts
        frame.time_base = TIME_BASE
        self.frames_in += 1
        out = self._collect(self._ctx.encode(frame))
        require(
            self.frames_in - self.packets_out <= self.limits.max_encoder_pending,
            "E_ENCODER_BACKLOG",
            self.frames_in - self.packets_out,
        )
        return out

    def flush(self) -> list[tuple[bytes, bool, int]]:
        out = self._collect(self._ctx.encode(None))
        require(self.frames_in == self.packets_out, "E_ENCODER_LOST_FRAMES")
        return out

    def _collect(self, packets: Any) -> list[tuple[bytes, bool, int]]:
        out = []
        for p in packets:
            require(p.pts is not None, "E_ENCODER_PTS_MISSING")
            out.append((bytes(p), bool(p.is_keyframe), int(p.pts)))
            self.packets_out += 1
        return out


class RrdWriter:
    def __init__(
        self,
        path: Path,
        clip_id: str,
        raster: tuple[int, int],
        limits: ExportLimits,
        extra_note: str | None = None,
    ):
        import rerun as rr
        import rerun.blueprint as rrb

        self._rr = rr
        self.path, self.limits = path, limits
        w, h = raster
        self.pw, self.ph, _ = proxy_shape(w, h, limits)
        self.sx, self.sy = self.pw / w, self.ph / h
        self.encoder = ProxyEncoder(self.pw, self.ph, limits)
        self._source_frames: dict[int, int] = {}
        self.rec = rr.RecordingStream(APPLICATION_ID, recording_id=clip_id)
        self.rec.save(str(path))
        self.samples = 0
        self.rec.log("rgb", rr.VideoStream(codec=rr.VideoCodec.H264), static=True)
        note = (
            "Model-relative 3D: MediaPipe hand-centred estimate in model-estimated metres. Not camera or "
            "world coordinates; metric accuracy, depth and occlusion are not validated. Overlays are image "
            "pixels of the decoded RGB frame. Time is clip-relative (clip_pts = source_pts - first source "
            "pts)."
        )
        note += (
            f" Preview re-encoded from decoded pixels at {self.pw}x{self.ph}."
            f" Source MP4 raster is {w}x{h} with overlay scale {self.sx:g} by {self.sy:g}."
        )
        if extra_note:
            note += " " + extra_note
        self.rec.log("notes/model_relative_3d", rr.TextDocument(note), static=True)
        self.rec.send_blueprint(
            rrb.Horizontal(
                rrb.Spatial2DView(origin="rgb", name="RGB + detected hands (image px)"),
                rrb.Vertical(
                    rrb.Spatial3DView(
                        origin="model_relative_3d/hand0",
                        name="Hand slot 0: model-relative 3D estimate",
                    ),
                    rrb.Spatial3DView(
                        origin="model_relative_3d/hand1",
                        name="Hand slot 1: model-relative 3D estimate",
                    ),
                    rrb.TextDocumentView(origin="notes", name="Notes"),
                ),
                column_shares=[3, 2],
            )
        )

    def add(
        self,
        rgb: Any,
        clip_pts: int,
        source_frame_id: int,
        obs: Any,
    ) -> None:
        rr, rec = self._rr, self.rec
        self._source_frames[clip_pts] = source_frame_id
        self._write_samples(self.encoder.encode(rgb, clip_pts))
        self._set_frame_time(clip_pts, source_frame_id)
        # Clear both slots every frame so a missing hand never persists.
        for slot in SLOTS:
            rec.log(f"rgb/hands/{slot}", rr.Clear(recursive=True))
            rec.log(f"model_relative_3d/{slot}", rr.Clear(recursive=True))
        labels = []
        for j, slot in enumerate(SLOTS[: obs.hand_present.shape[0]]):
            if not obs.hand_present[j]:
                continue
            labels.append(
                f"{slot}: {obs.handedness_label[j]} (score {float(obs.handedness_score[j]):.2f}); "
                + HANDEDNESS_NOTE
            )
            if not obs.landmark_mask[j].any():
                continue
            color = SLOT_COLORS[slot]
            ok = obs.landmark_mask[j]
            px = obs.image_landmarks_px[j] * np.array(
                [self.sx, self.sy], dtype=np.float32
            )
            local = obs.model_relative_landmarks_m[j]
            edges = [(a, b) for a, b in HAND_EDGES if ok[a] and ok[b]]
            rec.log(
                f"rgb/hands/{slot}/joints",
                rr.Points2D(px[ok], radii=max(2.0, self.pw / 320), colors=color),
            )
            rec.log(
                f"model_relative_3d/{slot}/joints",
                rr.Points3D(local[ok], radii=0.004, colors=color),
            )
            if edges:
                rec.log(
                    f"rgb/hands/{slot}/bones",
                    rr.LineStrips2D([px[[a, b]] for a, b in edges], colors=color),
                )
                rec.log(
                    f"model_relative_3d/{slot}/bones",
                    rr.LineStrips3D([local[[a, b]] for a, b in edges], colors=color),
                )
        if labels:
            rec.log("notes/handedness", rr.TextLog(" | ".join(labels)))

    def _set_frame_time(self, pts: int, source_frame_id: int) -> None:
        self.rec.set_time("clip_time", duration=np.timedelta64(pts * 1000, "ns"))
        self.rec.set_time("source_frame", sequence=source_frame_id)

    def _write_samples(self, packets: list[tuple[bytes, bool, int]]) -> None:
        for data, keyframe, pts in packets:
            source_frame_id = self._source_frames.pop(pts, None)
            if source_frame_id is None:
                raise ExportError("E_PROXY_PTS_MISMATCH", pts)
            self._set_frame_time(pts, source_frame_id)
            self._sample(data, keyframe)

    def _sample(self, data: bytes, keyframe: bool) -> None:
        self.rec.log(
            "rgb",
            self._rr.VideoStream.from_fields(sample=data, is_keyframe=keyframe),
        )
        self.samples += 1

    def partial_bytes(self) -> int:
        return os.stat(self.path).st_size if self.path.exists() else 0

    def close(self) -> dict[str, Any]:
        self._write_samples(self.encoder.flush())
        require(
            not self._source_frames and self.samples == self.encoder.frames_in,
            "E_PROXY_SAMPLE_COUNT",
            (self.samples, self.encoder.frames_in),
        )
        self.rec.flush()
        self.rec.disconnect()
        size = self.path.stat().st_size
        if size > self.limits.max_rrd_bytes:
            raise ExportError("E_RRD_LIMIT", size)
        return {
            "bytes": size,
            "samples": self.samples,
            "proxy_raster": [self.pw, self.ph],
            "reencoded": True,
            "overlay_scale": [self.sx, self.sy],
        }

    def abort(self) -> None:
        try:
            self.rec.disconnect()
        except Exception:  # best effort; the scratch file is deleted by the caller
            pass
