#!/usr/bin/env python3
"""SA-25 additive conformance fixtures for the catalog.v7 job-control contracts.

Only NEW fixture files are produced here (one per added contract id); every
published fixture stays authored, unchanged, by generate_fixtures.py, which
includes these files in its reproducibility check. Every adapter (TS, Python,
Dart) runs the same files. Cases omit error paths for oneOf documents because
engines report different branch paths; the error code is the shared contract.
"""

from __future__ import annotations

from generate_fixtures import DELETE, OUT, U, bad, dump, mut, ok, task_process

T0 = "2026-11-02T08:00:00Z"
T1 = "2026-11-02T14:00:00.123Z"
RUN = "run-e2e-1"
OWNER_NONCE = "ctl-1-3f9a8c2b7d41"
BOOT = "sa_svc_" + "A" * 43
KEY = f"job:{U['job']}"
LOCAL = {"kind": "local", "localExecutionRef": "child-1"}
MODAL = {"kind": "modal", "functionCallId": "fc-01HABC123"}


def action_cases():
    base = {"action": "claim_lease", "runRef": RUN, "owner": OWNER_NONCE}
    return [
        ok("record workflow run", {"action": "record_workflow_run", "runRef": RUN}),
        ok("claim lease", base),
        ok("renew lease", {"action": "renew_lease", "owner": OWNER_NONCE}),
        ok(
            "record worker submission",
            {"action": "record_worker_submission", "owner": OWNER_NONCE},
        ),
        ok(
            "record local execution",
            {"action": "record_execution", "owner": OWNER_NONCE, "executor": LOCAL},
        ),
        ok(
            "record modal execution",
            {"action": "record_execution", "owner": OWNER_NONCE, "executor": MODAL},
        ),
        ok(
            "mark submit unknown",
            {"action": "mark_submit_unknown", "owner": OWNER_NONCE},
        ),
        ok(
            "local child reaped evidence",
            {
                "action": "record_execution_evidence",
                "evidence": {
                    "kind": "local_child_reaped",
                    "executionRef": "child-1",
                    "detail": {"exit": "0"},
                },
            },
        ),
        ok(
            "provider call terminal evidence",
            {
                "action": "record_execution_evidence",
                "evidence": {
                    "kind": "provider_call_terminal",
                    "executionRef": "fc-01HABC123",
                },
            },
        ),
        ok(
            "pre-submission rejection",
            {
                "action": "record_execution_evidence",
                "evidence": {"kind": "pre_submission_rejected"},
            },
        ),
        bad(
            "unknown action",
            {"action": "resubmit", "owner": OWNER_NONCE},
            "schema_violation",
        ),
        bad(
            "a job ID is carried by the route, never the action",
            {**base, "jobId": U["job"]},
            "schema_violation",
        ),
        mut("owner is required", base, [("/owner", DELETE)], "schema_violation"),
        mut(
            "owner charset is bounded",
            base,
            [("/owner", "bad owner")],
            "schema_violation",
        ),
        mut(
            "owner length is bounded", base, [("/owner", "a" * 201)], "schema_violation"
        ),
        mut(
            "run ref charset is bounded",
            base,
            [("/runRef", "run 1")],
            "schema_violation",
        ),
        bad(
            "modal executor needs a function call ID",
            {
                "action": "record_execution",
                "owner": OWNER_NONCE,
                "executor": {"kind": "modal", "functionCallId": "x1"},
            },
            "schema_violation",
        ),
        bad(
            "executor kinds do not mix fields",
            {
                "action": "record_execution",
                "owner": OWNER_NONCE,
                "executor": {"kind": "local", "functionCallId": "fc-1"},
            },
            "schema_violation",
        ),
        bad(
            "pre-submission rejection names no execution",
            {
                "action": "record_execution_evidence",
                "evidence": {
                    "kind": "pre_submission_rejected",
                    "executionRef": "child-1",
                },
            },
            "schema_violation",
        ),
        bad(
            "terminal evidence must name the exact execution",
            {
                "action": "record_execution_evidence",
                "evidence": {"kind": "local_child_reaped"},
            },
            "schema_violation",
        ),
        bad(
            "evidence kind is closed",
            {
                "action": "record_execution_evidence",
                "evidence": {"kind": "assumed_dead", "executionRef": "child-1"},
            },
            "schema_violation",
        ),
        bad(
            "evidence detail values are bounded strings",
            {
                "action": "record_execution_evidence",
                "evidence": {
                    "kind": "local_child_reaped",
                    "executionRef": "child-1",
                    "detail": {"exit": 0},
                },
            },
            "schema_violation",
        ),
        bad(
            "evidence detail is bounded",
            {
                "action": "record_execution_evidence",
                "evidence": {
                    "kind": "local_child_reaped",
                    "executionRef": "child-1",
                    "detail": {f"k{i}": "v" for i in range(17)},
                },
            },
            "schema_violation",
        ),
    ]


