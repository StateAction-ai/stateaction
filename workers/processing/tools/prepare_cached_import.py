"""Package cached FLORA and CPU results for the explicit catalog import."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from dataclasses import replace
from pathlib import Path

from stateaction_contracts import validate_bytes

from stateaction_processing.artifact_seal import LaneBuilder
from stateaction_processing.flora_adapter import (
    canonical_bytes,
    captions_from_flora,
    flat_params,
    segments_from_flora,
)
from stateaction_processing.stage_docs import (
    StageContext,
    captions_document,
    segments_document,
)
from stateaction_processing.stage_media import FrameMap


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path: Path):
    return json.loads(path.read_bytes())


def require(ok: bool, message: str) -> None:
    if not ok:
        raise ValueError(message)


def write(path: Path, document: dict, contract: str | None = None) -> str:
    data = canonical_bytes(document)
    if contract:
        result = validate_bytes(contract, data)
        require(result.valid, f"{path.name}: {result.code} {result.errors[:3]}")
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def producer(stage: str, evidence: dict, parameter_hash: str) -> dict:
    return {
        "stage": stage,
        "module_id": f"imported_{stage}",
        "module_version": 1,
        "model_name": evidence["model"],
        "model_revision": evidence.get("revision"),
        "weights_sha256": evidence.get("weightsSha256"),
        "prompt_sha256": evidence.get("promptSha256"),
        "quant": None,
        "params_sha256": parameter_hash,
        "decoding_params": flat_params(evidence.get("decoding") or {}),
        "engine": {
            "name": evidence.get("engine"),
            "version": evidence.get("engineVersion"),
        },
        "gpu": {
            "requested_type": evidence.get("requestedGpu"),
            "observed_type": evidence.get("observedGpu"),
        },
    }


def prepare(spec_path: Path, target: Path) -> dict:
    spec = read(spec_path)
    root = spec_path.parent
    source, mcap, conversion, simulation, segments, captions, cpu = (
        root / spec[name]
        for name in (
            "video",
            "mcap",
            "conversion",
            "simulation",
            "segments",
            "captions",
            "cpu",
        )
    )
    require(not target.exists(), "Choose a new output directory")
    raw_segment, raw_caption, hand = read(segments), read(captions), read(cpu)
    video_sha, source_sha, segment_sha, caption_sha = map(
        sha, (source, mcap, segments, captions)
    )
    conversion_doc, simulation_doc = read(conversion), read(simulation)
    require(
        raw_segment["source"]["sha256"] == conversion_doc["source_sha256"] == video_sha
        and conversion_doc["mcap_sha256"] == source_sha,
        "Source and FLORA identities differ",
    )
    require(
        len(hand["verified_sources"]) == 1
        and hand["verified_sources"][0]["sha256"] == source_sha
        and hand["verified_sources"][0]["size_bytes"] == str(mcap.stat().st_size),
        "CPU result does not refer to the same source",
    )
    require(
        validate_bytes("artifacts.processing-result.v1", cpu.read_bytes()).valid,
        "CPU manifest must be an original processing-result.v1 document",
    )
    if isinstance(raw_caption, dict):
        require(
            raw_caption["source_sha256"] == video_sha
            and raw_caption["segments_sha256"] == segment_sha,
            "Caption input differs",
        )
        caption_rows = raw_caption["captions"]
    else:
        require(
            spec["captionInput"]
            == {"segmentsSha256": segment_sha, "captionsSha256": caption_sha},
            "Unbound caption rows require independently recorded input/output hashes",
        )
        caption_rows = raw_caption
        require(
            [(row["segment_id"], row["start_s"], row["end_s"]) for row in caption_rows]
            == [
                (row["id"], row["start_s"], row["end_s"])
                for row in raw_segment["segments"]
            ],
            "Caption rows and native segment intervals differ",
        )
    require(
        {row["segment_id"] for row in caption_rows}
        == {row["id"] for row in raw_segment["segments"]},
        "Caption index does not cover the native segments",
    )
    files = {entry["file_id"]: entry for entry in hand["outputs"]}
    clock_domain = hand["clips"][0]["clock_domain"]
    frames = FrameMap(source_sha256=source_sha, clock_domain=clock_domain)
    lanes = {side: LaneBuilder() for side in ("left", "right")}
    for entry in files.values():
        path = cpu.parent / entry["relative_path"]
        require(
            path.stat().st_size == int(entry["size_bytes"])
            and sha(path) == entry["sha256"],
            f"CPU output differs from its original manifest: {entry['relative_path']}",
        )
    for clip in hand["clips"]:
        mapping = read(
            cpu.parent / files[clip["files"]["frame_map_json"]]["relative_path"]
        )
        observations = read(
            cpu.parent / files[clip["files"]["hand_observations_json"]]["relative_path"]
        )
        require(
            mapping["job_id"] == observations["job_id"] == hand["job_id"]
            and mapping["clip_id"] == observations["clip_id"] == clip["clip_id"]
            and len(mapping["rows"])
            == len(observations["frames"])
            == clip["frame_count"],
            "Hand-pose frame map and observations disagree",
        )
        for frame, obs in zip(mapping["rows"], observations["frames"], strict=True):
            require(
                frame["frame_index"] == obs["frame_index"]
                and frame["clock_domain"] == clock_domain,
                "Hand-pose frame identities disagree",
            )
            frames.frame_ids.append(frame["source_frame_id"])
            frames.timestamps_ns.append(frame["timestamp_ns"])
            frames.pts_us.append(
                (int(frame["timestamp_ns"]) - int(frames.timestamps_ns[0])) // 1000
            )
            sides = {part["handedness"] for part in obs["hands"]}
            for side, lane in lanes.items():
                lane.add(
                    frames.ref(len(frames) - 1),
                    "present" if side in sides else "no_hand",
                )
    require(
        len(frames) == raw_segment["source"]["frames"] == conversion_doc["access_units"]
        and len(set(frames.frame_ids)) == len(frames)
        and all(a < b for a, b in zip(frames.pts_us, frames.pts_us[1:])),
        "Hand-pose coverage does not match the native timeline",
    )
    target.mkdir(parents=True)
    original = {
        "recording.mp4": source,
        "source.mcap": mcap,
        "diagnostics/segment/native-segments.json": segments,
        "diagnostics/caption/native-captions.json": captions,
        "diagnostics/hand_pose/original-manifest.json": cpu,
        "diagnostics/hand_pose/source-conversion.json": conversion,
        "diagnostics/hand_pose/source-simulation.json": simulation,
        **{
            f"diagnostics/{slot}": root / path
            for slot, path in spec.get("diagnostics", {}).items()
        },
        **{
            entry["relative_path"]: cpu.parent / entry["relative_path"]
            for entry in files.values()
        },
    }
    for slot, path in original.items():
        destination = target / slot
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
    evidence = spec["evidence"]
    require(
        evidence["hand_pose"]["model"] == hand["provenance"]["model"]["name"]
        and evidence["hand_pose"]["weightsSha256"]
        == hand["provenance"]["model"]["asset_sha256"],
        "Hand-pose provenance differs from the original manifest",
    )
    source_doc = {
        "schema": "stateaction.cached-recording-source.v1",
        "recordingId": hand["recording_id"],
        "videoSha256": video_sha,
        "mcapSha256": source_sha,
        "simulation": simulation_doc,
        "attribution": spec["attribution"],
    }
    source_manifest_sha = write(target / "source-manifest.json", source_doc)
    raw_provenance = raw_segment["provenance"]
    require(
        evidence["segment"].get("weightsSha256")
        == raw_provenance.get("tempseg_adapter_sha256"),
        "TempSeg provenance differs from the native document",
    )
    parameter_hash = hashlib.sha256(canonical_bytes(evidence["segment"])).hexdigest()
    ctx = StageContext(
        "segment",
        hand["job_id"],
        hand["recording_id"],
        source_manifest_sha,
        source_sha,
        "imported_segment",
        1,
        {},
        parameter_hash,
        "none",
        frames,
        target,
        lambda *_: None,
        lambda *_: None,
        source,
        {},
    )
    spans, windows_total, failed = segments_from_flora(
        ctx, raw_segment, None, preserve_overlaps=True
    )
    segment_doc = segments_document(
        ctx,
        producer("segment", evidence["segment"], parameter_hash),
        spans,
        windows_total,
        failed,
    )
    segment_doc["schema"] = "stateaction.segments.v2"
    projection_sha = write(
        target / "segments.json", segment_doc, "artifacts.segments.v2"
    )
    parameter_hash = hashlib.sha256(canonical_bytes(evidence["caption"])).hexdigest()
    ctx = replace(
        ctx,
        stage="caption",
        module_id="imported_caption",
        params_sha256=parameter_hash,
        segments=segment_doc,
        segments_sha256=projection_sha,
    )
    caption_doc = captions_document(
        ctx,
        producer("caption", evidence["caption"], parameter_hash),
        captions_from_flora(ctx, {"captions": caption_rows}),
    )
    caption_doc["schema"] = "stateaction.captions.v2"
    write(target / "captions.json", caption_doc, "artifacts.captions.v2")
    require(
        sum(row["status"] == "complete" for row in caption_doc["rows"])
        == sum(row["status"] == "complete" for row in caption_rows),
        "Caption projection did not preserve the completed results",
    )
    parameter_hash = hashlib.sha256(canonical_bytes(evidence["hand_pose"])).hexdigest()
    write(
        target / "hand-presence.json",
        {
            "schema": "stateaction.hand_presence.v2",
            "job_id": hand["job_id"],
            "recording_id": hand["recording_id"],
            "source_manifest_sha256": source_manifest_sha,
            "clock_domain": clock_domain,
            "frame_count": len(frames),
            "producer": producer("hand_pose", evidence["hand_pose"], parameter_hash),
            "lanes": {side: lane.spans() for side, lane in lanes.items()},
        },
        "artifacts.hand-presence.v2",
    )
    report = {
        "schema": "stateaction.cached-processing-import.v1",
        "source": "imported",
        "jobId": hand["job_id"],
        "recordingId": hand["recording_id"],
        "durationSeconds": raw_segment["source"]["duration_s"],
        "attribution": spec["attribution"],
        "evidence": evidence,
        "counts": {
            "segments": len(spans),
            "failedWindows": len(failed),
            "captions": sum(row["status"] == "complete" for row in caption_doc["rows"]),
            "failedCaptions": sum(
                row["status"] == "failed" for row in caption_doc["rows"]
            ),
            "handPoseFrames": len(frames),
        },
        "originals": {slot: sha(path) for slot, path in original.items()},
        "projection": {
            slot: sha(target / slot)
            for slot in (
                "source-manifest.json",
                "segments.json",
                "captions.json",
                "hand-presence.json",
            )
        },
    }
    write(target / "import.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.spec, args.output), indent=2))
