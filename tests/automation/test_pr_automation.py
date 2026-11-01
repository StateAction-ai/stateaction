"""Exercise the actual merger decisions against an injectable GitHub API."""

import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "automation"))

from auto_merge import candidates, merge_one  # noqa: E402
from github_policy import ApiError, GitHub, PolicyError, validate_pr  # noqa: E402

REPO = "timothywangdev/stateaction"
HEAD = "a" * 40
BASE = "b" * 40
NEW = "c" * 40
LINEAR_BRANCH = (
    "wanghujie/sa-11-scaffold-the-typescript-and-python-packages-with-repeatable"
)


def pull(number=11, ticket="SA-11"):
    return {
        "number": number,
        "title": f"{ticket}: Set up the monorepo",
        "body": f"Refs {ticket}\n\nDepends on SA-12 for the next increment.",
        "state": "open",
        "draft": False,
        "author_association": "OWNER",
        "base": {"ref": "main", "repo": {"full_name": REPO}},
        "head": {
            "ref": LINEAR_BRANCH
            if ticket == "SA-11"
            else f"wanghujie/{ticket.lower()}-test-fixture",
            "sha": HEAD,
            "repo": {"full_name": REPO},
        },
    }


class FakeGitHub:
    repo = REPO

    def __init__(self):
        self.pr = pull()
        self.other_prs = []
        self.writes = []
        self.base = BASE
        self.behind = False
        self.pr_reads = 0
        self.base_reads = 0
        self.calls = []
        self.on_pr_read = lambda _: None
        self.on_base_read = lambda _: None
        self.workflows = {}
        self.runs = {}
        self.jobs = {}
        for workflow_id, (filename, name, job) in enumerate(
            [
                ("checks.yml", "CI", "Required checks"),
                ("pr-policy.yml", "PR policy", "Ticket reference"),
            ],
            1,
        ):
            path = f".github/workflows/{filename}"
            self.workflows[filename] = {
                "id": workflow_id,
                "path": path,
                "name": name,
                "state": "active",
            }
            run_id = workflow_id * 100
            self.runs[workflow_id] = [
                {
                    "id": run_id,
                    "run_attempt": 1,
                    "workflow_id": workflow_id,
                    "path": path,
                    "name": name,
                    "head_sha": HEAD,
                    "head_branch": self.pr["head"]["ref"],
                    "head_repository": {"full_name": REPO},
                    "event": "pull_request",
                    "pull_requests": [{"number": 11}],
                    "status": "completed",
                    "conclusion": "success",
                }
            ]
            self.jobs[run_id] = [
                {"name": job, "status": "completed", "conclusion": "success"}
            ]

    def request(self, method, path, body=None):
        self.calls.append((method, path))
        if method != "GET":
            self.writes.append((method, path, deepcopy(body)))
            if path.endswith("/update-branch"):
                self.pr["head"]["sha"] = NEW
                return {"message": "Updating pull request branch"}
            if path.endswith("/merge"):
                return {"merged": True, "sha": "d" * 40}
            if path.endswith("/dispatches"):
                return None
            raise AssertionError((method, path))
        if path == "pulls/11":
            self.pr_reads += 1
            self.on_pr_read(self.pr_reads)
            return deepcopy(self.pr)
        if path == "git/ref/heads/main":
            self.base_reads += 1
            self.on_base_read(self.base_reads)
            return {"object": {"sha": self.base}}
        if path.startswith("compare/"):
            return {"merge_base_commit": {"sha": "e" * 40 if self.behind else BASE}}
        if path.startswith("actions/workflows/"):
            return deepcopy(self.workflows[path.rsplit("/", 1)[1]])
        raise AssertionError((method, path))

    def pages(self, path, key=None, **query):
        self.calls.append(("PAGES", path))
        if path == "pulls":
            return deepcopy([self.pr] + self.other_prs)
        if path.endswith("/runs"):
            workflow_id = int(path.split("/")[2])
            return deepcopy(self.runs[workflow_id])
        if path.endswith("/jobs"):
            run_id = int(path.split("/")[2])
            return deepcopy(self.jobs[run_id])
        raise AssertionError((path, key, query))


