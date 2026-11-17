"""Strict h264_mcap_v1 gate and access-unit/timeline adapter for the SA-61 probe (stdlib only).

This module does not parse the capture contract itself. Every source is first evaluated by the
published SA-50 reference reader (`packages/contracts/capture/conformance/python/
capture_conformance.py`) on its original bytes. A flat portable file must be `accept`.

Native recorders write standard indexed (chunked) MCAP, which the portable reader rejects as
`E_UNSUPPORTED_LAYOUT` by design. Only in that case, `indexed_mcap.validate` checks the original
container independently: CRCs, chunk/message/summary indexes, statistics, bounds and definition
order. It then builds an in-memory, validation-only flat projection holding the identical
Header/Schema/Channel/Message bodies in physical order. The unmodified reference checker evaluates
that projection for every payload/semantic rule. The projection's records must equal the
container's exactly. The result records both layers, and it never claims that the native layout
passed the flat reader.

Accepted video messages are then joined to the reader's own facts (sequence, SHA-256, encoder PTS,
source frame id, capture/log time) and handed to the decoder. Any disagreement is a hard error;
nothing is repaired or re-timed.

Bounds: the whole source is read into memory once with an explicit cap (`DEFAULT_MAX_SOURCE_BYTES`),
and indexed chunks are uncompressed and individually bounded.
"""

from __future__ import annotations

import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
CONFORMANCE = REPO / "packages/contracts/capture/conformance/python"
if str(CONFORMANCE) not in sys.path:
    sys.path.insert(0, str(CONFORMANCE))

import capture_conformance as cc  # noqa: E402  (published SA-50 reference reader)
import indexed_mcap  # noqa: E402

DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_FRAMES = 36_000  # 20 min at 30 fps; the spike is not a two-hour qualification
TIME_BASE = (1, 1_000_000)  # contract-fixed encoder time base (seconds per tick)


