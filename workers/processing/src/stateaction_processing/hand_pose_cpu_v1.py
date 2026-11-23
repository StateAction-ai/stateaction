"""Production worker pipeline `hand_pose_cpu_v1`: decode -> CPU MediaPipe hands -> MP4/NPZ/JSON/RRD.

Loaded by `run_job` ONLY after the physical claim was won; nothing heavy is imported before. It
adds no second pipeline: the work is the SA-31 streaming exporter (`export_artifacts`) writing
through a server-backed `OutputSink`. Authority comes only from the claim: every output is
allocated, uploaded, receipted and completed through the job-scoped output routes, the manifest
cites the SERVER's file ids, the output inventory is closed, and a provisional result candidate
is posted. The server alone verifies and accepts; this worker never selects a result.

Honesty: a source with no hands is a valid result. Unknown capture provenance stays unknown. The
ACTUAL MCAP capture profile must equal the admitted profile or the run fails (never relabelled).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .run_job import _OPENER

EXIT_OK = 0
EXIT_FAILURE_REPORTED = 3
EXIT_UNREPORTED = 70

PART_BYTES = 64 * 1024 * 1024
_RETRIES = 3
_HEARTBEAT_SECONDS = 20.0
_HTTP_TIMEOUT = 120


class ApiError(RuntimeError):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(f"{status}:{code}")
        self.status = status
        self.code = code


def _http(
    method: str,
    url: str,
    token: str | None,
    body: dict[str, Any] | None = None,
    raw: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[dict[str, Any], Any]:
    """One bounded request through the no-redirect opener. Returns (json-or-empty, response headers)."""
    data = (
        raw
        if raw is not None
        else (None if body is None else json.dumps(body).encode())
    )
    request = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    for key, value in (headers or {}).items():
        if key.lower() not in ("host", "content-length"):
            request.add_header(key, value)
    try:
        with _OPENER.open(request, timeout=_HTTP_TIMEOUT) as response:
            payload = response.read(8 * 1024 * 1024)
            parsed: dict[str, Any] = {}
            if payload and token:
                parsed = json.loads(payload)["data"]
            return parsed, response.headers
    except urllib.error.HTTPError as error:
        code = "http_error"
        try:
            code = json.loads(error.read(65536))["error"]["code"]
        except Exception:
            pass
        raise ApiError(error.code, str(code)) from None


class Api:
    def __init__(self, context: dict[str, Any]) -> None:
        self.base = f"{context['apiUrl']}/internal/v1/jobs/{context['jobId']}"
        self.job_id: str = context["jobId"]
        self.nonce: str = context["nonce"]
        self.token: str = context["capability"]
        # Recipe jobs claim the `hand_pose` stage: heartbeats are heartbeat.v2 and name it.
        self.stage: str | None = context.get("stage")

    def call(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        last: Exception | None = None
        for attempt in range(_RETRIES):
            try:
                return _http(method, f"{self.base}/{path}", self.token, body)[0]
            except ApiError as error:
                # 5xx/503 are retryable; 4xx are decisions (forbidden, conflict, invalid).
                if error.status < 500:
                    raise
                last = error
            except (urllib.error.URLError, OSError) as error:
                last = error
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError("api_unavailable") from last

    def heartbeat(self, phase: str, frames: int = 0) -> None:
        body: dict[str, Any] = {
            "schemaVersion": 1 if self.stage is None else 2,
            "jobId": self.job_id,
            "invocationNonce": self.nonce,
            "phase": phase,
            "processedFrames": str(frames),
            "totalFrames": None,
        }
        if self.stage is not None:
            body["stage"] = self.stage
        self.call("POST", "heartbeat", body)


class _Beater(threading.Thread):
    """Progress heartbeats while the long export runs. Never extends a deadline."""

    def __init__(self, api: Api) -> None:
        super().__init__(daemon=True)
        self.api, self.phase, self.frames = api, "hashing_source", 0
        self._stop_event = threading.Event()

    def run(self) -> None:
        while not self._stop_event.wait(_HEARTBEAT_SECONDS):
            try:
                self.api.heartbeat(self.phase, self.frames)
            except Exception:
                pass  # a lost heartbeat is not a decision; output calls fail closed on their own

    def stop(self) -> None:
        self._stop_event.set()


def _etag(headers: Any) -> str:
    value = headers.get("ETag") or headers.get("etag") or ""
    return str(value).strip('"')


class ServerOutputSink:
    """`OutputSink` over the job output routes: server-chosen file ids, intended slots only."""

    def __init__(self, api: Api, beater: _Beater | None = None) -> None:
        self.api, self.beater = api, beater
        self.receipts: dict[str, Any] = {}

    def _upload(self, out: Any) -> Any:
        from .artifact_types import OutputReceipt

        plan = self.api.call(
            "POST",
            "outputs",
            {
                "slot": out.relative_path,
                "role": out.role,
                "sizeBytes": str(out.size_bytes),
                "sha256": out.sha256,
            },
        )
        file_id, epoch = plan["fileId"], plan["transportEpoch"]
        if (plan["role"], int(plan["sizeBytes"]), plan["sha256"]) != (
            out.role,
            out.size_bytes,
            out.sha256,
        ):
            raise RuntimeError("output_plan_mismatch")
        if plan["state"] not in ("completed", "verified"):
            if self.beater:
                self.beater.phase = "uploading"
            self._send_parts(out, file_id, epoch, int(plan["partCount"]))
            done = self.api.call(
                "POST",
                f"outputs/{file_id}/complete",
                {"expectedTransportEpoch": epoch},
            )
            if done["state"] not in ("completed", "verified"):
                done = self.api.call(
                    "POST",
                    f"outputs/{file_id}/reconcile",
                    {"expectedTransportEpoch": epoch},
                )
            if done["state"] not in ("completed", "verified"):
                raise RuntimeError("output_not_completed")
        return OutputReceipt(file_id, out.role, out.size_bytes, out.sha256)

    def _send_parts(self, out: Any, file_id: str, epoch: int, count: int) -> None:
        numbers = list(range(1, count + 1))
        with out.path.open("rb") as handle:
            for start in range(0, len(numbers), 32):
                batch = numbers[start : start + 32]
                signed = self.api.call(
                    "POST",
                    f"outputs/{file_id}/parts/sign",
                    {"expectedTransportEpoch": epoch, "partNumbers": batch},
                )
                receipts = []
                for part in signed["parts"]:
                    handle.seek(int(part["offsetBytes"]))
                    chunk = handle.read(int(part["lengthBytes"]))
                    if len(chunk) != int(part["lengthBytes"]):
                        raise RuntimeError("short_read")
                    _, headers = _http(
                        "PUT", part["url"], None, raw=chunk, headers=part["headers"]
                    )
                    receipts.append(
                        {
                            "partNumber": part["partNumber"],
                            "etag": _etag(headers),
                            "sizeBytes": str(len(chunk)),
                        }
                    )
                self.api.call(
                    "PUT",
                    f"outputs/{file_id}/parts/receipts",
                    {"expectedTransportEpoch": epoch, "receipts": receipts},
                )

    def put(self, out: Any) -> Any:
        receipt = self._upload(out)
        self.receipts[out.relative_path] = receipt
        return receipt

    def seal(self, manifest: Any) -> Any:
        if self.beater:
            self.beater.phase = "sealing"
        receipt = self._upload(manifest)
        self.receipts[manifest.relative_path] = receipt
        return receipt

    def abort(self, reason: str) -> None:
        # Uploaded objects cannot be deleted by a worker. They stay in the inventory (retained for
        # diagnostics) and are never accepted: the failed outcome is reported instead.
        return None


def _snake_simulation(sim: dict[str, Any] | None) -> dict[str, Any] | None:
    """Admitted camelCase task-input marker -> the artifact (snake_case) form; same facts."""
    if sim is None:
        return None
    return {
        "schema": sim["schema"],
        "qualification": sim["qualification"],
        "mapped_timeline_semantics": sim["mappedTimelineSemantics"],
        "production_qualified": sim["productionQualified"],
        "provenance": sim["provenance"],
    }


_RUNTIME_REASONS = frozenset(
    {"api_unavailable", "output_plan_mismatch", "output_not_completed", "short_read"}
)


def _error_code(error: BaseException) -> str:
    code = str(getattr(error, "code", None) or type(error).__name__)
    # The worker's own bare RuntimeError reasons are reported by that reason, not by class name.
    if code == "RuntimeError" and str(error) in _RUNTIME_REASONS:
        code = str(error)
    code = code.lower().removeprefix("e_")
    out = "".join(c if c.isalnum() else "_" for c in code)[:60].strip("_")
    return out if out and out[0].isalpha() else "worker_error"


def _check_counts(checks: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"pass": 0, "warn": 0, "fail": 0, "measured": 0, "notEvaluated": 0}
    for check in checks:
        status = check["status"]
        counts["notEvaluated" if status == "not_evaluated" else status] += 1
    return counts


_DIAG_STAGES = {
    "inference": "while decoding and inferring frames",
    "source_verification": "at the final whole-source verification",
    "manifest": "while building the result manifest",
}
_DIAG_COUNTS = (
    "source_bytes_read",
    "video_messages",
    "frames_decoded",
    "frames_inferred",
    "clips_written",
    "files_put",
)


_INT64_MAX = 2**63 - 1


def _failure_evidence(
    error: BaseException | None, uploaded: int
) -> tuple[str, dict[str, str], bool]:
    """Curated stage message, int64-decimal counters and the proven-source flag.

    Only allowlisted stage and count names are read; exception text, paths and payloads are never
    copied. A count that is not an int in [0, int64 max] is omitted, never clamped (a clamped
    value would be an invented measurement). `files_uploaded` is what the server-backed sink
    actually stored before the failure. The source counts as verified only when the exporter set
    its boolean at the proven EOF/hash gate, the stage is `manifest` and the byte count is present.
    """
    diag = getattr(error, "diagnostics", None)
    stage = diag.get("stage") if isinstance(diag, dict) else None
    counts = diag.get("counts") if isinstance(diag, dict) else None
    measurements: dict[str, str] = {}
    if isinstance(counts, dict):
        for name in _DIAG_COUNTS:
            value = counts.get(name)
            if (
                isinstance(value, int)
                and not isinstance(value, bool)
                and 0 <= value <= _INT64_MAX
            ):
                measurements[name] = str(value)
    measurements["files_uploaded"] = str(max(0, int(uploaded)))
    verified = (
        isinstance(diag, dict)
        and diag.get("source_verified") is True
        and stage == "manifest"
        and measurements.get("source_bytes_read", "0") != "0"
    )
    where = _DIAG_STAGES.get(stage if isinstance(stage, str) else "")
    message = (
        f"Processing failed {where}; no accepted result exists."
        if where
        else "Processing failed before a complete verified result existed."
    )
    return message, measurements, verified


def _failure_manifest(
    grant: dict[str, Any],
    task: dict[str, Any],
    nonce: str,
    code: str,
    error: BaseException | None = None,
    uploaded: int = 0,
) -> bytes:
    from .artifact_types import RULE_REVISION

    message, measurements, verified = _failure_evidence(error, uploaded)

    digests = grant["digests"]
    source = next(i for i in grant["inputs"] if i["role"] == "source_mcap")
    # The bytes actually read must equal the granted MCAP size when the grant states one.
    verified = (
        verified
        and str(source.get("sizeBytes", measurements["source_bytes_read"]))
        == (measurements["source_bytes_read"])
    )

    def check(
        name: str, status: str, text: str, meas: dict[str, str]
    ) -> dict[str, Any]:
        return {
            "code": name,
            "status": status,
            "message": text,
            "rule_revision": RULE_REVISION,
            "measurements": meas,
        }

    if verified:
        # Attest only the MCAP named by source_file_id, matching successful exports.
        # Other inputs are not claimed as verified; the failed candidate accepts no clips.
        source_check = check(
            "source_accepted",
            "pass",
            "The source MCAP alone was verified to footer, CRC, SHA-256 and Close before the "
            "failure; the candidate still failed and no result is accepted.",
            {
                k: measurements[k]
                for k in ("source_bytes_read", "video_messages", "frames_decoded")
                if k in measurements
            },
        )
    else:
        source_check = check(
            "source_accepted",
            "not_evaluated",
            "Not evaluated: processing failed before the source was verified.",
            {},
        )
    doc: dict[str, Any] = {
        "schema": "stateaction.processing_result.v2",
        "job_id": grant["jobId"],
        "recording_id": task["targetId"],
        "source_manifest_sha256": digests["sourceManifestSha256"],
        "provenance": {
            "code_revision": digests["codeRevision"],
            "image_spec_sha256": digests["imageSpecSha256"],
            "config_sha256": digests["configSha256"],
            "profile_revision": task["profileRevision"],
            "model": {
                "name": "mediapipe_hand_landmarker",
                "asset_sha256": digests["modelSha256"],
                "license": "Apache-2.0",
            },
            "rerun_sdk_version": "0.41.0",
        },
        "verified_sources": (
            [
                {
                    "file_id": source["fileId"],
                    "size_bytes": measurements["source_bytes_read"],
                    "sha256": source["sha256"],
                }
            ]
            if verified
            else []
        ),
        "outputs": [],
        "clips": [],
        "checks": [
            check(code, "fail", message, measurements),
            source_check,
            # No complete detection summary was finalized for a failed candidate.
            check(
                "hand_detection_summary",
                "not_evaluated",
                "Not evaluated: no complete detection summary was finalized.",
                {},
            ),
        ],
        "metric_accuracy_validated": False,
        "limitations": [
            "Failure report: no clip is produced and nothing in this result is a hand-pose measurement."
        ],
        "attestation": {
            "invocation_nonce": nonce,
            "rgb_profile": task["rgbProfile"],
            "source_file_id": source["fileId"],
            "source_eof_verified": verified,
        },
    }
    sim = _snake_simulation(task.get("simulation"))
    if sim is not None:
        doc["simulation"] = sim
    return json.dumps(
        doc, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def _report(
    api: Api,
    sink: ServerOutputSink,
    manifest_receipt: Any,
    outcome: str,
    clip_count: int,
    checks: list[dict[str, Any]],
    error_code: str | None,
) -> None:
    api.call(
        "POST",
        "outputs/close",
        {
            "schemaVersion": 1,
            "jobId": api.job_id,
            "invocationNonce": api.nonce,
            "outcome": outcome,
        },
    )
    api.call(
        "POST",
        "result",
        {
            "schemaVersion": 1,
            "jobId": api.job_id,
            "invocationNonce": api.nonce,
            "manifestFileId": manifest_receipt.file_id,
            "manifestSha256": manifest_receipt.sha256,
            "summary": {
                "outcome": outcome,
                "clipCount": clip_count,
                "checks": _check_counts(checks),
                "errorCode": error_code,
            },
        },
    )


MAX_DOCUMENT_BYTES = 32 * 1024 * 1024


def _document_reader(api: Api) -> Any:
    """Bounded read of an earlier stage's annotation file for the consistency check.

    Best effort: any refusal (the job routes let only the caption stage read job outputs), size
    overrun or digest mismatch returns None, which makes that check `not_evaluated`, never `pass`.
    """

    def read(out: Any) -> bytes | None:
        try:
            plan = api.call("POST", f"outputs/{out.file_id}/read", {})
            request = urllib.request.Request(plan["readUrl"], method="GET")
            with _OPENER.open(request, timeout=_HTTP_TIMEOUT) as response:
                data: bytes = response.read(MAX_DOCUMENT_BYTES + 1)
        except Exception:
            return None
        if (
            len(data) > MAX_DOCUMENT_BYTES
            or len(data) != out.size_bytes
            or hashlib.sha256(data).hexdigest() != out.sha256
        ):
            return None
        return data

    return read


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _print_stage_receipt(
    grant: dict[str, Any],
    context: dict[str, Any],
    outcome: dict[str, Any],
    started: str,
) -> None:
    """`jobs.stage-receipt.v1` as the last stdout line (sorted, compact, flushed).

    Lists only recording.mp4 and hand-presence.json (the receipt caps outputs at 64; a long
    recording has far more clip files, which the hand_pose node lists through the inventory).
    A failed stage lists no output. Nothing may be printed after this line.
    """
    import sys

    from stateaction_contracts import validate_value

    receipt: dict[str, Any] = {
        "schemaVersion": 1,
        "jobId": grant["jobId"],
        "stage": "hand_pose",
        "module": context["module"],
        "status": outcome["status"],
        "errorCode": outcome["code"],
        "outputs": outcome.get("outputs", []),
        "counts": outcome.get("counts", {}),
        "gpu": {"requestedType": "none", "observedType": None},
        "startedAt": started,
        "finishedAt": _utc_now(),
    }
    if not validate_value("jobs.stage-receipt.v1", receipt).valid:
        receipt.update(
            status="failed", errorCode="receipt_invalid", outputs=[], counts={}
        )
    sys.stdout.write(
        json.dumps(receipt, sort_keys=True, separators=(",", ":"), allow_nan=False)
        + "\n"
    )
    sys.stdout.flush()


def _probe_call(metrics: Any, method: str, *args: Any) -> None:
    """SA-45 resource facts are best-effort and can never change the processing result."""
    try:
        getattr(metrics, method)(*args)
    except Exception:
        return


def run(grant: dict[str, Any], context: dict[str, Any]) -> int:
    started = _utc_now()
    # Recipe jobs: the outcome of this stage is printed as a stage receipt, the LAST stdout line.
    outcome: dict[str, Any] | None = (
        {"status": "failed", "code": "worker_error"}
        if context.get("stage") is not None
        else None
    )
    if outcome is not None:
        context = {**context, "_outcome": outcome}
    code = _run(grant, context)
    if outcome is not None:
        _print_stage_receipt(grant, context, outcome, started)
    return code


def _run(grant: dict[str, Any], context: dict[str, Any]) -> int:
    api = Api(context)
    scratch = Path(tempfile.mkdtemp(prefix="sa28-worker-"))
    metrics = context.get("metrics")
    if metrics is not None:
        _probe_call(metrics, "register_scratch", scratch)
    beater = _Beater(api)
    beater.start()
    sink = ServerOutputSink(api, beater)
    task: dict[str, Any] | None = None
    try:
        api.heartbeat("hashing_source")
        task = api.call("GET", "task-input")
        return _process(api, sink, beater, grant, task, scratch, context)
    except Exception as error:
        if task is None:
            if "_outcome" in context:
                context["_outcome"]["code"] = _error_code(error)
            print(f"Worker failed before task input: {type(error).__name__}")
            return EXIT_UNREPORTED
        if "_outcome" in context:
            context["_outcome"]["code"] = _error_code(error)
        return _fail(api, sink, grant, task, error, scratch)
    finally:
        beater.stop()
        if metrics is not None:
            _probe_call(metrics, "sample_now")
        shutil.rmtree(scratch, ignore_errors=True)


def _check_runtime_identity(digests: dict[str, Any], context: dict[str, Any]) -> None:
    """Modal only: the baked build identity must equal what the server admitted, BEFORE any source read.

    The code revision and the build-spec digest are baked into the image environment at deploy time
    (the build-spec digest is NOT a Modal image ID). The ACTUAL model bytes are hash-verified here,
    not only the pin. A local run keeps its existing behaviour (no baked identity to compare).
    """
    if context.get("executorKind") != "modal":
        return
    from . import hand_model
    from .artifact_types import ExportError

    for name, key in (
        ("STATEACTION_CODE_REVISION", "codeRevision"),
        ("STATEACTION_IMAGE_SPEC_SHA256", "imageSpecSha256"),
    ):
        baked = os.environ.get(name)
        if not baked or baked != digests[key]:
            raise ExportError("E_RUNTIME_IDENTITY_MISMATCH")
    if hand_model.resolve_model().sha256 != digests["modelSha256"]:
        raise ExportError("E_MODEL_DIGEST_MISMATCH")


def _process(
    api: Api,
    sink: ServerOutputSink,
    beater: _Beater,
    grant: dict[str, Any],
    task: dict[str, Any],
    scratch: Path,
    context: dict[str, Any] | None = None,
) -> int:
    from . import hand_model
    from .artifact_export import config_sha256, export_artifacts
    from .artifact_types import Attestation, ExportContext, ExportError, ExportLimits
    from .capture_stream import StreamLimits

    digests = grant["digests"]
    limits, stream_limits = ExportLimits(), StreamLimits()
    # Identity the server will compare against: refuse to run a different build or config.
    if config_sha256(limits, stream_limits) != digests["configSha256"]:
        raise ExportError("E_CONFIG_DIGEST_MISMATCH")
    if hand_model.PINS["sha256"] != digests["modelSha256"]:
        raise ExportError("E_MODEL_DIGEST_MISMATCH")
    _check_runtime_identity(digests, context or {})
    inputs = {i["role"]: i for i in grant["inputs"]}
    mcaps = [i for i in grant["inputs"] if i["role"] == "source_mcap"]
    if len(mcaps) != 1 or "source_manifest" not in inputs:
        raise ExportError("E_GRANT_INVENTORY")
    mcap = mcaps[0]
    if task["sourceManifestSha256"] != digests["sourceManifestSha256"]:
        raise ExportError("E_TASK_INPUT_MISMATCH")
    ctx = ExportContext(
        job_id=grant["jobId"],
        source_manifest_sha256=digests["sourceManifestSha256"],
        code_revision=digests["codeRevision"],
        image_spec_sha256=digests["imageSpecSha256"],
        profile_revision=task["profileRevision"],
        recording_id=task["targetId"],
        source_file_id=mcap["fileId"],
        expected_source_sha256=mcap["sha256"],
        forbidden_strings=(str(scratch),),
        attestation=Attestation(
            invocation_nonce=api.nonce,
            rgb_profile=task["rgbProfile"],
            simulation=_snake_simulation(task.get("simulation")),
        ),
    )
    extra: dict[str, Any] = {}
    if (context or {}).get("stage") is not None:
        # Recipe job: this stage seals it (review video, hand presence, processing-result.v3).
        from .artifact_seal import plan_from_task

        extra["seal"] = plan_from_task(
            task, context or {}, grant["jobId"], _document_reader(api)
        )
    request = urllib.request.Request(mcap["readUrl"], method="GET")
    beater.phase = "decoding"
    with _OPENER.open(request, timeout=_HTTP_TIMEOUT) as source:
        result = export_artifacts(
            source,
            sink,
            ctx,
            limits=limits,
            stream_limits=stream_limits,
            scratch_dir=scratch / "export",
            on_clip_closed=lambda meta: setattr(
                beater, "frames", beater.frames + int(meta["frame_count"])
            ),
            **extra,
        )
    beater.phase = "sealing"
    manifest_receipt = result.manifest_receipt
    _report(
        api,
        sink,
        manifest_receipt,
        "succeeded",
        len(result.clips),
        result.manifest["checks"],
        None,
    )
    if "_outcome" in (context or {}):
        keep = ("recording.mp4", "hand-presence.json")
        (context or {})["_outcome"].update(
            status="succeeded",
            code=None,
            outputs=[
                {
                    "fileId": result.receipts[slot].file_id,
                    "role": result.receipts[slot].role,
                    "sizeBytes": str(result.receipts[slot].size_bytes),
                    "sha256": result.receipts[slot].sha256,
                }
                for slot in keep
            ],
            counts={"frames": result.frames, "clips": len(result.clips)},
        )
    return EXIT_OK


def _fail(
    api: Api,
    sink: ServerOutputSink,
    grant: dict[str, Any],
    task: dict[str, Any],
    error: BaseException,
    scratch: Path,
) -> int:
    """Upload a diagnostic manifest and report a failed candidate; never fabricate a result."""
    from .artifact_types import make_output

    code = _error_code(error)
    print(f"Worker failed: {code}")
    from .libav_retry import LibavTransientError

    if isinstance(error, LibavTransientError):
        # Allowlisted libav diagnostic for the worker log; the curated manifest copies no text.
        print(
            f"Worker libav detail: {error.what}, {error.attempts} attempts, {error.message}"
        )
    try:
        data = _failure_manifest(
            grant, task, api.nonce, code, error, len(sink.receipts)
        )
        path = scratch / "result-manifest.json"
        path.write_bytes(data)
        out = make_output("result_manifest", "result-manifest.json", path, None)
        receipt = sink.seal(out)
        checks = json.loads(data)["checks"]
        _report(api, sink, receipt, "failed", 0, checks, code)
        return EXIT_FAILURE_REPORTED
    except Exception as report_error:
        print(f"Worker could not report failure: {type(report_error).__name__}")
        return EXIT_UNREPORTED
