"""`python -m stateaction_processing run-stage <execution_ref>`: one recipe stage under a stage claim.

Order, with nothing heavy before the claim is won:

1. read the stage bootstrap (stdin, <= 8 KiB; the capability never touches argv/env/logs) and resolve
   the module from the registry as DATA only (unknown, unregistered and `localOnly`-outside-local
   modules are refused before any claim);
2. claim with the stage-scoped bootstrap (the same `/claim` route, `claimStage` server side);
3. only then import the module, read the task input (recipe digest and stage/module must match the
   bootstrap), fetch the source and remux it natively to MP4 with a frame map (`stage_media`);
4. run the module, validate its document with the shared contract, upload it plus bounded
   diagnostics, and return a `jobs.stage-receipt.v1`.

A module that cannot produce a truthful document ends the stage `failed` with an `errorCode`; the
failed windows or captions INSIDE a produced document are data, recorded as failed rows, never empty.
`--io-dir DIR` is the file-backed mode (no HTTP, no claim): `DIR/bootstrap.json` carries the stage
bootstrap plus the v3 `taskInput`, `DIR/source.mcap` the source and, for caption, `DIR/segments.json`
the segments. Outputs, `receipt.json`, `heartbeats.jsonl` and `log.txt` are written into DIR. It is
allowed only with APP_ENV=local or STATEACTION_IO_DIR_HARNESS=1.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

from .run_job import (
    _CALL_ID,
    _ISOLATION_FD,
    _OPENER,
    _REF,
    _TOKEN,
    EXIT_CLAIM_LOST,
    EXIT_INTERNAL,
    EXIT_PIPELINE_UNAVAILABLE,
    WorkerExit,
    _post,
    _strict_origin,
    enforce_single_process,
)

EXIT_OK = 0
EXIT_FAILED_REPORTED = 3
BOOTSTRAP_VERSION = 2
STAGES = ("segment", "caption")
MAX_BOOTSTRAP_BYTES = 8192
MAX_SEGMENTS_BYTES = 32 * 1024 * 1024
MAX_DIAGNOSTIC_BYTES = 64 * 1024 * 1024
MAX_LOG_BYTES = 1024 * 1024
_MODULE_REF = re.compile(r"^[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,5}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_COMMON = {"schemaVersion", "jobId", "executionRef", "stage", "module", "recipeSha256"}
_HTTP_KEYS = _COMMON | {
    "apiUrl",
    "bootstrapToken",
    "executorKind",
    "segmentsFileId",
    "segmentsSha256",
}
_DIR_KEYS = _COMMON | {"taskInput", "segmentsSha256"}
_ROLE = {"segment": "segments_json", "caption": "captions_json"}
_DOCUMENT = {"segment": "segments.json", "caption": "captions.json"}
_CONTRACT = {"segment": "artifacts.segments.v1", "caption": "artifacts.captions.v1"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _uuid(value: object) -> str:
    text = str(uuid.UUID(str(value)))
    if text != value:
        raise ValueError("uuid")
    return text


def parse_bootstrap(
    raw: dict[str, Any], *, file_mode: bool, execution_ref: str
) -> dict[str, Any]:
    """Strictly validate a stage bootstrap. Raises `WorkerExit(EXIT_INTERNAL, 'InvalidBootstrap')`."""
    try:
        if not isinstance(raw, dict) or not set(raw) <= (
            _DIR_KEYS if file_mode else _HTTP_KEYS
        ):
            raise ValueError("shape")
        if raw["schemaVersion"] != BOOTSTRAP_VERSION:
            raise ValueError("version")
        _uuid(raw["jobId"])
        if raw["stage"] not in STAGES:
            raise ValueError("stage")
        if not _MODULE_REF.match(raw["module"]) or not _SHA.match(raw["recipeSha256"]):
            raise ValueError("module")
        if raw["executionRef"] != execution_ref or not _REF.match(execution_ref):
            raise ValueError("ref")
        digest, file_id = raw.get("segmentsSha256"), raw.get("segmentsFileId")
        if raw["stage"] == "caption":
            if not isinstance(digest, str) or not _SHA.match(digest):
                raise ValueError("segments")
            if not file_mode:
                _uuid(file_id)
        elif digest is not None or file_id is not None:
            raise ValueError("segments")
        if file_mode:
            if not isinstance(raw.get("taskInput"), dict):
                raise ValueError("task")
            return dict(raw)
        if not _TOKEN.match(raw["bootstrapToken"]):
            raise ValueError("token")
        kind = raw.setdefault("executorKind", "local")
        if kind not in ("local", "modal") or (kind == "modal") != bool(
            _CALL_ID.match(execution_ref)
        ):
            raise ValueError("executor")
        raw["apiUrl"] = _strict_origin(raw["apiUrl"])
        if kind == "modal" and (
            not raw["apiUrl"].startswith("https://")
            or raw["apiUrl"].split("//", 1)[1].split(":")[0]
            in ("127.0.0.1", "localhost", "[::1]")
        ):
            raise ValueError("modal_bootstrap")
        return dict(raw)
    except (ValueError, KeyError, TypeError) as error:
        raise WorkerExit(EXIT_INTERNAL, "InvalidBootstrap") from error


class StageFailure(RuntimeError):
    """A stage-level failure with a stable `errorCode` (no paths, URLs or payloads)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def error_code(error: BaseException) -> str:
    """Stable `errorCode` from an exception's `code` attribute (`E_FOO` -> `foo`), else generic."""
    code = getattr(error, "code", None)
    if isinstance(code, str):
        text = re.sub(r"[^a-z0-9_]+", "_", code.lower().removeprefix("e_")).strip("_")[
            :64
        ]
        if re.match(r"^[a-z][a-z0-9_]{0,63}$", text):
            return text
    return "internal_error"


