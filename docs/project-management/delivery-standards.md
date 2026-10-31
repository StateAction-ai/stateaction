# Delivery standards and milestone gates

## Working agreement

- Do not guess individual assignees. ownerRole states the required discipline; assign one accountable person before starting.
- Milestone order and dependency edges are commitments to sequence, not invented calendar deadlines. Add target dates only after capacity/estimates are confirmed.
- S/M are relative planning sizes, not elapsed-time promises or native Linear points; calibrate to the team estimate scale before sprint commitment. Split a ticket if it no longer has one reviewable outcome.
- 1=High for early feasibility, current foundations, integrity/recovery or launch gates; 2=Normal for other required MVP work. Required scope alone does not make an issue High. No artificial Urgent tickets.
- Native blocked-by edges represent immediate prerequisites; omit redundant transitive edges. Milestones describe exit gates, not barriers that prevent early feasibility work in parallel.
- Backlog -> Todo -> In Progress -> In Review -> Done, mapped to existing team statuses; blocked work records native dependencies rather than a fabricated progress state.
- Triage weekly and before committing work. Review milestone exits against evidence; publish a concise weekly project update with outcomes, next work, blockers/owners and measured cost/quality risks.

## Definition of Ready

- One accountable assignee, understood dependencies and sufficient input fixtures/access.
- Acceptance criteria and evidence method reviewed; open technical/product decisions have a named resolver.
- No unresolved source-migration conflict or unapproved paid activation.

## Definition of Done

- Acceptance criteria demonstrated with linked meaningful test/measurement evidence.
- Code/config reviewed; contract/permission/failure cases relevant to the change pass.
- Docs/runbooks and source/model/config provenance updated; no secret or raw private payload leakage.
- Completion is implementation evidence, never a design document or synthetic mock alone.

## Milestone exit gates

### M0 · Reproducible foundations

A clean clone builds the mobile, web, jobs and Python packages; versioned contracts, database constraints and the official Render local runner are reproducible. No production services are assumed.

### M1 · Authenticated, resumable collection

Real console/mobile identities and owner-bound journals work. Closed MCAP and required sidecars upload directly through the sealed multipart protocol; interruption and account changes preserve ownership and bytes.

### M2 · Local CPU processing

A short real recording passes the official local workflow into mandatory hand inference, bounded immutable outputs and a safe RRD. Fault cases and representative long-input memory/scratch/runtime limits are demonstrated.

### M3 · Internal review and customer inspection

Pipeline recording details lead to all generated clips. Staff approve/assign atomically; datasets contain approved clips only. Authorized customers use the same real viewer without internal data or mutation access.

### M4 · Bounded cloud CPU canary

The same contracts run on Render, R2 and Modal CPU. Real provider failure recovery, direct transfers, measured cost/resource limits, monitoring and an isolated database restore pass.

### M5 · Collection pilot ready

A signed physical-device two-hour capture/upload/process/review flow meets documented limits and repair-footage usefulness criteria. Internal and customer UAT, permission/retention decisions and rollout/rollback evidence are recorded.

## Project completion

All MVP issues must have implementation evidence and the pilot go/no-go must pass. A design document, offline mock, provider fixture or successful short run does not establish real auth, database races, model usefulness or two-hour/cloud readiness. Blockers require an accountable resolver and next action. Do not mark failed qualification as Done to improve completion percentage. Paid activation is separately controlled; this project setup does not provision services.