def result_cases():
    task_v1 = task_process
    task_v2 = {**task_process, "schemaVersion": 2, "rgbProfile": "h264_mcap_v1"}
    recorded = {
        "state": "recorded",
        "bootstrapToken": BOOT,
        "startDeadline": T0,
        "executionDeadline": T1,
        "taskInput": task_v1,
        "executionBackend": "local",
    }
    return [
        ok("workflow run or execution recorded", {"recorded": True}),
        ok("replayed record is not an error", {"recorded": False}),
        ok("lease granted", {"granted": True, "expiresAt": T1}),
        ok("lease refused: live owner", {"granted": False, "reason": "live_owner"}),
        ok(
            "lease refused: different run",
            {"granted": False, "reason": "different_run"},
        ),
        ok("lease refused: job not active", {"granted": False, "reason": "not_active"}),
        ok("lease renewed", {"renewed": True, "expiresAt": T1}),
        ok("lease not renewed", {"renewed": False}),
        ok("submission intent recorded with the one-time bootstrap", recorded),
        ok(
            "submission intent with a v2 task input", {**recorded, "taskInput": task_v2}
        ),
        ok(
            "submission intent already recorded: never submit again",
            {"state": "already_recorded"},
        ),
        ok("submission marked unknown", {"state": "submit_unknown"}),
        ok(
            "evidence recorded, slot kept until terminal",
            {"recorded": True, "slotReleased": False},
        ),
        ok(
            "evidence recorded, slot released", {"recorded": True, "slotReleased": True}
        ),
        mut(
            "bootstrap token is bounded",
            recorded,
            [("/bootstrapToken", "sa_svc_short")],
            "schema_violation",
        ),
        mut(
            "bootstrap token has the service prefix",
            recorded,
            [("/bootstrapToken", "A" * 50)],
            "schema_violation",
        ),
        mut(
            "task input must be a valid task document",
            recorded,
            [("/taskInput/kind", "export_release")],
            "schema_violation",
        ),
        mut(
            "backend is closed",
            recorded,
            [("/executionBackend", "gpu")],
            "schema_violation",
        ),
        bad(
            "lease refusal reason is closed",
            {"granted": False, "reason": "busy"},
            "schema_violation",
        ),
        bad(
            "a refused lease has no expiry",
            {"granted": False, "reason": "live_owner", "expiresAt": T1},
            "schema_violation",
        ),
        bad(
            "already recorded carries no token",
            {"state": "already_recorded", "bootstrapToken": BOOT},
            "schema_violation",
        ),
        bad("empty result", {}, "schema_violation"),
    ]


def reconcile_cases():
    admitted = {
        "state": "admitted",
        "jobId": U["job"],
        "dispatchKey": KEY,
        "executionDeadline": T1,
    }
    base = {
        "admission": admitted,
        "pendingDispatches": [{"jobId": U["job"], "dispatchKey": KEY}],
    }
    return [
        ok("admitted with a pending dispatch", base),
        ok(
            "slot busy",
            {
                "admission": {"state": "slot_busy", "holderJobId": U["prev_job"]},
                "pendingDispatches": [],
            },
        ),
        ok("idle", {"admission": {"state": "idle"}, "pendingDispatches": []}),
        mut(
            "dispatch key is job:{jobId}",
            base,
            [("/admission/dispatchKey", "job:abc")],
            "schema_violation",
        ),
        mut(
            "pending list is bounded",
            base,
            [("/pendingDispatches", [{"jobId": U["job"], "dispatchKey": KEY}] * 51)],
            "schema_violation",
        ),
        mut(
            "admission state is closed",
            base,
            [("/admission/state", "queued")],
            "schema_violation",
        ),
        mut(
            "pending dispatches may not be omitted",
            base,
            [("/pendingDispatches", DELETE)],
            "schema_violation",
        ),
        mut("extra field", base, [("/note", "x")], "schema_violation"),
    ]


def heartbeat_ack_cases():
    base = {"accepted": True, "executionDeadline": T1}
    return [
        ok("accepted", base),
        mut(
            "never a negative acknowledgement",
            base,
            [("/accepted", False)],
            "schema_violation",
        ),
        mut(
            "deadline is required",
            base,
            [("/executionDeadline", DELETE)],
            "schema_violation",
        ),
        mut(
            "deadline is RFC 3339 UTC",
            base,
            [("/executionDeadline", "2026-11-02 14:00:00")],
            "schema_violation",
        ),
        mut("extra field", base, [("/extendedBy", "60")], "schema_violation"),
    ]


def input_read_cases():
    base = {
        "fileId": U["file_mcap"],
        "readUrl": "http://127.0.0.1:19000/bucket/key?X-Amz-Signature=abc",
        "expiresAt": T1,
    }
    return [
        ok("fresh read URL", base),
        mut(
            "url must be http(s)",
            base,
            [("/readUrl", "ftp://host/key")],
            "schema_violation",
        ),
        mut(
            "url has no whitespace",
            base,
            [("/readUrl", "http://host/a b")],
            "schema_violation",
        ),
        mut(
            "file ID is a lowercase UUID",
            base,
            [("/fileId", U["file_mcap"].upper())],
            "schema_violation",
        ),
        mut("extra field", base, [("/role", "source_mcap")], "schema_violation"),
    ]


def render_sa25():
    cases = {
        "jobs.controller-action.v1": action_cases(),
        "jobs.controller-result.v1": result_cases(),
        "jobs.reconcile-result.v1": reconcile_cases(),
        "jobs.heartbeat-ack.v1": heartbeat_ack_cases(),
        "http.input-read.v1": input_read_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa25()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-25 fixture files")
