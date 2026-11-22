"""FLORA-native output -> `segments.v1` / `captions.v1` rows (shared by replay and the T09 modules).

FLORA TempSeg reports spans as MP4 frame indices (`start_frame`, `end_frame_exclusive`) and failed
windows in seconds relative to the first frame; the Captioner reports one row per FLORA segment id.
The remux frame map turns those into the contracts' `source_frame_id` / `timestamp_ns` references.
Nothing is repaired: a span outside the recording, a failed window without frames or a caption
without a matching segment is an error or a failed row, never an invented value. The derived label
fields come from `caption_rule@1` (`caption_rule.py`), applied only to complete caption text.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .stage_docs import CaptionOutcome, FailedWindow, Span, StageContext, StageError

_CODE = re.compile(r"[^a-z0-9_]+")
_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def code_of(value: object, default: str = "flora_error") -> str:
    """A contract error code (`^[a-z][a-z0-9_]{0,63}$`) from a FLORA status or error string."""
    text = _CODE.sub("_", str(value).lower()).strip("_")[:64]
    if not text:
        return default
    return text if text[0].isalpha() else f"flora_{text}"[:64]


def flat_params(value: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    """Flatten a nested FLORA settings dict into a flat scalar map (fractions as strings)."""
    out: dict[str, Any] = {}
    for key, item in value.items():
        name = f"{prefix}{code_of(key)}"
        if isinstance(item, dict):
            out.update(flat_params(item, f"{name}_"))
        elif isinstance(item, bool) or item is None or isinstance(item, int):
            out[name] = item
        elif isinstance(item, (float, str)):
            out[name] = str(item)[:256]
    return {k: v for k, v in out.items() if _KEY.match(k)}


def segments_from_flora(
    ctx: StageContext, native: dict[str, Any], replayed_from: dict[str, Any]
) -> tuple[list[Span], int, list[FailedWindow]]:
    """Spans, window total and failed windows of a FLORA `segments.json` document."""
    frames = ctx.frames
    total = len(frames)
    spans: list[Span] = []
    cursor = 0
    for seg in native["segments"]:
        start, end = seg["start_frame"], seg["end_frame_exclusive"]
        if not (
            isinstance(start, int)
            and isinstance(end, int)
            and 0 <= start < end <= total
        ):
            raise StageError("replay_segment_out_of_range")
        # segments.v1 rows must not overlap, but FLORA's stitched segments can (real output has
        # 1.5 s overlaps at window seams). The later segment starts where the previous one ended;
        # the native span stays in ext. A segment fully covered by its predecessor is an error:
        # dropping it would silently lose a model result.
        first = max(start, cursor)
        if first >= end:
            raise StageError("replay_segment_overlap_unresolvable")
        cursor = end
        spans.append(
            Span(
                first,
                end,
                "ok",
                {
                    "flora": {
                        "id": seg["id"],
                        "provenance": str(seg.get("provenance", "")),
                        "stitched": bool(seg.get("stitched", False)),
                        "crosses_core_boundary": bool(
                            seg.get("crosses_core_boundary", False)
                        ),
                        "native_start_frame": start,
                        "native_end_frame_exclusive": end,
                        "trimmed_start": first != start,
                    },
                    "replayed_from": replayed_from,
                },
            )
        )
    windows = native["windows"]
    failed: list[FailedWindow] = []
    for item in windows.get("failed", []):
        start = frames.index_at_or_after(item["start_s"])
        end = min(frames.index_at_or_after(item["end_s"]), total)
        if start >= end:
            raise StageError("replay_failed_window_without_frames")
        failed.append(
            FailedWindow(
                int(item["window_index"]), code_of(item.get("error_code")), start, end
            )
        )
    return spans, int(windows["total"]), failed


def captions_from_flora(
    ctx: StageContext, native: dict[str, Any]
) -> list[CaptionOutcome]:
    """One outcome per segment row of the captioned segments document."""
    if ctx.segments is None:
        raise StageError("segments_missing")
    by_id: dict[int, dict[str, Any]] = {}
    for item in native["captions"]:
        if item["segment_id"] in by_id:
            raise StageError("replay_caption_duplicate")
        by_id[item["segment_id"]] = item
    outcomes: list[CaptionOutcome] = []
    used = 0
    for row in ctx.segments["rows"]:
        if row["status"] != "ok":
            outcomes.append(
                CaptionOutcome(
                    row["segment_id"], "not_captioned", "segment_failed_window"
                )
            )
            continue
        flora = row["ext"].get("flora")
        if not isinstance(flora, dict) or "id" not in flora:
            raise StageError("replay_segments_not_flora")
        item = by_id.get(flora["id"])
        if item is None:
            outcomes.append(
                CaptionOutcome(row["segment_id"], "failed", "replay_caption_missing")
            )
            continue
        used += 1
        status = item.get("status")
        if status == "complete":
            outcomes.append(
                CaptionOutcome(
                    row["segment_id"], "complete", text=item.get("caption") or ""
                )
            )
        else:
            outcomes.append(
                CaptionOutcome(row["segment_id"], "failed", code_of(status))
            )
    if used != len(by_id):
        raise StageError("replay_caption_without_segment")
    return outcomes


def canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()
