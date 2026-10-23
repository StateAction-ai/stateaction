# Standalone Node.js backend variant

Status: proposed standalone Node hosting variant, not deployed; API/auth hosting remains a decision. Updated: 2026-10-22.
Parent: [Technical design](../technical-design.md). Related: [auth](auth-and-access.md), [storage](storage-and-data-model.md), [upload](mcap-upload.md), [orchestration](job-orchestration.md), [implementation plan](../implementation-plan.md).

## Scope of this hosting variant

If the standalone service option is selected, build the owned backend under root `backend/` using **Node.js 24 LTS, TypeScript and Fastify**. The [main design](../technical-design.md) also evaluates Supabase-hosted Edge Functions on Deno/TypeScript; that hosting/auth choice is provisional, and this document does not override it. Select one API and one identity authority rather than deploy both by default. The remaining runtime/framework/library recommendations describe this standalone Node variant.

Build the static React review/customer application under root `console/` and keep Python CPU/GPU processing under `processing/` on Modal in either option. In the Node variant, use a modular backend with separate API and control-plane process entrypoints backed by managed PostgreSQL and private object storage. In the Edge variant, short scheduled handlers provide equivalent outbox/reconciliation contracts; it does not inherit this persistent-process deployment.

The Stera clone is a recorder and client-protocol reference. Its backend is not an accepted production foundation. Inspection tells us which routes/cookies the phone currently expects and identifies migration hazards; it does not establish architecture quality, security or operational readiness. No recommendation here depends on preserving Bun, Hono, the old auth factory, old upload handlers or their error recovery.

For the Node variant, qualify Better Auth as an independently audited library and preserve its native cookie protocol only after testing. Reimplement our identity configuration, route adapter, enrollment and authorization. The Edge identity/session adapter needs its own qualification or explicit mobile migration; neither variant authorizes a second identity system or handwritten OAuth/session cryptography.

For orchestration, **Inngest Cloud remains the recommended pilot default**, with Temporal Cloud a credible alternative described below. The reason is low operational commitment for a bounded event-driven pipeline, not familiarity with the clone. User/team preference may change the recommendation before implementation; no cloud service has been activated by this design.

## Runtime comparison

| Option | Benefits for this project | Costs and constraints | Decision |
| --- | --- | --- | --- |
| Node.js LTS + TypeScript | Long-lived release/support policy; first-class JS ecosystem; one language for API/domain and web contracts; official Temporal worker support if selected; Modal's JS SDK supports Node | API is not a place for decoding/model inference; dependency/runtime versions still require qualification | Recommended control plane |
| Bun + TypeScript | Integrated developer tooling and a viable HTTP runtime; many Node packages work; Inngest and Modal can integrate | Node compatibility is not equivalent to every SDK's supported production worker runtime; runtime-specific optimizations have no measured benefit for our metadata/API workload | Do not inherit as deployment default; optional tooling only after deterministic CI qualification |
| Python + FastAPI | Strong typed request/response modeling; direct fit for data engineers; Python Temporal and Modal ecosystems | Better Auth is TypeScript: preserving it would need a separate identity service/proxy or a deliberate provider migration; contracts/clients still span languages | Strong alternative for a Python-first team; unnecessary extra identity/runtime boundary for this v1 |

