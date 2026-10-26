# Render deployment specification

Selected design · 2026-10-26 · Not implemented or deployed

Parent: [technical design](../technical-design.md). This document owns service placement, build targets, configuration and rollout. [Backend](backend-architecture.md), [workflow](job-orchestration.md), [storage](storage-and-data-model.md) and [operations](operations-and-costs.md) own their detailed protocols.

## Service inventory

| Proposed name / Render type | Initial size or schedule | Owns |
| --- | --- | --- |
| `repair-web` / Web Service | Node.js 24; 1 CPU/2GB; one paid instance | Next.js UI, Node route handlers, Better Auth and all public/internal HTTP endpoints |
| `repair-db` / Postgres | Pin PostgreSQL 17; 1GB RAM; 10GB disk allowance | Identity, grants, catalog, durable outbox/controller/jobs, review and release records |
| `repair-workflows` / Workflow | Node.js 24; per-task Flex; eight controller leases maximum | `ingest-run`, `process-batch`, `assemble-run`, `export-release` |
| `repair-reconcile` / Cron Job | Every minute UTC; application deadline 45 seconds | Bounded outbox delivery and interrupted-provider/controller reconciliation |
| `repair-db-backup` / Cron Job | Daily, initially `0 4 * * *` UTC; finite timeout | Restricted logical database export to private R2 backup storage |

