#!/usr/bin/env python3
"""SA-87 additive conformance fixtures for the catalog.v14 stage contracts.

Only NEW fixture files are produced; generate_fixtures.py includes them in its
reproducibility check. Every adapter (TS, Python, Dart) runs the same files.
All media identities are synthetic: no recording, model output or HomER data.
"""

from __future__ import annotations

import copy
import hashlib
import json
import uuid

from generate_fixtures import DELETE, OUT, U, bad, dump, mut, ok
from generate_fixtures import H as H0
from generate_sa25_fixtures import action_cases
from generate_sa28_fixtures import v2_doc

SOURCE = H0["source_manifest"]
TS_REV = "114a1076f70eb53f4a58ac045505db3087e79347"
SEGMENT_NS = uuid.uuid5(
    uuid.NAMESPACE_URL, "https://stateaction.ai/schemas/artifacts/segments.v1.json"
)
assert str(SEGMENT_NS) == "a505457d-7470-5704-b995-1b3d1e3638df"


def h(label: str) -> str:
    return hashlib.sha256(f"sa87:{label}".encode()).hexdigest()


def cjson_sha256(value) -> str:
    """sa-cjson-v1 for the ASCII-key, integer/string/bool/null values used here."""
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode()).hexdigest()


# ------------------------------------------------------------------ recipe
def stage(name, module, gpu, budget, params=None, enabled=True):
    return {
        "stage": name,
        "enabled": enabled,
        "module": module,
        "params": params if params is not None else {},
        "resources": {
            "gpu": gpu,
            "budgetSeconds": budget,
            "maxContainers": 1,
            "retries": 0,
        },
    }


SEG_PARAMS = {"grid_profile": "human_16s_4hz", "batch_size": 8, "repair_budget": 64}
CAP_PARAMS = {"max_new_tokens": 256, "temperature": "0.0", "overlap": True}
RECIPE = {
    "schemaVersion": 1,
    "recipeId": "flora_fp8@1",
    "maxJobCostUsd": "3.00",
    "stages": [
        stage("segment", "flora_tempseg_vllm_fp8@1", "RTX-PRO-6000", 1800, SEG_PARAMS),
        stage(
            "caption", "flora_captioner_vllm_fp8@1", "RTX-PRO-6000", 3600, CAP_PARAMS
        ),
        stage("hand_pose", "hand_pose_cpu_v1@1", "none", 7200),
    ],
}
STUB_RECIPE = {
    "schemaVersion": 1,
    "recipeId": "local_stub@1",
    "maxJobCostUsd": "0.00",
    "stages": [
        stage("segment", "stub_segmenter@1", "none", 60, {"fail_windows": "3"}),
        stage("caption", "stub_captioner@1", "none", 60, {"fail_captions": "1"}),
        stage("hand_pose", "hand_pose_cpu_v1@1", "none", 600),
    ],
}


def recipe_cases():
    base = RECIPE
    return [
        ok("default FLORA fp8 recipe", base),
        ok("local stub recipe", STUB_RECIPE),
        mut(
            "segment only, caption disabled",
            base,
            [("/stages/1/enabled", False)],
            None,
        ),
        mut(
            "hand pose only",
            base,
            [("/stages/0/enabled", False), ("/stages/1/enabled", False)],
            None,
        ),
        mut(
            "HF fallback segmenter on an A100",
            base,
            [
                ("/stages/0/module", "flora_tempseg_hf@1"),
                ("/stages/0/resources/gpu", "A100-40GB"),
            ],
            None,
        ),
        mut(
            "caption enabled without segment",
            base,
            [("/stages/0/enabled", False)],
            "reference_mismatch",
            "/stages/1/enabled",
        ),
        mut(
            "GPU below the module minimum",
            base,
            [("/stages/0/resources/gpu", "L4")],
            "reference_mismatch",
            "/stages/0/resources/gpu",
        ),
        mut(
            "fp8 module on a GPU it is not qualified on",
            base,
            [("/stages/1/resources/gpu", "A100-80GB")],
            "reference_mismatch",
            "/stages/1/resources/gpu",
        ),
        mut(
            "CPU module asked for a GPU",
            base,
            [("/stages/2/resources/gpu", "T4")],
            "reference_mismatch",
            "/stages/2/resources/gpu",
        ),
        mut(
            "unknown module",
            base,
            [("/stages/0/module", "flora_tempseg_vllm_fp8@2")],
            "reference_mismatch",
            "/stages/0/module",
        ),
        mut(
            "module of another stage",
            base,
            [("/stages/0/module", "flora_captioner_vllm_fp8@1")],
            "reference_mismatch",
            "/stages/0/module",
        ),
        mut(
            "retries must be 0",
            base,
            [("/stages/0/resources/retries", 1)],
            "schema_violation",
            "/stages/0/resources/retries",
        ),
        mut(
            "hand pose always runs",
            base,
            [("/stages/2/enabled", False)],
            "schema_violation",
            "/stages/2/enabled",
        ),
        mut(
            "stages are in recipe order",
            base,
            [("/stages/0", base["stages"][1]), ("/stages/1", base["stages"][0])],
            "schema_violation",
        ),
        mut(
            "every stage is present",
            base,
            [("/stages/2", DELETE)],
            "schema_violation",
        ),
        mut(
            "cost cap is a decimal string, never a float",
            base,
            [("/maxJobCostUsd", 3.5)],
            "schema_violation",
            "/maxJobCostUsd",
        ),
        mut(
            "cost cap has two fraction digits",
            base,
            [("/maxJobCostUsd", "3.5")],
            "schema_violation",
            "/maxJobCostUsd",
        ),
        mut(
            "fractional params are decimal strings",
            base,
            [("/stages/1/params/temperature", 0.5)],
            "schema_violation",
        ),
        mut(
            "params are flat",
            base,
            [("/stages/1/params/processor", {"fps": 2})],
            "schema_violation",
        ),
        mut(
            "budget is bounded",
            base,
            [("/stages/0/resources/budgetSeconds", 0)],
            "schema_violation",
            "/stages/0/resources/budgetSeconds",
        ),
        mut(
            "recipe id carries a version",
            base,
            [("/recipeId", "flora_fp8")],
            "schema_violation",
            "/recipeId",
        ),
        mut(
            "other recipe versions are rejected",
            base,
            [("/schemaVersion", 2)],
            "unsupported_version",
            "/schemaVersion",
        ),
    ]


