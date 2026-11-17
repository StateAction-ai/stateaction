"""Claim-before-anything ordering, against a real loopback HTTP listener and real child processes."""

import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

JOB = "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e"
TOKEN = "sa_svc_" + "A" * 43
REF = "local-test-ref"


class Handler(BaseHTTPRequestHandler):
    paths: list[str] = []
    claim_status = 403

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length))
        type(self).paths.append(self.path)
        if self.path.endswith("/claim") and type(self).claim_status == 200:
            data = {
                "jobId": JOB,
                "invocationNonce": body["invocationNonce"],
                "executionDeadline": "2999-01-01T00:00:00Z",
                "capability": {"token": "sa_svc_" + "B" * 43},
            }
        else:
            data = {"accepted": True}
        payload = json.dumps({"data": data}).encode()
        self.send_response(
            type(self).claim_status if self.path.endswith("/claim") else 200
        )
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # silence
        pass


def run_worker(port: int, pipeline: str, app_env: str = "local"):
    boot = {
        "schemaVersion": 1,
        "apiUrl": f"http://127.0.0.1:{port}",
        "jobId": JOB,
        "bootstrapToken": TOKEN,
        "executionRef": REF,
        "pipeline": pipeline,
    }
    # The probe prints which pipeline modules were imported at exit.
    code = (
        "import sys; from stateaction_processing.cli import main; "
        "import atexit; atexit.register(lambda: print('IMPORTED_PIPELINE='"
        "+str(any(m.endswith(('fixture_noop','hand_pose_cpu_v1')) for m in sys.modules)), file=sys.stderr)); "
        "sys.argv=['w','run-job','--execution-ref','" + REF + "']; main()"
    )
    return subprocess.run(
        [sys.executable, "-c", code],
        input=json.dumps(boot),
        capture_output=True,
        text=True,
        env={
            "PATH": os.environ.get("PATH", ""),
            "APP_ENV": app_env,
            "PYTHONNOUSERSITE": "1",
        },
        timeout=60,
        check=False,
    )


class RunJobTests(unittest.TestCase):
    def setUp(self):
        Handler.paths = []
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_lost_claim_exits_without_importing_pipeline_or_further_calls(self):
        Handler.claim_status = 403
        result = run_worker(self.port, "local_fixture_noop")
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertEqual(Handler.paths, [f"/internal/v1/jobs/{JOB}/claim"])
        self.assertIn("IMPORTED_PIPELINE=False", result.stderr)
        self.assertNotIn(TOKEN, result.stderr + result.stdout)

    def test_won_claim_then_pipeline_runs_and_heartbeats(self):
        Handler.claim_status = 200
        result = run_worker(self.port, "local_fixture_noop")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Handler.paths[0], f"/internal/v1/jobs/{JOB}/claim")
        self.assertEqual(Handler.paths[1], f"/internal/v1/jobs/{JOB}/heartbeat")

    def test_fixture_filter_blocks_creation_of_additional_processes(self):
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                """
import os
from stateaction_processing.run_job import enforce_single_process

enforce_single_process()
try:
    pid = os.fork()
except PermissionError:
    pass
else:
    if pid == 0:
        os._exit(0)
    os.waitpid(pid, 0)
    raise RuntimeError('fork bypassed the fixture filter')

try:
    pid = os.posix_spawn('/bin/true', ['true'], {})
except PermissionError:
    pass
else:
    os.waitpid(pid, 0)
    raise RuntimeError('spawn bypassed the fixture filter')
""",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipIf(
        (
            Path(__file__).parents[1] / "src/stateaction_processing/hand_pose_cpu_v1.py"
        ).is_file(),
        "production pipeline present (extractor stack landed)",
    )
    def test_unavailable_production_pipeline_fails_before_any_claim(self):
        Handler.claim_status = 200
        result = run_worker(self.port, "hand_pose_cpu_v1")
        self.assertEqual(result.returncode, 78, result.stderr)
        self.assertEqual(Handler.paths, [])

    def test_redirected_claim_is_not_followed_and_is_a_lost_claim(self):
        Handler.claim_status = 307
        result = run_worker(self.port, "local_fixture_noop")
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertEqual(Handler.paths, [f"/internal/v1/jobs/{JOB}/claim"])

    def test_non_origin_api_urls_are_rejected_before_any_request(self):
        for bad in [
            "https://user:pw@example.com",
            "https://example.com/path",
            "https://example.com?x=1",
            "http://example.com",
            "ftp://127.0.0.1",
        ]:
            with self.subTest(bad=bad):
                boot = {
                    "schemaVersion": 1,
                    "apiUrl": bad,
                    "jobId": JOB,
                    "bootstrapToken": TOKEN,
                    "executionRef": REF,
                    "pipeline": "local_fixture_noop",
                }
                code = (
                    "import sys; from stateaction_processing.cli import main; "
                    "sys.argv=['w','run-job','--execution-ref','" + REF + "']; main()"
                )
                result = subprocess.run(
                    [sys.executable, "-c", code],
                    input=json.dumps(boot),
                    capture_output=True,
                    text=True,
                    env={"PATH": os.environ.get("PATH", ""), "APP_ENV": "local"},
                    timeout=60,
                    check=False,
                )
                self.assertEqual(result.returncode, 70, result.stderr)
        self.assertEqual(Handler.paths, [])

    def test_fixture_refused_outside_local(self):
        Handler.claim_status = 200
        result = run_worker(self.port, "local_fixture_noop", app_env="production")
        self.assertEqual(result.returncode, 78, result.stderr)
        self.assertEqual(Handler.paths, [])


if __name__ == "__main__":
    unittest.main()
