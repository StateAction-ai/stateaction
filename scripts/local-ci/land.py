#!/usr/bin/env python3
"""SA-127: land the caller's own PR inside ONE `ci` lane ticket.

  agent-resource run --lane ci --key land-<pr>-<head> -- pnpm ci:land --pr N

Inside the ticket, in order: fetch origin; verify the checked-out branch is the PR's own head
branch; rebase the single commit onto the latest origin/main when main moved (force-with-lease
against the exact expected head, own branch only; a conflict stops with reason `rebase_conflict`
and pushes nothing); run the full gate on that exact head (no retry on failure: the failing stage
and log path are returned); under the merge lock re-check the base and squash merge via the
existing `ci:merge` code (`--match-head-commit`); verify MERGED. Policy, identity and ownership are
checked BEFORE any rebase, push or gate. A rebase that changes the PR patch-id (needed conflict-free
fuzz/context changes) is refused as `needs_review` and pushes nothing. The structured result is written
under `<local-ci-home>/land/` and printed as the LAST stdout line, so `agent-resource find --key K`
(which shows the ticket log) reveals it. A resubmit for an already merged PR returns the stored
result. Reuses local_ci.py; nothing here duplicates the gate or the merge.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "automation"))
import github_policy  # noqa: E402
import local_ci  # noqa: E402
from local_ci import Refused, git  # noqa: E402

SCHEMA = "stateaction.local-ci.land/1"
MAX_ATTEMPTS = 2  # a second gate only when main moved after a PASS and before the merge
PUSH_VISIBLE_WAIT = 90.0
OWNER = "timothywangdev"
OWN_BRANCH = re.compile(r"^wanghujie/sa-(\d+)-[a-z0-9._-]+$")
STATE_ENV = "STATEACTION_LAND_STATE"
# Files whose in-memory copy must equal the rebased tree before the gate runs (M1).
RUNNER_FILES = (
    "scripts/local-ci/local_ci.py",
    "scripts/local-ci/land.py",
    "scripts/local-ci/stages.json",
    "config/repository.json",
    "scripts/automation/github_policy.py",
)
# Distinct exit codes by reason; anything else Landing-shaped is 2.
EXIT = {
    "gate_failed": 1,
    "fatal": 3,
    "policy": 4,
    "merge_failed": 5,
    "needs_review": 6,
    "rebase_conflict": 7,
    "push_failed": 8,
    "pr_closed": 9,
    "error": 10,
    "merged_unverified": 11,
    "interrupted": 12,
    "refused": 75,
}
EXIT_GATE_FAILED = EXIT["gate_failed"]
EXIT_REFUSED = 2


MAX_TOTAL_ATTEMPTS = 4  # across re-executions
STALE_AUTH_SEC = 3 * 3600


class _ReExec(Exception):
    """Leave the auth block (its cleanup runs) before the process image is replaced."""


class Landing(Refused):
    """A refusal with a stable machine-readable reason."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


# --------------------------------------------------------------------- github/git


def pr_info(github_repo: str, number: int) -> dict:
    data = local_ci.gh_json("api", f"repos/{github_repo}/pulls/{number}")
    head_repo = ((data.get("head") or {}).get("repo") or {}).get("full_name")
    return {
        "state": "merged" if data.get("merged") else data.get("state"),
        "draft": bool(data.get("draft")),
        "branch": data["head"]["ref"],
        "head": data["head"]["sha"],
        "headRepo": head_repo,
        "base": data["base"]["ref"],
        "author": (data.get("user") or {}).get("login"),
        "mergeSha": data.get("merge_commit_sha") if data.get("merged") else None,
        "raw": data,
    }


def default_policy(github_repo: str, number: int, pr: dict) -> str:
    """Title/branch/declaration/one-PR-per-ticket policy (same code as ci:merge), run first."""
    pages = local_ci.gh_json(
        "api",
        "--paginate",
        "--slurp",
        f"repos/{github_repo}/pulls?state=all&per_page=100",
    )
    pulls = [item for page in pages for item in page]
    return github_policy.validate_pr(pr["raw"], github_repo, pulls)