# -------------------------------------------------------------- producers
def producer_fp8(stage_name, module, model, revision, params):
    return {
        "stage": stage_name,
        "module_id": module,
        "module_version": 1,
        "model_name": model,
        "model_revision": revision,
        "weights_sha256": h(f"{module}:weights"),
        "quant": {
            "method": "fp8_per_tensor",
            "checkpoint_manifest_sha256": h(f"{module}:checkpoint"),
        },
        "prompt_sha256": h(f"{module}:prompt"),
        "params_sha256": cjson_sha256(params),
        "decoding_params": {
            "do_sample": False,
            "num_beams": 1,
            "max_new_tokens": 1024,
            "temperature": "0.0",
        },
        "engine": {"name": "vllm", "version": "0.11.2"},
        "gpu": {
            "requested_type": "RTX-PRO-6000",
            "observed_type": "NVIDIA RTX PRO 6000 Blackwell Server Edition",
        },
    }


SEG_PRODUCER = producer_fp8(
    "segment", "flora_tempseg_vllm_fp8", "nvidia/Flora-TempSeg", TS_REV, SEG_PARAMS
)
CAP_PRODUCER = producer_fp8(
    "caption",
    "flora_captioner_vllm_fp8",
    "nvidia/Flora-Captioner",
    "rev-c3",
    CAP_PARAMS,
)
STUB_SEG_PRODUCER = {
    "stage": "segment",
    "module_id": "stub_segmenter",
    "module_version": 1,
    "model_name": "stub_segmenter",
    "model_revision": None,
    "weights_sha256": None,
    "quant": None,
    "prompt_sha256": None,
    "params_sha256": cjson_sha256({"fail_windows": "3"}),
    "decoding_params": {},
    "engine": {"name": "stub", "version": "1"},
    "gpu": {"requested_type": "none", "observed_type": None},
}
HAND_PRODUCER = {
    "stage": "hand_pose",
    "module_id": "hand_pose_cpu_v1",
    "module_version": 1,
    "model_name": "mediapipe_hand_landmarker",
    "model_revision": None,
    "weights_sha256": "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
    "quant": None,
    "prompt_sha256": None,
    "params_sha256": cjson_sha256({}),
    "decoding_params": {},
    "engine": {"name": "mediapipe", "version": "0.10.21"},
    "gpu": {"requested_type": "none", "observed_type": None},
}


# ---------------------------------------------------------------- segments
def frame(i: int) -> dict:
    """Synthetic 30 fps frame i: native id 1000 + i, android.elapsed_realtime ns."""
    return {
        "source_frame_id": str(1000 + i),
        "timestamp_ns": str(5000000000 + i * 33333333),
    }


END = {"source_frame_id": None, "timestamp_ns": None}


def ref(i):
    return END if i is None else frame(i)


def segment_rows(producer, spans):
    rows = []
    for ordinal, (start, end, status) in enumerate(spans):
        end_ref = ref(end)
        rows.append(
            {
                "segment_id": str(
                    uuid.uuid5(
                        SEGMENT_NS,
                        "|".join(
                            [
                                SOURCE,
                                f"{producer['module_id']}@{producer['module_version']}",
                                producer["params_sha256"],
                                frame(start)["source_frame_id"],
                                end_ref["source_frame_id"] or "end",
                            ]
                        ),
                    )
                ),
                "ordinal": ordinal,
                "start": frame(start),
                "end": end_ref,
                "status": status,
                "ext": {"flora": {"provenance": "fine", "stitched": False}}
                if status == "ok"
                else {},
            }
        )
    return rows


SPANS = [
    (0, 110, "ok"),
    (110, 240, "ok"),
    (360, 480, "failed_window"),
    (480, None, "ok"),
]
SPANS_OK = [s for s in SPANS if s[2] == "ok"]


def segments_doc(producer=SEG_PRODUCER, spans=SPANS, failed=True):
    return {
        "schema": "stateaction.segments.v1",
        "job_id": U["job"],
        "recording_id": U["recording"],
        "source_manifest_sha256": SOURCE,
        "clock_domain": "android.elapsed_realtime",
        "producer": copy.deepcopy(producer),
        "windows": {
            "total": 7,
            "ok": 6 if failed else 7,
            "failed": [
                {
                    "window_index": 3,
                    "error_code": "engine_timeout",
                    "core_start": frame(360),
                    "core_end": frame(480),
                }
            ]
            if failed
            else [],
            "failed_core_spans": [{"start": frame(360), "end": frame(480)}]
            if failed
            else [],
        },
        "rows": segment_rows(producer, spans),
    }


