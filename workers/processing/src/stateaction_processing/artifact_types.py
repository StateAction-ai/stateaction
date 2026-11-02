"""Shared types for the SA-31 clip artifact exporter: limits, job context, output sinks.

An *output sink* receives each file only after it is closed and hashed (`put`) and the final
result manifest only after the whole source was accepted (`seal`). Until `seal`, everything a sink
holds is provisional; `abort` discards it. The backend output protocol (SA-28) is not implemented
here: a real uploader implements `OutputSink` (or wraps callables in `CallbackSink`) and owns the
transport. `LocalDirectorySink` is the real local implementation used by the CLI.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

MiB = 1024 * 1024
RULE_REVISION = "sa31-export-2"
# Contract role -> clip file key (packages/contracts/api/artifacts/processing-result.v1.schema.json).
ROLE_BY_KEY = {
    "rgb_mp4": "clip_mp4",
    "hand_arrays_npz": "hand_arrays_npz",
    "hand_observations_json": "hand_observations_json",
    "frame_map_json": "frame_map_json",
    "thumbnail_jpeg": "thumbnail_jpeg",
    "viewer_rrd": "viewer_rrd",
}
FILE_NAMES = {
    "rgb_mp4": "rgb.mp4",
    "hand_arrays_npz": "hand-arrays.npz",
    "hand_observations_json": "hand-observations.json",
    "frame_map_json": "frame-map.json",
    "thumbnail_jpeg": "thumbnail.jpg",
    "viewer_rrd": "viewer.rrd",
}
MANIFEST_NAME = "result-manifest.json"


class ExportError(RuntimeError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def require(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise ExportError(code, detail)


@dataclass(frozen=True)
class ExportLimits:
    """Every bound is explicit and recorded (hashed into provenance.config_sha256)."""

    clip_target_seconds: float = 30.0  # cut at the first IDR at or after this clip age
    clip_ceiling_seconds: float = 60.0  # a clip must never be longer (ticket ceiling)
    clip_target_frames: int = 3000
    clip_max_frames: int = (
        3600  # contract max is 7200; 16 MiB JSON bound is the real limit
    )
    max_rrd_bytes: int = 128 * MiB
    proxy_max_width: int = 1280  # landscape proxy bound; portrait uses the swapped pair
    proxy_max_height: int = 720
    proxy_bitrate_bps: int = 3_000_000
    proxy_keyint: int = 30
    proxy_nominal_fps: int = 30  # rate control only; never rewrites source PTS
    max_encoder_pending: int = 4
    max_scratch_bytes: int = 768 * MiB  # unreleased bytes of the active clip's files
    thumbnail_max_side: int = 320
    max_hand_json_bytes: int = 16 * MiB  # contract maxBytes
    scratch_check_every_frames: int = 30


@dataclass(frozen=True)
class ExportContext:
    """Job identity and provenance supplied by the caller (never invented from the source)."""

    job_id: str
    source_manifest_sha256: str
    code_revision: str
    image_spec_sha256: str
    profile_revision: str
    recording_id: str | None = None  # default: uuid5 of the verified source SHA-256
    source_file_id: str | None = None  # default: uuid5(job_id, "source")
    expected_source_sha256: str | None = None
    forbidden_strings: tuple[
        str, ...
    ] = ()  # local paths etc. that must not reach any artifact
    extra_limitations: tuple[str, ...] = ()
    # Production requires caller-supplied recording_id and source_file_id (backend identities).
    # Offline/CLI runs set this True: identities are deterministic fixtures, labelled as such.
    fixture_identities: bool = False


@dataclass(frozen=True)
class OutputReceipt:
    """What the sink actually stored: the immutable object identity the manifest must cite.

    A backend sink returns the server-selected random file id from output reservation; the local
    sink returns an explicitly synthetic fixture id. `role`, `size_bytes` and `sha256` must equal
    the file that was put (the exporter checks), so a receipt cannot describe different bytes."""

    file_id: str
    role: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class OutputFile:
    role: str  # contract outputFileRole
    relative_path: str  # posix, safeRelativePath
    path: Path  # closed local file (scratch)
    size_bytes: int
    sha256: str
    clip_ordinal: int | None = None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(MiB):
            h.update(chunk)
    return h.hexdigest()


def make_output(
    role: str, relative_path: str, path: Path, ordinal: int | None
) -> OutputFile:
    size = path.stat().st_size
    require(size > 0, "E_OUTPUT_EMPTY", relative_path)
    return OutputFile(role, relative_path, path, size, sha256_file(path), ordinal)


def derived_uuid(job_id: str, name: str) -> str:
    """Deterministic RFC 9562 v5 UUID for a job-scoped output identity."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"stateaction:{job_id}:{name}"))


