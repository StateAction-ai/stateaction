#!/usr/bin/env python3
"""SA-73 additive conformance fixtures for the catalog.v13 source-copy contracts.

Only NEW fixture files are produced; generate_fixtures.py includes them in its
reproducibility check. Every adapter (TS, Python, Dart) runs the same files.
"""

from __future__ import annotations

from generate_fixtures import OUT, OWNER, H, U, dump, mut, ok

SEAL = "5" * 64
MANIFEST = H["config"]
STAFF = "Ym2nR8sT4vW6xZ1cB3dF5gH7jK9lM0pQ"

CONFIRM = {
    "expectedSealSha256": SEAL,
    "expectedSourceManifestSha256": MANIFEST,
    "expectedFileCount": 3,
}
PROOF_REQUEST = {
    "sealSha256": SEAL,
    "sourceManifestSha256": MANIFEST,
    "clientRecordingId": U["client_recording"],
}
FILES = [
    {
        "fileId": U["manifest"],
        "role": "source_manifest",
        "required": True,
        "sizeBytes": "1000",
        "sha256": MANIFEST,
    },
    {
        "fileId": U["file_mcap"],
        "role": "source_mcap",
        "required": True,
        "sizeBytes": "134217729",
        "sha256": H["mcap"],
    },
    {
        "fileId": U["file_meta"],
        "role": "recorder_metadata",
        "required": True,
        "sizeBytes": "4096",
        "sha256": H["meta"],
    },
]
CONFIRMATION = {
    "schemaVersion": 1,
    "confirmationId": U["evidence"],
    "recordingId": U["recording"],
    "clientRecordingId": U["client_recording"],
    "sealSha256": SEAL,
    "sourceManifestSha256": MANIFEST,
    "fileCount": 3,
    "totalBytes": "134222825",
    "files": FILES,
    "confirmedByUserId": STAFF,
    "verifiedAt": "2026-11-02T10:00:00.123Z",
    "confirmedAt": "2026-11-02T10:00:00.456Z",
}
PROOF = {
    "schemaVersion": 1,
    "proofId": U["request"],
    "recordingId": U["recording"],
    "clientRecordingId": U["client_recording"],
    "ownerUserId": OWNER,
    "sealSha256": SEAL,
    "sourceManifestSha256": MANIFEST,
    "confirmationId": U["evidence"],
    "confirmedAt": "2026-11-02T10:00:00.456Z",
    "verification": "rehash",
    "fileCount": 3,
    "totalBytes": "134222825",
    "files": FILES,
    "issuedAt": "2026-11-02T10:05:00.000Z",
    "expiresAt": "2026-11-02T10:06:00.000Z",
}


def confirm_cases():
    c = CONFIRM
    return [
        ok("staff confirmation request", c),
        mut(
            "owner identity is refused",
            c,
            [("/ownerUserId", OWNER)],
            "schema_violation",
        ),
        mut(
            "staff identity is refused",
            c,
            [("/confirmedByUserId", STAFF)],
            "schema_violation",
        ),
        mut(
            "seal digest is lowercase hex",
            c,
            [("/expectedSealSha256", "A" * 64)],
            "schema_violation",
            "/expectedSealSha256",
        ),
        mut(
            "file count lower bound",
            c,
            [("/expectedFileCount", 2)],
            "schema_violation",
            "/expectedFileCount",
        ),
        mut(
            "file count is an integer",
            c,
            [("/expectedFileCount", "3")],
            "schema_violation",
            "/expectedFileCount",
        ),
        mut(
            "sealed identities are required",
            {k: v for k, v in c.items() if k != "expectedSourceManifestSha256"},
            [],
            "schema_violation",
        ),
    ]


def proof_request_cases():
    c = PROOF_REQUEST
    return [
        ok("owner proof request", c),
        mut(
            "owner identity is refused",
            c,
            [("/ownerUserId", OWNER)],
            "schema_violation",
        ),
        mut(
            "client recording id is a UUID",
            c,
            [("/clientRecordingId", "not-a-uuid")],
            "schema_violation",
            "/clientRecordingId",
        ),
        mut(
            "manifest digest length",
            c,
            [("/sourceManifestSha256", "ab")],
            "schema_violation",
            "/sourceManifestSha256",
        ),
        mut(
            "client recording id is required",
            {k: v for k, v in c.items() if k != "clientRecordingId"},
            [],
            "schema_violation",
        ),
    ]


def confirmation_cases():
    c = CONFIRMATION
    return [
        ok("confirmation", c),
        mut("unknown field", c, [("/deleteSource", True)], "schema_violation"),
        mut(
            "schema version",
            c,
            [("/schemaVersion", 2)],
            "schema_violation",
            "/schemaVersion",
        ),
        mut(
            "evidence size is decimal text",
            c,
            [("/files/1/sizeBytes", 134217729)],
            "schema_violation",
            "/files/1/sizeBytes",
        ),
        mut(
            "evidence role is a source role",
            c,
            [("/files/1/role", "clip_mp4")],
            "schema_violation",
            "/files/1/role",
        ),
        mut(
            "evidence needs the three-file minimum",
            c,
            [("/files", FILES[:2])],
            "schema_violation",
            "/files",
        ),
        mut(
            "confirmation time is RFC 3339 UTC",
            c,
            [("/confirmedAt", "yesterday")],
            "schema_violation",
            "/confirmedAt",
        ),
    ]


def proof_cases():
    c = PROOF
    return [
        ok("fresh proof", c),
        mut(
            "a proof grants no storage capability",
            c,
            [("/signedUrl", "https://x.test/y")],
            "schema_violation",
        ),
        mut(
            "only a full re-hash is a proof",
            c,
            [("/verification", "head_bound")],
            "schema_violation",
            "/verification",
        ),
        mut(
            "expiry is required",
            {k: v for k, v in c.items() if k != "expiresAt"},
            [],
            "schema_violation",
        ),
        mut(
            "expiry is an RFC 3339 UTC instant",
            c,
            [("/expiresAt", "later")],
            "schema_violation",
            "/expiresAt",
        ),
        mut(
            "owner identity is an opaque id",
            c,
            [("/ownerUserId", "")],
            "schema_violation",
            "/ownerUserId",
        ),
        mut(
            "evidence digest",
            c,
            [("/files/2/sha256", "xyz")],
            "schema_violation",
            "/files/2/sha256",
        ),
    ]


def render_sa73():
    cases = {
        "http.source-copy-confirm.v1": confirm_cases(),
        "http.cleanup-proof-request.v1": proof_request_cases(),
        "http.source-copy-confirmation.v1": confirmation_cases(),
        "http.cleanup-proof.v1": proof_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa73()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-73 fixture files")
