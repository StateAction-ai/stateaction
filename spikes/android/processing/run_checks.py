#!/usr/bin/env python3
"""Finite protocol/interoperability qualification; every fault is an MCAP input."""
import argparse
import io
import json
import platform
import sys
import time
from pathlib import Path

import zstandard
from mcap.records import Chunk, Header, DataEnd, Footer

from spike import (LIMIT, InvalidCapture, bounded_records, digest, dump, make_fixture,
                   process, read_access_units)


def rejected(fn, wanted=None):
    try:
        fn()
    except Exception as error:
        if wanted:
            assert wanted in str(error), (wanted, repr(error))
        return {"status": "passed", "exception": type(error).__name__, "reason": str(error)}
    raise AssertionError("Invalid input was accepted")


def consume(path):
    receipt = {}
    count = sum(1 for _ in read_access_units(path, receipt))
    return receipt | {"frames": count}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    checks = {}; started = time.monotonic()
    clean = args.output / "synthetic.mcap"
    fixture = make_fixture(clean)
    accepted = consume(clean)
    assert accepted["frames"] == 95
    assert accepted["source_sha256"] == digest(clean)
    assert accepted["association_peaks"]["pending_acquisitions"] == 3
    checks["mixed_schema_delayed_output_vfr_hash_and_unequal_clocks"] = {"status": "passed", "result": accepted}
    simulation = args.output / "simulation.mcap"
    disclosed = {"rgb_profile": "h264_mcap_simulation_v1", "qualification": "simulation_only",
                 "mapped_timeline_semantics": "simulation_transport_only", "production_qualified": False}
    make_fixture(simulation, profile_overrides=disclosed)
    checks["reject_simulation_profile_without_opt_in"] = rejected(lambda: consume(simulation), "explicit_opt_in")
    simulation_receipt = {}
    assert sum(1 for _ in read_access_units(simulation, simulation_receipt, allow_simulation_profile=True)) == 95
    checks["accept_disclosed_simulation_profile_only_with_opt_in"] = {"status": "passed"}
    undisclosed = args.output / "undisclosed-simulation.mcap"
    make_fixture(undisclosed, profile_overrides=disclosed | {"production_qualified": True})
    checks["reject_simulation_claiming_production_qualification"] = rejected(
        lambda: list(read_access_units(undisclosed, {}, allow_simulation_profile=True)), "simulation_profile_missing_disclosure")
    for fault, reason in [("duplicate_pts", "duplicate_or_nonmonotonic_pts"),
                          ("missing_config", "idr_missing_sps_pps"),
                          ("config_only", "config_only_or_empty_access_unit"),
                          ("wrong_capture_time", "capture_timestamp_mismatch"),
                          ("unresolved", "unresolved_frame_evidence"),
                          ("wrong_codec", "not_annex_b"), ("truncated", None)]:
        path = args.output / f"bad-{fault}.mcap"
        make_fixture(path, fault=fault)
        checks[f"reject_{fault}"] = rejected(lambda: consume(path), reason)
    # Trailing bytes must not be ignored by the source hash/closure validator.
    path = args.output / "bad-trailing.mcap"; path.write_bytes(clean.read_bytes() + b"unexpected")
    checks["reject_trailing_bytes"] = rejected(lambda: consume(path), "trailing_data")
    # A small compressed payload lying about its expanded length cannot force
    # unbounded allocation. Build a real MCAP chunk for the guard, not a mock.
    expanded = b"\0" * (LIMIT + 1)
    chunk = Chunk(compression="zstd", data=zstandard.ZstdCompressor().compress(expanded),
                  message_start_time=0, message_end_time=0, uncompressed_crc=0, uncompressed_size=1)
    data = io.BytesIO(); data.write(b"\x89MCAP0\r\n")
    from mcap.data_stream import RecordBuilder
    builder = RecordBuilder()
    Header(profile="", library="spike-fault-fixture").write(builder)
    chunk.write(builder); DataEnd(data_section_crc=0).write(builder)
    Footer(summary_start=0, summary_offset_start=0, summary_crc=0).write(builder)
    data.write(builder.end()); data.write(b"\x89MCAP0\r\n"); data.seek(0)
    checks["reject_actual_decompression_bomb"] = rejected(lambda: list(bounded_records(data)), "actual_decompressed_chunk_limit")
    result = process(clean, args.output / "processed")
    assert result["frames"] == 95 and len(result["clips"]) == 4
    assert [c["first_source_frame_id"] for c in result["clips"]] == ["0", "30", "60", "90"]
    assert all(c["decoded_mp4_pts_exact"] for c in result["clips"])
    assert sum(c["detected_hands"] for c in result["clips"]) == 0
    checks["cpu_hands_idr_remux_rrd_no_hand_masks"] = {"status": "passed", "result": result}
    checks["reject_hash_mismatch_no_acceptance_receipt"] = rejected(
        lambda: process(clean, args.output / "bad-hash-output", expected_sha256="0" * 64), "source_hash_mismatch")
    assert not (args.output / "bad-hash-output" / "receipt.json").exists()
    # B-frame input is rejected either at source PTS-order or decoder delay:
    # no reordered stream is accepted as the no-B capture profile.
    path = args.output / "bad-b-frames.mcap"; make_fixture(path, fault="b_frames")
    checks["reject_b_frame_stream"] = rejected(lambda: process(path, args.output / "bad-b-frames-output"))
    receipt = {"status": "passed", "fixture_kind": "synthetic_software_h264", "checks": checks,
               "seconds": time.monotonic() - started, "platform": platform.platform(), "python": sys.version,
               "source_fixture": fixture, "limitations": ["No hardware encoder or real-phone evidence.",
                   "No production workflow, API, object storage or auth integration.",
                   "Finite 320x192 fixture is not a throughput, quality or two-hour memory qualification."]}
    dump(args.output / "checks.json", receipt)
    print(json.dumps({"status": receipt["status"], "checks": len(checks), "receipt": str(args.output / "checks.json")}))


if __name__ == "__main__":
    main()
