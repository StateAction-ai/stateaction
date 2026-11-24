"""Portable reader for SA-31 clip artifacts. Standard library + numpy only (no Lance, no Rerun).

    from stateaction_processing.artifact_reader import open_result

    result = open_result("/path/to/output-prefix")      # verifies every byte against the manifest
    result.provenance                                   # job, source SHA-256, model, code revision
    for clip in result.clips:
        a = clip.arrays()                               # dict of the eight contract NPZ arrays
        rows = clip.frame_map()                         # exact ids, native clock + timestamp, PTS
        t = clip.timestamps()                           # int64 arrays: source_pts, clip_pts, timestamp_ns
        clip.verify_roundtrip()                         # NPZ == hand-observations JSON == frame map

`open_result` refuses a directory without `result-manifest.json` (provisional output), any listed
file whose size or SHA-256 differs, any unlisted file, and (when `stateaction_contracts` is
importable, which the CLI requires) any document its versioned validator rejects. The manifest's
SHA-256 is returned as `result.manifest_sha256`: compare it with the value an uploader recorded.
Every statement a clip makes (shapes, dtypes, frame counts, ordering) is re-checked against the
manifest instead of trusted.
"""

from __future__ import annotations

import ast
import errno
import hashlib
import io
import json
import math
import os
import re
import stat
import zipfile
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, BinaryIO

import numpy as np

MANIFEST_NAME = "result-manifest.json"
ARRAYS = (
    ("image_landmarks_px", "float32", (2, 21, 2)),
    ("image_landmarks_mask", "bool", (2, 21)),
    ("model_relative_joints", "float32", (2, 21, 3)),
    ("model_relative_mask", "bool", (2, 21)),
    ("hand_detected", "bool", (2,)),
    ("handedness_score", "float32", (2,)),
    ("handedness", "int8", (2,)),
    ("frame_index", "int64", ()),
)
SIDES = {0: "left", 1: "right"}
# The frozen contracts cap the manifest, sidecars, and per-clip frame count.
_MAX_MANIFEST_BYTES = 1 << 20
_MAX_SIDECAR_BYTES = 16 << 20
_MAX_CLIP_FRAMES = 7200
# Eight fixed arrays occupy under 7 MiB at the frame cap, before ZIP overhead.
_MAX_NPZ_BYTES = 16 << 20
_MAX_NPY_HEADER_BYTES = 10_000