def segments_cases():
    base = segments_doc()
    clean = segments_doc(spans=SPANS_OK, failed=False)
    stub = segments_doc(producer=STUB_SEG_PRODUCER)
    empty = segments_doc(spans=[], failed=False)
    empty["windows"] = {"total": 0, "ok": 0, "failed": [], "failed_core_spans": []}
    no_span = segments_doc(spans=SPANS_OK)
    no_span["windows"]["failed_core_spans"] = []
    row_no_span = segments_doc(failed=False)
    two_windows = copy.deepcopy(base)
    two_windows["windows"]["ok"] = 5
    two_windows["windows"]["failed"].append(
        {
            "window_index": 4,
            "error_code": "engine_timeout",
            "core_start": frame(400),
            "core_end": frame(480),
        }
    )
    window_outside = copy.deepcopy(base)
    window_outside["windows"]["failed"][0]["core_end"] = frame(500)
    span_no_window = segments_doc()
    span_no_window["windows"]["failed"] = []
    span_no_window["windows"]["ok"] = 7
    return [
        ok("segments with a failed window recorded as a failed span", base),
        ok("every window ok", clean),
        ok("no segments found is an explicit empty result", empty),
        ok("stub module may leave model provenance null", stub),
        ok("two failed windows inside one merged core span", two_windows),
        bad(
            "failed window without a span",
            no_span,
            "reference_mismatch",
            "/windows/failed/0",
        ),
        bad(
            "failed window outside its recorded span",
            window_outside,
            "reference_mismatch",
            "/windows/failed/0",
        ),
        bad(
            "failed_window row without a failed core span",
            row_no_span,
            "reference_mismatch",
            "/rows/2/status",
        ),
        bad(
            "failed core span without a failed window",
            span_no_window,
            "reference_mismatch",
            "/windows/failed_core_spans/0",
        ),
        mut(
            "failed span not recorded as a row",
            base,
            [("/rows/2/status", "ok")],
            "reference_mismatch",
            "/windows/failed_core_spans/0",
        ),
        mut(
            "window counts add up",
            base,
            [("/windows/ok", 7)],
            "progress_mismatch",
            "/windows/ok",
        ),
        mut(
            "a failed window is listed once",
            two_windows,
            [("/windows/failed/1/window_index", 3)],
            "duplicate_identity",
            "/windows/failed/1/window_index",
        ),
        mut(
            "failed window ends after it starts",
            base,
            [("/windows/failed/0/core_end", frame(360))],
            "ordering_violation",
            "/windows/failed/0/core_end",
        ),
        mut(
            "failed core spans are ordered",
            base,
            [("/windows/failed_core_spans/0/end", frame(300))],
            "ordering_violation",
            "/windows/failed_core_spans/0/end",
        ),
        mut(
            "ordinals are dense",
            base,
            [("/rows/1/ordinal", 5)],
            "ordering_violation",
            "/rows/1/ordinal",
        ),
        mut(
            "segment ids are unique",
            base,
            [("/rows/1/segment_id", base["rows"][0]["segment_id"])],
            "duplicate_identity",
            "/rows/1/segment_id",
        ),
        mut(
            "end is exclusive and after start",
            base,
            [("/rows/0/end", frame(0))],
            "ordering_violation",
            "/rows/0/end",
        ),
        mut(
            "timestamps move with frame ids",
            base,
            [("/rows/0/end/timestamp_ns", "5000000000")],
            "ordering_violation",
            "/rows/0/end",
        ),
        mut(
            "rows do not overlap",
            base,
            [("/rows/1/start", frame(100))],
            "ordering_violation",
            "/rows/1/start",
        ),
        bad(
            "only the last row may end at end of stream",
            segments_doc(spans=[(0, None, "ok")] + SPANS[1:]),
            "ordering_violation",
            "/rows/1/start",
        ),
        mut(
            "segment id is the uuid5 of source, module, params and frames",
            base,
            [("/rows/0/segment_id", "0c4c8a1e-1d2b-5c3d-8e4f-5a6b7c8d9e0f")],
            "reference_mismatch",
            "/rows/0/segment_id",
        ),
        mut(
            "segment id must be a uuid5",
            base,
            [("/rows/0/segment_id", U["clip"])],
            "schema_violation",
            "/rows/0/segment_id",
        ),
        mut(
            "status is ok or failed_window",
            base,
            [("/rows/0/status", "empty")],
            "schema_violation",
            "/rows/0/status",
        ),
        mut(
            "start is a real frame",
            base,
            [("/rows/0/start", END)],
            "schema_violation",
        ),
        mut(
            "ext is namespaced",
            base,
            [("/rows/0/ext", {"provenance": "fine"})],
            "schema_violation",
        ),
        mut(
            "producer stage matches the document",
            base,
            [("/producer/stage", "caption")],
            "reference_mismatch",
            "/producer/stage",
        ),
        mut(
            "producer module is in the manifest",
            base,
            [("/producer/module_version", 9)],
            "reference_mismatch",
            "/producer/module_id",
        ),
        mut(
            "producer model matches the manifest",
            base,
            [("/producer/model_name", "nvidia/Other")],
            "reference_mismatch",
            "/producer/model_name",
        ),
        mut(
            "producer engine matches the manifest",
            base,
            [("/producer/engine/name", "transformers")],
            "reference_mismatch",
            "/producer/engine/name",
        ),
        mut(
            "weights hash is required for FLORA",
            base,
            [("/producer/weights_sha256", None)],
            "reference_mismatch",
            "/producer/weights_sha256",
        ),
        mut(
            "quantization is recorded for the fp8 module",
            base,
            [("/producer/quant", None)],
            "reference_mismatch",
            "/producer/quant",
        ),
        mut(
            "prompt hash is required for FLORA",
            base,
            [("/producer/prompt_sha256", None)],
            "reference_mismatch",
            "/producer/prompt_sha256",
        ),
        mut(
            "observed GPU is recorded, never copied",
            base,
            [("/producer/gpu/observed_type", None)],
            "reference_mismatch",
            "/producer/gpu/observed_type",
        ),
        mut(
            "requested GPU is one the module is qualified on",
            base,
            [("/producer/gpu/requested_type", "L4")],
            "reference_mismatch",
            "/producer/gpu/requested_type",
        ),
        mut(
            "decoding params are never floats",
            base,
            [("/producer/decoding_params/top_p", 0.9)],
            "schema_violation",
        ),
        mut(
            "timestamps are decimal strings",
            base,
            [("/rows/0/start/timestamp_ns", 5000000000)],
            "schema_violation",
        ),
        mut(
            "other segment versions are rejected",
            base,
            [("/schema", "stateaction.segments.v2")],
            "unsupported_version",
            "/schema",
        ),
    ]


# ---------------------------------------------------------------- captions
TEXT_A = "hold cloth with right hand, rotate pitcher with both hands, tighten pitcher lid with right hand"
TEXT_B = "pick up pitcher with right hand"
SEGMENT_IDS = [r["segment_id"] for r in segment_rows(SEG_PRODUCER, SPANS)]


def complete(segment_id, text, label, hand):
    return {
        "segment_id": segment_id,
        "status": "complete",
        "error_code": None,
        "text": text,
        "lang": "en",
        "derived": {
            "rule": "caption_rule@1",
            "short_label": label,
            "hand": hand,
            "steps": [s.strip(" \t") for s in text.split(",") if s.strip(" \t")],
        },
    }


