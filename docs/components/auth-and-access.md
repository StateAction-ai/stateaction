# Authentication and access control implementation plan

Date: 2026-10-22

Status: proposed implementation; source audit complete, deployment qualification pending
Owner: identity and backend engineering

This document specifies the **owned Node.js/TypeScript API with Better Auth variant**, not a final selection of API/auth hosting. The canonical [processing topology](pipeline-execution-and-data-flow.md) illustrates Supabase Edge Functions on Deno/TypeScript; that option must separately qualify its identity/session integration or define an explicit native auth migration. Do not treat Better Auth's Node integration as already qualified on Edge, or introduce a second identity system silently. The access-control, ownership, scoped-worker and delivery requirements below apply to either verified-principal adapter.

In the Node variant, an owned API under root `backend/` uses a reviewed Better Auth integration, with Fastify as the proposed HTTP framework and Supabase as managed PostgreSQL. The old Bun/Hono server is protocol/audit evidence only. Flutter and the review portal authenticate against the selected API; they do not receive database credentials or Supabase service-role keys. Preserve existing opaque Better Auth IDs when migrating existing identity/data; do not reassign captures by matching an email to a newly minted identity.

Read this with the [technical design](../technical-design.md), [processing execution/data flow](pipeline-execution-and-data-flow.md), [storage and data model](storage-and-data-model.md), [MCAP upload protocol](mcap-upload.md), and [review and delivery design](review-and-delivery.md). Those documents define the canonical domain schema and upload/release contracts; this document specifies the authorization conditions on those contracts.

## 1. Decision and boundary

For the Node variant, independently qualify Better Auth, its Drizzle adapter and the `user`, `session`, `account`, and `verification` schema. Rebuild configuration/adapters in our owned backend rather than copying the old auth factory. Move/provision reviewed tables through incremental migrations. Do not create parallel Supabase Auth accounts, translate Better Auth IDs into `auth.users`, or pretend Supabase `auth.uid()` is populated for direct Drizzle connections. If the Edge option selects another identity protocol, document account mappings, provider verification, mobile secure storage, expiry/logout and cutover as a distinct implementation gate.

