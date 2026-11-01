# Delivery standards and milestone gates

## Working agreement

- Do not guess individual assignees. ownerRole states the required discipline; assign one accountable person before starting.
- Milestone order and dependency edges are commitments to sequence, not invented calendar deadlines. Add target dates only after capacity/estimates are confirmed.
- S/M are relative planning sizes, not elapsed-time promises or native Linear points; calibrate to the team estimate scale before sprint commitment. Split a ticket if it no longer has one reviewable outcome.
- Native Linear priority is 2=High for feasibility, integrity/recovery and launch gates, 3=Normal for other work; do not create artificial Urgent tickets. The historical baseline JSON used custom intent 1=High/2=Normal, mapped to native 2/3. The mobile addendum records native values explicitly.
- Native blocked-by edges represent immediate prerequisites; omit redundant transitive edges. Milestones describe exit gates, not barriers that prevent early feasibility work in parallel.
- Backlog -> Todo -> In Progress -> In Review -> Done, mapped to existing team statuses; blocked work records native dependencies rather than a fabricated progress state.
- Triage weekly and before committing work. Review milestone exits against evidence; publish a concise weekly project update with outcomes, next work, blockers/owners and measured cost/quality risks.

## Ticket-to-code traceability

Use an issue branch and a PR title such as `SA-11: Scaffold platform foundations`. The PR body uses `Refs SA-11` for partial work and `Fixes SA-11` only when merging should complete all acceptance criteria. Reference additional affected issues separately. Include the change, validation evidence and remaining work using the repository's PR template. The `PR policy / Ticket reference` workflow checks the title on creation, edits and new commits; require that check in GitHub branch protection after it is published.

Native PR linking requires the [Linear GitHub integration](https://linear.app/docs/github) installed for the correct repository. Verify a real PR appears on its Linear ticket; commit text alone is insufficient. Publishing the repository, installing the GitHub App, configuring required checks and obtaining a hosted CI result are distinct steps. The latest implementation results are already on SA-11/SA-54/SA-60/SA-61, but repository integration and a linked PR have not yet been verified.

## Definition of Ready

- One accountable assignee, understood dependencies and sufficient input fixtures/access.
- Acceptance criteria and evidence method reviewed; open technical/product decisions have a named resolver.
- No unresolved source-migration conflict or unapproved paid activation.

## Definition of Done

- Acceptance criteria demonstrated with linked meaningful test/measurement evidence.
- Code/config reviewed; contract/permission/failure cases relevant to the change pass.
- Docs/runbooks and source/model/config provenance updated; no secret or raw private payload leakage.
- Completion is implementation evidence, never a design document or synthetic mock alone.

The [mobile implementation update](mobile-implementation-update.md) amends native capture/upload and codec/Rerun qualification scope. These gates describe required evidence, not completed work.

## Milestone exit gates

### M0 · Reproducible foundations

A clean clone builds mobile/native and Node/Python packages; versioned API plus H.264 MCAP/profile/clock schemas, generated descriptors and cross-language golden fixtures agree. Full Python SDK is optional reviewed reuse.

### M1 · Authenticated, resumable collection

Signed Android/iOS Google identities, truthful hardware H.264/raw-sensor capture, bounded EOS/close/recovery and actual background multipart adapters work with owner-bound journals and sealed stable files. Unsupported profiles and failures are explicit.

### M2 · Local CPU processing

Golden and native H.264 plus historical JPEG pass bounded one-pass CPU hands, IDR-safe MP4 remux, paired Rerun0.41 review assets, resource/fault tests and measured mobile codec/device qualification.

### M3 · Internal review and customer inspection

Pipeline recording details lead to all generated clips. Staff approve/assign atomically; datasets contain approved clips only. Authorized customers use the same real viewer without internal data or mutation access.

### M4 · Bounded cloud CPU canary

The same contracts run on Render, R2 and Modal CPU. Real provider failure recovery, direct transfers, measured cost/resource limits, monitoring and an isolated database restore pass.

### M5 · Collection pilot ready

The frozen qualified device/profile passes signed physical two-hour capture/upload/cloud-process/review with complete sensor/clock/calibration/drop/hash evidence, measured limits/cost and staff/customer UAT. No design-only or historical JPEG evidence substitutes.

## Project completion

All MVP issues must have implementation evidence and the pilot go/no-go must pass. A design document, offline mock, provider fixture or successful short run does not establish real auth, database races, model usefulness or two-hour/cloud readiness. Blockers require an accountable resolver and next action. Do not mark failed qualification as Done to improve completion percentage. Paid activation is separately controlled; this project setup does not provision services.
