"""Indexed/chunked MCAP container validation: positive equivalence and targeted corruption tests.

Fixtures are legal chunked re-framings of the published SA-50 golden corpus (tests/indexed_fixture.py).
They are synthetic container fixtures, never recording qualification.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import indexed_fixture as fx  # noqa: E402
import indexed_mcap as im  # noqa: E402
import strict_capture as sc  # noqa: E402

GOLDEN = sc.REPO / "packages/contracts/capture/golden"
CASES = json.loads((GOLDEN / "cases.json").read_text())
FLAT = (GOLDEN / "valid.mcap").read_bytes()
# Flat-framing faults (truncation, DataEnd CRC, portable layout) are discarded by re-framing, so those
# cases are covered by the flat path only. Definition faults survive re-framing as container rejects.
FRAMING_CODES = {"E_TRUNCATED", "E_DATA_CRC", "E_UNSUPPORTED_LAYOUT"}
DEFINITION_CODES = {"E_DEFINITION_ORDER", "E_DEFINITION_CONFLICT"}

try:
    import mcap  # noqa: F401

    HAVE_OFFICIAL = True
except ImportError:  # pragma: no cover - CI installs the locked `container` group
    HAVE_OFFICIAL = False


def container_code(data: bytes, **kw) -> str:
    with unittest.TestCase().assertRaises(im.ContainerRejected) as err:
        im.validate(data, **kw)
    return err.exception.code


class PositiveTest(unittest.TestCase):
    def test_chunked_golden_is_accepted_with_identical_facts_and_lossless_projection(
        self,
    ):
        for per_chunk in (1, 3, 7, 1000):
            for summary_crc in (True, False):
                with self.subTest(per_chunk=per_chunk, summary_crc=summary_crc):
                    data = fx.chunked(
                        FLAT, messages_per_chunk=per_chunk, summary_crc=summary_crc
                    )
                    cap = sc.gate(data)
                    flat = sc.gate(FLAT)
                    self.assertEqual(cap.result, flat.result)
                    self.assertEqual(
                        [(u.sequence, u.sha256, u.encoder_pts_us, u.source_frame_id) for u in cap.access_units],
                        [(u.sequence, u.sha256, u.encoder_pts_us, u.source_frame_id) for u in flat.access_units],
                    )  # fmt: skip
                    self.assertEqual(
                        cap.source_sha256, hashlib.sha256(data).hexdigest()
                    )
                    self.assertNotEqual(cap.source_sha256, flat.source_sha256)
                    # Same bodies, same order: the in-memory projection IS the published flat golden.
                    self.assertEqual(
                        cap.container["projection_sha256"], CASES["valid"]["sha256"]
                    )
                    self.assertEqual(cap.container["layout"], "indexed_chunked")
                    self.assertEqual(
                        cap.container["original_on_portable_reader"],
                        ["E_UNSUPPORTED_LAYOUT"],
                    )
                    self.assertEqual(
                        cap.container["summary_crc"],
                        "verified" if summary_crc else "absent_summary_cross_validated",
                    )
                    self.assertEqual(flat.container["layout"], "flat_portable")

    def test_sorted_message_index_is_accepted(self):
        sc.gate(fx.chunked(FLAT, sorted_message_index=True))

    def test_every_golden_case_has_the_same_semantic_outcome_when_chunked(self):
        """All 84 published cases: flat expectations unchanged; payload verdicts identical when chunked."""
        self.assertEqual(len(CASES), 84)
        compared = 0
        for name, case in CASES.items():
            if set(case["expected_errors"]) & FRAMING_CODES:
                continue
            flat = (GOLDEN / f"{name}.mcap").read_bytes()
            try:
                data = fx.chunked(flat)
            except (ValueError, IndexError, struct.error, KeyError, AssertionError):
                continue  # flat framing itself is broken (truncation/layout cases)
            with self.subTest(case=name):
                expected = set(case["expected_errors"])
                if case["expect"] == "accept":
                    self.assertTrue(sc.gate(data).access_units)
                elif expected & DEFINITION_CODES:
                    with self.assertRaises(sc.CaptureRejected) as err:
                        sc.gate(data)
                    got = err.exception.detail["indexed_container"]["errors"]
                    self.assertEqual(
                        got, [f"E_CONTAINER_{c[2:]}" for c in sorted(expected)]
                    )
                else:
                    with self.assertRaises(sc.CaptureRejected) as err:
                        sc.gate(data)
                    self.assertEqual(err.exception.code, "E_CAPTURE_NOT_ACCEPTED")
                    self.assertEqual(
                        sorted(err.exception.detail["errors"]),
                        sorted(case["expected_errors"]),
                    )
                    self.assertEqual(
                        err.exception.detail["indexed_container"]["layout"],
                        "indexed_chunked",
                    )
                compared += 1
        self.assertGreaterEqual(compared, 60)

    def test_portable_layout_golden_cases_keep_their_published_code(self):
        for name in ("chunk_record", "footer_summary_offset", "data_end_missing"):
            with self.subTest(case=name):
                with self.assertRaises(sc.CaptureRejected) as err:
                    sc.gate((GOLDEN / f"{name}.mcap").read_bytes())
                self.assertEqual(
                    err.exception.detail["errors"], ["E_UNSUPPORTED_LAYOUT"]
                )
                self.assertTrue(
                    err.exception.detail["indexed_container"]["errors"][0].startswith(
                        "E_CONTAINER_"
                    )
                )

    @unittest.skipUnless(HAVE_OFFICIAL, "official mcap wheel not installed")
    def test_official_reader_agrees(self):
        for per_chunk in (1, 7):
            data = fx.chunked(FLAT, messages_per_chunk=per_chunk)
            got = im.official_crosscheck(data, im.validate(data))
            self.assertTrue(got["stream_messages_equal_in_file_order"])


class CorruptionTest(unittest.TestCase):
    def assertCode(self, data: bytes, code: str, **kw):
        self.assertEqual(container_code(data, **kw), code)
        with self.assertRaises(sc.CaptureRejected) as err:
            sc.gate(data)
        self.assertEqual(err.exception.detail["errors"], ["E_UNSUPPORTED_LAYOUT"])
        self.assertEqual(err.exception.detail["indexed_container"]["errors"], [code])

    def test_payload_byte_flip_fails_chunk_crc(self):
        data = bytearray(fx.chunked(FLAT))
        first_chunk = data.index(bytes([0x06]), len(fx.MAGIC) + 9)
        data[first_chunk + 9 + 60] ^= 0x01
        self.assertCode(bytes(data), "E_CONTAINER_CHUNK_CRC")

    def test_zero_crcs_are_rejected(self):
        self.assertCode(
            fx.chunked(FLAT, zero_chunk_crc=True), "E_CONTAINER_CHUNK_CRC_ABSENT"
        )
        self.assertCode(
            fx.chunked(FLAT, zero_data_crc=True), "E_CONTAINER_DATA_CRC_ABSENT"
        )

    def test_diagnostic_zero_crc_mode_is_marked_and_still_verifies_nonzero(self):
        c = im.validate(
            fx.chunked(FLAT, zero_chunk_crc=True, zero_data_crc=True),
            crcs_required=False,
        )
        self.assertTrue(c.facts["chunk_crc"].startswith("DIAGNOSTIC_ONLY"))
        data = bytearray(fx.chunked(FLAT))
        data[data.index(bytes([0x06]), len(fx.MAGIC) + 9) + 9 + 60] ^= 0x01
        self.assertEqual(
            container_code(bytes(data), crcs_required=False), "E_CONTAINER_CHUNK_CRC"
        )

    def test_wrong_summary_crc_is_rejected(self):
        data = bytearray(fx.chunked(FLAT))
        data[-len(fx.MAGIC) - 1] ^= 0xFF  # last byte of footer summary_crc
        self.assertCode(bytes(data), "E_CONTAINER_SUMMARY_CRC")

    def test_every_truncation_is_rejected(self):
        data = fx.chunked(FLAT)
        for cut in list(range(0, len(data), 97)) + [
            len(data) - 1,
            len(data) - 8,
            len(data) - 9,
        ]:
            with self.subTest(cut=cut):
                with self.assertRaises(im.ContainerRejected):
                    im.validate(data[:cut])
                with self.assertRaises(sc.CaptureRejected):
                    sc.gate(data[:cut])

    def test_trailing_bytes_are_rejected(self):
        with self.assertRaises(im.ContainerRejected):
            im.validate(fx.chunked(FLAT) + b"\x00")
        with self.assertRaises(im.ContainerRejected):
            im.validate(fx.chunked(FLAT) + fx.rec(0x0F, b"\0\0\0\0") + fx.MAGIC)

    def test_unsupported_compression_is_named_not_decompressed(self):
        data = fx.chunked(FLAT, compression="zstd")
        with self.assertRaises(im.ContainerRejected) as err:
            im.validate(data)
        self.assertEqual(err.exception.code, "E_CONTAINER_UNSUPPORTED_COMPRESSION")
        self.assertEqual(err.exception.detail["compression"], "zstd")

    def test_chunk_bound(self):
        self.assertEqual(
            container_code(fx.chunked(FLAT), max_chunk_bytes=64),
            "E_CONTAINER_CHUNK_BOUND",
        )

    def test_record_limit(self):
        self.assertEqual(
            container_code(fx.chunked(FLAT), max_records=10), "E_CONTAINER_RECORD_LIMIT"
        )

    def test_index_and_summary_mismatches(self):
        cases = {
            "E_CONTAINER_MESSAGE_INDEX": [
                {"drop_message_index": True},
                {"message_index_shift": 1},
            ],
            "E_CONTAINER_CHUNK_INDEX": [{"chunk_index_offset_shift": 1}],
            "E_CONTAINER_CHUNK_TIME": [{"chunk_time_shift": -1}],
            "E_CONTAINER_STATISTICS": [{"statistics_count_shift": 1}],
            "E_CONTAINER_SUMMARY_DEFINITION": [{"omit_summary_schema": True}],
            "E_CONTAINER_SUMMARY_OFFSET": [{"summary_offset_shift": 1}],
            "E_CONTAINER_MESSAGE_OUTSIDE_CHUNK": [{"top_level_message": True}],
            "E_CONTAINER_UNSUPPORTED_RECORD": [{"attachment": True}],
        }
        for code, variants in cases.items():
            for kw in variants:
                with self.subTest(code=code, **kw):
                    self.assertCode(fx.chunked(FLAT, summary_crc=False, **kw), code)

    def test_definition_order_and_conflict(self):
        header, records = fx.flat_records(FLAT)
        first_msg = next(i for i, (op, _) in enumerate(records) if op == 0x05)
        cid = struct.unpack_from("<H", records[first_msg][1])[0]
        chan = next(
            i
            for i, (op, b) in enumerate(records)
            if op == 0x04 and struct.unpack_from("<H", b)[0] == cid
        )
        moved = (
            records[:chan]
            + records[chan + 1 : first_msg + 1]
            + [records[chan]]
            + records[first_msg + 1 :]
        )
        self.assertCode(fx.build(header, moved), "E_CONTAINER_DEFINITION_ORDER")
        op, body = next(
            r for r in records if r[0] == 0x04 and b"/camera/rgb/video" in r[1]
        )
        conflict = records + [
            (op, body.replace(b"/camera/rgb/video", b"/camera/rgb/vidEo"))
        ]
        self.assertEqual(
            container_code(fx.build(header, conflict)),
            "E_CONTAINER_DEFINITION_CONFLICT",
        )

    def test_reordered_messages_reach_the_reference_semantic_rules(self):
        """Container-legal reordering is not hidden: the reference checker sees the physical order."""
        header, records = fx.flat_records(FLAT)
        video_cid = None
        for op, b in records:
            if op == 0x04 and b"/camera/rgb/video" in b:
                video_cid = struct.unpack_from("<H", b)[0]
        idx = [
            i
            for i, (op, b) in enumerate(records)
            if op == 0x05 and struct.unpack_from("<H", b)[0] == video_cid
        ]
        swapped = list(records)
        swapped[idx[0]], swapped[idx[1]] = swapped[idx[1]], swapped[idx[0]]
        with self.assertRaises(sc.CaptureRejected) as err:
            sc.gate(fx.build(header, swapped))
        self.assertEqual(err.exception.code, "E_CAPTURE_NOT_ACCEPTED")
        self.assertIn("E_FIRST_NOT_IDR", err.exception.detail["errors"])


if __name__ == "__main__":
    unittest.main()
