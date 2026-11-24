"""Cross-field rules; same order, codes and paths as packages/contracts/src/rules.ts."""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from functools import cache
from typing import Any

from .canonical import request_sha256

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
    if state == "finalized":
        # A clean finalized take has no unresolved frames and every acquired
        # frame is accounted for as written or dropped.
        if c["videoFramesUnresolved"] != 0:
            return ("progress_mismatch", f"{base}/counters/videoFramesUnresolved")
        if (
            c["videoFramesWritten"] + c["videoFramesDropped"]
            != c["videoFramesAcquired"]
        ):
            return ("progress_mismatch", f"{base}/counters/videoFramesAcquired")
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


# ---------------------------------------------------------------- SA-87 stage contracts


@cache
def _modules() -> dict[str, Any]:
    """The committed module manifest (api/modules.json, jobs.module-manifest.v1)."""
    from .validate import _api_dir

    with open(_api_dir() / "modules.json", "rb") as file:
        manifest = json.load(file)
    return {f"{m['moduleId']}@{m['version']}": m for m in manifest["modules"]}


STAGE_ROLES: dict[str, tuple[str, ...]] = {
    "segment": ("segments_json", "diagnostic_blob"),
    "caption": ("captions_json", "diagnostic_blob"),
    "hand_pose": (
        "clip_mp4",
        "hand_arrays_npz",
        "hand_observations_json",
        "frame_map_json",
        "thumbnail_jpeg",
        "viewer_rrd",
        "hand_presence_json",
        "recording_mp4",
        "diagnostic_blob",
    ),
}
PRIMARY_ROLES: dict[str, tuple[str, ...]] = {
    "segment": ("segments_json",),
    "caption": ("captions_json",),
    "hand_pose": ("hand_presence_json", "recording_mp4"),
}
CODED_STATES = ("failed", "cancelled", "not_run")
STAGE_ORDER = ("segment", "caption", "hand_pose")
# uuid5(NAMESPACE_URL, "https://stateaction.ai/schemas/artifacts/segments.v1.json")
SEGMENT_ID_NAMESPACE = uuid.UUID("a505457d-7470-5704-b995-1b3d1e3638df")


def segment_id(
    source_manifest_sha256: str,
    module_ref: str,
    params_sha256: str,
    start_frame_id: str,
    end_frame_id: str | None,
) -> str:
    """UUIDv5 of source, module@version, params digest and start/end frame IDs."""
    name = "|".join(
        [
            source_manifest_sha256,
            module_ref,
            params_sha256,
            start_frame_id,
            end_frame_id if end_frame_id is not None else "end",
        ]
    )
    return str(uuid.uuid5(SEGMENT_ID_NAMESPACE, name))


def _is_end(ref: Any) -> bool:
    return ref["source_frame_id"] is None


def _before(a: Any, b: Any) -> bool:
    """Frame refs compare on identity and timestamp; a null end is end of stream."""
    if _is_end(b):
        return not _is_end(a)
    if _is_end(a):
        return False
    return int(a["source_frame_id"]) < int(b["source_frame_id"]) and int(
        a["timestamp_ns"]
    ) < int(b["timestamp_ns"])


def _at_or_before(a: Any, b: Any) -> bool:
    if _is_end(b):
        return True
    if _is_end(a):
        return False
    return int(a["source_frame_id"]) <= int(b["source_frame_id"]) and int(
        a["timestamp_ns"]
    ) <= int(b["timestamp_ns"])


def _same_ref(a: Any, b: Any) -> bool:
    return bool(
        a["source_frame_id"] == b["source_frame_id"]
        and a["timestamp_ns"] == b["timestamp_ns"]
    )


def _producer(doc: Any, stage: str) -> Violation:
    p = doc["producer"]
    if p["stage"] != stage:
        return ("reference_mismatch", "/producer/stage")
    if doc["schema"].endswith(".v2"):
        if p["module_id"] == f"imported_{stage}" and p["module_version"] == 1:
            return None
        return ("reference_mismatch", "/producer/module_id")
    module = _modules().get(f"{p['module_id']}@{int(p['module_version'])}")
    if module is None or module["stage"] != stage:
        return ("reference_mismatch", "/producer/module_id")
    if module["provenance"]["modelName"] != p["model_name"]:
        return ("reference_mismatch", "/producer/model_name")
    if module["provenance"]["engine"] != p["engine"]["name"]:
        return ("reference_mismatch", "/producer/engine/name")
    for name in module["provenance"]["requires"]:
        if name == "observed_gpu":
            value, path = p["gpu"]["observed_type"], "/producer/gpu/observed_type"
        else:
            value, path = p[name], f"/producer/{name}"
        if value is None:
            return ("reference_mismatch", path)
    if p["gpu"]["requested_type"] not in module["gpu"]["supported"]:
        return ("reference_mismatch", "/producer/gpu/requested_type")
    return None


