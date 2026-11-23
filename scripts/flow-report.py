#!/usr/bin/env python3
"""End-to-end flow report per ticket and PR (SA-126). Read-only, stdlib only.

Joins, per ticket: lane job records (agentqueue durable log, or the live state dir while the
pinned agentqueue lacks `--log`), local-ci run records and stage logs, `gh pr` data, git commit
times and the handoff ready markers. Writes Markdown on stdout (or --out). Never writes to any
source it reads, never prints a token. All times UTC.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

DEFAULT_LOG = Path.home() / ".local/state/agent-resource-guard/lane-log.jsonl"
DEFAULT_CI_HOME = Path.home() / ".cache/stateaction-local-ci"
DEFAULT_HANDOFF = Path("/home/wearaway/flora-work/handoff")
DEFAULT_EVENTS = Path("/home/wearaway/flora-work/metrics/ticket-events.jsonl")
EVENT_NAMES = (
    "start code_ready review_start review_done fix_done land_submitted "
    "land_started land_done merged blocked"
).split()
GH_REPO = "timothywangdev/stateaction"
GH_USER = "timothywangdev"
IDLE_GAP_MIN_S = (
    300  # an idle lane gap shorter than this is not reported as a candidate
)
FAST_FAIL_S = 30


def default_state_dir() -> Path:
    return Path(f"/run/user/{os.getuid()}/agent-resource-guard/agentqueue/machine")


# ---------------------------------------------------------------- formatting and statistics


def fmt_dur(seconds: float | None) -> str:
    if seconds is None:
        return "n/a"
    sign = "-" if seconds < 0 else ""
    s = round(abs(seconds))
    if s < 90:
        return f"{sign}{s}s"
    if s < 3600:
        return f"{sign}{s // 60}m{s % 60:02d}s"
    return f"{sign}{s // 3600}h{(s % 3600) // 60:02d}m"


def fmt_ts(epoch: float | None) -> str:
    if epoch is None:
        return "n/a"
    return time.strftime("%m-%d %H:%MZ", time.gmtime(epoch))


def quantile(values: list[float], q: float) -> float | None:
    """Linear interpolation between closest ranks (the numpy default)."""
    if not values:
        return None
    data = sorted(values)
    pos = (len(data) - 1) * q
    low = int(pos)
    high = min(low + 1, len(data) - 1)
    return data[low] + (data[high] - data[low]) * (pos - low)


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def parse_iso(text: str | None) -> float | None:
    if not text:
        return None
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def parse_when(text: str, now: float) -> float:
    match = re.fullmatch(r"(\d+(?:\.\d+)?)([smhd])", text)
    if match:
        unit = {"s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]
        return now - float(match.group(1)) * unit
    value = parse_iso(text)
    if value is None:
        raise SystemExit(f"cannot parse time {text!r}")
    return value


# ---------------------------------------------------------------- lane records


def job_command(argv: list[str] | str) -> list[str]:
    """The user's command: strips the guard's `resource_guard.py lane-job ... --` wrapper."""
    if isinstance(
        argv, str
    ):  # the agentqueue log stores argv joined on whitespace, redacted
        argv = argv.split()
    if "lane-job" in argv:
        rest = argv[argv.index("lane-job") + 1 :]
        if "--" in rest:
            return rest[rest.index("--") + 1 :]
    return list(argv)


def lane_parts(lane: str, project: str | None) -> tuple[str, str | None]:
    match = re.fullmatch(r"(.+)-([0-9a-f]{8})", lane or "")
    if match:
        return match.group(1), project or match.group(2)
    return lane, project


def normalize(raw: dict, source: str) -> dict:
    lane, project = lane_parts(raw.get("lane", ""), raw.get("project"))
    submitted, started, ended = (
        raw.get("submitted"),
        raw.get("started"),
        raw.get("ended"),
    )
    wait = raw.get("wait_s")
    run = raw.get("run_s")
    if wait is None and started is not None and submitted is not None:
        wait = started - submitted
    if run is None and started is not None and ended is not None:
        run = ended - started
    return {
        "id": raw.get("id"),
        "lane": lane,
        "project": project,
        "key": raw.get("key"),
        "cmd": job_command(raw.get("cmd", raw.get("argv", []))),
        "cwd": raw.get("cwd") or "",
        "submitted": submitted,
        "started": started,
        "ended": ended,
        "wait_s": wait,
        "run_s": run,
        "rc": raw.get("rc"),
        "reason": raw.get("reason"),
        "source": source,
    }


def read_log(path: Path) -> list[dict]:
    records = []
    if not path.is_file():
        return records
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except ValueError:
            continue  # a torn or foreign line never aborts the report
        if isinstance(raw, dict) and raw.get("id"):
            records.append(normalize(raw, "log"))
    return records


def read_state(directory: Path) -> list[dict]:
    """Live agentqueue state: jobs/<id>.json (submission) and res/<id> (outcome)."""
    records = []
    for path in sorted((directory / "jobs").glob("*.json")):
        try:
            job = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        result: dict = {}
        try:
            result = json.loads((directory / "res" / job["id"]).read_text())
        except (OSError, ValueError, KeyError):
            pass
        if not result:
            continue  # still queued or running: no durable outcome yet
        raw = {
            **job,
            **{k: result.get(k) for k in ("rc", "reason", "started", "ended")},
        }
        records.append(normalize(raw, "state"))
    return records


def classify(cmd: list[str]) -> dict:
    text = " ".join(cmd)
    info = {
        "kind": "other",
        "label": os.path.basename(cmd[0]) if cmd else "?",
        "pr": None,
        "partial": False,
    }
    if "merge" in cmd and ("local_ci.py" in text or "ci:merge" in text):
        info.update(kind="merge", label="local_ci.py merge")
        if "--pr" in cmd and cmd.index("--pr") + 1 < len(cmd):
            info["pr"] = int(cmd[cmd.index("--pr") + 1])
    elif "ci:local" in cmd:
        info.update(kind="gate", label="pnpm ci:local", partial="--only" in cmd)
    elif "local_ci.py" in text and "run" in cmd:
        info.update(kind="gate", label="local_ci.py run", partial="--only" in cmd)
    return info


def ticket_of_cwd(cwd: str) -> str | None:
    """Ticket of the worktree the job ran in: the nearest path component `sa-<n>-...` (digit
    boundary, so `sa124-diag-main` is not a ticket and a subdirectory of a worktree still maps),
    else the branch checked out there (`.../sa-<n>-...`)."""
    path = Path(cwd)
    for part in [path, *path.parents]:
        match = re.match(r"sa-(\d+)-", part.name)
        if match:
            return f"SA-{match.group(1)}"
    if cwd and path.is_dir():
        for branch in git(path, "rev-parse", "--abbrev-ref", "HEAD"):
            match = re.search(r"(?:^|/)sa-(\d+)-", branch)
            if match:
                return f"SA-{match.group(1)}"
    return None


# ---------------------------------------------------------------- local-ci runs


def scan_ci_runs(home: Path) -> list[dict]:
    runs = []
    logs = home / "logs"
    if not logs.is_dir():
        return runs
    for directory in sorted(logs.iterdir()):
        if not directory.is_dir():
            continue
        run = {
            "runId": directory.name,
            "dir": str(directory),
            "verdict": "UNFINISHED",
            "stages": [],
        }
        record = directory / "run.json"
        try:
            data = json.loads(record.read_text())
        except (OSError, ValueError):
            data = None
        if data:
            finished = parse_iso(data.get("finishedAt"))
            total = float(data.get("totalDurationSec") or 0)
            run.update(
                verdict=data.get("verdict", "UNFINISHED"),
                head=data.get("head"),
                finished=finished,
                start=(finished - total)
                if finished
                else None,  # epoch fields only: run ids are local time
                total=total,
                stages=[
                    {
                        "id": s["id"],
                        "status": s["status"],
                        "durationSec": s.get("durationSec"),
                    }
                    for s in data.get("stages", [])
                ],
            )
        else:  # killed or cancelled run: only the stage logs remain
            logs_ = [p for p in directory.glob("*.log")]
            newest = max(logs_, key=lambda p: p.stat().st_mtime, default=None)
            oldest = min(logs_, key=lambda p: p.stat().st_mtime, default=None)
            run.update(
                start=oldest.stat().st_mtime if oldest else None,
                finished=newest.stat().st_mtime if newest else None,
                total=None,
                newest_log_stage=newest.stem if newest else None,
            )
        if run.get("start"):
            runs.append(run)
    return runs


def failing_stage(run: dict) -> tuple[str, float | None, float | None]:
    """(stage id, stage duration, seconds into the run when the stage began)."""
    elapsed = 0.0
    for stage in run.get("stages", []):
        if stage["status"] != "passed":
            return stage["id"], stage.get("durationSec"), elapsed
        elapsed += stage.get("durationSec") or 0
    if run.get("verdict") == "FAIL" and run.get("stages"):
        return "verdict FAIL, all stages passed", None, None
    stage = run.get("newest_log_stage")
    return (
        (
            f"{stage} (last log; run unfinished)"
            if stage
            else "unknown (run recorded no stage)"
        ),
        None,
        None,
    )


def match_run(job: dict, runs: list[dict], used: set[str]) -> dict | None:
    if job["started"] is None or job["ended"] is None:
        return None
    best, best_overlap = None, -1.0
    for run in runs:
        if run["runId"] in used or not run.get("finished"):
            continue
        overlap = min(job["ended"] + 5, run["finished"]) - max(
            job["started"] - 30, run["start"]
        )
        if (
            run["start"] >= job["started"] - 30
            and run["finished"] <= job["ended"] + 30
            and overlap > best_overlap
        ):
            best, best_overlap = run, overlap
    return best


# ---------------------------------------------------------------- external sources


def load_prs(args) -> tuple[list[dict], str]:
    if args.no_gh:
        return [], "gh: skipped (--no-gh)"
    if args.gh_json:
        return json.loads(Path(args.gh_json).read_text()), f"gh: {args.gh_json}"
    env = {**os.environ}
    try:
        token = subprocess.run(
            ["gh", "auth", "token", "--user", GH_USER],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        ).stdout.strip()
        env["GH_TOKEN"] = token
        out = subprocess.run(
            [
                "gh",
                "pr",
                "list",
                "--repo",
                GH_REPO,
                "--state",
                "all",
                "--limit",
                "1000",
                "--json",
                "number,title,createdAt,mergedAt,state,headRefName",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
            env=env,
        ).stdout
        return json.loads(out), f"gh: live {GH_REPO}"
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return [], f"gh: unavailable ({type(error).__name__}); PR times are n/a"


def git(repo: Path, *argv: str) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), *argv],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [line for line in out.splitlines() if line]


def git_times(repo: Path, number: str) -> dict:
    """First/last branch commit time and the squash commit time on origin/main (or main)."""
    base = (
        "origin/main"
        if git(repo, "rev-parse", "--verify", "-q", "origin/main")
        else "main"
    )
    refs = [
        r
        for r in git(
            repo,
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes/origin",
        )
        if re.search(rf"/sa-0*{number}-", r)
    ]
    stamps = []
    for ref in refs:
        stamps += [float(x) for x in git(repo, "log", "--format=%at", f"{base}..{ref}")]
    merged = [
        float(x)
        for x in git(
            repo,
            "log",
            base,
            "--extended-regexp",
            f"--grep=^SA-0*{number}:",
            "--format=%ct",
        )
    ]
    return {
        "first_commit": min(stamps) if stamps else None,
        "last_commit": max(stamps) if stamps else None,
        "main_commit": max(merged) if merged else None,
    }


def handoff_ready(directory: Path, ticket: str) -> tuple[float | None, str]:
    for name, label in (
        (f"{ticket}-ready", "ready marker"),
        (f"{ticket}.md", "handoff note"),
    ):
        path = directory / name
        if path.exists():
            return path.stat().st_mtime, label
    return None, "none"


# ---------------------------------------------------------------- analysis


def lane_stats(records: list[dict]) -> dict:
    """Per lane: counts, wait/run quantiles, busy fraction, idle gaps, throughput."""
    out = {}
    for lane in sorted({r["lane"] for r in records}):
        jobs = [r for r in records if r["lane"] == lane]
        done = [r for r in jobs if r["run_s"] is not None]
        intervals = sorted((r["started"], r["ended"]) for r in done)
        merged: list[list[float]] = []
        for start, end in intervals:
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        first = min(r["submitted"] for r in jobs)
        last = max((r["ended"] for r in jobs if r["ended"]), default=first)
        span = max(last - first, 1e-9)
        busy = sum(e - s for s, e in merged)
        gaps = [(merged[i][1], merged[i + 1][0]) for i in range(len(merged) - 1)]
        gaps = [(a, b) for a, b in gaps if b > a]
        waits = [
            r["wait_s"]
            for r in jobs
            if r["wait_s"] is not None and r["reason"] != "cancelled"
        ]
        runs = [r["run_s"] for r in done]
        cancelled = [r for r in jobs if r["reason"] == "cancelled"]
        out[lane] = {
            "count": len(jobs),
            "pass": sum(1 for r in jobs if r["rc"] == 0 and r not in cancelled),
            "fail": sum(
                1 for r in jobs if r["rc"] not in (0, None) and r not in cancelled
            ),
            "cancel": len(cancelled),
            "wait_p50": median(waits),
            "wait_p90": quantile(waits, 0.9),
            "wait_max": max(waits, default=None),
            "run_p50": median(runs),
            "run_p90": quantile(runs, 0.9),
            "run_max": max(runs, default=None),
            "busy_s": busy,
            "span_s": span,
            "busy_fraction": busy / span,
            "idle_gaps": gaps,
            "longest_idle": max(gaps, key=lambda g: g[1] - g[0], default=None),
            "per_hour": len(done) / (span / 3600),
        }
    return out


def command_mix(records: list[dict]) -> list[dict]:
    rows = []
    for label in sorted({classify(r["cmd"])["label"] for r in records}):
        jobs = [r for r in records if classify(r["cmd"])["label"] == label]
        runs = [r["run_s"] for r in jobs if r["run_s"] is not None]
        rows.append(
            {
                "label": label,
                "count": len(jobs),
                "finished": len(runs),
                "cancelled": sum(1 for r in jobs if r["run_s"] is None),
                "median_run": median(runs),
                "passes": sum(
                    1 for r in jobs if r["rc"] == 0 and r["run_s"] is not None
                ),
                "run_total": sum(runs),
            }
        )
    return sorted(rows, key=lambda r: -r["run_total"])


def read_events(path: Path) -> list[dict]:
    """Lines written by flora-work/bin/ticketlog: {ts, ticket, event, note}. Bad lines are skipped."""
    out = []
    try:
        text = path.read_text()
    except OSError:
        return out
    for line in text.splitlines():
        try:
            e = json.loads(line)
            out.append(
                {
                    "ts": float(e["ts"]),
                    "ticket": str(e["ticket"]),
                    "event": str(e["event"]),
                    "note": str(e.get("note", "")),
                }
            )
        except (ValueError, KeyError, TypeError):
            continue
    return out


def event_flow(events: list[dict], since: float, until: float) -> list[dict]:
    """Per ticket start-to-merge time with phase durations from ticketlog events.

    Phases (first/last occurrence, None when an end point is missing):
    implementation = start -> code_ready; review = first review_start (else code_ready) -> last review_done;
    fix = last review_done -> last fix_done; queue wait = last land_submitted -> first land_started after it;
    gate = that land_started -> next land_done; merge = that land_done -> merged.
    Idle gaps are the differences between consecutive events of the ticket.
    """
    by: dict[str, list[dict]] = {}
    for e in sorted(events, key=lambda e: e["ts"]):
        by.setdefault(e["ticket"], []).append(e)
    rows = []
    for ticket, evs in by.items():
        if not any(since <= e["ts"] <= until for e in evs):
            continue

        def first(name, after=None):
            for e in evs:
                if e["event"] == name and (after is None or e["ts"] >= after):
                    return e["ts"]
            return None

        def last(name):
            times = [e["ts"] for e in evs if e["event"] == name]
            return times[-1] if times else None

        def span(a, b):
            return b - a if a is not None and b is not None and b >= a else None

        start, ready = first("start"), first("code_ready")
        review_end = last("review_done")
        review_begin = first("review_start") or ready
        submitted = last("land_submitted")
        started = first("land_started", submitted) if submitted else None
        done = first("land_done", started) if started else None
        merged = last("merged")
        begin = start if start is not None else evs[0]["ts"]
        gaps = sorted(
            (
                {"gap": b["ts"] - a["ts"], "from": a["event"], "to": b["event"]}
                for a, b in zip(evs, evs[1:])
            ),
            key=lambda g: -g["gap"],
        )
        rows.append(
            {
                "ticket": ticket,
                "events": len(evs),
                "start": begin,
                "merged": merged,
                "blocked": any(e["event"] == "blocked" for e in evs),
                "total": span(start, merged),
                "implementation": span(start, ready),
                "review": span(review_begin, review_end),
                "fix": span(review_end, last("fix_done")),
                "queue_wait": span(submitted, started),
                "gate": span(started, done),
                "merge": span(done if done is not None else submitted, merged),
                "gaps": gaps[:3],
            }
        )
    rows.sort(key=lambda r: r["start"])
    return rows


def build_data(args) -> dict:
    now = args.now if args.now is not None else time.time()
    since = parse_when(args.since, now)
    until = parse_when(args.until, now) if args.until else now
    sources = []
    records: dict[str, dict] = {}
    log_path = Path(args.lane_log)
    from_log = read_log(log_path)
    for r in from_log:
        records[r["id"]] = r
    sources.append(
        f"lane records: {len(from_log)} from durable log {log_path}"
        + ("" if from_log else " (absent or empty)")
    )
    state_dir = Path(args.state_dir)
    from_state = [r for r in read_state(state_dir) if r["id"] not in records]
    for r in from_state:
        records[r["id"]] = r
    if from_state or not from_log:
        sources.append(
            f"lane records: {len(from_state)} read directly from agentqueue state dir {state_dir} "
            "(the pinned agentqueue lacks `--log` or the log predates them; state records are lost on gc/reboot)"
        )
    scoped = [
        r
        for r in records.values()
        if r["submitted"] is not None and since <= r["submitted"] <= until
    ]
    if getattr(args, "lane", None):
        scoped = [r for r in scoped if r["lane"] == args.lane]
    scoped.sort(key=lambda r: r["submitted"])
    data = {"since": since, "until": until, "sources": sources, "records": scoped}
    data["lanes"] = lane_stats(scoped)
    data["mix"] = command_mix(scoped)
    if args.lanes_only:
        return data

    events_path = Path(getattr(args, "events", None) or DEFAULT_EVENTS)
    events = read_events(events_path)
    sources.append(
        f"ticket events: {len(events)} from {events_path}"
        + ("" if events else " (absent or empty)")
    )
    data["event_flow"] = event_flow(events, since, until)

    prs, pr_source = load_prs(args)
    sources.append(pr_source)
    pr_by_number, pr_by_ticket = {}, {}
    for pr in prs:
        pr_by_number[pr["number"]] = pr
        match = re.match(r"SA-(\d+):", pr.get("title", ""))
        if match:
            pr_by_ticket.setdefault(f"SA-{match.group(1)}", []).append(pr)
    for (
        group
    ) in pr_by_ticket.values():  # newest merged first, then unmerged by newest creation
        group.sort(
            key=lambda x: (
                parse_iso(x.get("mergedAt")) or 0,
                parse_iso(x.get("createdAt")) or 0,
            ),
            reverse=True,
        )
    runs = scan_ci_runs(Path(args.ci_home))
    sources.append(f"local-ci: {len(runs)} run dirs in {args.ci_home}/logs")
    sources.append(f"git: {args.repo}; handoff markers: {args.handoff}")

    tickets: dict[str, dict] = {}

    def ticket(name: str) -> dict:
        return tickets.setdefault(
            name,
            {"ticket": name, "gates": [], "partial": [], "merges": [], "other": []},
        )

    used: set[str] = set()
    unattributed: list[dict] = []
    for rec in scoped:
        info = classify(rec["cmd"])
        rec["info"] = info
        name = ticket_of_cwd(rec["cwd"])
        if info["kind"] == "merge" and info["pr"] in pr_by_number:
            match = re.match(r"SA-(\d+):", pr_by_number[info["pr"]]["title"])
            name = f"SA-{match.group(1)}" if match else name
        rec["ticket"] = name
        if name is None:
            if info["kind"] == "gate":
                unattributed.append(rec)
            continue
        if info["kind"] == "gate" and rec["lane"] == "ci":
            if info["partial"]:
                ticket(name)["partial"].append(rec)
            else:
                run = match_run(rec, runs, used) if rec["run_s"] is not None else None
                if run:
                    used.add(run["runId"])
                rec["run"] = run
                ticket(name)["gates"].append(rec)
        elif info["kind"] == "merge":
            ticket(name)["merges"].append(rec)
        else:
            ticket(name)["other"].append(rec)

    for name, t in tickets.items():
        number = name.split("-")[1]
        prs_of = pr_by_ticket.get(name, [])
        pr = prs_of[0] if prs_of else None
        merge_jobs = [m for m in t["merges"] if m["rc"] == 0]
        git_info = git_times(Path(args.repo), number)
        ready, ready_src = handoff_ready(Path(args.handoff), name)
        gates = t["gates"]
        finished = [g for g in gates if g["run_s"] is not None]
        cancelled = [
            g for g in gates if g["run_s"] is None or g["reason"] == "cancelled"
        ]
        failed = [
            g
            for g in finished
            if g["rc"] not in (0, None) and g["reason"] != "cancelled"
        ]
        passed = [g for g in finished if g["rc"] == 0]
        failures = []
        for g in failed:
            run = g.get("run")
            stage, stage_s, at = (
                failing_stage(run)
                if run
                else ("unknown (no local-ci run matched)", None, None)
            )
            failures.append(
                {
                    "job": g["id"],
                    "stage": stage,
                    "stage_s": stage_s,
                    "reached_at": at,
                    "run_s": g["run_s"],
                    "rc": g["rc"],
                    "verdict": run["verdict"] if run else None,
                }
            )
        merged = parse_iso(pr["mergedAt"]) if pr else None
        merged_src = "gh" if merged else None
        if merged is None and git_info["main_commit"]:
            merged, merged_src = git_info["main_commit"], "git main"
        if merged is None and merge_jobs:
            merged, merged_src = merge_jobs[-1]["ended"], "lane merge job"
        created = parse_iso(pr["createdAt"]) if pr else None
        first_submit = min((g["submitted"] for g in gates + t["partial"]), default=None)
        if ready and created and ready > created:
            ready, ready_src = None, f"{ready_src} newer than the PR, ignored"
        starts = [
            x for x in (git_info["first_commit"], ready, first_submit, created) if x
        ]
        start = min(starts) if starts else None
        wasted = sum(g["run_s"] for g in failed) + sum(
            g["run_s"] or 0 for g in cancelled
        )
        t.update(
            pr=pr["number"] if pr else None,
            prs=[x["number"] for x in prs_of],
            pr_created=created,
            merged=merged,
            merged_src=merged_src,
            ready=ready,
            ready_src=ready_src,
            first_commit=git_info["first_commit"],
            first_submit=first_submit,
            start=start,
            ready_to_pr=(created - ready) if created and ready else None,
            queue_wait=sum(g["wait_s"] or 0 for g in gates + t["partial"]),
            attempts=len(gates),
            passes=len(passed),
            fails=len(failed),
            cancels=len(cancelled),
            gate_wall=sum(g["run_s"] or 0 for g in finished),
            wasted=wasted,
            failures=failures,
            merge_latency=(merged - created) if merged and created else None,
            total=(merged - start) if merged and start else None,
            last_pass_end=max((g["ended"] for g in passed), default=None),
        )
    data["tickets"] = sorted(
        tickets.values(), key=lambda t: t["first_submit"] or t["start"] or 0
    )
    data["gh_source"] = pr_source
    data["unattributed"] = unattributed
    data["candidates"] = candidates(data)
    return data


def candidates(data: dict) -> list[str]:
    """Improvement candidates; every line is computed from the records above, nothing else."""
    out = []
    tickets = data.get("tickets", [])
    ci = data["lanes"].get("ci")
    failures = [dict(f, ticket=t["ticket"]) for t in tickets for f in t["failures"]]
    total_wasted = sum(t["wasted"] for t in tickets)
    gate_total = sum(t["gate_wall"] for t in tickets)
    if failures and total_wasted:
        late = [f for f in failures if (f["reached_at"] or 0) >= 300]
        share = 100 * total_wasted / gate_total if gate_total else 0
        line = (
            f"Failed or cancelled gate runs cost {fmt_dur(total_wasted)} ({share:.0f}% of {fmt_dur(gate_total)} "
            f"gate wall time) across {len(failures)} failed runs (cancelled runs that had started are included in the minutes)."
        )
        if late:
            stages = sorted({f["stage"] for f in late})
            line += (
                f" {len(late)} of them failed at a stage reached after at least 5 min ({', '.join(stages)}):"
                " reproduce those stages as Free commands before submitting the gate."
            )
        out.append(line)
    repeat: dict[str, list[str]] = {}
    for f in failures:
        repeat.setdefault(f["stage"], []).append(f["ticket"])
    for stage, owners in sorted(repeat.items()):
        if len(owners) >= 2 and not stage.startswith("unknown"):
            out.append(
                f"Stage `{stage}` failed {len(owners)} times ({', '.join(sorted(set(owners)))}): "
                "harden it or run it as a Free pre-check before the gate."
            )
    fast = [f for f in failures if f["run_s"] is not None and f["run_s"] < FAST_FAIL_S]
    if fast:
        out.append(
            f"{len(fast)} gate submissions failed within {FAST_FAIL_S}s "
            f"({', '.join(sorted({f['ticket'] for f in fast}))}), each after taking the ci slot: "
            "a pre-submit check (stale tree, hook or setup) would avoid the queue entry."
        )
    if ci:
        non_gate = [
            r
            for r in data["records"]
            if r["lane"] == "ci"
            and r.get("info", {}).get("kind") == "other"
            and r["run_s"] is not None
        ]
        if non_gate:
            held = sum(r["run_s"] for r in non_gate)
            out.append(
                f"{len(non_gate)} non-gate jobs (diagnostics, one-off scripts) held the ci lane for "
                f"{fmt_dur(held)}: run them as Free commands instead."
            )
        waits = [
            r["wait_s"]
            for r in data["records"]
            if r["lane"] == "ci" and r["wait_s"] is not None
        ]
        if waits:
            p90, mx = quantile(waits, 0.9), max(waits)
            if mx < 60:
                out.append(
                    f"The ci lane was not the bottleneck: wait p90 {fmt_dur(p90)}, max {fmt_dur(mx)}; "
                    f"it was idle {100 * (1 - ci['busy_fraction']):.0f}% of the observed span."
                )
            else:
                out.append(
                    f"ci queue wait: p90 {fmt_dur(p90)}, max {fmt_dur(mx)} "
                    f"(total {fmt_dur(sum(waits))}): tickets queued behind each other."
                )
        idle = ready_idle_overlap(tickets, ci["idle_gaps"])
        if idle:
            out.append(
                f"The ci lane sat idle for {fmt_dur(idle[0])} while {idle[1]} ticket(s) were code-ready "
                "but had not submitted a gate (ready marker earlier than first gate submit): "
                "submit the gate as soon as the ready marker is written."
            )
    delays = []
    for t in tickets:
        merge = next((m for m in t["merges"] if m["rc"] == 0), None)
        if merge and t["last_pass_end"] and merge["submitted"] >= t["last_pass_end"]:
            delays.append(merge["submitted"] - t["last_pass_end"])
    if delays and median(delays) >= 60:
        out.append(
            f"The merge is submitted a median {fmt_dur(median(delays))} (max {fmt_dur(max(delays))}) after the "
            "passing gate ended, as a separate ci ticket: a gate-then-merge single job removes that gap "
            "and a second queue entry."
        )
    gaps = [t["ready_to_pr"] for t in tickets if t["ready_to_pr"] is not None]
    walls = [
        t["gate_wall"] + t["queue_wait"]
        for t in tickets
        if t["ready_to_pr"] is not None
    ]
    if gaps and median(gaps) > 1.5 * (median(walls) or 0):
        out.append(
            f"Code-ready to PR takes a median {fmt_dur(median(gaps))} against {fmt_dur(median(walls))} of "
            "queue plus gate time: most of it is outside the gate (hand-offs, review, re-gates)."
        )
    return out or ["None: no rule fired on this window's data."]


def ready_idle_overlap(
    tickets: list[dict], gaps: list[tuple[float, float]]
) -> tuple[float, int] | None:
    total, hit = 0.0, set()
    for t in tickets:
        if not (t["ready"] and t["first_submit"] and t["first_submit"] > t["ready"]):
            continue
        for a, b in gaps:
            overlap = min(b, t["first_submit"]) - max(a, t["ready"])
            if overlap >= IDLE_GAP_MIN_S:
                total += overlap
                hit.add(t["ticket"])
    return (total, len(hit)) if hit else None


# ---------------------------------------------------------------- Markdown


def table(header: list[str], rows: list[list[str]]) -> list[str]:
    out = [
        "| " + " | ".join(header) + " |",
        "|" + "|".join("---" for _ in header) + "|",
    ]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return out


def render(data: dict) -> str:
    lines = ["# Flow report", ""]
    lines.append(
        f"Window: {fmt_ts(data['since'])} to {fmt_ts(data['until'])} (UTC), "
        f"{len(data['records'])} lane jobs submitted in it."
    )
    lines += [f"- {s}" for s in data["sources"]]
    lines.append("")
    if data.get("event_flow"):
        lines += ["## Start-to-merge time per ticket (ticketlog events)", ""]
        lines += table(
            [
                "Ticket",
                "Start",
                "Start to merge",
                "Implementation",
                "Review",
                "Fix",
                "Queue wait",
                "Gate",
                "Merge",
                "Biggest idle gaps",
            ],
            [
                [
                    r["ticket"] + (" (blocked)" if r["blocked"] else ""),
                    fmt_ts(r["start"]),
                    fmt_dur(r["total"]) if r["total"] is not None else "not merged",
                    *(
                        fmt_dur(r[k]) if r[k] is not None else "n/a"
                        for k in (
                            "implementation",
                            "review",
                            "fix",
                            "queue_wait",
                            "gate",
                            "merge",
                        )
                    ),
                    "; ".join(
                        f"{fmt_dur(g['gap'])} {g['from']}->{g['to']}" for g in r["gaps"]
                    )
                    or "-",
                ]
                for r in data["event_flow"]
            ],
        )
        lines.append("")
        merged = sorted(
            r["total"] for r in data["event_flow"] if r["total"] is not None
        )
        if merged:
            lines += [
                f"{len(merged)} merged tickets, median start to merge {fmt_dur(statistics.median(merged))}, "
                f"max {fmt_dur(merged[-1])}. n/a = the event pair was not logged (backfilled tickets only have start, code_ready, review_done, merged).",
                "",
            ]
    if "tickets" in data:
        lines += ["## Per-ticket flow", ""]
        rows = []
        for t in data["tickets"]:
            stages = {}
            for f in t["failures"]:
                stages[f["stage"]] = stages.get(f["stage"], 0) + 1
            fail_text = (
                ", ".join(f"{s} x{n}" if n > 1 else s for s, n in stages.items()) or "-"
            )
            gates = (
                f"{t['attempts']} ({t['passes']} pass, {t['fails']} fail"
                + (f", {t['cancels']} cancelled" if t["cancels"] else "")
                + ")"
            )
            if t["partial"]:
                gates += f" +{len(t['partial'])} partial"
            rows.append(
                [
                    t["ticket"],
                    ", ".join(f"#{n}" for n in t["prs"]) or "n/a",
                    fmt_dur(t["ready_to_pr"]),
                    fmt_dur(t["queue_wait"]),
                    gates,
                    fmt_dur(t["gate_wall"]),
                    fmt_dur(t["wasted"]),
                    fail_text,
                    fmt_dur(t["merge_latency"]),
                    fmt_dur(t["total"]),
                ]
            )
        lines += table(
            [
                "Ticket",
                "PR",
                "Ready to PR",
                "Queue wait",
                "Gate attempts",
                "Gate wall",
                "Lost to failures",
                "Failing stage",
                "Merge latency",
                "Total",
            ],
            rows,
        )
        lines.append("")
        lines += ["### Timeline", ""]
        lines += table(
            [
                "Ticket",
                "First commit",
                "Ready",
                "First gate submit",
                "PR created",
                "Merged",
                "Merged from",
            ],
            [
                [
                    t["ticket"],
                    fmt_ts(t["first_commit"]),
                    f"{fmt_ts(t['ready'])} ({t['ready_src']})",
                    fmt_ts(t["first_submit"]),
                    fmt_ts(t["pr_created"]),
                    fmt_ts(t["merged"]),
                    t["merged_src"] or "n/a",
                ]
                for t in data["tickets"]
            ],
        )
        lines.append("")
    lines += ["## Lane utilization", ""]
    rows = []
    for lane, s in data["lanes"].items():
        gap = s["longest_idle"]
        rows.append(
            [
                lane,
                s["count"],
                f"{s['pass']}/{s['fail']}/{s['cancel']}",
                f"{fmt_dur(s['wait_p50'])} / {fmt_dur(s['wait_p90'])} / {fmt_dur(s['wait_max'])}",
                f"{fmt_dur(s['run_p50'])} / {fmt_dur(s['run_p90'])} / {fmt_dur(s['run_max'])}",
                f"{100 * s['busy_fraction']:.1f}% of {fmt_dur(s['span_s'])}",
                f"{fmt_dur(gap[1] - gap[0])} at {fmt_ts(gap[0])}" if gap else "none",
                f"{s['per_hour']:.2f}" if s["span_s"] >= 300 else "n/a",
            ]
        )
    lines += table(
        [
            "Lane",
            "Jobs",
            "Pass/fail/cancel",
            "Wait p50/p90/max",
            "Run p50/p90/max",
            "Busy",
            "Longest idle gap",
            "Jobs/h",
        ],
        rows,
    )
    lines += ["", "## Command mix", ""]
    lines += table(
        [
            "Command",
            "Jobs",
            "Finished",
            "Cancelled",
            "Run median",
            "Passes",
            "Run total",
        ],
        [
            [
                m["label"],
                m["count"],
                m["finished"],
                m["cancelled"],
                fmt_dur(m["median_run"]),
                m["passes"],
                fmt_dur(m["run_total"]),
            ]
            for m in data["mix"]
        ],
    )
    lines.append("")
    if "tickets" in data:
        failures = [(t["ticket"], f) for t in data["tickets"] for f in t["failures"]]
        if data["unattributed"]:
            lines += [
                "## Unattributed gate runs",
                "",
                f"{len(data['unattributed'])} gate jobs ran outside a `sa-<n>-` worktree and are not in the "
                "per-ticket table (they still count in lanes and the command mix).",
                "",
            ]
            lines += table(
                ["Job", "Submitted", "rc", "Run", "cwd"],
                [
                    [
                        r["id"],
                        fmt_ts(r["submitted"]),
                        r["rc"],
                        fmt_dur(r["run_s"]),
                        r["cwd"],
                    ]
                    for r in data["unattributed"]
                ],
            )
            lines.append("")
        lines += ["## Gate failures and waste", ""]
        if failures:
            lines += table(
                [
                    "Ticket",
                    "Job",
                    "rc",
                    "Run",
                    "Verdict",
                    "Failing stage",
                    "Stage time",
                    "Reached at",
                ],
                [
                    [
                        n,
                        f["job"],
                        f["rc"],
                        fmt_dur(f["run_s"]),
                        f["verdict"] or "n/a",
                        f["stage"],
                        fmt_dur(f["stage_s"]),
                        fmt_dur(f["reached_at"]),
                    ]
                    for n, f in failures
                ],
            )
        else:
            lines.append("No failed gate runs in the window.")
        wasted = sum(t["wasted"] for t in data["tickets"])
        wall = sum(t["gate_wall"] for t in data["tickets"])
        lines += [
            "",
            f"Waste: {fmt_dur(wasted)} ({wasted / 60:.1f} min) lost to failed or cancelled gate runs, "
            f"of {fmt_dur(wall)} total gate wall time.",
            "",
        ]
        lines += ["## Improvement candidates", ""]
        lines += [f"- {c}" for c in data["candidates"]]
        lines += ["", "## Definitions", ""]
        lines += [
            "- Ready: mtime of `<ticket>-ready` in the handoff dir, else of `<ticket>.md`.",
            "- Ready to PR: PR createdAt minus Ready. Queue wait: summed `wait_s` of the ticket's gate jobs.",
            "- Gate attempt: a full `ci:local` run in the ci lane (a `--only` run is shown as partial). "
            "Gate wall: summed run time of finished attempts. Lost to failures: run time of failed and cancelled attempts.",
            "- Failing stage: first non-passed stage of the matching local-ci `run.json` (the newest stage log if the run never finished).",
            "- Merge latency: PR mergedAt minus createdAt. Total: merge time minus the earliest of first branch commit, "
            "Ready, first gate submit and PR creation. Merge time: gh, else the squash commit on main, else the lane merge job.",
            "- Ticket events (ticketlog): implementation = start to code_ready; review = review_start (else code_ready) to last review_done; "
            "fix = last review_done to last fix_done; queue wait = land_submitted to land_started; gate = land_started to land_done; "
            "merge = land_done to merged; start to merge = first start to last merged; idle gaps = largest differences between consecutive events.",
            "- Quantiles use linear interpolation. Busy: union of started..ended per lane over first submit to last end.",
        ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--since",
        default="24h",
        help="relative (90m, 24h, 2d) or ISO time; default 24h",
    )
    p.add_argument("--until", help="ISO time; default now")
    p.add_argument("--now", type=float, help=argparse.SUPPRESS)
    p.add_argument("--lane-log", default=str(DEFAULT_LOG))
    p.add_argument("--state-dir", default=str(default_state_dir()))
    p.add_argument("--ci-home", default=str(DEFAULT_CI_HOME))
    p.add_argument("--handoff", default=str(DEFAULT_HANDOFF))
    p.add_argument(
        "--events",
        default=str(DEFAULT_EVENTS),
        help="ticketlog events JSONL (default flora-work/metrics/ticket-events.jsonl)",
    )
    p.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]))
    p.add_argument(
        "--gh-json",
        help="PR list JSON (gh pr list --json number,title,createdAt,mergedAt) instead of live gh",
    )
    p.add_argument("--no-gh", action="store_true")
    p.add_argument("--lane", help="only this lane (ci, android-build, emulator)")
    p.add_argument(
        "--lanes-only",
        action="store_true",
        help="lane utilization and command mix only (no ticket join)",
    )
    p.add_argument(
        "--json", action="store_true", help="print the computed data as JSON"
    )
    p.add_argument("--out", help="write here instead of stdout")
    args = p.parse_args(argv)
    data = build_data(args)
    text = json.dumps(data, indent=1, default=str) if args.json else render(data)
    if args.out:
        Path(args.out).write_text(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
