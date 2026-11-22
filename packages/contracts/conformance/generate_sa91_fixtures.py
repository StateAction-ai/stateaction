#!/usr/bin/env python3
"""SA-91 additive conformance fixtures for the catalog.v16 prior-stages contract.

jobs.prior-stages.v1 is schema-only (no cross-field rule). Only a NEW fixture
file is produced; generate_fixtures.py includes it in its reproducibility
check. All identities are synthetic.
"""

from __future__ import annotations

import hashlib

from generate_fixtures import DELETE, OUT, U, dump, mut, ok

FILE_SEGMENTS = "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d"
FILE_DIAG = "3b4c5d6e-7f80-4b9c-8d1e-2f3a4b5c6d7e"
FILE_DIAG_FAILED = "4c5d6e7f-8091-4cad-9e2f-3a4b5c6d7e8f"


def h(name: str) -> str:
    return hashlib.sha256(f"sa91-{name}".encode()).hexdigest()


def out(file_id, role, slot, size, name):
    return {
        "fileId": file_id,
        "role": role,
        "slot": slot,
        "sizeBytes": size,
        "sha256": h(name),
    }


segment_ok = {
    "stage": "segment",
    "state": "succeeded",
    "errorCode": None,
    "counts": {"segments": 3, "failed_windows": 0},
    "outputs": [
        out(FILE_SEGMENTS, "segments_json", "segments.json", "2048", "segments"),
        out(
            FILE_DIAG,
            "diagnostic_blob",
            "diagnostics/segment/log.txt",
            "512",
            "diag",
        ),
    ],
}
segment_failed = {
    "stage": "segment",
    "state": "failed",
    "errorCode": "model_window_failed",
    "counts": {"failed_windows": 2},
    "outputs": [
        out(
            FILE_DIAG_FAILED,
            "diagnostic_blob",
            "diagnostics/segment/log.txt",
            "128",
            "diag-failed",
        )
    ],
}
caption_not_run = {
    "stage": "caption",
    "state": "not_run",
    "errorCode": "upstream_failed",
    "counts": {},
    "outputs": [],
}
base = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "stages": [segment_ok, caption_not_run],
}


def cases():
    return [
        ok("succeeded segment with segments.json and a diagnostic", base),
        ok(
            "failed segment keeps only its diagnostic",
            dict(base, stages=[segment_failed, caption_not_run]),
        ),
        ok(
            "not_run caption has no outputs and an error code",
            dict(base, stages=[caption_not_run]),
        ),
        ok("no stage runs recorded yet", dict(base, stages=[])),
        ok(
            "both stages with the largest output inventory",
            dict(
                base,
                stages=[
                    dict(
                        segment_ok,
                        outputs=[
                            out(
                                U["out_mp4"].replace("b2c3", f"{i:04x}"),
                                "diagnostic_blob",
                                f"diagnostics/segment/part-{i}.txt",
                                "1",
                                f"many-{i}",
                            )
                            for i in range(64)
                        ],
                    ),
                    caption_not_run,
                ],
            ),
        ),
        mut(
            "slot outside the attributed set",
            base,
            [("/stages/0/outputs/0/slot", "clips/0001/rgb.mp4")],
            "schema_violation",
            "/stages/0/outputs/0/slot",
        ),
        mut(
            "slot for the sealing stage is not attributed",
            base,
            [("/stages/0/outputs/1/slot", "diagnostics/hand_pose/log.txt")],
            "schema_violation",
            "/stages/0/outputs/1/slot",
        ),
        mut(
            "slot path traversal",
            base,
            [("/stages/0/outputs/1/slot", "diagnostics/segment/../x")],
            "schema_violation",
            "/stages/0/outputs/1/slot",
        ),
        mut(
            "extra top-level key",
            base,
            [("/objectKey", "jobs/x")],
            "schema_violation",
            "",
        ),
        mut(
            "extra output key",
            base,
            [("/stages/0/outputs/0/objectKey", "jobs/x")],
            "schema_violation",
            "/stages/0/outputs/0",
        ),
        mut(
            "three stages",
            base,
            [("/stages", [segment_ok, caption_not_run, segment_failed])],
            "schema_violation",
            "/stages",
        ),
        mut(
            "stage outputs missing",
            base,
            [("/stages/1/outputs", DELETE)],
            "schema_violation",
            "/stages/1",
        ),
        mut(
            "hand_pose is the sealing stage, not a prior stage",
            base,
            [("/stages/1/stage", "hand_pose")],
            "schema_violation",
            "/stages/1/stage",
        ),
        mut(
            "unknown stage state",
            base,
            [("/stages/0/state", "done")],
            "schema_violation",
            "/stages/0/state",
        ),
        mut(
            "unsupported schema version",
            base,
            [("/schemaVersion", 2)],
            "unsupported_version",
            "/schemaVersion",
        ),
    ]


def render_sa91():
    return {
        OUT / "contracts" / "jobs.prior-stages.v1.json": dump(
            {"contract": "jobs.prior-stages.v1", "cases": cases()}
        )
    }


if __name__ == "__main__":
    files = render_sa91()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-91 fixture file")
