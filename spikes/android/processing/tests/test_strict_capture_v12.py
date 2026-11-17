"""Consumer gate over the stateaction.capture.v1.2 corpus (flat and synthetic indexed layouts).

Fixtures are the published SA-68 synthetic goldens; nothing here is a measurement or a recording
qualification. The gate only reports capture integrity; `auto_admissible` is never device/server
qualification.
"""

from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import indexed_fixture as fx  # noqa: E402
import indexed_mcap as im  # noqa: E402
import strict_capture as sc  # noqa: E402

GOLDEN = sc.REPO / "packages/contracts/capture/golden/v1.2"
CASES = json.loads((GOLDEN / "cases.json").read_text())
# The gate additionally requires H.264 video; accepted files without it are reader-accepted but not
# consumable by this video gate, and must fail with a gate error rather than crash.
ACCEPTED = sorted(n for n, c in CASES.items() if c["expect"] == "accept")
REJECTED = sorted(n for n, c in CASES.items() if c["expect"] != "accept")


def payloads(parsed: dict) -> list[tuple[str, bytes]]:
    topics = {cid: ch["topic"] for cid, ch in parsed["channels"].items()}
    return [(topics[m["channel"]], m["data"]) for m in parsed["messages"]]


class V12FlatGateTest(unittest.TestCase):
    def test_corpus_is_nonvacuous(self):
        self.assertEqual(len(CASES), 106)
        self.assertEqual(len(ACCEPTED), 14)

    def test_accepted_goldens_pass_gate_with_original_sha(self):
        for name in ACCEPTED:
            with self.subTest(case=name):
                cap = sc.load(
                    GOLDEN / f"{name}.mcap", expected_sha256=CASES[name]["sha256"]
                )
                self.assertEqual(cap.container["layout"], "flat_portable")
                self.assertEqual(
                    cap.facts["wire_contract_revision"], "stateaction.capture.v1.2"
                )
                self.assertEqual(cap.source_sha256, CASES[name]["sha256"])

    def test_rejected_goldens_are_rejected_with_reference_errors(self):
        for name in REJECTED:
            with self.subTest(case=name):
                with self.assertRaises(sc.CaptureRejected) as err:
                    sc.load(GOLDEN / f"{name}.mcap")
                self.assertEqual(err.exception.code, "E_CAPTURE_NOT_ACCEPTED")
                self.assertEqual(
                    sorted(err.exception.detail["errors"]),
                    sorted(CASES[name]["expected_errors"]),
                )

    def test_clean_abort_passes_gate_but_is_never_auto_admissible(self):
        low = sc.load(GOLDEN / "v12_aborted_low_storage_clean.mcap")
        self.assertEqual(low.facts["close_outcome"], "aborted")
        self.assertIs(low.auto_admissible, False)
        deadline = sc.load(GOLDEN / "v12_aborted_encoder_deadline_unresolved.mcap")
        self.assertIs(deadline.auto_admissible, False)
        s = sc.summary(low)
        self.assertIs(s["auto_admissible"], False)
        self.assertEqual(s["close_stop_reason"], "low_storage_reserve")
        self.assertIn("not_server_or_device_qualification", s["auto_admissible_scope"])
        completed = sc.load(GOLDEN / "v12_valid_calibration_only.mcap")
        self.assertIs(completed.auto_admissible, True)

    def test_frozen_v11_has_no_auto_admissible_fact(self):
        old = sc.load(sc.REPO / "packages/contracts/capture/golden/valid.mcap")
        self.assertIsNone(old.auto_admissible)
        self.assertEqual(
            sc.summary(old)["wire_contract_revision"], "stateaction.capture.v1.1"
        )

    def test_calibration_and_depth_facts_are_the_original_evidence(self):
        cap = sc.load(GOLDEN / "v12_depth_raw_unknown_mapping_reprojected.mcap")
        depth = cap.facts["depth"]
        self.assertEqual(
            [d["estimate_provenance"] for d in depth],
            ["new_estimate", "reprojected", "new_estimate", "api_repeat"],
        )
        # Equal native timestamps are kept as distinct events; arbitrary repeats are labelled.
        self.assertEqual(
            depth[0]["native_timestamp_ns"], depth[1]["native_timestamp_ns"]
        )
        parsed = sc.cc.read_mcap(
            (GOLDEN / "v12_depth_raw_unknown_mapping_reprojected.mcap").read_bytes()
        )
        raw = [d for t, d in payloads(parsed) if t == "/camera/depth_raw/image"]
        self.assertEqual(
            [
                hashlib.sha256(sc.cc.decode_raw_image(r)["data"]).hexdigest()
                for r in raw
            ],
            [d["depth_sha256"] for d in depth],
        )
        cal = sc.load(GOLDEN / "v12_valid_calibration_only.mcap")
        self.assertEqual(cal.facts["calibrations_used"], ["rgb_0"])


