# StateAction.ai implementation project

[Open the Linear project](https://linear.app/hw-personal-projects/project/stateactionai-collection-and-review-mvp-392311683a3e). Linear is the live source of truth for issue status, assignees, native estimates, dates and decisions.

Canonical GitHub repository: [timothywangdev/stateaction](https://github.com/timothywangdev/stateaction), private. The existing repository was renamed to preserve history. PR titles carry the primary Linear ID; native integration and hosted-check evidence must be verified on actual published PRs.

The imported baseline covers the collection/review MVP: **six milestones, 40 implementation and qualification tickets**. The source plan and native Linear IDs are retained here for traceability, not as a second live task tracker. Application implementation and paid deployment remain separate work.

The subsequent [mobile implementation update](mobile-implementation-update.md) added **10 tickets** and amended **14 existing tickets**, producing a verified 50-ticket/90-dependency plan. It specifies H.264-in-MCAP, complete sensor/clock/calibration evidence, native Android/iOS capture and upload work, paired Rerun 0.41.0, and physical-device qualification. [Live mobile specification](https://linear.app/hw-personal-projects/document/mobile-implementation-h264-capture-and-reliable-upload-5677599f65bd). Its [remote receipt](linear-mobile-update-receipt.json) records publication/readback separately from the original baseline.

Three [Android feasibility spikes](../spikes/android-feasibility.md) now gate native capture, CPU/Rerun integration and native uploads. **Current project: 53 tickets, six milestones and 94 dependencies.** The [Android receipt](android-spike-receipt.json) verifies all remote dependency relations, no cycles and a path from each spike to the final acceptance gate. Results belong on the actual Linear tickets; unexecuted hardware/auth/provider checks remain explicit.

Implementation update, 2026-11-01: opt-in Android H.264 and local capture→CPU→Rerun checks are committed at `2005c06`. The [implementation receipt](android-capture-implementation-receipt.json) verifies seven updated issues and both live specification/backlog documents, with prerequisite relations preserved. SA-10 remains Done; capture/processing tickets remain In Progress for physical and cross-platform gates. See the [runbook](../components/android-h264-implementation.md) and [exact validation](../validation/android-h264-e2e.json).

Implementation update, 2026-11-01 (commit `23f41f7`): the [platform foundation](../components/platform-foundations.md) now passes clean locked builds and the official Render local runner with real Postgres/S3 and an installed Python worker. SA-11 remains In Progress until hosted CI evidence exists. The [actual Flutter UI check](../validation/flutter-capture-ui.json) adds Start/Stop/Retry/discard and saved details; its new sources pass packaged CPU processing and actual Rerun. Phone qualification and product auth/upload/review remain open. The [publication receipt](platform-ui-implementation-receipt.json) verifies four issue updates, three live documents and unchanged prerequisite relations.

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
| [Mobile implementation update](mobile-implementation-update.md) | Current native capture/upload work, actual new ticket links and implementation order |
| [Mobile addendum](mobile-implementation-addendum.json) | Reviewed new scopes, existing amendments and additive prerequisites; original baseline is unchanged |
| [Mobile publication receipt](linear-mobile-update-receipt.json) / [graph validation](mobile-plan-validation.json) | Actual updated Linear records and combined 50-ticket/90-dependency checks |
| [Android feasibility results](../spikes/android-feasibility.md) / [publication receipt](android-spike-receipt.json) | Three Android-only spike tickets, results, production prerequisites and 53-ticket/94-dependency readback |
| [Android implementation receipt](android-capture-implementation-receipt.json) | Committed recorder/CPU/Rerun implementation, final tests, seven issue result updates and preserved prerequisite readback |
| [Platform/UI implementation receipt](platform-ui-implementation-receipt.json) | Committed foundation and actual Flutter UI results; four issue/three document updates and preserved prerequisite readback |

Original publishing readback verified 40 tickets, 63 native dependencies, 140 acceptance criteria, six milestones and four documents. Original independent readback confirmed metadata and four detailed samples. The mobile addendum retains that history and has its own current receipt; project setup verification is distinct from future application acceptance evidence.

## Milestones

| Milestone | Tickets | Exit |
| --- | ---: | --- |
| M0 · Reproducible foundations | 9 | Clean-clone mobile/native and Node/Python builds; versioned API/capture/clock schemas, generated video descriptors and cross-language golden fixtures; three Android feasibility spikes. Full Python SDK is optional reviewed reuse. |
| M1 · Authenticated, resumable collection | 17 | Signed-device login, H.264/raw-sensor capture, bounded EOS/close/recovery and actual Android/iOS multipart adapters preserve original owner, evidence and stable bytes. Unsupported profiles and failures are explicit. |
| M2 · Local CPU processing | 11 | Mixed-schema H.264 and legacy JPEG pass bounded CPU inference, IDR-safe MP4 remux, paired Rerun 0.41.0 and resource/fault tests; measured codec/device qualification is recorded. |
| M3 · Internal review and customer inspection | 7 | Pipeline recording details lead to all generated clips. Staff approve/assign atomically; datasets contain approved clips only. Authorized customers use the same real viewer without internal data or mutation access. |
| M4 · Bounded cloud CPU canary | 6 | The same contracts run on Render, R2 and Modal CPU. Real provider failure recovery, direct transfers, measured cost/resource limits, monitoring and an isolated database restore pass. |
| M5 · Collection pilot ready | 3 | A signed physical-device two-hour capture/upload/process/review flow meets documented limits and repair-footage usefulness criteria. Internal and customer UAT, permission/retention decisions and rollout/rollback evidence are recorded. |

## Kickoff and management

- [SA-10: mobile-source migration](https://linear.app/hw-personal-projects/issue/SA-10/migrate-the-mobile-recorder-and-sdk-into-the-monorepo-safely) is Done. Controlled Android/CPU/Rerun implementation now has local evidence; continue its physical qualification alongside [SA-11: package scaffolding](https://linear.app/hw-personal-projects/issue/SA-11/scaffold-the-typescript-and-python-packages-with-repeatable-ci), auth/API/upload foundations and later [SA-24](https://linear.app/hw-personal-projects/issue/SA-24/prove-cpu-hand-overlays-and-real-rerun-playback-early) production integration. The cloud canary waits for the required local and provider checks.
- Timothy W is the project lead. Each ticket records its owner discipline; assign one accountable individual before moving it out of Backlog. No calendar deadlines, cycles or native point estimates are fabricated.
- Relative S/M sizes require team calibration. In the planning JSON, priority intent `1=High` / `2=Normal` maps to native Linear `2=High` / `3=Normal`; nothing is Urgent.
- Use the existing Backlog → Todo → In Progress → In Review → Done states. Native blocked-by relations carry prerequisite work. Milestones are evidence gates, not rigid barriers against useful parallel work.
- Review blockers, owner/capacity and milestone evidence weekly. Capture a concise outcome/next-work/blockers/risks update in Linear; do not mark mock-only or failed qualification work Done.
- Dataset versions/export/download are a separate future increment. GPU upgrades, Curator/Lance and organization/admin/sharing UI are outside MVP completion.

Source design: [technical design](../technical-design.md), [contracts](../contracts.md), [implementation milestones](../implementation-plan.md), [review/launch gates](../mvp-review.md). Baseline revision: `5955d66`.
