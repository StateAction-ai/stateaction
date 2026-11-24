"""Select a contiguous decoded-frame range from a forward-only capture."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, replace
from pathlib import Path
from tempfile import TemporaryFile
from typing import Any

from .capture_stream import AccessUnit, CaptureStream

MAX_FRAMES = 10_000_000


class SourceRangeError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SourceRange:
    start_ordinal: int
    end_ordinal: int

    def __post_init__(self) -> None:
        if not 0 <= self.start_ordinal < self.end_ordinal <= MAX_FRAMES:
            raise SourceRangeError("clip_range_invalid")

    @property
    def frame_count(self) -> int:
        return self.end_ordinal - self.start_ordinal


@dataclass(frozen=True)
class ClipBinding:
    clip_id: str
    plan_sha256: str
    source_range: SourceRange
    first: tuple[str, str]
    last: tuple[str, str]

    @classmethod
    def from_task(cls, task: dict[str, Any]) -> ClipBinding:
        """Read a clip from an already-validated task input."""
        clip = task["clip"]
        span = clip["sourceRange"]
        return cls(
            clip["id"],
            clip["planSha256"],
            SourceRange(span["start_ordinal"], span["end_ordinal"]),
            (span["first_source_frame_id"], span["start_ts_ns"]),
            (span["last_source_frame_id"], span["end_ts_ns"]),
        )


class AccessUnitBuffer:
    """Spool one GOP to scratch without retaining encoded video in memory."""

    def __init__(self, work_dir: Path | None) -> None:
        self._file = TemporaryFile(dir=work_dir)
        self._units: list[tuple[AccessUnit, int]] = []

    def append(self, au: AccessUnit) -> None:
        self._file.write(au.data)
        self._units.append((replace(au, data=b""), len(au.data)))

    def clear(self) -> None:
        self._units.clear()
        self._file.seek(0)
        self._file.truncate()

    def __iter__(self) -> Iterator[AccessUnit]:
        self._file.seek(0)
        for au, size in self._units:
            yield replace(au, data=self._file.read(size))

    def close(self) -> None:
        self._file.close()


def select_access_units(
    stream: CaptureStream, source_range: SourceRange | None, work_dir: Path | None
) -> Iterator[tuple[AccessUnit, int, bool]]:
    """Yield an AU, the clip PTS origin and whether the AU is decode-only."""
    if source_range is None or source_range.start_ordinal == 0:
        for au in stream:
            if au.index == 0:
                origin = au.encoder_pts_us
            if source_range is None or au.index < source_range.end_ordinal:
                yield au, origin, False
        return

    start = source_range.start_ordinal
    end = source_range.end_ordinal
    context = AccessUnitBuffer(work_dir)
    origin = 0
    try:
        for au in stream:
            if au.index < start:
                if au.is_idr:
                    context.clear()
                context.append(au)
                continue
            if au.index == start:
                origin = au.encoder_pts_us
                if not au.is_idr:
                    for preceding in context:
                        yield preceding, origin, True
                context.clear()
            if au.index < end:
                yield au, origin, False
    finally:
        context.close()
