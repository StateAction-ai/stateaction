#!/usr/bin/env python3
"""SA-36 additive conformance fixtures for the catalog.v10 staff clip review contracts.

Only NEW fixture files are produced; generate_fixtures.py includes them in its
reproducibility check. Every adapter (TS, Python, Dart) runs the same files.
"""

from __future__ import annotations

import copy

from generate_fixtures import DELETE, OUT, U, dump, mut, ok

DS1 = "00000000-0000-4000-8000-00000000d001"
DS2 = "00000000-0000-4000-8000-00000000d002"
REVIEW = "00000000-0000-4000-8000-00000000e001"
H = "ab" * 32
T1 = "2026-11-02T14:00:00.123456Z"

COMMAND = {
    "reviewId": REVIEW,
    "expectedReviewRevision": 0,
    "jobId": U["job"],
    "resultManifestSha256": H,
    "decision": "approved",
    "taskLabel": "pour water",
    "notes": "clean grasp",
    "datasetSelection": {
        "datasetIds": [DS1, DS2],
        "expectedRevisions": {DS1: 2, DS2: 5},
    },
}


def command_cases():
    c = COMMAND
    minimal = {
        k: v
        for k, v in c.items()
        if k not in ("taskLabel", "notes", "datasetSelection")
    }
    return [
        ok("approval with selection", c),
        ok(
            "rejection (also a withdrawal)",
            {**minimal, "decision": "rejected", "expectedReviewRevision": 3},
        ),
        ok("omitted selection preserves memberships", {**minimal, "taskLabel": "x"}),
        mut(
            "explicit empty selection clears all",
            c,
            [("/datasetSelection", {"datasetIds": [], "expectedRevisions": {}})],
            None,
        ),
        mut("label at the bound", c, [("/taskLabel", "a" * 200)], None),
        mut(
            "label too long",
            c,
            [("/taskLabel", "a" * 201)],
            "schema_violation",
            "/taskLabel",
        ),
        mut("notes at the bound", c, [("/notes", "a" * 4000)], None),
        mut(
            "notes too long", c, [("/notes", "a" * 4001)], "schema_violation", "/notes"
        ),
        mut(
            "decision is approved or rejected",
            c,
            [("/decision", "withdrawn")],
            "schema_violation",
            "/decision",
        ),
        mut(
            "reviewId is a UUID",
            c,
            [("/reviewId", "nope")],
            "schema_violation",
            "/reviewId",
        ),
        mut(
            "revision is not negative",
            c,
            [("/expectedReviewRevision", -1)],
            "schema_violation",
            "/expectedReviewRevision",
        ),
        mut(
            "result hash is sha256",
            c,
            [("/resultManifestSha256", "xyz")],
            "schema_violation",
            "/resultManifestSha256",
        ),
        mut("job identity required", c, [("/jobId", DELETE)], "schema_violation", ""),
        mut(
            "selection needs revisions",
            c,
            [("/datasetSelection/expectedRevisions", DELETE)],
            "schema_violation",
            "/datasetSelection",
        ),
        mut(
            "revision map keys are UUIDs",
            c,
            [("/datasetSelection/expectedRevisions", {"x": 1})],
            "schema_violation",
            "/datasetSelection/expectedRevisions",
        ),
        mut(
            "dataset IDs are unique",
            c,
            [("/datasetSelection/datasetIds", [DS1, DS1])],
            "schema_violation",
            "/datasetSelection/datasetIds",
        ),
        mut(
            "reviewer identity is never client supplied",
            c,
            [("/reviewerUserId", "x")],
            "schema_violation",
            "",
        ),
    ]


def review_cases():
    r = {
        "reviewId": REVIEW,
        "clipId": U["clip"],
        "jobId": U["job"],
        "resultManifestSha256": H,
        "revision": 1,
        "decision": "approved",
        "taskLabel": "pour water",
        "notes": None,
        "datasetSelection": COMMAND["datasetSelection"],
        "createdAt": T1,
    }
    return [
        ok("stored review", r),
        mut(
            "rejection without label",
            r,
            [
                ("/decision", "rejected"),
                ("/taskLabel", None),
                ("/datasetSelection", None),
            ],
            None,
        ),
        mut(
            "revision is positive",
            r,
            [("/revision", 0)],
            "schema_violation",
            "/revision",
        ),
        mut("closed object", r, [("/reviewerUserId", "x")], "schema_violation", ""),
    ]


