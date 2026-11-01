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
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT / "conformance/python")]
import capture_conformance as cc  # noqa: E402
import independent_decode  # noqa: E402


def validate_json_messages(data: bytes, validators: dict) -> dict:
    f = cc.read_mcap(data)
    counts = {}
    for m in f["messages"]:
        ch = f["channels"][m["channel"]]
        schema = f["schemas"][ch["schema_id"]]
        if schema["name"] in validators:
            assert schema["data"] == (ROOT / cc.CUSTOM[schema["name"]]).read_bytes(), (
                f"Emitted schema drift: {schema['name']}"
            )
            validators[schema["name"]].validate(json.loads(m["data"]))
            counts[schema["name"]] = counts.get(schema["name"], 0) + 1
    return counts


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
    validators = {}
    for name, file in cc.CUSTOM.items():
        schema = json.loads((ROOT / file).read_text())
        Draft202012Validator.check_schema(schema)
        validators[name] = Draft202012Validator(schema)
    fixture = json.loads((ROOT / "fixtures/protocol.json").read_text())
    count = 0
    for key, events in fixture.items():
        if key == "description":
            continue
        for event in events:
            validators[f"stateaction.capture.{key}.v1"].validate(event)
            count += 1
    original = fixture["FrameEvent"][0]
    assert int(original["mapped_capture_time_ns"]) > 2**53
    for invalid in [
        original | {"source_frame_id": 0},
        original | {"encoder_pts_us": 0},
        original | {"native_timestamp_ns": "-1"},
        original | {"state": "encoded"},
    ]:
        assert not validators["stateaction.capture.FrameEvent.v1"].is_valid(invalid), (
            f"Invalid fixture admitted: {invalid}"
        )
    # golden corpus
    cases = json.loads((ROOT / "golden/cases.json").read_text())
    on_disk = {p.stem for p in (ROOT / "golden").glob("*.mcap")}
    assert on_disk == set(cases), (
        f"golden/cases.json out of sync: {on_disk ^ set(cases)}"
    )
    summary = {}
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
        if result["outcome"] == "accept":
            counts = validate_json_messages(data, validators)
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
            reader = make_reader(source)
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
                by_name[schema.name].validate(json.loads(message.data))
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
