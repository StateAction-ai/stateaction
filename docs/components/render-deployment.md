# Render deployment specification

MVP design · updated 2026-10-31 · Not implemented or deployed.

Parent: [technical design](../technical-design.md). See [backend](backend-architecture.md), [jobs](job-orchestration.md), [storage](storage-and-data-model.md) and [operations](operations-and-costs.md).

## Four Render services

| Service | Starting configuration | Responsibility |
| --- | --- | --- |
| `repair-web` / Web Service | Node.js 24, one 1CPU/2GB instance; $25/month | Next.js UI/API, Better Auth, all database mutations and multipart issuance/completion |
| `repair-db` / paid Postgres | PostgreSQL 17, 1GB RAM; $19/month plus roughly $3 for 10GB disk | Identity and nine active domain tables; future `releases` makes ten; built-in PITR |
| `repair-workflows` / Workflow | Node.js 24; bounded task definitions | Register `process-recording` initially; specified `export-release` joins in the delivery follow-up |
| `repair-jobs` / Cron Job | Every minute UTC; bounded pass, 45-second application deadline | Request bounded dispatch/status reconciliation through the API |

R2 stores files; Modal initially runs CPU function `process_recording`. The `export_release` CPU function is specified for the later whole-dataset delivery backend, not deployed in the first increment. Mandatory hand inference uses the qualified MediaPipe CPU profile. No default GPU, backup cron or separate queue service is required. Cron has a $1/month floor; workflow active CPU/RAM is additional. Polling is not assumed to suspend billing. Base web/database allowance is **about $47/month**, plus cron/workflows/R2/Modal; Render Pro adds $25 if needed. [Next hosting](https://render.com/docs/deploy-nextjs-app), [workflow billing](https://render.com/docs/workflows-limits), [prices](https://render.com/pricing)

## Repository and builds

The [monorepo plan](../implementation-plan.md) owns migration order. These are target paths, not moves authorized during recording fixes:

- `apps/web`: Next app; `apps/jobs`: shared workflow definitions/executors and repair-cron entrypoint.
- `packages/server`: domain/auth/DB/R2 code and migrations; `packages/contracts`: schemas/fixtures.
- `apps/mobile`, `packages/stera_recorder`: required Flutter/native source; import optional reviewed Python helpers only where reused, rather than require the full Stera SDK.
- `workers/processing`: Python/uv; `infra/render.yaml`: future Render definition.

Use a root pnpm workspace/lockfile for TypeScript, separate Flutter pub/Python uv locks. Leave Render Root Directory blank for shared packages. Web builds include web/server/contracts; workflow and cron builds include jobs/contracts with distinct entrypoints. Build filters include shared dependencies, root lock/config and relevant infrastructure changes. Verify production tracing; no Turbo/Nx/Melos layer is needed.

The shared `/clips/[clipId]` viewer uses one Next.js client-only adapter around framework-independent `@rerun-io/web-viewer` **0.41.0**, matching the Python SDK. Self-host pinned JavaScript/WASM; qualify production asset paths, MIME types, WebCodecs/graphics and teardown. Measure this version's actual uncached asset bandwidth rather than reuse historical 0.22 sizes. Private bounded clip RRDs load through API-authorized direct R2 URLs; two-hour raw recordings never enter the customer browser. [Viewer contract](rerun-clip-review.md)

## Networking and secrets

Place services in the same workspace/region. Bind Next to `0.0.0.0` and Render's `PORT`. Public HTTPS handles users/Modal callbacks. Workflow/cron use the web service's private origin where supported, with service authentication. Readiness checks DB/schema briefly, starting no processing. Qualify workflow private connectivity before enabling network-isolated environments. [Private networking](https://render.com/docs/private-network)

| Secret/configuration | Holder |
| --- | --- |
| `APP_ORIGIN`, Better Auth/Google configuration, `API_DATABASE_URL`, R2 signing credentials | Web only |
| Controller internal token; matching verifier | Workflow service; verifier in web |
| Repair internal token; matching verifier | Cron; verifier in web |
| Workflow dispatch credentials/client origin | Web only; official local client in development |
| Modal control credentials and pinned function/environment references | Hosted workflow service only |
| `INTERNAL_API_ORIGIN`, public callback origin | Intended workflow/repair configuration |
| Scoped job capability, fresh execution nonce, public callback origin | Specific Python invocation only; no DB/general storage/control credentials |
| Migration URL | Explicit migration command only |

Keep credentials out of browser variables/shared secret groups. [Storage](storage-and-data-model.md#database-access) owns DB role/TLS details. Private pages/routes use current authorization; media transfers go directly to R2.

## Development and activation

Run the same TypeScript `process-recording` task with Render's official local Workflows runner on port 8120; the follow-up exporter uses that same pattern. `EXECUTION_BACKEND=local|modal` selects Python `LocalExecutor` or `ModalExecutor`. Postgres/MinIO use `infra/compose.yaml`; MediaPipe CPU needs no GPU. An optional qualified CUDA profile uses local hardware. [Local development](local-development.md)

After deployment authorization, migrate once, configure origins/allowlisted users and deploy the processor/web/workflow/cron. Keep collection admission disabled until signed-device uploads, controller/submission recovery, hand quality/license, shared-viewer authorization and PITR restore checks pass. Real read-only external inspection is in scope: operator-managed `dataset_access` admits only current approved members/labels of the granted dataset, with no staff QC/notes. Synthetic fixtures do not substitute for authorization tests. Frozen-version publication and Download all require the deferred release backend and a separate exporter/archive acceptance gate; no Releases/Deliveries UI, sharing UI or new operator publishing tool is included now. Preview environments receive no production secrets. Rollback pauses starts and preserves active calls, rows and files.