# ---------------------------------------------------------------------------- IO backends


class _HttpIo:
    def __init__(self, boot: dict[str, Any], grant: dict[str, Any], nonce: str) -> None:
        from .hand_pose_cpu_v1 import Api, ServerOutputSink, _Beater

        from_api = Api(
            {
                "apiUrl": boot["apiUrl"],
                "jobId": boot["jobId"],
                "nonce": nonce,
                "capability": grant["capability"]["token"],
            }
        )
        stage = boot["stage"]

        def heartbeat(phase: str, frames: int = 0) -> None:
            from_api.call(
                "POST",
                "heartbeat",
                {
                    "schemaVersion": 2,
                    "jobId": from_api.job_id,
                    "invocationNonce": nonce,
                    "stage": stage,
                    "phase": phase,
                    "processedFrames": str(frames),
                    "totalFrames": None,
                },
            )

        self.api, self.boot, self.grant = from_api, boot, grant
        self.heartbeat = heartbeat
        self.beater = _Beater(_Shim(heartbeat))  # type: ignore[arg-type]
        self.sink = ServerOutputSink(from_api, self.beater)

    def start(self) -> None:
        self.beater.start()

    def stop(self) -> None:
        self.beater.stop()

    def task_input(self) -> dict[str, Any]:
        task = self.api.call("GET", "task-input")
        if (
            task.get("sourceManifestSha256")
            != self.grant["digests"]["sourceManifestSha256"]
        ):
            raise StageFailure("task_source_mismatch")
        return task

    def source(self) -> tuple[BinaryIO, str | None]:
        mcaps = [i for i in self.grant["inputs"] if i["role"] == "source_mcap"]
        if len(mcaps) != 1:
            raise StageFailure("grant_inventory")
        request = urllib.request.Request(mcaps[0]["readUrl"], method="GET")
        return _OPENER.open(request, timeout=120), mcaps[0]["sha256"]

    def segments_bytes(self) -> bytes:
        file_id = self.boot["segmentsFileId"]
        plan = self.api.call("POST", f"outputs/{file_id}/read", {})
        if plan.get("fileId") != file_id:
            raise StageFailure("segments_file_mismatch")
        request = urllib.request.Request(plan["readUrl"], method="GET")
        with _OPENER.open(request, timeout=120) as response:
            data: bytes = response.read(MAX_SEGMENTS_BYTES + 1)
        if len(data) > MAX_SEGMENTS_BYTES:
            raise StageFailure("segments_too_large")
        return data

    def put(self, out: Any) -> Any:
        return self.sink.put(out)

    def beat(self, phase: str, frames: int) -> None:
        changed = phase != self.beater.phase
        self.beater.phase, self.beater.frames = phase, frames
        if changed:
            try:
                self.heartbeat(phase, frames)
            except Exception:
                pass

    def finish(self, receipt: dict[str, Any], log: bytes) -> None:
        return None


class _Shim:
    """`_Beater` calls `api.heartbeat(phase, frames)`; bind it to the heartbeat.v2 sender."""

    def __init__(self, send: Any) -> None:
        self.heartbeat = send