class V12IndexedGateTest(unittest.TestCase):
    def test_indexed_reframing_of_every_accepted_golden_is_equivalent(self):
        for name in ACCEPTED:
            flat = (GOLDEN / f"{name}.mcap").read_bytes()
            for per_chunk in (1, 5, 1000):
                with self.subTest(case=name, per_chunk=per_chunk):
                    indexed = fx.chunked(flat, messages_per_chunk=per_chunk)
                    cap = sc.gate(indexed)
                    ref = sc.gate(flat)
                    self.assertEqual(cap.result, ref.result)
                    self.assertEqual(
                        cap.source_sha256, hashlib.sha256(indexed).hexdigest()
                    )
                    self.assertEqual(
                        cap.container["original_on_portable_reader"],
                        ["E_UNSUPPORTED_LAYOUT"],
                    )
                    # Calibration/depth/confidence/metadata payload bytes survive unchanged.
                    self.assertEqual(
                        payloads(
                            sc.cc.read_mcap(im.flat_projection(im.validate(indexed)))
                        ),
                        payloads(sc.cc.read_mcap(flat)),
                    )

    def test_indexed_rejects_match_flat_semantic_rejects(self):
        framing = {
            "E_TRUNCATED",
            "E_DATA_CRC",
            "E_UNSUPPORTED_LAYOUT",
            "E_MALFORMED_RECORD",
        }
        checked = 0
        for name in REJECTED:
            expected = set(CASES[name]["expected_errors"])
            if expected & framing or not expected:
                continue
            flat = (GOLDEN / f"{name}.mcap").read_bytes()
            try:
                indexed = fx.chunked(flat)
            except (ValueError, KeyError, IndexError):
                continue
            with self.subTest(case=name):
                with self.assertRaises(sc.CaptureRejected) as err:
                    sc.gate(indexed)
                self.assertEqual(err.exception.code, "E_CAPTURE_NOT_ACCEPTED")
                self.assertEqual(
                    sorted(err.exception.detail["errors"]), sorted(expected)
                )
                checked += 1
        self.assertGreater(checked, 60)

    def test_container_corruption_is_rejected_on_v12_files(self):
        flat = (GOLDEN / "v12_depth_dense_measurement_linked.mcap").read_bytes()
        sc.gate(fx.chunked(flat))
        good = fx.chunked(flat)
        bad_chunk = bytearray(good)
        i = bad_chunk.index(b"/camera/depth_dense/image")
        bad_chunk[i] ^= 0x01  # inside a chunk payload: chunk CRC must fail
        with self.assertRaises(sc.CaptureRejected) as err:
            sc.gate(bytes(bad_chunk))
        self.assertEqual(err.exception.code, "E_CAPTURE_NOT_ACCEPTED")
        for kw in (
            {"statistics_count_shift": 1},
            {"drop_message_index": True},
            {"message_index_shift": 1},
            {"chunk_index_offset_shift": 1},
        ):
            with self.subTest(kw=kw):
                with self.assertRaises(sc.CaptureRejected):
                    sc.gate(fx.chunked(flat, **kw))
        with self.assertRaises(sc.CaptureRejected):
            sc.gate(good[:-40])


if __name__ == "__main__":
    unittest.main()
