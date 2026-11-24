"""Recipe seal (SA-92): the final CPU stage's review video, hand presence and v3 result.

When the job has a recipe, `hand_pose_cpu_v1` is the last stage and seals the job. In the SAME single
pass over the source that writes the clips (`export_artifacts`) it also:

* remuxes every access unit natively into one full-recording `recording.mp4` (no decode, no
  encode; verified by demuxing like a clip's `rgb.mp4`);
* tracks per-side hand presence and writes `hand-presence.json` (`hand-presence.v1`): `present`,
  `no_hand` (an explicit detection result) and `failed` (no inference result, never folded into
  `no_hand`). Thresholds are not touched;
* turns the claim-bound v2 manifest into `processing-result.v3`: it lists EVERY completed output of
  the job (earlier-stage files included) and one node per recipe stage, copied from the stage rows
  the controller hands over (`PriorStage`).

Nothing here runs without a recipe: the single-claim path stays exactly the v2 path.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

from .artifact_clip import _vcl_hashes_annexb, _vcl_hashes_avcc
from .artifact_types import (
    RULE_REVISION,
    ExportError,
    OutputFile,
    make_output,
    require,
)

TIME_BASE = Fraction(1, 1_000_000)
RECORDING_NAME = "recording.mp4"
PRESENCE_NAME = "hand-presence.json"
HAND_MODULE = "hand_pose_cpu_v1"
PRIOR_STAGES = ("segment", "caption")
MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
STATES = ("present", "no_hand", "failed")
_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_SLOT = re.compile(r"^[A-Za-z0-9._-]{1,128}(/[A-Za-z0-9._-]{1,128}){0,7}$")
_COUNT_MAX = 2**53 - 1
_SEGMENT_STATES = {"succeeded", "failed", "cancelled", "not_run"}


class SealError(RuntimeError):
    """The seal cannot be built truthfully. `code` is a stable machine-readable code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# --------------------------------------------------------------------- earlier-stage rows


@dataclass(frozen=True)
class PriorOutput:
    """One completed job output of an earlier stage, exactly as the server stored it."""

    file_id: str
    role: str
    slot: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class PriorStage:
    """The server's row for an earlier stage (state, receipt counts and its completed files)."""

    stage: str
    status: str  # succeeded | failed | not_run  (cancelled is recorded as failed)
    module: str  # the recipe's module for the stage
    error_code: str | None
    counts: dict[str, int]
    outputs: tuple[PriorOutput, ...]


def _uuid_ok(value: object) -> bool:
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _prior_output(stage: str, raw: object) -> PriorOutput:
    from stateaction_contracts import STAGE_ROLES

    if not isinstance(raw, dict) or set(raw) != {
        "fileId",
        "role",
        "slot",
        "sizeBytes",
        "sha256",
    }:
        raise SealError("prior_output_invalid")
    size = raw["sizeBytes"]
    if (
        not _uuid_ok(raw["fileId"])
        or raw["role"] not in STAGE_ROLES[stage]
        or not isinstance(raw["slot"], str)
        or not _SLOT.match(raw["slot"])
        or any(part in (".", "..") for part in raw["slot"].split("/"))
        or not isinstance(size, str)
        or not size.isdigit()
        or int(size) < 1
        or not isinstance(raw["sha256"], str)
        or not _SHA.match(raw["sha256"])
    ):
        raise SealError("prior_output_invalid")
    return PriorOutput(
        raw["fileId"], raw["role"], raw["slot"], int(size), raw["sha256"]
    )


