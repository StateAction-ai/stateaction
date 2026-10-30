# Storage and data model

MVP design · updated 2026-10-30 · Not implemented or deployed.

Parent: [technical design](../technical-design.md). [Contracts](../contracts.md) owns wire/manifests; [uploads](mcap-upload.md) and [jobs](job-orchestration.md) own operations.

## Seven domain tables

Keep Better Auth's identity/session/account tables separately. No organization hierarchy is needed.

| Table | Minimum contents and constraint |
| --- | --- |
| `access` | User ID, role (`collector`, `staff`, `customer`), enabled; unique user/role; operator-managed |
| `recordings` | ID, immutable owner/client capture ID, source manifest/hash, state, `currentJobId`, deletion marker; unique owner/client ID |
| `files` | Source/output/export purpose, recording or release, optional job, never-reused key, expected/observed bytes, SHA-256, persistent clientUploadId/requestDigest for sources, current transport epoch/key/multipart ID/plan/state; unique (recordingId,clientUploadId), current key and provider upload ID |
| `jobs` | Kind, recording XOR release, `previousJobId`, state/controller lease, workflow run reference, submission intent, execution call ID, invocation nonce/token hash, deadlines, result manifest/hash, error/timestamps; one row per intentional processing/export attempt |
| `reviews` | Exact successful job/manifest/clip ID, reviewer, task label/notes, approved/rejected decision, revision/time; append-only decisions; unique (jobId,clipId,revision) and locked expected-revision append |
| `releases` | Frozen approved review references, export job, archive/manifest references and hashes, state, actor/time |
| `release_access` | Release/user, enabled; unique release/user |

Files covers collector uploads **and** worker/export outputs. Bound inventories; keep frame-level arrays in object storage. Reviews pin exact revisions; new jobs never replace approvals. Retry inserts a new job/prefix and conditionally updates `currentJobId` or export job. Preserve old rows for diagnosis.

Job states: `queued`, `submitting`, `submit_unknown`, `running`, `result_pending`, `succeeded`, `failed`, `cancel_requested`, `cancelled`, `needs_attention`. State changes are conditional API transactions. Workflows orchestrate; Postgres preserves durable job/output references. Expired controller ownership permits monitoring recovery, not another Python execution. No outbox, dispatch ledger or stage DAG is needed. [Job protocol](job-orchestration.md)

## Objects and sealed uploads

Use private environment-specific R2 buckets; MinIO is the local development substitute. Logical source identity is stable. An unfinished source transport may restart with a new epoch/key only after old provider operations are reconciled and the old MPU is retired; completed keys are never reused. Each job writes under a unique job prefix; each export uses a new unpublished prefix. No shared writable dataset, Lance history or checkpoint takeover is needed.

For **every file, including small JSON**, the API allocates the key and multipart ID. Workers/phones receive bounded part URLs. The API completes that recorded upload; completion consumes its ID. It never reopens a completed key or supplies reusable whole-object PUT URLs/broad worker credentials. Replacements get new keys. Track parts through recorded receipts/provider `ListParts` rather than a new table.

The worker computes hashes and runs inline content/QC checks. API completion checks the expected object/key/size and bounded inventory, not media bytes. Sealing pins the manifest/hash, requires every declared file completed and prevents further uploads for that job. Success additionally requires known execution termination and current lifecycle checks. Qualify provider completion/replay behavior before pilot; metadata alone is not independent model verification.

Published archives reference only closed completed files. Never grant another writer to a published key. Corrections create another release. Customers receive approved portable outputs, not raw MCAP by default.

## Database access

Use paid Render Postgres 17 beside the web service in the same workspace/region. Only Next holds `API_DATABASE_URL`, using an explicit least-privilege application role and a bounded pool of five. Migrations use a separate direct owner URL in a controlled invocation. Workflows, cron and Python workers use APIs, never database credentials.

Disable external database access. Require internal TLS with the supported driver equivalent of `sslmode=require`; Render's internal certificates are self-signed. No extra pooler is needed for the initial single web instance. [Render connections](https://render.com/docs/postgresql-creating-connecting)

Use provider PITR initially and perform a restore drill. Preserve object references; database recovery does not restore deleted media. Staff handles retention/deletion manually: revoke access first, preserve referenced releases, resolve active jobs/uploads, then remove eligible objects. No automatic purge or cascading domain deletion ships in the pilot.
