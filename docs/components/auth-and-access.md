# Authentication and access

Node/Better Auth reference integration · hosting review 2026-10-26 · Not deployed. [Current hosting evaluation](hosting-evaluation.md) supersedes runtime/provider assumptions below. Access rules remain required; an Edge/Deno choice needs its own qualified identity/session adapter.

Parent: [Technical design](../technical-design.md). This document owns identity, permissions and session behavior. [Storage](storage-and-data-model.md) owns tables; [contracts](../contracts.md) owns wire/error formats; [uploads](mcap-upload.md) and [delivery](review-and-delivery.md) own their endpoint protocols.

## Identity and onboarding

Use one independently configured Better Auth authority in the owned Node backend. Supabase supplies PostgreSQL, not a second login system. Preserve the Flutter client's cookie protocol and existing opaque user IDs where data exists; qualify the library and adapter rather than copying Stera's factory. Mount `/api/auth/*` through the supported Fastify integration. OAuth/session cryptography stays in the library. [Better Auth integration](https://better-auth.com/docs/integrations/fastify)

Pilot onboarding uses Google sign-in and explicit invitations. Enable Apple only after real production signing, client IDs and audiences pass native tests; exclude borrowed development audiences. Configure only enabled providers. Verify nonce, issuer, expiry and the actual ID-token audience; Android using a web `serverClientId` is not evidence that every Android client ID belongs in the audience allowlist. A provider ID token establishes identity, not project access.

Do not assume SMTP exists. Administrators can distribute one-time invite URLs manually. Email OTP/password recovery is a separate implementation requiring a selected mail service and verified sending domain. Confirm pilot users can use the selected provider.

An invite records recipient verified email, organization/project, delegated permissions, creator, expiry and revocation. Store its random secret hashed. Acceptance requires login and matching provider-verified email, then one transaction locks/consumes the invite and creates grants. Same-user retry returns the original acceptance and current grants without recreating revoked grants; another identity cannot reuse it. Do not normalize addresses using Gmail-specific dot/plus rules. A signed-in unenrolled identity may read its own identity and accept an invite, but cannot enumerate projects or upload.

Bootstrap the first internal administrator through an audited operator command targeting a verified user ID. No first-user-admin rule, public staff-grant endpoint or email-domain shortcut.

### Identity/enrollment API

All paths below are proposed; shared success/error envelopes apply. Identity IDs remain immutable.

| Endpoint | Scope / required fields / result |
| --- | --- |
| `GET /api/v1/users/me` | Session; own ID, verified email, display name and access state. |
| `GET /api/v1/access` | Session; current organization/project grants and capabilities. |
| `POST /api/v1/invitations` | Authorized delegator; `organizationId`, `recipientEmail`, `membershipRole`, bounded `projectGrants[{projectId,role}]`, optional `expiresAt`; `201` ID/one-time URL/expiry. |
| `POST /api/v1/invitations/accept` | Session; `invitationId`, `token`; verified recipient match; `200` acceptance/current grants, idempotent by accepting user ID. |
| `DELETE /api/v1/invitations/:id` | Current delegation; revoke pending invitation; `204`, no implicit grant deletion. |
| `POST /api/v1/deletion-requests` | Fresh own session/support verification; optional `reason`; `202` request ID/state. |

## Permission rules

An organization is a tenant. Membership alone grants no producer-project access. `memberships.role` is `member` or `admin`; `project_access.role` is `collector` or `project_admin`. Internal `internal_reviewer`/`internal_admin` roles live in `platform_staff`, separate from customer membership. Staff data access also requires `staff_project_access`; administrators can create an audited assignment after fresh authentication.

| Principal | Upload | Internal data/review | Processing | Delivery/grants |
| --- | --- | --- | --- | --- |
| Unenrolled identity | No | No | No | No |
| Collector | Own files in assigned active project | Own upload status/allowed collection preview only | No direct submission | Separately granted releases only |
| Customer member | No | Published items only; no accept/reject | No | Granted releases and complete downloads |
| Tenant/project administrator | Only with collector grant | No automatic raw/review access | No | Delegated tenant/project invitations; no publication/staff escalation |
| Internal reviewer | Separate collector grant if collecting | Assigned project; correct/approve exact revisions | Assigned processing/retry through admission policy | No publication unless separately internal admin |
| Internal administrator | Separate collector grant if collecting | Assigned project | Authorized admission/cancellation | Publish and manage release/staff grants; audited |
| Processing service | No human upload | Issued inputs; writes proposals/results only | Current attempt only | Cannot approve, publish or grant access |

Every interactive request authenticates once, rejects suspended/deletion-blocked users, loads the resource's scope from Postgres and checks current grants. Client role flags, cached organization IDs and key prefixes are not authority. Grant-changing transactions recheck delegation and cannot escalate the caller. Staff removal or assignment revocation denies the next request.

Customer release access requires an eligible user, active membership in the **recipient organization**, live matching `release_grants`, and a published, available release. User-specific grants additionally match that user. The recipient may differ from the producer; no producer-project membership is required. An organization grant intentionally covers its active members, including later authorized invitees. Customers never gain internal review/cancellation rights through delivery access.

Use `404` for resources the caller cannot know exist; `403` for a denied action on a visible resource. Retain the shared error envelope from [contracts](../contracts.md). Better Auth endpoints retain their library format, normalized by the client adapter.

## Native sessions and offline ownership

Persist native session cookies in the qualified platform secure store; ordinary preferences contain only non-secret profile/ownership data. Forward cookies to the intended HTTPS host/path and save every returned `Set-Cookie` separately. Never comma-join them. On the server request Better Auth response headers so rotation reaches clients. Test these behaviors from a clean dependency install and on signed devices, not a modified local package cache.

Initial policy: seven-day session expiry, one-day refresh interval, five-minute freshness for deletion/elevating/publication actions; cookie session caching disabled for authoritative revocation checks. These are configurable defaults. Custom sensitive routes must enforce freshness explicitly. Redact cookies, ID tokens and signatures. [Sessions](https://better-auth.com/docs/concepts/session-management), [response headers](https://better-auth.com/docs/concepts/api)

At capture creation, persist immutable owner user ID, organization/project/assignment, capture ID and last verified assignment time in a durable journal. A previously enrolled collector may record offline under that assignment; cached access never authorizes upload. Reconnect rechecks live authority before starting/resuming. Revocation pauses transfer and preserves files; it does not move them to another project.

Unauthenticated capture-only files remain unclaimed until explicit claim into an authorized project. Legacy rows without an owner are quarantined for claim/recovery, not adopted by whichever account logs in next. `NO_AUTH_MODE` remains capture-only; the deployed collector build must enable authenticated networking.

On session expiry, pause authenticated network work and reauthenticate without deleting files, receipts or queue records. Serialize reauthentication. Storage URL expiry, `403`, network failure and `5xx` are different conditions, not reasons for destructive logout.

Explicit logout stops scheduling/renewal, saves receipts, cancels transfers best effort, revokes the remote session when reachable and clears credentials/UI caches only. Offline logout records unconfirmed remote revocation. Owner B cannot browse/resume/reassign owner A's pending captures. Same-owner recovery remains possible after login. Completion rechecks current ownership and project authority even when previously issued object requests succeeded.

## Browser and service authentication

Serve console and API under one HTTPS origin. Use host-only `HttpOnly; Secure; SameSite=Lax` cookies covering auth and API paths, and `Cache-Control: no-store` for private responses. No session tokens in browser localStorage. Trust forwarded host/protocol only from the configured proxy.

Keep Better Auth's origin/nonce/state checks. Custom human cookie-authenticated `/api/v1/*` mutation routes require JSON, `X-Stera-Client`, exact allowed Origin when present, and rejection of cross-site Fetch Metadata/`Origin: null`. Native requests without browser Origin are supported with the header and valid session. The header is not authentication. Allow only required CORS origins/methods/headers, including idempotency headers; no credentialed wildcard. OAuth callbacks retain their proper content types. Signed workflow, internal worker/validator and download-capability routes have their separate authentication/middleware below and are outside this human-cookie CSRF rule. [Security](https://better-auth.com/docs/reference/security)

Use separate authentication boundaries:

| Route group | Credential | Authority |
| --- | --- | --- |
| `/api/auth/*` | Provider/library protocol | Sign-in/session lifecycle |
| `/api/v1/*` | Human cookie session plus current grants | Authorized domain actions |
| `/api/inngest` | SDK-verified service signature | Registered short workflow steps only |
| Dedicated attempt claim/heartbeat/result routes | Hashed expiring attempt capability | Bound run/batch/attempt/claim epoch, allowed actions and invocation owner |
| `/api/download/sessions/:id/{manifest,urls}` | Hashed download capability | One requester/grant/release/manifest only |

Register signed/capability routes outside blanket human-cookie middleware. IDs alone are never credentials. Keep capabilities in redacted Authorization headers, not event history/manifests/URLs. Workflow events contain identifiers only; Modal/issuer credentials remain server-side.

For CLI downloads, a logged-in customer creates/renews the capability. Each request rechecks its expiry/revocation, original user's eligibility, recipient membership, grant, release state and manifest digest. It cannot access ordinary APIs. Signed file URLs remain bearer capabilities until effective expiry; revocation blocks new issuance, not already downloaded bytes. [Delivery](review-and-delivery.md) defines URL lifetime, batches and complete-inventory behavior.

Workers receive no general database or human-session credentials. Their writable batch scope and canonical single-writer takeover constraints are defined once in [storage](storage-and-data-model.md). A valid attempt token cannot authorize arbitrary object fetching or publication. Trusted validation starts only after the producer is terminal, all writes/grants are retired and provider visibility reconciled; hold ownership through acceptance. The final transaction checks the validated barrier/write-grant generation. Exporter credentials must also be retired before validating/publishing their destination; details belong to storage/orchestration.

## Deletion and implementation gates

Replace both direct user-delete paths, including Better Auth deletion and legacy `DELETE /users/me`, with `POST /api/v1/deletion-requests` and the retention-aware workflow. Require a fresh session/support verification, revoke access as policy directs and preserve shared provenance. Auth-owned sessions/accounts may cascade; domain references must not. Do not retain personal data indefinitely under a tombstone excuse. [Storage retention](storage-and-data-model.md) owns purge/restore rules.

Implement auth/access in `backend/src/modules/{auth,access}/`, configuration in `backend/src/config/`, and generated runtime bindings in `backend/src/contracts/` from canonical `processing/contracts/`. Mobile integration must remove queue-clearing expiry/logout behavior and persist owner binding. Do not import old server handlers.

Release evidence must prove:

- Native Google/Apple configuration as enabled; cookie restart/rotation/expiry and revocation work on signed devices.
- Expiry, offline logout and account switching preserve journals and prevent cross-owner upload.
- Concurrent invite acceptance is idempotent; forged tenant/staff roles cannot escalate.
- Cross-tenant raw/draft/review access is denied; recipient grants work without producer membership.
- CSRF/host spoofing, forged service calls and expired/stale capabilities fail before mutation/spend.
- CLI capabilities work without human cookies but cannot escape their release.
- User deletion cannot cascade shared releases; final acceptance/publication rechecks lifecycle and authority as specified by storage/orchestration.