class _DirIo:
    def __init__(self, directory: Path, boot: dict[str, Any]) -> None:
        self.dir, self.boot = directory, boot
        self.phase = "hashing_source"
        self._beats = (directory / "heartbeats.jsonl").open("a", encoding="utf-8")

    def start(self) -> None:
        return None

    def stop(self) -> None:
        self._beats.close()

    def task_input(self) -> dict[str, Any]:
        task: dict[str, Any] = self.boot["taskInput"]
        return task

    def source(self) -> tuple[BinaryIO, str | None]:
        return (self.dir / "source.mcap").open("rb"), None

    def segments_bytes(self) -> bytes:
        path = self.dir / "segments.json"
        if not path.is_file() or path.stat().st_size > MAX_SEGMENTS_BYTES:
            raise StageFailure("segments_missing")
        return path.read_bytes()

    def put(self, out: Any) -> Any:
        from .artifact_types import OutputReceipt, derived_uuid

        dest = self.dir / out.relative_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out.path, dest)
        file_id = derived_uuid(self.boot["jobId"], f"io-dir/{out.relative_path}")
        return OutputReceipt(file_id, out.role, out.size_bytes, out.sha256)

    def beat(self, phase: str, frames: int) -> None:
        if phase != self.phase or phase == "hashing_source":
            self.phase = phase
            self._beats.write(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "stage": self.boot["stage"],
                        "phase": phase,
                        "processedFrames": str(frames),
                        "totalFrames": None,
                    }
                )
                + "\n"
            )
            self._beats.flush()

    def finish(self, receipt: dict[str, Any], log: bytes) -> None:
        (self.dir / "receipt.json").write_bytes(_json(receipt))
        (self.dir / "log.txt").write_bytes(log)


def _json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


# ---------------------------------------------------------------------------- the stage


class _Log:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.size = 0

    def __call__(self, line: str) -> None:
        text = f"{_now()} {line[:500]}\n"
        if self.size + len(text) <= MAX_LOG_BYTES:
            self.lines.append(text)
            self.size += len(text)

    def bytes(self) -> bytes:
        return "".join(self.lines).encode()


def _stage_config(
    task: dict[str, Any], boot: dict[str, Any]
) -> tuple[dict[str, Any], str]:
    """The recipe stage this bootstrap is for, after the digest and the module were checked."""
    from stateaction_contracts import request_sha256

    if (
        task.get("schemaVersion") != 3
        or task.get("kind") != "process_recording"
        or task.get("jobId") != boot["jobId"]
    ):
        raise StageFailure("task_input_invalid")
    recipe = task["recipe"]
    if (
        task["recipeSha256"] != boot["recipeSha256"]
        or request_sha256(recipe) != boot["recipeSha256"]
    ):
        raise StageFailure("recipe_digest_mismatch")
    entry = next((s for s in recipe["stages"] if s["stage"] == boot["stage"]), None)
    if (
        entry is None
        or entry["enabled"] is not True
        or entry["module"] != boot["module"]
    ):
        raise StageFailure("recipe_stage_mismatch")
    return entry, request_sha256(entry["params"])


def _fail_code(error: BaseException, log: _Log) -> str:
    code = error_code(error)
    log(f"stage failed: {type(error).__name__} {code}")
    return code


