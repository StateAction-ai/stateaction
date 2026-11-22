#!/usr/bin/env python3
"""SA-103 additive conformance fixtures for the catalog.v15 worker output contracts.

http.output-create.v2 and http.output-plan.v2 reference the common.v2
outputFileRole (a superset of v1). Only NEW fixture files are produced;
generate_fixtures.py includes them in its reproducibility check.
"""

from __future__ import annotations

from generate_fixtures import (
    FILE_MAX,
    FILE_OVER,
    OUT,
    dump,
    mut,
    ok,
    output_create,
    output_plan,
    output_plan_max,
)

V1_ROLES = [
    "result_manifest",
    "clip_mp4",
    "hand_arrays_npz",
    "hand_observations_json",
    "frame_map_json",
    "thumbnail_jpeg",
    "viewer_rrd",
]
NEW_ROLES = {
    "segments_json": "segments.json",
    "captions_json": "captions.json",
    "hand_presence_json": "hand-presence.json",
    "recording_mp4": "recording.mp4",
    "diagnostic_blob": "diagnostics/segment/windows.jsonl",
}


def create_cases():
    cases = [
        ok("v1 clip request is still accepted", output_create),
        ok("largest output file", dict(output_create, sizeBytes=FILE_MAX)),
    ]
    for role in V1_ROLES:
        cases.append(ok(f"v1 role {role}", dict(output_create, role=role)))
    for role, slot in NEW_ROLES.items():
        cases.append(
            ok(f"annotation role {role}", dict(output_create, role=role, slot=slot))
        )
    cases += [
        mut(
            "over the file cap",
            output_create,
            [("/sizeBytes", FILE_OVER)],
            "schema_violation",
            "/sizeBytes",
        ),
        mut(
            "source role is not an output role",
            output_create,
            [("/role", "source_mcap")],
            "schema_violation",
            "/role",
        ),
        mut(
            "dag run is server rendered, not an output role",
            output_create,
            [("/role", "dag_run_json")],
            "schema_violation",
            "/role",
        ),
        mut(
            "unknown role",
            output_create,
            [("/role", "other")],
            "schema_violation",
            "/role",
        ),
        mut(
            "client supplies object key",
            output_create,
            [("/objectKey", "jobs/x")],
            "schema_violation",
            "",
        ),
    ]
    return cases


def plan_cases():
    cases = [ok("three 64 MiB parts for 128 MiB + 1 byte", output_plan)]
    cases.append(ok("100 GiB output plan uses 1600 parts", output_plan_max))
    for role in V1_ROLES:
        cases.append(ok(f"v1 role {role}", dict(output_plan, role=role)))
    for role in NEW_ROLES:
        cases.append(ok(f"annotation role {role}", dict(output_plan, role=role)))
    cases += [
        mut(
            "part count disagrees with size",
            output_plan,
            [("/partCount", 2)],
            "part_plan_mismatch",
            "/partCount",
        ),
        mut(
            "part count disagrees with size on an annotation role",
            dict(output_plan, role="segments_json"),
            [("/partCount", 2)],
            "part_plan_mismatch",
            "/partCount",
        ),
        mut(
            "source role is not an output role",
            output_plan,
            [("/role", "source_mcap")],
            "schema_violation",
            "/role",
        ),
        mut(
            "unknown role",
            output_plan,
            [("/role", "other")],
            "schema_violation",
            "/role",
        ),
        mut(
            "object key never leaves the server",
            output_plan,
            [("/objectKey", "jobs/x")],
            "schema_violation",
            "",
        ),
    ]
    return cases


def render_sa103():
    cases = {
        "http.output-create.v2": create_cases(),
        "http.output-plan.v2": plan_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa103()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-103 fixture files")