def parse_prior_stages(raw: object, recipe: dict[str, Any]) -> list[PriorStage]:
    """Validate the controller-supplied rows of `segment` and `caption`, in recipe order.

    A disabled stage may be absent (it is `not_run`, `stage_disabled`). An enabled stage must be
    present and settled: this stage is the seal and runs only after every earlier stage ended.
    """
    if not isinstance(raw, list) or len(raw) > len(PRIOR_STAGES):
        raise SealError("prior_stages_invalid")
    given: dict[str, dict[str, Any]] = {}
    for item in raw:
        if (
            not isinstance(item, dict)
            or not set(item) <= {"stage", "state", "errorCode", "counts", "outputs"}
            or item.get("stage") not in PRIOR_STAGES
            or item["stage"] in given
        ):
            raise SealError("prior_stages_invalid")
        given[item["stage"]] = item
    entries = {e["stage"]: e for e in recipe["stages"]}
    rows: list[PriorStage] = []
    for stage in PRIOR_STAGES:
        entry, item = entries[stage], given.get(stage)
        if item is None:
            if entry["enabled"] is True:
                raise SealError("prior_stage_missing")
            rows.append(
                PriorStage(stage, "not_run", entry["module"], "stage_disabled", {}, ())
            )
            continue
        state = item.get("state")
        if state not in _SEGMENT_STATES:
            raise SealError("prior_stage_unsettled")
        status = "failed" if state == "cancelled" else state
        code = item.get("errorCode")
        if (status == "succeeded") != (code is None) or (
            code is not None and not (isinstance(code, str) and _CODE.match(code))
        ):
            raise SealError("prior_stage_invalid")
        # An enabled stage may still be `not_run` (an earlier stage failed); a disabled one only is.
        if entry["enabled"] is not True and status != "not_run":
            raise SealError("prior_stage_invalid")
        counts = item.get("counts", {})
        if (
            not isinstance(counts, dict)
            or len(counts) > 16
            or any(
                not _CODE.match(str(k))
                or not isinstance(v, int)
                or isinstance(v, bool)
                or not 0 <= v <= _COUNT_MAX
                for k, v in counts.items()
            )
        ):
            raise SealError("prior_stage_invalid")
        outputs = tuple(_prior_output(stage, o) for o in item.get("outputs", []))
        if status == "not_run" and outputs:
            raise SealError("prior_stage_invalid")
        rows.append(PriorStage(stage, status, entry["module"], code, counts, outputs))
    return rows


# --------------------------------------------------------------------- the seal plan


@dataclass(frozen=True)
class SealPlan:
    recipe_id: str
    recipe_sha256: str
    hand_module: str  # recipe module of the hand_pose stage, `id@version`
    hand_params_sha256: str
    prior: tuple[PriorStage, ...]
    # Optional: bytes of an earlier output (segments.json / captions.json) for the consistency
    # check. None or a failed read makes that check `not_evaluated`, never `pass`.
    read_document: Callable[[PriorOutput], bytes | None] | None = field(
        default=None, compare=False
    )
    prepare_only: bool = False


def plan_from_task(
    task: dict[str, Any],
    stage_ctx: dict[str, Any],
    job_id: str,
    read_document: Callable[[PriorOutput], bytes | None] | None = None,
) -> SealPlan:
    """The seal plan of a claimed hand_pose stage: the admitted v3 task input plus the stage rows."""
    from stateaction_contracts import request_sha256

    if (
        task.get("schemaVersion") != 3
        or task.get("kind") != "process_recording"
        or task.get("jobId") != job_id
    ):
        raise SealError("task_input_invalid")
    recipe = task["recipe"]
    if (
        task["recipeSha256"] != stage_ctx["recipeSha256"]
        or request_sha256(recipe) != stage_ctx["recipeSha256"]
    ):
        raise SealError("recipe_digest_mismatch")
    entry = next((s for s in recipe["stages"] if s["stage"] == "hand_pose"), None)
    if (
        entry is None
        or entry["enabled"] is not True
        or entry["module"] != stage_ctx["module"]
        or not entry["module"].startswith(f"{HAND_MODULE}@")
    ):
        raise SealError("recipe_stage_mismatch")
    return SealPlan(
        recipe_id=recipe["recipeId"],
        recipe_sha256=task["recipeSha256"],
        hand_module=entry["module"],
        hand_params_sha256=request_sha256(entry["params"]),
        prior=()
        if stage_ctx.get("prepareOnly")
        else tuple(parse_prior_stages(stage_ctx["priorStages"], recipe)),
        read_document=read_document,
        prepare_only=stage_ctx.get("prepareOnly") is True,
    )


