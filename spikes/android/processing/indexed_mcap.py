"""Strict, independent validator for indexed (chunked) MCAP containers, used by the SA-61 probe.

Stdlib only. The published SA-50 portable reader parses only the flat layout. Native recorders write
standard indexed MCAP (Chunk + MessageIndex in the data section; Schema/Channel repeats, ChunkIndex,
Statistics and SummaryOffset in the summary). This module validates that container independently
against the MCAP specification (https://mcap.dev/spec) and then builds a validation-only flat
projection. The published reader is never patched.

Accepted layout (anything else is rejected with a specific `E_CONTAINER_*` code):

* Magic, Header first, closing magic, nothing after it. Every known record body is consumed exactly
  (no trailing bytes or unknown extension fields).
* Data section: top-level Schema/Channel records, Chunk records, and MessageIndex records that
  immediately follow their Chunk. Messages must be inside chunks. Attachments, metadata and unknown
  opcodes are rejected, not skipped.
* Chunks are uncompressed (`compression == ""`). Any other compression is rejected with its name,
  so decompression is never unbounded. Each chunk has `uncompressed_size == len(records)` up to the
  `max_chunk_bytes` bound and a nonzero `uncompressed_crc` equal to CRC-32 of its records. Chunks
  hold only Schema/Channel/Message records. Each chunk's message start/end time equals the min/max
  message log time, and empty chunks are rejected.
* Every channel with messages in a chunk has exactly one MessageIndex after that chunk. Its entries
  equal that channel's (log_time, offset) pairs in record order or sorted by (log_time, offset).
* Definitions are checked in file order with the same rules as the reference reader. A Schema/Channel
  id must be defined before use, may be repeated only with identical bytes, and Schema id 0 is
  reserved.
* Exactly one DataEnd, with a nonzero data_section_crc equal to CRC-32 of every preceding byte
  (magic included).
* The summary section is required. It starts right after DataEnd and holds only Schema/Channel
  repeats (byte-identical, covering every data-section definition), one ChunkIndex per chunk in file
  order (every field exact) and exactly one Statistics record (every count and time exact). Records
  of the same opcode must be contiguous. SummaryOffset records, when present, must describe every
  group exactly.
* Footer: summary_start/summary_offset_start must agree with the actual layout. A nonzero
  summary_crc must equal CRC-32 from summary_start through summary_offset_start. Zero is allowed by
  the spec and is reported as `absent`; it is not reported as verified. Every summary record is
  cross-checked against the data section either way.

`flat_projection` copies the original Header body and every data-section Schema/Channel/Message body
byte-for-byte, in physical order, into an in-memory flat MCAP (a new DataEnd CRC, a zero Footer).
That projection is the input to the published reader's payload/semantic checks. It is not the
recording, never written to disk, and does not mean the native layout passed the flat reader.
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from dataclasses import dataclass, field

MAGIC = b"\x89MCAP0\r\n"
OP_HEADER, OP_FOOTER, OP_SCHEMA, OP_CHANNEL, OP_MESSAGE = 0x01, 0x02, 0x03, 0x04, 0x05
OP_CHUNK, OP_MESSAGE_INDEX, OP_CHUNK_INDEX = 0x06, 0x07, 0x08
OP_ATTACHMENT, OP_ATTACHMENT_INDEX, OP_STATISTICS = 0x09, 0x0A, 0x0B
OP_METADATA, OP_METADATA_INDEX, OP_SUMMARY_OFFSET, OP_DATA_END = 0x0C, 0x0D, 0x0E, 0x0F
SUMMARY_GROUP_OPS = (OP_SCHEMA, OP_CHANNEL, OP_CHUNK_INDEX, OP_STATISTICS)

DEFAULT_MAX_CHUNK_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_RECORDS = 5_000_000


class ContainerRejected(ValueError):
    """The bytes are not a strictly valid indexed MCAP container in the supported layout."""

    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def require(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise ContainerRejected(code, detail)


class _Cursor:
    """Bounds-checked little-endian field reader over one record body."""

    def __init__(self, buf: bytes, what: str):
        self.buf, self.pos, self.what = buf, 0, what

    def take(self, n: int) -> bytes:
        require(
            0 <= n <= len(self.buf) - self.pos,
            "E_CONTAINER_TRUNCATED",
            f"{self.what} field",
        )
        out = self.buf[self.pos : self.pos + n]
        self.pos += n
        return out

    def u(self, fmt: str) -> int:
        size = struct.calcsize(fmt)
        return struct.unpack("<" + fmt, self.take(size))[0]

    def string(self) -> str:
        raw = self.take(self.u("I"))
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ContainerRejected("E_CONTAINER_STRING", self.what) from None

    def string_map(self) -> dict[str, str]:
        length = self.u("I")
        end = self.pos + length
        require(end <= len(self.buf), "E_CONTAINER_TRUNCATED", f"{self.what} map")
        out: dict[str, str] = {}
        while self.pos < end:
            k = self.string()
            require(k not in out, "E_CONTAINER_DUPLICATE_KEY", self.what)
            out[k] = self.string()
        require(self.pos == end, "E_CONTAINER_TRUNCATED", f"{self.what} map")
        return out

    def done(self) -> None:
        require(
            self.pos == len(self.buf),
            "E_CONTAINER_RECORD_LENGTH",
            {"record": self.what, "unread_bytes": len(self.buf) - self.pos},
        )


@dataclass(frozen=True)
class Record:
    op: int
    start: int  # absolute offset of the opcode byte (file offset, or offset within chunk records)
    end: int  # exclusive end of the record
    body: bytes


def _records(buf: bytes, start: int, stop: int, max_records: int, where: str):
    pos, count = start, 0
    while pos < stop:
        require(pos + 9 <= stop, "E_CONTAINER_TRUNCATED", f"{where} record header")
        op = buf[pos]
        (length,) = struct.unpack_from("<Q", buf, pos + 1)
        require(
            length <= stop - pos - 9, "E_CONTAINER_TRUNCATED", f"{where} record body"
        )
        count += 1
        require(count <= max_records, "E_CONTAINER_RECORD_LIMIT", max_records)
        end = pos + 9 + length
        yield Record(op, pos, end, buf[pos + 9 : end])
        pos = end


def _record_bytes(op: int, body: bytes) -> bytes:
    return bytes([op]) + struct.pack("<Q", len(body)) + body


@dataclass(frozen=True)
class Message:
    channel: int
    sequence: int
    log_time: int
    publish_time: int
    data: bytes
    chunk: int
    offset: int  # offset of the Message record within the chunk's uncompressed records


@dataclass
class IndexedContainer:
    profile: str
    library: str
    header_body: bytes
    # Data-section Schema/Channel/Message bodies in physical order (top level and inside chunks).
    entries: list[tuple[int, bytes]] = field(default_factory=list)
    schemas: dict[int, bytes] = field(default_factory=dict)  # id -> exact Schema body
    channels: dict[int, bytes] = field(default_factory=dict)  # id -> exact Channel body
    channel_topics: dict[int, str] = field(default_factory=dict)
    messages: list[Message] = field(default_factory=list)
    facts: dict = field(default_factory=dict)


class _Definitions:
    """Reference-reader definition rules applied in file order."""

    def __init__(self, out: IndexedContainer):
        self.out = out

    def schema(self, body: bytes) -> None:
        c = _Cursor(body, "Schema")
        sid = c.u("H")
        c.string()
        c.string()
        c.take(c.u("I"))
        c.done()
        require(sid != 0, "E_CONTAINER_DEFINITION_CONFLICT", "schema id 0 is reserved")
        prior = self.out.schemas.get(sid)
        require(
            prior in (None, body), "E_CONTAINER_DEFINITION_CONFLICT", f"schema {sid}"
        )
        self.out.schemas[sid] = body
        self.out.entries.append((OP_SCHEMA, body))

    def channel(self, body: bytes) -> None:
        c = _Cursor(body, "Channel")
        cid, sid = c.u("H"), c.u("H")
        topic = c.string()
        c.string()
        c.string_map()
        c.done()
        require(
            sid == 0 or sid in self.out.schemas,
            "E_CONTAINER_DEFINITION_ORDER",
            f"channel {cid} before schema {sid}",
        )
        prior = self.out.channels.get(cid)
        require(
            prior in (None, body), "E_CONTAINER_DEFINITION_CONFLICT", f"channel {cid}"
        )
        self.out.channels[cid] = body
        self.out.channel_topics[cid] = topic
        self.out.entries.append((OP_CHANNEL, body))

    def message(self, body: bytes, chunk: int, offset: int) -> Message:
        require(len(body) >= 22, "E_CONTAINER_TRUNCATED", "Message header")
        cid, seq, log, pub = struct.unpack_from("<HIQQ", body, 0)
        require(
            cid in self.out.channels,
            "E_CONTAINER_DEFINITION_ORDER",
            f"message before channel {cid}",
        )
        msg = Message(cid, seq, log, pub, body[22:], chunk, offset)
        self.out.messages.append(msg)
        self.out.entries.append((OP_MESSAGE, body))
        return msg


@dataclass
class _Chunk:
    index: int
    start: int
    length: int
    message_start_time: int
    message_end_time: int
    uncompressed_size: int
    compressed_size: int
    compression: str
    by_channel: dict[
        int, list[tuple[int, int]]
    ]  # channel -> [(log_time, offset)] record order
    message_indexes: dict[int, int] = field(
        default_factory=dict
    )  # channel -> MI file offset
    mi_start: int | None = None
    mi_end: int | None = None


def _parse_chunk(
    rec: Record,
    index: int,
    defs: _Definitions,
    max_chunk_bytes: int,
    max_records: int,
    crcs_required: bool,
) -> _Chunk:
    c = _Cursor(rec.body, "Chunk")
    start_t, end_t, usize, crc = c.u("Q"), c.u("Q"), c.u("Q"), c.u("I")
    compression = c.string()
    records = c.take(c.u("Q"))
    c.done()
    require(
        compression == "",
        "E_CONTAINER_UNSUPPORTED_COMPRESSION",
        {"chunk": index, "compression": compression},
    )
    require(
        usize <= max_chunk_bytes,
        "E_CONTAINER_CHUNK_BOUND",
        {"chunk": index, "uncompressed_size": usize, "limit": max_chunk_bytes},
    )
    require(
        usize == len(records),
        "E_CONTAINER_CHUNK_SIZE",
        {"chunk": index, "uncompressed_size": usize, "records": len(records)},
    )
    require(
        crc != 0 or not crcs_required, "E_CONTAINER_CHUNK_CRC_ABSENT", {"chunk": index}
    )
    require(
        crc == 0 or zlib.crc32(records) == crc,
        "E_CONTAINER_CHUNK_CRC",
        {"chunk": index},
    )
    by_channel: dict[int, list[tuple[int, int]]] = {}
    times: list[int] = []
    for r in _records(records, 0, len(records), max_records, f"chunk {index}"):
        if r.op == OP_SCHEMA:
            defs.schema(r.body)
        elif r.op == OP_CHANNEL:
            defs.channel(r.body)
        elif r.op == OP_MESSAGE:
            m = defs.message(r.body, index, r.start)
            by_channel.setdefault(m.channel, []).append((m.log_time, r.start))
            times.append(m.log_time)
        else:
            raise ContainerRejected(
                "E_CONTAINER_CHUNK_RECORD", {"chunk": index, "opcode": r.op}
            )
    require(bool(times), "E_CONTAINER_EMPTY_CHUNK", {"chunk": index})
    require(
        (start_t, end_t) == (min(times), max(times)),
        "E_CONTAINER_CHUNK_TIME",
        {
            "chunk": index,
            "declared": [start_t, end_t],
            "actual": [min(times), max(times)],
        },
    )
    return _Chunk(
        index, rec.start, rec.end - rec.start, start_t, end_t, usize, len(records),
        compression, by_channel,
    )  # fmt: skip


def _message_index(rec: Record, chunk: _Chunk | None) -> None:
    require(
        chunk is not None, "E_CONTAINER_MESSAGE_INDEX", "MessageIndex not after a Chunk"
    )
    c = _Cursor(rec.body, "MessageIndex")
    cid = c.u("H")
    n = c.u("I")
    require(
        n % 16 == 0, "E_CONTAINER_MESSAGE_INDEX", {"chunk": chunk.index, "bytes": n}
    )
    entries = [(c.u("Q"), c.u("Q")) for _ in range(n // 16)]
    c.done()
    actual = chunk.by_channel.get(cid)
    require(
        actual is not None and cid not in chunk.message_indexes,
        "E_CONTAINER_MESSAGE_INDEX",
        {
            "chunk": chunk.index,
            "channel": cid,
            "reason": "unknown or duplicate channel",
        },
    )
    require(
        entries == actual or entries == sorted(actual),
        "E_CONTAINER_MESSAGE_INDEX",
        {"chunk": chunk.index, "channel": cid, "reason": "entries differ from chunk"},
    )
    chunk.message_indexes[cid] = rec.start
    if chunk.mi_start is None:
        chunk.mi_start = rec.start
    chunk.mi_end = rec.end


def _close_chunk(chunk: _Chunk | None) -> None:
    if chunk is not None:
        missing = sorted(set(chunk.by_channel) - set(chunk.message_indexes))
        require(
            not missing,
            "E_CONTAINER_MESSAGE_INDEX",
            {"chunk": chunk.index, "missing_channels": missing},
        )


def validate(
    data: bytes,
    *,
    max_chunk_bytes: int = DEFAULT_MAX_CHUNK_BYTES,
    max_records: int = DEFAULT_MAX_RECORDS,
    crcs_required: bool = True,
) -> IndexedContainer:
    """Validate `data`.

    `crcs_required=False` (zero chunk/data CRCs tolerated; nonzero ones are still verified) exists
    only to diagnose payloads of old prototype sources. The strict capture gate never passes it, and
    the facts mark such a result DIAGNOSTIC_ONLY.
    """
    try:
        return _validate(data, max_chunk_bytes, max_records, crcs_required)
    except struct.error:
        raise ContainerRejected("E_CONTAINER_TRUNCATED", "record fields") from None


def _validate(
    data: bytes, max_chunk_bytes: int, max_records: int, crcs_required: bool
) -> IndexedContainer:
    require(
        len(data) >= 2 * len(MAGIC) and data.startswith(MAGIC),
        "E_CONTAINER_MAGIC",
        "leading magic",
    )
    require(data.endswith(MAGIC), "E_CONTAINER_TRUNCATED", "closing magic")
    stop = len(data) - len(MAGIC)
    out: IndexedContainer | None = None
    defs: _Definitions | None = None
    chunks: list[_Chunk] = []
    current: _Chunk | None = None
    data_end_at: int | None = None  # file offset just past DataEnd
    footer: Record | None = None
    summary: list[Record] = []
    data_crc = None

    for rec in _records(data, len(MAGIC), stop, max_records, "file"):
        require(footer is None, "E_CONTAINER_TRAILING_DATA", "record after Footer")
        if rec.start == len(MAGIC):
            require(rec.op == OP_HEADER, "E_CONTAINER_HEADER", "Header must be first")
            c = _Cursor(rec.body, "Header")
            profile, library = c.string(), c.string()
            c.done()
            out = IndexedContainer(profile, library, rec.body)
            defs = _Definitions(out)
            continue
        assert out is not None and defs is not None
        require(rec.op != OP_HEADER, "E_CONTAINER_HEADER", "repeated Header")
        if rec.op == OP_FOOTER:
            require(data_end_at is not None, "E_CONTAINER_DATA_END_MISSING")
            footer = rec
            continue
        if data_end_at is not None:
            summary.append(rec)
            continue
        if rec.op != OP_MESSAGE_INDEX:
            _close_chunk(current)
            current = None
        if rec.op == OP_SCHEMA:
            defs.schema(rec.body)
        elif rec.op == OP_CHANNEL:
            defs.channel(rec.body)
        elif rec.op == OP_CHUNK:
            current = _parse_chunk(
                rec, len(chunks), defs, max_chunk_bytes, max_records, crcs_required
            )
            chunks.append(current)
        elif rec.op == OP_MESSAGE_INDEX:
            _message_index(rec, current)
        elif rec.op == OP_DATA_END:
            c = _Cursor(rec.body, "DataEnd")
            data_crc = c.u("I")
            c.done()
            require(data_crc != 0 or not crcs_required, "E_CONTAINER_DATA_CRC_ABSENT")
            require(
                data_crc == 0 or zlib.crc32(data[: rec.start]) == data_crc,
                "E_CONTAINER_DATA_CRC",
            )
            data_end_at = rec.end
        elif rec.op == OP_MESSAGE:
            raise ContainerRejected(
                "E_CONTAINER_MESSAGE_OUTSIDE_CHUNK", {"offset": rec.start}
            )
        else:
            raise ContainerRejected(
                "E_CONTAINER_UNSUPPORTED_RECORD",
                {"section": "data", "opcode": rec.op, "offset": rec.start},
            )
    require(out is not None, "E_CONTAINER_HEADER", "no records")
    require(footer is not None, "E_CONTAINER_TRUNCATED", "no Footer")
    require(bool(chunks), "E_CONTAINER_NO_CHUNKS", "not an indexed/chunked layout")
    assert out is not None and footer is not None and data_end_at is not None

    c = _Cursor(footer.body, "Footer")
    summary_start, summary_offset_start, summary_crc = c.u("Q"), c.u("Q"), c.u("I")
    c.done()
    require(summary_start != 0, "E_CONTAINER_SUMMARY_MISSING")
    require(
        summary_start == data_end_at and bool(summary),
        "E_CONTAINER_SUMMARY_OFFSET",
        {"summary_start": summary_start, "data_end_at": data_end_at},
    )
    if summary_offset_start:
        offsets = [r for r in summary if r.start >= summary_offset_start]
        body = [r for r in summary if r.start < summary_offset_start]
        require(
            any(r.start == summary_offset_start for r in summary)
            and summary_offset_start > summary_start,
            "E_CONTAINER_SUMMARY_OFFSET",
            {"summary_offset_start": summary_offset_start},
        )
    else:
        offsets, body = [], summary
    if summary_crc:
        crc_end = footer.start + 9 + 16  # through summary_offset_start in the Footer
        require(
            zlib.crc32(data[summary_start:crc_end]) == summary_crc,
            "E_CONTAINER_SUMMARY_CRC",
        )
    _check_summary(out, chunks, body, offsets)

    log_times = [m.log_time for m in out.messages]
    out.facts = {
        "layout": "indexed_chunked",
        "profile": out.profile,
        "library": out.library,
        "chunks": len(chunks),
        "chunk_compression": sorted({ch.compression for ch in chunks}),
        "chunk_crc": "verified_nonzero"
        if crcs_required
        else "DIAGNOSTIC_ONLY_zero_allowed_not_strict",
        "data_section_crc": "verified_nonzero"
        if crcs_required
        else "DIAGNOSTIC_ONLY_zero_allowed_not_strict",
        "summary_crc": "verified" if summary_crc else "absent_summary_cross_validated",
        "message_indexes": sum(len(ch.message_indexes) for ch in chunks),
        "summary_offsets": len(offsets),
        "messages": len(out.messages),
        "schemas": len(out.schemas),
        "channels": len(out.channels),
        "file_order_is_log_time_order": log_times == sorted(log_times),
    }
    return out


def _check_summary(
    out: IndexedContainer,
    chunks: list[_Chunk],
    body: list[Record],
    offsets: list[Record],
) -> None:
    groups: list[tuple[int, int, int]] = []  # (opcode, start, end), contiguous
    for r in body:
        require(
            r.op in SUMMARY_GROUP_OPS,
            "E_CONTAINER_UNSUPPORTED_RECORD",
            {"section": "summary", "opcode": r.op, "offset": r.start},
        )
        if groups and groups[-1][0] == r.op:
            groups[-1] = (r.op, groups[-1][1], r.end)
        else:
            require(
                all(g[0] != r.op for g in groups),
                "E_CONTAINER_SUMMARY_GROUP",
                {"opcode": r.op, "reason": "non-contiguous group"},
            )
            groups.append((r.op, r.start, r.end))

    schemas = {}
    channels = {}
    chunk_indexes = []
    stats = []
    for r in body:
        if r.op == OP_SCHEMA:
            (sid,) = (
                struct.unpack_from("<H", r.body, 0) if len(r.body) >= 2 else (None,)
            )
            require(
                out.schemas.get(sid) == r.body and sid not in schemas,
                "E_CONTAINER_SUMMARY_DEFINITION",
                {"schema": sid},
            )
            schemas[sid] = r.body
        elif r.op == OP_CHANNEL:
            (cid,) = (
                struct.unpack_from("<H", r.body, 0) if len(r.body) >= 2 else (None,)
            )
            require(
                out.channels.get(cid) == r.body and cid not in channels,
                "E_CONTAINER_SUMMARY_DEFINITION",
                {"channel": cid},
            )
            channels[cid] = r.body
        elif r.op == OP_CHUNK_INDEX:
            chunk_indexes.append(r)
        else:
            stats.append(r)
    require(
        set(schemas) == set(out.schemas) and set(channels) == set(out.channels),
        "E_CONTAINER_SUMMARY_DEFINITION",
        "summary must repeat every data-section Schema and Channel",
    )
    require(
        len(chunk_indexes) == len(chunks),
        "E_CONTAINER_CHUNK_INDEX",
        {"chunk_indexes": len(chunk_indexes), "chunks": len(chunks)},
    )
    for r, ch in zip(chunk_indexes, chunks, strict=True):
        c = _Cursor(r.body, "ChunkIndex")
        got = {
            "message_start_time": c.u("Q"),
            "message_end_time": c.u("Q"),
            "chunk_start_offset": c.u("Q"),
            "chunk_length": c.u("Q"),
        }
        n = c.u("I")
        require(n % 10 == 0, "E_CONTAINER_CHUNK_INDEX", {"chunk": ch.index})
        pairs = [(c.u("H"), c.u("Q")) for _ in range(n // 10)]
        got["message_index_offsets"] = dict(pairs)
        require(
            len(got["message_index_offsets"]) == len(pairs), "E_CONTAINER_CHUNK_INDEX"
        )
        got["message_index_length"] = c.u("Q")
        got["compression"] = c.string()
        got["compressed_size"] = c.u("Q")
        got["uncompressed_size"] = c.u("Q")
        c.done()
        want = {
            "message_start_time": ch.message_start_time,
            "message_end_time": ch.message_end_time,
            "chunk_start_offset": ch.start,
            "chunk_length": ch.length,
            "message_index_offsets": ch.message_indexes,
            "message_index_length": (ch.mi_end or 0) - (ch.mi_start or 0),
            "compression": ch.compression,
            "compressed_size": ch.compressed_size,
            "uncompressed_size": ch.uncompressed_size,
        }
        mismatched = sorted(k for k in want if got[k] != want[k])
        require(
            not mismatched,
            "E_CONTAINER_CHUNK_INDEX",
            {"chunk": ch.index, "fields": mismatched},
        )
        # MessageIndex records must be contiguous right after their chunk.
        require(
            ch.mi_start == ch.start + ch.length,
            "E_CONTAINER_MESSAGE_INDEX",
            {"chunk": ch.index, "reason": "not contiguous after chunk"},
        )

    require(len(stats) == 1, "E_CONTAINER_STATISTICS", {"records": len(stats)})
    c = _Cursor(stats[0].body, "Statistics")
    got = {
        "message_count": c.u("Q"),
        "schema_count": c.u("H"),
        "channel_count": c.u("I"),
        "attachment_count": c.u("I"),
        "metadata_count": c.u("I"),
        "chunk_count": c.u("I"),
        "message_start_time": c.u("Q"),
        "message_end_time": c.u("Q"),
    }
    n = c.u("I")
    require(n % 10 == 0, "E_CONTAINER_STATISTICS", "channel_message_counts length")
    pairs = [(c.u("H"), c.u("Q")) for _ in range(n // 10)]
    c.done()
    counts: dict[int, int] = {}
    for m in out.messages:
        counts[m.channel] = counts.get(m.channel, 0) + 1
    declared = dict(pairs)
    times = [m.log_time for m in out.messages]
    want = {
        "message_count": len(out.messages),
        "schema_count": len(out.schemas),
        "channel_count": len(out.channels),
        "attachment_count": 0,
        "metadata_count": 0,
        "chunk_count": len(chunks),
        "message_start_time": min(times),
        "message_end_time": max(times),
    }
    mismatched = sorted(k for k in want if got[k] != want[k])
    # Channels with messages must be counted exactly; a zero entry is allowed only for a defined channel.
    counts_ok = len(declared) == len(pairs) and all(
        declared.get(cid) == n for cid, n in counts.items()
    ) and all(
        cid in out.channels and (v == counts.get(cid, 0)) for cid, v in declared.items()
    )  # fmt: skip
    if not counts_ok:
        mismatched.append("channel_message_counts")
    require(not mismatched, "E_CONTAINER_STATISTICS", {"fields": mismatched})

    want_offsets = {(op, start, end - start) for op, start, end in groups}
    got_offsets = []
    for r in offsets:
        require(
            r.op == OP_SUMMARY_OFFSET,
            "E_CONTAINER_UNSUPPORTED_RECORD",
            {"section": "summary_offset", "opcode": r.op, "offset": r.start},
        )
        c = _Cursor(r.body, "SummaryOffset")
        got_offsets.append((c.u("B"), c.u("Q"), c.u("Q")))
        c.done()
    if offsets:
        require(
            len(set(got_offsets)) == len(got_offsets)
            and set(got_offsets) == want_offsets,
            "E_CONTAINER_SUMMARY_OFFSET",
            {"declared": sorted(got_offsets), "actual": sorted(want_offsets)},
        )


def flat_projection(container: IndexedContainer) -> bytes:
    """In-memory flat MCAP for the published reader's payload checks (validation only).

    Copies the original Header body and every data-section Schema/Channel/Message body byte-for-byte
    in physical order. Only the container framing (DataEnd CRC, zero Footer) is new.
    """
    parts = [MAGIC, _record_bytes(OP_HEADER, container.header_body)]
    parts += [_record_bytes(op, body) for op, body in container.entries]
    prefix = b"".join(parts)
    data_end = _record_bytes(OP_DATA_END, struct.pack("<I", zlib.crc32(prefix)))
    footer = _record_bytes(OP_FOOTER, struct.pack("<QQI", 0, 0, 0))
    return prefix + data_end + footer + MAGIC


def projection_sha256(container: IndexedContainer) -> str:
    return hashlib.sha256(flat_projection(container)).hexdigest()


def official_crosscheck(data: bytes, container: IndexedContainer) -> dict:
    """Independent agreement with the official `mcap` Python library (validate_crcs=True).

    Requires the locked `mcap==1.6.0` wheel; raises ContainerRejected on any disagreement.
    """
    import io

    from mcap.reader import make_reader
    from mcap.records import Message as OfficialMessage
    from mcap.stream_reader import StreamReader

    mine = [
        (m.channel, m.sequence, m.log_time, m.publish_time, m.data)
        for m in container.messages
    ]
    try:
        streamed = [
            (r.channel_id, r.sequence, r.log_time, r.publish_time, r.data)
            for r in StreamReader(io.BytesIO(data), validate_crcs=True).records
            if isinstance(r, OfficialMessage)
        ]
        reader = make_reader(io.BytesIO(data), validate_crcs=True)
        summary = reader.get_summary()
        indexed = [
            (m.channel_id, m.sequence, m.log_time, m.publish_time, m.data)
            for _, _, m in reader.iter_messages(log_time_order=False)
        ]
    except Exception as e:  # noqa: BLE001 - any official-reader failure is a disagreement
        raise ContainerRejected(
            "E_CONTAINER_OFFICIAL_READER", type(e).__name__
        ) from None
    require(streamed == mine, "E_CONTAINER_OFFICIAL_MISMATCH", "stream order/payloads")
    require(
        sorted(indexed, key=lambda t: (t[2], t[0], t[1])) == sorted(mine, key=lambda t: (t[2], t[0], t[1])),
        "E_CONTAINER_OFFICIAL_MISMATCH",
        "indexed read",
    )  # fmt: skip
    require(
        summary is not None
        and summary.statistics is not None
        and summary.statistics.message_count == len(mine)
        and len(summary.chunk_indexes) == container.facts["chunks"],
        "E_CONTAINER_OFFICIAL_MISMATCH",
        "summary",
    )
    import mcap

    return {
        "library": "mcap (official Python)",
        "version": getattr(mcap, "__version__", "1.6.0"),
        "validate_crcs": True,
        "stream_messages_equal_in_file_order": True,
        "indexed_messages_equal": True,
        "statistics_message_count": summary.statistics.message_count,
        "chunk_indexes": len(summary.chunk_indexes),
    }