CAPTIONS = {
    "schema": "stateaction.captions.v1",
    "job_id": U["job"],
    "recording_id": U["recording"],
    "source_manifest_sha256": SOURCE,
    "segments_sha256": hashlib.sha256(dump(segments_doc())).hexdigest(),
    "producer": CAP_PRODUCER,
    "rows": [
        complete(SEGMENT_IDS[0], TEXT_A, "rotate pitcher", "both"),
        complete(SEGMENT_IDS[1], TEXT_B, "pick up pitcher", "right"),
        {
            "segment_id": SEGMENT_IDS[2],
            "status": "not_captioned",
            "error_code": "segment_failed_window",
        },
        {
            "segment_id": SEGMENT_IDS[3],
            "status": "failed",
            "error_code": "unsupported_target_frames",
        },
    ],
}


def captions_cases():
    base = CAPTIONS
    return [
        ok("complete, failed and not_captioned rows", base),
        mut("no captions", base, [("/rows", [])], None),
        mut(
            "empty caption text",
            base,
            [("/rows/0/text", "")],
            "schema_violation",
        ),
        mut(
            "whitespace-only caption text",
            base,
            [("/rows/0/text", "   ")],
            "schema_violation",
        ),
        mut(
            "caption text is a single trimmed line",
            base,
            [("/rows/0/text", "pick up pitcher\nwith right hand")],
            "schema_violation",
        ),
        mut(
            "failed caption stored as empty text",
            base,
            [("/rows/3/text", "")],
            "schema_violation",
        ),
        mut(
            "failed caption carries no text",
            base,
            [("/rows/3/text", "pick up pitcher")],
            "schema_violation",
        ),
        mut(
            "complete caption requires text",
            base,
            [("/rows/1/text", DELETE)],
            "schema_violation",
        ),
        mut(
            "complete caption has no error code",
            base,
            [("/rows/1/error_code", "unsupported_target_frames")],
            "schema_violation",
        ),
        mut(
            "failed caption requires an error code",
            base,
            [("/rows/3/error_code", None)],
            "schema_violation",
        ),
        mut(
            "not_captioned requires a reason code",
            base,
            [("/rows/2/error_code", DELETE)],
            "schema_violation",
        ),
        mut(
            "derived fields only with text",
            base,
            [("/rows/3/derived", base["rows"][1]["derived"])],
            "schema_violation",
        ),
        mut(
            "derived rule version is pinned",
            base,
            [("/rows/0/derived/rule", "caption_rule@2")],
            "schema_violation",
            "/rows/0/derived/rule",
        ),
        mut(
            "derived hand vocabulary",
            base,
            [("/rows/0/derived/hand", "unknown")],
            "schema_violation",
            "/rows/0/derived/hand",
        ),
        mut(
            "steps are the caption split on commas",
            base,
            [("/rows/0/derived/steps", ["rotate pitcher with both hands"])],
            "reference_mismatch",
            "/rows/0/derived/steps",
        ),
        mut(
            "one caption per segment",
            base,
            [("/rows/1/segment_id", SEGMENT_IDS[0])],
            "duplicate_identity",
            "/rows/1/segment_id",
        ),
        mut(
            "producer engine matches the manifest",
            base,
            [("/producer/engine/name", "stub")],
            "reference_mismatch",
            "/producer/engine/name",
        ),
        mut(
            "producer is a caption module",
            base,
            [
                ("/producer/module_id", "flora_tempseg_vllm_fp8"),
                ("/producer/model_name", "nvidia/Flora-TempSeg"),
            ],
            "reference_mismatch",
            "/producer/module_id",
        ),
        mut(
            "captioned segments are pinned by digest",
            base,
            [("/segments_sha256", DELETE)],
            "schema_violation",
        ),
        mut(
            "other caption versions are rejected",
            base,
            [("/schema", "stateaction.captions.v0")],
            "unsupported_version",
            "/schema",
        ),
    ]


# ----------------------------------------------------------- hand presence
def lane(spans):
    return [
        {
            "start": frame(a),
            "end": ref(b),
            "frames": (600 if b is None else b) - a,
            "state": s,
        }
        for a, b, s in spans
    ]


HAND = {
    "schema": "stateaction.hand_presence.v1",
    "job_id": U["job"],
    "recording_id": U["recording"],
    "source_manifest_sha256": SOURCE,
    "clock_domain": "android.elapsed_realtime",
    "frame_count": 600,
    "producer": HAND_PRODUCER,
    "lanes": {
        "left": lane(
            [
                (0, 200, "present"),
                (200, 450, "no_hand"),
                (450, 500, "failed"),
                (500, None, "present"),
            ]
        ),
        "right": lane([(0, None, "no_hand")]),
    },
}


def hand_cases():
    base = HAND
    return [
        ok("left and right lanes with explicit no_hand and failed frames", base),
        mut(
            "every frame failed",
            base,
            [
                ("/lanes/left", lane([(0, None, "failed")])),
                ("/lanes/right", lane([(0, None, "failed")])),
            ],
            None,
        ),
        mut(
            "spans are contiguous",
            base,
            [("/lanes/left/1/start", frame(210))],
            "ordering_violation",
            "/lanes/left/1/start",
        ),
        mut(
            "runs are merged",
            base,
            [("/lanes/left/1/state", "present")],
            "ordering_violation",
            "/lanes/left/1/state",
        ),
        mut(
            "span ends after it starts",
            base,
            [("/lanes/left/0/end", frame(0))],
            "ordering_violation",
            "/lanes/left/0/end",
        ),
        mut(
            "frames cover the recording",
            base,
            [("/lanes/left/0/frames", 199)],
            "dimension_mismatch",
            "/lanes/left",
        ),
        mut(
            "lane runs to end of stream",
            base,
            [("/lanes/right/0/end", frame(600))],
            "dimension_mismatch",
            "/lanes/right/0/end",
        ),
        mut(
            "failed is not folded into no_hand or unknown",
            base,
            [("/lanes/left/2/state", "unknown")],
            "schema_violation",
            "/lanes/left/2/state",
        ),
        mut(
            "a lane is never empty",
            base,
            [("/lanes/right", [])],
            "schema_violation",
            "/lanes/right",
        ),
        mut(
            "hand model weights hash is required",
            base,
            [("/producer/weights_sha256", None)],
            "reference_mismatch",
            "/producer/weights_sha256",
        ),
        mut(
            "CPU module never requests a GPU",
            base,
            [("/producer/gpu/requested_type", "T4")],
            "reference_mismatch",
            "/producer/gpu/requested_type",
        ),
        mut(
            "other hand presence versions are rejected",
            base,
            [("/schema", "stateaction.hand_presence.v2")],
            "unsupported_version",
            "/schema",
        ),
    ]


