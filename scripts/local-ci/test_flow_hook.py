"""SA-130: the best-effort flowlog report and cgroup counters of a gate run. No real flowlog
database is touched: a fake `run` and a fake binary stand in."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

os.environ["FLOWLOG"] = "off"
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import flow_hook  # noqa: E402

RECORD = {
    "runId": "r1",
    "verdict": "FAIL",
    "wallSec": 12.5,
    "head": "h" * 40,
    "tree": "t" * 40,
    "logDir": "/logs/r1",
    "stages": [
        {
            "id": "a",
            "status": "passed",
            "durationSec": 1.5,
            "cache": {"hits": 1, "tasks": 2},
        },
        {"id": "b", "status": "failed", "durationSec": 2.0},
    ],
}


class Recorder:
    def __init__(self, code: int = 0):
        self.code, self.argv, self.input = code, None, None

    def __call__(self, argv, **kw):
        if argv[0] == "git":
            return subprocess.CompletedProcess(argv, 0, "wanghujie/sa-130-x\n", "")
        self.argv, self.input = argv, kw.get("input")
        return subprocess.CompletedProcess(argv, self.code, "", "")


class FlowHookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sa130-fh-"))
        self.addCleanup(subprocess.run, ["rm", "-rf", str(self.tmp)])
        self.fake = self.tmp / "flowlog"
        self.fake.write_text("#!/bin/sh\n")
        self.fake.chmod(0o755)
        self._flowlog = os.environ.get("FLOWLOG")
        self.addCleanup(os.environ.__setitem__, "FLOWLOG", self._flowlog or "off")

    def test_a_skipped_stage_is_never_reported_as_the_failing_stage(self):
        os.environ["FLOWLOG"] = str(self.fake)
        rec = Recorder()
        record = {
            **RECORD,
            "stages": [
                {"id": "mobile", "status": "skipped", "durationSec": 0.0},
                *RECORD["stages"][1:],
            ],
        }
        self.assertTrue(flow_hook.report_ci_run(record, repo=self.tmp, run=rec))
        self.assertEqual(rec.argv[rec.argv.index("--failing-stage") + 1], "b")

    def test_report_sends_the_run_with_ticket_failing_stage_and_stages_on_stdin(self):
        os.environ["FLOWLOG"] = str(self.fake)
        rec = Recorder()
        self.assertTrue(flow_hook.report_ci_run(RECORD, repo=self.tmp, run=rec))
        argv = rec.argv
        self.assertEqual(argv[:2], [str(self.fake), "ci-run"])
        for flag, value in (
            ("--run-id", "r1"),
            ("--verdict", "fail"),
            ("--wall", "12.5"),
            ("--ticket", "SA-130"),
            ("--failing-stage", "b"),
            ("--branch", "wanghujie/sa-130-x"),
            ("--mode", "ci:local"),
        ):
            self.assertEqual(argv[argv.index(flag) + 1], value)
        self.assertEqual(argv[argv.index("--stages") + 1], "-")
        stages = json.loads(rec.input)
        self.assertEqual(
            [(s["stage"], s["wall_s"], s["status"]) for s in stages],
            [("a", 1.5, "passed"), ("b", 2.0, "failed")],
        )
        self.assertEqual((stages[0]["cache_hits"], stages[0]["cache_tasks"]), (1, 2))

    def test_verdicts_map(self):
        os.environ["FLOWLOG"] = str(self.fake)
        for verdict, expected in (
            ("PASS", "pass"),
            ("INTERRUPTED", "cancelled"),
            ("FAIL", "fail"),
        ):
            rec = Recorder()
            flow_hook.report_ci_run(
                {**RECORD, "verdict": verdict}, repo=self.tmp, run=rec
            )
            self.assertEqual(rec.argv[rec.argv.index("--verdict") + 1], expected)

    def test_missing_flowlog_is_not_an_error(self):
        os.environ["FLOWLOG"] = "off"
        rec = Recorder()
        self.assertFalse(flow_hook.report_ci_run(RECORD, repo=self.tmp, run=rec))
        self.assertIsNone(rec.argv)

    def test_failing_or_crashing_flowlog_never_raises(self):
        os.environ["FLOWLOG"] = str(self.fake)
        self.assertFalse(
            flow_hook.report_ci_run(RECORD, repo=self.tmp, run=Recorder(code=3))
        )

        def boom(*_a, **_k):
            raise subprocess.TimeoutExpired("flowlog", 20)

        self.assertFalse(flow_hook.report_ci_run(RECORD, repo=self.tmp, run=boom))

    def test_pass_never_names_a_failing_stage_and_the_token_is_scrubbed(self):
        os.environ["FLOWLOG"] = str(self.fake)
        seen = {}
        recorder = Recorder()

        def rec(argv, **kw):
            seen.update(kw)
            return recorder(argv, **kw)

        mixed = {**RECORD, "verdict": "PASS"}
        with unittest.mock.patch.dict(os.environ, {"GH_TOKEN": "secret"}):
            flow_hook.report_ci_run(mixed, repo=self.tmp, run=rec)
        self.assertNotIn("--failing-stage", recorder.argv)
        self.assertNotIn("GH_TOKEN", seen["env"])
        self.assertIs(seen["stdout"], subprocess.DEVNULL)

    def test_ticket_of_branch(self):
        self.assertEqual(flow_hook.ticket_of("wanghujie/sa-130-close"), "SA-130")
        self.assertIsNone(flow_hook.ticket_of("main"))
        self.assertIsNone(flow_hook.ticket_of(None))

    def test_counters_of_scope_and_shared_slice(self):
        work = self.tmp / "user.slice" / "agent-work.slice"
        scope = work / "agent-lane-ci-x.scope"
        scope.mkdir(parents=True)
        (work / "pids.current").write_text("40\n")
        (work / "pids.max").write_text("8192\n")
        (work / "pids.events").write_text("max 717\n")
        (work / "memory.events").write_text("low 0\nhigh 3\nmax 0\noom 0\noom_kill 1\n")
        (scope / "pids.current").write_text("7\n")
        (scope / "pids.max").write_text("max\n")
        got = flow_hook.guard_counters({"cgroup": str(scope)})
        self.assertEqual(got["slice"]["pidsCurrent"], 40)
        self.assertEqual(got["slice"]["pidsMax"], 8192)
        self.assertEqual(got["slice"]["pidsEventsMax"], 717)
        self.assertEqual(got["slice"]["memoryEvents"]["oom_kill"], 1)
        self.assertEqual(got["scope"]["pidsMax"], "max")
        self.assertIsNone(got["scope"]["pidsEventsMax"])  # unreadable file: None, not 0

    def test_counters_without_a_proof_are_empty(self):
        self.assertEqual(flow_hook.guard_counters({}), {})


if __name__ == "__main__":
    unittest.main()
