# StateAction.ai · Collection & review MVP

A repair worker can reliably upload a two-hour recording; our team reviews automatic 21-point hand clips and assigns approved data to datasets; authorized robotics customers inspect the same real viewer.

Prepared 2026-10-31. Planning baseline: repository revision `5955d66`. Application implementation and cloud deployment are pending.

## Agreed architecture

One monorepo: Flutter mobile/native recorder; Next.js/Node.js 24/TypeScript API, auth, web console and Render workflow controllers; Render Postgres; private R2 bulk storage; one shared Python processor locally and in finite Modal CPU functions. Use the official Render local workflow runner before cloud activation. Media bytes bypass Render. The API is the sole database writer and storage-signing authority.

## In scope

- Flutter mobile app and required native recorder in one monorepo; full Python SDK is optional reviewed reuse
- Node.js/TypeScript Next.js API/auth/UI and Render workflow controllers
- Better Auth Google login, minimal account Settings and sign-out
- Direct resumable MCAP multipart upload to private R2
- Official Render local runner and the same local/Modal CPU processing core
- Mandatory 21 image hand landmarks with explicitly model-relative 3D estimates
- Staff Pipeline recording details and recording-filtered clip review
- Atomic approval/assignment, approved-only many-to-many datasets and manual customer grants
- Real shared Rerun viewer and customer read-only inspection
- Bounded cloud CPU canary, failure recovery, resource/cost measurements and field pilot qualification

## Follow-up and non-goals

- Frozen dataset versions, publication, archive export and customer Download all (F1 follow-up)
- Cloud GPU, WiLoR/MANO/FLORA production models or automatic GPU upgrades
- Cosmos Curator, Ray, Lance, semantic captions/search/deduplication
- Generic DAG/outbox/extra workflow engine, independent validator or second API
- Organization/invitation/billing/admin/sharing interfaces
- Per-joint correction, validated metric trajectories, robot actions or demonstrated training benefit

## Success evidence

- Clean-clone builds and real official-runner local E2E
- Real Google/session/device ownership and interrupted multipart recovery
- Mandatory CPU hand inference, native frame mapping, reader/checksum round trip and safe real RRD
- Atomic approval/membership race proofs and actual cross-customer isolation
- Real provider recovery/closure/cancellation and isolated restore drill
- Measured representative two-hour resource/time/byte/cost receipt plus repair-footage usefulness pass
- Accountable internal/customer UAT and explicit pilot go/no-go

## Current planning status

Six milestones and **50 scoped implementation/qualification issues** after the [mobile addendum](mobile-implementation-update.md), which adds ten issues to the original 40-ticket baseline. The new source contract is hardware H.264 inside generic MCAP with original motion/clock/calibration evidence; Android/iOS capture and native upload correctness are explicit work. The project and issues start in Backlog. Timothy W is project lead; individual assignments and calendar commitments remain unset pending capacity review. No native estimate scale or active cycle is verified; relative sizes require team calibration.

The short CPU hand/Rerun probe starts after package scaffolding and can run alongside other foundation work. Milestones are exit gates, not rigid barriers. Frozen dataset delivery is a separate future increment and is excluded from MVP completion.

## Source of truth

Linear owns live status, assignees, estimates, dates and decisions. Repository `docs/project-management/linear-plan.json` records the imported scope/dependency baseline; source design is `docs/technical-design.md`, `docs/contracts.md`, `docs/implementation-plan.md` and referenced component paths. Do not treat local planning JSON as a live status mirror.
