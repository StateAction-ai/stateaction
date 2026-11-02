"""Non-seeking, hash-wrapped, bounded streaming reader for indexed (chunked) MCAP.

SA-29. The SA-61 spike validated the same container rules, but only after reading the whole file
into memory. This module applies those rules in file order over a forward-only binary stream:

* The source is only ever `read(n)`; there is no `seek`/`tell`, no mmap and no whole-file buffer.
* Every consumed byte (magic through closing magic, footer included) feeds one SHA-256. After the
  closing magic the stream must be at EOF; trailing bytes are rejected after being hashed.
* Memory is bounded by explicit `Limits`: the largest record/chunk buffer, the records per chunk,
  the number of chunks and definitions. Anything larger is rejected before it is allocated.
* A chunk is buffered whole (bounded by `max_chunk_bytes`), its CRC verified, and only then are its
  messages yielded. Everything yielded is still PROVISIONAL: the data-section CRC, summary,
  ChunkIndex/Statistics cross-checks and footer are verified only at the end of iteration, which
  raises `McapStreamError` on any mismatch. Callers must not publish results before exhaustion.
* Only uncompressed chunks are supported. zstd/lz4 are rejected by name
  (`E_STREAM_UNSUPPORTED_COMPRESSION`); this module never decompresses.

Stdlib only.
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import BinaryIO, Protocol

MAGIC = b"\x89MCAP0\r\n"
OP_HEADER, OP_FOOTER, OP_SCHEMA, OP_CHANNEL, OP_MESSAGE = 0x01, 0x02, 0x03, 0x04, 0x05
OP_CHUNK, OP_MESSAGE_INDEX, OP_CHUNK_INDEX = 0x06, 0x07, 0x08
OP_STATISTICS, OP_SUMMARY_OFFSET, OP_DATA_END = 0x0B, 0x0E, 0x0F
SUMMARY_GROUP_OPS = (OP_SCHEMA, OP_CHANNEL, OP_CHUNK_INDEX, OP_STATISTICS)

_READ_STEP = 1024 * 1024  # largest single read() issued against the source


class _Readable(Protocol):
    def read(self, n: int = ..., /) -> bytes: ...


class McapStreamError(ValueError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _require(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise McapStreamError(code, detail)


@dataclass(frozen=True)
class Limits:
    """Explicit allocation bounds. Defaults are conservative for a 1080p phone recording."""

    max_chunk_bytes: int = 64 * 1024 * 1024  # uncompressed chunk payload
    max_record_bytes: int = 64 * 1024 * 1024  # any non-chunk record body / message body
    max_message_bytes: int = 16 * 1024 * 1024
    max_records_per_chunk: int = 1_000_000
    max_chunks: int = 1_000_000
    max_definitions: int = 4096  # schemas + channels
    max_source_bytes: int | None = (
        None  # honest cap; None = only the stream bounds the read
    )

    def __post_init__(self) -> None:
        for name in ("max_chunk_bytes", "max_record_bytes", "max_message_bytes"):
            _require(getattr(self, name) > 0, "E_STREAM_LIMITS", name)


@dataclass
class SourceReport:
    """Evidence that the whole source was consumed once and hashed."""

    sha256: str = ""
    bytes_read: int = 0
    read_calls: int = 0
    max_read_bytes: int = 0
    peak_buffer_bytes: int = 0  # largest record/chunk buffer ever held
    chunks: int = 0
    messages: int = 0
    records: int = 0
    summary_crc: str = "absent"
    complete: bool = (
        False  # True only after footer, closing magic and EOF were verified
    )
    layout: str = "indexed_chunked"
    compression: tuple[str, ...] = ()


class HashingReader:
    """Forward-only exact reader that hashes and counts every byte it hands out."""

    def __init__(self, raw: _Readable, limits: Limits, report: SourceReport):
        self._raw, self._limits, self.report = raw, limits, report
        self._sha = hashlib.sha256()
        self.pos = 0  # absolute offset of the next unread byte
        self.data_crc = 0  # running CRC-32 of every byte so far (until frozen)
        self._crc_live = True

    def freeze_data_crc(self) -> int:
        self._crc_live = False
        return self.data_crc

    def read_exact(self, n: int, what: str) -> bytes:
        _require(n >= 0, "E_STREAM_TRUNCATED", what)
        cap = self._limits.max_source_bytes
        _require(
            cap is None or self.pos + n <= cap,
            "E_SOURCE_TOO_LARGE",
            {"limit": cap, "needed_at_least": self.pos + n},
        )
        parts: list[bytes] = []
        left = n
        while left:
            step = min(left, _READ_STEP)
            buf = self._raw.read(step)
            self.report.read_calls += 1
            _require(len(buf) > 0, "E_STREAM_TRUNCATED", what)
            _require(len(buf) <= step, "E_STREAM_SOURCE_OVERREAD", what)
            self.report.max_read_bytes = max(self.report.max_read_bytes, len(buf))
            self._sha.update(buf)
            if self._crc_live:
                self.data_crc = zlib.crc32(buf, self.data_crc)
            parts.append(buf)
            left -= len(buf)
        self.pos += n
        self.report.bytes_read = self.pos
        out = parts[0] if len(parts) == 1 else b"".join(parts)
        self.report.peak_buffer_bytes = max(self.report.peak_buffer_bytes, len(out))
        return out

    def finish_at_eof(self) -> None:
        """Hash and reject anything after the closing magic, then seal the SHA-256."""
        extra = self._raw.read(1)
        self.report.read_calls += 1
        if extra:
            self._sha.update(extra)
            self.pos += 1
            self.report.bytes_read = self.pos
            raise McapStreamError("E_STREAM_TRAILING_DATA", "bytes after closing magic")
        self.report.sha256 = self._sha.hexdigest()


class _Cursor:
    def __init__(self, buf: bytes, what: str):
        self.buf, self.pos, self.what = buf, 0, what

    def take(self, n: int) -> bytes:
        _require(
            0 <= n <= len(self.buf) - self.pos,
            "E_STREAM_TRUNCATED",
            f"{self.what} field",
        )
        out = self.buf[self.pos : self.pos + n]
        self.pos += n
        return out

    def u(self, fmt: str) -> int:
        return int(struct.unpack("<" + fmt, self.take(struct.calcsize(fmt)))[0])

    def string(self) -> str:
        raw = self.take(self.u("I"))
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            raise McapStreamError("E_STREAM_STRING", self.what) from None

    def string_map(self) -> dict[str, str]:
        end = self.u("I") + self.pos
        _require(end <= len(self.buf), "E_STREAM_TRUNCATED", f"{self.what} map")
        out: dict[str, str] = {}
        while self.pos < end:
            k = self.string()
            _require(k not in out, "E_STREAM_DUPLICATE_KEY", self.what)
            out[k] = self.string()
        _require(self.pos == end, "E_STREAM_TRUNCATED", f"{self.what} map")
        return out

    def done(self) -> None:
        _require(
            self.pos == len(self.buf),
            "E_STREAM_RECORD_LENGTH",
            {"record": self.what, "unread_bytes": len(self.buf) - self.pos},
        )


@dataclass(frozen=True)
class Header:
    profile: str
    library: str


@dataclass(frozen=True)
class SchemaDef:
    id: int
    name: str
    encoding: str
    data: bytes
    body: bytes


@dataclass(frozen=True)
class ChannelDef:
    id: int
    schema_id: int
    topic: str
    message_encoding: str
    metadata: dict[str, str]
    body: bytes


@dataclass(frozen=True)
class Message:
    channel_id: int
    sequence: int
    log_time: int
    publish_time: int
    data: bytes
    chunk: int  # index of the containing chunk


Item = Header | SchemaDef | ChannelDef | Message


@dataclass
class _ChunkMeta:
    start: int
    length: int
    t0: int
    t1: int
    usize: int
    csize: int
    compression: str
    mi_offsets: dict[int, int] = field(default_factory=dict)
    mi_start: int | None = None
    mi_end: int | None = None


def _record_header(rd: HashingReader, what: str) -> tuple[int, int]:
    head = rd.read_exact(9, f"{what} record header")
    (length,) = struct.unpack_from("<Q", head, 1)
    return head[0], int(length)


class McapStream:
    """Iterate `Header | SchemaDef | ChannelDef | Message` in strict file order.

    `report` is complete (and `report.complete` True) only after iteration ends without error.
    """

    def __init__(self, raw: _Readable | BinaryIO, limits: Limits | None = None):
        self.limits = limits or Limits()
        self.report = SourceReport()
        self._rd = HashingReader(raw, self.limits, self.report)

    # -- public ---------------------------------------------------------------------------
    def __iter__(self) -> Iterator[Item]:
        return self._run()

    # -- internals ------------------------------------------------------------------------
    def _run(self) -> Iterator[Item]:
        rd, lim, rep = self._rd, self.limits, self.report
        _require(rd.read_exact(len(MAGIC), "leading magic") == MAGIC, "E_STREAM_MAGIC")
        op, length = _record_header(rd, "header")
        _require(op == OP_HEADER, "E_STREAM_HEADER", "Header must be first")
        body = self._body(length, "Header")
        c = _Cursor(body, "Header")
        header = Header(c.string(), c.string())
        c.done()
        rep.records += 1
        yield header

        schemas: dict[int, bytes] = {}
        channels: dict[int, bytes] = {}
        chunks: list[_ChunkMeta] = []
        by_channel_total: dict[int, int] = {}
        current: _ChunkMeta | None = None
        current_index: dict[int, list[tuple[int, int]]] = {}
        n_messages = 0
        t_min: int | None = None
        t_max: int | None = None
        compressions: set[str] = set()

        def close_chunk() -> None:
            if current is not None:
                missing = sorted(set(current_index) - set(current.mi_offsets))
                _require(
                    not missing,
                    "E_STREAM_MESSAGE_INDEX",
                    {"chunk": len(chunks) - 1, "missing_channels": missing},
                )

        data_end_at: int | None = None
        while True:
            start = rd.pos
            crc_before = rd.data_crc
            op, length = _record_header(rd, "data")
            rep.records += 1
            if op != OP_MESSAGE_INDEX:
                close_chunk()
                current = None
                current_index = {}
            if op == OP_SCHEMA:
                body = self._body(length, "Schema")
                yield self._schema(body, schemas)
            elif op == OP_CHANNEL:
                body = self._body(length, "Channel")
                yield self._channel(body, schemas, channels)
            elif op == OP_CHUNK:
                _require(
                    len(chunks) < lim.max_chunks, "E_STREAM_CHUNK_LIMIT", lim.max_chunks
                )
                meta, items, current_index = self._chunk(
                    length, start, len(chunks), schemas, channels
                )
                compressions.add(meta.compression)
                chunks.append(meta)
                current = meta
                rep.chunks = len(chunks)
                for item in items:
                    if isinstance(item, Message):
                        n_messages += 1
                        by_channel_total[item.channel_id] = (
                            by_channel_total.get(item.channel_id, 0) + 1
                        )
                        t_min = (
                            item.log_time
                            if t_min is None
                            else min(t_min, item.log_time)
                        )
                        t_max = (
                            item.log_time
                            if t_max is None
                            else max(t_max, item.log_time)
                        )
                    yield item
                rep.messages = n_messages
            elif op == OP_MESSAGE_INDEX:
                _require(
                    current is not None, "E_STREAM_MESSAGE_INDEX", "not after a Chunk"
                )
                assert current is not None
                self._message_index(
                    self._body(length, "MessageIndex"),
                    start,
                    current,
                    len(chunks) - 1,
                    current_index,
                )
            elif op == OP_DATA_END:
                body = self._body(length, "DataEnd")
                c = _Cursor(body, "DataEnd")
                declared = c.u("I")
                c.done()
                before = crc_before
                _require(declared != 0, "E_STREAM_DATA_CRC_ABSENT")
                _require(declared == before, "E_STREAM_DATA_CRC")
                data_end_at = rd.pos
                rd.freeze_data_crc()
                break
            else:
                code = (
                    "E_STREAM_MESSAGE_OUTSIDE_CHUNK"
                    if op == OP_MESSAGE
                    else "E_STREAM_UNSUPPORTED_RECORD"
                )
                raise McapStreamError(code, {"opcode": op, "offset": start})
        _require(bool(chunks), "E_STREAM_NO_CHUNKS", "not an indexed/chunked layout")
        assert data_end_at is not None and t_min is not None and t_max is not None

        self._summary(
            chunks,
            schemas,
            channels,
            by_channel_total,
            n_messages,
            t_min,
            t_max,
            data_end_at,
        )
        rd.finish_at_eof()
        rep.compression = tuple(sorted(compressions))
        rep.complete = True

    def _body(self, length: int, what: str) -> bytes:
        _require(
            length <= self.limits.max_record_bytes,
            "E_STREAM_RECORD_BOUND",
            {"record": what, "bytes": length, "limit": self.limits.max_record_bytes},
        )
        return self._rd.read_exact(length, what)

    def _schema(self, body: bytes, schemas: dict[int, bytes]) -> SchemaDef:
        c = _Cursor(body, "Schema")
        sid, name, enc = c.u("H"), c.string(), c.string()
        data = c.take(c.u("I"))
        c.done()
        _require(sid != 0, "E_STREAM_DEFINITION_CONFLICT", "schema id 0 is reserved")
        _require(
            schemas.get(sid, body) == body,
            "E_STREAM_DEFINITION_CONFLICT",
            f"schema {sid}",
        )
        if sid not in schemas:
            _require(
                len(schemas) + 1 <= self.limits.max_definitions,
                "E_STREAM_DEFINITION_LIMIT",
                self.limits.max_definitions,
            )
        schemas[sid] = body
        return SchemaDef(sid, name, enc, data, body)

    def _channel(
        self, body: bytes, schemas: dict[int, bytes], channels: dict[int, bytes]
    ) -> ChannelDef:
        c = _Cursor(body, "Channel")
        cid, sid, topic, enc = c.u("H"), c.u("H"), c.string(), c.string()
        meta = c.string_map()
        c.done()
        _require(
            sid == 0 or sid in schemas,
            "E_STREAM_DEFINITION_ORDER",
            f"channel {cid} before schema {sid}",
        )
        _require(
            channels.get(cid, body) == body,
            "E_STREAM_DEFINITION_CONFLICT",
            f"channel {cid}",
        )
        if cid not in channels:
            _require(
                len(channels) + len(schemas) + 1 <= self.limits.max_definitions,
                "E_STREAM_DEFINITION_LIMIT",
                self.limits.max_definitions,
            )
        channels[cid] = body
        return ChannelDef(cid, sid, topic, enc, meta, body)

    def _chunk(
        self,
        length: int,
        start: int,
        index: int,
        schemas: dict[int, bytes],
        channels: dict[int, bytes],
    ) -> tuple[_ChunkMeta, list[Item], dict[int, list[tuple[int, int]]]]:
        rd, lim = self._rd, self.limits
        fixed = rd.read_exact(8 + 8 + 8 + 4 + 4, "Chunk header")
        t0, t1, usize, crc, clen = struct.unpack("<QQQII", fixed)
        # `clen` is the length of the compression string; read it and the records length.
        _require(
            clen <= 64,
            "E_STREAM_UNSUPPORTED_COMPRESSION",
            {"chunk": index, "name_len": clen},
        )
        compression = rd.read_exact(clen, "Chunk compression").decode(
            "utf-8", "replace"
        )
        (rec_len,) = struct.unpack("<Q", rd.read_exact(8, "Chunk records length"))
        _require(
            length == 8 + 8 + 8 + 4 + 4 + clen + 8 + rec_len,
            "E_STREAM_RECORD_LENGTH",
            {"record": "Chunk", "chunk": index},
        )
        _require(
            compression == "",
            "E_STREAM_UNSUPPORTED_COMPRESSION",
            {"chunk": index, "compression": compression},
        )
        _require(
            usize <= lim.max_chunk_bytes,
            "E_STREAM_CHUNK_BOUND",
            {"chunk": index, "uncompressed_size": usize, "limit": lim.max_chunk_bytes},
        )
        _require(
            usize == rec_len,
            "E_STREAM_CHUNK_SIZE",
            {"chunk": index, "uncompressed_size": usize, "records": rec_len},
        )
        records = rd.read_exact(rec_len, "Chunk records")
        _require(crc != 0, "E_STREAM_CHUNK_CRC_ABSENT", {"chunk": index})
        _require(zlib.crc32(records) == crc, "E_STREAM_CHUNK_CRC", {"chunk": index})

        items: list[Item] = []
        index_by_channel: dict[int, list[tuple[int, int]]] = {}
        times: list[int] = []
        pos, count = 0, 0
        while pos < len(records):
            _require(
                pos + 9 <= len(records),
                "E_STREAM_TRUNCATED",
                f"chunk {index} record header",
            )
            op = records[pos]
            (n,) = struct.unpack_from("<Q", records, pos + 1)
            _require(
                n <= len(records) - pos - 9,
                "E_STREAM_TRUNCATED",
                f"chunk {index} record body",
            )
            count += 1
            _require(
                count <= lim.max_records_per_chunk,
                "E_STREAM_RECORD_LIMIT",
                lim.max_records_per_chunk,
            )
            _require(
                n <= lim.max_record_bytes,
                "E_STREAM_RECORD_BOUND",
                {"chunk": index, "bytes": n},
            )
            body = records[pos + 9 : pos + 9 + n]
            if op == OP_SCHEMA:
                items.append(self._schema(body, schemas))
            elif op == OP_CHANNEL:
                items.append(self._channel(body, schemas, channels))
            elif op == OP_MESSAGE:
                _require(n >= 22, "E_STREAM_TRUNCATED", "Message header")
                _require(
                    n - 22 <= lim.max_message_bytes,
                    "E_STREAM_MESSAGE_BOUND",
                    {"chunk": index, "bytes": n - 22, "limit": lim.max_message_bytes},
                )
                cid, seq, log, pub = struct.unpack_from("<HIQQ", body, 0)
                _require(
                    cid in channels,
                    "E_STREAM_DEFINITION_ORDER",
                    f"message before channel {cid}",
                )
                items.append(Message(cid, seq, log, pub, body[22:], index))
                index_by_channel.setdefault(cid, []).append((log, pos))
                times.append(log)
            else:
                raise McapStreamError(
                    "E_STREAM_CHUNK_RECORD", {"chunk": index, "opcode": op}
                )
            pos += 9 + n
        _require(bool(times), "E_STREAM_EMPTY_CHUNK", {"chunk": index})
        _require(
            (t0, t1) == (min(times), max(times)),
            "E_STREAM_CHUNK_TIME",
            {"chunk": index, "declared": [t0, t1], "actual": [min(times), max(times)]},
        )
        rep_len = rd.pos - start
        return (
            _ChunkMeta(start, rep_len, t0, t1, usize, rec_len, compression),
            items,
            index_by_channel,
        )

    def _message_index(
        self,
        body: bytes,
        start: int,
        chunk: _ChunkMeta,
        chunk_no: int,
        index: dict[int, list[tuple[int, int]]],
    ) -> None:
        c = _Cursor(body, "MessageIndex")
        cid, n = c.u("H"), c.u("I")
        _require(n % 16 == 0, "E_STREAM_MESSAGE_INDEX", {"chunk": chunk_no, "bytes": n})
        entries = [(c.u("Q"), c.u("Q")) for _ in range(n // 16)]
        c.done()
        actual = index.get(cid)
        _require(
            actual is not None and cid not in chunk.mi_offsets,
            "E_STREAM_MESSAGE_INDEX",
            {
                "chunk": chunk_no,
                "channel": cid,
                "reason": "unknown or duplicate channel",
            },
        )
        _require(
            entries == actual or entries == sorted(actual or []),
            "E_STREAM_MESSAGE_INDEX",
            {"chunk": chunk_no, "channel": cid, "reason": "entries differ from chunk"},
        )
        chunk.mi_offsets[cid] = start
        if chunk.mi_start is None:
            chunk.mi_start = start
        chunk.mi_end = self._rd.pos

    def _summary(
        self,
        chunks: list[_ChunkMeta],
        schemas: dict[int, bytes],
        channels: dict[int, bytes],
        totals: dict[int, int],
        n_messages: int,
        t_min: int,
        t_max: int,
        summary_start: int,
    ) -> None:
        rd = self._rd
        groups: list[tuple[int, int, int]] = []  # (op, start, end)
        seen_s: set[int] = set()
        seen_c: set[int] = set()
        chunk_i = 0
        stats_seen = 0
        offsets: list[tuple[int, int, int]] = []
        offset_start: int | None = None
        footer: tuple[int, int, int] | None = None
        summary_crc_live = 0
        summary_crc_prefix = 0
        while True:
            start = rd.pos
            head = rd.read_exact(9, "summary record header")
            op, length = head[0], struct.unpack_from("<Q", head, 1)[0]
            body = self._body(length, "summary record")
            self.report.records += 1
            summary_crc_prefix = summary_crc_live
            summary_crc_live = zlib.crc32(head + body, summary_crc_live)
            if op == OP_FOOTER:
                c = _Cursor(body, "Footer")
                s_start, s_off, s_crc = c.u("Q"), c.u("Q"), c.u("I")
                c.done()
                footer = (s_start, s_off, s_crc)
                # CRC covers summary_start .. summary_offset_start inside the Footer (opcode,
                # length and the first 16 body bytes), i.e. everything but the footer's own CRC.
                summary_crc_live = zlib.crc32(head + body[:16], summary_crc_prefix)
                break
            if op == OP_SUMMARY_OFFSET:
                if offset_start is None:
                    offset_start = start
                c = _Cursor(body, "SummaryOffset")
                offsets.append((c.u("B"), c.u("Q"), c.u("Q")))
                c.done()
                continue
            _require(
                offset_start is None and op in SUMMARY_GROUP_OPS,
                "E_STREAM_UNSUPPORTED_RECORD",
                {"section": "summary", "opcode": op, "offset": start},
            )
            if groups and groups[-1][0] == op:
                groups[-1] = (op, groups[-1][1], rd.pos)
            else:
                _require(
                    all(g[0] != op for g in groups),
                    "E_STREAM_SUMMARY_GROUP",
                    {"opcode": op, "reason": "non-contiguous group"},
                )
                groups.append((op, start, rd.pos))
            if op == OP_SCHEMA:
                c = _Cursor(body, "Schema")
                sid = c.u("H")
                _require(
                    schemas.get(sid) == body and sid not in seen_s,
                    "E_STREAM_SUMMARY_DEFINITION",
                    {"schema": sid},
                )
                seen_s.add(sid)
            elif op == OP_CHANNEL:
                c = _Cursor(body, "Channel")
                cid = c.u("H")
                _require(
                    channels.get(cid) == body and cid not in seen_c,
                    "E_STREAM_SUMMARY_DEFINITION",
                    {"channel": cid},
                )
                seen_c.add(cid)
            elif op == OP_CHUNK_INDEX:
                _require(
                    chunk_i < len(chunks),
                    "E_STREAM_CHUNK_INDEX",
                    "more indexes than chunks",
                )
                self._check_chunk_index(body, chunks[chunk_i], chunk_i)
                chunk_i += 1
            else:
                stats_seen += 1
                self._check_statistics(
                    body,
                    schemas,
                    channels,
                    totals,
                    len(chunks),
                    n_messages,
                    t_min,
                    t_max,
                    stats_seen,
                )
        _require(footer is not None, "E_STREAM_TRUNCATED", "no Footer")
        assert footer is not None
        s_start, s_off, s_crc = footer
        _require(
            s_start == summary_start and bool(groups),
            "E_STREAM_SUMMARY_OFFSET",
            {"summary_start": s_start, "data_end_at": summary_start},
        )
        _require(
            seen_s == set(schemas) and seen_c == set(channels),
            "E_STREAM_SUMMARY_DEFINITION",
            "summary must repeat every data-section Schema and Channel",
        )
        _require(
            chunk_i == len(chunks),
            "E_STREAM_CHUNK_INDEX",
            {"indexes": chunk_i, "chunks": len(chunks)},
        )
        _require(stats_seen == 1, "E_STREAM_STATISTICS", {"records": stats_seen})
        if s_off:
            _require(
                offset_start == s_off and s_off > s_start,
                "E_STREAM_SUMMARY_OFFSET",
                {"summary_offset_start": s_off},
            )
            want = {(op, st, en - st) for op, st, en in groups}
            _require(
                len(set(offsets)) == len(offsets) and set(offsets) == want,
                "E_STREAM_SUMMARY_OFFSET",
                {"declared": sorted(offsets), "actual": sorted(want)},
            )
        else:
            _require(
                not offsets, "E_STREAM_SUMMARY_OFFSET", "offsets without footer pointer"
            )
        if s_crc:
            _require(summary_crc_live == s_crc, "E_STREAM_SUMMARY_CRC")
            self.report.summary_crc = "verified"
        else:
            self.report.summary_crc = "absent_summary_cross_validated"
        _require(
            rd.read_exact(len(MAGIC), "closing magic") == MAGIC,
            "E_STREAM_TRUNCATED",
            "closing magic",
        )

    def _check_chunk_index(self, body: bytes, ch: _ChunkMeta, i: int) -> None:
        c = _Cursor(body, "ChunkIndex")
        got = {
            "t0": c.u("Q"),
            "t1": c.u("Q"),
            "start": c.u("Q"),
            "length": c.u("Q"),
        }
        n = c.u("I")
        _require(n % 10 == 0, "E_STREAM_CHUNK_INDEX", {"chunk": i})
        pairs = [(c.u("H"), c.u("Q")) for _ in range(n // 10)]
        offs = dict(pairs)
        _require(len(offs) == len(pairs), "E_STREAM_CHUNK_INDEX", {"chunk": i})
        mi_len = c.u("Q")
        comp, csize, usize = c.string(), c.u("Q"), c.u("Q")
        c.done()
        want = {"t0": ch.t0, "t1": ch.t1, "start": ch.start, "length": ch.length}
        bad = sorted(k for k in want if got[k] != want[k])
        if offs != ch.mi_offsets:
            bad.append("message_index_offsets")
        if mi_len != (ch.mi_end or 0) - (ch.mi_start or 0):
            bad.append("message_index_length")
        if (comp, csize, usize) != (ch.compression, ch.csize, ch.usize):
            bad.append("sizes")
        _require(not bad, "E_STREAM_CHUNK_INDEX", {"chunk": i, "fields": bad})
        _require(
            ch.mi_start == ch.start + ch.length,
            "E_STREAM_MESSAGE_INDEX",
            {"chunk": i, "reason": "not contiguous after chunk"},
        )

    def _check_statistics(
        self,
        body: bytes,
        schemas: dict[int, bytes],
        channels: dict[int, bytes],
        totals: dict[int, int],
        n_chunks: int,
        n_messages: int,
        t_min: int,
        t_max: int,
        _seen: int,
    ) -> None:
        c = _Cursor(body, "Statistics")
        got = {
            "message_count": c.u("Q"),
            "schema_count": c.u("H"),
            "channel_count": c.u("I"),
            "attachment_count": c.u("I"),
            "metadata_count": c.u("I"),
            "chunk_count": c.u("I"),
            "t0": c.u("Q"),
            "t1": c.u("Q"),
        }
        n = c.u("I")
        _require(n % 10 == 0, "E_STREAM_STATISTICS", "channel_message_counts length")
        pairs = [(c.u("H"), c.u("Q")) for _ in range(n // 10)]
        c.done()
        want = {
            "message_count": n_messages,
            "schema_count": len(schemas),
            "channel_count": len(channels),
            "attachment_count": 0,
            "metadata_count": 0,
            "chunk_count": n_chunks,
            "t0": t_min,
            "t1": t_max,
        }
        bad = sorted(k for k in want if got[k] != want[k])
        declared = dict(pairs)
        ok = (
            len(declared) == len(pairs)
            and all(declared.get(cid) == k for cid, k in totals.items())
            and all(
                cid in channels and v == totals.get(cid, 0)
                for cid, v in declared.items()
            )
        )
        if not ok:
            bad.append("channel_message_counts")
        _require(not bad, "E_STREAM_STATISTICS", {"fields": bad})
