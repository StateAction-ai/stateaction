"""Handwritten stand-ins for the generated bindings in R3.3."""

from . import Call, Handle


def _require(handle: Handle, artifact: str):
    if handle.artifact != artifact:
        raise ValueError("wrong artifact type")
    return handle


def clip_filter_passthrough(*, source: Handle) -> Call:
    return Call(
        "clip_filter_passthrough@1",
        "recording",
        {"source": _require(source, "recording_source@2")},
        {},
        {"plan": "clip_plan@1"},
    )


def recording_mp4_remux(*, source: Handle) -> Call:
    return Call(
        "recording_mp4_remux@1",
        "recording",
        {"source": _require(source, "recording_source@2")},
        {},
        {"video": "recording_mp4@1"},
    )


def flora_tempseg_vllm_fp8(*, video: Handle) -> Call:
    return Call(
        "flora_tempseg_vllm_fp8@1",
        "clip",
        {"video": _require(video, "video_range@1")},
        {},
        {"segments": "segments@2"},
    )


def flora_captioner_vllm_fp8(*, video: Handle, segments: Handle, prompt: str) -> Call:
    return Call(
        "flora_captioner_vllm_fp8@1",
        "clip",
        {
            "video": _require(video, "video_range@1"),
            "segments": _require(segments, "segments@2"),
        },
        {"prompt": prompt},
        {"captions": "captions@2"},
    )


def hand_pose_cpu(*, video: Handle) -> Call:
    return Call(
        "hand_pose_cpu@1",
        "clip",
        {"video": _require(video, "video_range@1")},
        {},
        {"poses": "hand_pose@1"},
    )