ASKPASS = """#!/bin/sh
# answers only github.com's username/password prompts for this tool; anything else fails
case "$1" in
  "Username for 'https://github.com'"*) echo x-access-token ;;
  "Password for 'https://x-access-token@github.com'"*) cat "/proc/self/fd/$STATEACTION_LAND_TOKEN_FD" ;;
  *) exit 1 ;;
esac
"""
SCRUB_ENV = ("GH_TOKEN", "GITHUB_TOKEN")


def origin_allowed(url: str, github_repo: str) -> bool:
    """Fail closed: exactly https://github.com/<repo>[.git]. No SSH, other host or other repo."""
    return url in (
        f"https://github.com/{github_repo}",
        f"https://github.com/{github_repo}.git",
    )


def sweep_stale_auth(base: Path, now: float | None = None) -> None:
    now = now or time.time()
    for old in base.glob("land-auth-*"):
        with contextlib.suppress(OSError):
            if (
                old.is_dir()
                and old.stat().st_uid == os.getuid()
                and now - old.stat().st_mtime > STALE_AUTH_SEC
            ):
                shutil.rmtree(old, ignore_errors=True)


@contextlib.contextmanager
def github_auth(token: str | None = None, run=subprocess.run):
    """Yield an environment for git network commands. The token is checked to belong to
    timothywangdev, then lives only in an anonymous memfd handed to the git child (`gx` passes
    the fd) that the askpass script reads: never argv, never a file, so nothing survives
    exec or SIGKILL. The 0700 directory holds only the script."""
    token = (
        token
        or os.environ.get("GH_TOKEN")
        or run(
            ["gh", "auth", "token", "--user", OWNER],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout.strip()
    )
    if not token:
        raise Landing("identity", f"no GitHub credential for {OWNER}")
    who = run(
        ["gh", "api", "user", "--jq", ".login"],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "GH_TOKEN": token},
    ).stdout.strip()
    if who != OWNER:
        raise Landing(
            "identity",
            f"the GitHub credential belongs to {who or 'nobody'}, not {OWNER}",
        )
    base = Path(os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir())
    sweep_stale_auth(base)
    directory = Path(tempfile.mkdtemp(prefix="land-auth-", dir=base))
    fd = os.memfd_create("land-token")  # close-on-exec by default
    try:
        os.chmod(directory, 0o700)
        os.write(fd, token.encode())
        askpass = directory / "askpass.sh"
        askpass.write_text(ASKPASS)
        os.chmod(askpass, 0o700)
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in SCRUB_ENV
            and not k.startswith(
                ("GIT_TRACE", "GIT_CURL_VERBOSE", "GIT_ASKPASS", "SSH_ASKPASS")
            )
        }
        env.update(
            GIT_ASKPASS=str(askpass),
            STATEACTION_LAND_TOKEN_FD=str(fd),
            GIT_TERMINAL_PROMPT="0",
            GIT_CONFIG_COUNT="1",
            GIT_CONFIG_KEY_0="credential.helper",
            GIT_CONFIG_VALUE_0="",
        )
        yield env
    finally:
        os.close(fd)
        shutil.rmtree(directory, ignore_errors=True)


def gx(repo: Path, *args: str, env: dict | None = None, check=True, timeout=300) -> str:
    fds = (
        [int(env["STATEACTION_LAND_TOKEN_FD"])]
        if env and env.get("STATEACTION_LAND_TOKEN_FD")
        else []
    )
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        env=env,
        capture_output=True,
        timeout=timeout,
        pass_fds=fds,
    )
    if check and result.returncode:
        raise Refused(
            f"git {args[0]} failed: {result.stderr.decode(errors='replace').strip()[:300]}"
        )
    return result.stdout.decode(errors="replace").strip()


