"""SA-94 stage function settings and the stage CLI wrapper (stdlib only, no GPU, no Modal)."""

import hashlib
import json
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1]))
from flora_ext import pins, stage_settings, stage_wrapper  # noqa: E402

RECIPE = (
    HERE.parents[3]
    / "packages/contracts/conformance/fixtures/contracts/jobs.recipe.v1.json"
)
CALL = "fc-01HZ0000000000000000000000"


class SettingsTests(unittest.TestCase):
    def test_function_settings_are_the_ticket_settings(self):
        for name in ("flora_tempseg", "flora_captioner"):
            opts = stage_settings.function_options(name, {})
            self.assertEqual(opts["gpu"], "RTX-PRO-6000")
            self.assertEqual(
                {k: opts[k] for k in ("retries", "max_containers", "min_containers")},
                {"retries": 0, "max_containers": 1, "min_containers": 0},
            )
            self.assertIs(opts["single_use_containers"], True)
            self.assertIs(opts["restrict_modal_access"], True)
            self.assertEqual(opts["secrets"], [])

    def test_timeouts_come_from_the_default_recipe_budgets(self):
        recipe = next(
            c["input"]["document"]
            for c in json.loads(RECIPE.read_text())["cases"]
            if c["name"] == "default FLORA fp8 recipe"
        )
        budgets = {
            s["stage"]: s["resources"]["budgetSeconds"] for s in recipe["stages"]
        }
        self.assertEqual(
            stage_settings.budget_s("flora_tempseg", {}), budgets["segment"]
        )
        self.assertEqual(
            stage_settings.budget_s("flora_captioner", {}), budgets["caption"]
        )
        self.assertEqual(
            stage_settings.function_options("flora_tempseg", {})["timeout"],
            budgets["segment"],
        )

    def test_deploy_time_budget_is_bounded(self):
        self.assertEqual(
            stage_settings.budget_s("flora_tempseg", {"FLORA_SEGMENT_BUDGET_S": "900"}),
            900,
        )
        for bad in ("10", "99999"):
            with self.assertRaises(ValueError):
                stage_settings.budget_s(
                    "flora_tempseg", {"FLORA_SEGMENT_BUDGET_S": bad}
                )

    def test_bounded_deployment_has_hard_container_limits(self):
        options = stage_settings.function_options(
            "flora_tempseg", {"FLORA_STAGE_BOUNDED": "1"}
        )
        self.assertEqual(options["cpu"], (stage_settings.CPU, stage_settings.CPU))
        self.assertEqual(
            options["memory"], (stage_settings.MEMORY_MIB, stage_settings.MEMORY_MIB)
        )
        self.assertEqual(options["startup_timeout"], 60)
        self.assertEqual(options["scaledown_window"], 10)
        self.assertEqual(options["retries"], 0)
        self.assertEqual(options["max_containers"], 1)

    def test_the_stage_modules_name_the_stage_functions(self):
        self.assertEqual(
            set(stage_settings.STAGE_OF), {"flora_tempseg", "flora_captioner"}
        )
        self.assertEqual(
            {m for m, _ in pins.MODULES.values()}, {"tempseg", "captioner"}
        )

    def test_the_hand_pose_function_keeps_its_default_route(self):
        src = (HERE.parents[2] / "processing" / "modal_app.py").read_text()
        self.assertIn('DEFAULT_APP_NAME = "stateaction-processing"', src)
        self.assertIn('FUNCTION_NAME = "process_recording"', src)
        self.assertNotIn("flora", src.lower())
        self.assertNotEqual(stage_settings.APP_NAME, "stateaction-processing")

    def test_the_deployable_app_has_exactly_the_two_production_functions(self):
        src = (HERE.parents[1] / "modal_stage.py").read_text()
        code = src.split("from __future__ import annotations", 1)[1]
        self.assertEqual(src.count("@app.function("), 2)
        for forbidden in ("fixtures", "smoke", "STATEACTION_IO_DIR_HARNESS", "dry_run"):
            self.assertNotIn(forbidden, code, forbidden)
        self.assertIn("stage_settings.function_options(name)", src)
        self.assertIn('{"/models": models.read_only()}', code)

    def test_image_dependencies_are_pinned(self):
        src = (HERE.parents[1] / "modal_stage.py").read_text()
        for pinned in (
            "huggingface_hub==",
            "hf_xet==",
            "psutil==",
            "peft==",
            "accelerate==",
            "av==",
            "jsonschema==",
        ):
            self.assertIn(pinned, src)

    def test_controller_seam_comes_from_one_config(self):
        modules = json.loads(
            (HERE.parents[3] / "packages/contracts/api/modules.json").read_text()
        )["modules"]
        flora = {
            m["moduleId"]: m["stage"]
            for m in modules
            if m["moduleId"].startswith("flora_")
        }
        self.assertEqual(set(stage_settings.FUNCTION_OF_MODULE), set(flora))
        for module, function in stage_settings.FUNCTION_OF_MODULE.items():
            self.assertIn(function, stage_settings.STAGE_OF)
            self.assertEqual(stage_settings.STAGE_OF[function], flora[module])
        env = stage_settings.controller_env()
        pairs = dict(p.split("=") for p in env["MODAL_STAGE_FUNCTIONS"].split(","))
        app = stage_settings.APP_NAME
        self.assertEqual(pairs["flora_tempseg_hf@1"], f"{app}/flora_tempseg")
        self.assertEqual(pairs["flora_captioner_vllm_fp8@1"], f"{app}/flora_captioner")
        self.assertEqual(set(env), {"MODAL_STAGE_FUNCTIONS"})
        self.assertEqual(
            env["MODAL_STAGE_FUNCTIONS"],
            "flora_captioner_hf@1=stateaction-flora-stages/flora_captioner,"
            "flora_captioner_vllm_fp8@1=stateaction-flora-stages/flora_captioner,"
            "flora_tempseg_hf@1=stateaction-flora-stages/flora_tempseg,"
            "flora_tempseg_vllm_fp8@1=stateaction-flora-stages/flora_tempseg",
        )

    def test_app_name_is_configurable_in_one_place(self):
        code = (
            "import sys; sys.path.insert(0, %r); from flora_ext import stage_settings as s; print(s.APP_NAME)"
            % str(HERE.parents[1])
        )
        import subprocess

        out = subprocess.run(
            [sys.executable, "-c", code],
            env={**os.environ, "FLORA_STAGE_APP_NAME": "custom-flora"},
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(out, "custom-flora")


class WrapperTests(unittest.TestCase):
    def python_stub(self, tmp: Path, body: str) -> str:
        """An executable stand-in for `python`: reads argv/stdin and does `body`."""
        script = tmp / "fake_python"
        script.write_text(f"#!{sys.executable}\nimport sys, json, os\n{body}\n")
        script.chmod(0o755)
        return str(script)

    def test_bootstrap_gets_call_id_and_executor_and_goes_to_stdin_only(self):
        fixture = RECIPE.with_name("jobs.stage-receipt.v1.json")
        receipt = json.loads(fixture.read_text())["cases"][0]["input"]["document"]
        receipt["jobId"] = "00573d25-ffa0-4a3f-b1e2-134080fb58fb"
        with tempfile.TemporaryDirectory() as tmp:
            record = Path(tmp) / "record.json"
            stub = self.python_stub(
                Path(tmp),
                f"json.dump(dict(argv=sys.argv[1:], stdin=json.loads(sys.stdin.read()), "
                f"env=sorted(k for k in os.environ if k.startswith('MODAL_'))), open({str(record)!r}, 'w'))\n"
                f"json.dump({receipt!r}, open(os.environ['STATEACTION_STAGE_RECEIPT_FILE'], 'x'))",
            )
            result = stage_wrapper.run_stage_bootstrap(
                json.dumps(
                    {
                        "apiUrl": "https://api.example.com",
                        "jobId": "00573d25-ffa0-4a3f-b1e2-134080fb58fb",
                        "stage": "segment",
                        "module": "flora_tempseg_vllm_fp8@1",
                        "bootstrapToken": "synthetic-bootstrap",
                    }
                ),
                CALL,
                deadline_s=30,
                python=stub,
                env_source={"PATH": os.environ["PATH"], "MODAL_TOKEN_SECRET": "x"},
            )
            seen = json.loads(record.read_text())
        self.assertEqual(
            result,
            {
                "schemaVersion": 2,
                "functionCallId": CALL,
                "exitCode": 0,
                "receipt": receipt,
                "callBinding": hashlib.sha256(
                    b"https://api.example.com\n00573d25-ffa0-4a3f-b1e2-134080fb58fb\nsegment\nflora_tempseg_vllm_fp8@1\n"
                    + hashlib.sha256(b"synthetic-bootstrap").hexdigest().encode()
                ).hexdigest(),
            },
        )
        self.assertEqual(
            seen["argv"], ["-m", "stateaction_processing", "run-stage", CALL]
        )
        self.assertEqual(seen["stdin"]["executionRef"], CALL)
        self.assertEqual(seen["stdin"]["executorKind"], "modal")
        self.assertEqual(seen["env"], [], "no Modal credential reaches the stage")
        self.assertNotIn("bootstrap", " ".join(seen["argv"]))

    def test_a_json_diagnostic_is_not_a_stage_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            stub = self.python_stub(
                Path(tmp),
                "sys.stdin.read()\nprint(json.dumps({'kind': 'progress'}))\nsys.exit(70)",
            )
            result = stage_wrapper.run_stage_bootstrap(
                "{}", CALL, deadline_s=5, python=stub
            )
        self.assertEqual(
            result,
            {
                "schemaVersion": 2,
                "functionCallId": CALL,
                "exitCode": 70,
                "receipt": None,
            },
        )

    def test_caller_may_not_set_the_execution_identity(self):
        for forbidden in ({"executionRef": "fc-x"}, {"executorKind": "local"}):
            result = stage_wrapper.run_stage_bootstrap(
                json.dumps(forbidden), CALL, deadline_s=5, python="/bin/false"
            )
            self.assertEqual(result["exitCode"], stage_wrapper.EXIT_INTERNAL)
            self.assertEqual(result["schemaVersion"], 2)
            self.assertIsNone(result["receipt"])
        oversized = stage_wrapper.run_stage_bootstrap(
            json.dumps({"x": "y" * 9000}), CALL, deadline_s=5, python="/bin/false"
        )
        self.assertEqual(oversized["exitCode"], stage_wrapper.EXIT_INTERNAL)

    def test_missing_call_identity_runs_nothing(self):
        with self.assertRaises(RuntimeError):
            stage_wrapper.run_stage_bootstrap(
                "{}", None, deadline_s=5, python="/bin/false"
            )

    def test_a_stage_past_its_deadline_is_killed_with_its_children(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / "child.pid"
            stub = self.python_stub(
                Path(tmp),
                "import subprocess, time\n"
                f"p = subprocess.Popen(['sleep', '600']); open({str(pidfile)!r}, 'w').write(str(p.pid))\n"
                "time.sleep(600)",
            )
            started = time.monotonic()
            result = stage_wrapper.run_stage_bootstrap(
                "{}", CALL, deadline_s=1.5, python=stub, reap_grace_s=10
            )
            elapsed = time.monotonic() - started
            self.assertEqual(
                result,
                {
                    "schemaVersion": 2,
                    "functionCallId": CALL,
                    "exitCode": -signal.SIGKILL,
                    "receipt": None,
                },
            )
            self.assertLess(elapsed, 20)
            pid = int(pidfile.read_text())
            # A killed orphan may stay a zombie until its subreaper waits for it (as in a service scope),
            # and `kill(pid, 0)` succeeds on a zombie: dead means missing or in state Z, the wrapper's rule.
            until = time.monotonic() + 5
            while self.alive(pid) and time.monotonic() < until:
                time.sleep(0.05)
            self.assertFalse(self.alive(pid))

    @staticmethod
    def alive(pid: int) -> bool:
        try:
            raw = Path(f"/proc/{pid}/stat").read_text()
        except FileNotFoundError:
            return False
        return raw[raw.rindex(")") + 2 :].split()[0] != "Z"

    def test_io_dir_harness_flag_is_set_only_there(self):
        with tempfile.TemporaryDirectory() as tmp:
            stub = self.python_stub(
                Path(tmp),
                "d = sys.argv[-1]\n"
                "open(d + '/seen.json', 'w').write(json.dumps(dict(argv=sys.argv[1:-1], "
                "flag=os.environ.get('STATEACTION_IO_DIR_HARNESS'))))",
            )
            result = stage_wrapper.run_io_dir(
                {"bootstrap.json": b"{}", "source.mcap": b"x"},
                deadline_s=30,
                python=stub,
            )
        self.assertEqual(result["exitCode"], 0)
        seen = json.loads(result["files"]["seen.json"])
        self.assertEqual(seen["flag"], "1")
        self.assertEqual(
            seen["argv"], ["-m", "stateaction_processing", "run-stage", "--io-dir"]
        )
        self.assertNotIn(
            "bootstrap.json", result["files"], "inputs are not echoed back"
        )
        with self.assertRaises(ValueError):
            stage_wrapper.run_io_dir(
                {"../escape": b"x"}, deadline_s=5, python=sys.executable
            )
        self.assertNotIn(
            "STATEACTION_IO_DIR_HARNESS", stage_wrapper.child_env({"A": "1"})
        )


if __name__ == "__main__":
    unittest.main()


class SmokeHelperTests(unittest.TestCase):
    def test_limit_segment_rows_keeps_the_first_rows_and_rejects_bad_counts(self):
        from flora_ext import stage_smoke

        doc = {"schema": "x", "rows": [{"ordinal": n} for n in range(5)]}
        raw = json.dumps(doc).encode()
        out = json.loads(stage_smoke.limit_segment_rows(raw, 3))
        self.assertEqual([r["ordinal"] for r in out["rows"]], [0, 1, 2])
        self.assertEqual(out["schema"], "x")
        for bad in (0, 6):
            with self.assertRaises(ValueError):
                stage_smoke.limit_segment_rows(raw, bad)
