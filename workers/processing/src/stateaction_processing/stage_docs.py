"""Module-facing types and the builders for `segments.v1` / `captions.v1` documents.

A stage module (stub, replay, later the FLORA modules) receives a `StageContext` and returns a
`ModuleOutput`. The entrypoint, not the module, owns provenance headers, validation and upload;
the builders here turn frame-index spans and caption outcomes into contract documents, so every
module (and the replay adapter) produces the same truthful shapes:

* a failed window is a `failed_window` row plus an entry in `windows.failed` and
  `windows.failed_core_spans`, never an empty result;
* a caption that failed or was not produced is a row with an `error_code` and no text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .stage_media import FrameMap


class StageError(RuntimeError):
    """A stage cannot produce a truthful document. `code` is a stable machine-readable code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class StageContext:
    stage: str  # segment | caption
    job_id: str
    recording_id: str
    source_manifest_sha256: str
    source_sha256: str  # sha256 of the source MCAP bytes that were remuxed
    module_id: str
    module_version: int
    params: dict[str, Any]
    params_sha256: str
    gpu_requested: str
    frames: FrameMap
    scratch: Path
    beat: Callable[[str, int], None]
    log: Callable[[str], None]
    mp4_path: Path
    manifest: dict[str, Any]  # this module's entry in api/modules.json
    # caption stage only: the exact segments document that was captioned
    segments: dict[str, Any] | None = None
    segments_sha256: str | None = None

    @property
    def module_ref(self) -> str:
        return f"{self.module_id}@{self.module_version}"

    def producer(self, facts: ProducerFacts) -> dict[str, Any]:
        return producer_block(self, facts)


@dataclass(frozen=True)
class ProducerFacts:
    """What only the module knows. Fields a manifest requires must be real, never invented."""

    engine_version: str
    model_revision: str | None = None
    weights_sha256: str | None = None
    prompt_sha256: str | None = None
    quant: dict[str, str] | None = None
    decoding_params: dict[str, Any] = field(default_factory=dict)
    observed_gpu: str | None = None
    ext: dict[str, Any] = field(default_factory=dict)  # replay: original FLORA env.json


@dataclass(frozen=True)
class Span:
    """A segment over MP4 frame indices [start, end); `end == len(frames)` is end of stream."""

    start: int
    end: int
    status: str = "ok"
    ext: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True)
class FailedWindow:
    window_index: int
    error_code: str
    core_start: int
    core_end: int


@dataclass(frozen=True)
class CaptionOutcome:
    segment_id: str
    status: str  # complete | failed | not_captioned
    error_code: str | None = None
    text: str | None = None
    lang: str = "en"


@dataclass
class ModuleOutput:
    document: dict[str, Any]  # the full contract document (header, producer and rows)
    counts: dict[str, int]
    windows_rows: list[dict[str, Any]] = field(
        default_factory=list
    )  # windows.jsonl (segment)
    observed_gpu: str | None = None
    extra_diagnostics: dict[str, bytes] = field(default_factory=dict)  # name -> bytes
    tamper_receipt_digest: bool = False  # stub fault injection only (digest_mismatch)


def producer_block(ctx: StageContext, facts: ProducerFacts) -> dict[str, Any]:
    provenance = ctx.manifest["provenance"]
    return {
        "stage": ctx.stage,
        "module_id": ctx.module_id,
        "module_version": ctx.module_version,
        "model_name": provenance["modelName"],
        "model_revision": facts.model_revision,
        "weights_sha256": facts.weights_sha256,
        "quant": facts.quant,
        "prompt_sha256": facts.prompt_sha256,
        "params_sha256": ctx.params_sha256,
        "decoding_params": facts.decoding_params,
        "engine": {"name": provenance["engine"], "version": facts.engine_version},
        "gpu": {
            "requested_type": ctx.gpu_requested,
            "observed_type": facts.observed_gpu,
        },
    }


def _merge_failed(failed: list[FailedWindow]) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for window in sorted(failed, key=lambda w: w.core_start):
        if spans and window.core_start <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], window.core_end))
        else:
            spans.append((window.core_start, window.core_end))
    return spans


def segments_document(
    ctx: StageContext,
    producer: dict[str, Any],
    spans: list[Span],
    windows_total: int,
    failed: list[FailedWindow],
) -> dict[str, Any]:
    """`stateaction.segments.v1`. `spans` are the ok segments; failed windows add their rows."""
    from stateaction_contracts import segment_id

    frames = ctx.frames
    merged = _merge_failed(failed)
    entries = [Span(s.start, s.end, "ok", s.ext) for s in spans] + [
        Span(a, b, "failed_window") for a, b in merged
    ]
    rows = []
    for ordinal, span in enumerate(sorted(entries, key=lambda s: (s.start, s.end))):
        start, end = frames.ref(span.start), frames.end_ref(span.end)
        rows.append(
            {
                "segment_id": segment_id(
                    ctx.source_manifest_sha256,
                    ctx.module_ref,
                    ctx.params_sha256,
                    start["source_frame_id"],
                    end["source_frame_id"],
                ),
                "ordinal": ordinal,
                "start": start,
                "end": end,
                "status": span.status,
                "ext": span.ext,
            }
        )
    return {
        "schema": "stateaction.segments.v1",
        "job_id": ctx.job_id,
        "recording_id": ctx.recording_id,
        "source_manifest_sha256": ctx.source_manifest_sha256,
        "clock_domain": frames.clock_domain,
        "producer": producer,
        "windows": {
            "total": windows_total,
            "ok": windows_total - len(failed),
            "failed": [
                {
                    "window_index": w.window_index,
                    "error_code": w.error_code,
                    "core_start": frames.ref(w.core_start),
                    "core_end": frames.end_ref(w.core_end),
                }
                for w in failed
            ],
            "failed_core_spans": [
                {"start": frames.ref(a), "end": frames.end_ref(b)} for a, b in merged
            ],
        },
        "rows": rows,
    }


def captions_document(
    ctx: StageContext, producer: dict[str, Any], outcomes: list[CaptionOutcome]
) -> dict[str, Any]:
    """`stateaction.captions.v1`: one row per outcome; failed rows never carry text."""
    from .caption_rule import DerivationError, derive

    if ctx.segments is None or ctx.segments_sha256 is None:
        raise StageError("segments_missing")
    rows: list[dict[str, Any]] = []
    for item in outcomes:
        row: dict[str, Any] = {"segment_id": item.segment_id}
        if item.status == "complete":
            text = (item.text or "").strip(" \t")
            try:
                if not text:
                    raise DerivationError("caption_empty")
                if len(text) > 2000 or any(
                    ord(c) < 0x20 or ord(c) == 0x7F for c in text
                ):
                    raise DerivationError("caption_text_invalid")
                derived = derive(text)
            except DerivationError as error:
                # A caption we cannot store truthfully is a failed row, never an empty one.
                rows.append(
                    {
                        "segment_id": item.segment_id,
                        "status": "failed",
                        "error_code": error.code,
                    }
                )
                continue
            row.update(
                status="complete",
                error_code=None,
                text=text,
                lang=item.lang,
                derived=derived,
            )
        else:
            row.update(
                status=item.status, error_code=item.error_code or "caption_failed"
            )
        rows.append(row)
    return {
        "schema": "stateaction.captions.v1",
        "job_id": ctx.job_id,
        "recording_id": ctx.recording_id,
        "source_manifest_sha256": ctx.source_manifest_sha256,
        "segments_sha256": ctx.segments_sha256,
        "producer": producer,
        "rows": rows,
    }
