"""Stub segmenter and captioner with failure injection. LOCAL ONLY: never a model result.

Deterministic synthetic output for CI, local runs and controller tests at zero cost. Each injected
fault yields the truthful contract state, never an empty success:

segment params   segment_s (seconds, int or decimal string, default 10), fail_windows ("1,3"),
                 zero_segments, crash_after_n, hang / hang_s, digest_mismatch
caption params   fail_captions ("0,2": row ordinals), crash_after_n, hang / hang_s

* fail_windows / fail_captions: failed rows with `error_code` (never empty text).
* zero_segments: a valid document with no rows and every window ok.
* crash_after_n: `os._exit(CRASH_EXIT)` after n windows/captions, so no receipt exists.
* hang: sleeps (heartbeating) for `hang_s` seconds so budget and deadline tests can fire. With
  `hang_release_file` (a path) it also ends as soon as that file exists, so a test can hold a stage
  open until it has observed a controller re-entry and release it deterministically.
* digest_mismatch (segment): the receipt reports a different sha256 for segments.json than the file
  uploaded, so the caption stage, which pins the digest it was given, must reject it.
"""

from __future__ import annotations

import os
import time
from decimal import Decimal, InvalidOperation
from typing import Any

from ..stage_docs import (
    CaptionOutcome,
    FailedWindow,
    ModuleOutput,
    ProducerFacts,
    Span,
    StageContext,
    StageError,
    captions_document,
    segments_document,
)

CRASH_EXIT = 86
_FACTS = ProducerFacts(engine_version="1")
_MAX_HANG_S = 86400


def _index_set(value: Any) -> set[int]:
    if value in (None, ""):
        return set()
    try:
        return {int(p) for p in str(value).split(",") if p.strip()}
    except ValueError:
        raise StageError("stub_param_invalid") from None


def _segment_seconds(params: dict[str, Any]) -> Decimal:
    try:
        seconds = Decimal(str(params.get("segment_s", 10)))
    except InvalidOperation:
        raise StageError("stub_param_invalid") from None
    if not Decimal("0.05") <= seconds <= 3600:
        raise StageError("stub_param_invalid")
    return seconds


def _maybe_hang(ctx: StageContext, phase: str) -> None:
    if ctx.params.get("hang") is not True:
        return
    hang_s = min(int(ctx.params.get("hang_s", 3600)), _MAX_HANG_S)
    end = time.monotonic() + hang_s
    release = ctx.params.get("hang_release_file")
    while time.monotonic() < end:
        if isinstance(release, str) and os.path.exists(release):
            return
        ctx.beat(phase, 0)
        time.sleep(min(1.0, max(0.0, end - time.monotonic())))


def _maybe_crash(ctx: StageContext, done: int) -> None:
    n = ctx.params.get("crash_after_n")
    if isinstance(n, int) and not isinstance(n, bool) and done >= n:
        ctx.log(f"injected crash after {done}")
        os._exit(CRASH_EXIT)


def run_segment(ctx: StageContext) -> ModuleOutput:
    frames = ctx.frames
    total_frames = len(frames)
    step = _segment_seconds(ctx.params)
    fail = _index_set(ctx.params.get("fail_windows"))
    bounds: list[tuple[int, int]] = []
    k = 0
    while True:
        start = frames.index_at_or_after(float(step * k))
        if start >= total_frames:
            break
        end = min(frames.index_at_or_after(float(step * (k + 1))), total_frames)
        if end > start:
            bounds.append((start, end))
        k += 1
    _maybe_hang(ctx, "segmenting")
    spans: list[Span] = []
    failed: list[FailedWindow] = []
    windows_rows: list[dict[str, Any]] = []
    for index, (start, end) in enumerate(bounds):
        ctx.beat("segmenting", end)
        bad = index in fail
        windows_rows.append(
            {
                "window_index": index,
                "start_frame": start,
                "end_frame_exclusive": end,
                "status": "failed" if bad else "ok",
                "error_code": "injected_window_failure" if bad else None,
            }
        )
        if bad:
            failed.append(FailedWindow(index, "injected_window_failure", start, end))
        elif ctx.params.get("zero_segments") is not True:
            spans.append(Span(start, end, "ok", {"stub": {"window_index": index}}))
        _maybe_crash(ctx, index + 1)
    document = segments_document(ctx, ctx.producer(_FACTS), spans, len(bounds), failed)
    return ModuleOutput(
        document=document,
        counts={
            "frames": total_frames,
            "windows": len(bounds),
            "failed_windows": len(failed),
            "segments": len(spans),
        },
        windows_rows=windows_rows,
        tamper_receipt_digest=ctx.params.get("digest_mismatch") is True,
    )


def run_caption(ctx: StageContext) -> ModuleOutput:
    if ctx.segments is None:
        raise StageError("segments_missing")
    fail = _index_set(ctx.params.get("fail_captions"))
    _maybe_hang(ctx, "captioning")
    outcomes: list[CaptionOutcome] = []
    for row in ctx.segments["rows"]:
        ordinal = row["ordinal"]
        ctx.beat("captioning", len(outcomes))
        if row["status"] != "ok":
            outcomes.append(
                CaptionOutcome(
                    row["segment_id"], "not_captioned", "segment_failed_window"
                )
            )
        elif ordinal in fail:
            outcomes.append(
                CaptionOutcome(row["segment_id"], "failed", "injected_caption_failure")
            )
        else:
            text = f"pick up object {ordinal} with right hand, place object {ordinal} on table"
            outcomes.append(CaptionOutcome(row["segment_id"], "complete", text=text))
        _maybe_crash(ctx, len(outcomes))
    document = captions_document(ctx, ctx.producer(_FACTS), outcomes)
    statuses = [r["status"] for r in document["rows"]]
    return ModuleOutput(
        document=document,
        counts={
            "captions": statuses.count("complete"),
            "failed_captions": statuses.count("failed"),
            "not_captioned": statuses.count("not_captioned"),
        },
    )
