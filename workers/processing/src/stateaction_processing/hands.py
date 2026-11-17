"""CPU hand landmark inference adapter (SA-30).

One `HandInferencer.infer(frame)` call per decoded frame. MediaPipe Hand Landmarker runs on the
CPU delegate in IMAGE mode (every frame independent: no tracking state can invent a hand), up to
two hands, with the pinned 0.5 detection/presence thresholds. Any model error raises
`HandInferenceError`; there is no RGB-only fallback.

Conventions (carried on every observation as `SEMANTICS`):
- `image_landmarks_px[h, j] = (x, y)` in pixels of the decoded raster (normalized landmark * width/
  height; may fall outside the raster for partly visible hands). The model's relative image-z is not
  exported. Raster crop/rotation/mirror are unknown in contract v1 and carried as unknown.
- `model_relative_landmarks_m[h, j] = (x, y, z)` is MediaPipe's hand-centred world estimate in
  metres: model-relative only, no camera pose, no scale validation. `metric_accuracy_validated` is
  always False.
- `hand_present[h]` is a detection flag; `landmark_mask[h, j]` is True only when both the pixel and
  the 3D coordinate of that joint are finite. Absent or non-finite entries are NaN with a False
  mask, never fabricated.
- The model gives one handedness category and score per hand, not per-joint confidence. Those
  are exported as `handedness_score` (hand-level classification score). `joint_confidence` and
  `joint_visibility` are unsupported (None). The hand axis is detection order, not identity.
- `handedness_label` is the model's label. MediaPipe assumes a mirrored (selfie) input, and the
  capture mirror state is unknown, so it is not asserted to be the person's anatomical side.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .h264_decode import DecodedFrame, FrameTransform
from .hand_model import (
    MAX_HANDS,
    NUM_LANDMARKS,
    PINS,
    HandModelError,
    VerifiedModel,
    resolve_model,
)
from .jpeg_stream import JpegImage

SEMANTICS: dict[str, Any] = {
    "image_landmarks_px": "pixels of the decoded raster; crop, rotation and mirror unverified",
    "model_relative_landmarks_m": "MediaPipe hand-centred world estimate, metres, model-relative only",
    "hand_axis": "detection order, not tracked identity",
    "landmark_mask": "joint pixel and 3D coordinates both finite",
    "handedness_score": "hand-level classification score, NOT per-joint confidence",
    "joint_confidence": "unsupported",
    "joint_visibility": "unsupported",
    "handedness_label": "model label under a mirrored-input assumption; capture mirror unknown",
    "metric_accuracy_validated": False,
}


class HandInferenceError(RuntimeError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class JpegFrameProvenance:
    """Original MCAP/ROS message evidence and separately derived frame timing."""

    source_message: dict[str, Any]
    stream_ordinal: int
    derived_pts_us: int


@dataclass(frozen=True)
class FrameIdentity:
    """H.264 source identity, or JPEG evidence with derived processing aliases.

    For JPEG, the common frame ID and PTS fields are derived from stream order
    and the ROS header respectively. The original message fields are in `jpeg_source`.
    """

    sequence: int
    source_frame_id: str
    encoder_pts_us: int
    capture_time_ns: str
    log_time_ns: str
    native_clock_id: str
    native_timestamp_ns: str
    native_timestamps: dict[str, Any]
    calibration_id: str
    access_unit_sha256: str
    jpeg_source: JpegFrameProvenance | None = None


@dataclass(frozen=True)
class HandObservation:
    identity: FrameIdentity
    transform: FrameTransform
    image_landmarks_px: Any  # float32 [2, 21, 2]
    model_relative_landmarks_m: Any  # float32 [2, 21, 3]
    landmark_mask: Any  # bool [2, 21]
    hand_present: Any  # bool [2]
    handedness_label: tuple[str, str]  # "" when absent
    handedness_score: Any  # float32 [2], NaN when absent
    inference_ms: float
    metric_accuracy_validated: bool = False
    joint_confidence: None = None
    joint_visibility: None = None
    semantics: dict[str, Any] = field(default_factory=lambda: dict(SEMANTICS))

    @property
    def hands_detected(self) -> int:
        return int(self.hand_present.sum())

    def digest_into(self, h: Any) -> None:
        """Deterministic content digest excluding inference duration."""
        i = self.identity
        h.update(f"{i.sequence}|{i.source_frame_id}|{i.encoder_pts_us}|".encode())
        if i.jpeg_source is not None:
            h.update(
                json.dumps(
                    asdict(i.jpeg_source), sort_keys=True, separators=(",", ":")
                ).encode("utf-8")
            )
        for a in (
            self.image_landmarks_px,
            self.model_relative_landmarks_m,
            self.landmark_mask,
            self.hand_present,
            self.handedness_score,
        ):
            h.update(np.ascontiguousarray(a).tobytes())
        h.update("|".join(self.handedness_label).encode())


def identity_of(frame: DecodedFrame) -> FrameIdentity:
    au = frame.access_unit
    jpeg_source = (
        JpegFrameProvenance(au.source_message, au.index, au.derived_pts_us)
        if isinstance(au, JpegImage)
        else None
    )
    return FrameIdentity(
        sequence=au.sequence,
        source_frame_id=au.source_frame_id,
        encoder_pts_us=au.encoder_pts_us,
        capture_time_ns=au.capture_time_ns,
        log_time_ns=au.log_time_ns,
        native_clock_id=au.native_clock_id,
        native_timestamp_ns=au.native_timestamp_ns,
        native_timestamps=dict(au.native_timestamps),
        calibration_id=au.calibration_id,
        access_unit_sha256=au.sha256,
        jpeg_source=jpeg_source,
    )


def _req(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise HandInferenceError(code, detail)


def observation_from_result(
    result: Any, frame: DecodedFrame, inference_ms: float = 0.0
) -> HandObservation:
    """Map a MediaPipe HandLandmarkerResult to fixed-shape masked arrays; validates strictly."""
    height, width = int(frame.rgb.shape[0]), int(frame.rgb.shape[1])
    hands = list(result.hand_landmarks)
    worlds = list(result.hand_world_landmarks)
    handed = list(result.handedness)
    _req(len(hands) == len(worlds) == len(handed), "E_MODEL_RESULT_LENGTHS")
    _req(len(hands) <= MAX_HANDS, "E_MODEL_TOO_MANY_HANDS", len(hands))
    image: Any = np.full((MAX_HANDS, NUM_LANDMARKS, 2), np.nan, dtype=np.float32)
    local: Any = np.full((MAX_HANDS, NUM_LANDMARKS, 3), np.nan, dtype=np.float32)
    mask: Any = np.zeros((MAX_HANDS, NUM_LANDMARKS), dtype=bool)
    present: Any = np.zeros(MAX_HANDS, dtype=bool)
    score: Any = np.full(MAX_HANDS, np.nan, dtype=np.float32)
    labels = ["", ""]
    for j, (lm, world, cats) in enumerate(zip(hands, worlds, handed, strict=True)):
        _req(
            len(lm) == len(world) == NUM_LANDMARKS,
            "E_MODEL_LANDMARK_SHAPE",
            (len(lm), len(world)),
        )
        _req(len(cats) >= 1, "E_MODEL_HANDEDNESS_MISSING")
        side = str(cats[0].category_name).lower()
        _req(side in ("left", "right"), "E_MODEL_HANDEDNESS", side)
        try:
            hand_score = float(cats[0].score)
        except (TypeError, ValueError, OverflowError):
            raise HandInferenceError("E_MODEL_HANDEDNESS_SCORE") from None
        _req(0.0 <= hand_score <= 1.0, "E_MODEL_HANDEDNESS_SCORE")
        image[j] = [[p.x * width, p.y * height] for p in lm]
        local[j] = [[p.x, p.y, p.z] for p in world]
        mask[j] = np.isfinite(image[j]).all(axis=1) & np.isfinite(local[j]).all(axis=1)
        present[j] = True
        labels[j], score[j] = side, hand_score
        # Non-finite joints stay NaN-valued and masked out (copy the finite test, never repair).
        image[j][~mask[j]] = np.nan
        local[j][~mask[j]] = np.nan
    return HandObservation(
        identity=identity_of(frame),
        transform=frame.transform,
        image_landmarks_px=image,
        model_relative_landmarks_m=local,
        landmark_mask=mask,
        hand_present=present,
        handedness_label=(labels[0], labels[1]),
        handedness_score=score,
        inference_ms=inference_ms,
    )


class HandInferencer:
    """Owns one CPU HandLandmarker. Use as a context manager; call `infer` once per frame."""

    def __init__(self, model: VerifiedModel | str | Path | None = None):
        if not isinstance(model, VerifiedModel):
            model = resolve_model(model)
        self.model = model
        self.frames_inferred = 0
        try:
            import mediapipe as mp  # type: ignore[import-untyped]
        except ImportError as e:  # pragma: no cover - optional dependency
            raise HandModelError("E_MODEL_RUNTIME_UNAVAILABLE", "install 'cpu'") from e
        self._mp = mp
        try:
            options = mp.tasks.vision.HandLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(
                    model_asset_buffer=model.asset_buffer,
                    delegate=mp.tasks.BaseOptions.Delegate.CPU,
                ),
                running_mode=mp.tasks.vision.RunningMode.IMAGE,
                num_hands=MAX_HANDS,
                min_hand_detection_confidence=PINS["min_hand_detection_confidence"],
                min_hand_presence_confidence=PINS["min_hand_presence_confidence"],
            )
            self._landmarker = mp.tasks.vision.HandLandmarker.create_from_options(
                options
            )
        except Exception as e:
            raise HandModelError("E_MODEL_LOAD_FAILED", type(e).__name__) from None

    def infer(self, frame: DecodedFrame) -> HandObservation:
        rgb = frame.rgb
        _req(
            getattr(rgb, "dtype", None) == np.uint8
            and rgb.ndim == 3
            and rgb.shape[2] == 3,
            "E_FRAME_FORMAT",
        )
        t0 = time.perf_counter()
        try:
            image = self._mp.Image(
                image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)
            )
            result = self._landmarker.detect(image)
        except Exception as e:
            raise HandInferenceError("E_MODEL_FAILED", type(e).__name__) from None
        ms = (time.perf_counter() - t0) * 1000.0
        self.frames_inferred += 1
        return observation_from_result(result, frame, ms)

    def close(self) -> None:
        self._landmarker.close()

    def __enter__(self) -> HandInferencer:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def new_digest() -> Any:
    return hashlib.sha256()
