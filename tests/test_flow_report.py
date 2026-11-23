"""scripts/flow-report.py (SA-126): numbers computed from the real agentqueue snapshot
(/home/wearaway/flora-work/metrics/agentqueue-snapshot-20261123, copied to fixtures/flow_report/state)."""

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures" / "flow_report"
SPEC = importlib.util.spec_from_file_location(
    "flow_report", ROOT / "scripts" / "flow-report.py"
)
fr = importlib.util.module_from_spec(SPEC)
sys.modules["flow_report"] = fr
SPEC.loader.exec_module(fr)

SINCE, UNTIL = "2026-11-22T23:00:00Z", "2026-11-23T04:00:00Z"
T = fr.parse_iso


def args(**over):
    base = dict(
        since=SINCE,
        until=UNTIL,
        now=None,
        lane_log="/nonexistent",
        state_dir=str(FIX / "state"),
        ci_home=str(FIX / "ci-home"),
        handoff="/nonexistent",
        repo="/nonexistent",
        gh_json=str(FIX / "gh-prs.json"),
        no_gh=False,
        lanes_only=False,
        events="/nonexistent",
    )
    base.update(over)
    return argparse.Namespace(**base)


def by_ticket(data):
    return {t["ticket"]: t for t in data["tickets"]}


class TicketEventTests(unittest.TestCase):
    """ticketlog events: small copy of real backfilled lines (SA-124, SA-109) plus one synthetic full lifecycle."""

    @classmethod
    def setUpClass(cls):
        cls.data = fr.build_data(
            args(
                since="2026-11-01T00:00:00Z",
                until="2027-01-01T00:00:00Z",
                events=str(FIX / "ticket-events.jsonl"),
            )
        )
        cls.rows = {r["ticket"]: r for r in cls.data["event_flow"]}

    def test_phase_durations_of_a_full_lifecycle(self):
        r = self.rows["SA-900"]
        self.assertEqual(r["total"], 4520)
        self.assertEqual((r["implementation"], r["review"], r["fix"]), (1500, 900, 600))
        self.assertEqual((r["queue_wait"], r["gate"], r["merge"]), (60, 840, 20))

    def test_biggest_idle_gaps(self):
        gaps = self.rows["SA-900"]["gaps"]
        self.assertEqual(
            (gaps[0]["gap"], gaps[0]["from"], gaps[0]["to"]),
            (1500, "start", "code_ready"),
        )
        self.assertEqual(len(gaps), 3)

    def test_backfilled_ticket_has_missing_phases_not_zero(self):
        r = self.rows["SA-124"]
        self.assertEqual(r["total"], 1795396104.0 - 1795388185.0)
        self.assertIsNone(r["queue_wait"])
        self.assertIsNone(r["gate"])
        self.assertIsNone(r["review"])  # no code_ready/review_start logged

    def test_report_text_and_window(self):
        text = fr.render(self.data)
        self.assertIn("Start-to-merge time per ticket", text)
        self.assertIn("| SA-900 |", text)
        self.assertIn(
            "1500s start->code_ready".replace("1500s", fr.fmt_dur(1500)), text
        )
        empty = fr.build_data(
            args(
                since="2027-01-01T00:00:00Z",
                until="2027-02-01T00:00:00Z",
                events=str(FIX / "ticket-events.jsonl"),
            )
        )
        self.assertEqual(empty["event_flow"], [])


class FlowReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = fr.build_data(args())

    def test_known_snapshot_numbers(self):
        mix = {m["label"]: m for m in self.data["mix"]}
        gate = mix["pnpm ci:local"]
        self.assertEqual(
            (gate["count"], gate["finished"], gate["cancelled"], gate["passes"]),
            (8, 7, 1, 1),
        )
        self.assertAlmostEqual(gate["median_run"], 717.09, places=2)  # about 717 s
        self.assertEqual(mix["local_ci.py run"]["count"], 10)
        self.assertEqual(mix["local_ci.py run"]["passes"], 5)
        self.assertEqual(mix["local_ci.py merge"]["count"], 6)
        sa124 = by_ticket(self.data)["SA-124"]
        self.assertEqual(
            (sa124["attempts"], sa124["passes"], sa124["fails"], sa124["cancels"]),
            (6, 1, 4, 1),
        )
        self.assertEqual(len(sa124["partial"]), 2)

    def test_ci_lane_utilization(self):
        ci = self.data["lanes"]["ci"]
        self.assertEqual(
            (ci["count"], ci["pass"], ci["fail"], ci["cancel"]), (39, 25, 12, 2)
        )
        self.assertAlmostEqual(ci["busy_fraction"], 0.8076, places=3)
        self.assertAlmostEqual(ci["span_s"], 13177.15, places=1)
        self.assertAlmostEqual(ci["run_max"], 1048.02, places=1)
        self.assertAlmostEqual(ci["wait_max"], 0.54, places=2)
        start, end = ci["longest_idle"]
        self.assertAlmostEqual(end - start, 443.5, places=1)  # 7m23s at 01:40Z
        self.assertEqual(fr.fmt_ts(start), "11-23 01:40Z")

    def test_failures_name_the_failing_stage_and_cost(self):
        tickets = by_ticket(self.data)
        stages = {n: [f["stage"] for f in t["failures"]] for n, t in tickets.items()}
        self.assertEqual(
            stages["SA-124"],
            ["server-tooling", "web-auth-e2e", "web-auth-e2e", "web-auth-e2e"],
        )
        self.assertEqual(stages["SA-120"], ["runtime-smoke", "runtime-smoke"])
        self.assertEqual(stages["SA-97"], ["web-auth-e2e"])
        self.assertEqual(
            stages["SA-112"], ["unknown (run recorded no stage)"]
        )  # failed in 1 s: its run has no stages
        self.assertAlmostEqual(tickets["SA-124"]["wasted"], 2372.3, places=1)
        self.assertAlmostEqual(tickets["SA-120"]["wasted"], 1898.9, places=1)
        self.assertAlmostEqual(
            tickets["SA-120"]["failures"][0]["reached_at"], 925.02, places=1
        )
        self.assertEqual(sum(len(t["failures"]) for t in tickets.values()), 9)
        self.assertAlmostEqual(
            sum(t["wasted"] for t in tickets.values()), 4868.0, delta=1.0
        )

    def test_gh_join_gives_merge_latency_and_merge_time(self):
        t = by_ticket(self.data)
        self.assertEqual(t["SA-124"]["pr"], 67)
        self.assertEqual(t["SA-124"]["merge_latency"], 7196)
        self.assertEqual(t["SA-109"]["merge_latency"], 11)
        self.assertEqual(t["SA-120"]["merged"], T("2026-11-23T03:17:26Z"))
        self.assertAlmostEqual(t["SA-124"]["queue_wait"], 3.3, places=1)

    def test_candidates_come_from_the_data(self):
        text = " ".join(self.data["candidates"])
        self.assertIn("across 9 failed runs", text)
        self.assertIn("`web-auth-e2e` failed 4 times", text)
        self.assertIn("2 gate submissions failed within 30s", text)
        self.assertIn("14 non-gate jobs", text)
        self.assertIn("not the bottleneck", text)

    def test_report_markdown_names_the_known_numbers(self):
        md = fr.render(self.data)
        self.assertIn("| pnpm ci:local | 8 | 7 | 1 | 11m57s | 1 |", md)
        self.assertIn("| SA-124 | #67 |", md)
        self.assertIn("6 (1 pass, 4 fail, 1 cancelled) +2 partial", md)
        self.assertIn("## Improvement candidates", md)
        self.assertIn("read directly from agentqueue state dir", md)

    def test_window_limits_the_records(self):
        data = fr.build_data(args(since="2026-11-23T01:00:00Z", lanes_only=True))
        self.assertTrue(
            all(r["submitted"] >= T("2026-11-23T01:00:00Z") for r in data["records"])
        )
        self.assertNotIn("tickets", data)

    def test_relative_since_uses_now(self):
        data = fr.build_data(
            args(since="1h", until=None, now=T("2026-11-23T04:00:00Z"), lanes_only=True)
        )
        self.assertTrue(data["records"])
        self.assertTrue(
            all(r["submitted"] >= T("2026-11-23T03:00:00Z") for r in data["records"])
        )


