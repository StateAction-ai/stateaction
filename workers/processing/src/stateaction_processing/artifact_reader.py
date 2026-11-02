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
importable, which the CLI requires) any document the frozen v1 validators reject. The manifest's
SHA-256 is returned as `result.manifest_sha256`: compare it with the value an uploader recorded.
Every statement a clip makes (shapes, dtypes, frame counts, ordering) is re-checked against the
manifest instead of trusted.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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


class ArtifactError(ValueError):
    def __init__(self, code: str, detail: object = None):
        super().__init__(code if detail is None else f"{code}: {detail}")
        self.code = code
        self.detail = detail


def _req(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise ArtifactError(code, detail)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


_SAFE_PATH = re.compile(r"^[A-Za-z0-9._-]{1,128}(/[A-Za-z0-9._-]{1,128}){0,7}$")


def _safe_file(base: Path, rel: str) -> Path:
    """Manifest paths are untrusted: relative, no empty/dot/dotdot segment, no symlink anywhere."""
    _req(isinstance(rel, str) and bool(_SAFE_PATH.match(rel)), "E_UNSAFE_PATH", rel)
    _req(all(seg not in (".", "..") for seg in rel.split("/")), "E_UNSAFE_PATH", rel)
    cur = base
    for seg in rel.split("/"):
        cur = cur / seg
        _req(not cur.is_symlink(), "E_UNSAFE_PATH_SYMLINK", rel)
    root = base.resolve()
    _req(cur.resolve().is_relative_to(root), "E_UNSAFE_PATH_ESCAPE", rel)
    return cur


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
    paths: dict[str, Path]  # file key -> verified path
    job_id: str

    @property
    def clip_id(self) -> str:
        return str(self.meta["clip_id"])

    @property
    def frame_count(self) -> int:
        return int(self.meta["frame_count"])

    def arrays(self) -> dict[str, Any]:
        """The eight NPZ arrays; names, dtypes and shapes are checked against the manifest."""
        expected = self.meta["hand_arrays"]["arrays"]
        out = {}
        with np.load(self.paths["hand_arrays_npz"], allow_pickle=False) as z:
            _req(
                sorted(z.files) == sorted(e["name"] for e in expected),
                "E_NPZ_NAMES",
                z.files,
            )
            for e in expected:
                a = z[e["name"]]
                _req(
                    a.dtype.name == e["dtype"], "E_NPZ_DTYPE", (e["name"], a.dtype.name)
                )
                _req(list(a.shape) == e["shape"], "E_NPZ_SHAPE", (e["name"], a.shape))
                out[e["name"]] = a
        n = self.frame_count
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
        doc = json.loads(self.paths["frame_map_json"].read_bytes())
        _req(
            doc["clip_id"] == self.clip_id
            and doc["job_id"] == self.job_id
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
        doc = json.loads(self.paths["hand_observations_json"].read_bytes())
        _req(
            doc["clip_id"] == self.clip_id
            and doc["job_id"] == self.job_id
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
        with av.open(str(self.paths["rgb_mp4"])) as c:
            s = c.streams.video[0]
            pts = [int(p.pts) for p in c.demux(s) if p.size]
            tb = (s.time_base.numerator, s.time_base.denominator)
            codec, w, h = (
                s.codec_context.name,
                s.codec_context.width,
                s.codec_context.height,
            )
        _req(tb == (1, 1_000_000), "E_MP4_TIME_BASE", tb)
        _req(pts == [int(r["clip_pts"]) for r in rows], "E_MP4_PTS")
        _req(
            [w, h] == [self.meta["raster"]["width"], self.meta["raster"]["height"]],
            "E_MP4_RASTER",
        )
        _req(codec == "h264", "E_MP4_CODEC", codec)
        return {"packets": len(pts), "codec": codec, "raster": [w, h]}


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
    mpath = base / MANIFEST_NAME
    _req(
        mpath.is_file(),
        "E_MANIFEST_MISSING_PROVISIONAL",
        "no result-manifest.json: not a complete result",
    )
    data = mpath.read_bytes()
    manifest = json.loads(data)
    validated = _contract_check(
        "artifacts.processing-result.v1", data, required=require_contracts
    )
    listed = {o["relative_path"]: o for o in manifest["outputs"]}
    _req(not base.is_symlink(), "E_UNSAFE_PATH_SYMLINK", "prefix")
    for rel, o in listed.items():
        p = _safe_file(base, rel)
        _req(p.is_file(), "E_OUTPUT_MISSING", rel)
        _req(p.stat().st_size == int(o["size_bytes"]), "E_OUTPUT_SIZE", rel)
        _req(_sha256(p) == o["sha256"], "E_OUTPUT_SHA256", rel)
    found = {
        p.relative_to(base).as_posix()
        for p in base.rglob("*")
        if p.is_file() and p.name != MANIFEST_NAME
    }
    _req(found == set(listed), "E_OUTPUT_SET_MISMATCH", sorted(found ^ set(listed)))
    by_id = {
        o["file_id"]: base / o["relative_path"] for o in manifest["outputs"]
    }  # already vetted
    clips = []
    for meta in manifest["clips"]:
        paths = {key: by_id[fid] for key, fid in meta["files"].items()}
        clip = Clip(base, meta, paths, manifest["job_id"])
        if validated or require_contracts:
            _contract_check(
                "artifacts.frame-map.v1",
                paths["frame_map_json"].read_bytes(),
                required=require_contracts,
            )
            _contract_check(
                "artifacts.hand-observations.v1",
                paths["hand_observations_json"].read_bytes(),
                required=require_contracts,
            )
        clips.append(clip)
    return Result(
        base, manifest, hashlib.sha256(data).hexdigest(), validated, tuple(clips)
    )
