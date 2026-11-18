"""The thin Modal wrapper against a fake `modal` module and a fake CLI (SA-42). Nothing is deployed."""

import importlib.util
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

APP_PATH = Path(__file__).parents[1] / "modal_app.py"
CALL = "fc-" + "A1b2C3d4E5f6G7h8I9j0K1"
TOKEN = "sa_svc_" + "A" * 43
JOB = "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e"


class _Chain:
    def __getattr__(self, name):
        return lambda *a, **k: self


def load_wrapper(call_id=CALL):
    """Import modal_app.py with a recording fake `modal` (never the real SDK)."""
    seen = {}
    fake = types.ModuleType("modal")

    class App:
        def __init__(self, name):
            seen["app"] = name

        def function(self, **kwargs):
            seen["function"] = kwargs
            return lambda fn: fn

    fake.App = App
    fake.Image = types.SimpleNamespace(debian_slim=lambda *a, **k: _Chain())
    fake.is_local = lambda: False
    fake.current_function_call_id = lambda: call_id
    previous = sys.modules.get("modal")
    sys.modules["modal"] = fake
    try:
        spec = importlib.util.spec_from_file_location("modal_app_under_test", APP_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        if previous is None:
            del sys.modules["modal"]
        else:
            sys.modules["modal"] = previous
    return module, seen


def fake_cli(directory, exit_code, sleep=0, stray=False):
    """An executable that records argv, stdin and its environment, then exits.

    `stray` leaves a background descendant in the CLI's process group after the leader exits.
    """
    out = Path(directory)
    script = out / "fakepython"
    script.write_text(
        "#!/bin/sh\n"
        f'echo $$ > "{out}/leader"\n'
        f'echo "$@" > "{out}/argv"\n'
        f'cat > "{out}/stdin"\n'
        f'env > "{out}/env"\n'
        + (f'sleep 60 >/dev/null 2>&1 &\necho $! > "{out}/stray"\n' if stray else "")
        + (f"sleep {sleep}\n" if sleep else "")
        + f"exit {exit_code}\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script)


BOOTSTRAP = {
    "schemaVersion": 1,
    "apiUrl": "https://api.example.com",
    "jobId": JOB,
    "bootstrapToken": TOKEN,
    "pipeline": "hand_pose_cpu_v1",
}


def alive(pid):
    """A live process (a zombie awaiting its reaper is gone for our purposes)."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except FileNotFoundError:
        return False
    return state != "Z"


def kill_leftovers(directory):
    for name in ("leader", "stray"):
        path = Path(directory) / name
        if path.exists():
            try:
                os.killpg(int(path.read_text()), 9)
            except (OSError, ValueError):
                pass
            try:
                os.kill(int(path.read_text()), 9)
            except (OSError, ValueError):
                pass


class ModalWrapperTests(unittest.TestCase):
    def test_function_is_finite_cpu_with_explicit_pins_and_no_credentials(self):
        _module, seen = load_wrapper()
        fn = seen["function"]
        self.assertEqual(seen["app"], "stateaction-processing")
        self.assertEqual(fn["retries"], 0)
        self.assertEqual(fn["max_containers"], 1)
        self.assertEqual(fn["min_containers"], 0)
        self.assertEqual(fn["secrets"], [])
        self.assertIs(fn["restrict_modal_access"], True)
        self.assertIs(fn["single_use_containers"], True)
        self.assertIs(fn["nonpreemptible"], True)
        for key in ("cpu", "memory", "ephemeral_disk", "timeout"):
            self.assertIn(key, fn, key)
        self.assertNotIn("gpu", fn)
        # The Modal timeout is only a backstop for the wrapper's own deadline.
        module, _ = load_wrapper()
        self.assertLess(module.WRAPPER_DEADLINE_SECONDS, fn["timeout"])

    def test_bootstrap_reaches_the_cli_only_on_stdin_with_the_call_id(self):
        module, _ = load_wrapper()
        with tempfile.TemporaryDirectory() as d:
            result = module.run_bootstrap(
                json.dumps(BOOTSTRAP),
                CALL,
                python=fake_cli(d, 0),
                env_source={"PATH": os.environ["PATH"]},
            )
            argv = (Path(d) / "argv").read_text()
            stdin = json.loads((Path(d) / "stdin").read_text())
            env = (Path(d) / "env").read_text()
        self.assertEqual(
            result, {"schemaVersion": 1, "functionCallId": CALL, "exitCode": 0}
        )
        self.assertEqual(
            argv.split(),
            ["-m", "stateaction_processing", "run-job", "--execution-ref", CALL],
        )
        self.assertEqual(stdin["bootstrapToken"], TOKEN)
        self.assertEqual(stdin["executionRef"], CALL)
        self.assertEqual(stdin["executorKind"], "modal")
        self.assertNotIn(TOKEN, argv)
        self.assertNotIn(TOKEN, env)

    def test_child_environment_is_scrubbed_of_every_credential(self):
        module, _ = load_wrapper()
        source = {
            "PATH": os.environ["PATH"],
            "MODAL_TOKEN_ID": "ak-secret",
            "MODAL_TOKEN_SECRET": "as-secret",
            "DATABASE_URL": "postgres://u:p@h/db",
            "S3_SECRET_ACCESS_KEY": "r2-secret",
            "RENDER_API_KEY": "rnd_secret",
            "CONTROLLER_CAPABILITY_TOKEN": "sa_svc_x",
            "STATEACTION_HAND_MODEL": "/models/hand_landmarker.task",
        }
        with tempfile.TemporaryDirectory() as d:
            module.run_bootstrap(
                json.dumps(BOOTSTRAP), CALL, python=fake_cli(d, 0), env_source=source
            )
            env = (Path(d) / "env").read_text()
        for secret in (
            "ak-secret",
            "as-secret",
            "postgres://",
            "r2-secret",
            "rnd_secret",
        ):
            self.assertNotIn(secret, env)
        for name in ("MODAL_TOKEN", "DATABASE_URL", "S3_", "RENDER_", "CONTROLLER_"):
            self.assertNotIn(name, env)
        self.assertIn("STATEACTION_HAND_MODEL=/models/hand_landmarker.task", env)

    def test_cli_exit_codes_propagate_in_the_structured_result(self):
        module, _ = load_wrapper()
        for code in (0, 70, 75, 78):
            with self.subTest(code), tempfile.TemporaryDirectory() as d:
                result = module.run_bootstrap(
                    json.dumps(BOOTSTRAP),
                    CALL,
                    python=fake_cli(d, code),
                    env_source={"PATH": os.environ["PATH"]},
                )
                self.assertEqual(result["exitCode"], code)
                self.assertEqual(result["functionCallId"], CALL)

    def test_wrapper_deadline_kills_the_cli_and_still_returns_a_result(self):
        module, _ = load_wrapper()
        with tempfile.TemporaryDirectory() as d:
            result = module.run_bootstrap(
                json.dumps(BOOTSTRAP),
                CALL,
                python=fake_cli(d, 0, sleep=30),
                deadline_seconds=0.5,
                env_source={"PATH": os.environ["PATH"]},
            )
        self.assertEqual(result["exitCode"], -9)  # SIGKILL

    def test_a_stray_descendant_is_killed_and_proven_gone_before_the_result(self):
        module, _ = load_wrapper()
        with tempfile.TemporaryDirectory() as d:
            self.addCleanup(kill_leftovers, d)
            result = module.run_bootstrap(
                json.dumps(BOOTSTRAP),
                CALL,
                python=fake_cli(d, 0, stray=True),
                env_source={"PATH": os.environ["PATH"]},
            )
            stray = int((Path(d) / "stray").read_text())
            self.assertEqual(result["exitCode"], 0)
            self.assertFalse(
                alive(stray), "the stray must be gone before a result exists"
            )

    def test_a_group_that_cannot_be_proven_empty_withholds_the_result(self):
        module, _ = load_wrapper()
        with tempfile.TemporaryDirectory() as d:
            self.addCleanup(kill_leftovers, d)
            with mock.patch.object(module, "_group_members", return_value=[4242]):
                with self.assertRaisesRegex(RuntimeError, "not provably empty"):
                    module.run_bootstrap(
                        json.dumps(BOOTSTRAP),
                        CALL,
                        python=fake_cli(d, 0),
                        reap_grace_seconds=0.3,
                        env_source={"PATH": os.environ["PATH"]},
                    )

    def test_an_unreadable_process_table_withholds_the_result(self):
        module, _ = load_wrapper()
        with tempfile.TemporaryDirectory() as d:
            self.addCleanup(kill_leftovers, d)
            with mock.patch.object(
                module,
                "_group_members",
                side_effect=RuntimeError("process table unreadable"),
            ):
                with self.assertRaisesRegex(RuntimeError, "unreadable"):
                    module.run_bootstrap(
                        json.dumps(BOOTSTRAP),
                        CALL,
                        python=fake_cli(d, 0),
                        env_source={"PATH": os.environ["PATH"]},
                    )

    def test_a_kill_failure_at_the_deadline_withholds_the_result(self):
        module, _ = load_wrapper()
        with tempfile.TemporaryDirectory() as d:
            self.addCleanup(kill_leftovers, d)
            with mock.patch.object(module.os, "killpg", side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    module.run_bootstrap(
                        json.dumps(BOOTSTRAP),
                        CALL,
                        python=fake_cli(d, 0, sleep=30),
                        deadline_seconds=0.3,
                        env_source={"PATH": os.environ["PATH"]},
                    )

    def test_without_a_call_identity_nothing_runs(self):
        module, _ = load_wrapper(call_id=None)
        with tempfile.TemporaryDirectory() as d:
            for bad in (None, "", "local-x", "fc-", "fc-a b"):
                with self.subTest(bad), self.assertRaises(RuntimeError):
                    module.run_bootstrap(
                        json.dumps(BOOTSTRAP), bad, python=fake_cli(d, 0)
                    )
            self.assertFalse((Path(d) / "stdin").exists())

    def test_invalid_or_spoofed_bootstrap_never_starts_the_cli(self):
        module, _ = load_wrapper()
        spoofed = dict(BOOTSTRAP, executionRef="fc-Spoof")
        for raw in ("{", "[]", "x" * 9000, json.dumps(spoofed)):
            with self.subTest(raw[:20]), tempfile.TemporaryDirectory() as d:
                result = module.run_bootstrap(raw, CALL, python=fake_cli(d, 0))
                self.assertEqual(result["exitCode"], module.EXIT_INTERNAL)
                self.assertFalse((Path(d) / "stdin").exists())


if __name__ == "__main__":
    unittest.main()
