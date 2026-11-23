Fixes SA-<ticket number>

## Change

Describe the ticket's problem and resulting behavior. Use title `SA-123: Short description`. Fetch the issue in Linear and use its exact `gitBranchName`, including the username prefix; never invent or shorten the branch name.

## Acceptance criteria

Every criterion of the ticket with its evidence on this head. Replace the placeholder with one `- [x] criterion: evidence (command, receipt, log)` line per criterion. Merging requires every box checked and none unchecked (the unedited template below fails the policy on purpose); an unmet criterion blocks the merge.

- [ ] criterion: evidence

## Validation

List the checks run and any remaining limits. Update this same PR for the ticket; do not create replacement PRs.

Mention other tickets as dependencies in prose, without another Fixes declaration. Never use `Refs`.
