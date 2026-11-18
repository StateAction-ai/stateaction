#!/usr/bin/env python3
"""SA-28 additive conformance fixtures for the catalog.v9 output-acceptance contracts.

Only NEW fixture files are produced here; every published fixture stays authored, unchanged, by
generate_fixtures.py, which includes these files in its reproducibility check. Every adapter (TS,
Python, Dart) runs the same files.
"""

from __future__ import annotations

import copy

from generate_fixtures import DELETE, OUT, U, dump, mut, ok, result
from generate_sa71_fixtures import MARKER_ART

NONCE = "A" * 43
T1 = "2026-11-02T14:00:00.123456Z"
H = "ab" * 32


def v2_doc(profile="h264_mcap_v1", simulated=False):
    doc = copy.deepcopy(result)
    doc["schema"] = "stateaction.processing_result.v2"
    doc["attestation"] = {
        "invocation_nonce": NONCE,
        "rgb_profile": profile,
        "source_file_id": doc["verified_sources"][0]["file_id"],
        "source_eof_verified": True,
    }
    if simulated:
        doc["simulation"] = copy.deepcopy(MARKER_ART)
    return doc


def result_v2_cases():
    base = v2_doc()
    sim = v2_doc("h264_mcap_simulation_v1", True)
    failed = copy.deepcopy(base)
    failed["verified_sources"] = []
    failed["outputs"] = []
    failed["clips"] = []
    failed["attestation"]["source_eof_verified"] = False
    return [
        ok("hardware result with attestation", base),
        ok("simulated result carries the explicit marker", sim),
        ok("failed run that never reached EOF", failed),
        mut(
            "v1 discriminator is not accepted here",
            base,
            [("/schema", "stateaction.processing_result.v1")],
            "unsupported_version",
            "/schema",
        ),
        mut(
            "attestation is required",
            base,
            [("/attestation", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "nonce is 32 bytes base64url",
            base,
            [("/attestation/invocation_nonce", "short")],
            "schema_violation",
            "/attestation/invocation_nonce",
        ),
        mut(
            "marker cannot claim production qualification",
            sim,
            [("/simulation/production_qualified", True)],
            "schema_violation",
        ),
        mut(
            "references still resolve to outputs",
            base,
            [("/clips/0/files/rgb_mp4", U["file_mcap"])],
            "reference_mismatch",
            "/clips/0/files/rgb_mp4",
        ),
        mut("closed object", base, [("/object_key", "k")], "schema_violation", ""),
        # Adversarial: v2 inherits every v1 cross-reference rule.
        mut(
            "duplicate output file id",
            base,
            [("/outputs/1/file_id", base["outputs"][0]["file_id"])],
            "duplicate_identity",
            "/outputs/1/file_id",
        ),
        mut(
            "duplicate output slot",
            base,
            [("/outputs/1/relative_path", base["outputs"][0]["relative_path"])],
            "duplicate_identity",
            "/outputs/1/relative_path",
        ),
        mut(
            "duplicate verified source",
            base,
            [("/verified_sources", base["verified_sources"] * 2)],
            "duplicate_identity",
            "/verified_sources/2/file_id",
        ),
        mut(
            "a manifest cannot list itself as an output",
            base,
            [("/outputs/0/role", "result_manifest")],
            "reference_mismatch",
            "/outputs/0/role",
        ),
        mut(
            "a clip file must be an output of the matching role",
            base,
            [("/clips/0/files/viewer_rrd", base["outputs"][0]["file_id"])],
            "reference_mismatch",
            "/clips/0/files/viewer_rrd",
        ),
        mut(
            "clip ordinals are contiguous from zero",
            base,
            [("/clips/0/clip_ordinal", 1)],
            "ordering_violation",
            "/clips/0/clip_ordinal",
        ),
    ]


def close_cases():
    base = {
        "schemaVersion": 1,
        "jobId": U["job"],
        "invocationNonce": NONCE,
        "outcome": "succeeded",
    }
    return [
        ok("succeeded", base),
        ok("failed run seals its diagnostics", {**base, "outcome": "failed"}),
        mut(
            "outcome is closed",
            base,
            [("/outcome", "partial")],
            "schema_violation",
            "/outcome",
        ),
        mut(
            "nonce is required",
            base,
            [("/invocationNonce", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "nonce is 32 bytes base64url",
            base,
            [("/invocationNonce", "x")],
            "schema_violation",
            "/invocationNonce",
        ),
        mut("no file list is accepted", base, [("/files", [])], "schema_violation", ""),
        mut("closed object", base, [("/admin", True)], "schema_violation", ""),
    ]


def closure_cases():
    base = {
        "schemaVersion": 1,
        "jobId": U["job"],
        "outcome": "succeeded",
        "fileCount": 7,
        "clipCount": 1,
        "totalBytes": "123456",
        "manifestFileId": U["file_mcap"],
        "inventorySha256": H,
        "closedAt": T1,
    }
    return [
        ok("closed inventory", base),
        mut(
            "file count is bounded",
            base,
            [("/fileCount", 2001)],
            "schema_violation",
            "/fileCount",
        ),
        mut(
            "clip count is bounded",
            base,
            [("/clipCount", 1000)],
            "schema_violation",
            "/clipCount",
        ),
        mut(
            "digest is sha256",
            base,
            [("/inventorySha256", "x")],
            "schema_violation",
            "/inventorySha256",
        ),
        mut("no object keys", base, [("/objectKey", "k")], "schema_violation", ""),
    ]


def ack_cases():
    base = {
        "schemaVersion": 1,
        "jobId": U["job"],
        "candidateStatus": "provisional",
        "jobState": "result_pending",
    }
    return [
        ok("provisional never means accepted", base),
        ok(
            "accepted", {**base, "candidateStatus": "accepted", "jobState": "succeeded"}
        ),
        ok(
            "rejected with an actionable code",
            {
                **base,
                "candidateStatus": "rejected",
                "jobState": "failed",
                "reasonCode": "output_hash_mismatch",
            },
        ),
        mut(
            "status is closed",
            base,
            [("/candidateStatus", "selected")],
            "schema_violation",
            "/candidateStatus",
        ),
        mut(
            "reason code shape",
            base,
            [("/reasonCode", "Bad Code")],
            "schema_violation",
            "/reasonCode",
        ),
        mut("closed object", base, [("/slotReleased", True)], "schema_violation", ""),
    ]


def render_sa28():
    cases = {
        "artifacts.processing-result.v2": result_v2_cases(),
        "jobs.output-close.v1": close_cases(),
        "jobs.output-closure.v1": closure_cases(),
        "jobs.result-ack.v1": ack_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa28()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-28 fixture files")
