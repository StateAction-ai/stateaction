"""Test-only writer: re-frame a flat SA-50 golden MCAP as a legal indexed/chunked MCAP.

The Header/Schema/Channel/Message record bodies are copied byte-for-byte, in their original order,
into uncompressed chunks with MessageIndex records, and the summary is built the way the official
writer builds it. This produces synthetic container fixtures only; it never qualifies a recording.
Keyword overrides corrupt one specific field so negative tests can target a single rule.
"""

from __future__ import annotations

import struct
import zlib

MAGIC = b"\x89MCAP0\r\n"


def rec(op: int, body: bytes) -> bytes:
    return bytes([op]) + struct.pack("<Q", len(body)) + body


def s(text: str) -> bytes:
    raw = text.encode()
    return struct.pack("<I", len(raw)) + raw


def flat_records(data: bytes) -> tuple[bytes, list[tuple[int, bytes]]]:
    """(header body, [(op, body)] for Schema/Channel/Message) of a flat portable golden file."""
    assert data.startswith(MAGIC)
    pos, header, out = len(MAGIC), None, []
    while True:
        op = data[pos]
        (n,) = struct.unpack_from("<Q", data, pos + 1)
        body = data[pos + 9 : pos + 9 + n]
        pos += 9 + n
        if op == 0x01:
            header = body
        elif op in (0x03, 0x04, 0x05):
            out.append((op, body))
        elif op == 0x0F:
            return header, out
        else:
            raise ValueError(f"not a flat golden: opcode {op:#x}")


def build(
    header: bytes,
    records: list[tuple[int, bytes]],
    *,
    messages_per_chunk: int = 7,
    compression: str = "",
    zero_chunk_crc: bool = False,
    zero_data_crc: bool = False,
    summary_crc: bool = True,
    sorted_message_index: bool = False,
    drop_message_index: bool = False,
    message_index_shift: int = 0,
    chunk_index_offset_shift: int = 0,
    chunk_time_shift: int = 0,
    statistics_count_shift: int = 0,
    omit_summary_schema: bool = False,
    summary_offset_shift: int = 0,
    top_level_message: bool = False,
    attachment: bool = False,
) -> bytes:
    groups: list[list[tuple[int, bytes]]] = [[]]
    for op, body in records:
        if op == 0x05 and sum(o == 0x05 for o, _ in groups[-1]) >= messages_per_chunk:
            groups.append([])
        groups[-1].append((op, body))

    out = bytearray(MAGIC + rec(0x01, header))
    schemas: dict[int, bytes] = {}
    channels: dict[int, bytes] = {}
    chunk_indexes: list[bytes] = []
    counts: dict[int, int] = {}
    times: list[int] = []
    pending_top = top_level_message
    for gi, group in enumerate(groups):
        payload = bytearray()
        index: dict[int, list[tuple[int, int]]] = {}
        ctimes = []
        for op, body in group:
            if op == 0x03:
                schemas[struct.unpack_from("<H", body)[0]] = body
            elif op == 0x04:
                channels[struct.unpack_from("<H", body)[0]] = body
            else:
                cid, _, log = struct.unpack_from("<HIQ", body)
                index.setdefault(cid, []).append((log, len(payload)))
                counts[cid] = counts.get(cid, 0) + 1
                ctimes.append(log)
                times.append(log)
            payload += rec(op, body)
        if not ctimes:
            continue
        if (
            pending_top and gi > 0
        ):  # a top-level message between chunks is outside the layout
            out += rec(0x05, next(b for o, b in groups[0] if o == 0x05))
            pending_top = False
        if attachment:
            out += rec(
                0x09,
                struct.pack("<QQ", 0, 0)
                + s("a")
                + s("x")
                + struct.pack("<Q", 0)
                + struct.pack("<I", 0),
            )
        payload = bytes(payload)
        start = len(out)
        crc = 0 if zero_chunk_crc else zlib.crc32(payload)
        t0, t1 = min(ctimes) + chunk_time_shift, max(ctimes)
        chunk_body = (
            struct.pack("<QQQI", t0, t1, len(payload), crc)
            + s(compression)
            + struct.pack("<Q", len(payload))
            + payload
        )
        out += rec(0x06, chunk_body)
        chunk_len = len(out) - start
        mi_offsets = {}
        mi_start = len(out)
        for k, (cid, entries) in enumerate(sorted(index.items())):
            if drop_message_index and gi == 0 and k == 0:
                continue
            if sorted_message_index:
                entries = sorted(entries)
            entries = [
                (t, o + (message_index_shift if gi == 0 and k == 0 else 0))
                for t, o in entries
            ]
            mi_offsets[cid] = len(out)
            packed = b"".join(struct.pack("<QQ", t, o) for t, o in entries)
            out += rec(0x07, struct.pack("<HI", cid, len(packed)) + packed)
        mi_len = len(out) - mi_start
        offsets = b"".join(
            struct.pack("<HQ", c, o) for c, o in sorted(mi_offsets.items())
        )
        chunk_indexes.append(
            struct.pack("<QQQQ", t0, t1, start + chunk_index_offset_shift, chunk_len)
            + struct.pack("<I", len(offsets))
            + offsets
            + struct.pack("<Q", mi_len)
            + s(compression)
            + struct.pack("<QQ", len(payload), len(payload))
        )

    data_crc = 0 if zero_data_crc else zlib.crc32(bytes(out))
    out += rec(0x0F, struct.pack("<I", data_crc))

    summary_start = len(out)
    groups_at = []

    def group(op: int, bodies: list[bytes]) -> None:
        if bodies:
            g0 = len(out)
            for b in bodies:
                out.extend(rec(op, b))
            groups_at.append((op, g0, len(out) - g0))

    schema_bodies = [schemas[k] for k in sorted(schemas)]
    if omit_summary_schema:
        schema_bodies = schema_bodies[1:]
    group(0x03, schema_bodies)
    group(0x04, [channels[k] for k in sorted(channels)])
    group(0x08, chunk_indexes)
    cmc = b"".join(struct.pack("<HQ", c, n) for c, n in sorted(counts.items()))
    stats = (
        struct.pack(
            "<QHIIII",
            len(times) + statistics_count_shift,
            len(schemas),
            len(channels),
            0,
            0,
            len(chunk_indexes),
        )
        + struct.pack("<QQ", min(times), max(times))
        + struct.pack("<I", len(cmc))
        + cmc
    )
    group(0x0B, [stats])
    summary_offset_start = len(out)
    for op, g0, glen in groups_at:
        out += rec(0x0E, struct.pack("<BQQ", op, g0, glen + summary_offset_shift))
    footer_prefix = struct.pack("<QQ", summary_start, summary_offset_start)
    crc = (
        zlib.crc32(
            bytes(out[summary_start:])
            + bytes([0x02])
            + struct.pack("<Q", 20)
            + footer_prefix
        )
        if summary_crc
        else 0
    )
    out += rec(0x02, footer_prefix + struct.pack("<I", crc))
    out += MAGIC
    return bytes(out)


def chunked(flat: bytes, **kw) -> bytes:
    header, records = flat_records(flat)
    return build(header, records, **kw)
