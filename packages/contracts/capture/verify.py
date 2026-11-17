"""Verify stateaction.capture.v1.1 and v1.2 schemas, pinned hashes, native asset copies and golden MCAP conformance.

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


def table_of(f: dict) -> dict:
    return cc.CHANNELS12 if cc.uses_v12(f) else cc.CHANNELS


def differential_messages(data: bytes, diff, rng) -> dict:
    """Validate every parseable JSON message (and mutations of it) with both validators."""
    try:
        f = cc.read_mcap(data)
    except (
        cc.Truncated,
        cc.Unsupported,
        cc.CrcMismatch,
        cc.DefinitionOrder,
        cc.DefinitionConflict,
    ):
        return {}
    counts = {}
    table = table_of(f)
    for m in f["messages"]:
        want = table.get(f["channels"][m["channel"]]["topic"])
        if want is None or want[2] != "json":
            continue
        try:
            value = strict_schema.parse_json(m["data"])
        except strict_schema.MalformedJson:
            continue
        if len(m["data"]) > cc.JSON_MESSAGE_MAX:
            continue  # the v1.2 cap rejects it before any schema evaluation
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


def official_topics(path: Path):
    """Topic -> message count as the official mcap reader interprets the file, or the error type."""
    from mcap.exceptions import McapError
    from mcap.reader import make_reader

    try:
        with path.open("rb") as source:
            counts: dict[str, int] = {}
            for _, channel, _ in make_reader(
                source, validate_crcs=True
            ).iter_messages():
                counts[channel.topic] = counts.get(channel.topic, 0) + 1
            return dict(sorted(counts.items()))
    except (McapError, ValueError, EOFError, KeyError, struct_error()) as e:
        return f"error:{type(e).__name__}"


# Why definition order/conflicts are rejects: the official reader errors on use-before-definition and
# silently follows the latest redefinition, so the same bytes would mean different topics to other tools.
OFFICIAL_DEFINITION = {
    "channel_after_messages": "error:McapError",
    "schema_after_channel": "error:McapError",
}


def struct_error():
    import struct

    return struct.error


def build_raw_recipe(recipe: dict) -> bytes:
    import gen_golden_v12 as g12

    return g12.build_raw(recipe)


def verify_v12(manifest12: dict, diff, validators, rng) -> dict:
    """stateaction.capture.v1.2: direct schema cases, RawImage decode cases, golden corpus, official
    decoders, the max-revision (frozen reader) verdicts."""
    import gen_golden
    import gen_golden_v12 as g12

    g12.G, g12.cc = gen_golden, cc
    sc = json.loads((ROOT / "fixtures/schema_cases.v1.2.json").read_text())
    for case in sc["cases"]:
        value = strict_schema.parse_json(case["json"].encode())
        assert diff(case["schema"], value) == case["expect"], case["name"]
    raws = json.loads((ROOT / "fixtures/raw_image_cases.v1.2.json").read_text())
    raw_ok = 0
    for case in raws["cases"]:
        data = (
            bytes.fromhex(case["hex"])
            if "hex" in case
            else build_raw_recipe(case["build"])
        )
        try:
            cc.decode_raw_image(data)
            verdict = "ok"
        except (ValueError, UnicodeDecodeError):
            verdict = "malformed"
        assert verdict == case["expect"], case["name"]
        raw_ok += verdict == "ok"
    cases = json.loads((ROOT / "golden/v1.2/cases.json").read_text())
    on_disk = {p.stem for p in (ROOT / "golden/v1.2").glob("*.mcap")}
    assert on_disk == set(cases), f"golden/v1.2 out of sync: {on_disk ^ set(cases)}"
    summary = {}
    for name, entry in sorted(cases.items()):
        path = ROOT / "golden/v1.2" / f"{name}.mcap"
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], (
            f"Golden drift: {name}"
        )
        result = cc.check(data)
        assert (
            cc.canonical(result)
            == (ROOT / "golden/v1.2/expected" / f"{name}.json").read_text()
        ), name
        assert (
            result["outcome"] == entry["expect"]
            and result["errors"] == entry["expected_errors"]
        ), name
        stripped = sorted(
            re.sub(r"\[[0-9]+\]", "", v, count=1)
            for v in result["facts"].get("schema_violations", [])
        )
        assert stripped == entry.get("expected_violations", []), name
        # a frozen v1.1 reader (max_revision v1.1) must reject every v1.2 file
        old = cc.check(data, max_revision="v1.1")
        assert {"outcome": old["outcome"], "errors": old["errors"]} == entry[
            "v1_1_reader"
        ], name
        assert old["outcome"] == "reject", name
        differential_messages(data, diff, rng)
        crc = official_crc_status(path)
        if result["outcome"] == "accept":
            assert crc == "ok", (name, crc)
            ind = independent_decode.decode(path)
            facts = result["facts"]
            assert ind["profile"] == ""
            assert (
                ind["schema_sha256"].get(
                    "foxglove.RawImage", manifest12["files"][cc.RAW_IMAGE_DESC]
                )
                == manifest12["files"][cc.RAW_IMAGE_DESC]
            )
            assert [v["sequence"] for v in ind["video"]] == [
                v["sequence"] for v in facts["video"]
            ]
            # RawImage bytes: the official protobuf runtime agrees with the reference decoder and the facts
            depth = facts["depth"]
            expect_images = len(ind["images"])
            counted = sum(
                1 + (d["confidence_state"] == "separate_image") for d in depth
            )
            assert expect_images == counted, (name, expect_images, counted)
            for img in ind["images"]:
                assert img["step"] * img["height"] == img["bytes"], name
                assert img["frame_id"] == cc.DEPTH_FRAME_ID
                assert img["encoding"] in ("16UC1", "mono8")
            depth_shas = sorted(
                i["sha256"] for i in ind["images"] if i["encoding"] == "16UC1"
            )
            assert depth_shas == sorted(d["depth_sha256"] for d in depth), name
            conf_shas = sorted(
                i["sha256"] for i in ind["images"] if i["encoding"] == "mono8"
            )
            assert conf_shas == sorted(
                d["confidence_sha256"] for d in depth if d["confidence_sha256"]
            ), name
            assert official_topics(path) is not None
            summary[name] = {"depth_events": len(depth), "images": expect_images}
        else:
            summary[name] = result["errors"]
    return {
        "schema_cases": len(sc["cases"]),
        "raw_image_cases": len(raws["cases"]),
        "raw_image_ok": raw_ok,
        "golden_cases": summary,
    }


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
    manifest12 = json.loads((ROOT / cc.MANIFEST_V12).read_text())
    assert manifest12["wire_contract_revision"] == "stateaction.capture.v1.2"
    for name, expected in manifest12["files"].items():
        source = (ROOT / name).read_bytes()
        assert hashlib.sha256(source).hexdigest() == expected, (
            f"v1.2 contract hash mismatch: {name}"
        )
        assert (native / name).read_bytes() == source, (
            f"v1.2 native asset drift: {name}"
        )
    assert (native / cc.MANIFEST_V12).read_bytes() == (
        ROOT / cc.MANIFEST_V12
    ).read_bytes(), "v1.2 native manifest drift"
    # Every native asset must be pinned by one manifest (no stray or stale copies).
    pinned = set(manifest["files"]) | set(manifest12["files"]) | {cc.MANIFEST_V12}
    stray = {p.name for p in native.iterdir() if p.is_file()} - pinned
    assert not stray, f"Unpinned native assets: {stray}"
    # v1.1 stays frozen: its manifest never lists a v1.2 file; v1.2 reuses the v1.1 bytes unchanged.
    new_files = {
        *cc.CUSTOM12.values(),
        cc.RAW_IMAGE_DESC,
        "schema-provenance.raw-image.json",
    }
    assert not new_files & set(manifest["files"]), "v1.1 manifest lists a v1.2 file"
    for name, digest in manifest["files"].items():
        if name in manifest12["files"]:
            assert manifest12["files"][name] == digest, f"reused file differs: {name}"
    assert set(manifest12["files"]) == (
        (set(manifest["files"]) - {"Profile.schema.json", "Close.schema.json"})
        | new_files
    ), "manifest.v1.2.json file set"
    provenance = json.loads((ROOT / "schema-provenance.raw-image.json").read_text())
    assert provenance["descriptor_sha256"] == manifest12["files"][cc.RAW_IMAGE_DESC]
    disk = (
        {p.name for p in ROOT.glob("*.schema.json")}
        | {p.name for p in ROOT.glob("*.ros2msg")}
        | {"foxglove-compressed-video.desc", cc.RAW_IMAGE_DESC}
    )
    assert disk <= set(manifest["files"]) | set(manifest12["files"]), (
        f"Unpinned contract files: {disk - set(manifest['files']) - set(manifest12['files'])}"
    )
    assert all(
        (ROOT / f"{n}.schema.json").read_bytes() == build_schemas.render(b)
        for n, b in {**build_schemas.SCHEMAS, **build_schemas.SCHEMAS12}.items()
    ), "schema files differ from build_schemas.py output"
    validators, portable = {}, {}
    for name, file in {**cc.CUSTOM, **cc.CUSTOM12}.items():
        schema = json.loads((ROOT / file).read_text())
        Draft202012Validator.check_schema(schema)
        validators[name] = Oracle(schema)
        portable[name] = strict_schema.Schema(schema)
    diff = Differential(validators, portable)
    short = {n.split(".")[2]: n for n in cc.CUSTOM}
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
        if name in OFFICIAL_DEFINITION:
            got = official_topics(ROOT / "golden" / f"{name}.mcap")
            assert got == OFFICIAL_DEFINITION[name], (name, got)
        if name == "bogus_channel_redefined_after_messages":
            got = official_topics(ROOT / "golden" / f"{name}.mcap")
            assert got.get("/bogus/topic", 0) > 0, (name, got)
            assert "/stateaction/frame_events" not in got, (name, got)
        if name == "identical_duplicate_definitions":
            assert official_topics(ROOT / "golden" / f"{name}.mcap") == official_topics(
                ROOT / "golden/valid.mcap"
            ), name
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
    v12_summary = verify_v12(manifest12, diff, validators, rng)
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
                "v12": v12_summary,
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
