#!/usr/bin/env python3
"""SA-99 additive conformance fixtures for the catalog.v18 segment mark contracts.

Only NEW fixture files are produced; generate_fixtures.py includes them in its
reproducibility check. Every adapter (TS, Python, Dart) runs the same files.
"""

from __future__ import annotations

from generate_fixtures import OUT, U, dump, mut, ok

MARK = "00000000-0000-4000-8000-00000000f099"
SEGMENT = "5b1c2d3e-4f50-5617-8a9b-0c1d2e3f4a5b"
SHA = "d3690131c737f212505f230d86ea322e788db598fd0162f5500f7e22ab7005bc"
WHEN = "2026-11-22T10:00:00.000000Z"

GOOD = {
    "markId": MARK,
    "jobId": U["job"],
    "segmentsSha256": SHA,
    "expectedRevision": 0,
    "verdict": "good",
}
ISSUE = {**GOOD, "verdict": "issue", "issueType": "boundary", "note": "Starts late"}
STORED = {
    "markId": MARK,
    "jobId": U["job"],
    "segmentsSha256": SHA,
    "segmentId": SEGMENT,
    "revision": 1,
    "verdict": "issue",
    "issueType": "caption",
    "note": None,
    "createdAt": WHEN,
    "replayed": False,
}
LISTING = {
    "jobId": U["job"],
    "segmentsSha256": SHA,
    "segmentCount": 3,
    "checkedCount": 1,
    "issueCount": 1,
    "marks": [
        {
            "segmentId": SEGMENT,
            "revision": 2,
            "verdict": "issue",
            "issueType": "hand_pose",
            "note": "Left hand lost",
            "createdAt": WHEN,
        }
    ],
}


def drop(doc, key):
    return {k: v for k, v in doc.items() if k != key}


def command_cases():
    s = "schema_violation"
    return [
        ok("good mark", GOOD),
        ok("issue mark with a type and note", ISSUE),
        mut("each issue type: hand_pose", ISSUE, [("/issueType", "hand_pose")], None),
        mut("each issue type: caption", ISSUE, [("/issueType", "caption")], None),
        mut("note is optional", drop(ISSUE, "note"), [], None),
        mut("note at the bound", ISSUE, [("/note", "n" * 2000)], None),
        mut("note over the bound", ISSUE, [("/note", "n" * 2001)], s, "/note"),
        mut("issue requires a type", drop(ISSUE, "issueType"), [], s),
        mut("good forbids a type", GOOD, [("/issueType", "boundary")], s),
        mut("unknown issue type", ISSUE, [("/issueType", "audio")], s, "/issueType"),
        mut("unknown verdict", GOOD, [("/verdict", "bad")], s, "/verdict"),
        mut("markId is a UUID", GOOD, [("/markId", "x")], s, "/markId"),
        mut("jobId is a UUID", GOOD, [("/jobId", "x")], s, "/jobId"),
        mut(
            "digest is sha256", GOOD, [("/segmentsSha256", "abc")], s, "/segmentsSha256"
        ),
        mut(
            "revision is not negative",
            GOOD,
            [("/expectedRevision", -1)],
            s,
            "/expectedRevision",
        ),
        mut(
            "revision is an integer",
            GOOD,
            [("/expectedRevision", "0")],
            s,
            "/expectedRevision",
        ),
        mut("missing verdict", drop(GOOD, "verdict"), [], s),
        mut("unknown field", GOOD, [("/force", True)], s),
    ]


def mark_cases():
    s = "schema_violation"
    return [
        ok("stored issue", STORED),
        mut(
            "stored good",
            STORED,
            [("/verdict", "good"), ("/issueType", None), ("/note", "ok")],
            None,
        ),
        mut("replayed", STORED, [("/replayed", True)], None),
        mut("revision starts at 1", STORED, [("/revision", 0)], s, "/revision"),
        mut("unknown issue type", STORED, [("/issueType", "x")], s, "/issueType"),
        mut(
            "timestamp is RFC 3339 UTC",
            STORED,
            [("/createdAt", "yesterday")],
            s,
            "/createdAt",
        ),
        mut("segmentId is a UUID", STORED, [("/segmentId", "x")], s, "/segmentId"),
        mut("missing replayed", drop(STORED, "replayed"), [], s),
        mut("unknown field", STORED, [("/reviewer", "x")], s),
    ]


def marks_cases():
    s = "schema_violation"
    return [
        ok("listing", LISTING),
        mut(
            "no accepted result",
            LISTING,
            [
                ("/jobId", None),
                ("/segmentsSha256", None),
                ("/segmentCount", 0),
                ("/checkedCount", 0),
                ("/issueCount", 0),
                ("/marks", []),
            ],
            None,
        ),
        mut(
            "good row has a null type",
            LISTING,
            [("/marks/0/verdict", "good"), ("/marks/0/issueType", None)],
            None,
        ),
        mut(
            "counts are integers", LISTING, [("/checkedCount", "1")], s, "/checkedCount"
        ),
        mut(
            "row revision starts at 1",
            LISTING,
            [("/marks/0/revision", 0)],
            s,
            "/marks/0/revision",
        ),
        mut("row has no extra field", LISTING, [("/marks/0/reviewerUserId", "u")], s),
        mut("missing marks", drop(LISTING, "marks"), [], s),
        mut("unknown field", LISTING, [("/extra", 1)], s),
    ]


def render_sa99():
    cases = {
        "http.segment-mark-command.v1": command_cases(),
        "http.segment-mark.v1": mark_cases(),
        "http.segment-marks.v1": marks_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa99()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-99 fixture files")
