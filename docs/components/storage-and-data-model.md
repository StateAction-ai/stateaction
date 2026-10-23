# Storage and data model

Status: proposed implementation design. Updated: 2026-10-22. No production database, bucket or migration was created for this document.

Parent: [Technical design](../technical-design.md). Canonical topology: [processing execution and data flow](pipeline-execution-and-data-flow.md). Related: [uploads](mcap-upload.md), [auth](auth-and-access.md), [orchestration](job-orchestration.md), [processing](cloud-processing.md), [delivery](review-and-delivery.md).

## Decision

Use Supabase as managed PostgreSQL and retain private R2 object storage for the first qualification. Use Inngest Cloud for durable workflow orchestration and a transactional Postgres event outbox for reliable handoff. Keep object references provider-aware so S3 can replace R2 if compatibility, AWS credits or measured transfer economics favor it. API/auth hosting remains provisional: the canonical topology illustrates Supabase Edge Functions on Deno/TypeScript; an owned Node.js/TypeScript service with qualified Better Auth is the alternative. This storage contract does not select or validate an identity migration.

Store catalog and workflow records in Postgres. Store MCAP, images, videos, arrays, annotations, manifests and dataset shards in object storage. Curator maintains a canonical Lance/media root and native checkpoint workspaces per bounded processing batch, shared across compatible attempts under exclusive writer ownership. Store only reusable model weights in Modal Volumes. Neither the phone nor a Modal container filesystem is the durable source of truth after ingest.

| Layer | Stores | Deployment boundary |
| --- | --- | --- |
| Supabase Postgres | Users/grants, recording/run/batch state, accepted version references, reviews/releases/outbox | Managed application database |
| Lance in Curator batches | Clip/span rows, payload references, result columns and dataset commit history | Dataset files over the qualified object store; no separate LanceDB server or hosted vector database |
| Object payloads/workspaces | MCAP, clips, frames/sensors, arrays, manifests, native checkpoints and release shards | Private buckets; not stored as large Postgres rows |

Lance is required by the native Next recipes we plan to reuse; it is not required for every application table or every custom hand/MCAP adapter. Without those recipes we could choose other files/catalog structures, but removing Lance while retaining native Next processing would require replacing its dataset/recovery integration. This plan adds no hosted vector database.

This is a recommended target, not evidence that a Supabase project or R2 account is already configured. The inspected app implements an R2 client and PostgreSQL schema, but these are protocol/source evidence rather than a production-quality endorsement: [storage helper](../../stera-app/apps/server/src/lib/r2.ts), [schema](../../stera-app/packages/db/src/schema/app.ts), [connection factory](../../stera-app/packages/db/src/index.ts).

## Why this boundary

| Option | Practical consequence | Decision |
| --- | --- | --- |
| Supabase DB + Node API/qualified Better Auth + R2 | Preserves qualified mobile protocol compatibility while rebuilding server-side business logic | Node hosting/auth variant; not final hosting selection |
| Supabase DB + Edge API + object storage | Deno/TypeScript control requests; identity/provider/session integration still needs an explicit decision and native qualification | Illustrated canonical topology; not a completed auth migration |
| Move bulk bytes into Supabase Storage | Requires storage/transfer qualification; included storage does not eliminate large dataset transfer costs | Evaluate only against the same storage contracts |
| AWS S3 + managed/self-managed Postgres | Strong alternative with same-region AWS compute, credits or CloudFront delivery | Supported provider boundary; qualify before switching |
| Modal Volume for the dataset | Couples canonical data to compute provider and adds a second data access path for customers | Models/cache only |

R2 Standard lists $0.015/GB-month and free direct egress, with request charges. S3 can have exempt transfer paths, including same-region AWS services and CloudFront origin transfers. Do not assume every Modal read of S3 is chargeable or free: qualify the actual placement and billing path. R2's S3 API compatibility is partial, so successful presigning does not qualify Curator/Lance. [R2 prices](https://developers.cloudflare.com/r2/pricing/), [R2 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [S3 pricing](https://aws.amazon.com/s3/pricing/).

