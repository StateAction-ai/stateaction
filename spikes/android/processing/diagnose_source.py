#!/usr/bin/env python3
"""Explain why a capture is rejected: container layer vs. payload layer (diagnostic only, stdlib).

Never an acceptance path. It runs the same strict gate as `probe.py process`. If the strict indexed
container check fails only because chunk/data CRCs are zero (old prototype writers), it re-validates
the container with zero CRCs tolerated (nonzero CRCs are still checked). It then reports what the
published SA-50 reference checker says about the payloads, so producer owners get concrete
mismatches. The output marks itself DIAGNOSTIC_ONLY and is never a probe receipt.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

import indexed_mcap
import strict_capture as sc
from strict_capture import cc

ZERO_CRC = {"E_CONTAINER_CHUNK_CRC_ABSENT", "E_CONTAINER_DATA_CRC_ABSENT"}


def diagnose(path: Path) -> dict:
    data = sc.read_bounded(path, sc.DEFAULT_MAX_SOURCE_BYTES)
    out: dict = {
        "DIAGNOSTIC_ONLY": "not an acceptance result; the strict gate verdict is `strict_gate`",
        "source_sha256": hashlib.sha256(data).hexdigest(),
        "source_bytes": len(data),
    }
    try:
        cap = sc.gate(data)
        out["strict_gate"] = {"outcome": "accept", "container": cap.container}
        return out
    except sc.CaptureRejected as e:
        out["strict_gate"] = {"outcome": "reject", "code": e.code, "detail": e.detail}
    detail = out["strict_gate"]["detail"] or {}
    container_errors = set(detail.get("indexed_container", {}).get("errors", []))
    if not (container_errors and container_errors <= ZERO_CRC):
        return out
    try:
        container = indexed_mcap.validate(data, crcs_required=False)
    except indexed_mcap.ContainerRejected as e:
        out["container_with_zero_crcs_tolerated"] = {
            "errors": [e.code],
            "detail": e.detail,
        }
        return out
    out["container_with_zero_crcs_tolerated"] = container.facts
    result = cc.check(indexed_mcap.flat_projection(container))
    violations = result["facts"].get("schema_violations", [])
    by_kind = Counter(
        (v.split("[", 1)[0], v.rsplit(":", 1)[-1]) for v in violations
    )  # (topic, keyword)
    manifest = json.loads((cc.CAPTURE_DIR / "manifest.json").read_text())["files"]
    schemas = cc.read_mcap(indexed_mcap.flat_projection(container))["schemas"]
    topics = {
        m.channel: container.channel_topics[m.channel] for m in container.messages
    }
    counts = Counter(topics[m.channel] for m in container.messages)
    out["payload_reference_checker"] = {
        "outcome": result["outcome"],
        "errors": result["errors"],
        "schema_violation_counts": sorted(
            ({"topic": t, "keyword": k, "count": n} for (t, k), n in by_kind.items()),
            key=lambda d: (d["topic"], d["keyword"]),
        ),
        "embedded_schema_matches_manifest": {
            s["name"]: hashlib.sha256(s["data"]).hexdigest()
            == manifest.get(
                cc.CUSTOM.get(s["name"], "foxglove-compressed-video.desc")
                if s["name"] in cc.CUSTOM or s["name"] == cc.VIDEO_SCHEMA
                else "",
            )
            for s in schemas.values()
        },
        "topics_outside_contract": sorted(
            set(container.channel_topics.values()) - set(cc.CHANNELS)
        ),
        "message_counts": dict(sorted(counts.items())),
        "missing_singletons": [t for t in cc.SINGLETON_TOPICS if counts.get(t, 0) != 1],
    }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", type=Path)
    print(json.dumps(diagnose(ap.parse_args().source), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
