#!/usr/bin/env python3
"""SA-35 additive conformance fixtures for the catalog.v8 dataset contracts.

Only NEW fixture files are produced here (one per added contract id); every
published fixture stays authored, unchanged, by generate_fixtures.py, which
includes these files in its reproducibility check. Every adapter (TS, Python,
Dart) runs the same files. Cases omit error paths for oneOf documents because
engines report different branch paths; the error code is the shared contract.
"""

from __future__ import annotations

from generate_fixtures import DELETE, OUT, U, bad, dump, mut, ok

DS = "00000000-0000-4000-8000-00000000d001"
CLIP = U["clip"]
T1 = "2026-11-02T14:00:00.123456Z"
SIM = {
    "simulated": True,
    "qualification": "simulation_only",
    "productionQualified": False,
}


def create_cases():
    base = {"datasetId": DS, "name": "Kitchen pours"}
    return [
        ok("create", base),
        mut("name at the bound", base, [("/name", "a" * 120)], None),
        mut("name too long", base, [("/name", "a" * 121)], "schema_violation", "/name"),
        mut(
            "name required non-empty",
            base,
            [("/name", "")],
            "schema_violation",
            "/name",
        ),
        mut(
            "client chooses a UUID",
            base,
            [("/datasetId", "not-a-uuid")],
            "schema_violation",
            "/datasetId",
        ),
        mut(
            "datasetId required", base, [("/datasetId", DELETE)], "schema_violation", ""
        ),
        mut("closed object", base, [("/createdBy", "x")], "schema_violation", ""),
    ]


def update_cases():
    base = {"name": "Renamed", "expectedRevision": 3}
    return [
        ok("rename", base),
        mut(
            "revision is positive",
            base,
            [("/expectedRevision", 0)],
            "schema_violation",
            "/expectedRevision",
        ),
        mut(
            "revision is an integer",
            base,
            [("/expectedRevision", 1.5)],
            "schema_violation",
            "/expectedRevision",
        ),
        mut(
            "revision required",
            base,
            [("/expectedRevision", DELETE)],
            "schema_violation",
            "",
        ),
        mut("closed object", base, [("/admin", True)], "schema_violation", ""),
    ]


def members_cases():
    base = {"clipIds": [CLIP], "expectedRevision": 2}
    return [
        ok("one clip", base),
        mut(
            "one hundred clips",
            base,
            [("/clipIds", [f"00000000-0000-4000-8000-{i:012x}" for i in range(100)])],
            None,
        ),
        mut(
            "at least one clip",
            base,
            [("/clipIds", [])],
            "schema_violation",
            "/clipIds",
        ),
        mut(
            "at most one hundred clips",
            base,
            [("/clipIds", [f"00000000-0000-4000-8000-{i:012x}" for i in range(101)])],
            "schema_violation",
            "/clipIds",
        ),
        mut(
            "clip IDs are UUIDs",
            base,
            [("/clipIds", ["x"])],
            "schema_violation",
            "/clipIds/0",
        ),
        mut(
            "review status is never client supplied",
            base,
            [("/reviewStatus", "approved")],
            "schema_violation",
            "",
        ),
    ]


def read_create_cases():
    return [
        ok("thumbnail", {"role": "thumbnail_jpeg"}),
        ok("viewer", {"role": "viewer_rrd"}),
        bad("raw video has no path", {"role": "clip_mp4"}, "schema_violation", "/role"),
        bad(
            "source MCAP has no path",
            {"role": "source_mcap"},
            "schema_violation",
            "/role",
        ),
        bad("role required", {}, "schema_violation", ""),
        bad(
            "no object keys from the client",
            {"role": "viewer_rrd", "objectKey": "x"},
            "schema_violation",
            "",
        ),
    ]


def dataset_doc():
    return {
        "datasetId": DS,
        "name": "Kitchen pours",
        "clipCount": 3,
        "durationNs": "2700",
    }


def dataset_cases():
    d = dataset_doc()
    staff = {**d, "revision": 4, "createdAt": T1}
    return [
        ok("customer shape", d),
        ok("staff shape", staff),
        mut(
            "count is a safe integer",
            d,
            [("/clipCount", -1)],
            "schema_violation",
            "/clipCount",
        ),
        mut(
            "duration is decimal text",
            d,
            [("/durationNs", 2700)],
            "schema_violation",
            "/durationNs",
        ),
        mut(
            "no collector or owner detail",
            d,
            [("/createdBy", "user-1")],
            "schema_violation",
            "",
        ),
        mut("no grant detail", d, [("/grants", [])], "schema_violation", ""),
    ]


def page_cases():
    d = dataset_doc()
    return [
        ok("empty last page", {"datasets": [], "nextCursor": None}),
        ok("page with cursor", {"datasets": [d], "nextCursor": "WyIyMDI2IiwiaWQiXQ"}),
        bad(
            "cursor is null or text",
            {"datasets": [], "nextCursor": 1},
            "schema_violation",
        ),
        bad(
            "items follow the dataset contract",
            {"datasets": [{**d, "owner": "x"}], "nextCursor": None},
            "schema_violation",
        ),
        bad("cursor required", {"datasets": []}, "schema_violation"),
    ]


def clip_doc():
    return {
        "clipId": CLIP,
        "title": "Pour water",
        "taskLabel": "pour water",
        "durationNs": "900",
        "raster": {"width": 64, "height": 48},
        "frameCount": 3,
        "simulation": None,
        "media": {"thumbnail": True, "viewer": True},
    }