## Object layout and immutability

Provision private buckets per environment and trust boundary:

| Logical bucket | Writers | Readers | Policy |
| --- | --- | --- | --- |
| `capture-raw` | Upload service grants narrowly scoped mobile multipart writes | CPU ingest through scoped credentials; privileged internal inspection | Originals; no overwrite after verified ingest |
| `capture-derived` | Exclusive batch writer for native Lance/media/checkpoints; other stage writers for unique immutable artifacts | Processing dependencies and authorized internal review | Stable batch roots, attempt logs/scratch and immutable non-Curator artifacts are distinguished |
| `capture-releases` | Release packaging/promotion service | Authorized delivery URLs | Published manifests and shards are immutable; revocation is catalog state |

Names are examples; actual names must be environment-specific and globally available. Disable public bucket access and `R2_PUBLIC_URL` for production data. Never issue new single-PUT URLs or a new multipart upload ID against a verified raw key. A consumed multipart ID cannot re-open that object; every replacement uses a fresh physical generation. Preview access uses authorized signed GET URLs; Range requests must work for videos and large files.

Apply the same rule to source metadata/sidecars. A previously issued single-PUT URL can overwrite its object until it expires even if no new URLs are issued. Use one-part multipart for canonical immutable files, or upload small sidecars to staging and finalize once into a new protected key with verified destination hash; alternatively wait for all write capabilities to expire before accepting that key. A HEAD/hash verification alone does not revoke an outstanding PUT capability.

Object keys retain the app's owner-prefix rule. `userId` is the immutable Better Auth identifier, not a display name or email. Domain IDs are server-generated UUIDs. Do not change existing auth IDs to UUIDs during this work.

| Object | Example key |
| --- | --- |
| Original MCAP | `{userId}/orgs/{orgId}/recordings/{recordingId}/raw/{fileId}/source.mcap` |
| Recorder metadata | `{userId}/orgs/{orgId}/recordings/{recordingId}/raw/{fileId}/metadata.json` |
| Canonical Curator batch/media root | `{userId}/orgs/{orgId}/recordings/{recordingId}/runs/{runId}/batches/{batchId}/` |
| Canonical Lance table | The same batch root plus `lance`; retain the native media and recipe checkpoint layout below that root |
| Attempt logs/diagnostic scratch | `{userId}/orgs/{orgId}/recordings/{recordingId}/runs/{runId}/attempts/{attemptId}/...` |
| Immutable non-Curator artifact | `{userId}/orgs/{orgId}/recordings/{recordingId}/runs/{runId}/artifacts/{artifactId}/...` |
| Release files | `{publisherUserId}/orgs/{orgId}/releases/{releaseId}/versions/{version}/...` |

Owner prefixes are a storage namespace convention. They do not grant team access. Organization/project authorization lives in Postgres. Customer-facing manifests use logical artifact IDs and relative release paths; private provenance manifests may retain owner-prefixed references. Signed object URLs can reveal pseudonymous key prefixes, so identity minimization is not anonymity. Published manifests omit direct contributor identity unless the product contract explicitly permits it. Retain an uploader/publisher tombstone when an identity is retired; do not rename all historical objects or cascade-delete a shared release.

Attempt identity is separate from canonical dataset identity. Compatible retries preserve the same bounded batch's dataset URI, media root, clip row set, native contract namespace and checkpoint workspaces. Attempt logs and invocation receipts have unique paths, but each attempt does not copy or replace the Lance table. Native result/checkpoint Parquet is durable before its corresponding canonical publication. Native cleanup after successful publication may remove staging; retain our permanent application receipt.