def fetch_main(repo: Path, env: dict | None) -> str:
    gx(repo, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", env=env)
    return gx(repo, "rev-parse", "refs/remotes/origin/main")


def rebase_onto_main(repo: Path) -> None:
    try:
        result = subprocess.run(
            ["git", "rebase", "refs/remotes/origin/main"],
            cwd=repo,
            capture_output=True,
            timeout=600,
        )
        failed = bool(result.returncode)
    except subprocess.TimeoutExpired:
        failed = True
    if failed:
        gx(repo, "rebase", "--abort", check=False)
        raise Landing(
            "rebase_conflict",
            "rebase onto origin/main failed or conflicts; nothing was pushed",
        )


def push_with_lease(repo: Path, env: dict | None, branch: str, expected: str) -> None:
    gx(
        repo,
        "push",
        f"--force-with-lease=refs/heads/{branch}:{expected}",
        "origin",
        f"HEAD:refs/heads/{branch}",
        env=env,
    )


def patch_id(repo: Path, rev: str) -> str:
    diff = subprocess.run(
        ["git", "diff-tree", "-p", "--no-commit-id", rev],
        cwd=repo,
        capture_output=True,
        timeout=120,
        check=True,
    ).stdout
    out = subprocess.run(
        ["git", "patch-id", "--stable"],
        cwd=repo,
        input=diff,
        capture_output=True,
        timeout=120,
        check=True,
    ).stdout.decode()
    return out.split()[0] if out.split() else ""


def runner_ids(repo: Path) -> tuple:
    return tuple(
        gx(repo, "rev-parse", f"HEAD:{path}", check=False) for path in RUNNER_FILES
    )


def worktree_owns_branch(repo: Path, branch: str) -> bool:
    """This worktree (its own toplevel) has `branch` checked out as a symbolic ref (not
    detached) AND `git worktree list --porcelain` registers exactly that path+branch pair."""
    repo = repo.resolve()
    if Path(gx(repo, "rev-parse", "--show-toplevel")).resolve() != repo:
        return False
    if gx(repo, "symbolic-ref", "-q", "HEAD", check=False) != f"refs/heads/{branch}":
        return False
    current = None
    for line in gx(repo, "worktree", "list", "--porcelain").splitlines() + [""]:
        if line.startswith("worktree "):
            current = {"path": Path(line[9:]).resolve(), "branch": None}
        elif line.startswith("branch ") and current:
            current["branch"] = line[7:]
        elif not line and current:
            if current["path"] == repo and current["branch"] == f"refs/heads/{branch}":
                return True
            current = None
    return False


def wait_pr_head(
    fetch_pr,
    head: str,
    *,
    timeout=PUSH_VISIBLE_WAIT,
    sleep=time.sleep,
    clock=time.monotonic,
) -> None:
    end = clock() + timeout
    while fetch_pr()["head"] != head:
        if clock() >= end:
            raise Landing(
                "push_not_visible", "the PR head did not update to the rebased head"
            )
        sleep(2.0)


# ------------------------------------------------------------------------ results


def land_dir(home: Path) -> Path:
    return local_ci.private_dir(Path(home) / "land")


def write_result(home: Path, number: int, key: str, result: dict) -> None:
    for name in (f"{key}.json", f"pr-{number}.json"):
        local_ci.write_json_private(land_dir(home) / name, result)


def stored_result(home: Path, number: int) -> dict | None:
    path = land_dir(home) / f"pr-{number}.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def gate_summary(record: dict) -> dict:
    stages = record.get("stages", [])
    # a stage stopped because another lane failed (cancelled) or never started (not-run) is
    # not the failure: name the first stage that actually failed, those two only as a fallback
    failed = next(
        (
            s
            for s in stages
            if s.get("status")
            not in ("passed", "skipped", "cancelled", "not-run", "interrupted")
        ),
        None,
    ) or next((s for s in stages if s.get("status") not in ("passed", "skipped")), None)
    summary = {
        "verdict": record.get("verdict"),
        "wallSec": record.get("wallSec"),
        "totalDurationSec": record.get("totalDurationSec"),
        "stageSec": {s["id"]: s.get("durationSec") for s in stages},
        "logDir": record.get("logDir"),
        "receipt": record.get("receipt"),
    }
    if record.get("verdict") != "PASS":
        summary["detail"] = record.get("detail")
        if failed:
            summary["failedStage"] = failed["id"]
            summary["failedStageLog"] = str(
                Path(record.get("logDir") or ".") / f"{failed['id']}.log"
            )
    return summary


# --------------------------------------------------------------------------- land


def default_gate(repo: Path, guard: dict | None, home: Path | None) -> dict:
    if not guard:
        raise Landing("no_guard", "a verified guard proof is required to run the gate")
    return local_ci.run_pipeline(
        repo, rev="HEAD", guard=guard, home=home, ci_mode="ci:land"
    )


def default_merge(repo: Path, number: int, github_repo: str, home: Path | None) -> None:
    # The caller holds the ci ticket and the merge lock: use the lock-free inner merge.
    local_ci._merge_pr(repo, number, github_repo=github_repo, execute=True, home=home)


def default_verify_merged(home: Path, github_repo: str, pr: dict) -> bool:
    """A merged PR counts as ours only if a PASS receipt exists for the merged commit's tree."""
    sha = pr.get("mergeSha")
    if not sha:
        return False
    commit = local_ci.gh_json("api", f"repos/{github_repo}/commits/{sha}")
    tree = ((commit.get("commit") or {}).get("tree") or {}).get("sha")
    return bool(tree) and (Path(home) / "receipts" / f"{tree}.json").is_file()


def default_identity() -> str | None:
    """Resolve timothywangdev's credential itself and export it as GH_TOKEN, so pr_info, policy
    and the merge never see the workstation's default gh account. Returns the problem (naming
    the fix) or None."""
    try:
        local_ci.resolve_owner_credential()
    except Refused as error:
        return str(error)
    return None


def default_submodules(repo: Path) -> list[str]:
    """Pinned submodules no local checkout can supply (the gate would fail late on them)."""
    return local_ci.missing_submodules(repo, git(repo, "rev-parse", "HEAD^{tree}"))


def strict_origin(repo: Path, github_repo: str) -> bool:
    fetch_url = gx(repo, "remote", "get-url", "origin", check=False)
    push_urls = gx(
        repo, "remote", "get-url", "--push", "--all", "origin", check=False
    ).splitlines()
    return (
        origin_allowed(fetch_url, github_repo)
        and bool(push_urls)
        and all(origin_allowed(u, github_repo) for u in push_urls)
    )


def land(
    repo: Path,
    number: int,
    *,
    github_repo: str,
    home: Path | None = None,
    guard: dict | None = None,
    fetch_pr=None,
    fetch=None,
    rebase=None,
    push=None,
    gate=None,
    merge=None,
    lock=None,
    policy=None,
    auth=None,
    reexec=None,
    verify_merged=None,
    identity=None,
    submodules=None,
    origin_check=None,
    expected_head: str | None = None,
    sleep=time.sleep,
    log=lambda message: print(message, file=sys.stderr, flush=True),
) -> tuple[int, dict]:
    """Return (exit code, result). Every injectable defaults to the real thing. Every failure
    class ends in a result file and a distinct exit code; only gate failures use exit 1."""
    repo = Path(repo).resolve()
    home = Path(home) if home else local_ci.local_ci_home()
    started = time.time()
    fetch_pr = fetch_pr or (lambda: pr_info(github_repo, number))
    policy = policy or (lambda pr: default_policy(github_repo, number, pr))
    auth = auth or github_auth
    env_box: dict = {"env": None}
    fetch = fetch or (lambda: fetch_main(repo, env_box["env"]))
    rebase = rebase or (lambda: rebase_onto_main(repo))
    push = push or (
        lambda branch, expected: push_with_lease(repo, env_box["env"], branch, expected)
    )
    gate = gate or (lambda: default_gate(repo, guard, home))
    merge = merge or (lambda: default_merge(repo, number, github_repo, home))
    lock = lock or (lambda: local_ci.merge_lock(home))
    identity = identity or default_identity
    submodules = submodules or (lambda: default_submodules(repo))
    origin_check = origin_check or (lambda: strict_origin(repo, github_repo))
    phase = "preflight"
    verify_merged = verify_merged or (
        lambda pr: default_verify_merged(home, github_repo, pr)
    )

    carried = {}
    with contextlib.suppress(ValueError, TypeError):
        carried = json.loads(os.environ.pop(STATE_ENV, "") or "{}")
    initial = carried.get("initialHead") or git(repo, "rev-parse", "HEAD")
    result: dict = {
        "schema": SCHEMA,
        "pr": number,
        "key": f"land-{number}-{initial}",
        "initialHead": initial,
        "attempts": int(carried.get("attempts", 0)),
        "rebased": bool(carried.get("rebased", False)),
    }

    def finish(
        code: int, status: str, reason: str | None = None, **extra
    ) -> tuple[int, dict]:
        result.update(
            status=status,
            reason=reason,
            exit=code,
            wallSec=round(time.time() - started, 2),
            **extra,
        )
        with contextlib.suppress(Exception):
            write_result(home, number, result["key"], result)
        return code, result

    def refuse(reason: str, message: str) -> tuple[int, dict]:
        return finish(EXIT.get(reason, EXIT_REFUSED), "refused", reason, detail=message)

    try:
        wrong = identity()
        if wrong:
            return refuse("identity", wrong)
        pr = fetch_pr()
        result["branch"] = pr["branch"]
        if pr["state"] == "merged":  # idempotent resubmit; never downgrades a fatal
            previous = stored_result(home, number)
            if previous and previous.get("status") in ("merged", "fatal"):
                return previous.get(
                    "exit", 0 if previous["status"] == "merged" else 3
                ), {**previous, "resubmitted": True}
            if verify_merged(pr):
                result.update(mergedSha=pr["mergeSha"])
                return finish(0, "merged", "merged_receipt_verified", resubmitted=True)
            result.update(mergedSha=pr["mergeSha"])
            return finish(
                EXIT["merged_unverified"],
                "merged_unverified",
                "merged_unverified",
                detail="the PR is merged but no result or receipt of this tool proves the merged tree was gated; "
                "verify it by hand",
            )
        if pr["state"] != "open" or pr["draft"]:
            return refuse(
                "pr_closed",
                f"PR #{number} is {pr['state']}{' (draft)' if pr['draft'] else ''}",
            )
        if pr["base"] != "main":
            return refuse("wrong_base", f"PR base is {pr['base']}, not main")
        if (pr["headRepo"] or "").lower() != github_repo.lower():
            return refuse(
                "foreign_branch",
                f"PR head repository {pr['headRepo']} is not {github_repo}",
            )
        if pr.get("author") != OWNER:
            return refuse(
                "foreign_branch", f"PR author {pr.get('author')} is not {OWNER}"
            )
        if not OWN_BRANCH.fullmatch(pr["branch"]):
            return refuse(
                "foreign_branch",
                f"branch {pr['branch']!r} is not wanghujie/sa-<n>-<slug>",
            )
        for marker in ("rebase-merge", "rebase-apply"):
            if (repo / gx(repo, "rev-parse", "--git-path", marker)).exists():
                return refuse(
                    "rebase_in_progress",
                    "a rebase is in progress in this worktree; abort it first",
                )
        branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
        if branch != pr["branch"] or not worktree_owns_branch(repo, branch):
            return refuse(
                "foreign_branch",
                f"checked-out branch {branch!r} in this worktree is not the PR's head branch "
                f"{pr['branch']!r}; only the caller's own PR branch is rebased",
            )
        if not origin_check():
            return refuse(
                "foreign_origin",
                f"origin (fetch and push URL) must be exactly https://github.com/{github_repo}[.git]",
            )
        if expected_head and pr["head"] != expected_head:
            return refuse("head_mismatch", "the PR head is not the expected head")
        if git(repo, "rev-parse", "HEAD") != pr["head"]:
            return refuse(
                "head_mismatch",
                "local HEAD differs from the PR head; push or reset first",
            )
        if git(repo, "status", "--porcelain", "--untracked-files=no"):
            return refuse("dirty_tree", "the working tree has tracked changes")
        missing = submodules()
        if missing:
            return refuse("submodule", "; ".join(missing))
        result["ticket"] = policy(
            pr
        )  # PolicyError -> exit 4, before any rebase, push or gate

        with auth() as env:
            env_box["env"] = env
            for attempt in range(
                result["attempts"] + 1, result["attempts"] + 1 + MAX_ATTEMPTS
            ):
                result["attempts"] = attempt
                if attempt > MAX_TOTAL_ATTEMPTS:
                    return refuse(
                        "base_moved",
                        "too many gate attempts across re-executions; resubmit",
                    )
                phase = "rebase"
                base = fetch()
                if (
                    git(repo, "rev-list", "--count", "--merges", f"{base}..HEAD") != "0"
                    or git(repo, "rev-list", "--count", f"{base}..HEAD") != "1"
                ):
                    return refuse(
                        "not_single_commit",
                        "the PR must be one non-merge commit above origin/main",
                    )
                head = git(repo, "rev-parse", "HEAD")
                if git(repo, "rev-parse", "HEAD^") != base:
                    if expected_head is not None:
                        return refuse(
                            "base_moved",
                            "the expected head needs a rebase and renewed local qualification",
                        )
                    log(f"land: main moved; rebasing {pr['branch']} onto {base[:12]}")
                    before_runner = runner_ids(repo)
                    before_patch = patch_id(repo, head)
                    rebase()
                    new_head = git(repo, "rev-parse", "HEAD")
                    if patch_id(repo, new_head) != before_patch:
                        gx(repo, "reset", "--hard", head)
                        return refuse(
                            "needs_review",
                            "the rebase changed the patch (patch-id differs); the earlier review no "
                            "longer covers it. Nothing was pushed; rebase by hand and get a review",
                        )
                    try:
                        push(pr["branch"], head)
                    except Exception as error:  # noqa: BLE001
                        gx(repo, "reset", "--hard", head, check=False)
                        return refuse(
                            "push_failed",
                            f"push failed ({error}); local branch restored to {head}",
                        )
                    wait_pr_head(fetch_pr, new_head, sleep=sleep)
                    head = new_head
                    result["rebased"] = True
                    if runner_ids(repo) != before_runner:
                        log(
                            "land: the gate runner changed in the rebase; re-executing on the new code"
                        )
                        raise _ReExec(attempt)
                result["head"] = head
                phase = "gate"
                log(f"land: gate attempt {attempt} on {head[:12]}")
                record = gate()
                result["gate"] = gate_summary(record)
                if record.get("verdict") != "PASS":
                    return finish(
                        EXIT_GATE_FAILED,
                        "gate_failed",
                        "gate_failed",
                        detail="no retry; fix, push, then resubmit with a new key suffix",
                    )
                result["receipt"] = record.get("receipt")
                phase = "merge"
                with lock():
                    current = fetch_pr()
                    if current["state"] != "open":
                        return refuse(
                            "pr_closed",
                            f"PR #{number} became {current['state']} during the gate",
                        )
                    if fetch() == git(repo, "rev-parse", "HEAD^"):
                        merge()
                        for _ in range(4):  # a GET right after the merge can lag
                            merged = fetch_pr()
                            if merged["state"] == "merged" and merged["mergeSha"]:
                                break
                            sleep(2.0)
                        if merged["state"] != "merged" or not merged["mergeSha"]:
                            raise local_ci.MergedOnUntestedBase(
                                "GitHub does not report the PR as MERGED"
                            )
                        return finish(0, "merged", None, mergedSha=merged["mergeSha"])
                if expected_head is not None:
                    return refuse(
                        "base_moved",
                        "origin/main moved during the gate for the expected head",
                    )
                log("land: main moved after the gate; rebasing and gating again")
            return refuse("base_moved", "origin/main kept moving; resubmit")
    except _ReExec as request:  # the auth block has been left: no secret outlives exec
        os.environ[STATE_ENV] = json.dumps(
            {"initialHead": initial, "attempts": request.args[0], "rebased": True}
        )
        log("land: the gate runner changed in the rebase; re-executing on the new code")
        (reexec or (lambda: None))()
        os.environ.pop(STATE_ENV, None)  # only reached when exec did not replace us
        return refuse(
            "runner_changed",
            "the gate runner changed in the rebase and cannot re-execute",
        )
    except Landing as error:
        return refuse(error.reason, str(error))
    except github_policy.PolicyError as error:
        return finish(EXIT["policy"], "refused", "policy", detail=str(error))
    except local_ci.MergedOnUntestedBase as error:
        return finish(EXIT["fatal"], "fatal", "fatal", detail=str(error))
    except subprocess.CalledProcessError as error:
        reason = "merge_failed" if phase == "merge" else "error"
        return finish(
            EXIT[reason],
            "error",
            reason,
            detail=f"{phase}: {error.cmd[:3]} exited {error.returncode}",
        )
    except subprocess.TimeoutExpired as error:
        return finish(
            EXIT["error"], "error", "timeout", detail=f"{error.cmd[:2]} timed out"
        )
    except Refused as error:
        return finish(EXIT["refused"], "refused", "refused", detail=str(error))
    except Exception as error:  # noqa: BLE001  (every class ends in a result file)
        return finish(
            EXIT["error"], "error", type(error).__name__, detail=str(error)[:300]
        )
    except (
        BaseException
    ) as error:  # SIGTERM (SystemExit) or Ctrl-C: record, then propagate
        finish(
            EXIT["interrupted"],
            "interrupted",
            type(error).__name__,
            detail="stopped before finishing",
        )
        raise


# --------------------------------------------------------------------------- cli


def reexec_clean(script: str, argv: list[str]) -> None:
    """Replace the process image; a GH_TOKEN this tool resolved itself does not outlive it
    (the new image resolves it again)."""
    if local_ci.GH_TOKEN_SET_BY_TOOL["value"]:
        os.environ.pop("GH_TOKEN", None)
    os.execv(sys.executable, [sys.executable, script, *argv])


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--repo", default=local_ci.GITHUB_REPO)
    parser.add_argument(
        "--expected-head",
        help="land only this exact PR head and refuse if main moves",
    )
    args = parser.parse_args(argv)

    def terminated(_signum, _frame):
        raise SystemExit(143)

    signal.signal(signal.SIGTERM, terminated)
    try:
        repo = Path(git(Path.cwd(), "rev-parse", "--show-toplevel"))
        head = git(repo, "rev-parse", "HEAD")
        script = str(Path(__file__).resolve())
        guard = local_ci.ensure_guard([script, *argv], key=f"land-{args.pr}-{head}")
        code, result = land(
            repo,
            args.pr,
            github_repo=args.repo,
            guard=guard,
            expected_head=args.expected_head,
            reexec=lambda: reexec_clean(script, argv),
        )
    except Refused as error:
        print(f"LAND REFUSED: {error}", file=sys.stderr)
        print(
            json.dumps(
                {
                    "schema": SCHEMA,
                    "status": "refused",
                    "reason": "refused",
                    "detail": str(error),
                }
            )
        )
        return 75
    print(
        json.dumps(result, sort_keys=True)
    )  # last line: what `agent-resource find` shows
    return code


if __name__ == "__main__":
    raise SystemExit(main())
