# Implementation milestones

Updated: 2026-10-26. Target: [selected technical design](technical-design.md) and [Render deployment](components/render-deployment.md). These are engineering deliverables; no backend/worker deployment has been performed.

## Work sequence

| Milestone | Owner / dependency | Deliverables | Exit evidence |
| --- | --- | --- | --- |
| M0. Contracts, service builds and limits | Backend + robotics; first | Next.js/Node24, Better Auth, Render Postgres/Workflows build targets; shared OpenAPI/JSON Schemas, migrations/version pins, rights/regions/retention and resource/budget config | Root workspace builds web/tasks/cron separately; one identity authority; tenant constraints, cross-language fixtures and storage qualification plan |
| M1. Identity and capture transfer | Identity + mobile/backend; M0 | Independently configured Better Auth, enrollment, owner-bound offline journal, direct multipart upload/seal and recovery | Physical-device login/expiry/account-switch tests; complete interrupted large-file transfer and sidecar/seal race |
| M2. Cloud CPU pipeline | Platform + robotics; M0/M1 | Render task controllers, transactional outbox/minute cron, Modal adapter, claims/validation/admission, streamed ingest, native Curator cut/transcode with stable Lance batches | Controller restart/continuation and lost-dispatch tests; two-hour memory/scratch/read-byte receipt; same-root checkpoint/commit recovery; duplicate/cancel faults |
| M3. Review and delivery | Backend/frontend/data operations; develop UI alongside M1, integrate after M2 | Internal exact-revision review, rights/split checks, cloud exporter/validator, customer grants/inspection, complete downloader/loader | Concurrent review conflict; immutable release; every required file resumes/downloads/checksums with no hidden dependencies |
| M4. Pilot operations | Platform + mobile/data operations; M1–M3 | Same-region private Render services, scoped credentials, minute/daily cron, PITR/independent backup, spend controls and signed app build | Collector → review → customer full canary; private DB/pool limits, controller cancellation, restore/revocation exercise and gross cost receipt |
| M5. Optional models | ML/robotics; M2, independent of RGB pilot | Qualified embeddings/captions/hand adapters, model inventory/cache and profile switches | Exact image/context/GPU memory and recovery tests; commercial rights plus declared quality evidence |

M2 control code can use fake workers while ingest is built. M3 UI can use contract fixtures early. Internal review and customer delivery both ship in the first deployed product; optional model branches are not dependencies for a profile that does not promise them.

## Code ownership

| Root | Owns |
| --- | --- |
| `backend/` | Server-only shared TypeScript domain/auth/access modules, DB migrations, storage/Modal/Render adapters and workflow/cron entrypoints |
| `console/` | Next.js full Node server: internal/customer UI, Better Auth and thin domain/internal/download route handlers |
| `processing/contracts/` | Canonical schemas and generated/validated TypeScript/Python/Dart conformance fixtures |
| `processing/capture/` | Streaming MCAP ingest, sensor/clock/geometry adapters and bounded sharding |
| `processing/curator/` | Pinned recipes, preparation/enrichment wrappers and native checkpoint integration |
| `processing/hand_pose/` | Replaceable model-specific adapter and qualification |
| `processing/models/`, `processing/validation/` | Model/version/rights registry; independently authorized read-only result validation |
| `processing/export/` | Portable packaging, manifest/loader and validation |
| `processing/images/`, `processing/modal_app.py` | Pinned images/private finite Functions and resource limits |
| `processing/tests/`, `backend/tests/` | Contract, integration, fault and sizing evidence |
| Existing Flutter client | Auth/API/owner-journal/upload integration, coordinated with ongoing capture fixes |

These are target modules, not implemented files. Build the web/task/cron artifacts from the repository root with pinned dependencies; keep the Stera app/SDK audit separate. The minute cron delivers/reconciles commands only; Render controllers choose successors. No second API/auth/catalog/workflow engine is required.

## Cross-component acceptance

| Failure to inject | Required outcome |
| --- | --- |
| Session expiry, account change, revoked assignment | Local source/journal retained; another identity cannot take ownership |
| App kill, URL expiry, lost part/complete response | Same logical upload resumes; exact parts/generation/hash checked |
| Seal and final required file arrive in either order | One ingest run/outbox event; missing required data never silently downgraded |
| Corrupt source, oversized dimensions, unsupported clock/geometry | Quarantine/explicit limitation; no unrequested GPU successor |
| Unknown Modal submission, duplicate event, stale lease | No blind respawn; one accepted result; safe accounting and writer takeover |
| Render retry/continuation, expired 24h provider idempotency or lost task acknowledgement | Existing DB scope/dispatch/attempt recovered; no duplicate GPU spawn; abandoned controller repaired by minute cron |
| Crash before/after native checkpoint/commit | Same-root compatible recovery; no full table copy or duplicate accepted inference |
| Cancel/delete/revoke during validation or export | Final API transaction rejects stale acceptance/publication |
| Changed labels, split overlap, uncleared rights/model | Publication blocked or new explicit revision; previous release unchanged |
| Interrupted full download, expired URLs, revoked grant | Complete paginated inventory, safe resume/checksums and no internal access |
| Database restore while compute/grants may survive | Reconcile external state/revocations before admission; no resurrected permission |

Use an isolated DB and fake storage/Modal adapters for protocol faults first. Real provider tests use synthetic data before an authorized, bounded canary. Record source/image/model/config digests, app build, measured peak resources, throughput, bytes and gross cost. A successful model forward pass does not establish geometry accuracy or training usefulness.

The [audit](design-audit.md) lists qualification gates. Component acceptance sections own detailed cases; avoid a second competing test specification here.
