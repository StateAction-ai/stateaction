# Ticket PR automation

Each ticket owns one PR, including after that PR is closed. Fetch the issue in Linear and use its **exact `gitBranchName`**, including the username prefix; never invent or shorten it. SA-11's provided name is `wanghujie/sa-11-scaffold-the-typescript-and-python-packages-with-repeatable`. Use title `SA-11: Short description` and exactly one body line `Refs SA-11` or `Fixes SA-11`. `Refs` links work in progress; use `Fixes` when merging completes every acceptance criterion. Other ticket IDs belong in dependency prose. A mistaken PR should be corrected or reopened, rather than replaced.

`PR policy / Ticket reference` checks the live PR metadata and searches all PRs, including closed and merged PRs, for an earlier claim. The lowest-number original remains canonical. It checks a username-prefixed branch with the matching issue ID. With no Linear API secret, it cannot verify the exact `gitBranchName`, issue existence or acceptance criteria. Agents must fetch and verify those in Linear before creating a branch or publishing.

`Merge passing ticket PRs` runs trusted scripts from `main` after either `CI` or `PR policy` completes. It serially sweeps eligible open PRs, because GitHub concurrency can replace a pending invocation. Each PR must have a trusted author, a branch in this repository, a `main` target, and successful latest `CI / Required checks` and `PR policy / Ticket reference` jobs for its exact current head. Missing, failed, cancelled, skipped, stale, or incomplete checks wait. Drafts wait.

If `main` is not an ancestor of the tested head, the merger requests an update with an expected-head guard, then explicitly dispatches both workflows on the PR branch. It waits for those new checks. Immediately before merging, it rechecks the live PR, `main`, and both workflows. The merge API also receives the expected head SHA. Merge commits preserve imported source history. No untrusted code, downloaded artifacts, dependency installation, or caches run with the merger's write token.

This uses the default `GITHUB_TOKEN`; no paid app or personal access token secret is required. On GitHub Free private repositories, this is repository automation, **not server-enforced branch protection**. An administrator can still push or merge manually, change metadata to erase a prior ticket claim, or race an external update to `main` in the final API interval. The no-direct-push hook and `AGENTS.md` rules cover authorized development; supported branch protection is the upgrade path if stronger enforcement becomes necessary. Only trusted repository collaborators' PRs are automatically merged. Workflow changes therefore remain trusted code changes.

## Local checks

```sh
python3 -m unittest discover -s tests/automation -p 'test_*.py' -v
```

The first PR introduces these workflows, so its `workflow_run` merger cannot execute until that PR lands on `main`. After that PR's hosted CI and policy checks succeed, a maintainer runs the **same guard**, using the existing GitHub CLI login. This is a one-time bootstrap, not a check bypass:

```sh
export GITHUB_REPOSITORY=timothywangdev/stateaction
GH_TOKEN="$(gh auth token)" python3 scripts/automation/auto_merge.py --pr 1
```

Replace `1` with the actual canonical PR number. Do not print or persist the token. A refused or waiting result must be resolved; do not substitute an admin merge. To retry later, dispatch `auto-merge.yml` from `main` with input `pr_number`.

If a branch update completes after the bounded poll expires, its new head may have no workflow runs. Retrying the merger alone then waits. After verifying the updated head, explicitly dispatch **both checks on that branch**, then retry the merger after they succeed:

```sh
PR_NUMBER=1
PR_BRANCH="$(gh pr view "$PR_NUMBER" --repo timothywangdev/stateaction --json headRefName --jq .headRefName)"
gh workflow run checks.yml --repo timothywangdev/stateaction --ref "$PR_BRANCH" -f "pr_number=$PR_NUMBER"
gh workflow run pr-policy.yml --repo timothywangdev/stateaction --ref "$PR_BRANCH" -f "pr_number=$PR_NUMBER"
```

After both succeed, `gh workflow run auto-merge.yml --repo timothywangdev/stateaction --ref main -f "pr_number=$PR_NUMBER"` rechecks the guard. API failures and external base changes also fail closed; investigate before retrying.

## Primary references

- [GitHub: events caused by GITHUB_TOKEN and explicit dispatch](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub: workflow_run trust and default-branch requirements](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GitHub: workflow run API](https://docs.github.com/en/rest/actions/workflow-runs)
- [GitHub: expected-head update and merge APIs](https://docs.github.com/en/rest/pulls/pulls)
- [Linear: GitHub linking and magic words](https://linear.app/docs/github)
