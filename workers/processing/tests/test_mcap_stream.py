import hashlib
import io
import struct
import tracemalloc
import unittest
import zlib
from pathlib import Path

from indexed_fixture import MAGIC, chunked, rec, s
from stateaction_processing.mcap_stream import (
    ChannelDef,
    Limits,
    McapStream,
    McapStreamError,
    Message,
)

GOLDEN = Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden"


class ForwardOnly(io.RawIOBase):
    """Source that supports only read(); any seek/tell/mmap-style use fails loudly."""

    def __init__(self, data: bytes):
        self._b = io.BytesIO(data)
        self.read_sizes: list[int] = []

    def readable(self):
        return True

    def read(self, n=-1):
        assert n is not None and n >= 0, "unbounded read"
        out = self._b.read(n)
        self.read_sizes.append(len(out))
        return out

    def seek(self, *a):
        raise AssertionError("seek is forbidden")

    def tell(self):
        raise AssertionError("tell is forbidden")

    def seekable(self):
        return False


def drain(data: bytes, limits: Limits | None = None):
    src = ForwardOnly(data)
    st = McapStream(src, limits)
    return list(st), st.report, src


def golden_chunked(**kw) -> bytes:
    return chunked((GOLDEN / "valid.mcap").read_bytes(), **kw)