def execute(
    io: Any, boot: dict[str, Any], manifest: dict[str, Any], log: _Log
) -> dict[str, Any]:
    """Run the stage and return its receipt (status succeeded or failed). Never raises a stage error."""
    from stateaction_contracts import validate_bytes, validate_value

    from . import modules
    from .artifact_types import make_output
    from .stage_docs import StageContext
    from .stage_media import remux_source

    stage, started = boot["stage"], _now()
    outputs: list[dict[str, Any]] = []
    scratch = Path(tempfile.mkdtemp(prefix="sa90-stage-"))
    status, code, counts, gpu_requested, observed = "succeeded", None, {}, "none", None
    windows_rows: list[dict[str, Any]] = []
    tamper = False
    extra: dict[str, bytes] = {}

    def upload(role: str, slot: str, data: bytes) -> dict[str, Any]:
        path = scratch / slot.replace("/", "__")
        path.write_bytes(data)
        receipt = io.put(make_output(role, slot, path, None))
        path.unlink(missing_ok=True)
        return {
            "fileId": receipt.file_id,
            "role": receipt.role,
            "sizeBytes": str(receipt.size_bytes),
            "sha256": receipt.sha256,
        }

    try:
        task = io.task_input()
        entry, params_sha = _stage_config(task, boot)
        gpu_requested = entry["resources"]["gpu"]
        module_id, version = modules.parse_ref(boot["module"])
        fn = modules.load(
            stage, module_id
        )  # first import of module code: after the claim
        io.beat("remuxing", 0)
        log("remux start")
        raw, expected_sha = io.source()
        try:
            frames = remux_source(
                raw,
                scratch / "recording.mp4",
                expected_profile=task["rgbProfile"],
                on_frame=lambda n: io.beat("remuxing", n),
            )
        finally:
            raw.close()
        if expected_sha is not None and frames.source_sha256 != expected_sha:
            raise StageFailure("source_digest_mismatch")
        log(f"remux done frames={len(frames)}")
        segments_doc: dict[str, Any] | None = None
        segments_sha: str | None = None
        if stage == "caption":
            data = io.segments_bytes()
            segments_sha = hashlib.sha256(data).hexdigest()
            if segments_sha != boot["segmentsSha256"]:
                raise StageFailure("segments_digest_mismatch")
            parsed = validate_bytes(_CONTRACT["segment"], data)
            if not parsed.valid:
                raise StageFailure("segments_invalid")
            segments_doc = parsed.value
            assert isinstance(segments_doc, dict)
            if (
                segments_doc["job_id"] != boot["jobId"]
                or segments_doc["recording_id"] != task["targetId"]
                or segments_doc["source_manifest_sha256"]
                != task["sourceManifestSha256"]
            ):
                raise StageFailure("segments_identity_mismatch")
        ctx = StageContext(
            stage=stage,
            job_id=boot["jobId"],
            recording_id=task["targetId"],
            source_manifest_sha256=task["sourceManifestSha256"],
            source_sha256=frames.source_sha256,
            module_id=module_id,
            module_version=version,
            params=entry["params"],
            params_sha256=params_sha,
            gpu_requested=gpu_requested,
            frames=frames,
            scratch=scratch,
            beat=io.beat,
            log=log,
            mp4_path=scratch / "recording.mp4",
            manifest=manifest,
            segments=segments_doc,
            segments_sha256=segments_sha,
        )
        io.beat("segmenting" if stage == "segment" else "captioning", 0)
        result = fn(ctx)
        counts, windows_rows, observed = (
            result.counts,
            result.windows_rows,
            result.observed_gpu,
        )
        tamper, extra = result.tamper_receipt_digest, result.extra_diagnostics
        document = _json(result.document)
        checked = validate_bytes(_CONTRACT[stage], document)
        if not checked.valid:
            log(f"contract rejected: {checked.code} {checked.errors[:1]}")
            raise StageFailure(f"contract_{checked.code}")
        io.beat("uploading", len(frames))
        primary = upload(_ROLE[stage], _DOCUMENT[stage], document)
        if (
            tamper
        ):  # stub fault injection: the receipt names a digest the file does not have
            primary["sha256"] = primary["sha256"][:-1] + (
                "0" if primary["sha256"][-1] != "0" else "1"
            )
        outputs.append(primary)
        log(f"document uploaded bytes={len(document)}")
    except Exception as error:  # a stage failure is a truthful receipt, not a crash
        status, code, counts = "failed", _fail_code(error, log), {}
        if error_code(error) == "internal_error":
            log(f"unexpected {type(error).__name__}")

    def diagnostic(name: str, data: bytes) -> None:
        if len(data) > MAX_DIAGNOSTIC_BYTES:
            log(f"diagnostic dropped: {name} too large")
            return
        outputs.append(upload("diagnostic_blob", f"diagnostics/{stage}/{name}", data))

    try:
        for name, data in sorted(extra.items()):
            diagnostic(name, data)
        if windows_rows:
            diagnostic(
                "windows.jsonl", b"".join(_json(r) + b"\n" for r in windows_rows)
            )
        log(f"stage {status}")
        diagnostic("log.txt", log.bytes() or b"stage log empty\n")
    except Exception as error:
        log(f"diagnostics failed: {type(error).__name__}")
        if status == "succeeded":
            status, code = "failed", "diagnostics_failed"
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    receipt: dict[str, Any] = {
        "schemaVersion": 1,
        "jobId": boot["jobId"],
        "stage": stage,
        "module": boot["module"],
        "status": status,
        "errorCode": code,
        "outputs": outputs,
        "counts": counts,
        "gpu": {"requestedType": gpu_requested, "observedType": observed},
        "startedAt": started,
        "finishedAt": _now(),
    }
    verdict = validate_value("jobs.stage-receipt.v1", receipt)
    if not verdict.valid:
        raise StageFailure(f"receipt_{verdict.code}")
    return receipt


