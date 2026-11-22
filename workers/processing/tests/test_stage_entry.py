"""`run-stage`: file-backed IO mode over the SA-50 golden MCAP, and HTTP mode against a loopback fake.

Only committed synthetic data. Crash and hang cases run in real child processes.
"""

import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

from indexed_fixture import chunked
from stage_helpers import GOLDEN_MCAP, JOB, recipe, task_input, write_io_dir
from stateaction_contracts import request_sha256, validate_bytes

from stateaction_processing import stage_entry

SRC = Path(__file__).resolve().parents[1] / "src"
SEGMENT = {"segment_s": "0.07"}  # the golden MCAP has 5 frames about 33 ms apart


def run_dir(
    directory: Path, env: dict[str, str] | None = None
) -> tuple[int, dict | None]:
    """Run in-process in file mode; returns (exit code, receipt)."""
    out = io.StringIO()
    with mock.patch.dict(os.environ, {"APP_ENV": "local", **(env or {})}):
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = stage_entry.main(None, str(directory))
    lines = out.getvalue().strip().splitlines()
    return code, (json.loads(lines[-1]) if lines else None)


def child(
    args: list[str],
    env: dict[str, str],
    stdin: bytes | None = None,
    timeout: float = 120,
):
    full = {**os.environ, "PYTHONPATH": str(SRC), "PYTHONDONTWRITEBYTECODE": "1", **env}
    return subprocess.run(
        [sys.executable, "-m", "stateaction_processing", *args],
        input=stdin,
        env=full,
        capture_output=True,
        timeout=timeout,
    )


class FileModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def segment(self, params=None, **kw):
        write_io_dir(
            self.dir, "segment", recipe(segment_params=params or SEGMENT), **kw
        )
        return run_dir(self.dir)

    def test_segment_stage_writes_outputs_receipt_and_diagnostics(self):
        code, receipt = self.segment()
        self.assertEqual(code, 0, receipt)
        self.assertEqual((receipt["status"], receipt["errorCode"]), ("succeeded", None))
        self.assertEqual(receipt["counts"]["frames"], 5)  # AU count == MCAP frame count
        roles = {o["role"]: o for o in receipt["outputs"]}
        document = (self.dir / "segments.json").read_bytes()
        self.assertTrue(validate_bytes("artifacts.segments.v1", document).valid)
        self.assertEqual(
            roles["segments_json"]["sha256"], hashlib.sha256(document).hexdigest()
        )
        for name in ("log.txt", "windows.jsonl"):
            self.assertTrue((self.dir / "diagnostics/segment" / name).is_file(), name)
        self.assertEqual(json.loads((self.dir / "receipt.json").read_text()), receipt)
        self.assertTrue((self.dir / "log.txt").is_file())
        phases = [
            json.loads(line)["phase"]
            for line in (self.dir / "heartbeats.jsonl").read_text().splitlines()
        ]
        for phase in ("remuxing", "segmenting", "uploading"):
            self.assertIn(phase, phases)
        self.assertTrue(
            all(
                json.loads(line)["stage"] == "segment"
                for line in (self.dir / "heartbeats.jsonl").read_text().splitlines()
            )
        )
        self.assertNotIn("source.mcap", json.dumps(receipt))  # no paths in receipts

    def test_caption_stage_reads_the_segments_it_was_pinned_to(self):
        self.segment()
        segments = (self.dir / "segments.json").read_bytes()
        with tempfile.TemporaryDirectory() as other:
            d = Path(other)
            write_io_dir(
                d, "caption", recipe(segment_params=SEGMENT), segments_bytes=segments
            )
            code, receipt = run_dir(d)
            self.assertEqual(code, 0, receipt)
            doc = json.loads((d / "captions.json").read_text())
            self.assertTrue(
                validate_bytes(
                    "artifacts.captions.v1", (d / "captions.json").read_bytes()
                ).valid
            )
            self.assertEqual(
                doc["segments_sha256"], hashlib.sha256(segments).hexdigest()
            )
            self.assertEqual(receipt["counts"]["captions"], len(doc["rows"]))
            self.assertIn("captioning", (d / "heartbeats.jsonl").read_text())

    def test_failed_windows_and_captions_are_recorded_as_failed(self):
        code, receipt = self.segment({**SEGMENT, "fail_windows": "1"})
        self.assertEqual(code, 0)
        self.assertEqual(receipt["counts"]["failed_windows"], 1)
        segments = (self.dir / "segments.json").read_bytes()
        self.assertIn("failed_window", segments.decode())
        with tempfile.TemporaryDirectory() as other:
            d = Path(other)
            write_io_dir(
                d,
                "caption",
                recipe(caption_params={"fail_captions": "0"}),
                segments_bytes=segments,
            )
            code, receipt = run_dir(d)
            self.assertEqual(code, 0)
            statuses = [
                r["status"]
                for r in json.loads((d / "captions.json").read_text())["rows"]
            ]
            self.assertIn("failed", statuses)
            self.assertIn("not_captioned", statuses)
            self.assertEqual(receipt["counts"]["failed_captions"], 1)

    def test_zero_segments_is_succeeded_with_zero_rows(self):
        code, receipt = self.segment({**SEGMENT, "zero_segments": True})
        self.assertEqual((code, receipt["counts"]["segments"]), (0, 0))
        self.assertEqual(
            json.loads((self.dir / "segments.json").read_text())["rows"], []
        )

    def test_caption_stage_rejects_segments_whose_sha256_differs(self):
        self.segment()
        segments = (self.dir / "segments.json").read_bytes()
        with tempfile.TemporaryDirectory() as other:
            d = Path(other)
            write_io_dir(
                d, "caption", recipe(), segments_bytes=segments, segments_sha="0" * 64
            )
            code, receipt = run_dir(d)
            self.assertEqual(
                (code, receipt["status"], receipt["errorCode"]),
                (3, "failed", "segments_digest_mismatch"),
            )
            self.assertFalse(
                (d / "captions.json").exists()
            )  # nothing captioned, never an empty result
            self.assertEqual(
                [o["role"] for o in receipt["outputs"]], ["diagnostic_blob"]
            )

    def test_stub_digest_mismatch_makes_the_receipt_digest_disagree_with_the_file(self):
        code, receipt = self.segment({**SEGMENT, "digest_mismatch": True})
        self.assertEqual(code, 0)
        reported = next(
            o["sha256"] for o in receipt["outputs"] if o["role"] == "segments_json"
        )
        self.assertNotEqual(
            reported,
            hashlib.sha256((self.dir / "segments.json").read_bytes()).hexdigest(),
        )

    def test_recipe_digest_and_module_must_match_the_bootstrap(self):
        write_io_dir(self.dir, "segment", recipe(segment_params=SEGMENT))
        boot = json.loads((self.dir / "bootstrap.json").read_text())
        boot["recipeSha256"] = "0" * 64
        (self.dir / "bootstrap.json").write_text(json.dumps(boot))
        code, receipt = run_dir(self.dir)
        self.assertEqual((code, receipt["errorCode"]), (3, "recipe_digest_mismatch"))
        boot["module"] = "stub_captioner@1"
        (self.dir / "bootstrap.json").write_text(json.dumps(boot))
        self.assertEqual(
            run_dir(self.dir)[0], 78
        )  # stage/module mismatch is refused before running

    def test_corrupt_source_fails_the_stage_without_output(self):
        write_io_dir(self.dir, "segment", recipe(segment_params=SEGMENT))
        data = bytearray(chunked(GOLDEN_MCAP.read_bytes()))
        data[len(data) // 2] ^= 0xFF
        (self.dir / "source.mcap").write_bytes(bytes(data))
        code, receipt = run_dir(self.dir)
        self.assertEqual((code, receipt["status"]), (3, "failed"))
        self.assertFalse((self.dir / "segments.json").exists())

    def test_local_only_modules_are_refused_outside_local(self):
        write_io_dir(self.dir, "segment", recipe(segment_params=SEGMENT))
        env = {k: v for k, v in os.environ.items() if k != "APP_ENV"}
        env.update(APP_ENV="production", STATEACTION_IO_DIR_HARNESS="1")
        result = child(["run-stage", "--io-dir", str(self.dir)], env)
        self.assertEqual(result.returncode, 78, result.stderr)
        self.assertIn(b"module_local_only", result.stderr)
        self.assertFalse((self.dir / "receipt.json").exists())

    def test_io_dir_needs_local_or_the_harness_flag(self):
        write_io_dir(self.dir, "segment", recipe(segment_params=SEGMENT))
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in ("APP_ENV", "STATEACTION_IO_DIR_HARNESS")
        }
        self.assertEqual(
            child(["run-stage", "--io-dir", str(self.dir)], env).returncode, 78
        )
        env["STATEACTION_IO_DIR_HARNESS"] = "1"
        # harness allowed, but stub modules are still local-only: refused for the module, not the mode
        self.assertIn(
            b"module_local_only",
            child(["run-stage", "--io-dir", str(self.dir)], env).stderr,
        )

    def test_unregistered_real_module_is_unavailable(self):
        rec = recipe(segment_module="flora_tempseg_vllm_fp8@1")
        rec["stages"][0]["resources"]["gpu"] = "H100"
        write_io_dir(self.dir, "segment", rec)
        result = child(["run-stage", "--io-dir", str(self.dir)], {"APP_ENV": "local"})
        self.assertEqual(result.returncode, 78)
        self.assertIn(b"module_unavailable", result.stderr)

    def test_replay_of_an_unknown_recording_is_a_failed_receipt(self):
        write_io_dir(self.dir, "segment", recipe(segment_module="replay_segmenter@1"))
        with tempfile.TemporaryDirectory() as empty:
            code, receipt = run_dir(self.dir, {"STATEACTION_REPLAY_DIR": empty})
        self.assertEqual((code, receipt["errorCode"]), (3, "replay_not_found"))

    def test_crash_after_n_exits_without_a_receipt(self):
        write_io_dir(
            self.dir, "segment", recipe(segment_params={**SEGMENT, "crash_after_n": 1})
        )
        result = child(["run-stage", "--io-dir", str(self.dir)], {"APP_ENV": "local"})
        self.assertEqual(result.returncode, 86, result.stderr)
        self.assertFalse((self.dir / "receipt.json").exists())
        self.assertFalse((self.dir / "segments.json").exists())

    def test_hang_keeps_running_until_killed(self):
        write_io_dir(
            self.dir,
            "segment",
            recipe(segment_params={**SEGMENT, "hang": True, "hang_s": 600}),
        )
        env = {**os.environ, "PYTHONPATH": str(SRC), "APP_ENV": "local"}
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "stateaction_processing",
                "run-stage",
                "--io-dir",
                str(self.dir),
            ],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait(timeout=6)
        finally:
            proc.kill()
            proc.communicate()
        self.assertFalse((self.dir / "receipt.json").exists())


