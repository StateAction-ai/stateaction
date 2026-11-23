#!/usr/bin/env python3
"""SA-98 additive conformance fixtures for the catalog.v17 recording-annotations contract.

http.recording-annotations.v1 embeds the published segments, captions,
hand-presence and dag-run documents. The valid documents reuse the SA-87
fixtures unchanged. Only a NEW fixture file is produced; generate_fixtures.py
includes it in its reproducibility check.
"""

from __future__ import annotations

import copy

from generate_fixtures import DELETE, OUT, U, dump, mut, ok
from generate_sa87_fixtures import CAPTIONS, DAG, HAND, SEGMENT_IDS, segments_doc

SEGMENTS = segments_doc()
OTHER_JOB = "019a4b2c-3d4e-7f50-8a6b-7c8d9e0f1a99"
OTHER_RECORDING = "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a99"
UNKNOWN_SEGMENT = "00000000-0000-5000-8000-000000000000"

full = {
    "schema": "stateaction.recording-annotations.v1",
    "recording_id": U["recording"],
    "job_id": U["job"],
    "segments": SEGMENTS,
    "captions": CAPTIONS,
    "hand_presence": HAND,
    "dag_run": DAG,
}

# Every caption failed or not captioned; the failed model window stays recorded.
failed_captions = copy.deepcopy(CAPTIONS)
failed_captions["rows"] = [
    {
        "segment_id": row["segment_id"],
        "status": "not_captioned" if row["status"] == "not_captioned" else "failed",
        "error_code": "segment_failed_window"
        if row["status"] == "not_captioned"
        else "unsupported_target_frames",
    }
    for row in CAPTIONS["rows"]
]
caption_failed = dict(full, captions=failed_captions)

segments_only = dict(full, captions=None, hand_presence=None, dag_run=None)


def cases():
    return [
        ok("full document with every part", full),
        ok("caption_failed: failed caption rows and a failed window", caption_failed),
        ok("segments only, other parts null", segments_only),
        ok(
            "nothing produced, every part null",
            dict(segments_only, segments=None),
        ),
        mut(
            "captions without segments need no segment rows",
            full,
            [("/segments", None)],
            None,
        ),
        mut(
            "mismatched job_id on segments",
            full,
            [("/segments/job_id", OTHER_JOB)],
            "reference_mismatch",
            "/segments/job_id",
        ),
        mut(
            "mismatched job_id on captions",
            full,
            [("/captions/job_id", OTHER_JOB)],
            "reference_mismatch",
            "/captions/job_id",
        ),
        mut(
            "mismatched recording_id on hand presence",
            full,
            [("/hand_presence/recording_id", OTHER_RECORDING)],
            "reference_mismatch",
            "/hand_presence/recording_id",
        ),
        mut(
            "mismatched camelCase jobId on dag_run",
            full,
            [("/dag_run/jobId", OTHER_JOB)],
            "reference_mismatch",
            "/dag_run/jobId",
        ),
        mut(
            "mismatched camelCase recordingId on dag_run",
            full,
            [("/dag_run/recordingId", OTHER_RECORDING)],
            "reference_mismatch",
            "/dag_run/recordingId",
        ),
        mut(
            "document job_id differs from every part",
            full,
            [("/job_id", OTHER_JOB)],
            "reference_mismatch",
            "/segments/job_id",
        ),
        mut(
            "caption row for an unknown segment",
            full,
            [("/captions/rows/1/segment_id", UNKNOWN_SEGMENT)],
            "reference_mismatch",
            "/captions/rows/1/segment_id",
        ),
        mut(
            "embedded segments keep their own rules",
            full,
            [("/segments/windows/ok", 7)],
            "progress_mismatch",
            "/segments/windows/ok",
        ),
        mut(
            "embedded captions keep their own rules",
            full,
            [("/captions/rows/1/segment_id", SEGMENT_IDS[0])],
            "duplicate_identity",
            "/captions/rows/1/segment_id",
        ),
        mut(
            "embedded dag_run keeps its own rules",
            full,
            [("/dag_run/stages/1/errorCode", None)],
            "outcome_mismatch",
            "/dag_run/stages/1/errorCode",
        ),
        mut(
            "embedded part must be the published schema",
            full,
            [("/segments/schema", "stateaction.segments.v0")],
            "schema_violation",
            "/segments",
        ),
        mut(
            "wrong schema const",
            full,
            [("/schema", "stateaction.recording-annotations.v2")],
            "unsupported_version",
            "/schema",
        ),
        mut(
            "extra property",
            full,
            [("/objectKey", "jobs/x")],
            "schema_violation",
            "",
        ),
        mut(
            "a part is null, never absent",
            full,
            [("/hand_presence", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "unknown extra key inside an embedded part",
            full,
            [("/dag_run/objectKey", "jobs/x")],
            "schema_violation",
            "/dag_run",
        ),
    ]


def render_sa98():
    return {
        OUT / "contracts" / "http.recording-annotations.v1.json": dump(
            {"contract": "http.recording-annotations.v1", "cases": cases()}
        )
    }


if __name__ == "__main__":
    files = render_sa98()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-98 fixture file")