Node's published schedule makes v24 an LTS line on this document's date, supported through 2028-04-30. v26 is scheduled to enter LTS on 2026-10-28, after this design date. Pin a security-patched v24 release and image digest; reconsider v26 only after all SDKs support it and qualification passes. A library saying “Node >=20” is not a reason to deploy the now-EOL Node 20 line. [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), [Node release policy](https://nodejs.org/en/about/previous-releases)

The inspected Temporal TypeScript SDK main-branch requirements list Node 20/22/24 and explicitly discourage running Workers on alternative JS runtimes. Its client may work on Bun, but that is not official Worker support. Verify the **released, pinned SDK's** requirements rather than treating a moving main branch as its release contract. [Temporal SDK requirements](https://github.com/temporalio/sdk-typescript#requirements)

Bun documents its compatibility with individual Node APIs; evaluate it against our exact dependency matrix if we ever adopt it. FastAPI also needs normal HTTPS, process supervision and worker deployment design; choosing Python does not make background tasks durable automatically. These are engineering tradeoffs, not claims that either runtime cannot support a professional service. [Bun compatibility](https://bun.sh/docs/runtime/nodejs-compat), [FastAPI deployment concepts](https://fastapi.tiangolo.com/deployment/concepts/)

## Framework and library boundary

Fastify is recommended for explicit route schemas, lifecycle hooks, encapsulated modules, structured logging and a published support policy covering supported Node LTS lines. Benchmark speed is not the deciding criterion: this API authorizes small control requests while phones/workers transfer object bytes directly. Hono or Express could also serve the API; the required invariants would remain the same. [Fastify support policy](https://fastify.dev/docs/latest/Reference/LTS/), [validation/serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)

| Responsibility | Recommended implementation | Qualification requirement |
| --- | --- | --- |
| HTTP/API | Supported Fastify major on Node 24; explicit schemas, body/timeout limits and error mapping | Actual plugin compatibility, auth/integration behavior and request lifecycle tests |
| Runtime contracts | Committed JSON Schema/OpenAPI plus TypeScript types; Python/Dart conformance fixtures | One canonical wire definition; no independent handwritten request shape drifting across three languages |
| Identity | Better Auth through our reviewed Fastify adapter | Native Google/Apple flow, nonce/audience, multiple Set-Cookie, session rotation and logout/revocation on real devices |
| Domain persistence | Drizzle plus a qualified Postgres driver; explicit SQL transactions/constraints and reviewed migrations | SQL inspection, pooling/TLS behavior, cross-tenant FK tests, rollback/recovery and precision tests |
| Object storage | AWS SDK S3 client against qualified R2/S3 endpoints, provider-aware references | Multipart/session tokens, signing, Range requests, immutability, conditional behavior and promotion tests |
| Workflow | Inngest Cloud and thin engine-specific adapter | Replay/retry/versioning, signed delivery, outbox replay, quotas and uncertain Modal submission fault tests |
| Cloud execution | Modal private Functions with Python-specific pinned environments | Worker claim before expensive work; scoped credentials; GPU/runtime/codec tests |
| Operations | Structured redacted logs, health/readiness, metrics and supervised process/container | Shutdown drains, failure alerts, restore and cost accounting |

Drizzle and Better Auth are candidates because their library capabilities fit our requirements. Reusing those libraries does not accept the clone's schema, grants, provider configuration or route implementation. Select and pin supported versions after dependency/security review; preserve an older protocol only when compatibility requires it and the security posture permits it.

Better Auth provides a documented Fastify integration. Our adapter must additionally preserve all Set-Cookie values separately, use a configured trusted external URL behind the proxy, and preserve the correct callback body semantics for enabled providers. Do not blindly copy an example that derives trust from arbitrary Host headers or serializes every callback body as JSON. [Better Auth Fastify integration](https://better-auth.com/docs/integrations/fastify)

## Workflow choice independent of the recorder

Inngest is an event/workflow service: our code declares durable steps, waits and retries; its service persists progress and invokes our handlers. Temporal provides a durable Workflow/Activity model: its service persists workflow history, while supported Workers execute our workflow/activity code. Both can coordinate Modal jobs. Neither replaces our identity, recording catalog, artifact acceptance, cost limits or release approval.

| Criterion | Inngest Cloud | Temporal Cloud |
| --- | --- | --- |
| Operating model | HTTP-served functions or an outbound connection from a worker; managed durable step coordination | Managed Temporal service plus supported Workflow/Activity worker execution; choose and qualify worker hosting explicitly |
| Initial fit | Straightforward event-driven intake, a few processing branches and short controller steps | Strong fit for complex long-running processes, signals, compensation and explicit workflow versioning/replay practice |
| Code discipline | Stable durable step IDs, durable waits and idempotent side effects | Deterministic workflow code, Activities for external side effects, replay/versioning and activity timeout/heartbeat design |
| Support and portability | JS SDK and managed service; inspect plan limits/security/support commitments; self-hosted server license is a separate consideration | Multiple official SDKs and managed support; server is MIT-licensed; self-hosting remains a significant operational responsibility |
| Worker runtime | Node API or separate worker through supported integration | Use official Node for TypeScript Workers; do not treat Bun compatibility as equivalent support |
| Cost shape | Free execution allowance; paid tiers have a monthly base; counted durable steps/polls matter | No current base monthly fee; actions, active/retained history, support and worker hosting all matter |
| Recommendation | Default for the lean pilot after fault/limit qualification | Select if team experience, deployment model, workflow needs or customer requirements justify its engineering commitment |

Inngest documents both HTTP `serve()` and outbound `connect()` deployment options. The initial design may use a signed HTTP endpoint on the owned backend; a separate outbound worker can be selected if keeping the public API surface smaller is valuable. This is a handler-hosting choice, not a second scheduler. [Inngest deployment models](https://www.inngest.com/docs/learn/serving-inngest-functions)

Current published prices on 2026-10-22: Inngest Free lists 50,000 executions/month and five concurrent steps, with Pro starting at $99/month; Temporal Cloud lists no base monthly fee and actions starting at $50/million, plus storage and developer support at 10% of usage. Temporal Business support starts at $500/month, but that is not the base Cloud minimum. Count each provider's actual billable units and control-worker hosting; a free tier is not a guarantee of free production operations. Do not use an obsolete Temporal monthly minimum to bias the choice. [Inngest pricing](https://www.inngest.com/pricing), [Temporal pricing](https://temporal.io/pricing)

Temporal's server MIT license and Inngest server/CLI SSPL/future Apache grant are materially different from the respective SDK licenses and managed-cloud service terms. Managed Inngest remains a legitimate choice, but do not call its entire server Apache or assume we can distribute/operate a modified hosted fork under the SDK license. [Temporal server license](https://github.com/temporalio/temporal/blob/main/LICENSE), [Inngest server license](https://github.com/inngest/inngest/blob/main/LICENSE.md)

Keep application stages and attempt protocols independent of the engine. Engine-specific workflow definitions will still need rewriting if we switch: an interface does not make durable histories/replay semantics portable. A switch drains or deliberately migrates active workflows and preserves domain IDs/input digests; never run two schedulers against the same logical job without an admission guard.

## Owned modular backend

Deploy one API process and one bounded control-plane process initially, possibly on the same inexpensive supervised host. They can share reviewed libraries while holding separate runtime credentials. Keeping them as distinct entrypoints allows independent restarts and future host separation. Do not add Kubernetes, service mesh or a fleet of independently deployed microservices for this pilot.

| Module | Owns | Must not do |
| --- | --- | --- |
| `auth` | Better Auth adapter/configuration, session principal, enrollment and access-state checks | Hand-roll OAuth/session tokens or derive project roles from email/display name |
| `access` | Membership/staff/project/release authorization and audit | Accept client roles/resource IDs as authority |
| `recordings` / `uploads` | Owner-bound capture registration, seal, file generations, multipart lifecycle and verification admission | Trust prefix-only checks, client ETags as full-file hash, or fail open when DB idempotency fails |
| `processing` | Run/job/attempt records, admission/fencing, trusted promotion and reconciliation | Put model inference or media extraction on the API host |
| `reviews` | Immutable label revisions and approval of exact evidence | Mutate published release dependencies |
| `releases` / `downloads` | Frozen exports, publication, recipient grants and scoped download sessions | Give customers review/publish powers or expose raw storage listing |
| `workflows` | Engine definitions/adapters and outbox delivery | Become a second custom DAG scheduler or bypass domain service transactions |

Proposed targets are directories to create during implementation, not files already shipped:

| Target | Purpose |
| --- | --- |
| `backend/package.json`, `backend/tsconfig.json`, runtime/lockfile | Owned Node/TypeScript build, package pinning and CI contract |
| `backend/src/api.ts`, `backend/src/app.ts` | Process startup and testable Fastify composition |
| `backend/src/config/` | Validated environment/provider config; no secret values in examples |
| `backend/src/modules/{auth,access,recordings,uploads,processing,reviews,releases,downloads}/` | Route adapters, domain services and scoped repositories |
| `backend/src/db/{schema,migrations}/` | Reviewed identity/domain schema, grants and incremental migration history |
| `backend/src/contracts/` | HTTP/event/manifest schemas, published to client/worker conformance fixtures |
| `backend/src/adapters/{storage,modal,workflow}/` | Provider-specific clients behind explicit domain contracts |
| `backend/src/workflows/` | Versioned Inngest functions, or Temporal workflows/activities if explicitly selected |
| `backend/src/workers/control-plane.ts` | Outbox relay/reconciliation entrypoint, with bounded concurrency |
| `backend/tests/{contract,integration,fault}/` | Client wire compatibility, real DB/storage contract and failure-boundary tests |
| `console/` | Static React internal/customer UI, served under the application origin |
| `processing/` | Cloud Python entrypoints/images/stages and model qualification |

Repository methods require explicit project/release scope, but do not invent a universal repository abstraction that hides transactional invariants. Domain services own the transaction; route handlers perform protocol adaptation, validation and response shaping. Object/network operations occur outside DB transactions, with persisted state and final conditional commits covering the boundary.

## What to reuse, rebuild and preserve

| Clone item | Evidence value | Owned implementation action |
| --- | --- | --- |
| Flutter `/api/auth/*` cookie/social flow | Native wire expectations and known device behavior | Preserve/test protocol; write our Better Auth factory and Fastify adapter |
| Existing auth IDs/session tables | Potential identity/data continuity | Audit schema and secrets; preserve opaque IDs if data exists; migrate by reviewed plan |
| Upload route request/response shapes | Client compatibility fixture inputs | Implement canonical upload services and compatibility adapters; reject insecure old behavior |
| R2 helper | Lists operations/endpoints already attempted | Reimplement with bounded/scoped credentials, session binding and provider contract tests |
| Old asset parser/idempotency logic | Documents concrete migration hazards | Do not copy: second-segment parser breaks new keys; DB-error fresh-start behavior loses idempotency |
| Old user deletion/logout | Negative acceptance fixtures | Replace cascades and destructive queue clearing; preserve journals and shared provenance |
| Recorder/MCAP SDK | Domain source/protocol inventory | Independently qualify file schema/timestamps/calibration; no production claim from app startup alone |

Reuse code only after reading its implementation, confirming dependency/asset licenses, identifying state/failure semantics and testing the actual invariants. Small pure serialization/types may pass that review. Auth, upload finalization, mutation authorization, promotion and deletion deserve owned implementations with explicit evidence. Do not copy the entire server and rename its folders.

## Compatibility and cutover

1. **Record a wire contract.** Capture request/response fixtures for the actual mobile app without credentials or user data. List required cookie attributes, callback methods, errors, integer encoding and upload capabilities. Separate required compatibility from a bug that must be fixed.
2. **Build the new service independently.** Use the owned module structure and an isolated test database/bucket. Add domain schema and grants. No cloned server imports or runtime requirement. Keep the old app checkout read-only while its bug-fix work continues.
3. **Qualify identity continuity.** If real users/data exist, preserve opaque user IDs, approved provider-account associations and cookie signing settings where safe; explicitly invalidate/relogin sessions when secret/security changes require it. Never silently bind existing recordings to a new user merely because email matches. If no durable production identities exist, document a clean enrollment cutover rather than manufacture migration complexity.
4. **Introduce one writing authority.** Reverse-proxy route groups to the new backend behind the same HTTPS origin. Auth can move as one group with exactly one identity/session authority. Upload start/parts/complete/finalize/abort move together for each canonical session; do not split the lifecycle between two services with independent state.
5. **Migrate domain records.** Preserve legacy mappings and backfill as unverified. Disable direct-delete bypasses first. Any legacy endpoint accepted by the new service is a thin adapter to the canonical transaction, not a parallel storage/database mutation path.
6. **Qualify the mobile release.** Prove login, restart/rotation, offline capture, expiry, owner switching, interrupted multipart resume and final validation on signed physical-device builds. Existing presigned object requests may continue until expiry, but new URL issuance must use the selected backend authority.
7. **Switch and retire.** Switch verified route groups, drain active legacy sessions under a bounded plan, revoke obsolete issuer/database credentials and remove old backend deployment. Do not mirror live writes to two services. Read-only shadow comparison is acceptable where it does not expose secrets or create side effects.

This gradual replacement preserves the app contract while replacing implementation responsibility. Switching framework/runtime does not authorize weakening authentication, copying incomplete data, changing capture ownership or enabling a billable cloud job during documentation work.

## Acceptance of the backend choice

- Node 24 production image and every native/SDK dependency pass CI and startup checks; runtime choice is independently documented.
- A fresh checkout builds the owned backend without Bun or imports from the cloned server.
- Real Flutter clients authenticate against the owned Fastify adapter with correct cookie/nonce/audience behavior.
- Cross-tenant ACL, account deletion, ambiguous uploads, stale promotion and customer download-capability tests pass against real Postgres transactions.
- One canonical upload/write authority exists during cutover, and rollback does not create a second identity or duplicate multipart lifecycle.
- Inngest free-tier limits and counted executions are measured before activation; if Temporal is selected instead, official Node Workers, worker hosting and replay/versioning tests are explicit.
- API/control processes never decode MCAP or run annotation models; cloud workers and protected storage remain the data-plane boundary.

The backend quality bar is the reviewed behavior and operational evidence above, not the Stera name, a framework's benchmark, or the fact that the clone currently boots.
