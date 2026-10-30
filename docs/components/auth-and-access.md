# Authentication and access

MVP design · updated 2026-10-30 · Not implemented or deployed.

Parent: [technical design](../technical-design.md). [Contracts](../contracts.md) owns routes/encoding; [storage](storage-and-data-model.md) owns tables.

## One login and a manual allowlist

Use one Better Auth instance in Next.js with its official `/api/auth/*` adapter and Render Postgres tables. Start with Google login. Qualify the actual provider audiences/nonce and signed mobile builds; enable Apple only when required and tested. No email service, invitation UI, organizations or delegated administration is needed for the pilot. [Next integration](https://better-auth.com/docs/integrations/next)

After verified login, an operator enables the immutable user ID through a reviewed script. Unenrolled users see their identity and an access-pending page. Roles come from `access`, never client flags or email-domain shortcuts. Users may hold multiple roles.

| Role | Allowed |
| --- | --- |
| `collector` | Register/upload own recordings and inspect own upload/processing status |
| `staff` | Inspect pilot recordings, retry jobs, label/review clips, build/publish/revoke releases and assign release recipients |
| `customer` | Inspect/download only explicitly granted published releases; no raw/internal/review access |

Configure one pilot project server-side. Every request checks enabled access and ownership or release grant. Staff have pilot-wide access. Customers cannot enumerate others' releases. Operators change roles; no public role-administration endpoint exists. Revocation denies the next API request.

## Sessions and offline ownership

Use host-only `HttpOnly; Secure; SameSite=Lax` browser cookies under one HTTPS origin. Native cookies live in platform secure storage. Save every `Set-Cookie` separately and propagate rotation from server auth calls. Disable cookie-only session caching for authoritative revocation. Keep a seven-day session/one-day refresh starting policy; sensitive publication requires a fresh session. [Session management](https://better-auth.com/docs/concepts/session-management)

Persist the verified owner ID and capture ID in the recording journal **when capture starts**. Previously authorized collectors may record offline; upload/resume rechecks current access. Expiry pauses networking and requests login without deleting local files, queue entries or receipts. Serialize reauthentication. Network errors, expired storage URLs and authorization denial are distinct conditions.

Logout stops transfers/renewal, preserves journals/files, clears credentials and revokes the remote session when reachable. Offline logout records unconfirmed revocation. Another account cannot browse, resume or adopt the previous owner's pending captures. Legacy ownerless recordings require explicit recovery rather than automatic adoption. Unauthenticated capture mode cannot upload.

## Browser and service boundaries

Human mutations require a valid session, JSON, `X-Stera-Client` and allowed browser Origin; reject cross-site Fetch Metadata and `Origin: null`. Native requests may omit Origin while retaining the header and session. Keep Better Auth's own origin/state checks. Configure canonical/trusted origins explicitly; no credentialed wildcard CORS. Protected Next data and pages never enter public/shared caches. [Security](https://better-auth.com/docs/reference/security)

| Caller | Credential and scope |
| --- | --- |
| Browser/mobile | Human session and live role/ownership checks |
| Workflow controller | Rotated internal token; scoped job claim/submission/status/reconciliation operations |
| Repair cron | Separate internal token and workflow-dispatch client; pending-job/controller repair only |
| Processing/export worker | Hashed expiring job capability, then fresh invocation nonce/call-ID binding; only its inputs/uploads/result |

Worker tokens cannot claim another job, publish releases or obtain general database/R2/Modal credentials. Workflows/cron have no human session or database access. Only hosted workflow controllers hold Modal control credentials; cron requests reconciliation through the API. Render dispatch credentials belong only to web; task inputs contain IDs, not secrets. Keep credentials in redacted Authorization headers, outside manifests/logs. Service routes never fall back to cookies.

Raw/output URLs are issued only after authorization. Revocation blocks new URLs; already issued archive URLs can remain usable for up to 24 hours. Handle deletion through staff-assisted suspension and reference-aware cleanup; disable direct auth-user cascading deletion. Test account switching, CSRF, stale worker claims, private caches and customer isolation before pilot.

Before enabling real collection/processing, the operator records pilot permission evidence covering capture and automated processing; recording registration references that approval. Missing/revoked permission blocks ingest admission. A collector checkbox alone does not establish third-party rights. Publication separately checks permitted customer export. No self-service policy engine is required.