def _recipe(doc: Any, base: str) -> Violation:
    stages = doc["stages"]
    if stages[1]["enabled"] is True and stages[0]["enabled"] is not True:
        return ("reference_mismatch", f"{base}/stages/1/enabled")
    for i, stage in enumerate(stages):
        module = _modules().get(stage["module"])
        if module is None or module["stage"] != stage["stage"]:
            return ("reference_mismatch", f"{base}/stages/{i}/module")
        if stage["resources"]["gpu"] not in module["gpu"]["supported"]:
            return ("reference_mismatch", f"{base}/stages/{i}/resources/gpu")
    return None


def _stage_receipt(doc: Any, base: str) -> Violation:
    if (doc["status"] == "succeeded") != (doc["errorCode"] is None):
        return ("outcome_mismatch", f"{base}/errorCode")
    outputs = doc["outputs"]
    found = _duplicate(outputs, "fileId", f"{base}/outputs")
    if found:
        return found
    allowed = STAGE_ROLES[doc["stage"]]
    for i, output in enumerate(outputs):
        if output["role"] not in allowed:
            return ("reference_mismatch", f"{base}/outputs/{i}/role")
    if doc["status"] == "succeeded" and doc["stage"] != "hand_pose":
        for role in PRIMARY_ROLES[doc["stage"]]:
            if sum(1 for o in outputs if o["role"] == role) != 1:
                return ("inventory_incomplete", f"{base}/outputs")
    if _instant(doc["finishedAt"]) < _instant(doc["startedAt"]):
        return ("ordering_violation", f"{base}/finishedAt")
    return None


_TRIM = re.compile(r"^[ \t]+|[ \t]+\Z")


def caption_steps(text: str) -> list[str]:
    """text split on commas, each step trimmed of spaces and tabs, empty steps dropped."""
    steps = (_TRIM.sub("", step) for step in text.split(","))
    return [step for step in steps if step]


def segments(doc: Any) -> Violation:
    found = _producer(doc, "segment")
    if found:
        return found
    windows = doc["windows"]
    failed, spans = windows["failed"], windows["failed_core_spans"]
    if windows["ok"] + len(failed) != windows["total"]:
        return ("progress_mismatch", "/windows/ok")
    found = _duplicate(failed, "window_index", "/windows/failed")
    if found:
        return found
    for i, span in enumerate(spans):
        p = f"/windows/failed_core_spans/{i}"
        if not _before(span["start"], span["end"]):
            return ("ordering_violation", f"{p}/end")
        if i > 0 and not _at_or_before(spans[i - 1]["end"], span["start"]):
            return ("ordering_violation", f"{p}/start")
    covered: set[int] = set()
    for i, window in enumerate(failed):
        start, end = window["core_start"], window["core_end"]
        if not _before(start, end):
            return ("ordering_violation", f"/windows/failed/{i}/core_end")
        k = next(
            (
                k
                for k, span in enumerate(spans)
                if _at_or_before(span["start"], start)
                and _at_or_before(end, span["end"])
            ),
            -1,
        )
        # A failed window must lie inside a recorded failed core span.
        if k < 0:
            return ("reference_mismatch", f"/windows/failed/{i}")
        covered.add(k)
    for i in range(len(spans)):
        if i not in covered:
            return ("reference_mismatch", f"/windows/failed_core_spans/{i}")
    rows = doc["rows"]
    producer = doc["producer"]
    module_ref = f"{producer['module_id']}@{int(producer['module_version'])}"
    seen: set[str] = set()
    for i, row in enumerate(rows):
        p = f"/rows/{i}"
        if not _same(row["ordinal"], i):
            return ("ordering_violation", f"{p}/ordinal")
        if row["segment_id"] in seen:
            return ("duplicate_identity", f"{p}/segment_id")
        seen.add(row["segment_id"])
        if not _before(row["start"], row["end"]):
            return ("ordering_violation", f"{p}/end")
        boundary = "start" if doc["schema"] == "stateaction.segments.v2" else "end"
        if i > 0 and not _at_or_before(rows[i - 1][boundary], row["start"]):
            return ("ordering_violation", f"{p}/start")
        expected = segment_id(
            doc["source_manifest_sha256"],
            module_ref,
            producer["params_sha256"],
            row["start"]["source_frame_id"],
            row["end"]["source_frame_id"],
        )
        if row["segment_id"] != expected:
            return ("reference_mismatch", f"{p}/segment_id")
    # Failed windows are rows too: failed_window rows equal the failed core spans, in order.
    k = 0
    for i, row in enumerate(rows):
        if row["status"] != "failed_window":
            continue
        if (
            k >= len(spans)
            or not _same_ref(spans[k]["start"], row["start"])
            or not _same_ref(spans[k]["end"], row["end"])
        ):
            return ("reference_mismatch", f"/rows/{i}/status")
        k += 1
    if k < len(spans):
        return ("reference_mismatch", f"/windows/failed_core_spans/{k}")
    return None