# --------------------------------------------------------- module manifest
MANIFEST_ENTRY = {
    "moduleId": "stub_segmenter",
    "version": 1,
    "stage": "segment",
    "description": "Synthetic segments.",
    "license": {"id": "LicenseRef-StateAction-Internal", "commercialUse": True},
    "gpu": {"minimum": "none", "supported": ["none"]},
    "localOnly": True,
    "outputs": ["segments_json"],
    "provenance": {
        "modelName": "stub_segmenter",
        "modelRevision": None,
        "engine": "stub",
        "requires": [],
    },
}


def manifest_cases():
    base = {"schemaVersion": 1, "modules": [MANIFEST_ENTRY]}
    return [
        {
            "name": "the committed api/modules.json",
            "input": {"file": "../../api/modules.json"},
            "expect": {"valid": True},
        },
        ok("one module", base),
        mut(
            "a second version of a module",
            base,
            [("/modules/1", dict(MANIFEST_ENTRY, version=2))],
            None,
        ),
        mut(
            "module_id@version is unique",
            base,
            [("/modules/1", MANIFEST_ENTRY)],
            "duplicate_identity",
            "/modules/1/version",
        ),
        mut(
            "minimum GPU is a supported GPU",
            base,
            [("/modules/0/gpu/minimum", "T4")],
            "reference_mismatch",
            "/modules/0/gpu/minimum",
        ),
        mut(
            "outputs belong to the module stage",
            base,
            [("/modules/0/outputs/0", "captions_json")],
            "reference_mismatch",
            "/modules/0/outputs/0",
        ),
        mut(
            "unknown GPU type",
            base,
            [("/modules/0/gpu/supported/0", "TPU")],
            "schema_violation",
            "/modules/0/gpu/supported/0",
        ),
        mut(
            "licence is required",
            base,
            [("/modules/0/license", DELETE)],
            "schema_violation",
        ),
        mut(
            "provenance requirements use producer field names",
            base,
            [("/modules/0/provenance/requires", ["checkpoint"])],
            "schema_violation",
            "/modules/0/provenance/requires/0",
        ),
        mut("a manifest lists modules", base, [("/modules", [])], "schema_violation"),
    ]


# -------------------------------------------------------------- task input
def task(recipe=RECIPE, digest=None):
    return {
        "schemaVersion": 3,
        "jobId": U["job"],
        "targetId": U["recording"],
        "profileRevision": "cpu-mediapipe-1",
        "kind": "process_recording",
        "sourceManifestSha256": SOURCE,
        "rgbProfile": "h264_mcap_v1",
        "recipe": recipe,
        "recipeSha256": digest or cjson_sha256(recipe),
    }


def task_cases():
    base = task()
    reordered = json.loads(json.dumps(RECIPE, sort_keys=True))
    no_caption_segment = mut("x", RECIPE, [("/stages/0/enabled", False)], None)
    unqualified = mut("x", RECIPE, [("/stages/0/resources/gpu", "L4")], None)
    return [
        ok("process recording with an inline recipe", base),
        ok("stub recipe", task(STUB_RECIPE)),
        ok(
            "recipe digest is canonical, not byte order",
            task(reordered, cjson_sha256(RECIPE)),
        ),
        ok(
            "export release is unchanged",
            {
                "schemaVersion": 3,
                "jobId": U["job"],
                "targetId": U["recording"],
                "profileRevision": "cpu-mediapipe-1",
                "kind": "export_release",
                "selectionSha256": H0["config"],
            },
        ),
        mut(
            "recipe digest must match the recipe",
            base,
            [("/recipeSha256", cjson_sha256(STUB_RECIPE))],
            "reference_mismatch",
            "/recipeSha256",
        ),
        bad(
            "caption enabled without segment",
            task(
                no_caption_segment["input"]["document"],
            ),
            "reference_mismatch",
            "/recipe/stages/1/enabled",
        ),
        bad(
            "GPU below the module minimum",
            task(unqualified["input"]["document"]),
            "reference_mismatch",
            "/recipe/stages/0/resources/gpu",
        ),
        mut(
            "recipe is required",
            base,
            [("/recipe", DELETE)],
            "schema_violation",
        ),
        mut(
            "retries in an inline recipe must be 0",
            base,
            [("/recipe/stages/1/resources/retries", 2)],
            "schema_violation",
        ),
        mut(
            "v2 task inputs are a different contract",
            base,
            [("/schemaVersion", 2)],
            "unsupported_version",
            "/schemaVersion",
        ),
    ]


# -------------------------------------------------------- processing result
OUT_IDS = {
    "segments": "29d0e1f2-a3b4-4c5d-8e6f-708192a3b4c5",
    "captions": "3ae1f2a3-b4c5-4d6e-9f70-8192a3b4c5d6",
    "presence": "4bf2a3b4-c5d6-4e7f-a081-92a3b4c5d6e7",
    "review": "5c03b4c5-d6e7-4f80-b192-a3b4c5d6e7f8",
    "diag": "6d14c5d6-e7f8-4091-82a3-b4c5d6e7f809",
}
NEW_OUTPUTS = [
    ("segments", "segments_json", "annotations/segments.json"),
    ("captions", "captions_json", "annotations/captions.json"),
    ("presence", "hand_presence_json", "annotations/hand-presence.json"),
    ("review", "recording_mp4", "review/recording.mp4"),
    ("diag", "diagnostic_blob", "diagnostics/segment/windows.jsonl"),
]