The backup schedule is **04:00 UTC**, not a Toronto-local fixed hour. Configure the final schedule/deadline from database size and restore policy. Two cron services have a combined $2/month floor, plus compute above it. Paid web/Postgres sizing is a qualification starting point. [Next.js hosting](https://render.com/docs/deploy-nextjs-app), [Workflows](https://render.com/docs/workflows), [cron](https://render.com/docs/cronjobs)

External services remain explicit: **R2 for raw/derived/release/backup objects, Modal for CPU/GPU work**, and Google for pilot sign-in. No SMTP service is required for the Google/invitation pilot; adding email login/recovery requires a mail provider. R2 remains subject to the existing Lance/multipart/capability/recovery tests, with S3 as a qualified fallback. Render Object Storage is listed as forthcoming/early access by its SDK; no suitable Render GPU offering was established. Do not replace R2 with an attached disk or assume a Flex task has a GPU. [SDK feature status](https://github.com/render-oss/sdk), [disk boundaries](https://render.com/docs/disks)

The [deployment diagram](../figures/render-platform.md) separates control requests from direct media transfers. The [stage diagram](pipeline-execution-and-data-flow.md) specifies extraction/annotation dependencies.

## Network and HTTP routing

Place web, Postgres, Workflows and both cron services in the **same Render workspace and region**. Workflows/cron can initiate private connections but cannot receive them. Use the web service's actual internal hostname/port for controller acceptance calls and its canonical public HTTPS origin for phone/browser and Modal callbacks. Internal calls still require service authentication. Do not enable a network-isolated Render environment for this topology until its Workflow private-network support is proven. [Private network](https://render.com/docs/private-network)

| HTTP boundary on `repair-web` | Handling |
| --- | --- |
| Next.js pages | Separate collector status, internal review and customer release experiences; current grants checked server-side |
| `/api/auth/*` | One Better Auth instance and official Next adapter |
| `/api/v1/*` | Human session, current scope and mutation CSRF checks |
| `/internal/v1/*` | Distinct controller/attempt/validator credentials; no human-cookie fallback |
| `/api/download/*` | Release-scoped downloader capability; issue short-lived direct R2 GET/Range URLs |
| `/health/live`, `/health/ready` | Small unauthenticated health responses; readiness checks schema/DB briefly, exposes no secrets and starts no processing |

Bind the Next server to `0.0.0.0` and Render's assigned `PORT`; use `/health/ready` as its health check. All domain/internal route handlers use the Node runtime. Keep private responses out of shared/static Next caches, and use bounded short control requests. Upload, playback, export and download payloads never traverse Next or workflow task arguments.

Runtime database clients use the private, restricted-role transaction-pool URL; migrations/backups use direct internal connections. Disable external DB access. [Storage's database contract](storage-and-data-model.md#database-access) owns TLS, role passwords, pooled-role qualification and connection budgets; never replace a restricted URL with a generated owner URL.

## Repository and build targets

Implement an npm-workspace root with one reviewed lockfile. `console/` is the Next application; `backend/` is a shared server-side TypeScript package plus task/cron/migration entrypoints; `processing/` is the independent Python worker source. These packages/scripts are **planned targets**, not files already shipped.

| Artifact | Proposed build/start contract |
| --- | --- |
| Web | Root `npm ci`; build the backend package then Next; workspace start script runs production Next on Render's host/port |
| Workflow | Root `npm ci && npm run build --workspace backend`; `node backend/dist/workflows/index.js` |
| Reconciler | Same compiled backend artifact; `node backend/dist/workers/relay-reconcile.js` |
| Backup | Pinned compatible PostgreSQL client plus a finite backup entrypoint; stream to restricted backup storage |
| Migration | Explicit reviewed command using the migration-only direct role; never on every web/task startup |

The workflow entrypoint **statically imports all four registered task modules**. Render's SDK detects its task runtime and invokes registered handlers; no custom HTTP server or separate initialization daemon is required. Register synchronously; create provider/DB clients when a task executes, not during module import. Pin/test SDK 1.4.0 and the chosen supported Next release. [Workflow tutorial](https://render.com/docs/workflows-tutorial), [task definitions](https://render.com/docs/workflows-defining)

Shared domain modules must not import Next-specific request/cookie APIs; adapters provide the principal and dependencies. Test the root build and Next production tracing so the backend package/dependencies are present. Keep server config/provider clients out of browser bundles. API and controllers reuse the same domain operations, not copied business logic.

## Service configuration and secrets

| Setting / secret class | Holder |
| --- | --- |
| Canonical `APP_ORIGIN`, `BETTER_AUTH_URL`, explicit trusted origins, `BETTER_AUTH_SECRET`, enabled Google credentials | Web only; public origin is fixed before OAuth/device qualification |
| Restricted `API_DATABASE_URL` | Web only |
| Restricted `CONTROL_DATABASE_URL` | Workflow and reconciler; bounded pools and controller capacity from storage contract |
| `WORKFLOW_API_TOKEN`; matching verifier/hash | Token in workflow service; verifier in web; scoped quiescence/acceptance only, rotated independently |
| `RECONCILE_API_TOKEN`; matching verifier/hash | Token in minute cron; verifier in web; attempt-grant retirement/reconciliation only, never acceptance or new grants |
| Private `INTERNAL_API_ORIGIN`, public `PUBLIC_API_ORIGIN`, pinned pipeline/profile/task versions | Workflow/reconciler configuration; public callback origin equals web `APP_ORIGIN`; no arbitrary client-supplied destinations |
| `RENDER_API_KEY` and pinned task references | Reconciler only; dedicated automation identity with the least supported provider permissions |
| Modal control tokens | Workflow and reconciler only; no media-worker control token |
| R2 multipart signing/temporary-grant issuance | Next API only; raw/derived/release authority separated. Controllers coordinate by scoped APIs; no issuer secret in tasks/cron. |
| Direct migration URL | Controlled migration invocation only |
| Direct backup-reader URL and backup-prefix writer | Daily backup cron only |
| Bootstrap/claimed-worker/read-only-validator capabilities | Issued just in time for the specific attempt/invocation; tracked, bounded and redacted |

Validate per-service configuration at startup. Do not share all secrets through one environment group or place any in `NEXT_PUBLIC_*`. Disable processing admission until profiles, rights/regions, object grants and budgets are qualified. The minute cron is the only outbox dispatcher: no Render key in Next and no post-response task launch. UI shows durable `queued` status during the minute-plus-provider-start delay.

## Deployment and recovery order

1. Build/test locally with Postgres and fake Render/Modal/storage adapters. Generate shared contracts and resolve SDK pins before paid qualification.
2. After deployment authorization, create scoped database roles/migrations and private buckets; configure fixed origin and service-specific secrets. Default unused processing profiles to disabled.
3. Deploy a compatible workflow task version, then web and the relay/backup commands. Configure relay task references explicitly; no event should point to an unregistered version. All tasks can remain idle while admission is disabled.
4. Prove signed-device login, owner-bound multipart recovery, controller death/continuation after Modal submission, native Curator recovery, stale-write/validator rejection and complete release downloads with synthetic data first.
5. Run the authorized bounded two-hour capture canary, then review/export/download and restore/revocation drills. Admit collectors only after the relevant gates pass; optional models remain separate.

Keep additive DB schemas, task contracts, code/image digests and old handlers compatible until active dispatches drain. A fresh continuation must target the correct handler version. Disable new admission before rollback; reconcile running Modal calls and writer grants rather than deleting them or resetting the database. Render CI-based deployment can be enabled after required checks exist; no deployment is performed by this document. [Deployment controls](https://render.com/docs/deploys)

Use local development and separately budgeted cloud environments. Credentials, databases, buckets and callbacks are distinct by environment. Preview deployments receive no production secrets/data. Paid Postgres PITR plus daily off-provider backups cover the catalog; dataset objects and pinned Lance history need their own retention/restore checks. [Operations](operations-and-costs.md) owns schedules, cost accounting and incident recovery.

## Budget and scale

Application/DB allowance is about **$47/month with one infrastructure operator or $72 with a Pro workspace**, before the two cron floors and variable workflow/R2/Modal/backup usage. Under the existing three-month video assumptions, CPU-only totals remain approximately **$83/$108 for 20 recording hours** on single-operator/team workspaces, before backup and ancillary usage. [Cost scenarios](video-cost-model.md)

Keep web stateless, media direct, controller count bounded and GPU warm count zero. Raise batch concurrency from measurements; add web replicas and database capacity only when their own metrics require them. Recovery state lives in Postgres and object storage, so redeploying a web/task instance does not erase it. This design adds no Supabase, Inngest, separate API service, Redis queue or always-on Ray cluster.
