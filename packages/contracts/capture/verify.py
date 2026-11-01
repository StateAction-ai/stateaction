"""Verify stateaction.capture.v1.1 schemas, pinned hashes, native asset copies and golden MCAP conformance.

  uv run --no-project --with jsonschema==4.25.1 --with mcap==1.6.0 --with protobuf==6.33.0 python packages/contracts/capture/verify.py

Checks: schema validity; manifest SHA-256 and byte-identical native assets; protocol fixtures; every golden
case reproduces golden/expected/<case>.json and cases.json; JSON evidence in accepted goldens validates
against the schemas embedded in the file; the independent official-library decode agrees with the reference
(exact decimal capture timestamps, counts, descriptor hash, ffmpeg decoded-frame count when available).
Pass extra `--mcap file...` to apply the JSON-schema/descriptor checks to actual producer output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, ValidationError, validators

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT / "conformance/python")]
import build_schemas  # noqa: E402
import capture_conformance as cc  # noqa: E402
import independent_decode  # noqa: E402
import strict_schema  # noqa: E402


def _fullmatch_pattern(validator, pattern, instance, schema):
    # JSON Schema patterns are ECMA-262; Python's `$` also matches before a trailing newline, so the
    # oracle uses whole-string matching exactly like every portable reader.
    if validator.is_type(instance, "string") and not re.fullmatch(pattern, instance):
        yield ValidationError(f"{instance!r} does not match {pattern!r}")


Oracle = validators.extend(Draft202012Validator, {"pattern": _fullmatch_pattern})


def oracle_violations(validator, instance) -> list[str]:
    return sorted(
        {
            "".join("/" + strict_schema.token(k) for k in e.absolute_path)
            + ":"
            + e.validator
            for e in validator.iter_errors(instance)
        }
    )


class Differential:
    """Every instance is validated by the portable interpreter and by jsonschema; sets must agree."""

    def __init__(self, oracles, portable):
        self.oracles, self.portable, self.count, self.rejected = oracles, portable, 0, 0

    def __call__(self, name, instance) -> list[str]:
        mine = self.portable[name].validate(instance)
        theirs = oracle_violations(self.oracles[name], instance)
        assert mine == theirs, (
            f"interpreter/jsonschema disagree on {name}: {mine} vs {theirs}: {instance!r}"
        )
        self.count += 1
        self.rejected += bool(mine)
        return mine


def mutations(value, rng, depth=0):
    """Small structural mutations of a valid JSON value (types, extra/missing keys, bounds)."""
    out = []
    if isinstance(value, dict):
        for k in list(value)[:12]:
            out.append({kk: vv for kk, vv in value.items() if kk != k})
            for sub in mutations(value[k], rng, depth + 1)[:6]:
                out.append({**value, k: sub})
        out.append({**value, "unexpected": 1})
    elif isinstance(value, list):
        out += [value[:-1], value + value[-1:], []]
        if value:
            for sub in mutations(value[0], rng, depth + 1)[:4]:
                out.append([sub] + value[1:])
    elif isinstance(value, str):
        out += [
            "",
            value + "\n",
            value.upper(),
            "x" * 300,
            "9" * 25,
            7,
            None,
            value + "\u00e9",
        ]
    elif isinstance(value, bool):
        out += [not value, 1, "true"]
    elif isinstance(value, (int, float)):
        out += [-1, value + 0.5, 2**32, 10**7, True, str(value), None]
    else:
        out += ["null", 0, {}]
    return out


def differential_messages(data: bytes, diff, rng) -> dict:
    """Validate every parseable JSON message (and mutations of it) with both validators."""
    try:
        f = cc.read_mcap(data)
    except (cc.Truncated, cc.Unsupported, cc.CrcMismatch, cc.Malformed):
        return {}
    counts = {}
    for m in f["messages"]:
        want = cc.CHANNELS.get(f["channels"][m["channel"]]["topic"])
        if want is None or want[2] != "json":
            continue
        try:
            value = strict_schema.parse_json(m["data"])
        except strict_schema.MalformedJson:
            continue
        diff(want[0], value)
        for mutated in rng.sample(
            mutations(value, rng), k=min(4, len(mutations(value, rng)))
        ):
            diff(want[0], mutated)
        counts[want[0]] = counts.get(want[0], 0) + 1
    return counts


def official_crc_status(path: Path) -> str:
    """Read with the official mcap reader and validate_crcs=True (independent CRC implementation)."""
    from mcap.exceptions import McapError
    from mcap.stream_reader import CRCValidationError, StreamReader

    try:
        with path.open("rb") as source:
            for _ in StreamReader(source, validate_crcs=True).records:
                pass
    except CRCValidationError:
        return "crc_error"
    except (McapError, ValueError, EOFError, struct_error()) as e:
        return f"unreadable:{type(e).__name__}"
    return "ok"


def struct_error():
    import struct

    return struct.error


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcap", nargs="*", type=Path, default=[])
    args = parser.parse_args()
    native = (
        ROOT.parents[1] / "stera_recorder/android/src/main/assets/stateaction/capture"
    )
    manifest = json.loads((ROOT / "manifest.json").read_text())
    for name, expected in manifest["files"].items():
        source = (ROOT / name).read_bytes()
        assert hashlib.sha256(source).hexdigest() == expected, (
            f"Contract hash mismatch: {name}"
        )
        assert (native / name).read_bytes() == source, f"Native asset drift: {name}"
    disk = (
        {p.name for p in ROOT.glob("*.schema.json")}
        | {p.name for p in ROOT.glob("*.ros2msg")}
        | {"foxglove-compressed-video.desc"}
    )
    assert disk <= set(manifest["files"]), (
        f"Unpinned contract files: {disk - set(manifest['files'])}"
    )
    assert all(
        (ROOT / f"{n}.schema.json").read_bytes() == build_schemas.render(b)
        for n, b in build_schemas.SCHEMAS.items()
    ), "schema files differ from build_schemas.py output"
    validators, portable = {}, {}
    for name, file in cc.CUSTOM.items():
        schema = json.loads((ROOT / file).read_text())
        Draft202012Validator.check_schema(schema)
        validators[name] = Oracle(schema)
        portable[name] = strict_schema.Schema(schema)
    diff = Differential(validators, portable)
    short = {n.split(".")[2]: n for n in validators}
    # direct interpreter cases (declared by hand; also checked against jsonschema)
    schema_cases = json.loads((ROOT / "fixtures/schema_cases.json").read_text())
    for case in schema_cases["cases"]:
        raw = (
            b"\xff\xfe" if case["json"] == "__INVALID_UTF8__" else case["json"].encode()
        )
        try:
            instance = strict_schema.parse_json(raw)
        except strict_schema.MalformedJson:
            assert case["expect"] == "malformed", case["name"]
            continue
        assert diff(short[case["schema"]], instance) == case["expect"], case["name"]
    for case in schema_cases["unsupported_schemas"]:
        try:
            strict_schema.Schema(case["schema"])
        except strict_schema.SchemaUnsupported:
            continue
        raise AssertionError(f"unsupported schema accepted: {case['name']}")
    fixture = json.loads((ROOT / "fixtures/protocol.json").read_text())
    count = 0
    for key, events in fixture.items():
        if key == "description":
            continue
        for event in events:
            assert diff(f"stateaction.capture.{key}.v1", event) == [], event
            count += 1
    original = fixture["FrameEvent"][0]
    assert int(original["mapped_capture_time_ns"]) > 2**53
    for invalid in [
        original | {"source_frame_id": 0},
        original | {"encoder_pts_us": 0},
        original | {"native_timestamp_ns": "-1"},
        original | {"state": "encoded"},
    ]:
        assert diff("stateaction.capture.FrameEvent.v1", invalid), (
            f"Invalid fixture admitted: {invalid}"
        )
    # golden corpus
    cases = json.loads((ROOT / "golden/cases.json").read_text())
    on_disk = {p.stem for p in (ROOT / "golden").glob("*.mcap")}
    assert on_disk == set(cases), (
        f"golden/cases.json out of sync: {on_disk ^ set(cases)}"
    )
    summary = {}
    rng = random.Random(50)
    for name, entry in sorted(cases.items()):
        data = (ROOT / "golden" / f"{name}.mcap").read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], (
            f"Golden drift: {name}"
        )
        result = cc.check(data)
        expected = (ROOT / "golden/expected" / f"{name}.json").read_text()
        assert cc.canonical(result) == expected, (
            f"Reference result differs from golden/expected/{name}.json"
        )
        assert (
            result["outcome"] == entry["expect"]
            and result["errors"] == entry["expected_errors"]
        )
        stripped = sorted(
            re.sub(r"\[[0-9]+\]", "", v, count=1)
            for v in result["facts"].get("schema_violations", [])
        )
        assert stripped == entry.get("expected_violations", []), name
        counts = differential_messages(data, diff, rng)
        crc = official_crc_status(ROOT / "golden" / f"{name}.mcap")
        if name.startswith("data_crc_") and name != "data_crc_zero":
            assert crc == "crc_error", (name, crc)
        if result["outcome"] == "accept":
            assert crc == "ok", (name, crc)
            ind = independent_decode.decode(ROOT / "golden" / f"{name}.mcap")
            assert ind["profile"] == ""
            assert (
                ind["schema_sha256"]["foxglove.CompressedVideo"]
                == manifest["files"]["foxglove-compressed-video.desc"]
            )
            assert [str(v["capture_ns"]) for v in ind["video"]] == [
                v["capture_time_ns"] for v in result["facts"]["video"]
            ]
            assert [str(v["log_time"]) for v in ind["video"]] == [
                v["log_time_ns"] for v in result["facts"]["video"]
            ]
            assert [v["sequence"] for v in ind["video"]] == [
                v["sequence"] for v in result["facts"]["video"]
            ]
            assert len(ind["video"]) == int(
                result["facts"]["frame_event_counts"]["written"]
            )
            if ind["decoded_frames"] is not None:
                assert ind["decoded_frames"] == len(ind["video"]) and not ind.get(
                    "ffmpeg_errors"
                ), ind
            summary[name] = {
                "json_messages": sum(counts.values()),
                "video": len(ind["video"]),
                "ffmpeg_decoded_frames": ind["decoded_frames"],
            }
        else:
            summary[name] = result["errors"]
    # encoder-output buffer contract: the reference assembler reproduces every declared expectation
    buffers = json.loads((ROOT / "fixtures/encoder_buffers.json").read_text())
    units = {k: cc.nals((ROOT / v).read_bytes()) for k, v in buffers["sources"].items()}
    for name, case in buffers["cases"].items():
        assert cc.assemble_encoder_buffers(case["buffers"], units) == case["expect"], (
            f"encoder buffer case {name}"
        )
    actual_counts, sources = {}, []
    for path in args.mcap:
        from mcap.reader import make_reader

        with path.open("rb") as source:
            reader = make_reader(source, validate_crcs=True)
            assert reader.get_header().profile == "", (
                f"Expected generic mixed-encoding MCAP: {path}"
            )
            seen = set()
            by_name = {n: validators[n] for n in validators}
            for schema, channel, message in reader.iter_messages():
                if (
                    schema.name == "foxglove.CompressedVideo"
                    and schema.name not in seen
                ):
                    assert (
                        hashlib.sha256(schema.data).hexdigest()
                        == manifest["files"]["foxglove-compressed-video.desc"]
                    ), "Emitted video descriptor drift"
                    seen.add(schema.name)
                if schema.name not in by_name:
                    continue
                if schema.name not in seen:
                    assert (
                        schema.data == (ROOT / cc.CUSTOM[schema.name]).read_bytes()
                    ), f"Emitted schema drift: {schema.name}"
                    seen.add(schema.name)
                assert (
                    diff(schema.name, strict_schema.parse_json(message.data)) == []
                ), f"{path}: {schema.name} message violates the strict schema"
                actual_counts[schema.name] = actual_counts.get(schema.name, 0) + 1
        with path.open("rb") as source:
            sources.append(
                {
                    "path": str(path),
                    "sha256": hashlib.file_digest(source, "sha256").hexdigest(),
                }
            )
    print(
        json.dumps(
            {
                "schemas": len(validators),
                "protocol_events": count,
                "rejected_mutations": 4,
                "schema_differential": {
                    "instances": diff.count,
                    "rejected": diff.rejected,
                },
                "schema_cases": len(schema_cases["cases"]),
                "unsupported_schemas_fail_closed": len(
                    schema_cases["unsupported_schemas"]
                ),
                "native_assets_match": True,
                "golden_cases": summary,
                "encoder_buffer_cases": len(buffers["cases"]),
                "sources": sources,
                "actual_messages": actual_counts,
                "descriptor_sha256": manifest["files"][
                    "foxglove-compressed-video.desc"
                ],
            },
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
