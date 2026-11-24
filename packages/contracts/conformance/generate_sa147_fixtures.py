"""Clip plans preserve source ordinals, native timestamps and dropped-frame gaps."""

from generate_fixtures import DELETE, OUT, dump, mut, ok
from generate_sa42_fixtures import STATUS
from generate_sa87_fixtures import RECIPE, result_v3
from generate_sa87_fixtures import task as recipe_task

CONTRACT = "artifacts.clip-plan.v1"
PLAN = {
    "schema": "stateaction.clip-plan.v1",
    "recording_id": "41217451-7311-545d-89e4-fbbb5c943d77",
    "plan_version": 1,
    "source_manifest_sha256": "a" * 64,
    "frame_count": 3,
    "origin_ts_ns": "9223372036854100000",
    "clock_domain": "android.elapsed_realtime",
    "mode": "passthrough",
    "state": "succeeded",
    "error_code": None,
    "filter_version": "clip_filter@0",
    "params_sha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    "producer": {
        "module_id": "clip_filter",
        "revision": "0",
        "weights_sha256": None,
        "gpu_type": None,
    },
    "spans": [
        {
            "kind": "clip",
            "start_ordinal": 0,
            "end_ordinal": 3,
            "first_source_frame_id": "7",
            "last_source_frame_id": "10",
            "start_ts_ns": "9223372036854100000",
            "end_ts_ns": "9223372036854600000",
        },
    ],
}


