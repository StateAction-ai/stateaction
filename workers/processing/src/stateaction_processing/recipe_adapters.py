from pathlib import Path
from typing import Any

from stateaction_contracts import request_sha256, validate_value
from stateaction_contracts.recipe_graph import read_json, require

from .artifact_types import Attestation, ExportContext, LocalDirectorySink, sha256_file
from .clip_plan import prepare_passthrough
from .flora_adapter import canonical_bytes
from .source_range import ClipBinding
from .stage_media import remux_source

JSON_ARTIFACTS = {
    "plan": "artifacts.clip-plan.v1",
    "hand_presence": "artifacts.hand-presence.v1",
    "segments": "artifacts.segments.v1",
    "captions": "artifacts.captions.v1",
    "observations": "artifacts.hand-observations.v1",
    "frame_map": "artifacts.frame-map.v1",
}


def plan_source(
    request: dict[str, Any], source: Path, scratch: Path
) -> tuple[dict[str, Any], Path]:
    video = scratch / "recording.mp4"
    with source.open("rb") as raw:
        plan = prepare_passthrough(
            raw,
            video,
            recording_id=request["recordingId"],
            plan_version=1,
            source_manifest_sha256=request["sourceManifestSha256"],
            expected_source_sha256=request["sourceSha256"],
            expected_profile=request["rgbProfile"],
        )
    return plan, video


def hand_pose(
    request: dict[str, Any], source: Path, clip: ClipBinding, scratch: Path
) -> tuple[dict[str, Path], dict[str, int], dict[str, Any]]:
    from . import hand_model
    from .artifact_export import export_artifacts
    from .artifact_seal import SealPlan

    binding = request["binding"]
    require(
        binding.get("modelSha256") == hand_model.PINS["sha256"],
        "hand_model_pin_mismatch",
    )
    context = ExportContext(
        job_id=request["jobId"],
        recording_id=request["recordingId"],
        source_file_id=request["sourceFileId"],
        source_manifest_sha256=request["sourceManifestSha256"],
        expected_source_sha256=request["sourceSha256"],
        code_revision=binding["codeRevision"],
        image_spec_sha256=binding["imageSha256"],
        profile_revision=request.get("profileRevision", "recipe-node-v2"),
        attestation=Attestation(request["claimRef"], request["rgbProfile"], None),
    )
    sink = LocalDirectorySink(scratch / "export", request["jobId"])
    with source.open("rb") as raw:
        result = export_artifacts(
            raw,
            sink,
            context,
            scratch_dir=scratch / "export-work",
            seal=SealPlan(
                recipe_id=request.get("recipeRef", "node_worker@1"),
                recipe_sha256=request["recipeSha256"],
                hand_module=request["module"],
                hand_params_sha256=request_sha256({}),
                prior=(),
                prepare_only=True,
                clip=clip,
            ),
        )
    maps = [
        sink.root / item.relative_path
        for item in result.outputs
        if item.role == "frame_map_json"
    ]
    require(bool(maps), "hand_output_inventory")
    first = read_json(maps[0], 16 * 1024**2)["rows"][0]
    last = read_json(maps[-1], 16 * 1024**2)["rows"][-1]
    require(
        result.frames == clip.source_range.frame_count
        and (first["source_frame_id"], result.clips[0]["source_start_ns"]) == clip.first
        and (last["source_frame_id"], result.clips[-1]["source_end_ns"]) == clip.last,
        "clip_source_mismatch",
    )
    roles = {
        "hand_observations_json": "observations",
        "frame_map_json": "frame_map",
        "hand_arrays_npz": "arrays",
        "viewer_rrd": "rrd",
        "clip_mp4": "rgb",
        "thumbnail_jpeg": "thumbnail",
    }
    files = {}
    for item in result.outputs:
        if item.role == "hand_presence_json":
            files["hand_presence"] = sink.root / item.relative_path
        elif item.role in roles and item.clip_ordinal is not None:
            role = roles[item.role]
            files[f"{role}_{item.clip_ordinal}"] = sink.root / item.relative_path
    require(len(files) == len(result.clips) * len(roles) + 1, "hand_output_inventory")
    metadata = {
        key: result.manifest[key]
        for key in (
            "provenance",
            "checks",
            "verified_sources",
            "clips",
            "limitations",
            "metric_accuracy_validated",
            "attestation",
            "simulation",
        )
        if key in result.manifest
    }
    for chunk in metadata["clips"]:
        chunk.pop("files", None)
    return files, {"frames": result.frames, "chunks": len(result.clips)}, metadata


