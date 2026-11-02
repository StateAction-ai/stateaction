"""Writer for one immutable clip: native MP4 remux, NPZ, JSON, frame map, thumbnail, RRD (SA-31).

A clip starts at an IDR and holds frames in source order. Per frame the writer receives the
already-decoded `DecodedFrame` and its `HandObservation` (one decode, one inference, both done
upstream). Files are produced into a scratch directory and are provisional until the exporter has
accepted the whole source.

* `rgb.mp4`: the original Annex B access units muxed unchanged (no decode, no encode, no frame-rate
  conversion). Packet PTS=DTS=clip_pts in 1/1,000,000. Remux integrity is checked on the written
  file by demuxing (no decode): PTS list and VCL NAL bytes must equal the source access units.
* `hand-arrays.npz`: the eight contract arrays; NaN + False mask where a hand/joint is absent.
* `hand-observations.json` / `frame-map.json`: the frozen `stateaction.*.v1` documents, checked with
  the shared contract validators on the exact bytes written.
"""

from __future__ import annotations

import hashlib
import json
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np

from .artifact_rrd import RrdWriter
from .artifact_types import (
    FILE_NAMES,
    ROLE_BY_KEY,
    ExportError,
    ExportLimits,
    OutputFile,
    make_output,
    require,
)
from .h264_decode import DecodedFrame
from .hand_model import MAX_HANDS, NUM_LANDMARKS

TIME_BASE = Fraction(1, 1_000_000)
JOINT_ORDER = [
    "wrist", "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip",
    "index_finger_mcp", "index_finger_pip", "index_finger_dip", "index_finger_tip",
    "middle_finger_mcp", "middle_finger_pip", "middle_finger_dip", "middle_finger_tip",
    "ring_finger_mcp", "ring_finger_pip", "ring_finger_dip", "ring_finger_tip",
    "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip",
]  # fmt: skip
ARRAY_SPEC = (
    ("image_landmarks_px", "float32"),
    ("image_landmarks_mask", "bool"),
    ("model_relative_joints", "float32"),
    ("model_relative_mask", "bool"),
    ("hand_detected", "bool"),
    ("handedness_score", "float32"),
    ("handedness", "int8"),
    ("frame_index", "int64"),
)
SIDE_CODE = {"left": 0, "right": 1}


def _short(v: Any) -> float:
    """Shortest decimal that round-trips the float32 exactly (JSON mirrors the NPZ bytes)."""
    return float(str(np.float32(v)))


def _point_list(arr: Any, mask: Any) -> list[list[float] | None]:
    return [
        [_short(x) for x in arr[j]] if bool(mask[j]) else None
        for j in range(arr.shape[0])
    ]


