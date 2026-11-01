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
    ("F", 2),  # hand_detected
    ("F", 2),  # handedness_score
    ("F", 2),  # handedness: int8 0 left, 1 right, -1 none
    ("F",),  # frame_index
)
ACTIVE = ("preflight", "recording", "finalizing")
FINAL_OUTCOMES = ("completed", "interrupted")
RECOVERABLE = ("finalizing", "recovery_required")


def _instant(value: str) -> str:
    """RFC 3339 UTC (schema-validated) to a fixed-width key with 9 fraction digits."""
    fraction = value[20:-1] if len(value) > 20 else ""
    return value[:19] + fraction.ljust(9, "0")


def _count(items: list[Any], role: str, required: bool | None = None) -> int:
    return sum(
        1
        for f in items
        if f["role"] == role and (required is None or f["required"] is required)
    )


def check_sealed_inventory(seal: Any, declaration: Any) -> Violation:
    """Seal == declaration files + one source_manifest entry; paths into the declaration."""
    sealed = [f for f in seal["files"] if f["role"] != "source_manifest"]
    declared = declaration["files"]
    if len(declared) != len(sealed):
        return ("inventory_incomplete", "/files")
    for i, file in enumerate(declared):
        match = next((f for f in sealed if f["fileId"] == file["file_id"]), None)
        if match is None:
            return ("inventory_incomplete", f"/files/{i}/file_id")
        for snake, camel in (
            ("role", "role"),
            ("size_bytes", "sizeBytes"),
            ("sha256", "sha256"),
            ("required", "required"),
        ):
            if not _same(match[camel], file[snake]):
                return ("reference_mismatch", f"/files/{i}/{snake}")
    return None


def _capture_snapshot(doc: Any, base: str) -> Violation:
    c = {k: int(v) for k, v in doc["counters"].items()}
    if c["videoFramesSubmitted"] > c["videoFramesAcquired"]:
        return ("progress_mismatch", f"{base}/counters/videoFramesSubmitted")
    if c["videoFramesWritten"] > c["videoFramesSubmitted"]:
        return ("progress_mismatch", f"{base}/counters/videoFramesWritten")
    if (
        c["videoFramesWritten"] + c["videoFramesDropped"] + c["videoFramesUnresolved"]
        > c["videoFramesAcquired"]
    ):
        return ("progress_mismatch", f"{base}/counters/videoFramesAcquired")
    state, container, outcome = (
        doc["state"],
        doc["containerState"],
        doc["captureOutcome"],
    )
    if state in ACTIVE:
        ok = (container is None, outcome is None)
    elif state == "finalized":
        ok = (container == "closed", outcome in FINAL_OUTCOMES)
    elif state == "recovery_required":
        ok = (container == "unclosed", outcome is None)
    else:  # quarantined
        ok = (container is not None, outcome == "failed")
    if not ok[0]:
        return ("outcome_mismatch", f"{base}/containerState")
    if not ok[1]:
        return ("outcome_mismatch", f"{base}/captureOutcome")
    return None


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


def sealed_inventory(doc: Any) -> Violation:
    files = doc["files"]
    if (
        _count(files, "source_manifest") != 1
        or _count(files, "source_manifest", True) != 1
        or _count(files, "source_mcap") != 1
        or _count(files, "source_mcap", True) != 1
        or _count(files, "recorder_metadata", True) < 1
    ):
        return ("inventory_incomplete", "/files")
    return None


def claim_grant(doc: Any) -> Violation:
    inputs = doc["inputs"]
    found = _duplicate(inputs, "fileId", "/inputs")
    if found:
        return found
    if _count(inputs, "source_manifest") != 1 or _count(inputs, "source_mcap") != 1:
        return ("inventory_incomplete", "/inputs")
    m = next(i for i, f in enumerate(inputs) if f["role"] == "source_manifest")
    if inputs[m]["sha256"] != doc["digests"]["sourceManifestSha256"]:
        return ("reference_mismatch", f"/inputs/{m}/sha256")
    if _instant(doc["startDeadline"]) > _instant(doc["executionDeadline"]):
        return ("ordering_violation", "/executionDeadline")
    return None


def result_candidate(doc: Any) -> Violation:
    summary = doc["summary"]
    if (summary["outcome"] == "succeeded") != (summary["errorCode"] is None):
        return ("outcome_mismatch", "/summary/errorCode")
    return None


def capture_snapshot(doc: Any) -> Violation:
    return _capture_snapshot(doc, "")


def capture_recoverable(doc: Any) -> Violation:
    captures = doc["captures"]
    found = _duplicate(captures, "clientRecordingId", "/captures")
    if found:
        return found
    for i, capture in enumerate(captures):
        found = _capture_snapshot(capture, f"/captures/{i}")
        if found:
            return found
        if capture["state"] not in RECOVERABLE:
            return ("outcome_mismatch", f"/captures/{i}/state")
    return None


def capture_capabilities(doc: Any) -> Violation:
    accepted = doc["outcome"] == "accepted"
    if accepted != (doc["acceptedProfile"] is not None):
        return ("outcome_mismatch", "/acceptedProfile")
    if accepted != (len(doc["unsupportedReasons"]) == 0):
        return ("outcome_mismatch", "/unsupportedReasons")
    return None


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
    # The declaration is the source_manifest file; it never lists itself.
    for i, f in enumerate(files):
        if f["role"] == "source_manifest":
            return ("reference_mismatch", f"/files/{i}/role")
    if (
        _count(files, "source_mcap") != 1
        or _count(files, "source_mcap", True) != 1
        or _count(files, "recorder_metadata", True) < 1
    ):
        return ("inventory_incomplete", "/files")
    domains = doc["clock_domains"]
    for i, channel in enumerate(doc["channels"]):
        if channel["clock_domain"] not in domains:
            return ("reference_mismatch", f"/channels/{i}/clock_domain")
    return None


def frame_map(doc: Any) -> Violation:
    rows = doc["rows"]
    found = _duplicate(rows, "source_frame_id", "/rows")
    if found:
        return found
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
    found = (
        _duplicate(doc["verified_sources"], "file_id", "/verified_sources")
        or _duplicate(outputs, "file_id", "/outputs")
        or _duplicate(outputs, "relative_path", "/outputs")
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
    claimed: set[object] = set()
    for i, clip in enumerate(clips):
        p = f"/clips/{i}"
        if not _same(clip["clip_ordinal"], i):
            return ("ordering_violation", f"{p}/clip_ordinal")
        for key, role in OUTPUT_ROLE.items():
            if roles.get(clip["files"][key]) != role:
                return ("reference_mismatch", f"{p}/files/{key}")
        # Each output file belongs to exactly one clip.
        for key in OUTPUT_ROLE:
            if clip["files"][key] in claimed:
                return ("duplicate_identity", f"{p}/files/{key}")
            claimed.add(clip["files"][key])
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
    "sealed_inventory": sealed_inventory,
    "claim_grant": claim_grant,
    "result_candidate": result_candidate,
    "capture_snapshot": capture_snapshot,
    "capture_recoverable": capture_recoverable,
    "capture_capabilities": capture_capabilities,
    "unique_part_numbers": unique_part_numbers,
    "upload_plan": upload_plan,
    "heartbeat_progress": heartbeat_progress,
    "recording_source": recording_source,
    "frame_map": frame_map,
    "hand_observations": hand_observations,
    "processing_result": processing_result,
}