def captions(doc: Any) -> Violation:
    found = _producer(doc, "caption") or _duplicate(doc["rows"], "segment_id", "/rows")
    if found:
        return found
    for i, row in enumerate(doc["rows"]):
        if row["status"] == "complete" and row["derived"]["steps"] != caption_steps(
            row["text"]
        ):
            return ("reference_mismatch", f"/rows/{i}/derived/steps")
    return None


def hand_presence(doc: Any) -> Violation:
    found = _producer(doc, "hand_pose")
    if found:
        return found
    for side in ("left", "right"):
        base = f"/lanes/{side}"
        spans = doc["lanes"][side]
        frames = 0
        for i, span in enumerate(spans):
            p = f"{base}/{i}"
            if not _before(span["start"], span["end"]):
                return ("ordering_violation", f"{p}/end")
            if i > 0:
                prev = spans[i - 1]
                if not _same_ref(prev["end"], span["start"]):
                    return ("ordering_violation", f"{p}/start")
                if prev["state"] == span["state"]:
                    return ("ordering_violation", f"{p}/state")
            frames += span["frames"]
        last = len(spans) - 1
        if not _is_end(spans[last]["end"]):
            return ("dimension_mismatch", f"{base}/{last}/end")
        if frames != doc["frame_count"]:
            return ("dimension_mismatch", base)
    return None


def recipe(doc: Any) -> Violation:
    return _recipe(doc, "")


def module_manifest(doc: Any) -> Violation:
    seen: set[str] = set()
    for i, module in enumerate(doc["modules"]):
        p = f"/modules/{i}"
        ref = f"{module['moduleId']}@{int(module['version'])}"
        if ref in seen:
            return ("duplicate_identity", f"{p}/version")
        seen.add(ref)
        if module["gpu"]["minimum"] not in module["gpu"]["supported"]:
            return ("reference_mismatch", f"{p}/gpu/minimum")
        allowed = STAGE_ROLES[module["stage"]]
        for j, role in enumerate(module["outputs"]):
            if role not in allowed:
                return ("reference_mismatch", f"{p}/outputs/{j}")
    return None


def task_input_recipe(doc: Any) -> Violation:
    if doc["kind"] != "process_recording":
        return None
    found = _recipe(doc["recipe"], "/recipe")
    if found:
        return found
    if request_sha256(doc["recipe"]) != doc["recipeSha256"]:
        return ("reference_mismatch", "/recipeSha256")
    return None


def processing_result_nodes(doc: Any) -> Violation:
    outputs = doc["outputs"]
    roles = {o["file_id"]: o["role"] for o in outputs}
    claimed: set[str] = set()
    for i, node in enumerate(doc["nodes"]):
        p = f"/nodes/{i}"
        if (node["status"] == "succeeded") != (node["error_code"] is None):
            return ("outcome_mismatch", f"{p}/error_code")
        if node["status"] == "not_run" and node["outputs"]:
            return ("outcome_mismatch", f"{p}/outputs")
        allowed = STAGE_ROLES[node["stage"]]
        node_roles: list[str] = []
        for j, file_id in enumerate(node["outputs"]):
            role = roles.get(file_id)
            if role is None or role not in allowed:
                return ("reference_mismatch", f"{p}/outputs/{j}")
            if file_id in claimed:
                return ("duplicate_identity", f"{p}/outputs/{j}")
            claimed.add(file_id)
            node_roles.append(role)
        if node["status"] == "succeeded":
            for role in PRIMARY_ROLES[node["stage"]]:
                if node_roles.count(role) != 1:
                    return ("inventory_incomplete", f"{p}/outputs")
    for k, output in enumerate(outputs):
        if output["file_id"] not in claimed:
            return ("reference_mismatch", f"/outputs/{k}/file_id")
    return None