def run(execution_ref: str | None, io_dir: Path | None) -> int:
    file_mode = io_dir is not None
    threaded = False
    if file_mode:
        assert io_dir is not None
        if (
            os.environ.get("APP_ENV") != "local"
            and os.environ.get("STATEACTION_IO_DIR_HARNESS") != "1"
        ):
            raise WorkerExit(EXIT_PIPELINE_UNAVAILABLE, "IoDirNotAllowed")
        try:
            data = (io_dir / "bootstrap.json").read_bytes()[: MAX_BOOTSTRAP_BYTES * 512]
            raw = json.loads(data)
            execution_ref = execution_ref or str(raw.get("executionRef", ""))
        except (OSError, ValueError, AttributeError) as error:
            raise WorkerExit(EXIT_INTERNAL, "InvalidBootstrap") from error
    else:
        assert execution_ref is not None
        if os.environ.get("STATEACTION_THREADED_ISOLATION_FD") == "3":
            threaded = True
            # SA-91 local stage path: the controller supervises this one thread group (no fork or
            # exec) and withholds the bootstrap until this acknowledgement arrives.
            enforce_single_process(allow_threads=True)
            try:
                os.write(_ISOLATION_FD, b"2")
            finally:
                os.close(_ISOLATION_FD)
        data = sys.stdin.buffer.read(MAX_BOOTSTRAP_BYTES + 1)
        if len(data) > MAX_BOOTSTRAP_BYTES:
            raise WorkerExit(EXIT_INTERNAL, "BootstrapTooLarge")
        try:
            raw = json.loads(data)
        except ValueError as error:
            raise WorkerExit(EXIT_INTERNAL, "InvalidBootstrap") from error
    boot = parse_bootstrap(raw, file_mode=file_mode, execution_ref=execution_ref or "")
    if threaded and (
        boot["executorKind"] != "local" or os.environ.get("APP_ENV") != "local"
    ):
        # The isolated local path exists only for the local executor in APP_ENV=local.
        raise WorkerExit(EXIT_INTERNAL, "InvalidBootstrap")
    from . import modules

    try:
        manifest = modules.resolve(boot["stage"], boot["module"])
    except modules.ModuleRefused as refused:
        # Fail closed BEFORE the claim: a module we would refuse never takes a claim.
        raise WorkerExit(EXIT_PIPELINE_UNAVAILABLE, refused.code) from refused
    log = _Log()
    if file_mode:
        assert io_dir is not None
        io: Any = _DirIo(io_dir, boot)
    else:
        nonce = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
        claim = {
            "schemaVersion": 1,
            "jobId": boot["jobId"],
            "invocationNonce": nonce,
            "executor": (
                {"kind": "modal", "functionCallId": execution_ref}
                if boot["executorKind"] == "modal"
                else {"kind": "local", "localExecutionRef": execution_ref}
            ),
        }
        try:
            grant = _post(
                f"{boot['apiUrl']}/internal/v1/jobs/{boot['jobId']}/claim",
                boot["bootstrapToken"],
                claim,
            )
            if grant["jobId"] != boot["jobId"] or grant["invocationNonce"] != nonce:
                raise ValueError("grant")
            grant["capability"]["token"]
        except (
            urllib.error.URLError,
            OSError,
            ValueError,
            KeyError,
            TypeError,
        ) as error:
            raise WorkerExit(EXIT_CLAIM_LOST, "ClaimLost") from error
        del boot["bootstrapToken"]
        io = _HttpIo(boot, grant, nonce)
    io.start()
    try:
        io.beat("hashing_source", 0)
        receipt = execute(io, boot, manifest, log)
        # The receipt is NOT uploaded as a job output: the server keeps it on the stage run, and an
        # inventory file that no receipt (hence no result node) can name would block the seal.
        io.finish(receipt, log.bytes())
    finally:
        io.stop()
    encoded_receipt = json.dumps(receipt, sort_keys=True, separators=(",", ":"))
    receipt_path = os.environ.get("STATEACTION_STAGE_RECEIPT_FILE")
    if not file_mode and receipt_path:
        with Path(receipt_path).open("x", encoding="utf-8") as output:
            output.write(encoded_receipt)
    print(encoded_receipt)
    return EXIT_OK if receipt["status"] == "succeeded" else EXIT_FAILED_REPORTED


def main(execution_ref: str | None, io_dir: str | None = None) -> int:
    try:
        return run(execution_ref, Path(io_dir) if io_dir else None)
    except WorkerExit as stop:
        print(f"Worker stopped: {stop.label}", file=sys.stderr)
        return stop.code
    except Exception as error:
        print(f"Worker failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else None))
