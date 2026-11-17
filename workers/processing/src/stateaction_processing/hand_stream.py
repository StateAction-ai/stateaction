"""Run CPU hand inference over a streamed, verified capture (SA-30).

    summary = run_hand_inference(open(path, "rb"), sink)   # sink(HandObservation), provisional

Each frame is decoded once by `FrameStream` and inferred once. Observations are handed to `sink`
immediately and never accumulated here (no whole-session arrays). The sink's output is provisional:
`run_hand_inference` returns a summary only after `FrameStream.require_accepted()` verifies the
selected source profile and the decoder finishes. A model, decode or source error raises, so a job can
never succeed with RGB-only output. Frames with no hand are legitimate masked observations.
"""

from __future__ import annotations

import hashlib
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

from . import hand_model
from .capture_stream import StreamLimits
from .frames import FrameStream
from .hands import SEMANTICS, HandInferenceError, HandInferencer, HandObservation
from .jpeg_stream import JPEG_PROFILE

Sink = Callable[[HandObservation], None]


@dataclass
class Missingness:
    frames: int = 0
    frames_no_hand: int = 0
    frames_one_hand: int = 0
    frames_two_hands: int = 0
    hand_slots_present: int = 0
    joints_present: int = 0
    joints_masked_in_present_hands: int = 0
    joints_outside_raster: int = 0

    def add(self, obs: HandObservation) -> None:
        """Count one observation (shared with the SA-31 artifact exporter)."""
        self.frames += 1
        n = obs.hands_detected
        if n == 0:
            self.frames_no_hand += 1
        elif n == 1:
            self.frames_one_hand += 1
        else:
            self.frames_two_hands += 1
        self.hand_slots_present += n
        self.joints_present += int(obs.landmark_mask.sum())
        self.joints_masked_in_present_hands += int(
            (~obs.landmark_mask[obs.hand_present]).sum()
        )
        w, h = obs.transform.raster
        px = obs.image_landmarks_px
        outside = obs.landmark_mask & (
            (px[..., 0] < 0) | (px[..., 0] >= w) | (px[..., 1] < 0) | (px[..., 1] >= h)
        )
        self.joints_outside_raster += int(outside.sum())


@dataclass
class HandRunSummary:
    accepted: bool
    source_sha256: str
    source_bytes: int
    recording_id: str | None
    video_messages: int
    frames_decoded: int
    frames_inferred: int
    decoder_instances: int
    raster: tuple[int, int] | None
    missingness: Missingness
    inference_ms_mean: float
    inference_ms_max: float
    observations_sha256: str
    model: dict[str, Any]
    semantics: dict[str, Any] = field(default_factory=lambda: dict(SEMANTICS))
    metric_accuracy_validated: bool = False
    source_profile: str | None = None


def run_hand_inference(
    raw: BinaryIO,
    sink: Sink,
    *,
    model: str | Path | None = None,
    limits: StreamLimits | None = None,
    source_profile: str | None = None,
) -> HandRunSummary:
    verified = hand_model.resolve_model(model)  # hash-checked BEFORE any inference
    stream = FrameStream(raw, limits, source_profile=source_profile)
    miss = Missingness()
    digest = hashlib.sha256()
    total_ms = max_ms = 0.0
    raster: tuple[int, int] | None = None
    with HandInferencer(verified) as inferencer:
        for frame in stream:
            obs = inferencer.infer(frame)
            raster = obs.transform.raster
            miss.add(obs)
            obs.digest_into(digest)
            total_ms += obs.inference_ms
            max_ms = max(max_ms, obs.inference_ms)
            sink(obs)
        frames_inferred = inferencer.frames_inferred
    # Acceptance gate: footer/CRC/SHA/Close and decoder final success, after all inference.
    report = stream.require_accepted()
    stats = stream.decode_stats
    if stats is None or frames_inferred != stats.frames_out:
        raise HandInferenceError("E_INFERENCE_COUNT", (frames_inferred, stats))
    return HandRunSummary(
        accepted=True,
        source_sha256=report.source.sha256,
        source_bytes=report.source.bytes_read,
        recording_id=report.recording_id,
        video_messages=report.video_messages,
        frames_decoded=stats.frames_out,
        frames_inferred=frames_inferred,
        decoder_instances=stats.decoder_instances,
        raster=raster,
        missingness=miss,
        inference_ms_mean=total_ms / frames_inferred if frames_inferred else 0.0,
        inference_ms_max=max_ms,
        observations_sha256=digest.hexdigest(),
        model={**hand_model.provenance(), "verified_sha256": verified.sha256},
        source_profile=(report.profile or {}).get("rgb_profile"),
    )


def main(argv: list[str] | None = None) -> int:
    """`python -m stateaction_processing.hand_stream SOURCE.mcap [--model PATH]` -> JSON summary."""
    import argparse
    import dataclasses
    import json

    p = argparse.ArgumentParser(description=main.__doc__)
    p.add_argument("source", type=Path)
    p.add_argument("--model", type=Path, default=None)
    p.add_argument("--expected-sha256", default=None)
    p.add_argument(
        "--source-profile",
        choices=("h264_mcap_v1", "h264_mcap_simulation_v1", JPEG_PROFILE),
    )
    a = p.parse_args(argv)
    try:
        with a.source.open("rb") as raw:
            summary = run_hand_inference(
                raw, lambda _o: None, model=a.model, source_profile=a.source_profile
            )
    except Exception as e:
        code = getattr(e, "code", type(e).__name__)
        print(f"hand inference failed: {code}", file=sys.stderr)
        return 2
    if a.expected_sha256 and a.expected_sha256 != summary.source_sha256:
        print("hand inference failed: E_SOURCE_SHA_MISMATCH", file=sys.stderr)
        return 2
    print(
        json.dumps(dataclasses.asdict(summary), indent=2, sort_keys=True, default=str)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