class IdentityTests(unittest.TestCase):
    def test_valid_one_ticket_with_dependency_prose(self):
        self.assertEqual(validate_pr(pull(), REPO, []), "SA-11")

    def test_closed_or_merged_original_blocks_duplicate(self):
        for state in ("open", "closed"):
            original = pull(number=3)
            original["state"] = state
            with self.assertRaisesRegex(PolicyError, "PR #3"):
                validate_pr(pull(), REPO, [original])

    def test_original_remains_canonical_after_later_duplicate(self):
        self.assertEqual(validate_pr(pull(), REPO, [pull(number=15)]), "SA-11")

    def test_previous_claim_detected_when_title_or_branch_was_mistyped(self):
        original = pull(number=3)
        original["title"] = "A legacy title"
        original["head"]["ref"] = "legacy-branch"
        with self.assertRaisesRegex(PolicyError, "PR #3"):
            validate_pr(pull(), REPO, [original])

    def test_title_branch_and_primary_reference_must_match(self):
        variants = [
            ("title", "Fix setup"),
            ("title", "SA-11:    "),
            ("title", "SA-11: Description "),
            ("title", "SA-11: \t"),
            ("title", "SA-11: Depends on SA-12"),
            ("body", "Refs SA-11\nFixes SA-12"),
            ("body", "Refs SA-11 and SA-12"),
            ("body", "Refs SA-011"),
            ("body", "No reference"),
        ]
        for field, value in variants:
            with self.subTest(field=field, value=value):
                pr = pull()
                pr[field] = value
                with self.assertRaises(PolicyError):
                    validate_pr(pr, REPO, [])
        pr = pull()
        pr["head"]["ref"] = "wanghujie/sa-12-different-ticket"
        with self.assertRaises(PolicyError):
            validate_pr(pr, REPO, [])

    def test_linear_provided_prefixed_branch_is_accepted(self):
        pr = pull()
        self.assertEqual(pr["head"]["ref"], LINEAR_BRANCH)
        self.assertEqual(validate_pr(pr, REPO, []), "SA-11")

    def test_missing_malformed_or_wrong_issue_linear_prefix_is_rejected(self):
        for branch in (
            "sa-11-invented-branch",
            "/sa-11-missing-username",
            "wanghujie//sa-11-extra-slash",
            "wanghujie/sa-12-wrong-issue",
            "wanghujie/SA-11-wrong-case",
            "wanghujie/sa-11-",
        ):
            with self.subTest(branch=branch):
                pr = pull()
                pr["head"]["ref"] = branch
                with self.assertRaisesRegex(PolicyError, "exact gitBranchName"):
                    validate_pr(pr, REPO, [])

    def test_refs_and_fixes_are_supported(self):
        for verb in ("Refs", "Fixes"):
            pr = pull()
            pr["body"] = f"{verb} SA-11"
            self.assertEqual(validate_pr(pr, REPO, []), "SA-11")

    def test_hidden_comments_do_not_satisfy_primary_reference(self):
        for body in (
            "<!--\nRefs SA-11\n-->",
            "<!-- Refs SA-11 -->",
            "<!--\nRefs SA-11",
        ):
            pr = pull()
            pr["body"] = body
            with self.assertRaises(PolicyError):
                validate_pr(pr, REPO, [])

    def test_hidden_template_reference_does_not_add_an_extra_ticket(self):
        pr = pull()
        pr["body"] = "Refs SA-11\n<!--\nRefs SA-123\n-->"
        self.assertEqual(validate_pr(pr, REPO, []), "SA-11")

    def test_forks_untrusted_authors_and_wrong_base_are_refused(self):
        for key, value in (
            ("head_repo", "outsider/fork"),
            ("author", "CONTRIBUTOR"),
            ("base", "release"),
        ):
            api = FakeGitHub()
            if key == "head_repo":
                api.pr["head"]["repo"]["full_name"] = value
            elif key == "author":
                api.pr["author_association"] = value
            else:
                api.pr["base"]["ref"] = value
            with self.assertRaises(PolicyError):
                merge_one(api, 11)
            self.assertEqual(api.writes, [])


