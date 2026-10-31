# StateAction.ai implementation project

[Open the Linear project](https://linear.app/hw-personal-projects/project/stateactionai-collection-and-review-mvp-392311683a3e). Linear is the live source of truth for issue status, assignees, native estimates, dates and decisions.

The imported baseline covers the collection/review MVP: **six milestones, 40 implementation and qualification tickets**. The source plan and native Linear IDs are retained here for traceability, not as a second live task tracker. Application implementation and paid deployment remain separate work.

Live Linear documents: [scope](https://linear.app/hw-personal-projects/document/project-brief-and-scope-451f8b9b2df3), [delivery standards and gates](https://linear.app/hw-personal-projects/document/delivery-standards-and-milestone-gates-2a319c649690), [technical baseline](https://linear.app/hw-personal-projects/document/technical-design-approved-mvp-baseline-d48076a1dee2) and [all tickets/dependencies](https://linear.app/hw-personal-projects/document/implementation-backlog-and-traceability-af9bfc2cea06).

## Project artifacts

| Artifact | Purpose |
| --- | --- |
| [Project brief](project-brief.md) | Outcome, agreed stack, scope and explicit follow-up limits |
| [Delivery standards](delivery-standards.md) | Ready/Done criteria, ownership, review cadence and milestone exit evidence |
| [Planning baseline](linear-plan.json) | Exact ticket scope, acceptance criteria, validation and immediate dependencies |
| [Linear receipt](linear-receipt.json) | Actual project/milestone/document/issue IDs and remote verification |
| [Independent Linear readback](linear-independent-verification.json) | Separate-context project/list checks and four detailed ticket/dependency samples |
| [Plan validation](plan-validation.json) | Dependency/reference checks and MVP requirement coverage |

Publishing readback verified all 40 tickets, 63 native dependency edges, 140 acceptance criteria, six milestones and four documents. Independent readback confirmed the full project list/metadata and four detailed ticket/relationship samples. This verifies the project setup; application acceptance evidence is future work.

## Milestones

| Milestone | Tickets | Exit |
| --- | ---: | --- |
| M0 · Reproducible foundations | 5 | A clean clone builds the mobile, web, jobs and Python packages; versioned contracts, database constraints and the official Render local runner are reproducible. No production services are assumed. |
| M1 · Authenticated, resumable collection | 9 | Real console/mobile identities and owner-bound journals work. Closed MCAP and required sidecars upload directly through the sealed multipart protocol; interruption and account changes preserve ownership and bytes. |
| M2 · Local CPU processing | 10 | A short real recording passes the official local workflow into mandatory hand inference, bounded immutable outputs and a safe RRD. Fault cases and representative long-input memory/scratch/runtime limits are demonstrated. |
| M3 · Internal review and customer inspection | 7 | Pipeline recording details lead to all generated clips. Staff approve/assign atomically; datasets contain approved clips only. Authorized customers use the same real viewer without internal data or mutation access. |
| M4 · Bounded cloud CPU canary | 6 | The same contracts run on Render, R2 and Modal CPU. Real provider failure recovery, direct transfers, measured cost/resource limits, monitoring and an isolated database restore pass. |
| M5 · Collection pilot ready | 3 | A signed physical-device two-hour capture/upload/process/review flow meets documented limits and repair-footage usefulness criteria. Internal and customer UAT, permission/retention decisions and rollout/rollback evidence are recorded. |

## Kickoff and management

- Start by assigning [SA-10: mobile-source handoff](https://linear.app/hw-personal-projects/issue/SA-10/migrate-the-mobile-recorder-and-sdk-into-the-monorepo-safely) and [SA-11: package scaffolding](https://linear.app/hw-personal-projects/issue/SA-11/scaffold-the-typescript-and-python-packages-with-repeatable-ci). Run [SA-24: CPU-hand/Rerun feasibility](https://linear.app/hw-personal-projects/issue/SA-24/prove-cpu-hand-overlays-and-real-rerun-playback-early) as soon as scaffolding exists; it does not wait for the entire upload/UI stack.
- Timothy W is the project lead. Each ticket records its owner discipline; assign one accountable individual before moving it out of Backlog. No calendar deadlines, cycles or native point estimates are fabricated.
- Relative S/M sizes require team calibration. In the planning JSON, priority intent `1=High` / `2=Normal` maps to native Linear `2=High` / `3=Normal`; nothing is Urgent.
- Use the existing Backlog → Todo → In Progress → In Review → Done states. Native blocked-by relations carry prerequisite work. Milestones are evidence gates, not rigid barriers against useful parallel work.
- Review blockers, owner/capacity and milestone evidence weekly. Capture a concise outcome/next-work/blockers/risks update in Linear; do not mark mock-only or failed qualification work Done.
- Dataset versions/export/download are a separate future increment. GPU upgrades, Curator/Lance and organization/admin/sharing UI are outside MVP completion.

Source design: [technical design](../technical-design.md), [contracts](../contracts.md), [implementation milestones](../implementation-plan.md), [review/launch gates](../mvp-review.md). Baseline revision: `5955d66`.
