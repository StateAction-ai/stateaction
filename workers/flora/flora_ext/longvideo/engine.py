"""Vendor engine with a larger retry budget, plus run-wise stitching for failure isolation."""

from dataclasses import replace

from .. import bootstrap
from ..config import MODELS

a = bootstrap.production
RETRY_BUDGET_VENDOR_MAX = 64  # fine_subtask.py:24 ADAPTIVE_FINE_RETRY_HARD_MAX_WINDOWS

QUALITY_POLICY = {
    "drop_guard_only_segments": True,
    "hard_max_overlap_depth": 3,
    "hard_max_segments_per_window": 23,
    "max_adjacent_matching_ambiguities": 0,
    "require_event_when_coarse_present": True,
    "schema_version": "subtask_annotation_atomic_fine_quality_policy_v1",
    "soft_max_segments_per_window": 12,
}


def make_binding(pool):
    return dict(
        candidate_id="flora_final",
        checkpoint_sha256=MODELS["tempseg"]["sha256"],
        model_io_contract=a.fine_window_profile(a.PROFILES[pool]).model_io_contract,
    )


def build_engine(predictor, bound, pool, retry_budget=RETRY_BUDGET_VENDOR_MAX):
    """Copy of vendor `production_segmenter` with a configurable retry budget (<= 64)."""
    fine = a.FineSubtaskSegmenter(
        predictor=predictor,
        model_binding=bound,
        profile_id="human_ego_atomic_v0_2",
        window_profile_id=a.PROFILES[pool],
        fail_on_unresolved=True,
        batch_concurrency=1,
        unresolved_stitch_tolerance_ticks=2,
        quality_policy=a.FineSegmentationQualityPolicy.from_value(QUALITY_POLICY),
    )
    return a.HierarchicalSubtaskSegmenter(
        coarse_segmenter=a.NoCoarse(),
        fine_segmenter=fine,
        fine_prior_mode="none",
        fine_failure_policy="adaptive_fine_then_conservative_completion",
        fine_output_coverage_policy="allow_gaps",
        adaptive_fine_retry_max_windows=retry_budget,
    )


def good_runs(windows, ok_flags):
    """Maximal runs of consecutive ok windows -> list of lists of windows."""
    runs, cur = [], []
    for w, ok in zip(windows, ok_flags, strict=True):
        if ok:
            cur.append(w)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return runs


def stitch_runs(windows, rows, duration_s):
    """Stitch each run of good windows separately with the vendor stitcher.

    Windows are renumbered 0..k-1 inside a run (the vendor demands a complete
    zero-based sequence) while keeping their true view start, so tick offsets
    stay global. Returns (segments, unresolved) as dicts.
    """
    from flora_runtime.video_segmentation.fine_temporal import (
        TICK_US,
        parse_prediction_with_diagnostics,
        stitch_predictions,
    )

    ok = [r["status"] == "ok" for r in rows]
    segments, unresolved = [], []
    for run in good_runs(windows, ok):
        local = [replace(w, window_index=i) for i, w in enumerate(run)]
        frags = {}
        for lw, w in zip(local, run, strict=True):
            row = rows[w.window_index]
            frags[lw.window_index] = parse_prediction_with_diagnostics(
                row["prediction_json"], lw, drop_guard_only=True
            ).fragments
        result = stitch_predictions(local, frags)
        for e in result.events:
            segments.append(
                dict(
                    start_s=e.span.start_s,
                    end_s=min(e.span.end_s, duration_s),
                    scope_ids=list(e.source_scope_ids),
                    provenance="run_stitch",
                )
            )
        for u in result.unresolved:
            unresolved.append(
                dict(
                    support_start_s=u.support_start_tick * TICK_US / 1e6,
                    support_end_s=u.support_end_tick * TICK_US / 1e6,
                    scope_ids=list(u.source_scope_ids),
                )
            )
    segments.sort(key=lambda s: (s["start_s"], s["end_s"]))
    return segments, unresolved