def render_sa147():
    failed = {**PLAN, "state": "failed", "error_code": "decode_failed"}
    spans = [
        {
            **PLAN["spans"][0],
            "end_ordinal": 1,
            "last_source_frame_id": "7",
            "end_ts_ns": "9223372036854100000",
        },
        {
            **PLAN["spans"][0],
            "kind": "excluded",
            "start_ordinal": 1,
            "end_ordinal": 2,
            "first_source_frame_id": "9",
            "last_source_frame_id": "9",
            "start_ts_ns": "9223372036854200000",
            "end_ts_ns": "9223372036854200000",
            "reason": "idle",
            "signals": {"motion": "0.01"},
            "thresholds": {"motion": "0.025"},
            "filter_version": "clip_filter@1",
        },
        {
            **PLAN["spans"][0],
            "start_ordinal": 2,
            "first_source_frame_id": "10",
            "start_ts_ns": "9223372036854600000",
        },
    ]
    applied = {
        **PLAN,
        "mode": "apply",
        "filter_version": "clip_filter@1",
        "producer": {**PLAN["producer"], "revision": "1"},
        "spans": spans,
    }
    cases = [
        ok(
            "whole recording with a dropped source ID and large native timestamps", PLAN
        ),
        ok("failed filter keeps the whole recording with its error", failed),
        ok("certified planner output partitions the recording", applied),
        mut(
            "gap before the end",
            PLAN,
            [("/spans/0/end_ordinal", 2)],
            "dimension_mismatch",
            "/spans",
        ),
        mut(
            "overlap",
            applied,
            [("/spans/2/start_ordinal", 1)],
            "dimension_mismatch",
            "/spans/2/start_ordinal",
        ),
        mut(
            "wrong clock origin",
            PLAN,
            [("/origin_ts_ns", "0")],
            "reference_mismatch",
            "/spans/0/start_ts_ns",
        ),
        mut(
            "rounded timestamp",
            applied,
            [("/spans/2/start_ts_ns", "9223372036854200000")],
            "ordering_violation",
            "/spans/2/start_ts_ns",
        ),
        mut(
            "failed plan without an error",
            failed,
            [("/error_code", None)],
            "schema_violation",
        ),
        mut(
            "passthrough cannot exclude",
            applied,
            [("/mode", "passthrough")],
            "outcome_mismatch",
            "/spans",
        ),
        mut(
            "excluded span with wrong filter version",
            applied,
            [("/spans/1/filter_version", "clip_filter@0")],
            "reference_mismatch",
            "/spans/1/filter_version",
        ),
    ]
    recipe = {
        **RECIPE,
        "schemaVersion": 2,
        "clipFilter": {"mode": "passthrough", "module": "clip_filter@0", "params": {}},
    }
    recipe_cases = [
        ok("recipe explicitly uses a whole-recording clip", recipe),
        mut(
            "uncertified apply is refused",
            recipe,
            [("/clipFilter/mode", "apply")],
            "schema_violation",
        ),
        mut(
            "unknown planner is refused",
            recipe,
            [("/clipFilter/module", "clip_filter@1")],
            "schema_violation",
        ),
    ]

    task = {
        **recipe_task(),
        "schemaVersion": 4,
        "clip": {
            "id": "ad30fea5-011b-4cb1-9820-f076c0401e6a",
            "planVersion": 1,
            "planSha256": "a" * 64,
            "sourceRange": PLAN["spans"][0],
        },
    }
    task_cases = [
        ok("clip-bound task input", task),
        mut(
            "missing source range",
            task,
            [("/clip/sourceRange", DELETE)],
            "schema_violation",
        ),
        mut(
            "wrong recipe digest",
            task,
            [("/recipeSha256", "0" * 64)],
            "reference_mismatch",
            "/recipeSha256",
        ),
    ]
    plan_task = {
        **{
            key: value
            for key, value in task.items()
            if key not in ("recipe", "recipeSha256", "clip")
        },
        "schemaVersion": 5,
        "kind": "clip_plan",
        "planVersion": 1,
        "clipFilter": recipe["clipFilter"],
    }
    plan_task_cases = [
        ok("plan job is pinned to a passthrough filter", plan_task),
        mut(
            "plan job cannot request apply",
            plan_task,
            [("/clipFilter/mode", "apply")],
            "schema_violation",
        ),
    ]
    legacy = result_v3()
    clip = {
        **legacy,
        "schema": "stateaction.processing_result.v5",
        "review_clip_id": task["clip"]["id"],
        "clip_plan_sha256": task["clip"]["planSha256"],
    }
    original = next(out for out in clip["outputs"] if out["role"] == "recording_mp4")
    clip["outputs"] = [out for out in legacy["outputs"] if out is not original]
    clip["nodes"] = [
        {
            **node,
            "outputs": [fid for fid in node["outputs"] if fid != original["file_id"]],
        }
        for node in legacy["nodes"]
    ]
    legacy_clip = {**clip, "outputs": legacy["outputs"], "nodes": legacy["nodes"]}
    result_cases = [
        ok("review clip result leaves the original MP4 with the plan job", clip),
        mut(
            "result must pin the plan",
            clip,
            [("/clip_plan_sha256", DELETE)],
            "schema_violation",
        ),
        {
            "name": "clip job cannot own a recording MP4",
            "input": {"document": legacy_clip},
            "expect": {"valid": False, "code": "reference_mismatch"},
        },
    ]
    status_cases = [
        ok("legacy processing status", STATUS),
        ok(
            "recording-level plan job",
            {**STATUS, "kind": "clip_plan", "codeRevision": "a" * 40},
        ),
        ok(
            "clip pipeline job",
            {**STATUS, "kind": "clip_pipeline", "codeRevision": "b" * 40},
        ),
        mut(
            "invalid admitted code revision",
            {**STATUS, "codeRevision": "a" * 40},
            [("/codeRevision", "invalid revision!")],
            "schema_violation",
        ),
        mut("unknown job kind", STATUS, [("/kind", "planner")], "schema_violation"),
    ]
    return {
        OUT / "contracts" / f"{name}.json": dump({"contract": name, "cases": entries})
        for name, entries in (
            (CONTRACT, cases),
            ("jobs.recipe.v2", recipe_cases),
            ("jobs.task-input.v4", task_cases),
            ("artifacts.processing-result.v5", result_cases),
            ("jobs.task-input.v5", plan_task_cases),
            ("jobs.job-status.v3", status_cases),
        )
    }
