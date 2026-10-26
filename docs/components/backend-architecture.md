# Backend implementation

Selected Render design · updated 2026-10-26 · Design only; not deployed.

Parent: [Technical design](../technical-design.md). Shared wire contracts: [contracts](../contracts.md). Component contracts: [auth](auth-and-access.md), [storage](storage-and-data-model.md), [orchestration](job-orchestration.md).

## Build target

Build one **Next.js / Node.js 24 LTS / TypeScript web service on Render**. It serves the review/delivery UI, the mobile HTTP API and Better Auth under one HTTPS origin. Render Postgres holds identity and application state; Render Workflows runs finite orchestration tasks. Private R2 holds media and datasets; Modal runs Python CPU/GPU processing. The application never proxies large uploads, video playback or dataset downloads. Render supports full Next.js as a Node web service. [Render Next.js hosting](https://render.com/docs/deploy-nextjs-app)

Use Next App Router route handlers with the Node runtime for HTTP boundaries. Share domain modules between route handlers and workflow tasks; implement each operation once. The cloned Stera server supplies mobile protocol fixtures only. No standalone Fastify server, separate API service, Bun/Deno runtime or Supabase dependency is required. Pin the supported Next.js, Node and library versions together before implementation. [Route handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)

## Modules and execution

| Target | Responsibility |
| --- | --- |
| `console/app/` | Next pages, layouts and review/delivery components |
| `console/app/api/auth/[...all]/route.ts` | Official Better Auth Next adapter; one identity authority |
| `console/app/api/v1/**/route.ts` | Thin human API adapters: validate, authenticate, authorize, call domain services, encode responses |
| `console/app/internal/v1/**/route.ts` | Workflow, worker and validator endpoints with distinct scoped service authentication |
| `console/app/api/download/**/route.ts` | Scoped CLI download-session adapters |
| `backend/src/modules/auth/`, `access/` | Better Auth configuration, enrollment, principal and authorization |
| `backend/src/modules/recordings/`, `uploads/` | Registration, seal and canonical multipart lifecycle |
| `backend/src/modules/processing/` | Admission, claims, batch ownership, validation and final acceptance |
| `backend/src/modules/reviews/`, `releases/`, `downloads/` | Exact-revision approval, publication and recipient access |
| `backend/src/db/` | Drizzle schema, reviewed migrations, repositories and bounded connection pools |
| `backend/src/adapters/`, `config/` | R2, Modal and Render clients; validated server-only configuration |
| `backend/src/workflows/` | Render task definitions, bounded outbox relay and reconciliation tasks |
| `backend/src/contracts/`, `tests/` | Generated bindings from `processing/contracts/`; integration/fault tests and mobile fixtures |
| `processing/` | Qualified Python media/model workers and canonical schemas |

Treat `backend/` as a server-only workspace package imported by Next and the workflow build. Build from the repository root so both packages are available; verify production output includes their runtime dependencies. Browser bundles may import public contract types, never database/storage clients, auth configuration or secrets.

Domain services own short database transactions. Routes adapt requests; repositories require explicit resource scope. Put a state change and its uniquely identified outbox command in the same transaction, then return the durable operation ID. A minute Render cron relays committed commands; the web service does not kick workflows after committing and holds no Render operator/API key. Initial submission latency includes up to one cron interval plus provider queue time. Network calls occur outside transactions and finish through conditional commits. Do not launch untracked work after an HTTP response. Render tasks resume from application records and receipts; process memory and provider retries are not durable domain state.

The planned control plane comprises the web service, one Render Workflow service, a bounded minute cron and a separate daily database-backup cron. Render Workflows owns finite task execution; the [orchestration contract](job-orchestration.md) owns successor scheduling, outbox delivery and recovery. There is no `/api/inngest` endpoint. Media workers cannot invoke control-plane modules directly or receive database/Modal-control credentials. A separately authenticated workflow principal calls quiescence/final acceptance; a distinct cleanup-only principal lets cron retire grants after controller loss. Only the API's conditional transaction accepts validated results. Human publication remains a fresh-session internal-admin action.

## Database, sessions and request safety

Connect same-region Render services to Render Postgres through its internal URL. Require TLS using the provider-supported internal mode; Render currently documents `sslmode=require` and self-signed internal certificates. Disable external database access, opening only an audited temporary operator path when necessary. Qualify workflow-to-database connectivity in the selected region before deployment. [Render database connections](https://render.com/docs/postgresql-creating-connecting)

Use separate migration, application and bounded workflow-service database roles. The migration role owns DDL; generated owner credentials do not enter runtime services. Workflow access is limited to its ledger/outbox/control requirements; it cannot grant staff access or publish releases. Better Auth identity/session tables and domain tables share this managed database, with reviewed migrations and retention-safe foreign keys. Drizzle keeps SQL and transaction boundaries visible. [Storage](storage-and-data-model.md) owns role-specific URL/pooling configuration.

Use a bounded connection pool per process, not per request. Cap task concurrency so all web replicas, deploy overlap, task instances and operator reserve fit the selected database/pooler's budget. Do not hold a connection or transaction while waiting for Modal. Verify driver and transaction-pooler compatibility, including prepared statements and session settings; load-test before increasing concurrency.

Mount Better Auth through `toNextJsHandler(auth)`. Domain APIs resolve the session once, recheck live grants and propagate any rotated cookies individually. Next proxy redirects are navigation convenience; every page data loader and route independently authorizes its resource. Private responses and authenticated rendering must not enter public/static/shared caches. Use route handlers for mutations so native and browser clients share one explicit API; UI components do not gain a second authorization path. [Better Auth Next integration](https://better-auth.com/docs/integrations/next), [auth/access rules](auth-and-access.md)

## Compatibility and implementation gates

1. Capture credential-free mobile fixtures for cookies, errors, integer encoding and upload requests. Preserve required behavior rather than unsafe legacy quirks.
2. Build against isolated Render Postgres and buckets. Preserve opaque identity IDs and provider associations where real data exists; never remap recordings by email alone.
3. Move one complete route group behind the same origin. Auth has one authority; each multipart session has one writing service from start through completion/abort.
4. Map legacy assets into canonical unverified records. Disable direct user-delete bypasses and fail-open upload starts before enabling new writers.
5. Qualify signed iOS/Android login, rotation, offline ownership, account switching, interrupted upload and cloud verification. Drain old sessions before retiring old credentials/server.

Acceptance requires a production Next build without cloned-server imports, private-cache/header checks, real Postgres isolation tests, safe deploy/restart and the component fault tests. Qualify the Render SDK, Modal Node SDK, database connectivity and task recovery together; an unavailable checkpoint API is not assumed. Deployment, shape selection and paid canaries remain implementation work. Costs live in [operations](operations-and-costs.md).