class CaptureRejected(ValueError):
    """The source is not an accepted, internally consistent h264_mcap_v1 capture."""

    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def require(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise CaptureRejected(code, detail)


@dataclass(frozen=True)
class AccessUnit:
    """One accepted, complete Annex B image access unit with its original identities."""

    index: int  # decode order in the source (== MCAP video sequence order)
    sequence: int  # MCAP channel sequence == FrameEvent output_sequence
    source_frame_id: (
        str  # original acquisition id (int64 decimal string, never re-numbered)
    )
    encoder_pts_us: int  # original encoder PTS, time base 1/1_000_000
    capture_time_ns: str  # mapped capture time (derived evidence, decimal string)
    log_time_ns: str  # MCAP log time (decimal string)
    frame_id: str  # optical coordinate frame name, NOT an image id
    idr: bool
    sha256: str
    data: bytes

    @property
    def nal_types(self) -> list[int]:
        return [n[0] & 31 for n in cc.nals(self.data)]

    @property
    def vcl_sha256(self) -> list[str]:
        return [
            hashlib.sha256(n).hexdigest()
            for n in cc.nals(self.data)
            if n[0] & 31 in (1, 5)
        ]


@dataclass(frozen=True)
class StrictCapture:
    source_sha256: str
    source_bytes: int
    result: dict  # exact reference-reader result (outcome accept)
    access_units: list[AccessUnit]
    container: dict  # which layout was validated and how (see gate)

    @property
    def facts(self) -> dict:
        return self.result["facts"]

    @property
    def auto_admissible(self) -> bool | None:
        """Reader fact: clean `completed` take only (v1.2+); None for frozen v1.1 files.

        This is a capture-integrity fact. It is NOT server, device or qualification admission: an
        accepted clean `aborted` file passes the gate (its bytes are internally consistent) but is
        never automatically admissible.
        """
        return self.facts.get("auto_admissible")


def read_bounded(path: Path, max_bytes: int) -> bytes:
    size = path.stat().st_size
    require(
        size <= max_bytes, "E_SOURCE_TOO_LARGE", {"bytes": size, "limit": max_bytes}
    )
    with path.open("rb") as f:
        data = f.read(max_bytes + 1)
    require(len(data) == size, "E_SOURCE_CHANGED_WHILE_READING")
    return data


def load(
    path: Path | str,
    *,
    max_bytes: int = DEFAULT_MAX_SOURCE_BYTES,
    expected_sha256: str | None = None,
):
    data = read_bounded(Path(path), max_bytes)
    digest = hashlib.sha256(data).hexdigest()
    if expected_sha256 is not None:
        require(digest == expected_sha256, "E_SOURCE_HASH_MISMATCH", {"actual": digest})
    return gate(data, digest)


def gate(data: bytes, digest: str | None = None) -> StrictCapture:
    digest = digest or hashlib.sha256(data).hexdigest()
    result = cc.check(data)
    container: dict = {
        "layout": "flat_portable",
        "reference_reader_input": "original_bytes",
    }
    checked = data
    indexed = None
    if result["outcome"] == "reject" and result["errors"] == ["E_UNSUPPORTED_LAYOUT"]:
        try:
            indexed = indexed_mcap.validate(data)
        except indexed_mcap.ContainerRejected as e:
            raise CaptureRejected(
                "E_CAPTURE_NOT_ACCEPTED",
                {
                    "outcome": result["outcome"],
                    "errors": result["errors"],
                    "indexed_container": {"errors": [e.code], "detail": e.detail},
                },
            ) from None
        checked = indexed_mcap.flat_projection(indexed)
        result = cc.check(checked)
        container = {
            **indexed.facts,
            "original_on_portable_reader": ["E_UNSUPPORTED_LAYOUT"],
            "reference_reader_input": "validation_projection_in_memory",
            "projection_sha256": hashlib.sha256(checked).hexdigest(),
            "projection_note": "identical Header/Schema/Channel/Message bodies in physical "
            "order; new flat framing only; not the recording and never written",
        }
    require(
        result["outcome"] == "accept",
        "E_CAPTURE_NOT_ACCEPTED",
        {
            "outcome": result["outcome"],
            "errors": result["errors"],
            **({"indexed_container": container} if indexed is not None else {}),
            **(
                {"schema_violations": result["facts"]["schema_violations"][:20]}
                if "schema_violations" in result["facts"]
                else {}
            ),
        },
    )
    parsed = cc.read_mcap(
        checked
    )  # already validated by check(); re-read only to obtain payload bytes
    if indexed is not None:
        # The projection must be lossless at record level: same messages/definitions, same order.
        projected = [
            (m["channel"], m["sequence"], m["log_time"], m["publish_time"], m["data"])
            for m in parsed["messages"]
        ]
        original = [
            (m.channel, m.sequence, m.log_time, m.publish_time, m.data)
            for m in indexed.messages
        ]
        require(projected == original, "E_PROJECTION_NOT_LOSSLESS", "messages")
        require(
            set(parsed["schemas"]) == set(indexed.schemas)
            and set(parsed["channels"]) == set(indexed.channels),
            "E_PROJECTION_NOT_LOSSLESS",
            "definitions",
        )
    topics = {cid: ch["topic"] for cid, ch in parsed["channels"].items()}
    videos = [m for m in parsed["messages"] if topics[m["channel"]] == cc.VIDEO_CHANNEL]
    facts = result["facts"]["video"]
    require(
        len(videos) == len(facts),
        "E_VIDEO_FACT_COUNT",
        {"messages": len(videos), "facts": len(facts)},
    )
    require(0 < len(videos) <= MAX_FRAMES, "E_FRAME_LIMIT", len(videos))
    units: list[AccessUnit] = []
    for i, (msg, fact) in enumerate(zip(videos, facts, strict=True)):
        video = cc.decode_video(msg["data"])
        payload = video["data"]
        sha = hashlib.sha256(payload).hexdigest()
        require(sha == fact["sha256"], "E_VIDEO_FACT_HASH", i)
        require(msg["sequence"] == fact["sequence"], "E_VIDEO_FACT_SEQUENCE", i)
        require(str(msg["log_time"]) == fact["log_time_ns"], "E_VIDEO_FACT_LOG_TIME", i)
        require(video["format"] == "h264" == fact["format"], "E_VIDEO_FORMAT", i)
        errors, idr = cc.classify_au(payload)
        require(
            not errors and idr == fact["idr"],
            "E_ACCESS_UNIT",
            {"index": i, "errors": errors},
        )
        units.append(
            AccessUnit(
                index=i,
                sequence=fact["sequence"],
                source_frame_id=fact["source_frame_id"],
                encoder_pts_us=int(fact["encoder_pts_us"]),
                capture_time_ns=fact["capture_time_ns"],
                log_time_ns=fact["log_time_ns"],
                frame_id=fact["frame_id"],
                idr=idr,
                sha256=sha,
                data=payload,
            )
        )
    require(units[0].idr, "E_FIRST_NOT_IDR")
    for a, b in zip(units, units[1:]):
        # Decode order must equal presentation order: no B-frame reordering and no ambiguous mapping.
        require(
            b.encoder_pts_us > a.encoder_pts_us,
            "E_PTS_NOT_INCREASING",
            {"index": b.index},
        )
        require(
            b.sequence > a.sequence, "E_SEQUENCE_NOT_INCREASING", {"index": b.index}
        )
    require(
        len({u.source_frame_id for u in units}) == len(units),
        "E_DUPLICATE_SOURCE_FRAME",
    )
    return StrictCapture(digest, len(data), result, units, container)


def plan_clips(units: list[AccessUnit], max_clip_us: int) -> list[list[AccessUnit]]:
    """Split at IDRs only. A clip is extended to the next IDR boundary at/after max_clip_us.

    A clip never starts on a non-IDR access unit; if the source has a GOP longer than the
    bound, that whole GOP becomes one (longer) clip rather than an undecodable fragment.
    """
    require(max_clip_us > 0, "E_CLIP_BOUND")
    clips: list[list[AccessUnit]] = []
    for u in units:
        if u.idr and (
            not clips or u.encoder_pts_us - clips[-1][0].encoder_pts_us >= max_clip_us
        ):
            clips.append([u])
        else:
            require(bool(clips), "E_FIRST_NOT_IDR")
            clips[-1].append(u)
    for clip in clips:
        require(clip[0].idr, "E_CLIP_NOT_IDR_START")
    return clips


def clip_pts(unit: AccessUnit, clip: list[AccessUnit]) -> int:
    """clip_pts = source_pts - first_included_source_pts (exact integer microseconds)."""
    return unit.encoder_pts_us - clip[0].encoder_pts_us


def summary(capture: StrictCapture) -> dict:
    facts = capture.facts
    return {
        "reader": "packages/contracts/capture/conformance/python/capture_conformance.py",
        "container": capture.container,
        "outcome": capture.result["outcome"],
        "errors": capture.result["errors"],
        "close_outcome": facts["close_outcome"],
        "wire_contract_revision": facts.get(
            "wire_contract_revision", "stateaction.capture.v1.1"
        ),
        "close_stop_reason": facts.get("close_stop_reason"),
        "encoder_drain": facts.get("encoder_drain"),
        "auto_admissible": capture.auto_admissible,
        "auto_admissible_scope": "capture_integrity_only_not_server_or_device_qualification",
        "frame_event_counts": facts["frame_event_counts"],
        "channel_counts": facts["channel_counts"],
        "unresolved_frames": facts["unresolved_frames"],
        "video_messages": len(capture.access_units),
        "idr_count": sum(u.idr for u in capture.access_units),
        "source_frame_ids": [u.source_frame_id for u in capture.access_units],
        "encoder_pts_us": [str(u.encoder_pts_us) for u in capture.access_units],
        "encoder_time_base": list(TIME_BASE),
    }


if __name__ == "__main__":
    cap = load(Path(sys.argv[1]))
    print(json.dumps({"source_sha256": cap.source_sha256, **summary(cap)}, indent=2))
