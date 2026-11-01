"""Cross-field rules; same order, codes and paths as packages/contracts/src/rules.ts."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

Violation = tuple[str, str] | None
PART_SIZE = 67108864
OUTPUT_ROLE = {
    "rgb_mp4": "clip_mp4",
    "hand_arrays_npz": "hand_arrays_npz",
    "hand_observations_json": "hand_observations_json",
    "frame_map_json": "frame_map_json",
    "thumbnail_jpeg": "thumbnail_jpeg",
    "viewer_rrd": "viewer_rrd",
}
HAND_ARRAY_SHAPES: tuple[tuple[int | str, ...], ...] = (
    ("F", 2, 21, 2),
    ("F", 2, 21),
    ("F", 2, 21, 3),
    ("F", 2, 21),
    ("F", 2),
    ("F", 2),
    ("F",),
)


def _same(a: object, b: object) -> bool:
    """JSON equality: booleans never equal numbers."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


def _duplicate(items: list[Any], key: str, base: str) -> Violation:
    seen: list[object] = []
    for i, item in enumerate(items):
        value = item[key]
        if any(_same(value, s) for s in seen):
            return ("duplicate_identity", f"{base}/{i}/{key}")
        seen.append(value)
    return None


def _masks(points: list[Any], mask: list[Any], path: str) -> Violation:
    for j, flag in enumerate(mask):
        if (points[j] is not None) != flag:
            return ("mask_mismatch", f"{path}/{j}")
    return None


def unique_file_ids(doc: Any) -> Violation:
    return _duplicate(doc["files"], "fileId", "/files")


def unique_part_numbers(doc: Any) -> Violation:
    return _duplicate(doc["receipts"], "partNumber", "/receipts")


def upload_plan(doc: Any) -> Violation:
    parts = -(-int(doc["sizeBytes"]) // PART_SIZE)
    return (
        None if _same(doc["partCount"], parts) else ("part_plan_mismatch", "/partCount")
    )


def heartbeat_progress(doc: Any) -> Violation:
    total = doc.get("totalFrames")
    if (
        "processedFrames" in doc
        and total is not None
        and int(doc["processedFrames"]) > int(total)
    ):
        return ("progress_mismatch", "/processedFrames")
    return None


def recording_source(doc: Any) -> Violation:
    files = doc["files"]
    found = _duplicate(files, "file_id", "/files")
    if found:
        return found

    def required(role: str) -> int:
        return sum(1 for f in files if f["role"] == role and f["required"] is True)

    if required("source_mcap") != 1 or required("recorder_metadata") < 1:
        return ("inventory_incomplete", "/files")
    domains = doc["clock_domains"]
    for i, channel in enumerate(doc["channels"]):
        if channel["clock_domain"] not in domains:
            return ("reference_mismatch", f"/channels/{i}/clock_domain")
    return None


def frame_map(doc: Any) -> Violation:
    rows = doc["rows"]
    if len(rows) != doc["frame_count"]:
        return ("dimension_mismatch", "/rows")
    first = rows[0]
    for i, row in enumerate(rows):
        p = f"/rows/{i}"
        if not _same(row["frame_index"], i):
            return ("ordering_violation", f"{p}/frame_index")
        if row["clock_domain"] != first["clock_domain"]:
            return ("clock_mismatch", f"{p}/clock_domain")
        if i > 0:
            prev = rows[i - 1]
            if int(row["timestamp_ns"]) <= int(prev["timestamp_ns"]):
                return ("ordering_violation", f"{p}/timestamp_ns")
            if int(row["source_pts"]) <= int(prev["source_pts"]):
                return ("ordering_violation", f"{p}/source_pts")
        if int(row["clip_pts"]) != int(row["source_pts"]) - int(first["source_pts"]):
            return ("clock_mismatch", f"{p}/clip_pts")
        raster, crop = row["raster"], row["transform"]["crop"]
        if (
            crop["x"] + crop["width"] > raster["width"]
            or crop["y"] + crop["height"] > raster["height"]
        ):
            return ("dimension_mismatch", f"{p}/transform/crop")
    return None


def hand_observations(doc: Any) -> Violation:
    frames = doc["frames"]
    if len(frames) != doc["frame_count"]:
        return ("dimension_mismatch", "/frames")
    for i, frame in enumerate(frames):
        p = f"/frames/{i}"
        if not _same(frame["frame_index"], i):
            return ("ordering_violation", f"{p}/frame_index")
        found = _duplicate(frame["hands"], "hand_index", f"{p}/hands")
        if found:
            return found
        for j, hand in enumerate(frame["hands"]):
            h = f"{p}/hands/{j}"
            found = _masks(
                hand["image_landmarks_px"], hand["image_mask"], f"{h}/image_mask"
            )
            if found:
                return found
            points = hand["points_3d"]
            found = _masks(points["joints"], points["mask"], f"{h}/points_3d/mask")
            if found:
                return found
    return None


def processing_result(doc: Any) -> Violation:
    outputs = doc["outputs"]
    found = _duplicate(outputs, "file_id", "/outputs") or _duplicate(
        outputs, "relative_path", "/outputs"
    )
    if found:
        return found
    for i, output in enumerate(outputs):
        if output["role"] == "result_manifest":
            return ("reference_mismatch", f"/outputs/{i}/role")
    roles = {o["file_id"]: o["role"] for o in outputs}
    clips = doc["clips"]
    found = _duplicate(clips, "clip_id", "/clips")
    if found:
        return found
    for i, clip in enumerate(clips):
        p = f"/clips/{i}"
        if not _same(clip["clip_ordinal"], i):
            return ("ordering_violation", f"{p}/clip_ordinal")
        for key, role in OUTPUT_ROLE.items():
            if roles.get(clip["files"][key]) != role:
                return ("reference_mismatch", f"{p}/files/{key}")
        start, end = int(clip["source_start_ns"]), int(clip["source_end_ns"])
        if end < start:
            return ("clock_mismatch", f"{p}/source_end_ns")
        if int(clip["duration_ns"]) != end - start:
            return ("clock_mismatch", f"{p}/duration_ns")
        arrays = clip["hand_arrays"]["arrays"]
        for k, expected in enumerate(HAND_ARRAY_SHAPES):
            shape = arrays[k]["shape"]
            want = [clip["frame_count"] if d == "F" else d for d in expected]
            if any(not _same(shape[d], w) for d, w in enumerate(want)):
                return ("dimension_mismatch", f"{p}/hand_arrays/arrays/{k}/shape")
    return None


RULES: dict[str, Callable[[Any], Violation]] = {
    "unique_file_ids": unique_file_ids,
    "unique_part_numbers": unique_part_numbers,
    "upload_plan": upload_plan,
    "heartbeat_progress": heartbeat_progress,
    "recording_source": recording_source,
    "frame_map": frame_map,
    "hand_observations": hand_observations,
    "processing_result": processing_result,
}
