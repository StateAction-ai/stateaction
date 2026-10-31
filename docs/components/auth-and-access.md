# Authentication and access

MVP design · updated 2026-10-31 · Not implemented or deployed.

Parent: [technical design](../technical-design.md). [Contracts](../contracts.md) owns routes/encoding; [storage](storage-and-data-model.md) owns tables.

## One login and a manual allowlist

Use one Better Auth instance in Next.js with its official `/api/auth/*` adapter and Render Postgres tables. Start with Google login. Qualify the actual provider audiences/nonce and signed mobile builds; enable Apple only when required and tested. No email service, invitation UI, organizations or delegated administration is needed for the pilot. [Next integration](https://better-auth.com/docs/integrations/next)

After verified login, an operator enables the immutable user ID through a reviewed script. Unenrolled users see their identity and an access-pending page. Roles come from `access`, never client flags or email-domain shortcuts. Users may hold multiple roles.

| Role | Allowed |
| --- | --- |
| `collector` | Register/upload own recordings and inspect own upload/processing status |
| `staff` | Inspect Pipeline status/errors, create/manage Datasets and review accepted clips; release/export/publish UI is follow-up |
| `customer` | Read-only granted Datasets and their currently approved clips; no raw/internal/review access |

Configure one pilot project server-side. Every request checks enabled access and ownership or Dataset grant. Staff have pilot-wide access. Customers cannot enumerate ungranted Datasets or their hidden members. Operators change roles/view grants; no public role-administration/sharing UI is required. Revocation denies the next API request.

Both roles use **`/clips/[clipId]`**, reached from the shared Data browser. Pipeline is the staff status/error screen. Staff may inspect accepted pilot clips. Customer working access requires an enabled role, live `dataset_access`, current Dataset membership and the clip's latest review being approved. Use that exact current approved label; never expose a draft/rejected decision or internal notes. A newer processing job does not change an older clip's identity. An inaccessible clip returns 404.

Customer lists, counts, hours and grid items include only currently approved members of granted Datasets. Resolve each response consistently, then recheck the live grant/membership/approval when issuing a viewer URL. A Dataset UUID or membership alone is not authority. Removal, withdrawal or revocation blocks access through that working Dataset; another valid Dataset may still authorize the same clip. Seed operator grants/approved clips for customer tests; no publication flow is required. [Dataset contract](data-browser-and-datasets.md)

Follow-up published Dataset versions additionally require publication plus the Dataset grant. Their named label/member snapshots stay pinned when the working Dataset changes; do not replace frozen labels with a draft or silently select another context. Future publication remains staff-only.

`GET /api/v1/clips/:clipId` returns role-scoped data/capabilities. `POST /api/v1/clips/:clipId/viewer-access` rechecks access before signing the same customer-safe RRD for either role. `POST /api/v1/clips/:clipId/reviews` additionally requires staff, CSRF protection and `expectedRevision`. Customer payloads omit internal QC, notes and provenance; disabling forms is not authorization. [Viewer contract](rerun-clip-review.md)

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

Raw/output URLs require authorization. Revocation blocks new URLs; future archive URLs can remain usable for up to 24 hours. Handle deletion through staff-assisted suspension and reference-aware cleanup; disable direct auth-user cascading deletion. Test account switching, CSRF, stale worker claims, private caches and customer isolation before pilot.

Viewer access uses a short-lived signed RRD GET, never a raw-MCAP URL. Internal data must be absent from the RRD bytes, not merely hidden in its entity tree. Self-host viewer assets; never send private URLs to `app.rerun.io`. Previously issued URLs/loaded bytes remain subject to their expiry/local possession.

Before enabling real collection/processing, the operator records pilot permission evidence covering capture and automated processing; recording registration references that approval. Missing/revoked permission blocks ingest admission. A collector checkbox alone does not establish third-party rights. Before enabling a Dataset view grant, the operator must also record permission covering external inspection and verify the Dataset contains only data cleared for that recipient. A grant is not merely a UI entitlement. Missing/revoked review permission blocks sharing; grant revocation blocks new URLs. Future publication separately checks permitted customer export. No self-service policy engine is required.

When adding or approving a clip in an already shared Dataset, staff/operator must confirm it is cleared for the existing recipients before it becomes externally visible. Revoked permission disables the affected sharing. This is a manual pilot rule recorded with permission evidence, not an extra reviewer checklist or policy engine.