Initially serialize native mutation across all stages/attempts of a batch, even when they write different result fields. Ray may parallelize within the owning invocation. Curator's field-level/native publisher behavior does not supply a writer lease. The control plane must externally enforce ownership. Before a new invocation receives write access to the stable root, prove the previous writer has terminated **and** its write credentials have expired or been revoked. A DB claim epoch fences API acceptance; it does not stop stale object-store writes. If either condition is uncertain, block takeover or deliberately start a separate new run/root. Sequential recipes inside the same qualified invocation may retain its existing ownership.

An accepted Curator result pins the actual committed dataset version plus row selection, field/result-contract/config digests and the validated publication/checkpoint receipt. Source payloads, existing fragments and input-column meaning remain immutable. Prohibit compaction, row deletion, vacuum/history pruning and data-file rewrite while recovery or a pinned consumer depends on them. A later compatible enrichment may append a new committed version; it does not change an earlier accepted/reviewed version. Keep the referenced data/transaction history reachable.

Acceptance uses a short compare-and-set transaction: current attempt, claim epoch, invocation owner, batch writer ownership, expected input/parent/publication versions and non-cancelled/non-deleted lifecycle must still match. Record the observed commit/receipt and selected artifacts in the same transaction that marks the job accepted. Cancellation winning before that transaction leaves unaccepted writes/versions; a physically committed native result is not automatically approved application state. Compatible recovery reconciles an existing native publication instead of blindly recomputing it.

Non-Curator payloads and manifests use unique immutable object identities, verified SHA-256 and bytes; accept their existing protected references without copying all payloads at every stage. Treat every worker result as untrusted: whitelist provider/bucket/batch-or-artifact scope, bound file counts/bytes, prohibit arbitrary URLs/path traversal, verify hashes/versions and validate referenced dataset closure. Do not treat a mutable `latest` pointer as review evidence. A finite trusted cloud export copies or materializes payloads into a unique protected release root only when access isolation or portable delivery requires it. Verify that final closure/checksums and finish with the corresponding lifecycle/fencing transaction. A Lance manifest alone is not a portable copy when its fragments still reference another root. [Canonical retry/data-flow contract](pipeline-execution-and-data-flow.md)

## Database ownership and authorization

Use application schemas and least-privilege server-side database access. Mobile/web clients reach the selected API, not unrestricted Postgres/PostgREST. If neither hosting variant uses the Supabase Data API, disable it; otherwise expose only deliberately reviewed objects with explicit grants/RLS. Revoke unintended `anon`/`authenticated` access to auth/domain/workflow tables and default grants. Better Auth cookies in the Node variant do not populate Supabase `auth.uid()` automatically. An Edge auth choice must document its actual verified principal and database policy mapping rather than assume equivalent claims.

Use separate database roles for migrations, API and outbox/reconciliation. The migration owner can create tables/extensions. API and outbox/reconciliation processes get only required DML/functions. Worker containers receive no general Postgres connection string. Tenant checks remain mandatory even if RLS is added as defense in depth. If transaction-local tenant context is used for RLS, set it inside every transaction and test connection reuse; session settings are unsafe across a transaction pool.