# ---------------------------------------------------------------------------- HTTP mode


class FakeApi(BaseHTTPRequestHandler):
    server_state: dict = {}

    def log_message(self, *args):
        pass

    def _send(self, body: bytes, status: int = 200, ctype: str = "application/json"):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _data(self, data, status=200):
        self._send(json.dumps({"data": data}).encode(), status)

    def do_GET(self):  # noqa: N802
        st = self.server_state
        st["requests"].append(("GET", self.path))
        if self.path.endswith("/task-input"):
            return self._data(st["task"])
        if self.path == "/source":
            return self._send(st["source"], ctype="application/octet-stream")
        if self.path == "/segments":
            return self._send(st["segments"], ctype="application/octet-stream")
        self._send(b"{}", 404)

    def do_POST(self):  # noqa: N802
        st = self.server_state
        body = json.loads(
            self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}"
        )
        st["requests"].append(("POST", self.path, body))
        base = f"http://127.0.0.1:{self.server.server_port}"
        if self.path.endswith("/claim"):
            if st["claim_status"] != 200:
                return self._data({}, st["claim_status"])
            return self._data(
                {
                    "jobId": JOB,
                    "invocationNonce": body["invocationNonce"],
                    "capability": {"token": "B" * 43},
                    "inputs": [
                        {
                            "role": "source_mcap",
                            "readUrl": f"{base}/source",
                            "sha256": st["source_sha"],
                            "fileId": str(uuid.uuid4()),
                        }
                    ],
                }
            )
        if self.path.endswith("/heartbeat"):
            return self._data({"accepted": True})
        if self.path.endswith("/outputs"):
            st["outputs"].append(body)
            return self._data(
                {
                    "fileId": str(uuid.uuid4()),
                    "transportEpoch": 1,
                    "role": body["role"],
                    "sizeBytes": body["sizeBytes"],
                    "sha256": body["sha256"],
                    "state": "completed",
                    "partCount": 1,
                }
            )
        if self.path.endswith("/read"):
            return self._data(
                {"fileId": body.get("fileId", ""), "readUrl": f"{base}/segments"}
            )
        self._data({})