def run_flora(
    request: dict[str, Any],
    node: dict[str, Any],
    source: Path,
    clip: ClipBinding,
    segment_files: dict[str, Path],
    scratch: Path,
) -> tuple[dict[str, Path], dict[str, int]]:
    from .modules import resolve
    from .modules.flora import run_caption_vllm, run_segment_vllm
    from .modules.replay import run_caption, run_segment
    from .stage_docs import StageContext

    caption = node["module"] == "flora_captioner_vllm_fp8@1"
    stage, replay_id = (
        ("caption", "replay_captioner") if caption else ("segment", "replay_segmenter")
    )
    binding = request["binding"]
    replay = binding["mode"] == "local_replay"
    module_id = replay_id if replay else node["module"].partition("@")[0]
    video = scratch / "recording.mp4"
    with source.open("rb") as raw:
        frames = remux_source(
            raw,
            video,
            expected_profile=request["rgbProfile"],
            source_range=clip.source_range,
        )
    require(
        frames.source_sha256 == request["sourceSha256"]
        and (frames.frame_ids[0], frames.timestamps_ns[0]) == clip.first
        and (frames.frame_ids[-1], frames.timestamps_ns[-1]) == clip.last,
        "clip_source_mismatch",
    )
    document, digest, native_digest = None, None, None
    if caption:
        segments = segment_files["segments"]
        document = read_json(segments, 16 * 1024**2)
        require(
            validate_value(JSON_ARTIFACTS["segments"], document).valid
            and document["recording_id"] == request["recordingId"]
            and document["source_manifest_sha256"] == request["sourceManifestSha256"],
            "segments_identity_invalid",
        )
        if replay:
            provenance = read_json(segment_files["replay_provenance"], 16 * 1024**2)
            native_digest = provenance["replayed_from"]["native_sha256"]
            require(
                isinstance(native_digest, str)
                and all(
                    row["ext"].get("replayed_from", {}).get("native_sha256")
                    == native_digest
                    for row in document["rows"]
                    if row["status"] == "ok"
                ),
                "replay_provenance_mismatch",
            )
        digest = sha256_file(segments)
    ctx = StageContext(
        stage,
        request["jobId"],
        request["recordingId"],
        request["sourceManifestSha256"],
        request["sourceSha256"],
        module_id,
        1,
        node["params"],
        request_sha256(node["params"]),
        "none" if replay else binding["gpu"],
        frames,
        scratch,
        lambda *_: None,
        lambda _: None,
        video,
        resolve(stage, f"{module_id}@1"),
        document,
        digest,
    )
    if replay:
        result = (
            run_caption(ctx, expected_native_segments_sha256=native_digest)
            if caption
            else run_segment(ctx)
        )
        provenance_file = "replayed_from.json"
        provenance_role = "replay_provenance"
    else:
        result = run_caption_vllm(ctx) if caption else run_segment_vllm(ctx)
        require(result.observed_gpu == request["observedGpu"], "node_gpu_changed")
        provenance_file = "provenance.json"
        provenance_role = "producer_provenance"
    role = "captions" if caption else "segments"
    output = scratch / f"{role}.json"
    output.write_bytes(canonical_bytes(result.document))
    files = {role: output}
    provenance_path = scratch / provenance_file
    provenance_path.write_bytes(result.extra_diagnostics[provenance_file])
    files[provenance_role] = provenance_path
    if result.windows_rows:
        windows = scratch / "windows.json"
        windows.write_bytes(canonical_bytes(result.windows_rows))
        files["windows"] = windows
    return files, result.counts
