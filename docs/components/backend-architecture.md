# Backend implementation

MVP design · updated 2026-10-31 · Not implemented or deployed.

Parent: [technical design](../technical-design.md). Routes and schemas: [contracts](../contracts.md). See [auth](auth-and-access.md), [storage](storage-and-data-model.md), [jobs](job-orchestration.md) and [deployment](render-deployment.md).

## One application and fixed workflow contracts

Run Next.js/Node.js 24/TypeScript on Render for login, the mobile API, Pipeline status, shared Data browser and clip review. Render Postgres holds identity and nine current domain tables, plus a follow-up Dataset-version table. Processing uses Render Workflows; export remains a follow-up contract. Minute cron repairs missed starts/lost controllers. **The API is the sole database writer; workflows/cron have no database credentials.** R2 holds files; video bytes never traverse Next.

Implement `process_recording`: extract MCAP/native evidence, estimate hands, make accepted clips/review artifacts and validate output. Keep `export_release` packaging/closure as follow-up design; its UI is not required now. CPU MediaPipe provides mandatory 21 image landmarks and labelled 3D estimates, subject to asset/quality gates. No GPU is required.

| Target | Responsibility |
| --- | --- |
| `apps/web` | Next pages and thin Node route handlers, including Better Auth's official Next adapter |
| `apps/jobs` | Shared Render task definitions, execution adapters and finite repair-cron entrypoint |
| `packages/server` | Server-only auth, authorization, domain operations, Postgres/R2 adapters and migrations |
| `packages/contracts` | JSON schemas and cross-language fixtures; generated public types |
| `workers/processing` | Python extraction, hand inference, inline QC and future export |
| `apps/mobile` | Existing Flutter app, Android/iOS projects and durable upload journal |
| `packages/stera_recorder`, `packages/stera-sdk` | Existing recorder/plugin and SDK sources |

This is the target layout; do not move sources while recording fixes are in progress. Use pnpm workspaces for TypeScript, Flutter pub and Python uv separately. Reuse Render's SDK/local runner; no extra monorepo build framework is needed. [Better Auth integration](https://better-auth.com/docs/integrations/next)

## Small control operations

Route handlers validate bounded requests, resolve the principal, authorize the resource and call a domain operation. Transactions are short; provider calls happen outside them and finish with conditional updates. Private pages/responses bypass shared caches. Preserve individual rotated `Set-Cookie` headers. Next proxy redirects never substitute for route/data authorization.

Creating a job persists intent; after commit, make a bounded workflow-start request. Failure leaves the job repairable by cron; no outbox is necessary. Tasks `process-recording` and `export-release` claim/control through APIs. Before executing Python, persist submission intent, then record the Modal call ID or uncertainty. Each physical execution claims with its fresh nonce and actual function-call ID before reading media. A finish callback is provisional: API reconciliation checks terminal execution, closed outputs and current state before success. Manual processing retries create another job/prefix; native controller retries recover the same job/call. [Job protocol](job-orchestration.md)

Source/output uploads use API-allocated keys and multipart IDs, including small files. Workers get scoped job capabilities and part URLs, not reusable object-write credentials. The API completes uploads and seals the bounded manifest; sealed jobs cannot allocate more files. Heavy hashing/model checks stay in Python. [Upload](mcap-upload.md)

## Data browser and Datasets

`/data-browser` lists Dataset names, visible video counts and total hours; `?datasetId=UUID` opens screenshot/title/Task-label cards. Staff creates/manages Datasets and adds/removes existing accepted clips. `datasets` and `dataset_clips` hold many-to-many membership, not media copies; edits check `expectedRevision`. Use the `/api/v1/datasets` list/items/staff-mutation groups defined in [contracts](../contracts.md).

Operator-managed `dataset_access` grants enable customer review now. Customer responses include only current members whose latest review is approved; counts/hours use the same visibility. Recheck access on viewer URL issuance. No release/publication flow is required for this working view. Follow-up Dataset versions freeze the whole Dataset at a revision, blocking unreviewed/rejected members. [Dataset contract](data-browser-and-datasets.md)

## Shared clip viewer

One Next page, `/clips/[clipId]`, serves staff and customers via the immutable `clips` catalog. Open it from the Data browser; it has no sidebar entry. Metadata/capabilities come from `GET /api/v1/clips/:clipId`; `POST /api/v1/clips/:clipId/viewer-access` issues a short-lived direct R2 RRD URL; staff reviews use `POST /api/v1/clips/:clipId/reviews`. Recheck each operation. [Viewer](rerun-clip-review.md), [access](auth-and-access.md)

Mount **`@rerun-io/web-viewer@0.22.1`** in one client-only React adapter using dynamic import/effect lifecycle and cleanup; disable SSR for that adapter. Match Python SDK 0.22.1 and self-host its JS/WASM assets. Avoid the old React wrapper's separate React 18 dependency. No Rerun Cloud, external hosted iframe or persistent live SDK server is needed.

Both roles receive the same safe RRD and viewer component; staff-only forms/QC stay outside it. Start with ≤60-second clips, a proposed 128 MiB RRD ceiling and explicit 1280×720 review-proxy resize, preserving full native frame cadence/mapping. Qualify browser memory, CORS, sequential RRD loading, URL renewal and version compatibility; this RRD loader does not offer HTTP Range seeking. Never load the two-hour source into the viewer or display UUID/storage paths in the page.

## Development and acceptance

Run the same task definitions through Render's official local Workflows runner on port 8120 or its hosted service. `EXECUTION_BACKEND=local|modal` selects real Python `LocalExecutor` or `ModalExecutor`. Local Postgres/MinIO use `infra/compose.yaml`; MediaPipe CPU needs no GPU. Test customer viewing with operator Dataset grants and approved clips. Export/download generation is follow-up, not an implemented UI dependency. Local success does not qualify Modal/R2. [Local development](local-development.md)

Before pilot, prove builds, signed-device ownership, interrupted uploads, controller/unknown-submission recovery, catalog/review consistency and customer Dataset-grant/approval isolation. Test future archive generation separately when enabled. Stage DAGs, shared writable datasets and separate validators remain deferred. Workflow polling/retry follows the verified orchestration contract, not an assumed durable-sleep API.