def result_v3():
    doc = v2_doc()
    doc["schema"] = "stateaction.processing_result.v3"
    doc["recipe_id"] = RECIPE["recipeId"]
    doc["recipe_sha256"] = cjson_sha256(RECIPE)
    for key, role, path in NEW_OUTPUTS:
        doc["outputs"].append(
            {
                "file_id": OUT_IDS[key],
                "role": role,
                "relative_path": path,
                "size_bytes": "2048",
                "sha256": h(key),
            }
        )
    clip_files = [
        o["file_id"] for o in doc["outputs"] if o["file_id"] not in OUT_IDS.values()
    ]
    doc["nodes"] = [
        {
            "stage": "segment",
            "status": "succeeded",
            "module": "flora_tempseg_vllm_fp8@1",
            "error_code": None,
            "outputs": [OUT_IDS["segments"], OUT_IDS["diag"]],
            "counts": {"segments": 4, "failed_windows": 1},
        },
        {
            "stage": "caption",
            "status": "succeeded",
            "module": "flora_captioner_vllm_fp8@1",
            "error_code": None,
            "outputs": [OUT_IDS["captions"]],
            "counts": {"captions_complete": 2, "captions_failed": 1},
        },
        {
            "stage": "hand_pose",
            "status": "succeeded",
            "module": "hand_pose_cpu_v1@1",
            "error_code": None,
            "outputs": clip_files + [OUT_IDS["presence"], OUT_IDS["review"]],
            "counts": {"clips": 1},
        },
    ]
    return doc


def result_cases():
    base = result_v3()
    caption_failed = copy.deepcopy(base)
    caption_failed["outputs"] = [
        o for o in base["outputs"] if o["file_id"] != OUT_IDS["captions"]
    ]
    caption_failed["nodes"][1].update(
        status="failed", error_code="stage_timeout", outputs=[], counts={}
    )
    no_clips = copy.deepcopy(base)
    clip_ids = set(base["nodes"][2]["outputs"]) - {
        OUT_IDS["presence"],
        OUT_IDS["review"],
    }
    no_clips["clips"] = []
    no_clips["outputs"] = [o for o in base["outputs"] if o["file_id"] not in clip_ids]
    no_clips["nodes"][2]["outputs"] = [OUT_IDS["presence"], OUT_IDS["review"]]
    diag_index = next(
        i for i, o in enumerate(base["outputs"]) if o["file_id"] == OUT_IDS["diag"]
    )
    not_run = copy.deepcopy(caption_failed)
    not_run["nodes"][1].update(status="not_run", error_code="stage_disabled")
    return [
        ok("all three stages succeeded", base),
        ok("caption stage failed; the job still seals", caption_failed),
        ok("caption stage not run", not_run),
        ok("recording-level outputs with zero clips", no_clips),
        mut(
            "failed node needs an error code",
            caption_failed,
            [("/nodes/1/error_code", None)],
            "outcome_mismatch",
            "/nodes/1/error_code",
        ),
        mut(
            "succeeded node has no error code",
            base,
            [("/nodes/0/error_code", "stage_timeout")],
            "outcome_mismatch",
            "/nodes/0/error_code",
        ),
        mut(
            "not_run node produced nothing",
            not_run,
            [
                ("/nodes/1/outputs", [OUT_IDS["diag"]]),
                ("/nodes/0/outputs", [OUT_IDS["segments"]]),
            ],
            "outcome_mismatch",
            "/nodes/1/outputs",
        ),
        mut(
            "succeeded segment node lists its segments",
            base,
            [("/nodes/0/outputs", [OUT_IDS["diag"]])],
            "inventory_incomplete",
            "/nodes/0/outputs",
        ),
        mut(
            "every output belongs to a node",
            base,
            [("/nodes/0/outputs", [OUT_IDS["segments"]])],
            "reference_mismatch",
            f"/outputs/{diag_index}/file_id",
        ),
        mut(
            "node output is a manifest output",
            base,
            [("/nodes/0/outputs/1", U["clip"])],
            "reference_mismatch",
            "/nodes/0/outputs/1",
        ),
        mut(
            "node output has a role of its stage",
            base,
            [
                (
                    "/nodes/0/outputs",
                    [OUT_IDS["segments"], OUT_IDS["diag"], OUT_IDS["captions"]],
                ),
                ("/nodes/1/outputs", []),
            ],
            "reference_mismatch",
            "/nodes/0/outputs/2",
        ),
        mut(
            "an output belongs to one node",
            base,
            [("/nodes/1/outputs", [OUT_IDS["captions"], OUT_IDS["diag"]])],
            "duplicate_identity",
            "/nodes/1/outputs/1",
        ),
        mut(
            "succeeded caption node lists exactly one captions file",
            base,
            [("/nodes/1/outputs", []), ("/nodes/0/outputs", [OUT_IDS["segments"]])],
            "inventory_incomplete",
            "/nodes/1/outputs",
        ),
        mut(
            "hand pose seals with the review video",
            no_clips,
            [
                ("/nodes/2/outputs", [OUT_IDS["presence"]]),
                (
                    "/outputs",
                    [
                        o
                        for o in no_clips["outputs"]
                        if o["file_id"] != OUT_IDS["review"]
                    ],
                ),
            ],
            "inventory_incomplete",
            "/nodes/2/outputs",
        ),
        mut(
            "hand pose node is never not_run",
            base,
            [("/nodes/2/status", "not_run")],
            "schema_violation",
            "/nodes/2/status",
        ),
        mut(
            "nodes are in recipe order",
            base,
            [("/nodes/0", base["nodes"][1]), ("/nodes/1", base["nodes"][0])],
            "schema_violation",
        ),
        mut(
            "nodes are required",
            base,
            [("/nodes", DELETE)],
            "schema_violation",
        ),
        mut(
            "v2 discriminator is not accepted here",
            base,
            [("/schema", "stateaction.processing_result.v2")],
            "unsupported_version",
            "/schema",
        ),
    ]


