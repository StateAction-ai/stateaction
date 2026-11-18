"""Adapter protocol against a loopback stub of the job routes (no media, no model inference).

The SA-31 exporter is replaced by a tiny fake that drives the SAME `OutputSink` the adapter passes
to the real exporter, so this proves the claim-bound output protocol: allocate, sign, PUT, receipt,
complete, close the inventory, post the provisional candidate, and report a failed candidate with a
diagnostic manifest when the pipeline raises. Real decode/inference is covered by the artifact tests
and by the joined native-MCAP validation.
"""

import hashlib
import json
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

JOB = "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e"
REC = "9a1f3c52-7d84-4e6b-8f21-0c5d6e7f8a90"
NONCE = "N" * 43
SHA0 = "0" * 64
MCAP = "11111111-1111-4111-8111-111111111111"
MAN = "22222222-2222-4222-8222-222222222222"


class Stub(BaseHTTPRequestHandler):
    calls: list[tuple[str, str, object]] = []
    blobs: dict[str, bytes] = {}
    sizes: dict[str, int] = {}
    counter = 0

    def log_message(self, *args):
        pass

    def _read(self):
        raw = self.rfile.read(int(self.headers.get("content-length", "0")))
        return raw

    def _reply(self, data, headers=None):
        payload = json.dumps({"data": data}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        type(self).calls.append(("GET", self.path, None))
        self._reply(
            {
                "schemaVersion": 2,
                "jobId": JOB,
                "targetId": REC,
                "profileRevision": "h264_mcap_v1",
                "kind": "process_recording",
                "sourceManifestSha256": SHA0,
                "rgbProfile": "h264_mcap_v1",
            }
        )

    def do_PUT(self):  # noqa: N802
        raw = self._read()
        if self.path.startswith("/blob/"):
            type(self).blobs[self.path] = raw
            type(self).calls.append(("PUT", "blob", len(raw)))
            self._reply({}, {"ETag": f'"{hashlib.md5(raw).hexdigest()}"'})
        else:
            type(self).calls.append(("PUT", self.path, json.loads(raw)))
            self._reply({"accepted": True})

    def do_POST(self):  # noqa: N802
        raw = self._read()
        body = json.loads(raw) if raw else {}
        cls = type(self)
        cls.calls.append(("POST", self.path, body))
        if self.path.endswith("/outputs"):
            cls.counter += 1
            fid = f"00000000-0000-4000-8000-{cls.counter:012d}"
            cls.sizes[fid] = int(body["sizeBytes"])
            self._reply(
                {
                    "fileId": fid,
                    "recordingId": REC,
                    "role": body["role"],
                    "sizeBytes": body["sizeBytes"],
                    "sha256": body["sha256"],
                    "transportEpoch": 1,
                    "partSizeBytes": "67108864",
                    "partCount": 1,
                    "state": "reserved",
                    "transportExpiresAt": "2999-01-01T00:00:00Z",
                }
            )
        elif self.path.endswith("/parts/sign"):
            fid = self.path.split("/")[-3]
            self._reply(
                {
                    "transportEpoch": 1,
                    "parts": [
                        {
                            "partNumber": 1,
                            "method": "PUT",
                            "url": f"http://127.0.0.1:{self.server.server_port}/blob/{fid}",
                            "headers": {},
                            "offsetBytes": "0",
                            "lengthBytes": str(cls.sizes[fid]),
                            "expiresAt": "2999-01-01T00:00:00Z",
                        }
                    ],
                }
            )
        elif self.path.endswith("/complete"):
            self._reply({"state": "completed"})
        else:
            self._reply({"accepted": True})


def install_fakes(fail: bool, diagnostic: "bool | dict" = False):
    from stateaction_processing.artifact_types import make_output

    export = types.ModuleType("stateaction_processing.artifact_export")
    export.config_sha256 = lambda *_: "c" * 64  # type: ignore[attr-defined]
    streams = types.ModuleType("stateaction_processing.capture_stream")
    streams.StreamLimits = lambda: object()  # type: ignore[attr-defined]

    def export_artifacts(raw, sink, ctx, **kw):
        if fail and diagnostic:
            path = Path(tempfile.mkdtemp(prefix="fake-clip-")) / "a.bin"
            path.write_bytes(b"clip bytes")
            sink.put(make_output("hand_arrays_npz", "clips/000/hands.npz", path, None))
            error = RuntimeError("secret /home/someone/private.mcap token=abc")
            error.diagnostics = (
                diagnostic
                if isinstance(diagnostic, dict)
                else {  # type: ignore[attr-defined]
                    "stage": "source_verification",
                    "counts": {
                        "frames_decoded": 5,
                        "frames_inferred": 5,
                        "clips_written": 1,
                        "files_put": 1,
                        "path": "/home/someone/private.mcap",  # not allowlisted
                        "video_messages": -3,  # invalid: dropped
                    },
                    "detail": "token=abc",
                }
            )
            raise error
        if fail:
            raise RuntimeError("boom")
        manifest = {
            "checks": [{"code": "source_accepted", "status": "pass"}],
            "clips": [],
        }
        path = Path(tempfile.mkdtemp(prefix="fake-export-")) / "m.json"
        path.write_bytes(json.dumps(manifest).encode())
        receipt = sink.seal(
            make_output("result_manifest", "result-manifest.json", path, None)
        )
        return types.SimpleNamespace(
            manifest_receipt=receipt, clips=[], manifest=manifest
        )

    export.export_artifacts = export_artifacts  # type: ignore[attr-defined]
    sys.modules["stateaction_processing.artifact_export"] = export
    sys.modules["stateaction_processing.capture_stream"] = streams


class AdapterProtocolTests(unittest.TestCase):
    def setUp(self):
        Stub.calls, Stub.blobs, Stub.sizes, Stub.counter = [], {}, {}, 0
        self.server = HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        for name in ("artifact_export", "capture_stream"):
            self.addCleanup(sys.modules.pop, f"stateaction_processing.{name}", None)

    def run_adapter(
        self, fail: bool, diagnostic: "bool | dict" = False, size: "str | None" = None
    ) -> int:
        from stateaction_processing import hand_model, hand_pose_cpu_v1

        install_fakes(fail, diagnostic)
        port = self.server.server_port
        grant = {
            "jobId": JOB,
            "digests": {
                "sourceManifestSha256": SHA0,
                "codeRevision": "rev1",
                "imageSpecSha256": "1" * 64,
                "modelSha256": hand_model.PINS["sha256"],
                "configSha256": "c" * 64,
            },
            "inputs": [
                {"fileId": MCAP, "role": "source_mcap", "sha256": "a" * 64,
                 "readUrl": f"http://127.0.0.1:{port}/source",
                 **({"sizeBytes": size} if size is not None else {})},
                {"fileId": MAN, "role": "source_manifest", "sha256": SHA0, "readUrl": ""},
            ],
        }  # fmt: skip
        context = {
            "apiUrl": f"http://127.0.0.1:{port}",
            "jobId": JOB,
            "nonce": NONCE,
            "capability": "sa_svc_" + "B" * 43,
        }
        return hand_pose_cpu_v1.run(grant, context)

    def test_success_allocates_uploads_closes_then_posts_a_provisional_candidate(self):
        self.assertEqual(self.run_adapter(fail=False), 0)
        names = [
            p.split(f"{JOB}/")[-1] for _, p, _ in Stub.calls if p != "blob" and JOB in p
        ]
        # heartbeat, task input, allocate, sign, (blob PUT), receipts, complete, close, result
        self.assertEqual(names[0], "heartbeat")
        self.assertEqual(names[1], "task-input")
        self.assertEqual(names[2], "outputs")
        self.assertTrue(names[3].endswith("/parts/sign"))
        self.assertTrue(names[4].endswith("/parts/receipts"))
        self.assertTrue(names[5].endswith("/complete"))
        self.assertEqual(names[-2:], ["outputs/close", "result"])
        close = next(b for m, p, b in Stub.calls if p.endswith("/outputs/close"))
        self.assertEqual(close["outcome"], "succeeded")
        self.assertEqual(close["invocationNonce"], NONCE)
        result = Stub.calls[-1][2]
        self.assertEqual(result["summary"]["outcome"], "succeeded")
        self.assertIsNone(result["summary"]["errorCode"])
        self.assertEqual(result["summary"]["checks"]["pass"], 1)
        alloc = next(
            b for m, p, b in Stub.calls if p.endswith("/outputs") and m == "POST"
        )
        self.assertEqual(alloc["slot"], "result-manifest.json")
        self.assertEqual(alloc["role"], "result_manifest")
        # The candidate cites the SERVER's file id, not a worker-chosen one.
        self.assertEqual(
            result["manifestFileId"], "00000000-0000-4000-8000-000000000001"
        )

    def test_pipeline_failure_reports_a_failed_candidate_with_a_diagnostic_manifest(
        self,
    ):
        self.assertEqual(self.run_adapter(fail=True), 3)
        blob = next(iter(Stub.blobs.values()))
        manifest = json.loads(blob)
        self.assertEqual(manifest["schema"], "stateaction.processing_result.v2")
        self.assertEqual(manifest["clips"], [])
        self.assertEqual(manifest["outputs"], [])
        self.assertFalse(manifest["attestation"]["source_eof_verified"])
        self.assertEqual(manifest["attestation"]["invocation_nonce"], NONCE)
        close = next(b for m, p, b in Stub.calls if p.endswith("/outputs/close"))
        self.assertEqual(close["outcome"], "failed")
        result = Stub.calls[-1][2]
        self.assertEqual(result["summary"]["outcome"], "failed")
        self.assertEqual(result["summary"]["errorCode"], "runtimeerror")
        self.assertEqual(result["summary"]["clipCount"], 0)
        self.assertEqual(result["summary"]["checks"]["fail"], 1)

    def test_failure_after_uploads_reports_curated_counters_and_closes_failed(self):
        self.assertEqual(self.run_adapter(fail=True, diagnostic=True), 3)
        from stateaction_contracts import validate_bytes

        blob = next(
            b
            for b in Stub.blobs.values()
            if b.startswith(b"{") and b"processing_result" in b
        )
        verdict = validate_bytes("artifacts.processing-result.v2", blob)
        self.assertTrue(verdict.valid, (verdict.code, verdict.errors[:3]))
        manifests = [
            json.loads(b)
            for b in Stub.blobs.values()
            if b.startswith(b"{") and b"processing_result" in b
        ]
        self.assertEqual(len(manifests), 1)
        manifest = manifests[0]
        self.assertEqual(manifest["clips"], [])
        self.assertEqual(
            manifest["outputs"], []
        )  # nothing uploaded is cited as a result
        self.assertFalse(manifest["attestation"]["source_eof_verified"])
        by_code = {c["code"]: c for c in manifest["checks"]}
        fail = by_code["runtimeerror"]
        self.assertEqual(fail["status"], "fail")
        self.assertIn("final whole-source verification", fail["message"])
        self.assertEqual(
            fail["measurements"],
            {
                "frames_decoded": "5",
                "frames_inferred": "5",
                "clips_written": "1",
                "files_put": "1",
                "files_uploaded": "1",  # the uploaded diagnostic file stays retained, unaccepted
            },
        )
        for code in ("source_accepted", "hand_detection_summary"):
            self.assertEqual(by_code[code]["status"], "not_evaluated")
            self.assertEqual(by_code[code]["measurements"], {})
        # Bounded and free of caller text, paths and tokens.
        raw = json.dumps(manifest)
        for leaked in ("someone", "private.mcap", "token=abc", "secret"):
            self.assertNotIn(leaked, raw)
        self.assertLess(len(raw), 16 * 1024)
        close = next(b for m, p, b in Stub.calls if p.endswith("/outputs/close"))
        self.assertEqual(close["outcome"], "failed")
        result = Stub.calls[-1][2]
        self.assertEqual(result["summary"]["outcome"], "failed")
        self.assertEqual(result["summary"]["clipCount"], 0)
        self.assertEqual(
            result["summary"]["checks"],
            {"pass": 0, "warn": 0, "fail": 1, "measured": 0, "notEvaluated": 2},
        )
        names = [p.split(f"{JOB}/")[-1] for _, p, _ in Stub.calls if JOB in p]
        self.assertLess(
            names.index("outputs/close"), names.index("result")
        )  # inventory closed before the candidate

    def failed_manifest(self, diagnostic, size=None):
        from stateaction_contracts import validate_bytes

        self.assertEqual(
            self.run_adapter(fail=True, diagnostic=diagnostic, size=size), 3
        )
        blob = next(
            b
            for b in Stub.blobs.values()
            if b.startswith(b"{") and b"processing_result" in b
        )
        verdict = validate_bytes("artifacts.processing-result.v2", blob)
        self.assertTrue(verdict.valid, (verdict.code, verdict.errors[:3]))
        manifest = json.loads(blob)
        by_code = {c["code"]: c for c in manifest["checks"]}
        result = Stub.calls[-1][2]
        # The summary counts always equal the manifest's own check statuses.
        expected = {"pass": 0, "warn": 0, "fail": 0, "measured": 0, "notEvaluated": 0}
        for c in manifest["checks"]:
            expected[
                "notEvaluated" if c["status"] == "not_evaluated" else c["status"]
            ] += 1
        self.assertEqual(result["summary"]["checks"], expected)
        self.assertEqual(result["summary"]["outcome"], "failed")
        self.assertEqual(result["summary"]["clipCount"], 0)
        self.assertEqual(manifest["clips"], [])
        self.assertEqual(manifest["outputs"], [])
        return manifest, by_code

    def test_failure_after_proven_source_reports_source_check_but_stays_failed(self):
        manifest, by_code = self.failed_manifest(
            {
                "stage": "manifest",
                "source_verified": True,
                "counts": {
                    "source_bytes_read": 1234,
                    "video_messages": 5,
                    "frames_decoded": 5,
                },
            }
        )
        source = by_code["source_accepted"]
        self.assertEqual(source["status"], "pass")
        self.assertNotIn("before the source was verified", source["message"])
        self.assertEqual(
            source["measurements"],
            {"source_bytes_read": "1234", "video_messages": "5", "frames_decoded": "5"},
        )
        # The attestation names exactly the proven MCAP, never unread input files.
        self.assertTrue(manifest["attestation"]["source_eof_verified"])
        self.assertEqual(manifest["attestation"]["source_file_id"], MCAP)
        self.assertEqual(
            manifest["verified_sources"],
            [
                {
                    "file_id": MCAP,
                    "size_bytes": "1234",
                    "sha256": "a" * 64,
                }
            ],
        )
        self.assertEqual(by_code["runtimeerror"]["status"], "fail")
        self.assertEqual(by_code["hand_detection_summary"]["status"], "not_evaluated")

    def test_source_is_never_inferred_verified(self):
        # Flag missing, false, truthy-but-not-True, wrong stage, or no byte count: not evaluated.
        cases = [
            {"stage": "manifest", "counts": {"source_bytes_read": 9}},
            {
                "stage": "manifest",
                "source_verified": False,
                "counts": {"source_bytes_read": 9},
            },
            {
                "stage": "manifest",
                "source_verified": 1,
                "counts": {"source_bytes_read": 9},
            },
            {
                "stage": "source_verification",
                "source_verified": True,
                "counts": {"source_bytes_read": 9},
            },
            {"stage": "manifest", "source_verified": True, "counts": {}},
        ]
        for diag in cases:
            with self.subTest(diag=diag):
                Stub.calls, Stub.blobs, Stub.sizes, Stub.counter = [], {}, {}, 0
                manifest, by_code = self.failed_manifest(diag)
                self.assertEqual(by_code["source_accepted"]["status"], "not_evaluated")
                self.assertFalse(manifest["attestation"]["source_eof_verified"])
                self.assertEqual(manifest["verified_sources"], [])

    def test_granted_size_must_equal_bytes_read(self):
        diag = {
            "stage": "manifest",
            "source_verified": True,
            "counts": {"source_bytes_read": 9},
        }
        _m, by_code = self.failed_manifest(diag, size="9")
        self.assertEqual(by_code["source_accepted"]["status"], "pass")
        Stub.calls, Stub.blobs, Stub.sizes, Stub.counter = [], {}, {}, 0
        _m, by_code = self.failed_manifest(diag, size="10")
        self.assertEqual(by_code["source_accepted"]["status"], "not_evaluated")

    def test_out_of_range_and_invalid_counts_are_omitted_never_clamped(self):
        _manifest, by_code = self.failed_manifest(
            {
                "stage": "inference",
                "counts": {
                    "frames_decoded": 2**63,  # over int64: omitted, not clamped
                    "frames_inferred": 2**63 - 1,  # exactly int64 max: kept
                    "clips_written": True,  # bool
                    "files_put": -1,  # negative
                    "video_messages": "7",  # non-int
                    "source_bytes_read": 1.5,  # non-int
                },
            }
        )
        self.assertEqual(
            by_code["runtimeerror"]["measurements"],
            {"frames_inferred": str(2**63 - 1), "files_uploaded": "1"},
        )


if __name__ == "__main__":
    unittest.main()