class OutputSink(Protocol):
    def put(self, out: OutputFile) -> OutputReceipt:
        """A closed, hashed file. The sink may copy, upload or move it and returns the receipt
        (file id chosen by the store); the exporter then drops the scratch copy. It must never
        overwrite an existing object."""

    def seal(self, manifest: OutputFile) -> OutputReceipt:
        """The final result manifest, called only after the entire source was accepted and every
        listed file was `put`. Nothing is complete before this returns."""

    def abort(self, reason: str) -> None:
        """Discard everything `put` so far (provisional output)."""


@dataclass
class CallbackSink:
    """Adapter for an uploader: three callables, no further assumptions."""

    on_put: Callable[[OutputFile], OutputReceipt]
    on_seal: Callable[[OutputFile], OutputReceipt]
    on_abort: Callable[[str], None] = lambda _reason: None

    def put(self, out: OutputFile) -> OutputReceipt:
        return self.on_put(out)

    def seal(self, manifest: OutputFile) -> OutputReceipt:
        return self.on_seal(manifest)

    def abort(self, reason: str) -> None:
        self.on_abort(reason)


@dataclass
class LocalDirectorySink:
    """Moves each closed file under `root` with exclusive create (a retry needs a fresh prefix).

    `root` must not exist or must be an empty directory. The manifest is renamed into place last,
    so a directory without `result-manifest.json` is provisional/incomplete by definition.
    """

    root: Path
    job_id: str | None = (
        None  # deterministic fixture ids when given, else random fixture ids
    )
    placed: list[Path] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.root = Path(self.root)
        if self.root.exists():
            require(
                self.root.is_dir() and not any(self.root.iterdir()),
                "E_OUTPUT_PREFIX_NOT_EMPTY",
                "retries need a fresh output prefix; existing artifacts are never overwritten",
            )
        else:
            self.root.mkdir(parents=True)

    def _receipt(self, out: OutputFile) -> OutputReceipt:
        fid = (
            derived_uuid(self.job_id, f"fixture-file/{out.relative_path}")
            if self.job_id
            else str(uuid.uuid4())
        )  # SYNTHETIC fixture id: not a backend-reserved file id
        return OutputReceipt(fid, out.role, out.size_bytes, out.sha256)

    def _place(self, out: OutputFile) -> OutputReceipt:
        dest = self.root / out.relative_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Hard-link then unlink = atomic no-overwrite placement (link fails if dest exists).
        try:
            os.link(out.path, dest)
        except FileExistsError:
            raise ExportError("E_OUTPUT_EXISTS", out.relative_path) from None
        except OSError:  # different filesystem: exclusive copy
            with out.path.open("rb") as src, dest.open("xb") as dst:
                while chunk := src.read(MiB):
                    dst.write(chunk)
        self.placed.append(dest)
        out.path.unlink(missing_ok=True)
        return self._receipt(out)

    def put(self, out: OutputFile) -> OutputReceipt:
        return self._place(out)

    def seal(self, manifest: OutputFile) -> OutputReceipt:
        return self._place(manifest)

    def abort(self, reason: str) -> None:
        for p in reversed(self.placed):
            p.unlink(missing_ok=True)
        for d in sorted(self.root.rglob("*"), reverse=True):
            if d.is_dir():
                try:
                    d.rmdir()
                except OSError:
                    pass
        self.placed.clear()