# --------------------------------------------------------------------- hand presence lanes


class LaneBuilder:
    """Run-length lane over every decoded frame, in order (`hand-presence.v1` lane)."""

    def __init__(self) -> None:
        self.runs: list[list[Any]] = []  # [start frameRef, state, frames]

    def add(self, ref: dict[str, str], state: str) -> None:
        require(state in STATES, "E_PRESENCE_STATE", state)
        if self.runs and self.runs[-1][1] == state:
            self.runs[-1][2] += 1
        else:
            self.runs.append([ref, state, 1])

    def spans(self) -> list[dict[str, Any]]:
        end_of_stream = {"source_frame_id": None, "timestamp_ns": None}
        out = []
        for i, (start, state, frames) in enumerate(self.runs):
            end = self.runs[i + 1][0] if i + 1 < len(self.runs) else end_of_stream
            out.append(
                {
                    "start": dict(start),
                    "end": dict(end),
                    "frames": frames,
                    "state": state,
                }
            )
        return out


def side_states(obs: Any) -> tuple[str, str]:
    """(left, right) state of one inferred frame: `present` or the explicit `no_hand` result."""
    sides = {
        obs.handedness_label[j]
        for j in range(len(obs.handedness_label))
        if bool(obs.hand_present[j])
    }
    return (
        "present" if "left" in sides else "no_hand",
        "present" if "right" in sides else "no_hand",
    )


def _au_digest(hashes: list[str]) -> bytes:
    return hashlib.sha256("".join(hashes).encode()).digest()


