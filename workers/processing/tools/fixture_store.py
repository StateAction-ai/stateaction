#!/usr/bin/env python3
"""Local-only FLORA fixture store for two short HomER episodes (SA-86).

    python3 workers/processing/tools/fixture_store.py fetch
    python3 workers/processing/tools/fixture_store.py ingest-flora --t3 T3_DIR --captions CAPTION_RUN_DIR
    python3 workers/processing/tools/fixture_store.py manifest
    python3 workers/processing/tools/fixture_store.py verify [--decode]

The store is `artifacts/fixtures/flora-homer/` (git-ignored; HomER / WGO-Bench media is CC BY-NC-SA
and never committed). CI never reads it: CI uses the synthetic fixtures in the unit tests.

Layout per episode `<ep>/`: `source.mp4`, `source.mcap` (simulation MCAP from `mp4_to_sim_mcap.py`),
`flora/segments.json`, `flora/windows.jsonl` (TempSeg run T3_r1), `flora/captions.json`,
`flora/env.json` (Captioner run environment). `MANIFEST.json` lists path, sha256, bytes, source
and provenance of every file.

Only the standard library is needed, except `fetch` which reads the dataset Parquet through
pyarrow; if pyarrow is missing the script re-runs itself under `uv run --no-project --with pyarrow`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DEFAULT_STORE = REPO / "artifacts/fixtures/flora-homer"
DATASET = "macrodata/WGO-Bench"
PARQUET_URL = (
    f"https://huggingface.co/datasets/{DATASET}/resolve/main/data/annotations.parquet"
)
PARQUET_BYTES = 1401440590
PARQUET_REVISION_NOTE = (
    "main (unpinned; every extracted file is pinned by the sha256 below)"
)
EPISODES = {
    "homer_33": {
        "sha256": "c27a72aa1f474e19ef4e738453bf75ef53604969e2dcaeea0af5d106810a2690",
        "frames": 2167,
        "duration_s": 72.233333,
    },
    "homer_37": {
        "sha256": "ea38b0dea9b82eba99d82ace8a2805ba392b142c066a8b32ca32579a46b777d3",
        "frames": 1984,
        "duration_s": 66.133333,
    },
}
LICENCE = "CC BY-NC-SA (WGO-Bench / HomER); local fixture store only, never committed (decision H2)"
FLORA_FILES = ("segments.json", "windows.jsonl", "captions.json", "env.json")
SKIP_TOP = {".cache"}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(16 << 20):
            h.update(chunk)
    return h.hexdigest()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def download_parquet(cache: Path) -> Path:
    dest = cache / "annotations.parquet"
    if dest.is_file() and dest.stat().st_size == PARQUET_BYTES:
        return dest
    cache.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(
        PARQUET_URL, headers={"Range": f"bytes={have}-"} if have else {}
    )
    print(
        f"downloading {DATASET} annotations.parquet ({PARQUET_BYTES} bytes, have {have})",
        flush=True,
    )
    with (
        urllib.request.urlopen(req, timeout=120) as resp,
        part.open("ab" if have else "wb") as out,
    ):
        if have and resp.status != 206:
            out.truncate(0)
        shutil.copyfileobj(resp, out, 16 << 20)
    if part.stat().st_size != PARQUET_BYTES:
        raise SystemExit(
            f"E_PARQUET_SIZE: got {part.stat().st_size}, expected {PARQUET_BYTES}"
        )
    os.replace(part, dest)
    return dest


def cmd_fetch(a: argparse.Namespace) -> int:
    try:
        import pyarrow.parquet as pq
    except ModuleNotFoundError:
        if os.environ.get("FIXTURE_STORE_REEXEC"):
            raise
        os.environ["FIXTURE_STORE_REEXEC"] = "1"
        os.execvp(
            "uv",
            ["uv", "run", "--no-project", "--with", "pyarrow", "python", *sys.argv],
        )
    store: Path = a.store
    todo = {ep for ep in EPISODES if not (store / ep / "source.mp4").is_file()}
    todo |= {
        ep
        for ep in EPISODES
        if (store / ep / "source.mp4").is_file()
        and sha256_file(store / ep / "source.mp4") != EPISODES[ep]["sha256"]
    }
    if not todo:
        print("fetch: all source.mp4 files already present with matching sha256")
        return 0
    pf = pq.ParquetFile(download_parquet(store / ".cache"))
    found: set[str] = set()
    for rg in range(pf.num_row_groups):
        ids = pf.read_row_group(rg, columns=["id"]).column("id").to_pylist()
        if not todo.intersection(ids):
            continue
        for row in pf.read_row_group(rg, columns=["id", "video"]).to_pylist():
            if row["id"] not in todo:
                continue
            data = row["video"]
            got = hashlib.sha256(data).hexdigest()
            if got != EPISODES[row["id"]]["sha256"]:
                raise SystemExit(f"E_SHA256: {row['id']} {got}")
            atomic_write(store / row["id"] / "source.mp4", data)
            found.add(row["id"])
            print(f"wrote {row['id']}/source.mp4 {len(data)} bytes sha256 {got}")
    if found != todo:
        raise SystemExit(f"E_MISSING: {sorted(todo - found)}")
    return 0


def cmd_ingest_flora(a: argparse.Namespace) -> int:
    """Copy T3 segments/windows and the Captioner run output into the store and validate captions."""
    for ep in EPISODES:
        out = a.store / ep / "flora"
        out.mkdir(parents=True, exist_ok=True)
        for name in ("segments.json", "windows.jsonl"):
            shutil.copyfile(a.t3 / ep / name, out / name)
        shutil.copyfile(a.captions / ep / "captions.json", out / "captions.json")
        shutil.copyfile(a.captions / "env.json", out / "env.json")
    return 0 if not check_captions(a.store) else 1


def check_captions(store: Path) -> list[str]:
    """Every caption row maps to one T3 segment id, has a status, and has text only when complete."""
    errs: list[str] = []
    for ep in EPISODES:
        flora = store / ep / "flora"
        seg_doc = json.loads((flora / "segments.json").read_text())
        ids = [s["id"] for s in seg_doc["segments"]]
        doc = json.loads((flora / "captions.json").read_text())
        rows = doc["captions"]
        if [r["segment_id"] for r in rows] != ids:
            errs.append(f"{ep}: caption segment ids differ from T3 segment ids")
        for r in rows:
            st = r.get("status")
            if not isinstance(st, str) or not st:
                errs.append(f"{ep}/{r.get('segment_id')}: missing status")
            elif st == "complete":
                if not isinstance(r.get("caption"), str) or not r["caption"].strip():
                    errs.append(
                        f"{ep}/{r['segment_id']}: complete without caption text"
                    )
            elif "caption" in r:
                errs.append(f"{ep}/{r['segment_id']}: {st} row carries caption text")
        if doc.get("source_sha256") != EPISODES[ep]["sha256"]:
            errs.append(f"{ep}: captions.json source_sha256 mismatch")
    return errs


def provenance_for(rel: str) -> tuple[str, str]:
    """(source, provenance) of one store file."""
    ep, _, rest = rel.partition("/")
    if rel == "README.md":
        return (
            "docs/components/flora-fixture-store.md (copied by `fixture_store.py manifest`)",
            "documentation",
        )
    table = {
        "source.mp4": (
            f"HF dataset {DATASET} data/annotations.parquet, row id={ep}, column video ({PARQUET_REVISION_NOTE})",
            f"verbatim bytes of the dataset video; sha256 pinned in fixture_store.py; licence {LICENCE}",
        ),
        "source.mcap": (
            f"{ep}/source.mp4 via workers/processing/tools/mp4_to_sim_mcap.py",
            "simulation_only h264_mcap_simulation_v1 conversion; camera label is the public dataset name, encoder and clock unknown; not hardware evidence",
        ),
        "source.simulation.json": (
            f"{ep}/source.mcap, written by mp4_to_sim_mcap.py",
            "artifacts.simulation-provenance.v1 marker: simulation_only; camera = public dataset label; encoder and clock unknown",
        ),
        "source.conversion.json": (
            f"{ep}/source.mcap, written by mp4_to_sim_mcap.py",
            "conversion receipt: source and MCAP sha256, remux or libx264 re-encode (B-frames refused by the capture contract) and why",
        ),
        "flora/segments.json": (
            "TempSeg run T3_r1 (vLLM 0.34 fp8_per_tensor, FP32 dt_bias, RTX PRO 6000 on Modal); copied verbatim",
            "real NVIDIA FLORA TempSeg output; provenance block inside the file",
        ),
        "flora/windows.jsonl": (
            "TempSeg run T3_r1 window records; copied verbatim",
            "real NVIDIA FLORA TempSeg per-window output",
        ),
        "flora/captions.json": (
            "SA-86 Colab run of the FLORA Captioner on the T3_r1 segments of this episode",
            "real NVIDIA FLORA Captioner output; run configuration in env.json",
        ),
        "flora/env.json": (
            "SA-86 Colab run environment record",
            "GPU, vLLM, torch, CUDA, quantisation, prompt sha256, decoding and model revisions",
        ),
    }
    if rest not in table:
        return ("unknown", "unrecorded")
    return table[rest]


def iter_store_files(store: Path):
    for p in sorted(store.rglob("*")):
        rel = p.relative_to(store)
        if (
            p.is_file()
            and rel.parts[0] not in SKIP_TOP
            and rel.name != "MANIFEST.json"
            and not rel.name.endswith(".part")
        ):
            yield rel.as_posix(), p


def cmd_manifest(a: argparse.Namespace) -> int:
    errs = check_captions(a.store)
    if errs:
        print("\n".join(errs), file=sys.stderr)
        return 1
    readme = REPO / "docs/components/flora-fixture-store.md"
    if readme.is_file():
        shutil.copyfile(readme, a.store / "README.md")
    files = []
    for rel, p in iter_store_files(a.store):
        src, prov = provenance_for(rel)
        files.append(
            {
                "path": rel,
                "sha256": sha256_file(p),
                "bytes": p.stat().st_size,
                "source": src,
                "provenance": prov,
            }
        )
    doc = {
        "schema": "stateaction.flora_fixture_manifest.v1",
        "ticket": "SA-86",
        "licence": LICENCE,
        "episodes": EPISODES,
        "files": files,
    }
    atomic_write(
        a.store / "MANIFEST.json",
        (json.dumps(doc, indent=2, sort_keys=True) + "\n").encode(),
    )
    print(f"MANIFEST.json: {len(files)} files")
    return 0


def cmd_verify(a: argparse.Namespace) -> int:
    store: Path = a.store
    manifest = store / "MANIFEST.json"
    if not manifest.is_file():
        print(f"E_NO_MANIFEST {manifest}", file=sys.stderr)
        return 1
    doc = json.loads(manifest.read_text())
    errs = []
    listed = {f["path"] for f in doc["files"]}
    for f in doc["files"]:
        p = store / f["path"]
        if not p.is_file():
            errs.append(f"missing {f['path']}")
        elif p.stat().st_size != f["bytes"]:
            errs.append(f"size {f['path']}: {p.stat().st_size} != {f['bytes']}")
        elif sha256_file(p) != f["sha256"]:
            errs.append(f"sha256 {f['path']}")
        else:
            print(f"ok {f['path']} {f['bytes']} {f['sha256'][:12]}")
    for rel, _ in iter_store_files(store):
        if rel not in listed:
            errs.append(f"unlisted {rel}")
    for ep, meta in EPISODES.items():
        if f"{ep}/source.mp4" not in listed:
            errs.append(f"{ep}: source.mp4 not in manifest")
        for f in doc["files"]:
            if f["path"] == f"{ep}/source.mp4" and f["sha256"] != meta["sha256"]:
                errs.append(f"{ep}: source.mp4 sha256 is not the pinned dataset sha256")
    errs += check_captions(store)
    if a.decode and not errs:
        errs += decode_check(store)
    for e in errs:
        print("FAIL", e, file=sys.stderr)
    print("VERIFY", "FAIL" if errs else "PASS", f"files={len(doc['files'])}")
    return 1 if errs else 0


def decode_check(store: Path) -> list[str]:
    """Decode each source.mcap with the worker FrameStream (frame count must equal the MP4's) and
    validate its simulation marker against `artifacts.simulation-provenance.v1`."""
    from stateaction_contracts import validate_bytes

    from stateaction_processing.frames import FrameStream

    errs = []
    for ep, meta in EPISODES.items():
        with (store / ep / "source.mcap").open("rb") as raw:
            fs = FrameStream(raw, source_profile="h264_mcap_simulation_v1")
            n = sum(1 for _ in fs)
            rep = fs.require_accepted()
        profile = rep.profile or {}
        marker_bytes = (store / ep / "source.simulation.json").read_bytes()
        verdict = validate_bytes("artifacts.simulation-provenance.v1", marker_bytes)
        marker = json.loads(marker_bytes)
        print(
            f"decode {ep}: frames={n} expected={meta['frames']} accepted=True "
            f"rgb_profile={profile.get('rgb_profile')} qualification={profile.get('qualification')} "
            f"marker_valid={verdict.valid}"
        )
        if n != meta["frames"]:
            errs.append(f"{ep}: decoded {n} frames, expected {meta['frames']}")
        if not verdict.valid:
            errs.append(f"{ep}: simulation marker invalid: {verdict.code}")
        if marker.get("qualification") != profile.get("qualification") or marker.get(
            "mapped_timeline_semantics"
        ) != profile.get("mapped_timeline_semantics"):
            errs.append(f"{ep}: marker disagrees with the MCAP Profile")
    return errs


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--store", type=Path, default=DEFAULT_STORE)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    ing = sub.add_parser("ingest-flora")
    ing.add_argument(
        "--t3",
        type=Path,
        required=True,
        help="directory holding <ep>/segments.json and windows.jsonl",
    )
    ing.add_argument(
        "--captions",
        type=Path,
        required=True,
        help="Colab run output: env.json and <ep>/captions.json",
    )
    sub.add_parser("manifest")
    ver = sub.add_parser("verify")
    ver.add_argument(
        "--decode",
        action="store_true",
        help="also decode each source.mcap with the worker FrameStream",
    )
    a = p.parse_args(argv)
    return {
        "fetch": cmd_fetch,
        "ingest-flora": cmd_ingest_flora,
        "manifest": cmd_manifest,
        "verify": cmd_verify,
    }[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