# ----------------------------------------------------- receipts and actions
def receipt(stage_name="segment", status="succeeded", outputs=None):
    return {
        "schemaVersion": 1,
        "jobId": U["job"],
        "stage": stage_name,
        "module": "flora_tempseg_vllm_fp8@1"
        if stage_name == "segment"
        else "flora_captioner_vllm_fp8@1",
        "status": status,
        "errorCode": None if status == "succeeded" else "stage_timeout",
        "outputs": outputs
        if outputs is not None
        else [
            {
                "fileId": OUT_IDS["segments"],
                "role": "segments_json",
                "sizeBytes": "2048",
                "sha256": h("segments"),
            },
            {
                "fileId": OUT_IDS["diag"],
                "role": "diagnostic_blob",
                "sizeBytes": "4096",
                "sha256": h("diag"),
            },
        ],
        "counts": {"segments": 4, "windows_total": 7, "failed_windows": 1},
        "gpu": {
            "requestedType": "RTX-PRO-6000",
            "observedType": "NVIDIA RTX PRO 6000 Blackwell Server Edition",
        },
        "startedAt": "2026-11-22T10:00:00.000Z",
        "finishedAt": "2026-11-22T10:03:12.250Z",
    }


def receipt_cases():
    base = receipt()
    failed = receipt(status="failed", outputs=[])
    return [
        ok("segment stage receipt", base),
        ok("failed stage receipt with no outputs", failed),
        mut(
            "succeeded receipt has no error code",
            base,
            [("/errorCode", "stage_timeout")],
            "outcome_mismatch",
            "/errorCode",
        ),
        mut(
            "failed receipt names its error",
            failed,
            [("/errorCode", None)],
            "outcome_mismatch",
            "/errorCode",
        ),
        mut(
            "outputs are unique",
            base,
            [("/outputs/1/fileId", OUT_IDS["segments"])],
            "duplicate_identity",
            "/outputs/1/fileId",
        ),
        mut(
            "output role belongs to the stage",
            base,
            [("/outputs/1/role", "captions_json")],
            "reference_mismatch",
            "/outputs/1/role",
        ),
        mut(
            "succeeded segment receipt hands over its segments file",
            base,
            [("/outputs", [base["outputs"][1]])],
            "inventory_incomplete",
            "/outputs",
        ),
        mut(
            "finished after it started",
            base,
            [("/finishedAt", "2026-11-22T09:59:59.999Z")],
            "ordering_violation",
            "/finishedAt",
        ),
        mut(
            "counts are bounded integers",
            base,
            [("/counts/segments", "4")],
            "schema_violation",
            "/counts/segments",
        ),
        {
            "name": "at most 64 outputs",
            "input": {
                "repeat": {
                    "document": base,
                    "pointer": "/outputs",
                    "count": 65,
                }
            },
            "expect": {"valid": False, "code": "schema_violation"},
        },
        {
            "name": "receipts are at most 64 KiB",
            "input": {"json": json.dumps(base) + " " * 65536},
            "expect": {"valid": False, "code": "document_too_large"},
        },
        mut(
            "other receipt versions are rejected",
            base,
            [("/schemaVersion", 2)],
            "unsupported_version",
            "/schemaVersion",
        ),
    ]


OWNER = "ctl-1-3f9a8c2b7d41"


def stage_action(state, **extra):
    doc = {
        "action": "record_stage_run",
        "owner": OWNER,
        "stage": "segment",
        "state": state,
        "module": "flora_tempseg_vllm_fp8@1",
    }
    doc.update(extra)
    return doc


def controller_cases():
    inherited = []
    for case in action_cases():
        if not case["expect"]["valid"]:
            continue
        case = copy.deepcopy(case)
        case["name"] = f"v1 action unchanged: {case['name']}"
        inherited.append(case)
    return inherited + [
        ok(
            "issue a stage claim",
            {"action": "issue_stage_claim", "owner": OWNER, "stage": "caption"},
        ),
        ok("record a submitted stage", stage_action("submitting")),
        ok(
            "record a running stage with its call",
            stage_action("running", callId="fc-01HSEG123"),
        ),
        ok(
            "record a succeeded stage with its receipt",
            stage_action("succeeded", callId="fc-01HSEG123", receipt=receipt()),
        ),
        ok(
            "record a failed stage",
            stage_action(
                "failed",
                callId="fc-01HSEG123",
                errorCode="stage_timeout",
                receipt=receipt(status="failed", outputs=[]),
            ),
        ),
        ok(
            "record a disabled stage as not run",
            stage_action("not_run", errorCode="stage_disabled"),
        ),
        bad(
            "succeeded stage requires a receipt",
            stage_action("succeeded", callId="fc-01HSEG123"),
            "outcome_mismatch",
            "/receipt",
        ),
        bad(
            "not_run requires a reason",
            stage_action("not_run"),
            "outcome_mismatch",
            "/errorCode",
        ),
        bad(
            "a running stage has no error",
            stage_action("running", errorCode="stage_timeout"),
            "outcome_mismatch",
            "/errorCode",
        ),
        bad(
            "a running stage has no receipt",
            stage_action("running", receipt=receipt()),
            "outcome_mismatch",
            "/receipt",
        ),
        bad(
            "receipt is for this stage",
            stage_action("succeeded", receipt=receipt("caption", outputs=[])),
            "reference_mismatch",
            "/receipt/stage",
        ),
        bad(
            "receipt status matches the state",
            stage_action("failed", errorCode="stage_timeout", receipt=receipt()),
            "outcome_mismatch",
            "/receipt/status",
        ),
        bad(
            "receipt rules apply inside the action",
            stage_action(
                "succeeded",
                receipt=dict(receipt(), finishedAt="2026-11-22T09:00:00.000Z"),
            ),
            "ordering_violation",
            "/receipt/finishedAt",
        ),
        bad(
            "stage actions are lease-fenced",
            {"action": "issue_stage_claim", "stage": "caption"},
            "schema_violation",
        ),
        bad(
            "unknown stage",
            {"action": "issue_stage_claim", "owner": OWNER, "stage": "trim"},
            "schema_violation",
        ),
        bad(
            "unknown stage state",
            stage_action("done"),
            "schema_violation",
        ),
    ]


HEARTBEAT = {
    "schemaVersion": 2,
    "jobId": U["job"],
    "invocationNonce": "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c",
    "stage": "segment",
    "phase": "segmenting",
    "processedFrames": "1800",
    "totalFrames": "2167",
}