def clip_cases():
    c = clip_doc()
    staff = {
        **c,
        "datasetId": DS,
        "recordingId": U["recording"],
        "jobId": U["job"],
        "reviewRevision": 2,
    }
    return [
        ok("hardware clip", c),
        ok("dataset context", {**c, "datasetId": DS}),
        ok("staff identifiers", staff),
        ok("simulation-only marker", {**c, "simulation": SIM}),
        ok("unlabelled clip", {**c, "taskLabel": None}),
        mut(
            "marker cannot claim production qualification",
            {**c, "simulation": SIM},
            [("/simulation/productionQualified", True)],
            "schema_violation",
        ),
        mut(
            "marker cannot be hardware",
            {**c, "simulation": SIM},
            [("/simulation/qualification", "hardware")],
            "schema_violation",
        ),
        mut("no internal notes", c, [("/notes", "qc")], "schema_violation", ""),
        mut(
            "no object keys",
            c,
            [("/objectKey", "jobs/x/outputs/y")],
            "schema_violation",
            "",
        ),
        mut("no hashes", c, [("/sha256", "0" * 64)], "schema_violation", ""),
        mut("no collector detail", c, [("/ownerUserId", "u")], "schema_violation", ""),
        mut("media flags required", c, [("/media", DELETE)], "schema_violation", ""),
        mut(
            "frame count is positive",
            c,
            [("/frameCount", 0)],
            "schema_violation",
            "/frameCount",
        ),
    ]


def clip_page_cases():
    c = clip_doc()
    return [
        ok("empty last page", {"clips": [], "nextCursor": None}),
        ok("page with cursor", {"clips": [c], "nextCursor": "abc"}),
        bad(
            "items follow the clip contract",
            {"clips": [{**c, "jobId": "x"}], "nextCursor": None},
            "schema_violation",
        ),
        bad("cursor required", {"clips": []}, "schema_violation"),
    ]


def staff_page_cases():
    c = {
        **clip_doc(),
        "recordingId": U["recording"],
        "jobId": U["job"],
        "reviewRevision": 0,
        "reviewStatus": "pending",
        "datasetCount": 0,
    }
    return [
        ok("pending clip", {"clips": [c], "nextCursor": None}),
        ok(
            "approved in two datasets",
            {
                "clips": [
                    {
                        **c,
                        "reviewStatus": "approved",
                        "reviewRevision": 1,
                        "datasetCount": 2,
                    }
                ],
                "nextCursor": "x",
            },
        ),
        bad(
            "status is closed",
            {"clips": [{**c, "reviewStatus": "maybe"}], "nextCursor": None},
            "schema_violation",
        ),
        bad(
            "staff fields required",
            {
                "clips": [{k: v for k, v in c.items() if k != "recordingId"}],
                "nextCursor": None,
            },
            "schema_violation",
        ),
        bad(
            "no internal notes even for staff",
            {"clips": [{**c, "notes": "qc"}], "nextCursor": None},
            "schema_violation",
        ),
    ]


def read_cases():
    base = {
        "url": "http://127.0.0.1:19000/bucket/jobs/j/outputs/f/e1/thumbnail.jpg?X-Amz-Expires=60&X-Amz-Signature=abc",
        "role": "thumbnail_jpeg",
        "contentType": "image/jpeg",
        "sizeBytes": "4096",
        "expiresAt": "2026-11-02T14:01:00.000Z",
        "ttlSeconds": 60,
    }
    return [
        ok("thumbnail read", base),
        ok(
            "viewer read",
            {
                **base,
                "role": "viewer_rrd",
                "contentType": "application/octet-stream",
                "sizeBytes": "134217728",
            },
        ),
        mut(
            "ttl is bounded",
            base,
            [("/ttlSeconds", 61)],
            "schema_violation",
            "/ttlSeconds",
        ),
        mut(
            "ttl is positive",
            base,
            [("/ttlSeconds", 0)],
            "schema_violation",
            "/ttlSeconds",
        ),
        mut(
            "only derived roles",
            base,
            [("/role", "clip_mp4")],
            "schema_violation",
            "/role",
        ),
        mut(
            "url is http(s)",
            base,
            [("/url", "ftp://host/key")],
            "schema_violation",
            "/url",
        ),
        mut(
            "no object key beside the url",
            base,
            [("/objectKey", "k")],
            "schema_violation",
            "",
        ),
    ]


def change_cases():
    return [
        ok("created", {"datasetId": DS, "revision": 1}),
        ok("renamed", {"revision": 2}),
        ok("added", {"added": 3, "revision": 3}),
        ok("removed", {"removed": True, "revision": 4}),
        bad("revision required", {"added": 1}, "schema_violation"),
        bad(
            "added is bounded",
            {"added": 101, "revision": 2},
            "schema_violation",
            "/added",
        ),
        bad("closed object", {"revision": 2, "members": []}, "schema_violation"),
    ]


def render_sa35():
    cases = {
        "http.dataset-create.v1": create_cases(),
        "http.dataset-update.v1": update_cases(),
        "http.dataset-members-add.v1": members_cases(),
        "http.clip-read-create.v1": read_create_cases(),
        "http.dataset.v1": dataset_cases(),
        "http.dataset-page.v1": page_cases(),
        "http.dataset-clip.v1": clip_cases(),
        "http.dataset-clip-page.v1": clip_page_cases(),
        "http.staff-clip-page.v1": staff_page_cases(),
        "http.clip-read.v1": read_cases(),
        "http.dataset-change.v1": change_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa35()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-35 fixture files")