def state_cases():
    s = {
        "qualityChecks": {"status": "not_evaluated", "checks": []},
        "clipId": U["clip"],
        "recordingId": U["recording"],
        "jobId": U["job"],
        "resultManifestSha256": H,
        "current": True,
        "capabilities": {"canReview": True},
        "review": {
            "revision": 0,
            "decision": None,
            "taskLabel": None,
            "notes": None,
            "reviewedAt": None,
        },
        "history": [],
        "memberships": [],
        "membershipsTruncated": False,
        "availableDatasets": [
            {
                "datasetId": DS1,
                "name": "Kitchen",
                "revision": 2,
                "member": False,
                "shared": False,
            }
        ],
        "availableDatasetsTruncated": False,
    }
    checks = {
        "status": "evaluated",
        "checks": [
            {
                "id": "hand_detection_summary",
                "status": "measured",
                "ruleRevision": 1,
                "measurements": {"frames_with_hand": "12"},
            },
            {"id": "frame_gap", "status": "fail"},
        ],
    }
    reviewed = copy.deepcopy(s)
    reviewed["review"] = {
        "revision": 1,
        "decision": "approved",
        "taskLabel": "pour",
        "notes": "n",
        "reviewedAt": T1,
    }
    reviewed["history"] = [
        {
            "revision": 1,
            "decision": "approved",
            "taskLabel": "pour",
            "notes": "n",
            "reviewedAt": T1,
        }
    ]
    reviewed["memberships"] = [
        {"datasetId": DS1, "name": "Kitchen", "revision": 3, "addedAt": T1}
    ]
    return [
        ok("unreviewed legacy clip", s),
        ok("reviewed with membership", reviewed),
        mut("evaluated checks keep measured", s, [("/qualityChecks", checks)], None),
        mut(
            "sixty-four checks",
            s,
            [
                (
                    "/qualityChecks",
                    {
                        "status": "evaluated",
                        "checks": [
                            {"id": f"c_{i}", "status": "pass"} for i in range(64)
                        ],
                    },
                )
            ],
            None,
        ),
        mut(
            "sixty-five checks",
            s,
            [
                (
                    "/qualityChecks",
                    {
                        "status": "evaluated",
                        "checks": [
                            {"id": f"c_{i}", "status": "pass"} for i in range(65)
                        ],
                    },
                )
            ],
            "schema_violation",
        ),
        mut(
            "not_evaluated carries no checks",
            s,
            [
                (
                    "/qualityChecks",
                    {
                        "status": "not_evaluated",
                        "checks": [{"id": "a", "status": "pass"}],
                    },
                )
            ],
            "schema_violation",
        ),
        mut(
            "measurements are decimal strings",
            s,
            [
                (
                    "/qualityChecks",
                    {
                        "status": "evaluated",
                        "checks": [
                            {
                                "id": "a",
                                "status": "measured",
                                "measurements": {"n": 1.5},
                            }
                        ],
                    },
                )
            ],
            "schema_violation",
        ),
        mut(
            "raw message is not a field",
            s,
            [
                (
                    "/qualityChecks",
                    {
                        "status": "evaluated",
                        "checks": [{"id": "a", "status": "pass", "message": "/srv/x"}],
                    },
                )
            ],
            "schema_violation",
        ),
        mut(
            "no internal identity",
            s,
            [("/reviewerUserId", "x")],
            "schema_violation",
            "",
        ),
        mut(
            "truncation flag required",
            s,
            [("/membershipsTruncated", DELETE)],
            "schema_violation",
            "",
        ),
    ]


def render_sa36():
    cases = {
        "http.clip-review-command.v1": command_cases(),
        "http.clip-review.v1": review_cases(),
        "http.clip-review-state.v1": state_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa36()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-36 fixture files")