def heartbeat_cases():
    base = HEARTBEAT
    return [
        ok("segmenting heartbeat", base),
        mut("remuxing in a GPU stage", base, [("/phase", "remuxing")], None),
        mut(
            "captioning heartbeat",
            base,
            [("/stage", "caption"), ("/phase", "captioning")],
            None,
        ),
        mut(
            "hand pose uses the v1 phases",
            base,
            [("/stage", "hand_pose"), ("/phase", "inference"), ("/totalFrames", None)],
            None,
        ),
        mut(
            "segmenting only in the segment stage",
            base,
            [("/stage", "caption")],
            "reference_mismatch",
            "/phase",
        ),
        mut(
            "captioning only in the caption stage",
            base,
            [("/phase", "captioning")],
            "reference_mismatch",
            "/phase",
        ),
        mut(
            "stage is required",
            base,
            [("/stage", DELETE)],
            "schema_violation",
        ),
        mut(
            "progress never exceeds the total",
            base,
            [("/processedFrames", "2168")],
            "progress_mismatch",
            "/processedFrames",
        ),
        mut(
            "v1 heartbeats are a different contract",
            base,
            [("/schemaVersion", 1)],
            "unsupported_version",
            "/schemaVersion",
        ),
    ]


# ------------------------------------------------------------------ dag run
def node(stage_name, module, state, **extra):
    doc = {
        "stage": stage_name,
        "enabled": True,
        "module": module,
        "state": state,
        "errorCode": None,
        "callId": None,
        "gpu": {"requestedType": "none", "observedType": None},
        "startedAt": None,
        "finishedAt": None,
        "counts": {},
        "estimatedCostUsd": None,
        "receiptSha256": None,
    }
    doc.update(extra)
    return doc


DAG = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "recordingId": U["recording"],
    "jobState": "succeeded",
    "recipeId": "flora_fp8@1",
    "recipeSha256": cjson_sha256(RECIPE),
    "maxJobCostUsd": "3.00",
    "estimatedCostUsd": "0.41",
    "stages": [
        node(
            "segment",
            "flora_tempseg_vllm_fp8@1",
            "succeeded",
            callId="fc-01HSEG123",
            gpu={
                "requestedType": "RTX-PRO-6000",
                "observedType": "NVIDIA RTX PRO 6000 Blackwell Server Edition",
            },
            startedAt="2026-11-22T10:00:00.000Z",
            finishedAt="2026-11-22T10:03:12.250Z",
            counts={"segments": 4, "failed_windows": 1},
            estimatedCostUsd="0.16",
            receiptSha256=h("receipt-segment"),
        ),
        node(
            "caption",
            "flora_captioner_vllm_fp8@1",
            "failed",
            errorCode="stage_timeout",
            callId="fc-01HCAP456",
            gpu={"requestedType": "RTX-PRO-6000", "observedType": None},
            startedAt="2026-11-22T10:03:13.000Z",
            finishedAt="2026-11-22T10:08:13.000Z",
            estimatedCostUsd="0.25",
        ),
        node(
            "hand_pose",
            "hand_pose_cpu_v1@1",
            "succeeded",
            callId="child-1",
            startedAt="2026-11-22T10:08:14.000Z",
            finishedAt="2026-11-22T10:20:00.000Z",
            counts={"clips": 12},
            receiptSha256=h("receipt-hand"),
        ),
    ],
    "renderedAt": "2026-11-22T10:20:01.000Z",
}


def dag_cases():
    base = DAG
    return [
        ok("run with a failed caption stage shown truthfully", base),
        mut(
            "disabled caption stage is not_run with a reason",
            base,
            [
                (
                    "/stages/1",
                    node(
                        "caption",
                        "flora_captioner_vllm_fp8@1",
                        "not_run",
                        enabled=False,
                        errorCode="stage_disabled",
                    ),
                ),
            ],
            None,
        ),
        mut(
            "running job with pending stages",
            base,
            [
                ("/jobState", "running"),
                ("/estimatedCostUsd", None),
                ("/stages/1", node("caption", "flora_captioner_vllm_fp8@1", "pending")),
                ("/stages/2", node("hand_pose", "hand_pose_cpu_v1@1", "pending")),
            ],
            None,
        ),
        mut(
            "a disabled stage never ran",
            base,
            [("/stages/0/enabled", False)],
            "outcome_mismatch",
            "/stages/0/state",
        ),
        mut(
            "a failed stage names its error",
            base,
            [("/stages/1/errorCode", None)],
            "outcome_mismatch",
            "/stages/1/errorCode",
        ),
        mut(
            "not_run names its reason",
            base,
            [
                (
                    "/stages/1",
                    node(
                        "caption",
                        "flora_captioner_vllm_fp8@1",
                        "not_run",
                        enabled=False,
                    ),
                )
            ],
            "outcome_mismatch",
            "/stages/1/errorCode",
        ),
        mut(
            "succeeded only with a recorded receipt",
            base,
            [("/stages/2/receiptSha256", None)],
            "outcome_mismatch",
            "/stages/2/receiptSha256",
        ),
        mut(
            "stages are in recipe order",
            base,
            [("/stages/0", base["stages"][1]), ("/stages/1", base["stages"][0])],
            "ordering_violation",
            "/stages/0/stage",
        ),
        mut(
            "finished after it started",
            base,
            [("/stages/0/finishedAt", "2026-11-22T09:00:00.000Z")],
            "ordering_violation",
            "/stages/0/finishedAt",
        ),
        mut(
            "one node per stage",
            base,
            [("/stages/3", base["stages"][2])],
            "schema_violation",
            "/stages",
        ),
        mut(
            "cost estimates are decimal strings",
            base,
            [("/stages/0/estimatedCostUsd", 0.16)],
            "schema_violation",
        ),
    ]


def render_sa87():
    cases = {
        "artifacts.segments.v1": segments_cases(),
        "artifacts.captions.v1": captions_cases(),
        "artifacts.hand-presence.v1": hand_cases(),
        "artifacts.processing-result.v3": result_cases(),
        "jobs.recipe.v1": recipe_cases(),
        "jobs.module-manifest.v1": manifest_cases(),
        "jobs.task-input.v3": task_cases(),
        "jobs.controller-action.v2": controller_cases(),
        "jobs.heartbeat.v2": heartbeat_cases(),
        "jobs.stage-receipt.v1": receipt_cases(),
        "http.dag-run.v1": dag_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa87()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-87 fixture files")