def heartbeat_stage(doc: Any) -> Violation:
    if (doc["phase"] == "segmenting" and doc["stage"] != "segment") or (
        doc["phase"] == "captioning" and doc["stage"] != "caption"
    ):
        return ("reference_mismatch", "/phase")
    return None


def stage_receipt(doc: Any) -> Violation:
    return _stage_receipt(doc, "")


def stage_run_action(doc: Any) -> Violation:
    if doc["action"] != "record_stage_run":
        return None
    state = doc["state"]
    if ("errorCode" in doc) != (state in CODED_STATES):
        return ("outcome_mismatch", "/errorCode")
    terminal = state in ("succeeded", "failed")
    if (not terminal) if "receipt" in doc else state == "succeeded":
        return ("outcome_mismatch", "/receipt")
    if "receipt" not in doc:
        return None
    receipt = doc["receipt"]
    if receipt["stage"] != doc["stage"]:
        return ("reference_mismatch", "/receipt/stage")
    if receipt["module"] != doc["module"]:
        return ("reference_mismatch", "/receipt/module")
    if receipt["status"] != state:
        return ("outcome_mismatch", "/receipt/status")
    return _stage_receipt(receipt, "/receipt")


def dag_run(doc: Any) -> Violation:
    for i, node in enumerate(doc["stages"]):
        p = f"/stages/{i}"
        if i >= len(STAGE_ORDER) or node["stage"] != STAGE_ORDER[i]:
            return ("ordering_violation", f"{p}/stage")
        state = node["state"]
        if node["enabled"] is not True and state != "not_run":
            return ("outcome_mismatch", f"{p}/state")
        if (state in CODED_STATES) != (node["errorCode"] is not None):
            return ("outcome_mismatch", f"{p}/errorCode")
        if state == "succeeded" and node["receiptSha256"] is None:
            return ("outcome_mismatch", f"{p}/receiptSha256")
        if (
            node["startedAt"] is not None
            and node["finishedAt"] is not None
            and _instant(node["finishedAt"]) < _instant(node["startedAt"])
        ):
            return ("ordering_violation", f"{p}/finishedAt")
    return None


def recording_annotations(doc: Any) -> Violation:
    parts = (
        ("segments", "job_id", "recording_id", segments),
        ("captions", "job_id", "recording_id", captions),
        ("hand_presence", "job_id", "recording_id", hand_presence),
        ("dag_run", "jobId", "recordingId", dag_run),
    )
    # Every present part names the document's job and recording (dag_run in camelCase).
    for key, job_key, recording_key, _ in parts:
        part = doc[key]
        if part is None:
            continue
        if part[job_key] != doc["job_id"]:
            return ("reference_mismatch", f"/{key}/{job_key}")
        if part[recording_key] != doc["recording_id"]:
            return ("reference_mismatch", f"/{key}/{recording_key}")
    # Each embedded part keeps its own cross-field rules.
    for key, _, _, rule in parts:
        if doc[key] is None:
            continue
        found = rule(doc[key])
        if found:
            return (found[0], f"/{key}{found[1]}")
    if doc["segments"] is not None and doc["captions"] is not None:
        ids = {row["segment_id"] for row in doc["segments"]["rows"]}
        for i, row in enumerate(doc["captions"]["rows"]):
            if row["segment_id"] not in ids:
                return ("reference_mismatch", f"/captions/rows/{i}/segment_id")
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
    "segments": segments,
    "captions": captions,
    "hand_presence": hand_presence,
    "recipe": recipe,
    "module_manifest": module_manifest,
    "task_input_recipe": task_input_recipe,
    "processing_result_nodes": processing_result_nodes,
    "heartbeat_stage": heartbeat_stage,
    "stage_receipt": stage_receipt,
    "stage_run_action": stage_run_action,
    "dag_run": dag_run,
    "recording_annotations": recording_annotations,
}