Use the existing cookie session transport for both native and web clients. The current Flutter package bridges a native cookie jar into ordinary API requests; the server validates those headers with Better Auth. There is no bearer plugin in the inspected server factory. Switching the app to `Authorization: Bearer` without a coordinated server/plugin change would break authentication. A future bearer migration is a separate transport decision; it does not solve project authorization. Better Auth documents bearer support as an explicit plugin. [Bearer plugin](https://better-auth.com/docs/plugins/bearer)

All authorization decisions run in the selected API using current database state. A user profile, valid session, object-key prefix, cached organization, or client-supplied role is never sufficient by itself. Object storage remains private. Signed object URLs are short-lived capabilities issued only after the relevant checks. Better Auth documents a Fastify integration; our owned adapter additionally needs correct multiple-Set-Cookie handling, trusted external URL and provider callback bodies. [Fastify integration](https://better-auth.com/docs/integrations/fastify)

## 2. Current code and concrete pilot blockers

This audit inspected the working tree read-only while another agent was fixing the recording application. Recheck these observations against the eventual implementation commit.

| Area | Observed implementation | Required implementation |
| --- | --- | --- |
| Identity | `stera-app/packages/auth/src/index.ts` configures Better Auth 1.6.25, Drizzle/Postgres, Google and Apple social sign-in | Use as protocol evidence; write and qualify our own factory/adapter and supported pinned dependency version |
| Server session | `apps/server/src/middleware/auth.ts` calls `getSession({headers})`, stores `userId` | Add one request principal, authoritative eligibility checks, project/release checks, and correct forwarding of refresh `Set-Cookie` headers |
| Mobile credential | `apps/mobile/lib/src/services/api/token_service.dart` attaches cookies and saves returned `Set-Cookie` | Keep this bridge; prove restart, expiry, rotation, host/path and secure-cookie behavior on both platforms |
| Native persistence | Inspected installed `better_auth_flutter` 0.1.0 source defaults native storage to FlutterSecureStorage | Pin/audit the shipped package; verify this behavior from a clean dependency installation, not only the current local cache |
| Auth-free build | `AppConfig.noAuthMode` omits auth/upload providers; `Api.sendRequest` refuses networking | Production collector artifact must set `NO_AUTH_MODE=false`; test actual release artifact and all provider configuration |
| Queue ownership | `services/db/schema/uploads.dart` has no immutable owner-user field | Add owner, organization and project binding before any authenticated upload can start |
| Expiry/logout | `TokenService.handleSessionExpired` invokes logout; `AuthRepo.logout` clears UploadDb | Pause owned uploads and retain the durable capture/upload journal; session expiry must not erase work |
| Providers | Auth initialization always mints an Apple client secret; env validation requires both Apple and Google credentials | Enable providers explicitly; initialize only enabled providers; missing disabled Apple config must not block a Google pilot |
| Apple audience | Factory can accept a temporary borrowed development bundle ID | Remove the development audience from production; qualify the actual signed bundle and OAuth client configuration |
| User deletion | Both Better Auth `deleteUser.enabled` and custom `DELETE /users/me` are enabled; custom route directly deletes the user with cascading foreign keys | Replace both bypasses with the same retention-aware deletion-request policy before shared review data or releases exist |
| API perimeter | Hono CORS currently lists common methods/headers and all `/api/v1/*` routes share login middleware | Add the exact methods and non-simple client header used by new endpoints; enforce origin/CSRF policy on custom mutation routes |
| Tenant ACL | Existing domain tables contain user ownership but no organizations/project/release grants | Add explicit tenant/project/staff/release scopes; login alone must grant no data access |

The present secure cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`. Keep production HTTPS mandatory. Do not weaken cookies to make plain HTTP device testing work; use a development HTTPS endpoint. The mobile release currently needs the authenticated application configuration, not merely a login-screen change.

## 3. Pilot onboarding without an assumed email service

### Provider choice

Start with **Google sign-in for the controlled repair-worker pilot**, because the current native flow is already implemented. Confirm every pilot participant can use an approved Google identity before onboarding; an email address need not imply a particular mailbox provider, but it must have a usable Google identity for this path. Enable Apple only after its real production credentials and signed app bundle are qualified. App-store distribution requirements must be checked against the selected distribution channel before submission; do not ship a visible broken provider button.

Do not enable password signup, SMS OTP, magic links, or email OTP silently. Each introduces delivery, verification, recovery and abuse requirements. If pilot users cannot use the chosen social provider, add a separately scoped email-OTP implementation with a selected transactional mail provider, verified sending domain, retry behavior, rate limits, recovery support and budget. Supabase serving as managed Postgres does not provide email delivery for Better Auth.

The native flow obtains a Google ID token and submits it to Better Auth's social sign-in endpoint. Keep the web OAuth client first for web redirect/code flow and accept only the explicitly configured native token audiences. Derive the audience allowlist from the actual token flow; the current Android configuration uses `serverClientId`, so adding an Android OAuth client ID to the server list is not a substitute for checking the returned token's audience. Keep nonce validation and the mobile single-sign-in-flow guard. [Google integration](https://better-auth.com/docs/authentication/google)

### Explicit invitations and eligibility

1. An internal administrator creates a project and an invitation for a normalized, verified identity address, intended organization, project, role and expiry. Default expiry: 72 hours; this is a product default, not a provider requirement.
2. The API stores only a hash of the random one-time invitation secret and returns the invite URL once. Administrators distribute it through their existing approved pilot communication channel. This design does not require SMTP and does not automatically send a message.
3. The recipient signs in through an enabled provider and accepts the invitation while authenticated. The server compares the provider-verified identity email to the invitation email. Do not apply provider-specific Gmail dot/plus rewriting. Apple relay identities require an invitation to that actual verified relay address or an administrator-assisted identity review.
4. Inside one database transaction, lock the invitation, check expiry/revocation/remaining use and caller identity, insert/upsert the unique membership/project grant, mark the invitation accepted, and write an audit event. Repeating acceptance by the same user returns the existing result; acceptance by another user fails.
5. A newly authenticated but uninvited account receives only its own identity and invitation-acceptance surface. It cannot enumerate organizations, upload files, read recordings, submit jobs, review, or download releases. Identity creation is not enrollment.

Use application-owned invitation tables and domain grants for v1. Do not also enable Better Auth's organization plugin with a second independent membership model. Better Auth's supported hooks may later prevent uninvited account creation before persistence, but project access must remain enforced even if that optional admission hook fails or is absent. [Better Auth hooks](https://better-auth.com/docs/concepts/hooks)

The first internal administrator is bootstrapped by a one-time audited operator command using an already verified Better Auth user ID. There is no public “become admin” endpoint, automatic first-user administrator, trusted email-suffix shortcut, or grant derived from the user's editable display name.

## 4. Canonical principals and authorization data

Domain IDs may be UUIDs; Better Auth `user.id` and its foreign keys must remain text. Never cast an existing identity to UUID or rewrite its object prefix during database migration.

| Table | Authorization responsibility |
| --- | --- |
| `user`, `session`, `account`, `verification` | Better Auth identity and credential/session lifecycle; no tenant permissions embedded in client-writable profile fields |
| `organizations` | Tenant identity and enabled/suspended state |
| `memberships` | Active user-to-organization membership; unique organization/user pair; membership administration privilege is distinct from internal staff |
| `projects` | Tenant-owned collection/delivery scope and lifecycle |
| `project_access` | Explicit active member-to-producer-project grants for collection or delegated administration; customer release access does not require producer-project membership |
| `platform_staff` | Audited internal `internal_reviewer` or `internal_admin` privilege, separate from tenant membership |
| `staff_project_access` | Which projects an internal reviewer may access; internal admin can manage assignments, with elevated access audited |
| `recordings` | Immutable source owner user ID plus organization/project scope; owner prefix is a storage convention, not the ACL |
| `processing_runs` | Scope inherited from its recording/project; callable only through trusted orchestration services |
| `reviews` | Internal actor, target artifact/version, decision and history; no customer approval mutation |
| `releases`, `release_items` | Immutable publication snapshot and its exact artifacts |
| `release_grants` | Explicit recipient organization/user entitlement to a published release, optional expiry/revocation; recipient organization may differ from the release's producer organization |
| `deletion_requests`, `audit_events` | Retention-aware user/data lifecycle and attributable security/domain events |

Additional auth-specific tables belong in the canonical schema: `invitations` with hashed secret, recipient, scopes, creator, expiry and acceptance; `user_access_state` for suspended/deletion-requested state without assuming a Better Auth plugin schema. Use unique constraints and composite foreign keys wherever practical to prevent a membership or recording from being joined to a project in a different organization. Canonical column spellings belong in the [storage schema](storage-and-data-model.md).

### Principal capability matrix

Interactive human requests require a valid, eligible session from the selected identity adapter (Better Auth in the Node variant). The narrow CLI download-session capability below is a delegated exception, not a general human/API credential. “Assigned” means an explicit current project/staff assignment. “Granted” means a live release grant and a published, available release.

| Principal | Collect/upload | Read unreviewed recording/derived artifacts | Submit processing/retry | Review/correct/approve | Publish/manage release grants | Read/download published delivery | Manage people/grants |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Unenrolled authenticated user | No | No | No | No | No | No | No |
| Collector | Own capture, assigned active project | Own upload receipt/status and approved collection preview only | No direct GPU submission | No | No | Only if separately granted | No |
| Customer viewer | No | No | No | No | No | Granted releases, including complete trainable artifacts | No |
| Tenant administrator | Only with separate collector project grant | No automatic raw access | No | No | No internal publication powers | Granted releases | Tenant/project invitations within delegated scope; cannot grant staff or elevate own delegation |
| Internal reviewer | Only with separate collector grant | Assigned project | Assigned project through API policy | Assigned project | No, unless separately authorized as internal admin | Assigned project/release support scope | No staff escalation |
| Internal administrator | Explicit collection grant if collecting | Authorized operational access, audited | Authorized projects, budget checks | Authorized operational access | Yes, after publication invariants | Authorized operational access | Staff/project/release grants, audited |
| Processing service | No human upload | Only leased input artifacts for current attempt | No arbitrary job creation | Writes proposals/QC results only | No | No customer download grant | No |

A customer tenant administrator never becomes an internal reviewer. An internal reviewer needs both active `platform_staff` status and an active `staff_project_access` assignment. Removing either denies the next API request. Internal administrator access follows the explicitly audited operational policy rather than tenant membership. Removing an organization/project assignment takes effect on the next API authorization check; already issued signed URLs have a bounded residual lifetime.

### Server check order

For each endpoint, validate input shape, authenticate once, reject suspended/deletion-blocked identity, load the scoped resource and current grants, check the requested capability, then mutate in a transaction where required. Set request context to `{userId, sessionId, accessState, requestId}`; resolve project/release access through shared helpers rather than scattering email or role comparisons in route handlers. Resource scope is loaded from the database, never accepted as proof from a request body.

Cross-tenant resource lookup should return `404 resource_not_found` consistently, including guessed upload/recording/release IDs. Use `403 forbidden` when the caller is allowed to know a resource exists but lacks the requested action. Grant-changing transactions recheck administrator authority and the grant's target scope; they must not allow an organization admin to elevate to `platform_staff`.

## 5. Native session lifecycle and recording ownership

### Credential storage and rotation

Keep session cookies in the platform-backed secure store through the qualified Flutter auth package. `KvStore` may cache user display information and the non-secret user ID, never session cookies, provider ID tokens, service keys or presigned URLs as durable identity credentials. Redact `Cookie`, `Set-Cookie`, provider tokens and URL signatures from application, crash and network logs. Native secure storage reduces extraction risk; it does not make a compromised or unlocked device trustworthy.

Set session policy explicitly rather than relying on changing library defaults: initial pilot proposal is seven-day expiry, refresh after one day of use, and five-minute freshness for destructive/elevating actions. Keep cookie session caching disabled initially so revocation checks read the authoritative session store. Evaluate a separate staff idle-lock policy after measured usage; offline capture must not require indefinitely valid remote sessions. Better Auth distinguishes session expiry, update age and freshness. [Session management](https://better-auth.com/docs/concepts/session-management)

The old server calls `getSession` without forwarding response headers. Our Node/Fastify adapter must request returned headers and forward each `Set-Cookie` separately; never combine them with commas. Make an explicit call through `/api/auth/get-session` on foreground/reconnect when needed. Verify behavior on the independently qualified Better Auth version and Flutter package rather than inheriting a local factory/version as production-ready. The documented server API exposes `returnHeaders` and `getSetCookie()`. An Edge identity/session variant needs equivalent tested expiry/rotation behavior. [Better Auth server API](https://better-auth.com/docs/concepts/api)

### Capture while offline

At recording creation, persist `ownerUserId`, `organizationId`, `projectId`, capture ID and last confirmed assignment in a durable capture journal. Recording bytes and journal must survive application restarts, auth expiry, retry exhaustion and network outages. The recording's source owner and project association are immutable once upload begins.

A previously enrolled collector may capture offline under the last selected authorized assignment. The app labels that assignment's verification time; cached state does not authorize upload. On reconnect, authenticate and recheck current membership/project access before initiating or resuming an upload. If access was revoked, preserve the local recording, pause transfer and present a recoverable assignment/access issue. It must not quietly move the recording to another project.

If the app starts with no enrolled owner identity, it can enter an explicit local capture-only mode. Such captures are unclaimed and cannot upload until an authenticated collector explicitly claims them into an authorized project. The existing `NO_AUTH_MODE` artifact remains a separate capture-only build; it must not bypass the server or automatically adopt all local files after a production login.

### Session expiry, logout and account switching

Replace “401 -> logout -> clear UploadDb” with “401 -> pause authenticated network work -> retain owned journal -> reauthenticate.” Serialize reauthentication so parallel part failures do not produce multiple sign-in prompts. A `403`, storage URL expiry, timeout or HTTP 5xx must not be treated as an expired Better Auth session.

Before explicit logout, stop scheduling new part uploads, cancel best-effort in-flight transfers, persist confirmed part receipts and owner bindings, then revoke the session if reachable and clear only credentials and per-account UI caches. Offline logout clears local credentials immediately and records that remote revocation could not be confirmed. A different account cannot resume old account uploads. Offer a clear account-owned pending-work state rather than deleting files implicitly.

For captures with a known original owner, only that same identity may resume upload; staff-assisted reassignment is a separate audited operation with explicit provenance and must not occur automatically on account switch. Legacy unowned queue rows must be quarantined until explicitly claimed before any network transfer; do not infer their owner from whichever account happens to log in first. Signed object requests already in flight may finish after logout, but the backend must recheck ownership and grants on completion. [MCAP upload rules](mcap-upload.md)

## 6. Web session perimeter, CSRF and origins

Serve the review/customer portal and API under one HTTPS application origin through a reverse proxy where practical, for example portal `/` and API `/api/*`. Keep host-only cookies, `HttpOnly`, `Secure`, `SameSite=Lax`; do not widen cookie `Domain` to unrelated subdomains. Auth/session responses and user-specific API responses use `Cache-Control: no-store`. Do not place session tokens in browser localStorage or downloadable manifest files.

That cookie perimeter describes the Node/Better Auth variant. An Edge endpoint on a different site is not automatically compatible with `SameSite=Lax` browser API calls; the Edge variant must provide the qualified origin/proxy arrangement or explicitly design/test its alternative session transport and CSRF protections. Do not silently weaken cookie attributes to make a different hosting topology appear compatible.

Retain Better Auth's CSRF/origin safeguards on `/api/auth/*` in the Node variant. For custom `/api/v1/*` mutations, add our own perimeter; a library validating a session does not wrap arbitrary API business logic with origin protection. Require JSON for JSON mutation endpoints, a non-simple `X-Stera-Client` header, reject cross-site Fetch Metadata, and validate any supplied Origin against the exact allowlist. Native requests without browser Origin/Fetch Metadata are supported with the required header and valid session. Browser requests with `Origin: null` are rejected for our custom mutations. A hostile browser origin cannot set the custom header without successful preflight; the header itself is not authentication. Apply the same browser/session threat model to an Edge identity adapter. [Better Auth security model](https://better-auth.com/docs/reference/security)

The selected API's CORS policy must allow only actual portal/development origins and explicit request headers/methods. Never use credentialed wildcard origins or reflect arbitrary request Origin. Include `PATCH`, `X-Stera-Client` and `Idempotency-Key` if used by the final API. Configure object-store CORS separately for exact upload origins/headers; CORS is not a bucket access-control policy.

Mutation routes must not support side-effecting GET, method-override loopholes, or form/text content-type fallbacks. OAuth callbacks retain Better Auth's state/nonce behavior and are not forced through our custom JSON-only rule. Pin redirect/callback URLs, allowlist return destinations, and configure the reverse proxy's forwarded host/protocol handling so an arbitrary forwarded header cannot become the OAuth base URL.

## 7. Proposed API authorization contracts

Paths below are proposed domain routes under `/api/v1`; shared upload/release operations must use the final paths defined in their component documents. Better Auth's existing `/api/auth/*` is retained.

The inspected server currently exposes only Better Auth, `GET`/`DELETE /api/v1/users/me`, `POST`/`GET /api/v1/assets`, `GET /api/v1/assets/:id`, and `POST /api/v1/upload/presign` plus `POST /api/v1/upload/multipart/{start,parts,list-parts,complete,finalize,abort}`. `/access`, invitations, recordings, reviews, releases and deletion requests are proposed additions. The existing user-delete paths must be replaced and the asset/upload paths adapted through the canonical service; the presence of a current route is not evidence that it meets this authorization contract.

| Operation | Required checks | Response/failure |
| --- | --- | --- |
| `GET /users/me` | Valid session, return own non-secret identity/access state | `200`; existing identity response preserved or versioned; `401` if absent/expired |
| `GET /access` | Valid session | `200` permitted organizations/projects and capability flags; no role inferred from flags sent back by client |
| `POST /invitations` | Internal admin or explicitly delegated tenant invitation capability; no self-escalation | `201` one-time secret URL and expiry; `403`, `409 invitation_conflict`, `429` |
| `POST /invitations/accept` | Valid session plus verified matching recipient, live secret, transactional claim | `200` existing/new enrollment; `410 invitation_expired`, `403 invitation_identity_mismatch`, generic invalid-secret response |
| `DELETE /invitations/:id` | Issuer's current delegation or internal admin | `204`, audited; `404` across scopes |
| Create/resume/sign/complete/abort MCAP upload | Active collector grant; exact journal/recording ownership; session bound to caller, recording and project | `201/200/204` per upload protocol; `401`, `403 access_revoked`, `404`, `409 ownership_conflict` |
| Read recording/QC/review state | Own permitted collection receipt, or assigned internal staff capability | `200`; no customer visibility through recording endpoints |
| Submit/retry processing | Assigned internal staff, allowed recipe, cost admission policy | `202` durable run ID; no direct human client invocation of GPU credentials |
| Write review/correction | Internal reviewer/admin, assigned scope, expected artifact/review revision | `200/201`; `409 stale_revision` |
| Publish release/manage grants | Internal admin, fresh session, all approval/license/schema checks | `201/200`; `409 release_not_ready`; customer cannot call |
| List/read release | Active recipient identity and membership in the recipient organization, live matching `release_grants`, published/available snapshot; no producer-project membership required | `200`; `404` for invisible release |
| Create delivery download session | Same grant checks, requested artifacts must belong to that immutable release | `200` paginated manifest/short-lived object grants; `403 download_not_permitted`, `409 release_unavailable` |
| `POST /deletion-requests` | Own identity, fresh session or explicit support verification | `202` request ID; access blocked/revoked according to retention policy; no immediate shared-data cascade |

Custom API errors follow the existing envelope: `{"error":{"code":"forbidden","message":"Access denied","requestId":"..."}}`. Extend the current shared `ErrorCode` union and mobile decoding for the proposed detailed codes; they are not implemented today. Do not leak whether another tenant has a guessed identity, project, recording or release. Better Auth endpoints retain their documented error format; normalize them in the client adapter rather than rewriting protocol bodies through broad middleware. Use `429` with `Retry-After`; network errors and `503` preserve local capture state. Never log the invitation secret, session credential, URL signature or full sensitive request body.

## 8. Published-delivery access and complete downloads

Robotics customers inspect published deliveries and download all trainable data. They do not accept/reject individual episodes and cannot see internal review queues, rejected content, processor diagnostics or raw source recordings unless a separately reviewed delivery explicitly includes those sources.

Resolve customer authorization from the release's recipient grants and current identity/membership, not from the original collector's key prefix. The producing organization owns the project/release; the receiving customer organization can be different. For an organization grant, require an active recipient organization, active membership of the requesting user in that recipient organization, and a live release grant. For a user-specific grant, additionally require the grant's user match within its recipient organization. Neither case requires membership or `project_access` in the producer organization. Scope-consistent producer foreign keys must not prohibit this deliberate cross-organization grant relationship.

A release item may contain artifacts from different collectors while every storage key retains its immutable owner-user prefix. Storage keys beginning `${userId}/...` preserve the existing repository convention; organization/project access is checked in PostgreSQL. Keep private provenance manifests distinct from customer manifests, which use logical artifact IDs and relative release paths. Signed storage URLs can still reveal a pseudonymous owner/publisher prefix; omit direct identity/email mappings from customer data and qualify that residual disclosure if contributor anonymity is required.

The release manifest enumerates every published artifact, byte length, checksum, schema/calibration/provenance references, required training sidecars, episode mapping and license notice. The customer can retrieve every manifest page and resume downloads; the UI must not expose only preview MP4 files. Issue artifact download URLs on demand with the ten-minute default in the delivery component and a refresh endpoint that rechecks the live grant. Use shorter preview grants where practical. Final URL validity must account for storage-provider and temporary-credential limits.

Do not embed long-lived signed URLs in the immutable manifest; store artifact IDs and checksums and resolve URLs at download time. Revoking a grant stops new URL issuance immediately. A previously signed URL can remain usable until expiry, and a download started before expiry may continue; immediate revocation requires an authorized proxy and its bandwidth/operating cost. Document this bounded behavior in the operational contract. The portal exposes authorized release/revision IDs, never arbitrary object keys supplied by the browser. [Review and delivery](review-and-delivery.md)

The CLI uses a deliberately delegated download-session capability created/renewed by a logged-in authorized customer. Store only its hash, with requester user/recipient organization, grant/release IDs, frozen manifest digest, expiry/revocation and allowed actions. Its session ID is public lookup data, not a credential. A dedicated capability-authenticated manifest/URL-batch route runs outside broad human-cookie middleware; validate the secret and recheck the original user's current eligibility, recipient membership, live grant and published release on every request. It can read only that manifest and mint URLs for its enumerated artifacts. It cannot enter normal account, raw, review, processing or publication APIs. Browser creation/renewal stays session/CSRF protected. Pin its final path and shared schema with the delivery component, and redact the capability from logs and shell history.

## 9. Service identities and database exposure

Human sessions are never reused as worker credentials. Inngest Cloud coordinates the workflow, a Postgres transactional `event_outbox` records events for reliable publication, and Modal executes CPU/GPU work. There is no `pgmq` dependency in v1. Qualified short-lived handlers/reconciliation services for the selected hosting variant invoke Modal using server-only credentials; verify Node versus Deno SDK/transport support instead of assuming compatibility. Inngest event publishing and signed handler delivery use separate server secrets; validate delivery signatures through the supported adapter on its dedicated service route. Do not expose workflow triggers or cost-incurring event ingestion as an anonymous human endpoint or apply human-cookie authentication to service callbacks. [Orchestration design](job-orchestration.md)

A processing attempt receives only its job ID, attempt token and scoped input/output references. Attempt credentials authorize claim/heartbeat/result submission for that attempt, expire, are stored hashed, and are checked against the current fencing token. A stale or canceled attempt cannot publish a result. Workflow event payloads/history carry identifiers, not human session cookies, provider tokens, issuer keys, Modal credentials or long-lived signed object URLs. The worker-result ingress uses its dedicated attempt authentication rather than accepting a collector/customer cookie as equivalent authority.

Use short-lived, object-specific read/write grants or qualified prefix-restricted temporary credentials. Most adapter outputs are unique immutable object references. Native Curator is the explicit canonical exception: an authorized single writer mutates its bounded batch's stable Lance/media/checkpoint root across compatible attempts. Pin accepted committed versions and result contracts instead of copying the entire dataset per stage. Attempt log roots are unique; canonical dataset identity is not an attempt ID. No processing worker may write protected published-release roots or mutate raw/prepared source evidence outside its issued scope.

Serialize native batch mutation initially, including writers of different result fields. Curator does not enforce application writer leases. Before handing the stable root to a replacement/new invocation, verify the previous writer has terminated **and** its outstanding write capabilities expired or were revoked. A database claim epoch or new API token cannot stop old object-store writes. Block when that evidence is missing. Keep existing input payloads, physical fragments, row identities and pinned history immutable/reachable; prohibit incompatible layout maintenance during recovery/pinned use. The [canonical data-flow contract](pipeline-execution-and-data-flow.md) governs this exception.

A namespace with a bucket-wide write key is not isolation, and a batch-wide read-write key is not field-level access control. Keep raw originals and published roots outside its scope. Curator's one profile with R2 temporary credentials may apply read-write actions to every listed working path, including prepared/clip inputs; the pinned native adapter is then a trusted writer that must preserve existing media/input hashes within that bounded namespace. Do not claim storage-enforced read-only input paths or invent multi-profile support. If such enforcement is required, qualify an adapter/provider policy that supports per-action scopes (such as an appropriate AWS STS policy), or reject the profile. Qualify temporary-token propagation through Curator/Botocore/Lance and fail rather than fall back to a broad long-lived key. Workers cannot enumerate customer identities, read identity credential/session tables, issue delivery grants or publish releases. Keep database credentials out of GPU workers; control-plane claim/heartbeat/result APIs mediate state changes.

Treat result manifests as untrusted even with a valid attempt token. Validate provider/bucket/batch-or-artifact scope, counts/bytes, source/selection/result-contract digests and referenced closure. For native Curator, verify the actual dataset commit and native publication receipt, row-level status and expected input version under exclusive writer ownership; accept that pinned version in place. For non-Curator immutable payloads, verify object identity/hash/bytes. Payload copying/relocation is reserved for the qualified final release export or an explicitly required isolation boundary, with destination hash/closure verification. A valid worker token is not permission to fetch arbitrary URLs or copy another tenant's objects.

After validation or any bounded cloud copy, a final compare-and-set transaction must still match attempt/claim epoch/invocation owner, batch writer identity and expected upstream/input/observed publication digests, plus non-cancelled/non-deleted recording/run/job lifecycle. Select the accepted version/artifacts and mark success atomically. Cancellation winning before the commit leaves unaccepted results; it cannot be overwritten by a delayed receipt. Final release publication similarly rechecks the frozen selection/digest, current internal authority/rights and ready/non-revoked lifecycle. Native committed state alone is not application approval or customer publication.

Use separate database roles for migration owner, API runtime, and workflow/outbox operations. The API role has only required DML and cannot alter schema or grant itself privileges; the workflow publisher/reconciler can access its outbox/lease/result surfaces, not credentials or arbitrary tenant data. If one process initially holds both runtime roles, keep separate connection factories and credentials so service separation is mechanical later. Restrict network access, require verified TLS, cap connections and rotate credentials.

In the Node/direct-database variant, disable unused Supabase Data API and keep sensitive tables unexposed. For Edge hosting, explicitly decide its database access path and verified identity context; do not infer this from function hosting alone. Revoke unintended `anon`/`authenticated` grants/default grants and apply explicit RLS to deliberately exposed objects. A later configuration toggle must not expose session tokens or domain tables. Direct Drizzle access does not automatically obtain Supabase Auth claims. [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api)

Use a direct or session-pooled connection for a persistent Node API depending on network support; Edge/serverless access needs a qualified bounded pooling strategy. Migrations use a separate connection with an appropriately privileged role. If transaction pooling is chosen, disable postgres-js prepared statements (`prepare: false`) and do not depend on session-scoped settings/locks across transactions. Keep ACL predicates in application queries; any future database tenant setting must be transaction-local and proven under the selected pooling mode. [Supabase Postgres connections](https://supabase.com/docs/guides/database/connecting-to-postgres)

## 10. Implementation work packages and migration sequence

1. **Freeze the auth contract and qualify dependencies.** Record server/mobile versions, HTTPS origin, provider callback/token audiences and cookie names/options in a release receipt. Test a clean dependency install so modified global caches cannot hide a missing upstream fix. Keep all app source changes in the implementation owner's branch.
2. **Add domain access schema.** Add owned migrations/constraints for organizations, memberships, project/staff assignments, invitations, user access state, processing-batch ownership/publications and audit events. The Node variant uses reviewed Drizzle schema under `backend/src/db/`; an Edge variant requires its approved migration/access tooling. Preserve existing identity IDs or perform an explicit mapping migration. Bootstrap one internal admin and explicit pilot project/collector grants. Migrate legacy rows only with a documented owner-to-project mapping; quarantine ambiguous data.
3. **Add shared principal/ACL services.** For Node create `backend/src/modules/auth/` and `backend/src/modules/access/` with a testable Fastify principal hook and capability helpers; for Edge create equivalent owned function/shared-policy adapters. Do not extend/import the cloned server's middleware as production code. Scope all queries by resource/project/organization; add audit writes for invitations, grants, suspensions, processing admission, approval, publication and downloads. Store only necessary security metadata with a retention policy.
4. **Qualify provider/configuration startup.** For Node create `backend/src/modules/auth/` factory/adapter and `backend/src/config/` validation for enabled providers, explicit session policy and production audiences. The Edge variant must prove its chosen identity protocol on native clients before adoption. Keep secret values outside mobile assets and examples. Add fatal configuration checks for authenticated production builds.
5. **Make mobile queue/session safe.** Update `auth_repo.dart`, `auth_provider.dart`, `token_service.dart`, `Api`, startup initialization and Drift upload/capture journal migrations. Preserve file ownership across expiry/logout; implement owner-filtered resumption and explicit unclaimed-capture handling. Do not drop/recreate the database to add owner columns.
6. **Protect all custom routes.** Apply current-grant ACL and CSRF/origin policy before upload signing/completion, review mutation, release publication and grant issuance. Define owned HTTP/event/manifest contracts and conformance fixtures; Node targets `backend/src/contracts/`, with a qualified Edge equivalent if selected. Forward session refresh cookies correctly. Keep narrow download-capability and signed service routes separate from broad human-session hooks. Recheck authorization/fences in final acceptance transactions.
7. **Replace unsafe deletion paths.** Remove or route Better Auth direct deletion and custom `DELETE /users/me` through the same policy before deploying shared-domain readers. Auth-only session/account rows may cascade; provenance-bearing domain foreign keys must use explicit restriction/tombstone or immutable actor-reference rules. Do not copy existing `assets`/`upload_sessions` user-delete cascades into recordings, reviews or releases. Support fresh-session verification, revoke sessions and preserve required provenance. Keep legal/privacy erasure and contract retention outcomes explicit in `deletion_requests`; never use soft deletion as an indefinite refusal to erase eligible data. A background deletion workflow handles object cleanup with an auditable result.
8. **Ship portal identity and access screens.** Implement existing-provider sign-in, access-denied/enrollment states, project selection, invitation administration and active-session support. Customer routes select only published grants. Internal and customer navigation derives from capabilities but every endpoint rechecks them.
9. **Run isolation and lifecycle acceptance tests.** Use real signed test artifacts on iOS and Android, an HTTPS staging origin, provider test identities, and multiple tenants. Release only after all blocker scenarios below pass. This is authorization validation, not a request to deploy during documentation work.

Better Auth's Drizzle integration requires schema generation/review and migrations through our ORM; do not run the built-in adapter migration path against this application by assumption. Compare generated auth/plugin schema with the existing tables and apply reviewed incremental migrations. [Better Auth database integration](https://better-auth.com/docs/concepts/database)

## 11. Acceptance and failure scenarios

| Scenario | Required result |
| --- | --- |
| Authenticated production artifact | `NO_AUTH_MODE=false`; real login works; no borrowed Apple audience; disabled provider cannot prevent server startup |
| Native restart after social login | Session restored from secure store; cookie only sent to intended HTTPS origin/path; no secrets in SharedPreferences or logs |
| Session refresh | Advance beyond update age; prove Set-Cookie reaches native jar/browser and survives restart; expiry remains enforced |
| Collector offline for a workday | Capture/journal intact across restarts; reconnect requests login if necessary; resumes same owner's confirmed parts |
| Session expires during multipart upload | Upload pauses without clearing journal or changing recording ID; valid storage part response is not misclassified as auth expiry |
| Owner A logs out and owner B logs in | A's files, receipts and job metadata remain owner-bound; B cannot sign, complete, resume, list or adopt them automatically |
| Legacy unowned local file | Remains unclaimed until deliberate enrollment/claim; never uploaded automatically under a new identity |
| Invite reused or accepted concurrently | Exactly one recipient enrollment; retry by same recipient idempotent; other identity denied; secret not persisted plaintext |
| Self-edited client role or organization ID | No privilege change; server reads grants/resource scope; unauthorized cross-tenant IDs consistently hidden |
| Tenant admin attempts internal role or raw review | Denied; no public path can create platform staff; customer capability does not imply review access |
| Customer requests draft/rejected/raw artifact | Denied even with guessed ID/key; published manifest grants all and only that release's trainable artifacts |
| Producer project belongs to a different organization | Active customer membership plus the recipient release grant permits delivery access; customer cannot enumerate the producer's projects/raw data |
| Grant revoked during download | New grants/URL refresh denied; residual signed-URL validity bounded and documented; no promise of instantaneous cancellation |
| Collector assignment revoked after parts upload | Completion checks current authority; retain object/session for controlled recovery or cleanup, never publish/process automatically |
| Internal reviewer removed from project | Next API request denied; stale UI state cannot approve/publish; existing URL lifetime bounded |
| Custom route called from hostile web origin | Origin/Fetch Metadata/non-simple-header policy rejects mutations; CORS never reflects attacker origin |
| Native call omits browser Origin | Valid session plus required custom header accepted; missing Origin alone never authenticates anything |
| Database Data API accidentally enabled | Unprivileged key cannot read auth/domain tables; schema/default-grant audit catches exposure before deployment |
| Stale worker result after cancellation | Attempt fencing check rejects state transition; worker never gets publish or grant-management permission |
| Curator retry needs the same canonical root | No new write capability until prior writer termination and credential expiry/revocation are both proved; DB epoch alone is insufficient |
| Native result/checkpoint committed before callback loss | Recover the same compatible batch/root and reconcile its actual publication; do not copy all payloads or rerun completed inference by default |
| Cancellation occurs during result validation/export | Final CAS rejects acceptance/publication; committed native versions or copied objects remain unaccepted and cannot resurrect deleted state |
| Worker submits another tenant's object in a result manifest | Promoter rejects its scope before copying; no arbitrary URL fetching or ambient privileged read |
| Forged workflow trigger or callback | Inngest signature/attempt credential check denies the request before any invocation or state mutation; human session alone cannot authorize it |
| CLI has only a valid download-session capability | Dedicated scoped route works without a human cookie; normal account/internal APIs remain inaccessible; expired/revoked identity/membership/grant/session blocks fresh URL issuance |
| User requests deletion with published history | Sessions revoked per policy; request tracked; no FK cascade erases shared releases or silently orphans object storage |
| IdP/API outage or rate limiting | Retryable error with safe backoff; recording and ownership journal preserved; no credential logging or destructive logout |

Pilot exit evidence includes a provider/configuration receipt without secrets, migration IDs, ACL matrix test results, physical-device session/queue results, and a signed-URL/Data API exposure audit. Authentication working in a local development build is not sufficient evidence for repair-worker deployment.
