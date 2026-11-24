"""Shared fixtures for stage reruns, result selection and retained artifacts."""

import json
from copy import deepcopy
from hashlib import sha256

from generate_fixtures import DELETE, OUT, U, dump, mut, ok


def render_sa142(existing):
    files = {}

    def first_valid(contract):
        cases = json.loads(existing[OUT / "contracts" / f"{contract}.json"])["cases"]
        return next(
            case["input"]["document"] for case in cases if case["expect"]["valid"]
        )

    def emit(contract, *cases):
        files[OUT / "contracts" / f"{contract}.json"] = dump(
            {"contract": contract, "cases": cases}
        )

    parent, child = U["prev_job"], U["job"]
    sha = "a" * 64
    when = "2026-11-24T02:00:00Z"
    plan_input = {"parentJobId": parent, "stage": "hand_pose", "scope": "only"}
    emit(
        "http.stage-rerun-plan-request.v1",
        ok("CPU-only stage", plan_input),
        mut("explicit scope", plan_input, [("/scope", "all")], "schema_violation"),
    )
    command = {
        **plan_input,
        "requestId": child,
        "expectedPlanSha256": sha,
        "expectedMaxGpuCostUsd": "0.00",
        "reason": "Verify improved hand pose",
    }
    emit(
        "http.stage-rerun-command.v1",
        ok("confirmed plan", command),
        mut(
            "missing request identity",
            command,
            [("/requestId", DELETE)],
            "schema_violation",
        ),
    )
    replay = {"jobId": child, "parentJobId": parent, "replayed": True}
    emit(
        "http.stage-rerun-result.v1",
        ok("exact replay", replay),
        mut(
            "missing replay marker", replay, [("/replayed", DELETE)], "schema_violation"
        ),
    )
    selection = {
        "jobId": parent,
        "expectedSelectionSeq": 0,
        "reason": "Select the earlier result",
    }
    emit(
        "http.recording-result-selection-command.v1",
        ok("first result selection", selection),
        mut(
            "negative sequence",
            selection,
            [("/expectedSelectionSeq", -1)],
            "schema_violation",
        ),
    )
    prepare = {"owner": "lease-fixture-owner"}
    emit(
        "jobs.rerun-preparation-command.v1",
        ok("lease owner", prepare),
        mut("missing lease owner", prepare, [("/owner", DELETE)], "schema_violation"),
    )
    binding = {
        "functionId": "fu-verified",
        "definitionId": "fd-revision",
        "gpu": "none",
        "maxBilledSeconds": 1100,
        "maxContainers": 1,
        "maxCpuMilli": 4000,
        "maxMemoryMib": 8192,
        "microUsdPerGpuSecond": 0,
        "microUsdPerCpuSecond": 211,
        "environment": "main",
        "appName": "stateaction-hand-pose-cpu-v1-36a4b3eadfbc98ad4820eaca",
        "codeRevision": "1" * 40,
        "paramsSha256": sha256(b"{}").hexdigest(),
        "definitionSha256": "2" * 64,
    }
    worker_receipt = first_valid("jobs.stage-receipt.v1")
    worker_digest = sha256(
        json.dumps(
            worker_receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()
    evidence_keys = (
        "functionId",
        "definitionId",
        "environment",
        "appName",
        "codeRevision",
        "paramsSha256",
        "definitionSha256",
    )
    evidence = {key: binding[key] for key in evidence_keys}
    receipt = {
        **worker_receipt,
        "schemaVersion": 2,
        "providerBinding": {**evidence, "workerReceiptSha256": worker_digest},
    }
    emit(
        "jobs.stage-receipt.v2",
        ok("provider evidence alongside the original worker receipt", receipt),
        mut(
            "missing definition digest",
            receipt,
            [("/providerBinding/definitionSha256", DELETE)],
            "schema_violation",
        ),
    )
    action = {
        "action": "record_stage_run",
        "owner": "verified-stage-owner",
        "stage": receipt["stage"],
        "module": receipt["module"],
        "state": receipt["status"],
        "callId": "fc-Approved",
        "receipt": receipt,
        **({"errorCode": receipt["errorCode"]} if receipt["errorCode"] else {}),
    }
    emit(
        "jobs.controller-action.v4",
        ok("record an inspected Modal stage", action),
        mut(
            "bound receipt needs a provider call",
            action,
            [("/callId", DELETE)],
            "schema_violation",
        ),
    )
    ready = {
        "state": "ready",
        "execute": ["hand_pose"],
        "functions": {"handPose": binding},
    }
    emit(
        "jobs.rerun-preparation.v1",
        ok("bound CPU rerun", ready),
        mut(
            "function ID only",
            ready,
            [("/functions/handPose", "fu-verified")],
            "schema_violation",
        ),
    )
    stage = {
        "stage": "hand_pose",
        "enabled": True,
        "module": "hand_pose_cpu_v1@1",
        "params": {},
        "resources": {
            "gpu": "none",
            "budgetSeconds": 1100,
            "maxContainers": 1,
            "retries": 0,
        },
    }
    imported = {
        "stage": "segment",
        "state": "succeeded",
        "sourceJobId": parent,
        "executionJobId": None,
        "receiptSha256": None,
        "errorCode": None,
        "importJobId": parent,
        "importManifestSha256": sha,
    }
    preview = {
        "planSha256": sha,
        "execute": [stage],
        "reuse": [{**imported, "copyBytes": "4096"}],
        "maxGpuCostUsd": "0.00",
        "maxComputeCostUsd": "0.27",
        "estimatedComputeCostUsd": None,
        "estimatedSeconds": None,
    }
    emit(
        "http.stage-rerun-plan.v1",
        ok("imported segmentation and the CPU cap", preview),
        mut(
            "missing compute cap",
            preview,
            [("/maxComputeCostUsd", DELETE)],
            "schema_violation",
        ),
    )
    read = {
        "fileId": U["out_mp4"],
        "readUrl": "https://store.example.test/segments.json",
        "expiresAt": when,
        "producerJobId": parent,
    }
    emit(
        "jobs.stage-input-read.v1",
        ok("child reads original producer bytes", read),
        mut(
            "missing producer identity",
            read,
            [("/producerJobId", DELETE)],
            "schema_violation",
        ),
    )
    dag = first_valid("http.dag-run.v1")
    dag.update(
        schemaVersion=2,
        derivedFromJobId=parent,
        execute=["hand_pose"],
        reuse=[{**imported, "receipt": None, "importedCounts": {"segments": 5}}],
    )
    emit(
        "http.dag-run.v2",
        ok("derived DAG with import origin", dag),
        mut("missing lineage", dag, [("/reuse", DELETE)], "schema_violation"),
    )
    annotations = first_valid("http.recording-annotations.v1")
    producer_job = annotations["job_id"]
    annotations["job_id"] = U["request"]
    annotations["schema"] = "stateaction.recording-annotations.v3"
    annotations["producer_jobs"] = {
        part: producer_job if annotations[part] is not None else None
        for part in ("segments", "captions", "hand_presence")
    }
    annotations["dag_run"].update(
        schemaVersion=2,
        jobId=U["request"],
        derivedFromJobId=producer_job,
        execute=["hand_pose"],
        reuse=[],
    )
    emit(
        "http.recording-annotations.v3",
        ok("unchanged producer artifacts in a derived result", annotations),
        mut(
            "segments name a different producer",
            annotations,
            [("/producer_jobs/segments", U["request"])],
            "reference_mismatch",
            "/segments/job_id",
        ),
    )
    marks = deepcopy(first_valid("http.segment-marks.v1"))
    for mark in marks["marks"]:
        mark.update(originJobId=parent, originRevision=mark["revision"], revision=0)
    emit(
        "http.segment-marks.v2",
        ok("inherited mark includes the marking run", marks),
        mut(
            "missing marking run",
            marks,
            [("/marks/0/originJobId", DELETE)],
            "schema_violation",
        ),
    )
    result = first_valid("artifacts.processing-result.v3")
    result["schema"] = "stateaction.processing_result.v4"
    result["reused_hand"] = {
        "job_id": parent,
        "manifest_sha256": sha,
        "clips": [
            {"clip_id": clip["clip_id"], "original_clip_id": U["request"]}
            for clip in result["clips"]
        ],
    }
    emit(
        "artifacts.processing-result.v4",
        ok("sealing accepted hand output in a derived result", result),
        mut(
            "missing hand origin",
            result,
            [("/reused_hand", DELETE)],
            "schema_violation",
        ),
    )
    return files
