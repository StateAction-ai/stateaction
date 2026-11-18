#!/usr/bin/env python3
"""SA-42 additive conformance fixtures for the catalog.v12 job status contract.

Only a NEW fixture file is produced; generate_fixtures.py includes it in its
reproducibility check. Every adapter (TS, Python, Dart) runs the same file.
"""

from __future__ import annotations

from generate_fixtures import OUT, dump, job_status, mut, ok

STATUS = {
    **job_status,
    "executionBackend": "modal",
    "executionRef": "fc-0123456789ABCDEFabcdef",
    "startDeadline": "2026-11-01T18:14:07Z",
    "executionDeadline": "2026-11-02T00:04:07Z",
}


def status_cases():
    s = STATUS
    return [
        ok("recorded modal call", s),
        mut(
            "recorded local execution",
            s,
            [("/executionBackend", "local"), ("/executionRef", "local-3f2c1b9a")],
            None,
        ),
        mut(
            "nothing recorded yet",
            s,
            [
                ("/executionBackend", None),
                ("/executionRef", None),
                ("/startDeadline", None),
                ("/executionDeadline", None),
            ],
            None,
        ),
        mut("backend admitted before any reference", s, [("/executionRef", None)], None),
        mut(
            "unknown backend",
            s,
            [("/executionBackend", "gpu")],
            "schema_violation",
            "/executionBackend",
        ),
        mut(
            "reference charset",
            s,
            [("/executionRef", "fc 1/2")],
            "schema_violation",
            "/executionRef",
        ),
        mut(
            "reference bound",
            s,
            [("/executionRef", "a" * 129)],
            "schema_violation",
            "/executionRef",
        ),
        mut(
            "deadline is an RFC 3339 UTC instant or null",
            s,
            [("/executionDeadline", "tomorrow")],
            "schema_violation",
            "/executionDeadline",
        ),
        mut(
            "start deadline is an RFC 3339 UTC instant or null",
            s,
            [("/startDeadline", "soon")],
            "schema_violation",
            "/startDeadline",
        ),
        mut(
            "reference is required",
            {k: v for k, v in s.items() if k != "executionRef"},
            [],
            "schema_violation",
        ),
        mut("unknown field", s, [("/functionCallId", "fc-1")], "schema_violation"),
    ]


def render_sa42():
    cases = {"jobs.job-status.v2": status_cases()}
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa42()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-42 fixture file")