class ArtifactError(ValueError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _req(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise ArtifactError(code, detail)


@dataclass(frozen=True)
class _OutputIdentity:
    size: int
    sha256: str


def _sha256(file: BinaryIO, size: int, rel: str) -> str:
    h = hashlib.sha256()
    remaining = size
    while remaining:
        chunk = file.read(min(1 << 20, remaining))
        _req(bool(chunk), "E_OUTPUT_SIZE", rel)
        h.update(chunk)
        remaining -= len(chunk)
    _req(not file.read(1), "E_OUTPUT_SIZE", rel)
    return h.hexdigest()


def _verify_file(file: BinaryIO, rel: str, identity: _OutputIdentity) -> os.stat_result:
    info = os.fstat(file.fileno())
    _req(info.st_size == identity.size, "E_OUTPUT_SIZE", rel)
    _req(_sha256(file, identity.size, rel) == identity.sha256, "E_OUTPUT_SHA256", rel)
    return info


_SAFE_PATH = re.compile(r"^[A-Za-z0-9._-]{1,128}(/[A-Za-z0-9._-]{1,128}){0,7}$")


def _open_component(
    parent: int, name: str, flags: int, rel: str, missing_code: str
) -> int:
    try:
        return os.open(name, flags, dir_fd=parent)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ArtifactError("E_UNSAFE_PATH_SYMLINK", rel) from exc
        if exc.errno == errno.ENOTDIR:
            # Linux reports ENOTDIR for an O_NOFOLLOW directory open on a symlink.
            try:
                is_link = stat.S_ISLNK(
                    os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode
                )
            except FileNotFoundError:
                is_link = False
            if is_link:
                raise ArtifactError("E_UNSAFE_PATH_SYMLINK", rel) from exc
        if exc.errno in (errno.ENOENT, errno.ENOTDIR):
            raise ArtifactError(missing_code, rel) from exc
        raise ArtifactError("E_OUTPUT_OPEN", rel) from exc


@contextmanager
def _open_file(
    base: Path, rel: str, *, missing_code: str = "E_OUTPUT_MISSING"
) -> Iterator[BinaryIO]:
    _req(isinstance(rel, str) and bool(_SAFE_PATH.fullmatch(rel)), "E_UNSAFE_PATH", rel)
    segments = rel.split("/")
    _req(all(seg not in (".", "..") for seg in segments), "E_UNSAFE_PATH", rel)
    _req(
        os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW"),
        "E_SAFE_OPEN_UNAVAILABLE",
    )
    # Open every component relative to its already-open parent so a concurrent symlink
    # replacement cannot redirect the subsequent file open.
    absolute_base = Path(os.path.abspath(base))
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open(absolute_base.anchor, dir_flags)
    try:
        for segment in (*absolute_base.parts[1:], *segments[:-1]):
            child = _open_component(parent, segment, dir_flags, rel, missing_code)
            os.close(parent)
            parent = child
        fd = _open_component(
            parent,
            segments[-1],
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            rel,
            missing_code,
        )
        with os.fdopen(fd, "rb") as file:
            _req(stat.S_ISREG(os.fstat(file.fileno()).st_mode), missing_code, rel)
            yield file
    finally:
        os.close(parent)


def _read_bounded(
    file: BinaryIO, rel: str, limit: int, identity: _OutputIdentity | None = None
) -> bytes:
    size = os.fstat(file.fileno()).st_size
    _req(size <= limit, "E_OUTPUT_LIMIT", rel)
    if identity is not None:
        _req(size == identity.size, "E_OUTPUT_SIZE", rel)
        data = file.read(identity.size + 1)
        _req(len(data) == identity.size, "E_OUTPUT_SIZE", rel)
        _req(
            hashlib.sha256(data).hexdigest() == identity.sha256, "E_OUTPUT_SHA256", rel
        )
        return data
    data = file.read(limit + 1)
    _req(len(data) <= limit, "E_OUTPUT_LIMIT", rel)
    return data


def _check_npy_header(
    member: IO[bytes],
    info: zipfile.ZipInfo,
    shape: tuple[int, ...],
    dtype: np.dtype[Any],
) -> None:
    name = info.filename
    prefix = member.read(8)
    version = prefix[6:]
    _req(
        prefix[:6] == b"\x93NUMPY"
        and version in (b"\x01\x00", b"\x02\x00", b"\x03\x00"),
        "E_NPZ_HEADER",
        name,
    )
    length_width = 2 if version == b"\x01\x00" else 4
    length_bytes = member.read(length_width)
    header_size = int.from_bytes(length_bytes, "little")
    _req(
        len(length_bytes) == length_width and 0 < header_size <= _MAX_NPY_HEADER_BYTES,
        "E_NPZ_HEADER",
        name,
    )
    _req(
        info.file_size
        == 8 + length_width + header_size + math.prod(shape) * dtype.itemsize,
        "E_NPZ_MEMBER_SIZE",
        name,
    )
    raw = member.read(header_size)
    _req(len(raw) == header_size, "E_NPZ_HEADER", name)
    header = ast.literal_eval(
        raw.decode("utf-8" if version == b"\x03\x00" else "latin1").strip()
    )
    _req(
        isinstance(header, dict)
        and set(header) == {"descr", "fortran_order", "shape"}
        and type(header["fortran_order"]) is bool,
        "E_NPZ_HEADER",
        name,
    )
    dimensions = header["shape"]
    _req(
        isinstance(dimensions, tuple)
        and all(type(dim) is int for dim in dimensions)
        and dimensions == shape,
        "E_NPZ_SHAPE",
        name,
    )
    _req(
        header["descr"] in (dtype.newbyteorder("<").str, dtype.newbyteorder(">").str),
        "E_NPZ_DTYPE",
        name,
    )


def _check_npz(data: bytes, frames: int) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            _req(
                sorted(names) == sorted(f"{name}.npy" for name, _, _ in ARRAYS),
                "E_NPZ_NAMES",
            )
            for name, dtype_name, tail in ARRAYS:
                info = archive.getinfo(f"{name}.npy")
                dtype = np.dtype(dtype_name)
                shape = (frames, *tail)
                payload_size = math.prod(shape) * dtype.itemsize
                _req(
                    10 + payload_size
                    <= info.file_size
                    <= 12 + _MAX_NPY_HEADER_BYTES + payload_size,
                    "E_NPZ_MEMBER_SIZE",
                    name,
                )
                _req(
                    info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                    "E_NPZ_COMPRESSION",
                    name,
                )
                with archive.open(info) as member:
                    _check_npy_header(member, info, shape, dtype)
    except ArtifactError:
        raise
    except (
        zipfile.BadZipFile,
        zlib.error,
        ValueError,
        SyntaxError,
        RecursionError,
        RuntimeError,
        EOFError,
        OverflowError,
    ) as exc:
        raise ArtifactError("E_NPZ_INVALID") from exc


def _contract_check(contract: str, data: bytes, *, required: bool) -> bool:
    try:
        from stateaction_contracts import validate_bytes
    except ImportError:
        _req(not required, "E_CONTRACT_VALIDATORS_UNAVAILABLE", contract)
        return False
    result = validate_bytes(contract, data)
    _req(
        result.valid, "E_CONTRACT_VIOLATION", (contract, result.code, result.errors[:3])
    )
    return True


@dataclass(frozen=True)
class Clip:
    root: Path
    meta: dict[str, Any]
    paths: dict[str, Path]  # file key -> path; reader methods verify bytes on use
    job_id: str
    _outputs: dict[str, _OutputIdentity] = field(default_factory=dict, repr=False)
    _producer: tuple[str, str] | None = field(default=None, repr=False)

    @property
    def clip_id(self) -> str:
        return str(self.meta["clip_id"])

    @property
    def frame_count(self) -> int:
        return int(self.meta["frame_count"])

    def _relative_path(self, key: str) -> str:
        path = self.paths[key]
        _req(path.is_relative_to(self.root), "E_UNSAFE_PATH", path)
        return path.relative_to(self.root).as_posix()

    def _read_output(self, key: str, limit: int) -> bytes:
        rel = self._relative_path(key)
        with _open_file(self.root, rel) as file:
            return _read_bounded(file, rel, limit, self._outputs.get(key))

    def arrays(self) -> dict[str, Any]:
        """The eight NPZ arrays; names, dtypes and shapes are checked against the manifest."""
        expected = self.meta["hand_arrays"]["arrays"]
        n = self.frame_count
        _req(1 <= n <= _MAX_CLIP_FRAMES, "E_NPZ_FRAME_LIMIT", n)
        by_name = {entry["name"]: entry for entry in expected}
        _req(
            len(expected) == len(ARRAYS) and set(by_name) == {a[0] for a in ARRAYS},
            "E_NPZ_NAMES",
        )
        for name, dtype, tail in ARRAYS:
            _req(by_name[name]["dtype"] == dtype, "E_NPZ_DTYPE", name)
            _req(by_name[name]["shape"] == [n, *tail], "E_NPZ_SHAPE", name)
        data = self._read_output("hand_arrays_npz", _MAX_NPZ_BYTES)
        # Check every member and its actual header before loading from the same bytes.
        _check_npz(data, n)
        with np.load(
            io.BytesIO(data), allow_pickle=False, max_header_size=_MAX_NPY_HEADER_BYTES
        ) as archive:
            out = {name: archive[name] for name, _, _ in ARRAYS}
        for name, dtype, tail in ARRAYS:
            _req(
                out[name].shape == (n, *tail) and out[name].dtype.name == dtype,
                "E_NPZ_CONTRACT",
                name,
            )
        _req(np.array_equal(out["frame_index"], np.arange(n)), "E_NPZ_FRAME_INDEX")
        detected, side = out["hand_detected"], out["handedness"]
        _req(np.array_equal(side >= 0, detected), "E_NPZ_HANDEDNESS_PRESENCE")
        for m in ("image_landmarks_mask", "model_relative_mask"):
            _req(
                not (out[m] & ~detected[..., None]).any(), "E_NPZ_MASK_WITHOUT_HAND", m
            )
        for arr, mask in (
            (out["image_landmarks_px"], out["image_landmarks_mask"]),
            (out["model_relative_joints"], out["model_relative_mask"]),
        ):
            _req(np.isfinite(arr[mask]).all(), "E_NPZ_NONFINITE_UNDER_MASK")
            _req(np.isnan(arr[~mask]).all(), "E_NPZ_VALUE_UNDER_FALSE_MASK")
        return out

    def frame_map_document(self) -> dict[str, Any]:
        doc = json.loads(self._read_output("frame_map_json", _MAX_SIDECAR_BYTES))
        job_id, clip_id = self._producer or (self.job_id, self.clip_id)
        _req(
            doc["clip_id"] == clip_id
            and doc["job_id"] == job_id
            and doc["frame_count"] == self.frame_count == len(doc["rows"]),
            "E_FRAME_MAP_IDENTITY",
        )
        return doc  # type: ignore[no-any-return]

    def frame_map(self) -> list[dict[str, Any]]:
        return list(self.frame_map_document()["rows"])

    def timestamps(self) -> dict[str, Any]:
        """int64 arrays plus the clock domain; clocks are never merged or converted."""
        rows = self.frame_map()
        return {
            "clock_domain": self.meta["clock_domain"],
            "source_frame_id": np.array(
                [int(r["source_frame_id"]) for r in rows], dtype=np.int64
            ),
            "timestamp_ns": np.array(
                [int(r["timestamp_ns"]) for r in rows], dtype=np.int64
            ),
            "source_pts": np.array(
                [int(r["source_pts"]) for r in rows], dtype=np.int64
            ),
            "clip_pts": np.array([int(r["clip_pts"]) for r in rows], dtype=np.int64),
        }

    def hand_observations(self) -> dict[str, Any]:
        doc = json.loads(
            self._read_output("hand_observations_json", _MAX_SIDECAR_BYTES)
        )
        job_id, clip_id = self._producer or (self.job_id, self.clip_id)
        _req(
            doc["clip_id"] == clip_id
            and doc["job_id"] == job_id
            and doc["frame_count"] == self.frame_count,
            "E_HAND_JSON_IDENTITY",
        )
        return doc  # type: ignore[no-any-return]

    def verify_roundtrip(self) -> dict[str, int]:
        """NPZ arrays, hand-observations JSON and frame map must describe the same frames."""
        a = self.arrays()
        t = self.timestamps()
        rows = self.frame_map()
        _req(
            np.array_equal(t["clip_pts"], t["source_pts"] - t["source_pts"][0]),
            "E_CLIP_PTS_REBASE",
        )
        _req(
            str(int(t["timestamp_ns"][0])) == self.meta["source_start_ns"]
            and str(int(t["timestamp_ns"][-1])) == self.meta["source_end_ns"],
            "E_CLIP_SPAN",
        )
        _req(
            all(r["clock_domain"] == self.meta["clock_domain"] for r in rows),
            "E_CLOCK_DOMAIN",
        )
        doc = self.hand_observations()
        compared = 0
        for fr in doc["frames"]:
            i = fr["frame_index"]
            seen = set()
            for h in fr["hands"]:
                j = h["hand_index"]
                seen.add(j)
                _req(bool(a["hand_detected"][i, j]), "E_ROUNDTRIP_PRESENCE", (i, j))
                _req(
                    SIDES[int(a["handedness"][i, j])] == h["handedness"],
                    "E_ROUNDTRIP_SIDE",
                    (i, j),
                )
                _req(
                    np.float32(h["handedness_score"]) == a["handedness_score"][i, j],
                    "E_ROUNDTRIP_SCORE",
                    (i, j),
                )
                for key, arr, mask, width in (
                    (
                        "image_landmarks_px",
                        a["image_landmarks_px"],
                        a["image_landmarks_mask"],
                        2,
                    ),
                    ("joints", a["model_relative_joints"], a["model_relative_mask"], 3),
                ):
                    pts = h[key] if key == "image_landmarks_px" else h["points_3d"][key]
                    for k, p in enumerate(pts):
                        _req(
                            (p is not None) == bool(mask[i, j, k]),
                            "E_ROUNDTRIP_MASK",
                            (i, j, k, key),
                        )
                        if p is not None:
                            want = np.array(p, dtype=np.float32)
                            _req(
                                np.array_equal(want, arr[i, j, k]),
                                "E_ROUNDTRIP_VALUE",
                                (i, j, k, key),
                            )
                            compared += width
            _req(
                seen == {int(x) for x in np.flatnonzero(a["hand_detected"][i])},
                "E_ROUNDTRIP_HAND_SET",
                i,
            )
        return {"frames": self.frame_count, "scalars_compared": compared}

    def verify_mp4(self) -> dict[str, Any]:
        """Optional (needs PyAV): demux, no decode. PTS must equal the frame map clip_pts exactly."""
        import av

        rows = self.frame_map()
        rel = self._relative_path("rgb_mp4")
        with _open_file(self.root, rel) as file:
            identity = self._outputs.get("rgb_mp4")
            before = _verify_file(file, rel, identity) if identity is not None else None
            file.seek(0)
            with av.open(file) as c:
                s = c.streams.video[0]
                packets = 0
                for packet in c.demux(s):
                    if not packet.size:
                        continue
                    _req(
                        packets < len(rows)
                        and packet.pts == int(rows[packets]["clip_pts"]),
                        "E_MP4_PTS",
                    )
                    packets += 1
                tb = (s.time_base.numerator, s.time_base.denominator)
                codec, w, h = (
                    s.codec_context.name,
                    s.codec_context.width,
                    s.codec_context.height,
                )
            after = os.fstat(file.fileno())
            if before is not None:
                _req(
                    (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                    == (after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                    "E_OUTPUT_CHANGED_DURING_READ",
                    rel,
                )
        _req(tb == (1, 1_000_000), "E_MP4_TIME_BASE", tb)
        _req(packets == len(rows), "E_MP4_PTS")
        _req(
            [w, h] == [self.meta["raster"]["width"], self.meta["raster"]["height"]],
            "E_MP4_RASTER",
        )
        _req(codec == "h264", "E_MP4_CODEC", codec)
        return {"packets": packets, "codec": codec, "raster": [w, h]}


@dataclass(frozen=True)
class Result:
    root: Path
    manifest: dict[str, Any]
    manifest_sha256: str
    contract_validated: bool
    clips: tuple[Clip, ...]

    @property
    def provenance(self) -> dict[str, Any]:
        return {
            "job_id": self.manifest["job_id"],
            "recording_id": self.manifest["recording_id"],
            "source_manifest_sha256": self.manifest["source_manifest_sha256"],
            "verified_sources": self.manifest["verified_sources"],
            **self.manifest["provenance"],
            "metric_accuracy_validated": self.manifest["metric_accuracy_validated"],
            "limitations": self.manifest["limitations"],
        }


def open_result(
    root: str | os.PathLike[str], *, require_contracts: bool = False
) -> Result:
    base = Path(root)
    with _open_file(
        base,
        MANIFEST_NAME,
        missing_code="E_MANIFEST_MISSING_PROVISIONAL",
    ) as file:
        data = _read_bounded(file, MANIFEST_NAME, _MAX_MANIFEST_BYTES)
    manifest = json.loads(data)
    schema = manifest.get("schema") if isinstance(manifest, dict) else None
    if schema == "stateaction.processing_result.v1":
        manifest_contract = "artifacts.processing-result.v1"
    elif schema == "stateaction.processing_result.v2":
        manifest_contract = "artifacts.processing-result.v2"
    elif schema == "stateaction.processing_result.v3":
        manifest_contract = "artifacts.processing-result.v3"
    elif schema == "stateaction.processing_result.v4":
        manifest_contract = "artifacts.processing-result.v4"
    elif schema == "stateaction.processing_result.v5":
        manifest_contract = "artifacts.processing-result.v5"
    else:
        raise ArtifactError("E_CONTRACT_VIOLATION", "processing-result schema")
    validated = _contract_check(manifest_contract, data, required=require_contracts)
    listed = {o["relative_path"]: o for o in manifest["outputs"]}
    sidecar_limits = {
        "frame_map_json": _MAX_SIDECAR_BYTES,
        "hand_observations_json": _MAX_SIDECAR_BYTES,
        "hand_arrays_npz": _MAX_NPZ_BYTES,
    }
    bounded_files = {
        file_id: sidecar_limits[key]
        for meta in manifest["clips"]
        for key, file_id in meta["files"].items()
        if key in sidecar_limits
    }
    sidecar_contracts = {
        "frame_map_json": "artifacts.frame-map.v1",
        "hand_observations_json": "artifacts.hand-observations.v1",
    }
    contracts_by_id = {
        file_id: sidecar_contracts[key]
        for meta in manifest["clips"]
        for key, file_id in meta["files"].items()
        if key in sidecar_contracts
    }
    by_id = {}
    for rel, o in listed.items():
        file_id = o["file_id"]
        identity = _OutputIdentity(int(o["size_bytes"]), o["sha256"])
        limit = bounded_files.get(file_id, sidecar_limits.get(o.get("role")))
        _req(limit is None or identity.size <= limit, "E_OUTPUT_LIMIT", rel)
        contract = contracts_by_id.get(file_id)
        with _open_file(base, rel) as file:
            if contract is not None and validated:
                sidecar = _read_bounded(file, rel, _MAX_SIDECAR_BYTES, identity)
                _contract_check(contract, sidecar, required=require_contracts)
            else:
                _verify_file(file, rel, identity)
        by_id[file_id] = (base / rel, identity)
    found = set()
    for path in base.rglob("*"):
        rel = path.relative_to(base).as_posix()
        _req(not path.is_symlink(), "E_UNSAFE_PATH_SYMLINK", rel)
        if rel != MANIFEST_NAME and path.is_file():
            found.add(rel)
    _req(found == set(listed), "E_OUTPUT_SET_MISMATCH", sorted(found ^ set(listed)))
    clips = []
    reused_hand = manifest.get("reused_hand")
    producers = {}
    if schema == "stateaction.processing_result.v4":
        mapping = reused_hand["clips"]
        producers = {
            item["clip_id"]: (reused_hand["job_id"], item["original_clip_id"])
            for item in mapping
        }
        _req(
            len(producers) == len(mapping)
            and set(producers) == {meta["clip_id"] for meta in manifest["clips"]},
            "E_CONTRACT_VIOLATION",
            "invalid reused hand clip origins",
        )
    for meta in manifest["clips"]:
        paths = {key: by_id[fid][0] for key, fid in meta["files"].items()}
        identities = {key: by_id[fid][1] for key, fid in meta["files"].items()}
        clips.append(
            Clip(
                base,
                meta,
                paths,
                manifest["job_id"],
                identities,
                producers.get(meta["clip_id"]),
            )
        )
    return Result(
        base, manifest, hashlib.sha256(data).hexdigest(), validated, tuple(clips)
    )