class TimezoneIndependenceTests(unittest.TestCase):
    def test_numbers_do_not_depend_on_the_readers_timezone(self):
        old = os.environ.get("TZ")
        self.addCleanup(
            lambda: (
                os.environ.__setitem__("TZ", old)
                if old is not None
                else os.environ.pop("TZ", None),
                __import__("time").tzset(),
            )
        )
        seen = []
        for zone in ("UTC", "Asia/Tokyo", "America/New_York"):
            os.environ["TZ"] = zone
            __import__("time").tzset()
            data = fr.build_data(args())
            tickets = by_ticket(data)
            seen.append(
                (
                    [f["stage"] for f in tickets["SA-112"]["failures"]],
                    {n: t["wasted"] for n, t in tickets.items()},
                    sum(len(t["failures"]) for t in tickets.values()),
                )
            )
        self.assertEqual(seen[0], seen[1])
        self.assertEqual(seen[0], seen[2])
        self.assertEqual(seen[0][0], ["unknown (run recorded no stage)"])
        self.assertEqual(seen[0][2], 9)

    def test_run_without_run_json_uses_log_mtimes_not_the_run_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "logs" / "20991231T235959-abcdef"  # run id says year 2099
            run.mkdir(parents=True)
            for name, when in (
                ("toolchain.log", 1_795_400_000),
                ("server-tooling.log", 1_795_400_100),
            ):
                (run / name).write_text("x")
                os.utime(run / name, (when, when))
            runs = fr.scan_ci_runs(Path(tmp))
        self.assertEqual(
            (runs[0]["start"], runs[0]["finished"]), (1_795_400_000, 1_795_400_100)
        )
        self.assertEqual(
            fr.failing_stage(runs[0])[0], "server-tooling (last log; run unfinished)"
        )


class FixtureHygieneTests(unittest.TestCase):
    def test_fixtures_hold_no_environment_dumps(self):
        files = [p for p in FIX.rglob("*") if p.is_file()]
        self.assertTrue(files)
        self.assertEqual(
            [p for p in files if p.suffix == ".env" or p.name.startswith(".env")], []
        )
        for p in files:
            if p.suffix in (".json", ".jsonl") or p.parent.name == "res":
                continue
            self.fail(f"unexpected fixture file {p}")
        for p in FIX.rglob("*"):
            if p.is_file() and p.suffix == ".json" and p.parent.name == "jobs":
                self.assertNotIn(
                    "SSH_AUTH_SOCK=", p.read_text()
                )  # names in pass_env only, never values


class AttributionTests(unittest.TestCase):
    def test_gates_outside_a_ticket_worktree_are_reported_unattributed(self):
        data = fr.build_data(args())
        cwds = {r["cwd"].split("/")[-1] for r in data["unattributed"]}
        self.assertTrue(all(r["info"]["kind"] == "gate" for r in data["unattributed"]))
        self.assertNotIn("SA-124", [r["ticket"] for r in data["unattributed"]])
        self.assertIsInstance(cwds, set)
        md = fr.render(data)
        if data["unattributed"]:
            self.assertIn("## Unattributed gate runs", md)

    def test_all_prs_of_a_ticket_are_shown_newest_merged_first(self):
        prs = json.loads((FIX / "gh-prs.json").read_text())
        dup = dict(
            next(p for p in prs if p["number"] == 72),
            number=99,
            mergedAt=None,
            state="CLOSED",
            createdAt="2026-11-23T03:00:00Z",
        )
        old = dict(
            next(p for p in prs if p["number"] == 72),
            number=50,
            mergedAt="2026-11-20T00:00:00Z",
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prs.json"
            path.write_text(json.dumps(prs + [dup, old]))
            data = fr.build_data(args(gh_json=str(path)))
        t = by_ticket(data)["SA-120"]
        self.assertEqual(t["prs"][0], 72)
        self.assertEqual(sorted(t["prs"]), [50, 72, 99])
        self.assertEqual(t["pr"], 72)
        self.assertIn("#72, #", fr.render(data))

    def test_lane_filter_and_cli(self):
        out = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "flow-report.py"),
                "--lanes-only",
                "--lane",
                "ci",
                "--since",
                SINCE,
                "--until",
                UNTIL,
                "--state-dir",
                str(FIX / "state"),
                "--lane-log",
                "/nonexistent",
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        self.assertIn("| ci |", out)
        self.assertNotIn("| android-build |", out)


class LogAndSourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def log_from_state(self, path: Path, skip: int = 0):
        """The SA-125 schema, one line per finished job, built from the real records."""
        lines = []
        for r in fr.read_state(FIX / "state")[skip:]:
            lines.append(
                json.dumps(
                    {
                        "v": 1,
                        "id": r["id"],
                        "lane": r["lane"] + "-" + (r["project"] or ""),
                        "project": r["project"],
                        "key": r["key"],
                        "cmd": r["cmd"],
                        "cwd": r["cwd"],
                        "submitted": r["submitted"],
                        "started": r["started"],
                        "ended": r["ended"],
                        "wait_s": r["wait_s"],
                        "run_s": r["run_s"],
                        "rc": r["rc"],
                        "reason": r["reason"],
                        "mem": 6442450944,
                        "budget": 12884901888,
                    }
                )
            )
        path.write_text("\n".join(lines) + "\ntorn line {\n")

    def test_log_reproduces_the_state_numbers(self):
        log = self.root / "lane-log.jsonl"
        self.log_from_state(log)
        empty = self.root / "empty"
        from_log = fr.build_data(
            args(lane_log=str(log), state_dir=str(empty), lanes_only=True)
        )
        from_state = fr.build_data(args(lanes_only=True))
        self.assertEqual(len(from_log["records"]), len(from_state["records"]))
        a, b = from_log["lanes"]["ci"], from_state["lanes"]["ci"]
        for key in ("count", "pass", "fail", "cancel", "busy_s", "run_max", "wait_max"):
            self.assertAlmostEqual(a[key], b[key], places=6)
        gate = {m["label"]: m for m in from_log["mix"]}["pnpm ci:local"]
        self.assertEqual((gate["count"], gate["finished"], gate["passes"]), (8, 7, 1))
        self.assertAlmostEqual(gate["median_run"], 717.09, places=2)
        self.assertTrue(all(r["source"] == "log" for r in from_log["records"]))
        self.assertTrue(any("from durable log" in s for s in from_log["sources"]))

    def test_log_wins_and_state_fills_the_gap(self):
        log = self.root / "lane-log.jsonl"
        self.log_from_state(log, skip=39)  # only the last 2 jobs are in the log
        data = fr.build_data(args(lane_log=str(log), lanes_only=True))
        sources = [r["source"] for r in data["records"]]
        self.assertEqual(sources.count("log"), 2)
        self.assertEqual(len(sources), 41)
        self.assertTrue(
            any("read directly from agentqueue state dir" in s for s in data["sources"])
        )

    def test_real_log_written_by_the_merged_agentqueue(self):
        """tests/fixtures/flow_report/real-lane-log.jsonl: 3 tiny real jobs run with agentqueue 4991a94
        (`--log` before `run`), one exiting 3; cmd is the whitespace-joined argv."""
        data = fr.build_data(
            args(
                lane_log=str(FIX / "real-lane-log.jsonl"),
                state_dir=str(self.root / "none"),
                since="2026-11-23T00:00:00Z",
                until="2026-12-31T00:00:00Z",
                lanes_only=True,
            )
        )
        ci = data["lanes"]["ci"]
        self.assertEqual(
            (ci["count"], ci["pass"], ci["fail"], ci["cancel"]), (3, 2, 1, 0)
        )
        self.assertTrue(
            all(
                r["source"] == "log" and r["project"] == "0123abcd"
                for r in data["records"]
            )
        )
        labels = sorted(m["label"] for m in data["mix"])
        self.assertEqual(labels, ["local_ci.py run", "pnpm ci:local"])
        self.assertEqual(fr.ticket_of_cwd(data["records"][0]["cwd"]), "SA-999")
        self.assertEqual(fr.classify(data["records"][2]["cmd"])["kind"], "gate")

    def test_cancelled_job_has_no_run_time(self):
        raw = {
            "id": "x",
            "lane": "ci-43779948",
            "cmd": "pnpm ci:local",
            "cwd": "/w/sa-1-a",
            "submitted": 10.0,
            "started": None,
            "ended": 20.0,
            "wait_s": None,
            "run_s": None,
            "rc": 130,
            "reason": "cancelled",
        }
        rec = fr.normalize(raw, "log")
        self.assertEqual(
            (rec["lane"], rec["project"], rec["cmd"]),
            ("ci", "43779948", ["pnpm", "ci:local"]),
        )
        self.assertIsNone(rec["run_s"])
        stats = fr.lane_stats([rec])["ci"]
        self.assertEqual((stats["cancel"], stats["fail"], stats["pass"]), (1, 0, 0))

    def test_lane_job_wrapper_is_stripped_from_the_command(self):
        argv = [
            "/usr/bin/python3",
            "/g/resource_guard.py",
            "lane-job",
            "--lane",
            "ci",
            "--project-key",
            "k",
            "--",
            "pnpm",
            "ci:local",
            "--only",
            "x",
        ]
        cmd = fr.job_command(argv)
        self.assertEqual(cmd, ["pnpm", "ci:local", "--only", "x"])
        self.assertTrue(fr.classify(cmd)["partial"])
        self.assertEqual(
            fr.classify(
                ["python3", "scripts/local-ci/local_ci.py", "merge", "--pr", "7"]
            )["pr"],
            7,
        )
        self.assertEqual(fr.ticket_of_cwd("/x/sa-124-adopt-agentqueue"), "SA-124")
        self.assertEqual(
            fr.ticket_of_cwd("/x/sa-124-adopt-agentqueue/packages/web"), "SA-124"
        )  # subdirectory
        self.assertIsNone(
            fr.ticket_of_cwd("/x/sa124-diag-main")
        )  # not a ticket worktree
        self.assertIsNone(fr.ticket_of_cwd("/x/sa-1x-nope"))
        self.assertIsNone(fr.ticket_of_cwd("/x/rasbora"))

    def test_handoff_markers_git_times_and_ready_to_pr(self):
        handoff = self.root / "handoff"
        handoff.mkdir()
        for name, when in (
            ("SA-109-ready", "2026-11-23T01:20:00Z"),
            ("SA-110.md", "2026-11-23T01:55:00Z"),
            ("SA-124.md", "2026-11-23T01:08:30Z"),
        ):  # SA-124 note is newer than its PR
            (handoff / name).write_text("x")
            os.utime(handoff / name, (T(when), T(when)))
        repo = self.root / "repo"
        repo.mkdir()

        def run(*argv, when=None):
            env = {
                **os.environ,
                "GIT_CONFIG_GLOBAL": "/dev/null",
                "GIT_CONFIG_SYSTEM": "/dev/null",
            }
            if when:
                env.update(GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    *argv,
                ],
                check=True,
                capture_output=True,
                env=env,
            )

        run("init", "-q", "-b", "main")
        run("commit", "-q", "--allow-empty", "-m", "init", when="2026-11-22T00:00:00Z")
        run(
            "checkout",
            "-q",
            "-b",
            "wanghujie/sa-109-stop-an-invalid-task-input",
            when="2026-11-22T00:00:00Z",
        )
        run("commit", "-q", "--allow-empty", "-m", "work", when="2026-11-23T01:01:00Z")
        run("checkout", "-q", "main")
        run(
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "SA-109: Stop an invalid task input",
            when="2026-11-23T01:25:24Z",
        )
        data = fr.build_data(args(handoff=str(handoff), repo=str(repo)))
        t = by_ticket(data)
        self.assertEqual(t["SA-109"]["first_commit"], T("2026-11-23T01:01:00Z"))
        self.assertEqual(t["SA-109"]["ready_src"], "ready marker")
        self.assertEqual(
            t["SA-109"]["ready_to_pr"],
            T("2026-11-23T01:25:13Z") - T("2026-11-23T01:20:00Z"),
        )
        self.assertEqual(t["SA-110"]["ready_src"], "handoff note")
        self.assertEqual(
            t["SA-110"]["ready_to_pr"],
            T("2026-11-23T02:00:12Z") - T("2026-11-23T01:55:00Z"),
        )
        self.assertIsNone(
            t["SA-124"]["ready"]
        )  # a note newer than the PR is not a ready time
        self.assertIn("ignored", t["SA-124"]["ready_src"])
        self.assertEqual(
            t["SA-109"]["total"], T("2026-11-23T01:25:24Z") - T("2026-11-23T01:01:00Z")
        )
        self.assertIn("5m13s", fr.render(data))

    def test_cli_is_read_only_and_prints_markdown(self):
        before = sorted(p.name for p in (FIX / "state" / "jobs").iterdir())
        out = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts" / "flow-report.py"),
                "--since",
                SINCE,
                "--until",
                UNTIL,
                "--state-dir",
                str(FIX / "state"),
                "--lane-log",
                "/nonexistent",
                "--ci-home",
                str(FIX / "ci-home"),
                "--handoff",
                "/nonexistent",
                "--repo",
                "/nonexistent",
                "--gh-json",
                str(FIX / "gh-prs.json"),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        self.assertTrue(out.startswith("# Flow report"))
        self.assertIn("## Lane utilization", out)
        self.assertEqual(
            before, sorted(p.name for p in (FIX / "state" / "jobs").iterdir())
        )


if __name__ == "__main__":
    unittest.main()