def _jsonb(doc: Any) -> bytes:
    return json.dumps(
        doc, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def _validate(contract: str, data: bytes) -> None:
    from stateaction_contracts import validate_bytes

    result = validate_bytes(contract, data)
    if not result.valid:
        raise ExportError(
            "E_CONTRACT_VIOLATION", (contract, result.code, result.errors[:3])
        )


class ClipWriter:
    def __init__(
        self,
        scratch: Path,
        ordinal: int,
        clip_id: str,
        job_id: str,
        first: DecodedFrame,
        limits: ExportLimits,
        rrd_note: str | None = None,
    ):
        import av

        self._av = av
        require(
            first.access_unit.is_idr, "E_CLIP_START_NOT_IDR", first.access_unit.sequence
        )
        self.ordinal, self.clip_id, self.job_id, self.limits = (
            ordinal,
            clip_id,
            job_id,
            limits,
        )
        self.dir = scratch / f"clip-{ordinal:03d}"
        self.dir.mkdir(parents=True)
        self.rel = f"clips/{ordinal:03d}"
        self.origin = first.access_unit.encoder_pts_us
        w, h = first.transform.raster
        self.raster = (w, h)
        self.clock_domain = first.access_unit.native_clock_id
        self.rows: list[dict[str, Any]] = []
        self.packet_hashes: list[tuple[int, list[str]]] = []
        self.frames = 0
        self.hands_frames = 0
        self._arr: dict[str, list[Any]] = {k: [] for k, _ in ARRAY_SPEC[:7]}
        self._hand_frames: list[dict[str, Any]] = []
        self.thumbnail: bytes | None = None
        self.mp4 = av.open(str(self.dir / FILE_NAMES["rgb_mp4"]), "w", format="mp4")
        self.stream = self.mp4.add_stream("h264")
        self.stream.width, self.stream.height = w, h
        self.stream.time_base = TIME_BASE
        self.rrd = RrdWriter(
            self.dir / FILE_NAMES["viewer_rrd"], clip_id, (w, h), limits, rrd_note
        )
        self.last_pts = -1
        self._thumb_from(first)

    # ------------------------------------------------------------------ per frame
    @property
    def first_pts(self) -> int:
        return self.origin

    def age_us(self, encoder_pts_us: int) -> int:
        return encoder_pts_us - self.origin

    def add(self, frame: DecodedFrame, obs: Any) -> None:
        au = frame.access_unit
        w, h = frame.transform.raster
        require((w, h) == self.raster, "E_RASTER_CHANGED_IN_CLIP", [w, h])
        require(au.native_clock_id == self.clock_domain, "E_CLOCK_CHANGED_IN_CLIP")
        require(
            au.source_frame_id.isdigit(),
            "E_SOURCE_FRAME_ID_NOT_INT64",
            au.source_frame_id,
        )
        clip_pts = au.encoder_pts_us - self.origin
        require(clip_pts > self.last_pts, "E_CLIP_PTS_ORDER", clip_pts)
        self.last_pts = clip_pts
        # Native remux: the original Annex B AU goes into the muxer unchanged.
        packet = self._av.Packet(au.data)
        packet.pts = packet.dts = clip_pts
        packet.time_base = TIME_BASE
        packet.stream = self.stream
        packet.is_keyframe = au.is_idr
        self.mp4.mux(packet)
        self.packet_hashes.append((clip_pts, _vcl_hashes_annexb(au.data)))
        self.rrd.add(
            frame.rgb, au.data, au.is_idr, clip_pts, int(au.source_frame_id), obs
        )

        index = self.frames
        mask = obs.landmark_mask
        self._arr["image_landmarks_px"].append(obs.image_landmarks_px)
        self._arr["image_landmarks_mask"].append(mask)
        self._arr["model_relative_joints"].append(obs.model_relative_landmarks_m)
        self._arr["model_relative_mask"].append(mask)
        self._arr["hand_detected"].append(obs.hand_present)
        self._arr["handedness_score"].append(obs.handedness_score)
        self._arr["handedness"].append(
            np.array(
                [SIDE_CODE[lab] if lab else -1 for lab in obs.handedness_label],
                dtype=np.int8,
            )
        )
        hands = []
        for j in range(MAX_HANDS):
            if not obs.hand_present[j]:
                continue
            hands.append(
                {
                    "hand_index": j,
                    "handedness": obs.handedness_label[j],
                    "handedness_score": _short(obs.handedness_score[j]),
                    "visibility": "unknown",
                    "image_landmarks_px": _point_list(
                        obs.image_landmarks_px[j], mask[j]
                    ),
                    "image_mask": [bool(x) for x in mask[j]],
                    "points_3d": {
                        "space": "model_relative",
                        "units": "model_estimated_meters",
                        "origin": "hand_geometric_center",
                        "metric_accuracy_validated": False,
                        "joints": _point_list(
                            obs.model_relative_landmarks_m[j], mask[j]
                        ),
                        "mask": [bool(x) for x in mask[j]],
                    },
                }
            )
        self.hands_frames += 1 if hands else 0
        self._hand_frames.append({"frame_index": index, "hands": hands})
        self.rows.append(
            {
                "frame_index": index,
                "source_frame_id": au.source_frame_id,
                "clock_domain": au.native_clock_id,
                "timestamp_ns": au.native_timestamp_ns,
                "source_pts": str(au.encoder_pts_us),
                "clip_pts": str(clip_pts),
                "raster": {"width": w, "height": h},
                # Identity of OUR processing (native remux); display orientation stays unknown.
                "transform": {
                    "rotation_degrees": 0,
                    "mirrored": False,
                    "crop": {"x": 0, "y": 0, "width": w, "height": h},
                },
                "timing_verified": False,
            }
        )
        self.frames += 1
        if self.frames % self.limits.scratch_check_every_frames == 0:
            self.check_scratch()

    def check_scratch(self) -> None:
        used = sum(p.stat().st_size for p in self.dir.iterdir() if p.is_file())
        require(used <= self.limits.max_scratch_bytes, "E_SCRATCH_LIMIT", used)
        require(
            self.rrd.partial_bytes() <= self.limits.max_rrd_bytes,
            "E_RRD_LIMIT",
            self.rrd.partial_bytes(),
        )

    def _thumb_from(self, frame: DecodedFrame) -> None:
        av = self._av
        h, w = frame.rgb.shape[:2]
        scale = min(1.0, self.limits.thumbnail_max_side / max(w, h))
        tw, th = max(2, int(w * scale) & ~1), max(2, int(h * scale) & ~1)
        vf = av.VideoFrame.from_ndarray(frame.rgb, format="rgb24").reformat(
            width=tw, height=th, format="yuvj420p"
        )
        enc = av.CodecContext.create("mjpeg", "w")
        enc.width, enc.height, enc.pix_fmt = tw, th, "yuvj420p"
        enc.time_base = Fraction(1, 25)
        enc.options = {"q:v": "3"}
        enc.open()
        vf.pts = 0
        packets = list(enc.encode(vf)) + list(enc.encode(None))
        require(len(packets) == 1, "E_THUMBNAIL_ENCODE", len(packets))
        self.thumbnail = bytes(packets[0])

    # ------------------------------------------------------------------ close
    def close(self) -> tuple[dict[str, Any], list[OutputFile]]:
        require(self.frames >= 1, "E_CLIP_EMPTY")
        self.mp4.close()
        rrd_info = self.rrd.close()
        self._verify_mp4()
        n = self.frames
        arrays = {
            name: np.stack(self._arr[name]).astype(dt, copy=False)
            for name, dt in ARRAY_SPEC[:7]
        }
        arrays["frame_index"] = np.arange(n, dtype=np.int64)
        shapes = {
            "image_landmarks_px": (n, MAX_HANDS, NUM_LANDMARKS, 2),
            "image_landmarks_mask": (n, MAX_HANDS, NUM_LANDMARKS),
            "model_relative_joints": (n, MAX_HANDS, NUM_LANDMARKS, 3),
            "model_relative_mask": (n, MAX_HANDS, NUM_LANDMARKS),
            "hand_detected": (n, MAX_HANDS),
            "handedness_score": (n, MAX_HANDS),
            "handedness": (n, MAX_HANDS),
            "frame_index": (n,),
        }
        for name, shape in shapes.items():
            require(
                arrays[name].shape == shape, "E_ARRAY_SHAPE", (name, arrays[name].shape)
            )
        np.savez_compressed(self.dir / FILE_NAMES["hand_arrays_npz"], **arrays)

        first_row, last_row = self.rows[0], self.rows[-1]
        hand_doc = {
            "schema": "stateaction.hand_observations.v1",
            "job_id": self.job_id,
            "clip_id": self.clip_id,
            "frame_count": n,
            "joint_order": JOINT_ORDER,
            "image_space": {
                "raster": {"width": self.raster[0], "height": self.raster[1]},
                "units": "px",
                "origin": "top_left_pixel_corner",
            },
            "frames": self._hand_frames,
        }
        hand_bytes = _jsonb(hand_doc)
        require(
            len(hand_bytes) <= self.limits.max_hand_json_bytes,
            "E_HAND_JSON_TOO_LARGE",
            len(hand_bytes),
        )
        _validate("artifacts.hand-observations.v1", hand_bytes)
        (self.dir / FILE_NAMES["hand_observations_json"]).write_bytes(hand_bytes)
        map_doc = {
            "schema": "stateaction.frame_map.v1",
            "job_id": self.job_id,
            "clip_id": self.clip_id,
            "frame_count": n,
            "time_base": {"num": 1, "den": 1_000_000},
            "rows": self.rows,
        }
        map_bytes = _jsonb(map_doc)
        _validate("artifacts.frame-map.v1", map_bytes)
        (self.dir / FILE_NAMES["frame_map_json"]).write_bytes(map_bytes)
        assert self.thumbnail is not None
        (self.dir / FILE_NAMES["thumbnail_jpeg"]).write_bytes(self.thumbnail)

        outputs = [
            make_output(
                ROLE_BY_KEY[key],
                f"{self.rel}/{FILE_NAMES[key]}",
                self.dir / FILE_NAMES[key],
                self.ordinal,
            )
            for key in ROLE_BY_KEY
        ]
        clip_meta = {
            "ordinal": self.ordinal,
            "clip_id": self.clip_id,
            "source_start_ns": first_row["timestamp_ns"],
            "source_end_ns": last_row["timestamp_ns"],
            "clock_domain": self.clock_domain,
            "raster": {"width": self.raster[0], "height": self.raster[1]},
            "frame_count": n,
            "frames_with_hands": self.hands_frames,
            "array_shapes": {k: list(v) for k, v in shapes.items()},
            "first_source_pts": first_row["source_pts"],
            "last_source_pts": last_row["source_pts"],
            "rrd": rrd_info,
        }
        return clip_meta, outputs

    def abort(self) -> None:
        try:
            self.mp4.close()
        except Exception:  # best effort during failure cleanup
            pass
        self.rrd.abort()

    # ------------------------------------------------------------------ integrity
    def _verify_mp4(self) -> None:
        """Demux-only check (no decode): packet count, exact PTS and VCL NAL bytes of every AU."""
        av = self._av
        with av.open(str(self.dir / FILE_NAMES["rgb_mp4"])) as src:
            stream = src.streams.video[0]
            extra = stream.codec_context.extradata
            require(extra is not None and extra[0] == 1, "E_MP4_NO_AVCC")
            nal_len = (extra[4] & 3) + 1
            got = []
            for p in src.demux(stream):
                if not p.size:
                    continue
                require(
                    p.pts is not None and p.time_base == TIME_BASE, "E_MP4_TIMEBASE"
                )
                got.append((int(p.pts), _vcl_hashes_avcc(bytes(p), nal_len)))
        require(
            got == self.packet_hashes,
            "E_MP4_REMUX_MISMATCH",
            (len(got), len(self.packet_hashes)),
        )


def _vcl_hashes_annexb(data: bytes) -> list[str]:
    out, i, n = [], 0, len(data)
    starts = []
    while i + 3 <= n:
        if data[i : i + 3] == b"\x00\x00\x01":
            starts.append(i + 3)
            i += 3
        else:
            i += 1
    for k, s in enumerate(starts):
        end = (starts[k + 1] - 3) if k + 1 < len(starts) else n
        while end > s and data[end - 1] == 0 and k + 1 < len(starts):
            end -= 1  # the 4-byte start code's leading zero belongs to the next unit
        nal = data[s:end]
        if nal and nal[0] & 31 in (1, 5):
            out.append(hashlib.sha256(nal).hexdigest())
    return out


def _vcl_hashes_avcc(data: bytes, nal_len: int) -> list[str]:
    out, pos = [], 0
    while pos < len(data):
        size = int.from_bytes(data[pos : pos + nal_len], "big")
        pos += nal_len
        nal = data[pos : pos + size]
        pos += size
        require(bool(nal) and pos <= len(data), "E_MP4_NAL_LENGTH")
        if nal[0] & 31 in (1, 5):
            out.append(hashlib.sha256(nal).hexdigest())
    return out