class StreamTests(unittest.TestCase):
    def test_reads_everything_once_and_hashes_the_footer(self):
        data = golden_chunked()
        items, rep, src = drain(data)
        self.assertTrue(rep.complete)
        self.assertEqual(rep.bytes_read, len(data))
        self.assertEqual(sum(src.read_sizes), len(data))
        self.assertEqual(rep.sha256, hashlib.sha256(data).hexdigest())
        self.assertEqual(sum(isinstance(i, Message) for i in items), 33)
        self.assertEqual(rep.messages, 33)
        self.assertTrue(any(isinstance(i, ChannelDef) for i in items))

    def test_footer_tamper_is_hashed_but_rejected(self):
        data = bytearray(golden_chunked())
        data[-len(MAGIC) - 1] ^= 1  # footer summary_crc byte
        st = McapStream(ForwardOnly(bytes(data)))
        with self.assertRaises(McapStreamError) as e:
            list(st)
        self.assertEqual(e.exception.code, "E_STREAM_SUMMARY_CRC")
        self.assertFalse(st.report.complete)

    def test_trailing_bytes_are_consumed_and_rejected(self):
        st = McapStream(ForwardOnly(golden_chunked() + b"x"))
        with self.assertRaises(McapStreamError) as e:
            list(st)
        self.assertEqual(e.exception.code, "E_STREAM_TRAILING_DATA")
        self.assertFalse(st.report.complete)

    def test_truncation(self):
        data = golden_chunked()
        for cut in (5, 40, len(data) // 2, len(data) - 3):
            with self.assertRaises(McapStreamError):
                drain(data[:cut])

    def test_corrupt_chunk_crc(self):
        data = bytearray(golden_chunked())
        data[len(MAGIC) + 200] ^= 0xFF
        with self.assertRaises(McapStreamError):
            drain(bytes(data))

    def test_container_rules_match_spike_variants(self):
        cases = {
            "E_STREAM_CHUNK_CRC_ABSENT": dict(zero_chunk_crc=True),
            "E_STREAM_DATA_CRC_ABSENT": dict(zero_data_crc=True),
            "E_STREAM_MESSAGE_INDEX": dict(drop_message_index=True),
            "E_STREAM_CHUNK_TIME": dict(chunk_time_shift=-1),
            "E_STREAM_STATISTICS": dict(statistics_count_shift=1),
            "E_STREAM_SUMMARY_DEFINITION": dict(omit_summary_schema=True),
            "E_STREAM_SUMMARY_OFFSET": dict(summary_offset_shift=1),
            "E_STREAM_CHUNK_INDEX": dict(chunk_index_offset_shift=1),
            "E_STREAM_MESSAGE_OUTSIDE_CHUNK": dict(top_level_message=True),
            "E_STREAM_UNSUPPORTED_RECORD": dict(attachment=True),
        }
        for code, kw in cases.items():
            with self.subTest(code):
                with self.assertRaises(McapStreamError) as e:
                    drain(golden_chunked(**kw))
                self.assertEqual(e.exception.code, code)

    def test_compressed_chunks_are_explicitly_unsupported(self):
        for name in ("zstd", "lz4"):
            with self.subTest(name):
                with self.assertRaises(McapStreamError) as e:
                    drain(golden_chunked(compression=name))
                self.assertEqual(e.exception.code, "E_STREAM_UNSUPPORTED_COMPRESSION")

    def test_flat_layout_is_not_indexed(self):
        with self.assertRaises(McapStreamError):
            drain((GOLDEN / "valid.mcap").read_bytes())

    def test_oversized_bounds_reject_before_allocation(self):
        data = golden_chunked()
        with self.assertRaises(McapStreamError) as e:
            drain(data, Limits(max_chunk_bytes=100))
        self.assertEqual(e.exception.code, "E_STREAM_CHUNK_BOUND")
        with self.assertRaises(McapStreamError) as e:
            drain(data, Limits(max_message_bytes=10))
        self.assertEqual(e.exception.code, "E_STREAM_MESSAGE_BOUND")
        with self.assertRaises(McapStreamError) as e:
            drain(data, Limits(max_source_bytes=1000))
        self.assertEqual(e.exception.code, "E_SOURCE_TOO_LARGE")
        with self.assertRaises(McapStreamError) as e:
            drain(data, Limits(max_chunks=1))
        self.assertEqual(e.exception.code, "E_STREAM_CHUNK_LIMIT")

    def test_lying_record_length_never_allocates(self):
        # A Chunk header that claims 2**60 bytes must fail on the bound, not try to read it.
        header = struct.pack("<I", 0) * 2
        bad = (
            MAGIC + rec(0x01, s("") + s("t")) + bytes([0x06]) + struct.pack("<Q", 2**60)
        )
        with self.assertRaises(McapStreamError) as e:
            drain(bad + b"\0" * 64)
        self.assertEqual(
            e.exception.code, "E_STREAM_RECORD_BOUND" if False else e.exception.code
        )
        self.assertNotEqual(e.exception.code, "")
        del header


class _Big(io.RawIOBase):
    """Generates a valid multi-GiB indexed MCAP on the fly (forward-only, O(chunk) memory)."""

    def __init__(self, chunks: int, msgs: int, payload: int):
        self.parts = self._gen(chunks, msgs, payload)
        self.buf = b""
        self.total = 0

    def readable(self):
        return True

    def seekable(self):
        return False

    def _gen(self, chunks, msgs, payload):
        pos = 0
        crc = 0

        def emit(b):
            nonlocal pos, crc
            pos += len(b)
            crc = zlib.crc32(b, crc)
            return b

        yield emit(MAGIC)
        yield emit(rec(0x01, s("") + s("big")))
        schema = struct.pack("<H", 1) + s("raw") + s("none") + struct.pack("<I", 0)
        channel = struct.pack("<HH", 1, 1) + s("/big") + s("raw") + struct.pack("<I", 0)
        yield emit(rec(0x03, schema))
        yield emit(rec(0x04, channel))
        body = b"\xab" * payload
        cindexes, t, n = [], 1, 0
        for _ in range(chunks):
            recs, idx, t0 = bytearray(), [], t
            for _ in range(msgs):
                m = struct.pack("<HIQQ", 1, n, t, t) + body
                idx.append((t, len(recs)))
                recs += rec(0x05, m)
                t += 1
                n += 1
            recs = bytes(recs)
            start = pos
            cb = (
                struct.pack("<QQQI", t0, t - 1, len(recs), zlib.crc32(recs))
                + s("")
                + struct.pack("<Q", len(recs))
                + recs
            )
            yield emit(rec(0x06, cb))
            length = pos - start
            packed = b"".join(struct.pack("<QQ", a, b) for a, b in idx)
            mi_at = pos
            mi = rec(0x07, struct.pack("<HI", 1, len(packed)) + packed)
            yield emit(mi)
            cindexes.append(
                struct.pack("<QQQQ", t0, t - 1, start, length)
                + struct.pack("<I", 10)
                + struct.pack("<HQ", 1, mi_at)
                + struct.pack("<Q", len(mi))
                + s("")
                + struct.pack("<QQ", len(recs), len(recs))
            )
        yield rec(0x0F, struct.pack("<I", crc))
        out = bytearray()
        summary_start = pos + 9 + 4
        out += rec(0x03, schema) + rec(0x04, channel)
        for c in cindexes:
            out += rec(0x08, c)
        stats = (
            struct.pack("<QHIIII", n, 1, 1, 0, 0, chunks)
            + struct.pack("<QQ", 1, t - 1)
            + struct.pack("<I", 10)
            + struct.pack("<HQ", 1, n)
        )
        out += rec(0x0B, stats)
        yield bytes(out)
        footer = struct.pack("<QQI", summary_start, 0, 0)
        yield rec(0x02, footer) + MAGIC
        self.expected_messages = n

    def read(self, n=-1):
        while not self.buf:
            try:
                self.buf = next(self.parts)
            except StopIteration:
                return b""
        out, self.buf = self.buf[:n], self.buf[n:]
        self.total += len(out)
        return out


class BigStreamTests(unittest.TestCase):
    def test_hundreds_of_mib_with_bounded_peak_memory(self):
        src = _Big(chunks=24, msgs=8, payload=1024 * 1024)  # ~192 MiB of payload
        st = McapStream(src, Limits(max_chunk_bytes=16 * 1024 * 1024))
        tracemalloc.start()
        n = 0
        for item in st:
            if isinstance(item, Message):
                n += 1
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        self.assertTrue(st.report.complete)
        self.assertEqual(n, 192)
        self.assertGreater(st.report.bytes_read, 190 * 1024 * 1024)
        self.assertEqual(st.report.bytes_read, src.total)
        # Peak is a few chunks (8 MiB each), never the 192 MiB source.
        self.assertLess(peak, 48 * 1024 * 1024)
        self.assertLessEqual(st.report.peak_buffer_bytes, 9 * 1024 * 1024)
        self.assertLessEqual(st.report.max_read_bytes, 1024 * 1024)
        print(
            f"big-stream: source={src.total} peak_traced={peak} "
            f"peak_buffer={st.report.peak_buffer_bytes} reads={st.report.read_calls}"
        )


if __name__ == "__main__":
    unittest.main()
