#!/usr/bin/env python3
"""SA-27 additive conformance fixtures for the catalog.v11 staff job control contracts.

Only NEW fixture files are produced; generate_fixtures.py includes them in its
reproducibility check. Every adapter (TS, Python, Dart) runs the same files.
"""

from __future__ import annotations

from generate_fixtures import OUT, U, dump, mut, ok

REQ = "00000000-0000-4000-8000-00000000f001"
COMMAND = {
    "requestId": REQ,
    "action": "retry",
    "jobId": U["job"],
    "expectedState": "failed",
}
RESULT = {
    "action": "retry",
    "jobId": U["job"],
    "state": "failed",
    "retryJobId": REQ,
    "replayed": False,
    "guidance": {
        "code": "retry_available",
        "instruction": "Termination is proven. Retry creates a new job.",
    },
}


def command_cases():
    c = COMMAND
    return [
        ok("retry request", c),
        mut(
            "cancel request",
            c,
            [("/action", "cancel"), ("/expectedState", "running")],
            None,
        ),
        mut(
            "reconcile request",
            c,
            [("/action", "reconcile"), ("/expectedState", "submit_unknown")],
            None,
        ),
        mut(
            "unknown action",
            c,
            [("/action", "resubmit")],
            "schema_violation",
            "/action",
        ),
        mut(
            "unknown state",
            c,
            [("/expectedState", "stopped")],
            "schema_violation",
            "/expectedState",
        ),
        mut(
            "requestId is a UUID",
            c,
            [("/requestId", "nope")],
            "schema_violation",
            "/requestId",
        ),
        mut("jobId is a UUID", c, [("/jobId", "nope")], "schema_violation", "/jobId"),
        mut("unknown field", c, [("/force", True)], "schema_violation"),
        mut(
            "missing state",
            {k: v for k, v in c.items() if k != "expectedState"},
            [],
            "schema_violation",
        ),
    ]


def result_cases():
    r = RESULT
    return [
        ok("retry result", r),
        mut("replayed retry", r, [("/replayed", True)], None),
        mut(
            "cancel result has no retry job",
            r,
            [
                ("/action", "cancel"),
                ("/state", "cancel_requested"),
                ("/retryJobId", None),
            ],
            None,
        ),
        mut(
            "retryJobId is a UUID or null",
            r,
            [("/retryJobId", "x")],
            "schema_violation",
            "/retryJobId",
        ),
        mut(
            "replayed is boolean",
            r,
            [("/replayed", "no")],
            "schema_violation",
            "/replayed",
        ),
        mut(
            "guidance code is known",
            r,
            [("/guidance/code", "clear_slot")],
            "schema_violation",
            "/guidance/code",
        ),
        mut(
            "guidance instruction is bounded",
            r,
            [("/guidance/instruction", "a" * 2001)],
            "schema_violation",
            "/guidance/instruction",
        ),
        mut(
            "guidance instruction is not empty",
            r,
            [("/guidance/instruction", "")],
            "schema_violation",
            "/guidance/instruction",
        ),
        mut("unknown field", r, [("/extra", 1)], "schema_violation"),
    ]


def render_sa27():
    cases = {
        "http.job-control-command.v1": command_cases(),
        "http.job-control-result.v1": result_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa27()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-27 fixture files")
