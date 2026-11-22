# PR history, merge policy and Linear traceability

Mandatory. `AGENTS.md` has the short form. Merge mechanics and receipt validation: [local-ci.md](../local-ci.md). Ticket-to-PR flow overview: [repository-workflow.md](../repository-workflow.md) (describes the same flow; updated for the local gate).

## PR history and merge policy

- Rebase each PR onto the latest published `origin/main` before merging.
- Squash all commits in the PR into **one commit on main**. Do not create merge commits or preserve the PR's individual commits with GitHub's rebase-merge option.
- After a rebase, require review and a fresh local full-suite PASS receipt on the exact new head tree. Merge ready PRs; do not leave reviewed, tested work in draft. Keep remaining device, provider and deployment qualifications explicit on the ticket.
- When an owned PR branch needs a rewritten push, preserve its previous head and use `--force-with-lease` with the exact expected remote head. Never force-push or rewrite main, already merged history or another worker's branch.
- Automated merging must enforce squash merging and wait for the branch owner to rebase stale PRs; it must not refresh them with a merge commit.

## Linear and pull request traceability

- Canonical private repository: `timothywangdev/stateaction`. Verify the active GitHub account before changing remote settings or publishing. When several CLI accounts/sessions exist, pin each repository mutation to the `timothywangdev` credential; do not print or persist its token.
- Each ticket produces exactly one PR, and each PR has exactly one primary Linear ticket. Before creating a PR, search all existing PRs, including closed/merged ones, for that ticket. Update or reopen the original PR; never create a replacement or catch-all PR. After a PR merges, follow-up work needs a new ticket and its own PR.
- Before creating or naming a ticket branch, fetch that issue from Linear and use its exact `gitBranchName`, including the username prefix. Never invent, shorten or regenerate the branch name from the title. If Linear does not provide a branch name, resolve that missing value before branching. Use a title such as `SA-11: Scaffold platform foundations` and one `Refs SA-11` or `Fixes SA-11` declaration in its body. Other issues may be described as dependencies, not additional implementation references.
- Keep acceptance criteria, actual evidence and remaining gates on the ticket. Use `Fixes` only when all criteria are demonstrated. Keep unfinished code or unresolved review/test failures in draft; do not make a PR ready merely to trigger a merge. Track remaining device, provider and deployment qualification on the ticket rather than holding reviewed, tested isolated code in draft.
- Every ready PR is squash merged only after its current head is a single commit directly above the latest fetched `origin/main` (no merge commits) and carries a valid local full-suite PASS receipt plus the ticket policy. Merge with `pnpm ci:merge --pr <n> --execute` (see [local-ci.md](../local-ci.md)); it uses GitHub's squash merge with `--match-head-commit`, never pushes `main` and never fakes a hosted status. Hosted `CI` / `PR policy` workflows are manual and optional because hosted billing must not block merging. Never bypass a failed or missing local receipt or use an admin merge.
- Use ticket branches and PRs for all new implementation. Never push directly to `main`, force push `main`, or rewrite merged history; rewritten pushes are limited to your own PR branch with an exact `--force-with-lease` as described above. GitHub Free private repositories do not provide server-enforced protected branches; the pre-push hook and these instructions are required until a supported plan is explicitly selected.
- Record the actual PR URL on its ticket and verify native GitHub integration separately. A pasted URL/hash is traceability, not proof that the GitHub App is installed.