def _engine_version() -> str:
    try:
        from importlib.metadata import version

        text = version("mediapipe")
    except Exception:
        text = ""
    return text if re.match(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$", text) else "unknown"


def _jsonb(doc: Any) -> bytes:
    return json.dumps(
        doc, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


class RecordingWriter:
    """Native full-recording remux plus presence lanes, fed one decoded frame at a time."""

    def __init__(self, scratch: Path, first: Any) -> None:
        import av

        au = first.access_unit
        require(au.is_idr, "E_RECORDING_START_NOT_IDR", au.sequence)
        self._av = av
        self.path = scratch / RECORDING_NAME
        self.origin = au.encoder_pts_us
        self.raster = first.transform.raster
        self.clock_domain = au.native_clock_id
        self.frames = 0
        self.last_pts = -1
        self.left, self.right = LaneBuilder(), LaneBuilder()
        self._digests: list[tuple[int, bytes]] = []
        self._mp4 = av.open(str(self.path), "w", format="mp4")
        self._stream = self._mp4.add_stream("h264")
        self._stream.width, self._stream.height = self.raster
        self._stream.time_base = TIME_BASE

    def add(self, frame: Any, obs: Any) -> None:
        au = frame.access_unit
        require(frame.transform.raster == self.raster, "E_RASTER_CHANGED_IN_RECORDING")
        require(au.native_clock_id == self.clock_domain, "E_CLOCK_CHANGED_IN_RECORDING")
        require(au.source_frame_id.isdigit(), "E_SOURCE_FRAME_ID_NOT_INT64")
        pts = au.encoder_pts_us - self.origin
        require(pts > self.last_pts, "E_RECORDING_PTS_ORDER", pts)
        self.last_pts = pts
        packet = self._av.Packet(au.data)
        packet.pts = packet.dts = pts
        packet.time_base = TIME_BASE
        packet.stream = self._stream
        packet.is_keyframe = au.is_idr
        self._mp4.mux(packet)  # the original Annex B access unit, unchanged
        self._digests.append((pts, _au_digest(_vcl_hashes_annexb(au.data))))
        ref = {
            "source_frame_id": au.source_frame_id,
            "timestamp_ns": au.native_timestamp_ns,
        }
        left, right = side_states(obs)
        self.left.add(ref, left)
        self.right.add(ref, right)
        self.frames += 1

    def _verify(self) -> None:
        """Demux-only check (no decode): packet count, exact PTS and VCL NAL bytes of every AU."""
        with self._av.open(str(self.path)) as src:
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
                got.append(
                    (int(p.pts), _au_digest(_vcl_hashes_avcc(bytes(p), nal_len)))
                )
        require(
            got == self._digests,
            "E_MP4_REMUX_MISMATCH",
            (len(got), len(self._digests)),
        )

    def close(self, plan: SealPlan, context: Any) -> tuple[OutputFile, OutputFile]:
        """Finish both files: (recording.mp4, hand-presence.json), verified, in scratch."""
        from stateaction_contracts import validate_bytes

        from . import hand_model

        require(self.frames >= 1, "E_RECORDING_EMPTY")
        self._mp4.close()
        self._verify()
        provenance = hand_model.PINS
        doc = {
            "schema": "stateaction.hand_presence.v1",
            "job_id": context.job_id,
            "recording_id": context.recording_id,
            "source_manifest_sha256": context.source_manifest_sha256,
            "clock_domain": self.clock_domain,
            "frame_count": self.frames,
            "producer": {
                "stage": "hand_pose",
                "module_id": HAND_MODULE,
                "module_version": int(plan.hand_module.partition("@")[2]),
                "model_name": "mediapipe_hand_landmarker",
                "model_revision": None,
                "weights_sha256": provenance["sha256"],
                "quant": None,
                "prompt_sha256": None,
                "params_sha256": plan.hand_params_sha256,
                # Recorded as pinned, never changed here (fractions are strings: sa-cjson-v1).
                "decoding_params": {
                    "max_hands": int(provenance["max_hands"]),
                    "min_hand_detection_confidence": str(
                        provenance["min_hand_detection_confidence"]
                    ),
                    "min_hand_presence_confidence": str(
                        provenance["min_hand_presence_confidence"]
                    ),
                },
                "engine": {"name": "mediapipe", "version": _engine_version()},
                "gpu": {"requested_type": "none", "observed_type": None},
            },
            "lanes": {"left": self.left.spans(), "right": self.right.spans()},
        }
        data = _jsonb(doc)
        verdict = validate_bytes("artifacts.hand-presence.v1", data)
        if not verdict.valid:
            raise ExportError(
                "E_CONTRACT_VIOLATION",
                ("hand-presence", verdict.code, verdict.errors[:3]),
            )
        presence_path = self.path.with_name(PRESENCE_NAME)
        presence_path.write_bytes(data)
        return (
            make_output("recording_mp4", RECORDING_NAME, self.path, None),
            make_output("hand_presence_json", PRESENCE_NAME, presence_path, None),
        )

    def abort(self) -> None:
        try:
            self._mp4.close()
        except Exception:  # best effort during failure cleanup
            pass


# --------------------------------------------------------------------- consistency check


def _check(
    status: str, message: str, measurements: dict[str, int] | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "code": "annotation_files_consistent",
        "status": status,
        "message": message,
        "rule_revision": RULE_REVISION,
    }
    if measurements is not None:
        out["measurements"] = {k: str(v) for k, v in measurements.items()}
    return out


def annotation_check(plan: SealPlan) -> dict[str, Any]:
    """`annotation_files_consistent`: every caption row names a segment of THIS job's segments.json,
    and the captions pin that exact segments file. `not_evaluated` when a document is absent or
    cannot be read here (the server re-checks both at acceptance); never a silent pass."""
    from stateaction_contracts import validate_bytes

    files: dict[str, PriorOutput | None] = {
        "segments_json": None,
        "captions_json": None,
    }
    for row in plan.prior:
        for out in row.outputs:
            if out.role in files:
                files[out.role] = out
    seg, cap = files["segments_json"], files["captions_json"]
    if seg is None and cap is None:
        return _check(
            "not_evaluated",
            "No segments.json or captions.json was produced by the earlier stages.",
        )
    if cap is not None and seg is None:
        return _check("fail", "captions.json exists but there is no segments.json.")
    if seg is None or plan.read_document is None:
        return _check(
            "not_evaluated",
            "The sealing stage could not read the annotation files; acceptance verifies them.",
        )
    seg_bytes = plan.read_document(seg)
    cap_bytes = plan.read_document(cap) if cap is not None else b""
    if seg_bytes is None or cap_bytes is None:
        return _check(
            "not_evaluated",
            "The sealing stage could not read the annotation files; acceptance verifies them.",
        )
    seg_doc = validate_bytes("artifacts.segments.v1", seg_bytes)
    if not seg_doc.valid or hashlib.sha256(seg_bytes).hexdigest() != seg.sha256:
        return _check("fail", "segments.json is not the valid file the stage stored.")
    segment_rows = seg_doc.value["rows"]
    known = {r["segment_id"] for r in segment_rows}
    if cap is None:
        return _check(
            "pass",
            "No captions file; segments.json is valid.",
            {"segments": len(segment_rows), "captions": 0, "unknown_segments": 0},
        )
    cap_doc = validate_bytes("artifacts.captions.v1", cap_bytes)
    if not cap_doc.valid or hashlib.sha256(cap_bytes).hexdigest() != cap.sha256:
        return _check("fail", "captions.json is not the valid file the stage stored.")
    rows = cap_doc.value["rows"]
    unknown = sum(1 for r in rows if r["segment_id"] not in known)
    pinned = cap_doc.value["segments_sha256"] == seg.sha256
    measurements = {
        "segments": len(segment_rows),
        "captions": len(rows),
        "unknown_segments": unknown,
        "pins_segments_file": int(pinned),
    }
    if unknown or not pinned:
        return _check(
            "fail",
            "Captions name an unknown segment or pin a different segments.json.",
            measurements,
        )
    return _check(
        "pass", "Every caption names a segment of segments.json.", measurements
    )


# --------------------------------------------------------------------- processing-result.v3


def to_v3(
    plan: SealPlan,
    doc: dict[str, Any],
    own: list[OutputFile],
    frames: int,
    clips: int,
    miss: Any,
) -> dict[str, Any]:
    """Turn the v2 manifest of this run into `processing-result.v3` with every job output."""
    prior_outputs = [o for row in plan.prior for o in row.outputs]
    listed = list(
        doc["outputs"]
    )  # this stage's own files, cited by the sink's file ids
    ids = [o["file_id"] for o in listed] + [o.file_id for o in prior_outputs]
    slots = [o["relative_path"] for o in listed] + [o.slot for o in prior_outputs]
    require(
        len(set(ids)) == len(ids) and len(set(slots)) == len(slots),
        "E_INVENTORY_DUPLICATE",
    )
    require(
        {o.relative_path for o in own} == {o["relative_path"] for o in listed},
        "E_INVENTORY_MISMATCH",
    )
    out = dict(doc)
    out["schema"] = "stateaction.processing_result.v3"
    out["outputs"] = [
        {
            "file_id": o.file_id,
            "role": o.role,
            "relative_path": o.slot,
            "size_bytes": str(o.size_bytes),
            "sha256": o.sha256,
        }
        for o in prior_outputs
    ] + listed
    out["recipe_id"] = plan.recipe_id
    out["recipe_sha256"] = plan.recipe_sha256
    nodes: list[dict[str, Any]] = [
        {
            "stage": row.stage,
            "status": row.status,
            "module": row.module,
            "error_code": row.error_code,
            "outputs": [o.file_id for o in row.outputs],
            "counts": dict(row.counts),
        }
        for row in plan.prior
    ]
    nodes.append(
        {
            "stage": "hand_pose",
            "status": "succeeded",
            "module": plan.hand_module,
            "error_code": None,
            "outputs": [o["file_id"] for o in listed],
            "counts": {
                "frames": frames,
                "clips": clips,
                "frames_no_hand": miss.frames_no_hand,
                "frames_one_hand": miss.frames_one_hand,
                "frames_two_hands": miss.frames_two_hands,
            },
        }
    )
    out["nodes"] = nodes
    if not plan.prepare_only:
        out["checks"] = [*doc["checks"], annotation_check(plan)]
    return out
