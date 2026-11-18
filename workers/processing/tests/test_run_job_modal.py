"""Modal claim shape and bootstrap rules of the shared worker CLI (SA-42). No network."""

import io
import json
import os
import sys
import unittest
from unittest import mock

from stateaction_processing import run_job

JOB = "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e"
TOKEN = "sa_svc_" + "A" * 43
CALL = "fc-" + "A1b2C3d4E5f6G7h8I9j0K1"


def boot(**changes):
    value = {
        "schemaVersion": 1,
        "apiUrl": "https://api.example.com",
        "jobId": JOB,
        "bootstrapToken": TOKEN,
        "executionRef": CALL,
        "pipeline": "hand_pose_cpu_v1",
        "executorKind": "modal",
    }
    value.update(changes)
    return value


def run_with(value, ref=CALL):
    """Feed `value` as stdin to run(); returns (exit code, recorded _post calls)."""
    posts = []

    def fake_post(url, token, body):
        posts.append((url, token, body))
        raise ValueError("claim lost")  # a lost claim: nothing after it may run

    stdin = mock.Mock()
    stdin.buffer = io.BytesIO(json.dumps(value).encode())
    with (
        mock.patch.object(sys, "stdin", stdin),
        mock.patch.object(run_job, "_post", fake_post),
        mock.patch.object(
            run_job.importlib, "import_module", side_effect=AssertionError("imported")
        ),
    ):
        code = run_job.main(ref)
    return code, posts


class ModalWorkerTests(unittest.TestCase):
    def test_modal_claim_names_the_call_id_and_precedes_every_import(self):
        code, posts = run_with(boot())
        self.assertEqual(code, run_job.EXIT_CLAIM_LOST)
        self.assertEqual(len(posts), 1)
        url, token, body = posts[0]
        self.assertEqual(url, f"https://api.example.com/internal/v1/jobs/{JOB}/claim")
        self.assertEqual(token, TOKEN)
        self.assertEqual(body["executor"], {"kind": "modal", "functionCallId": CALL})
        self.assertEqual(
            set(body), {"schemaVersion", "jobId", "invocationNonce", "executor"}
        )

    def test_local_default_is_unchanged(self):
        value = boot(executionRef="local-test-ref")
        del value["executorKind"]
        with mock.patch.dict("os.environ", {"APP_ENV": "local"}):
            code, posts = run_with(value, ref="local-test-ref")
        self.assertEqual(code, run_job.EXIT_CLAIM_LOST)
        self.assertEqual(
            posts[0][2]["executor"],
            {"kind": "local", "localExecutionRef": "local-test-ref"},
        )

    def test_kind_and_reference_shape_must_agree(self):
        for name, value, ref in [
            ("modal kind, local ref", boot(executionRef="local-x"), "local-x"),
            ("local kind, call id", boot(executorKind="local"), CALL),
            ("unknown kind", boot(executorKind="gpu"), CALL),
        ]:
            with self.subTest(name):
                code, posts = run_with(value, ref=ref)
                self.assertEqual(code, run_job.EXIT_INTERNAL)
                self.assertEqual(posts, [])

    def test_modal_refuses_loopback_http_and_fixture_before_any_claim(self):
        for name, value in [
            ("loopback", boot(apiUrl="http://127.0.0.1:9")),
            ("localhost https", boot(apiUrl="https://localhost")),
            ("fixture pipeline", boot(pipeline="local_fixture_noop")),
        ]:
            with self.subTest(name):
                code, posts = run_with(value)
                self.assertEqual(code, run_job.EXIT_INTERNAL)
                self.assertEqual(posts, [])

    def test_mismatched_bootstrap_ref_is_rejected(self):
        code, posts = run_with(boot(executionRef="fc-Other"), ref=CALL)
        self.assertEqual(code, run_job.EXIT_INTERNAL)
        self.assertEqual(posts, [])


class RuntimeIdentityTests(unittest.TestCase):
    """Modal only: the baked build identity is compared with the claim before any source read."""

    DIGESTS = {
        "codeRevision": "rev-1",
        "imageSpecSha256": "1" * 64,
        "modelSha256": "2" * 64,
    }

    def check(self, kind, env, model_sha="2" * 64):
        from types import SimpleNamespace

        from stateaction_processing import hand_model, hand_pose_cpu_v1

        with (
            mock.patch.dict(os.environ, env, clear=False),
            mock.patch.object(
                hand_model,
                "resolve_model",
                return_value=SimpleNamespace(sha256=model_sha),
            ) as resolve,
        ):
            hand_pose_cpu_v1._check_runtime_identity(
                self.DIGESTS, {"executorKind": kind}
            )
        return resolve

    GOOD = {
        "STATEACTION_CODE_REVISION": "rev-1",
        "STATEACTION_IMAGE_SPEC_SHA256": "1" * 64,
    }

    def test_local_runs_keep_their_behaviour_and_do_not_compare(self):
        resolve = self.check("local", {})
        resolve.assert_not_called()

    def test_matching_modal_identity_verifies_the_model_bytes(self):
        resolve = self.check("modal", self.GOOD)
        resolve.assert_called_once()

    def test_any_mismatch_or_missing_identity_fails_before_a_source_read(self):
        from stateaction_processing.artifact_types import ExportError

        for name, env in [
            ("revision", {**self.GOOD, "STATEACTION_CODE_REVISION": "rev-2"}),
            ("image spec", {**self.GOOD, "STATEACTION_IMAGE_SPEC_SHA256": "3" * 64}),
        ]:
            with self.subTest(name), self.assertRaises(ExportError) as caught:
                self.check("modal", env)
            self.assertEqual(caught.exception.code, "E_RUNTIME_IDENTITY_MISMATCH")
        with self.subTest("missing"), mock.patch.dict(os.environ, self.GOOD):
            os.environ.pop("STATEACTION_CODE_REVISION")
            with self.assertRaises(ExportError):
                self.check("modal", {})
        with self.subTest("model digest"), self.assertRaises(ExportError):
            self.check("modal", self.GOOD, model_sha="9" * 64)


if __name__ == "__main__":
    unittest.main()
