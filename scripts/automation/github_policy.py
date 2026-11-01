#!/usr/bin/env python3
"""Small, dependency-free GitHub policy shared by PR checks and the trusted merger."""

from __future__ import annotations

import json
import re
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

TITLE = re.compile(r"^(SA-[1-9][0-9]*): (\S(?:[^\r\n]*\S)?)$")
BRANCH = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*/(sa-[1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*$"
)
DECLARATION = re.compile(r"^\s*(Refs|Fixes)\s+(.*?)\s*$", re.MULTILINE | re.IGNORECASE)
TICKET = re.compile(r"\bSA-[1-9][0-9]*\b", re.IGNORECASE)
SHA = re.compile(r"^[0-9a-f]{40}$")
TRUSTED_AUTHORS = {"OWNER", "MEMBER", "COLLABORATOR"}
WORKFLOWS = (
    ("checks.yml", "CI", "Required checks"),
    ("pr-policy.yml", "PR policy", "Ticket reference"),
)


class PolicyError(RuntimeError):
    """The current PR or API response does not meet repository policy."""


class ApiError(PolicyError):
    """An API failure stops a sweep rather than skipping validation."""


class GitHub:
    def __init__(self, repo: str, token: str):
        if not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+", repo
        ) or repo.split("/")[-1] in {".", ".."}:
            raise PolicyError("Expected repository owner/name.")
        if not token:
            raise PolicyError("GITHUB_TOKEN or GH_TOKEN is required.")
        self.repo = repo
        self.token = token

    def request(self, method: str, path: str, body=None):
        request = Request(
            f"https://api.github.com/repos/{self.repo}/{path}",
            data=None if body is None else json.dumps(body).encode(),
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": "stateaction-pr-policy",
                "X-GitHub-Api-Version": "2026-03-10",
            },
        )
        try:
            with urlopen(request, timeout=30) as response:
                data = response.read()
                return json.loads(data) if data else None
        except HTTPError as error:
            # Never include request headers, a token, or arbitrary API response text.
            raise ApiError(
                f"GitHub {method} {path.split('?')[0]}: HTTP {error.code}"
            ) from error

    def pages(self, path: str, key: str | None = None, **query):
        items = []
        for page in range(1, 201):
            response = self.request(
                "GET", f"{path}?{urlencode(query | {'per_page': 100, 'page': page})}"
            )
            batch = response[key] if key else response
            if not isinstance(batch, list):
                raise PolicyError("GitHub returned an invalid list response.")
            items.extend(batch)
            if len(batch) < 100:
                return items
        raise PolicyError(
            "Pagination limit reached; refusing an incomplete policy check."
        )


def visible_body(pr: dict) -> str:
    """Hidden template comments do not establish a visible Linear link."""
    return re.sub(r"<!--.*?(?:-->|\Z)", "", pr.get("body") or "", flags=re.DOTALL)


def claimed_tickets(pr: dict) -> set[str]:
    """Recognize a prior PR even if one of its three identifiers was mistyped."""
    tickets = set()
    title = TITLE.fullmatch(pr.get("title", ""))
    branch = BRANCH.fullmatch(pr.get("head", {}).get("ref", ""))
    if title:
        tickets.add(title[1])
    if branch:
        tickets.add(branch[1].upper())
    for declaration in DECLARATION.finditer(visible_body(pr)):
        tickets.update(ticket.upper() for ticket in TICKET.findall(declaration[2]))
    return tickets


def validate_pr(pr: dict, repo: str, all_prs: list[dict]) -> str:
    if pr.get("state") != "open":
        raise PolicyError("PR must be open.")
    if pr.get("base", {}).get("ref") != "main":
        raise PolicyError("PR must target main.")
    if any(
        (pr.get(side, {}).get("repo") or {}).get("full_name", "").lower()
        != repo.lower()
        for side in ("head", "base")
    ):
        raise PolicyError(
            "Automatic merging is limited to branches in this repository."
        )
    if pr.get("author_association") not in TRUSTED_AUTHORS:
        raise PolicyError(
            "Automatic merging requires an owner, member, or collaborator author."
        )
    if not SHA.fullmatch(pr.get("head", {}).get("sha", "")):
        raise PolicyError("PR head SHA is invalid.")
    title = TITLE.fullmatch(pr.get("title", ""))
    branch = BRANCH.fullmatch(pr.get("head", {}).get("ref", ""))
    if not title or len(TICKET.findall(pr["title"])) != 1:
        raise PolicyError(
            "Use a title such as SA-11: Set up the monorepo (one ticket only)."
        )
    ticket = title[1]
    if not branch or branch[1].upper() != ticket:
        raise PolicyError(
            f"Copy the exact gitBranchName from Linear for {ticket}; "
            "it must include the Linear username prefix and matching issue ID."
        )
    declarations = list(DECLARATION.finditer(visible_body(pr)))
    if len(declarations) != 1 or declarations[0][2] != ticket:
        raise PolicyError(
            f"Include exactly one primary line: Refs {ticket} or Fixes {ticket}."
        )
    earlier = [
        other["number"]
        for other in all_prs
        if other["number"] < pr["number"] and ticket in claimed_tickets(other)
    ]
    if earlier:
        raise PolicyError(
            f"{ticket} already belongs to PR #{min(earlier)}; update or reopen that original PR."
        )
    return ticket


def get_validated_pr(api, number: int) -> tuple[dict, str]:
    pr = api.request("GET", f"pulls/{number}")
    all_prs = api.pages("pulls", state="all", sort="created", direction="asc")
    return pr, validate_pr(pr, api.repo, all_prs)


def successful_workflows(api, pr: dict) -> tuple[bool, str]:
    """Trust actual workflow IDs, paths, latest runs, and final jobs, not check names."""
    for filename, name, job_name in WORKFLOWS:
        workflow = api.request("GET", f"actions/workflows/{filename}")
        path = f".github/workflows/{filename}"
        if (
            workflow.get("path") != path
            or workflow.get("name") != name
            or workflow.get("state") != "active"
        ):
            return False, f"{name} workflow identity is invalid or disabled"
        runs = api.pages(
            f"actions/workflows/{workflow['id']}/runs",
            "workflow_runs",
            head_sha=pr["head"]["sha"],
        )
        runs = [
            run
            for run in runs
            if run.get("workflow_id") == workflow["id"]
            and run.get("path") == path
            and run.get("name") == name
            and run.get("head_sha") == pr["head"]["sha"]
            and run.get("head_branch") == pr["head"]["ref"]
            and run.get("head_repository", {}).get("full_name", "").lower()
            == api.repo.lower()
            and run.get("event") in {"pull_request", "workflow_dispatch"}
            and (
                run["event"] == "workflow_dispatch"
                or any(
                    item.get("number") == pr["number"]
                    for item in run.get("pull_requests", [])
                )
            )
        ]
        if not runs:
            return False, f"{name} has no eligible run for the current head"
        latest = max(runs, key=lambda run: (run["id"], run.get("run_attempt", 1)))
        if latest.get("status") != "completed" or latest.get("conclusion") != "success":
            return False, f"latest {name} run has not succeeded"
        jobs = api.pages(
            f"actions/runs/{latest['id']}/attempts/{latest.get('run_attempt', 1)}/jobs",
            "jobs",
        )
        required = [job for job in jobs if job.get("name") == job_name]
        if (
            len(required) != 1
            or required[0].get("status") != "completed"
            or required[0].get("conclusion") != "success"
        ):
            return False, f"{name} / {job_name} must succeed (skipped is not success)"
    return True, "both exact-head workflow runs and final jobs succeeded"