class HttpModeTests(unittest.TestCase):
    def setUp(self):
        FakeApi.server_state = {"requests": [], "outputs": [], "claim_status": 200}
        self.state = FakeApi.server_state
        self.server = HTTPServer(("127.0.0.1", 0), FakeApi)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join, 5)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        mcap = chunked(GOLDEN_MCAP.read_bytes())
        self.state.update(source=mcap, source_sha=hashlib.sha256(mcap).hexdigest())

    def bootstrap(self, stage="segment", rec=None, **extra):
        rec = rec or recipe(segment_params=SEGMENT)
        self.state["task"] = task_input(rec)
        module = next(s["module"] for s in rec["stages"] if s["stage"] == stage)
        return json.dumps(
            {
                "schemaVersion": 2,
                "apiUrl": f"http://127.0.0.1:{self.server.server_port}",
                "jobId": JOB,
                "bootstrapToken": "sa_svc_" + "A" * 43,
                "executionRef": "local-stage-ref",
                "stage": stage,
                "module": module,
                "recipeSha256": request_sha256(rec),
                **extra,
            }
        ).encode()

    def run_worker(self, boot: bytes):
        return child(["run-stage", "local-stage-ref"], {"APP_ENV": "local"}, stdin=boot)

    def test_lost_claim_exits_before_any_module_import_or_source_read(self):
        self.state["claim_status"] = 403
        code = (
            "import sys; from stateaction_processing.cli import main; sys.argv=['x','run-stage','local-stage-ref'];"
            "import atexit; atexit.register(lambda: print('IMPORTED=' + str(any(m.endswith(('modules.stub','stage_media','modules.replay')) for m in sys.modules)), file=sys.stderr));"
            "main()"
        )
        env = {**os.environ, "PYTHONPATH": str(SRC), "APP_ENV": "local"}
        result = subprocess.run(
            [sys.executable, "-c", code],
            input=self.bootstrap(),
            env=env,
            capture_output=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn(b"IMPORTED=False", result.stderr)
        self.assertEqual(
            [r[1].rsplit("/", 1)[-1] for r in self.state["requests"]], ["claim"]
        )

    def test_local_only_module_is_refused_before_the_claim(self):
        env = {k: v for k, v in os.environ.items() if k != "APP_ENV"}
        env["APP_ENV"] = "production"
        result = child(["run-stage", "local-stage-ref"], env, stdin=self.bootstrap())
        self.assertEqual(result.returncode, 78)
        self.assertEqual(self.state["requests"], [])

    def test_segment_stage_claims_uploads_the_stage_slots_and_heartbeats_with_v2(self):
        result = self.run_worker(self.bootstrap())
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(receipt["status"], "succeeded")
        slots = {o["slot"]: o["role"] for o in self.state["outputs"]}
        self.assertEqual(slots["segments.json"], "segments_json")
        for name in ("log.txt", "windows.jsonl", "receipt.json"):
            self.assertEqual(slots[f"diagnostics/segment/{name}"], "diagnostic_blob")
        beats = [r[2] for r in self.state["requests"] if r[1].endswith("/heartbeat")]
        self.assertTrue(
            beats
            and all(b["schemaVersion"] == 2 and b["stage"] == "segment" for b in beats)
        )
        self.assertTrue({"remuxing", "segmenting"} <= {b["phase"] for b in beats})
        order = [r[1].rsplit("/", 1)[-1] for r in self.state["requests"]]
        self.assertEqual(order[0], "claim")
        self.assertNotIn(
            "sa_svc_" + "A" * 43, result.stdout.decode() + result.stderr.decode()
        )

    def test_caption_stage_reads_segments_through_the_stage_output_read(self):
        seg_dir = tempfile.TemporaryDirectory()
        self.addCleanup(seg_dir.cleanup)
        write_io_dir(Path(seg_dir.name), "segment", recipe(segment_params=SEGMENT))
        self.assertEqual(run_dir(Path(seg_dir.name))[0], 0)
        segments = (Path(seg_dir.name) / "segments.json").read_bytes()
        self.state["segments"] = segments
        file_id = str(uuid.uuid4())
        boot = self.bootstrap(
            "caption",
            recipe(segment_params=SEGMENT),
            segmentsFileId=file_id,
            segmentsSha256=hashlib.sha256(segments).hexdigest(),
        )
        result = self.run_worker(boot)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(
            any(
                r[1].endswith(f"/outputs/{file_id}/read")
                for r in self.state["requests"]
                if r[0] == "POST"
            )
        )
        self.assertIn("captions.json", {o["slot"] for o in self.state["outputs"]})

    def test_caption_stage_rejects_a_digest_that_differs_from_the_pinned_one(self):
        self.state["segments"] = b'{"not":"the segments"}'
        boot = self.bootstrap(
            "caption", segmentsFileId=str(uuid.uuid4()), segmentsSha256="1" * 64
        )
        result = self.run_worker(boot)
        receipt = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(
            (result.returncode, receipt["errorCode"]), (3, "segments_digest_mismatch")
        )
        self.assertNotIn("captions.json", {o["slot"] for o in self.state["outputs"]})


class BootstrapTests(unittest.TestCase):
    def test_shape_is_strict(self):
        good = {
            "schemaVersion": 2,
            "apiUrl": "http://127.0.0.1:1",
            "jobId": JOB,
            "bootstrapToken": "sa_svc_" + "A" * 43,
            "executionRef": "ref",
            "stage": "segment",
            "module": "stub_segmenter@1",
            "recipeSha256": "0" * 64,
        }
        stage_entry.parse_bootstrap(dict(good), file_mode=False, execution_ref="ref")
        for patch in (
            {"stage": "hand_pose"},
            {"module": "bad"},
            {"extra": 1},
            {"segmentsSha256": "0" * 64},
            {"apiUrl": "http://example.com"},
            {"executionRef": "other"},
        ):
            with self.subTest(patch), self.assertRaises(stage_entry.WorkerExit):
                stage_entry.parse_bootstrap(
                    {**good, **patch}, file_mode=False, execution_ref="ref"
                )
        with self.assertRaises(
            stage_entry.WorkerExit
        ):  # caption needs the segments pin
            stage_entry.parse_bootstrap(
                {**good, "stage": "caption"}, file_mode=False, execution_ref="ref"
            )


if __name__ == "__main__":
    unittest.main()