Avoid session advisory locks for durable coordination. Persist leases and cost reservations as rows and use short transactions. The persistent Node variant can use a direct connection or session pool; Edge/serverless connections need a qualified bounded pooling strategy. Transaction pooling must not depend on session state and requires compatible driver configuration, including `prepare: false` when using postgres-js. Use a separate migration connection. Short API invocations do not hold transactions open during Modal execution or object copying. [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Postgres.js integration](https://supabase.com/docs/guides/database/postgres-js).

## Canonical tables

The following is a logical contract, not a migration already applied. Use UTC `timestamptz` for operational events, integer bytes for sizes and integer nanoseconds for native sensor timestamps. Serialize integers outside JavaScript's exact range as decimal strings.

| Table | Minimum fields and relationships | Required constraints / indexes |
| --- | --- | --- |
| Existing auth tables, Node/Better Auth variant | Better Auth user/session/account/verification | Preserve existing opaque IDs if migrated; Edge identity selection needs an explicit mapping/cutover contract |
| `organizations` | `id`, name, lifecycle state | PK `id` |
| `user_access_state` | `user_id`, suspended/deletion state, changed_by/at | Independent of Better Auth plugin schema; checked on privileged requests |
| `memberships` | `org_id`, `user_id`, role, state | Unique `(org_id,user_id)`; active membership required |
| `projects` | `id`, `org_id`, delivery profile, retention policy | Unique `(org_id,id)` |
| `project_access` | `org_id`, `project_id`, `user_id`, role, active/expiry/revocation | Composite project FK; scoped collector/admin/customer grant |
| `platform_staff` | `user_id`, internal role, active | Internal role is not tenant admin |
| `staff_project_access` | `user_id`, `project_id`, permissions, active/expiry/revocation | Explicit staff project scope |
| `invitations` | digest, target identity/email, proposed grants, expiry, revoked_at, accepted_at | One-time acceptance; verified matching identity |
| `recordings` | `id`, `org_id`, `project_id`, `owner_user_id`, `client_recording_id`, capture schema, sealed logical file inventory/digest, ingest state, retention/deletion state | Unique `(owner_user_id,client_recording_id)`; tenant-consistent project FK |
| `recording_files` | `id`, `recording_id`, file role, generation, provider/bucket/key, expected bytes/hash, server bytes/hash, transfer state, verification state | Unique physical object reference; unique active generation for each required role |
| `upload_sessions` | existing identity fields plus `file_id`, state, frozen part size/count, expected bytes, expiry, storage upload ID | Existing owner/client idempotency preserved; one active session per file generation |
| `upload_parts` | `upload_session_id`, part number, bytes, ETag, receipt source, received_at | Unique `(upload_session_id,part_number)`; replace receipt only for a recorded re-PUT |
| `processing_runs` | `id`, recording, profile/config/schema/code/model digests, declared and verified source-manifest digests, state, requested_by | Immutable input identity; explicit new run for reprocessing |
| `processing_batches` | `id`, run/recording/tenant scope, batch/selection manifest and digest, stable dataset URI/media root, native contract/checkpoint namespace, source/config/model/result-contract digests, frozen clip row-set digest, writer lease/claim/owner, capability expiry/revocation evidence, previous-writer terminal receipt, observed/accepted publication versions and receipts, lifecycle | Unique `(run_id,batch_key)` and canonical root; same-run/tenant FKs; exclusive writer CAS; immutable identity/row set after freeze; retain pinned versions/history |
| `stage_jobs` | run/batch/stage/partition key, state, workflow step key, not_before, attempt limit, expected/observed upstream and accepted dataset versions/receipts, selected artifact manifest, cost class | Unique logical `(run_id,batch_id,stage,partition_key)` where batch applies; ready/retry index; current attempt FK |
| `job_attempts` | job/batch, attempt number, claim epoch, invocation owner, lease, provider call ID, deadline, unique log/scratch prefix, stable batch-root reference, hashed worker capability/expiry, terminal/revocation evidence, result/error | Unique `(job_id,attempt_number)`; immutable attempt identity; indexed expired lease; attempt prefix is not canonical dataset identity |
| `event_outbox` | event ID/type/version, aggregate/run ID, secret-free payload, delivery lease/attempts, delivered_at | Unique logical event ID; pending delivery index; insert in domain transaction |
| `artifacts` | tenant, run/batch/job/attempt, kind/reference type, object provider/bucket/key plus SHA-256/bytes for immutable payloads, or canonical dataset URI plus pinned version/selection/contract digest for Lance snapshots; accepted receipt/state | No caller-supplied arbitrary URLs; unique typed reference including dataset version where applicable; acceptance audit; never hash `latest` as immutable evidence |
| `label_revisions` | recording/run, revision, parent, author, annotation object/hash, taxonomy version | Immutable revisions; optimistic edit version |
| `reviews` | recording/run/batch dataset versions and label revision, reviewer, decision, reason, qualification profile | Append-only; approval tied to exact versions, revision and artifacts |
| `releases` | tenant/project, version, state, frozen manifest/hash, profile, published_by/at | Unique `(project_id,version)`; immutable published selection |
| `release_items` | release, recording/run, label/review revision, artifact references, split | Unique item; no mutable `latest` resolution |
| `release_grants` | release/producer scope, recipient_org_id, optional recipient_user_id, access scope, expiry/revocation | Recipient may differ from producer org; active recipient membership plus grant required; rechecked before URL minting |
| `download_sessions` | release/grant, requester/recipient org, manifest digest, hashed random capability, expiry/revocation, cursor, audit reference | Resumable URL batches; contains no long-lived storage secret |
| `resource_slots` | resource class, holder attempt, claim epoch, state/deadline | Atomic global GPU admission; blocked while execution is ambiguous |
| `budget_reservations` | attempt, currency, upper estimate, settled amount, state | Lock budget row on admission; avoid double reservation |
| `audit_events` | actor, tenant/project, action, target, request ID, redacted details | Append-only app permissions; time/tenant index |
| `deletion_requests` | subject/recording/release, reason, authorization, retention hold, progress | Catalog tombstone precedes physical purge |

All intra-tenant FKs must enforce organization consistency. A release grant deliberately links a producer release to a separate recipient organization: it is not constrained to producer membership. User-specific grants remain bound to their recipient organization; require active membership there as well as the live grant. Staff access requires both active platform_staff and staff_project_access records. A valid `recording_id` alone is not authorization. Use composite references/constraints where practical and explicit joins in every service method. Add external-ID mappings instead of rewriting existing `assets` IDs. Domain provenance FKs must use RESTRICT or an immutable actor tombstone; only auth-owned account/session records may cascade on identity deletion. Replace existing assets/upload user cascades before account deletion is re-enabled.

## State boundaries

| Entity | State contract |
| --- | --- |
| File transfer | `registered`, `uploading`, `uploaded`, `aborted`, `expired` |
| File verification | `pending`, `running`, `verified`, `quarantined` |
| Recording ingest | `awaiting_upload`, `validation_queued`, `validating`, `verified`, `quarantined`, `deleted` |
| Processing run | `queued`, `running`, `blocked`, `succeeded`, `failed`, `cancelled` |
| Stage job | `blocked`, `ready`, `dispatching`, `dispatch_unknown`, `running`, `retry_wait`, `succeeded`, `failed`, `cancel_requested`, `cancelled` |
| Attempt | `created`, `dispatching`, `dispatch_unknown`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled` |
| Internal review | `needs_changes`, `approved`, `rejected`; absence means unreviewed |
| Release | `draft`, `building`, `ready`, `published`, `revoked`, `failed` |

Upload success, processing success, quality qualification, internal approval and customer access are separate fields/entities. Do not overload the existing generic `assets.status` or expose a universal `training_ready=true` boolean.

## Manifest contracts

Every durable JSON manifest has `schema_version`, identifiers, creation time, content digests and relative artifact references. Validate against committed JSON Schema before acceptance. References carry provider/bucket/key, bytes, SHA-256 and media/schema metadata; signed URLs and credentials never enter a permanent manifest.

| Manifest | Required content |
| --- | --- |
| Source ingest | All source file IDs/roles/sizes/client and server hashes; MCAP schema/channel inventory; recorder/geometry version; missing sidecars; structural failures; native clock domains; permitted processing profile |
| Stage result | Run/batch/job/attempt/claim identity; stable dataset/media root and expected/actual committed versions; source/selection/parent/result-contract/config digests; native publication/checkpoint receipt references; immutable artifact hashes; row-level errors; completion state; measured resource usage when available |
| Review package | Pinned dataset versions and selection references; preview and its frame-to-source mapping; compact QC; annotation revision; separate validity/qualification fields; source and processing provenance |
| Release | Frozen episode inventory, exact artifacts and checksums, split/group policy, taxonomy, schema/loader version, allowed uses/attribution, qualification evidence, shard manifest, limitations |

Freeze a declared recording inventory through the seal API. It binds logical file role, expected bytes and content SHA-256; a fresh physical transfer generation can satisfy the same logical content identity after an audited recovery. Changed bytes require a new sealed revision/run. First ingest is admitted only when all required members have uploaded; it establishes server verification.

Keep originals immutable and distinguish raw sensor observations, model estimates and reviewer labels. Capture wall time is optional/untrusted until verified. Native device timestamps must never be interpreted as Unix calendar time. More detailed robotics fields are in [processing](cloud-processing.md).

## Compatibility migration

1. Disable both direct user-delete bypasses until retention-aware deletion is installed. Add new tables and nullable foreign keys without changing existing mobile requests. Preserve `assets` and existing `upload_sessions` data.
2. Create a compatibility mapping from `(user_id,asset_id)` to recording/file. Deterministically map existing client IDs. Backfill legacy rows as **unverified**; an existing storage path is not proof of a completed valid MCAP.
3. Route old and new upload endpoints through one service and one canonical session. Do not run two independent completion paths. The current legacy parser assumes the second key segment is assetId; a new `/orgs/` layout must never pass through that parser. Resolve new IDs from server-held file/session records and reject new-layout paths through the legacy parser. New clients announce an upload protocol version.
4. Enforce new completion, authorization and ingest rules server-side. Legacy clients that cannot satisfy them receive an explicit update-required response; do not bypass verification for compatibility.
5. Deploy internal/customer API readers against new tables. Freeze release snapshots independently of collector account lifecycle.
6. Retire old asset-registration write paths after the minimum app version is enforced and reconciliation reports no active legacy uploads. Keep read mapping for historical data.

Run migrations once through CI/operator tooling with an advisory migration lock compatible with the chosen connection, backup first, and verify a restore. Application instances do not auto-run destructive migrations on startup. Each migration needs a forward recovery path; dropping old tables is a later operation after validation.

## Retention, recovery and deletion

Proposed initial defaults are operational settings, not a customer contract: seven days to abort inactive multipart uploads, seven days for unaccepted attempt-only diagnostic scratch after execution is proven terminal, and thirty days for delivered outbox entries/redacted diagnostic logs. The seven-day scratch rule must never delete a live/recoverable batch's canonical media root, native checkpoints or result workspace. Raw data and published releases have **no automatic age purge** until project retention is explicitly configured. Keep all payloads/fragments/versions required by a review, release or compatible recovery reachable. Native successful-publication cleanup may remove its temporary staging, but permanent application receipts remain.

Use a mark-and-sweep collector. Tombstone the recording/release, revoke new grants/dispatch, enumerate DB references, wait for active writes/issued capabilities to expire, then purge authorized objects and record completion. A job must not resurrect deleted data. Object listing alone is not the reference graph. Failed physical purge remains a retryable deletion task. Backups may retain data for their documented retention; record deletion obligations and replay tombstones after restore.

Do not rely on R2 supporting S3 bucket versioning or Object Lock semantics. Immutable originals/non-Curator objects and protected releases use scoped writers, unique identities, checksums and controlled deletion. Canonical Lance state is versioned under the qualified exclusive writer/recovery protocol; this is not a claim that its entire root is immutable. Evaluate provider-supported retention locks separately. Preserve raw originals until cloud verification and a recovery copy/backup policy have been exercised. Database backups do not contain object payloads.

Supabase Free pauses after inactivity and has limited DB capacity. Use Free for development; budget Pro from $25/month for an operational pilot, with plan/compute/backups verified before deployment. Application catalogs, outbox records and audit logs consume database storage and IO. Inngest has a separate execution allowance. Daily backups are not point-in-time recovery. [Supabase plans](https://supabase.com/pricing), [backups](https://supabase.com/docs/guides/platform/backups).

## Scoped worker credentials

The backend issues task-limited object capabilities. Simple workers can use exact presigned reads/writes. R2 also supports short-lived credentials restricted to one bucket and explicit object/prefix paths; pass the session token through every client. Keep the parent issuer key on the backend, not on phones. A qualified Curator writer receives bounded access to its stable batch run root and necessary native workspaces; other workers get only their unique output/diagnostic prefixes. No processing worker gets write access to published release roots. [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).

Keep raw-original and published-release roots out of the native writer's allowlist. Scope each recipe to the batch's required working media, metadata/checkpoint and new-output paths. Native Curator uses one storage profile; R2 temporary-credential actions can apply to every listed path, so one read-write profile may not express read-only prepared/clip inputs plus writable canonical outputs. Do not invent multi-profile recipe support or claim per-field/per-path action isolation that the selected policy cannot supply.

In that qualified configuration, pinned Curator is a **trusted writer within its scoped batch working namespace** and must honor the immutable existing-media/input-fragment hash contract. The scope blocks raw originals, published releases and unrelated tenants; it does not make every existing working object storage-enforced read-only. If storage-enforced read-only inputs are required, qualify an adapter/provider policy that can express the distinction (for example, an appropriate AWS STS policy with actions scoped to their allowed prefixes), or reject that provider/profile. Do not solve it with a company-wide or raw-bucket key, or by copying the entire Lance dataset on every retry. Verify the actual complete permission set and repeated-write/hash failure tests.

Regranting a stable writable root requires verified termination of the previous invocation and expiry/revocation of **all** its outstanding write capabilities, with a clock-skew margin. Track grants/expiry in batch and attempt records; a database lease/token rotation alone does not revoke signed object requests or temporary storage credentials. Test token propagation through Botocore and Lance/PyArrow; fail qualification if a client silently falls back to broad long-lived credentials. S3 uses corresponding STS/presigned capabilities. No worker receives a general database, customer session or auth secret.

## Implementation targets and acceptance

Create owned domain migrations/contracts and API services for the selected hosting variant. Root `backend/` is the Node/Drizzle variant; Edge/Deno implementation requires its own qualified deployment/identity adapter. The cloned server is read-only protocol reference. Keep worker contracts under root `processing/contracts/`. Exact proposed targets are listed in [implementation plan](../implementation-plan.md).

Required evidence before pilot:

- Cross-tenant foreign keys and queries reject crafted IDs; customer grants cannot enumerate raw objects.
- Two concurrent registrations or retries produce one logical recording/file/session, not overwritten originals.
- A stale claim cannot change an accepted pointer; takeover cannot obtain the stable root until the prior writer is terminal and its write capabilities are expired/revoked.
- A crash after durable checkpoint/result but before native commit recovers the same batch/root and skips qualified saved work; a crash after commit is reconciled without duplicate inference.
- A pinned reviewed dataset version remains readable after later compatible enrichments; compaction/history pruning cannot remove its dependencies.
- A label edit/reprocess leaves a published release's inventory and checksums unchanged.
- Restoring DB plus objects reproduces a release and re-applies revocations/deletion tombstones.
- Byte/time values survive TypeScript, Dart, Python and JSON round-trips without precision loss.
- Provider contract tests cover multipart, signed Range GET, temporary session tokens, canonical Lance commit/recovery, final release export, list pagination and controlled delete.
- Lifecycle cleanup excludes active/ambiguous writers, recoverable native workspaces, pinned dataset history and referenced release objects.

## Decision confidence

Existing PostgreSQL/R2 source integration is evidence only, not a production quality rating. Managed DB/storage/workflow boundaries are design choices. API/auth hosting, full R2/Lance conditional commit and scoped-credential behavior, canonical recovery, long-recording resource bounds, cost per usable recording hour and production restore behavior remain unqualified until tested.
