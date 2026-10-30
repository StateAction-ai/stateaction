# Backend implementation

MVP design · updated 2026-10-30 · Not implemented or deployed.

Parent: [technical design](../technical-design.md). Routes and schemas: [contracts](../contracts.md). See [auth](auth-and-access.md), [storage](storage-and-data-model.md), [jobs](job-orchestration.md) and [deployment](render-deployment.md).

## One application and two workflow tasks

Run Next.js/Node.js 24/TypeScript on Render for login, the mobile API, staff review and customer delivery. Render Postgres stores identity and seven domain tables. Two Render Workflow tasks orchestrate processing/export; a minute cron repairs missed starts and lost controllers. **The API is the sole database writer; workflows/cron have no database credentials.** R2 holds files; video bytes never traverse Next.

Two fixed Python functions do the work: `process_recording` extracts MCAP/native evidence, estimates hands, makes preview/clips and validates its own output; `export_release` packages approved clips and checks the archive. The mandatory starting profile is CPU MediaPipe: 21 image landmarks plus explicitly labelled 3D estimates. Exact asset terms and quality remain activation gates. No GPU is required for this profile.

| Target | Responsibility |
| --- | --- |
| `apps/web` | Next pages and thin Node route handlers, including Better Auth's official Next adapter |
| `apps/jobs` | Shared Render task definitions, execution adapters and finite repair-cron entrypoint |
| `packages/server` | Server-only auth, authorization, domain operations, Postgres/R2 adapters and migrations |
| `packages/contracts` | JSON schemas and cross-language fixtures; generated public types |
| `workers/processing` | Python extraction, hand inference, inline QC and export |
| `apps/mobile` | Existing Flutter app, Android/iOS projects and durable upload journal |
| `packages/stera_recorder`, `packages/stera-sdk` | Existing recorder/plugin and SDK sources |

This is the target layout; do not move sources while recording fixes are in progress. Use pnpm workspaces for TypeScript, Flutter pub and Python uv separately. Reuse Render's SDK/local runner; no extra monorepo build framework is needed. [Better Auth integration](https://better-auth.com/docs/integrations/next)

## Small control operations

Route handlers validate bounded requests, resolve the principal, authorize the resource and call a domain operation. Transactions are short; provider calls happen outside them and finish with conditional updates. Private pages/responses bypass shared caches. Preserve individual rotated `Set-Cookie` headers. Next proxy redirects never substitute for route/data authorization.

Creating a job persists intent; after commit, make a bounded workflow-start request. Failure leaves the job repairable by cron; no outbox is necessary. Tasks `process-recording` and `export-release` claim/control through APIs. Before executing Python, persist submission intent, then record the Modal call ID or uncertainty. Each physical execution claims with its fresh nonce and actual function-call ID before reading media. A finish callback is provisional: API reconciliation checks terminal execution, closed outputs and current state before success. Manual processing retries create another job/prefix; native controller retries recover the same job/call. [Job protocol](job-orchestration.md)

Source/output uploads use API-allocated keys and multipart IDs, including small files. Workers get scoped job capabilities and part URLs, not reusable object-write credentials. The API completes uploads and seals the bounded manifest; sealed jobs cannot allocate more files. Heavy hashing/model checks stay in Python. [Upload](mcap-upload.md)

## Development and acceptance

Run the same task definitions through Render's official local Workflows runner on port 8120 or its hosted service. `EXECUTION_BACKEND=local|modal` selects `LocalExecutor` for real Python subprocesses or `ModalExecutor`. Local Postgres/MinIO use `infra/compose.yaml`. `HAND_MODEL_PROFILE=mediapipe_cpu` completes hand/review/download without a GPU; an optional qualified local CUDA profile can use local hardware. Local success does not qualify Modal/R2 behavior. [Local development](local-development.md)

Before pilot, prove builds, signed-device cookies/ownership, interrupted uploads, controller recovery, unknown submission safety, stale callback rejection and complete archive download. Stage DAGs, shared writable datasets and separate validators remain deferred. Workflow polling/retry follows the verified orchestration contract, not an assumed durable-sleep API.