class MergeTests(unittest.TestCase):
    def test_ready_pr_merges_with_expected_sha_and_preserves_history(self):
        api = FakeGitHub()
        self.assertEqual(merge_one(api, 11)["action"], "merged")
        self.assertEqual(len(api.writes), 1)
        method, path, body = api.writes[0]
        self.assertEqual((method, path), ("PUT", "pulls/11/merge"))
        self.assertEqual(body["sha"], HEAD)
        self.assertEqual(body["merge_method"], "merge")
        self.assertEqual(api.calls[-2], ("GET", "git/ref/heads/main"))

    def test_failed_cancelled_skipped_neutral_or_missing_final_job_never_merges(self):
        for workflow_id in (1, 2):
            for conclusion in (
                "failure",
                "cancelled",
                "skipped",
                "neutral",
                "timed_out",
                None,
            ):
                with self.subTest(workflow_id=workflow_id, conclusion=conclusion):
                    api = FakeGitHub()
                    api.jobs[workflow_id * 100][0]["conclusion"] = conclusion
                    self.assertEqual(merge_one(api, 11)["action"], "waiting")
                    self.assertEqual(api.writes, [])
            api = FakeGitHub()
            api.jobs[workflow_id * 100] = []
            self.assertEqual(merge_one(api, 11)["action"], "waiting")
            self.assertEqual(api.writes, [])

    def test_missing_incomplete_or_failed_workflow_never_merges(self):
        for change in ("missing", "queued", "failure", "cancelled", "skipped"):
            api = FakeGitHub()
            if change == "missing":
                api.runs[1] = []
            elif change == "queued":
                api.runs[1][0]["status"] = change
            else:
                api.runs[1][0]["conclusion"] = change
            self.assertEqual(merge_one(api, 11)["action"], "waiting")
            self.assertEqual(api.writes, [])

    def test_newest_failed_run_overrides_earlier_success(self):
        api = FakeGitHub()
        newer = deepcopy(api.runs[1][0])
        newer.update(id=101, conclusion="failure")
        api.runs[1].append(newer)
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_latest_attempt_must_pass(self):
        api = FakeGitHub()
        newer_attempt = deepcopy(api.runs[1][0])
        newer_attempt.update(run_attempt=2, conclusion="failure")
        api.runs[1].append(newer_attempt)
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_spoofed_workflow_path_id_event_repo_branch_or_pr_is_ignored(self):
        mutations = [
            ("path", ".github/workflows/fake.yml"),
            ("workflow_id", 999),
            ("event", "push"),
            ("head_branch", "main"),
            ("head_repository", {"full_name": "outsider/fork"}),
            ("head_sha", NEW),
            ("pull_requests", [{"number": 99}]),
        ]
        for key, value in mutations:
            with self.subTest(key=key):
                api = FakeGitHub()
                api.runs[1][0][key] = value
                self.assertEqual(merge_one(api, 11)["action"], "waiting")
                self.assertEqual(api.writes, [])

    def test_disabled_or_renamed_workflow_is_refused(self):
        for key, value in (
            ("state", "disabled_manually"),
            ("name", "Fake CI"),
            ("path", "fake.yml"),
        ):
            api = FakeGitHub()
            api.workflows["checks.yml"][key] = value
            self.assertEqual(merge_one(api, 11)["action"], "waiting")
            self.assertEqual(api.writes, [])

    def test_dispatch_run_can_be_used_after_branch_update(self):
        api = FakeGitHub()
        for runs in api.runs.values():
            runs[0].update(event="workflow_dispatch", pull_requests=[])
        self.assertEqual(merge_one(api, 11)["action"], "merged")

    def test_draft_and_stale_trigger_wait_without_writes(self):
        api = FakeGitHub()
        api.pr["draft"] = True
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])
        api.pr["draft"] = False
        self.assertEqual(merge_one(api, 11, expected_head=NEW)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_head_changes_during_validation_waits(self):
        api = FakeGitHub()
        api.on_pr_read = lambda count: (
            api.pr["head"].update(sha=NEW) if count == 2 else None
        )
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_main_changes_during_validation_waits(self):
        api = FakeGitHub()

        def update_base(count):
            if count == 2:
                api.base = NEW

        api.on_base_read = update_base
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_behind_base_updates_with_expected_head_then_dispatches_both_checks(self):
        api = FakeGitHub()
        api.behind = True
        result = merge_one(api, 11)
        self.assertEqual((result["action"], result["new_head"]), ("updated", NEW))
        self.assertEqual(
            api.writes,
            [
                ("PUT", "pulls/11/update-branch", {"expected_head_sha": HEAD}),
                (
                    "POST",
                    "actions/workflows/checks.yml/dispatches",
                    {"ref": LINEAR_BRANCH, "inputs": {"pr_number": "11"}},
                ),
                (
                    "POST",
                    "actions/workflows/pr-policy.yml/dispatches",
                    {"ref": LINEAR_BRANCH, "inputs": {"pr_number": "11"}},
                ),
            ],
        )

    def test_title_is_data_and_never_executed_by_a_shell(self):
        api = FakeGitHub()
        api.pr["title"] = "SA-11: $(touch /tmp/never) `echo unsafe`"
        with patch("subprocess.run", side_effect=AssertionError("No shell is allowed")):
            self.assertEqual(merge_one(api, 11)["action"], "merged")
        self.assertEqual(api.writes[-1][2]["commit_title"], api.pr["title"] + " (#11)")

    def test_api_read_failure_refuses_without_any_mutation(self):
        api = FakeGitHub()
        with (
            patch.object(api, "pages", side_effect=ApiError("GitHub API unavailable")),
            self.assertRaises(ApiError),
        ):
            merge_one(api, 11)
        self.assertEqual(api.writes, [])

    def test_merge_refusal_is_not_retried(self):
        api = FakeGitHub()
        request = api.request

        def refuse_merge(method, path, body=None):
            if path.endswith("/merge"):
                api.writes.append((method, path, body))
                return {"merged": False}
            return request(method, path, body)

        with (
            patch.object(api, "request", side_effect=refuse_merge),
            self.assertRaisesRegex(PolicyError, "no retry"),
        ):
            merge_one(api, 11)
        self.assertEqual(len(api.writes), 1)

    def test_slow_branch_update_does_not_dispatch_old_head_or_retry_update(self):
        api = FakeGitHub()
        api.behind = True
        request = api.request

        def delayed_update(method, path, body=None):
            if path.endswith("/update-branch"):
                api.writes.append((method, path, body))
                return {"message": "accepted"}
            return request(method, path, body)

        with (
            patch.object(api, "request", side_effect=delayed_update),
            self.assertRaisesRegex(PolicyError, "new head is not visible"),
        ):
            merge_one(api, 11, sleep=lambda _: None)
        self.assertEqual(
            api.writes, [("PUT", "pulls/11/update-branch", {"expected_head_sha": HEAD})]
        )

    def test_event_discovery_refuses_fork_trigger(self):
        api = FakeGitHub()
        event = {"workflow_run": deepcopy(api.runs[1][0])}
        self.assertEqual(candidates(api, event), [11])
        event["workflow_run"]["head_repository"]["full_name"] = "outsider/fork"
        with self.assertRaises(PolicyError):
            candidates(api, event)

    def test_event_sweeps_other_eligible_heads_to_handle_replaced_pending_triggers(
        self,
    ):
        api = FakeGitHub()
        other = pull(number=12, ticket="SA-12")
        other["head"]["sha"] = NEW
        fork = pull(number=13, ticket="SA-13")
        fork["head"]["repo"]["full_name"] = "outsider/fork"
        api.other_prs = [other, fork]
        event = {"workflow_run": deepcopy(api.runs[1][0])}
        self.assertEqual(candidates(api, event), [11, 12])

    def test_privileged_workflow_checks_out_only_main_and_no_artifacts_or_dependencies(
        self,
    ):
        workflow = (ROOT / ".github/workflows/auto-merge.yml").read_text()
        self.assertIn("ref: refs/heads/main", workflow)
        self.assertIn("persist-credentials: false", workflow)
        for disallowed in (
            "download-artifact@",
            "setup-node@",
            "pip install",
            "pnpm install",
            "head.sha",
            "pull_request_target:",
        ):
            self.assertNotIn(disallowed, workflow)


class ApiTests(unittest.TestCase):
    def test_missing_token_is_refused(self):
        with self.assertRaises(PolicyError):
            GitHub(REPO, "")

    def test_api_error_does_not_log_a_response_body_or_token(self):
        api = GitHub(REPO, "not-a-real-token")
        error = HTTPError("https://api.github.com/", 403, "private response", {}, None)
        with (
            patch("github_policy.urlopen", side_effect=error),
            self.assertRaises(ApiError) as caught,
        ):
            api.request("GET", "pulls/11")
        self.assertEqual(str(caught.exception), "GitHub GET pulls/11: HTTP 403")

    def test_repository_identity_rejects_path_injection(self):
        for repo in ("owner/repo/path", "../repo", "https://evil.example/repo"):
            with self.assertRaises(PolicyError):
                GitHub(repo, "not-a-real-token")

    def test_pagination_includes_closed_claims_on_later_pages(self):
        api = GitHub(REPO, "not-a-real-token")
        first = [
            pull(number=100 + index, ticket=f"SA-{100 + index}") for index in range(100)
        ]
        second = [pull(number=3)]
        with patch.object(api, "request", side_effect=[first, second]) as request:
            prs = api.pages("pulls", state="all")
        self.assertEqual(len(prs), 101)
        self.assertIn("page=2", request.call_args_list[1].args[1])
        with self.assertRaisesRegex(PolicyError, "PR #3"):
            validate_pr(pull(), REPO, prs)


if __name__ == "__main__":
    unittest.main()
