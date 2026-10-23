# Storage and data model

Recommended implementation · 2026-10-23 · Not deployed

Parent: [Technical design](../technical-design.md). This document owns database entities, states, namespaces and retention. [Contracts](../contracts.md) owns serialization/manifests; [auth](auth-and-access.md) owns permissions; [processing flow](pipeline-execution-and-data-flow.md) and [orchestration](job-orchestration.md) own execution.

## Storage boundary

| Store | Contents | Boundary |
| --- | --- | --- |
| Supabase PostgreSQL | Identity/grants, recordings/uploads, workflow/outbox, accepted version references, reviews/releases | Application catalog; clients use our API |
| Lance files in object storage | Curator clip/span rows, media references, result columns and commit history | One dataset per bounded processing batch; no LanceDB server/vector service |
| Private object payloads | MCAP, clips, sensor/frame shards, arrays, native checkpoints, manifests and releases | R2 candidate; S3 fallback after equivalent tests |
| Modal Volume | Pinned model weights | Cache only; no canonical customer dataset |

Native Curator Next recipes require Lance. Custom MCAP/hand adapters need not use Lance internally. Provider-aware object references prevent permanent coupling to R2. R2 qualification must prove conditional Lance commits, recovery, listing, Range/multipart operations and temporary-token propagation; S3 API syntax alone is insufficient. [R2 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

## Entities and constraints

Domain IDs are UUIDs; existing Better Auth user IDs remain opaque text. Operational times use UTC `timestamptz`; sizes/counts/native timestamps use suitable integer columns. Wire encoding and digest rules are defined in [contracts](../contracts.md).

| Entity | Required identity/data | Integrity rule |
| --- | --- | --- |
| `user`, `session`, `account`, `verification` | Qualified Better Auth schema | Preserve migrated IDs/provider associations; no domain-role fields editable through profiles |
| `user_access_state` | User, suspension/deletion state, changed-by/time | Current eligibility checked server-side |
| `organizations` | ID, name, lifecycle | Tenant boundary |
| `memberships` | Organization, user, role/state | Unique organization/user |
| `projects` | ID, organization, profile/retention policy | Unique organization/ID |
| `project_access` | Organization/project/user, role, expiry/revocation | Project and membership match organization |
| `platform_staff`, `staff_project_access` | Staff role/state; user/project permissions/expiry | Active role AND assignment required for project data |
| `invitations` | Secret hash, verified recipient, proposed scope, issuer, expiry/revocation/acceptance | Transactional one-time claim |
| `recordings` | Owner/project, client ID, capture schema, sealed inventory/digest, rights policy/scope/evidence, ingest/deletion state | Unique `(owner_user_id,client_recording_id)`; owner/project frozen at upload |
| `recording_files` | Recording/role/segment, generation, object reference, expected/observed bytes/hash, transfer/verification | Unique physical object; one active generation per role/segment |
| `upload_sessions` | Owner/client upload ID, file generation, provider upload ID, plan/expiry/state, blocked reason/resume state, operation lease | Unique `(owner_user_id,client_upload_id)`; one active session per generation |
| `upload_parts` | Session/part number, bytes, exact ETag, receipt source/time | Unique session/part; replacement requires recorded re-PUT |
| `processing_runs` | Recording OR release target, source/selection/code/image/model/config digests, rights policy/scope/evidence, state/requester | Exactly one target; changed inputs/config create new run |
| `processing_batches` | Recording run/batch key; stable dataset/media/checkpoint roots; source/config/result-contract/selection digests; frozen row-set digest; writer/lease/epoch; capability/termination and quiescence-generation evidence; observed/accepted versions/receipts | Unique run/batch key and root; same tenant/run; one writer |
| `stage_jobs` | Run, optional batch, stage, partition key, workflow step, current attempt, expected parent refs, accepted result, retry/deadline | Explicit dedup indexes below |
| `job_attempts` | Job, number, epoch, invocation owner, provider call, deadline/lease, token hash/expiry, batch reference, unique log root, outcome | Unique job/attempt number; index expired leases |
| `storage_write_grants` | Attempt/owner/root, monotonically increasing grant generation, provider identifier/fingerprint, allowed actions/paths, issued/expiry/revocation and drain evidence | Record every issue/renewal before release to a worker; no plaintext secret; barrier covers all grants for that root/generation |
| `event_outbox` | Event ID/type/version, aggregate/run, secret-free payload, delivery lease/attempts/time | Unique logical event; inserted with domain change |
| `artifacts` | Scope/kind; immutable object+hash/bytes OR dataset URI+version/selection/contract digest; acceptance receipt | Typed references; no arbitrary client URLs or mutable `latest` |
| `label_revisions` | Run, parent/revision, author, annotation hash, taxonomy | Immutable; optimistic edit checks |
| `reviews` | Run/batch versions, labels, reviewer, decision/profile/reason | Append-only; exact evidence references |
| `releases` | Producer/project/version, frozen items/manifest hash, rights policy/scope/evidence, lifecycle, publisher/time | Unique project/version; published selection immutable |
| `release_items` | Release, recording/run, dataset versions, artifact/label/review IDs, split | Exact selection; no `latest` lookup |
| `release_grants` | Release, recipient organization, optional recipient user, scope/expiry/revocation | Recipient may differ from producer; live recipient membership required |
| `download_sessions` | Requester/recipient/grant/release/manifest, capability hash, expiry/revocation | Delegated release-only access |
| `resource_slots`, `budget_reservations` | Resource/attempt/epoch; reserved/settled cost and lifecycle | Atomic admission; compute slot separate from batch writer |
| `audit_events`, `deletion_requests` | Attributable redacted events; authorized subject/scope, holds/progress | Append-only audit; deletion tracked before purge |

Make `partition_key` non-null, including an explicit default for unpartitioned work. Use separate partial unique indexes: `(batch_id,stage,partition_key)` for batch jobs; `(run_id,stage,partition_key)` where `batch_id IS NULL` for run jobs. An ordinary unique key containing nullable batch ID does not deduplicate run jobs. Batch references must match the job's run.

Release export has a release-targeted run and run-level job; recording batches belong only to recording-targeted runs. Enforce the target discriminator/check constraint. Intra-tenant composite foreign keys enforce project consistency. Recipient grants deliberately cross producer-to-recipient scope. Role semantics live in [auth](auth-and-access.md).

Idempotent replay must match original organization/project/assignment and content identity; changing scope under the same owner/client ID returns conflict. Domain provenance foreign keys use `RESTRICT` or immutable actor tombstones; only auth-owned sessions/accounts cascade on identity deletion. Keep compatibility mappings from `(legacy_user_id,asset_id)` rather than rewriting historical keys.

Freeze `rights_policy_revision`, permitted collection/processing/export scope and evidence references on recordings, runs and releases. Later policy changes do not silently expand permitted use. A collector checkbox or model license alone does not establish third-party/private-video rights. Publication checks the frozen policy/evidence and current withdrawal/hold decisions. Evidence may reference restricted immutable artifacts; customer manifests disclose only permitted summaries.

## State enums

| Entity | States |
| --- | --- |
| File transfer | `registered`, `uploading`, `uploaded`, `aborted`, `expired` |
| File verification | `pending`, `running`, `verified`, `quarantined` |
| Upload session | `initializing`, `ready`, `uploading`, `completing`, `completed`, `cancel_requested`, `cancelled`, `expired`, `blocked` |
| Recording ingest | `awaiting_upload`, `validation_queued`, `validating`, `verified`, `quarantined`, `deleted` |
| Processing run | `queued`, `running`, `blocked`, `succeeded`, `failed`, `cancelled` |
| Batch | `planning`, `processing`, `ready`, `blocked`, `retired` |
| Stage job | `blocked`, `ready`, `dispatching`, `dispatch_unknown`, `running`, `retry_wait`, `succeeded`, `failed`, `cancel_requested`, `cancelled` |
| Attempt | `created`, `dispatching`, `dispatch_unknown`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled` |
| Review | `needs_changes`, `approved`, `rejected`; absent means unreviewed |
| Release | `draft`, `building`, `ready`, `published`, `revoked`, `failed` |

Upload-session state describes provider/control progress; file transfer describes observed byte-transfer progress. Reconciliation is a leased `operation: reconcile`, not a session state; retain the existing state until its result is known. `blocked` preserves progress and a reason/resume state. `completed` requires verified provider completion and maps the file to `uploaded`; `cancelled` requires confirmed abort/cleanup and maps it to `aborted`. Initialization/readiness do not certify uploaded bytes.

Transfer completion, source verification, accepted processing, internal approval and publication are separate facts. Do not introduce a universal `training_ready` flag. Transitions require conditional updates and the owning component's validation.

## Namespaces and immutability

Use environment-specific private raw, derived and release buckets. Disable public URLs. Storage keys start with immutable user ID for namespace continuity; permission always comes from database grants.

Let `R` denote `{userId}/orgs/{orgId}/recordings/{recordingId}`:

| Data | Key/root |
| --- | --- |
| Original/generation | `R/raw/{fileId}/source.mcap` and separate allocated sidecar keys |
| Stable Curator batch | `R/runs/{runId}/batches/{batchId}/`, including native `lance`, media and recipe-owned workspaces |
| Attempt-only logs/scratch | `R/runs/{runId}/attempts/{attemptId}/` |
| Immutable custom output | `R/runs/{runId}/artifacts/{artifactId}/` |
| Protected release | `{publisherUserId}/orgs/{orgId}/releases/{releaseId}/versions/{version}/` |

Verified original keys cannot be reopened/reused; replacements allocate a new generation. Canonical sources/sidecars use consumed multipart IDs, including one-part multipart, or staging followed by verified protected finalization. A reusable single-PUT URL can overwrite until expiry; HEAD/hash does not revoke it.

Custom artifacts have immutable identities, SHA-256 and bytes. Native Curator is versioned: compatible retries reuse the same batch dataset/media/contract/checkpoint namespace. Durable results precede native publication. Attempts identify invocation/logs/accounting, not replacement datasets. Do not copy Lance/media at every stage or retry.

Initially serialize all native batch writers. Before granting a replacement invocation the stable root, prove previous execution terminated **and every outstanding write capability expired/revoked**, including clock-skew margin. Reconcile in-flight writes and provider read visibility too; expiry alone does not cancel requests already in progress. If uncertain, block or explicitly create a separate run; a DB epoch alone cannot stop storage writes.

Pinned Curator is trusted within its scoped working namespace. Its one R2 read-write profile may apply actions to every listed path, so it cannot be advertised as read-only-input/field-level isolation. Exclude raw originals, releases and unrelated tenants; verify immutable existing-media/input hashes. A later authorized batch writer still has working-namespace privileges and must preserve old input/fragment hashes; a prior validation barrier does not make those files storage-enforced read-only. If storage-enforced action separation is required, qualify an adapter/provider policy that supports it or reject the profile. Never invent multi-profile support or fall back to broad long-lived credentials. [Temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)

Preserve source payloads, existing fragments/input meaning, frozen row sets and required transaction history. No compaction, row deletion, data-file rewrite or history pruning during recovery/pinned use. Later compatible enrichment adds versions without changing prior accepted evidence.

## Acceptance and reference lifetime

Before validation, stop write-credential renewal and establish a recorded **quiescence barrier**: producer execution terminal, all its write capabilities retired, outstanding writes reconciled and candidate objects/commit visible through provider readback. Hold the batch ownership lease through validation and acceptance so another writer cannot invalidate the check. Record the barrier and write-grant generation; any renewed write authority invalidates validation and requires a new barrier/check. Compute capacity may be released once execution is terminal, independently of this lease.

A finite **read-only trusted Modal CPU validator** checks that barrier/generation, actual publication/checkpoint receipts, committed dataset versions, exact source/parent/selection/config/result-contract references, row errors and complete referenced objects. It bounds counts/bytes and rejects foreign prefixes/arbitrary URLs. Custom objects additionally require hash/size verification. No media hashing or closure traversal on the API host.

After validation, one short API transaction compares current job/attempt, claim epoch, invocation owner, batch writer, unchanged expected parent/input refs, observed publication version and the validated quiescence/write-grant generation, plus active recording/run/job lifecycle. It selects accepted references and marks success atomically. Cancellation/deletion winning first rejects late acceptance. An existing native commit is reconciled, not automatically approved or recomputed. [Orchestration](job-orchestration.md) specifies execution/retry details.

Reviews pin dataset versions, selections, artifacts and labels. Export materializes the approved delivery into a protected root once when required; it cannot retain hidden scratch/expiring dependencies. Exporter output requires the same terminal/grant-retirement/drained-write barrier before independent validation. Hold its destination reservation through validation/publication; never reissue writes against a published prefix. Publication rechecks that barrier/generation, frozen selection/digest, current internal authority, rights and ready/non-revoked lifecycle. Signed customer URLs may expose pseudonymous prefixes; use logical file IDs/relative paths and omit direct contributor identity unless permitted.

## Database access, retention and migration

Use separate migration, API and control-worker roles; no processing-worker database URL. Disable unused Supabase Data API and revoke unintended/default `anon`/`authenticated` grants. Better Auth sessions do not populate `auth.uid()` in direct SQL. Bound pools/TLS; transaction pooling needs compatible driver settings (`prepare: false` for postgres-js), transaction-local context and no session-lock dependence. [Connections](https://supabase.com/docs/guides/database/connecting-to-postgres)

Proposed retention: seven days for inactive multipart cleanup and terminal attempt-only diagnostic scratch; thirty days for delivered outbox/redacted logs. Never apply that scratch rule to canonical roots, recoverable checkpoints, unpublished durable results or pinned versions/history. Native successful cleanup may remove its staging; retain permanent application receipts. Raw/release age purge requires explicit project policy.

Deletion marks catalog state, blocks new grants/dispatch, resolves references/holds and waits for active writers/capabilities before physical purge. Retry failures; retain an audit/tombstone and replay deletions/revocations after restore. Backups do not contain object payloads. Preserve both referenced objects and required Lance history/checkpoints in restore exercises.

Implement additive migrations under `backend/src/db/`. Disable direct-delete bypasses first; backfill legacy data as unverified through canonical upload adapters. Never pass new `/orgs/` keys through the legacy second-segment asset parser or accept fresh untracked uploads after DB errors. Apply migrations once with backup/restore evidence; do not auto-migrate destructively on startup.

Acceptance covers nullable-key dedup, cross-tenant constraints, exact parent/version CAS races, native checkpoint/commit recovery, safe writer takeover, immutable reviewed versions, source/sidecar overwrites and restore with reference-aware cleanup.
