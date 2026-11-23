# Ticket ownership, phases and flaky tests

Mandatory. `AGENTS.md` has the short form.

## One agent owns a ticket from plan to merge

One agent owns a ticket end to end: plan, implement, test, independent review by other agents or models, fix, land with its own `ci:land` ticket and set Linear Done. There are no runner/lander hand-offs. The owner asks the user only for a decision it cannot make.

1. **Plan** (about 5 min): read the Linear criteria and the code path; write a short plan and the criteria checklist in the handoff. State stubs for unmerged dependencies.
2. **Implement and test** (about 30 min): Free commands only, red/green tests, a small localized diff.
3. **Review**: a read-only reviewer on a different model or family; two in parallel for guard, merge-policy, migration, auth or secrets code. Fix every material finding in ONE round and verify the fixes yourself; a second review only for blockers or a changed design.
4. **Land**: format, one squashed commit with `Fixes SA-n`, push, open the PR with the criteria checklist, submit your own `agent-resource run --lane ci --key land-<pr>-<head> -- pnpm ci:land --pr <n>`. At most 3 gate tickets per PR, with the root cause recorded before every resubmit.
5. **Blocked** by a real dependency: do not merge; log `blocked` with the reason and report.

## Phase log

Log each phase with `flowlog event --ticket SA-n --event <event> --note "..."` (`ticketlog SA-n <event> "note"` is a shim for the same call). Events: `start`, `code_ready`, `review_start`, `review_done`, `fix_done`, `land_submitted`, `land_done`, `merged`, `blocked`. `ci:local` and `ci:land` also call `flowlog ci-run` at the end of a run (best effort: a missing flowlog never fails the gate). Read the flow with `flowlog report --project timothywangdev/stateaction`.

## Zero flaky tests

A test or stage that passes and fails on the same tree is a P0 bug.

- Never skip, retry, loosen, quarantine or reorder a test to get green.
- Record the root cause (which test or process, why) before any gate resubmit. An unknown cause is a blocker, not a rerun.
- A failure in your PR's gate is yours: fix it in your PR even if the flaw predates your change. A flake found in unchanged, already merged code outside any open PR gets an urgent ticket at once (with the user's say-so).
- A new or changed test runs 20 times in a row (Free command) with zero failures before landing; record it in the handoff.
- Tests are deterministic: ready signals instead of sleeps, no shared ports, per-test state, bounded waits.
