# Storage and data model

MVP design · updated 2026-10-31 · Not implemented or deployed.

Parent: [technical design](../technical-design.md). [Contracts](../contracts.md) owns wire/manifests; [uploads](mcap-upload.md) and [jobs](job-orchestration.md) own operations.

## Ten planned domain tables

Nine domain tables support the current browser/review scope; `releases` is a follow-up Dataset-version contract. Keep Better Auth's identity/session/account tables separately. No organization hierarchy is needed; none of this schema is implemented yet.

| Table | Minimum contents and constraint |
| --- | --- |
| `access` | User ID, role (`collector`, `staff`, `customer`), enabled; unique user/role; operator-managed |
| `recordings` | ID, immutable owner/client capture ID, source manifest/hash, state, `currentJobId`, deletion marker; unique owner/client ID |
| `files` | Source/output/export purpose, recording or release, optional job, never-reused key, expected/observed bytes, SHA-256, persistent clientUploadId/requestDigest for sources, current transport epoch/key/multipart ID/plan/state; unique (recordingId,clientUploadId), current key and provider upload ID |
| `jobs` | Kind, recording XOR release, `previousJobId`, state/controller lease, workflow run reference, submission intent, execution call ID, invocation nonce/token hash, deadlines, result manifest/hash, error/timestamps; one row per intentional processing/export attempt |
| `clips` | Immutable UUID, processing job, ordinal, friendly default display title, duration/source bounds/frame-map reference, safe screenshot/RRD file FKs; unique (jobId,ordinal); files must be completed same-job outputs |
| `reviews` | Exact successful job/manifest/clip ID, reviewer, task label/notes, approved/rejected decision, revision/time; append-only decisions; unique (jobId,clipId,revision) and locked expected-revision append |
| `datasets` | UUID, name, optimistic revision, actor/timestamps; mutable working grouping, not a copy of its media |
| `dataset_clips` | Dataset/clip FKs; primary key (datasetId,clipId); many-to-many membership |
| `dataset_access` | Dataset/user FKs, enabled, operator/time and external-review permission evidence reference; unique (datasetId,userId); customer view grant |
| `releases` — follow-up | Dataset ID/name/revision, frozen references for **all** approved members, export job, archive/manifest hashes, publication state and actor/time; user-facing Dataset version |

Files covers collector uploads **and** worker/export outputs. Bound inventories; keep frame-level arrays in object storage. Reviews pin exact revisions; new jobs never replace approvals. Retry inserts a new job/prefix and conditionally updates `currentJobId` or export job. Preserve old rows for diagnosis.

Insert the validated clip catalog atomically with job acceptance. An idempotent replay returns the same IDs; it cannot repoint an existing clip. Reprocessing creates new clip IDs. Direct catalog lookup avoids scanning manifests or treating a file ID as a clip. [Shared viewer](rerun-clip-review.md)

Clip identity covers fixed media, observations and timelines. Task labels are review metadata. Current customer access requires an enabled customer role, live `dataset_access`, current membership and the clip's **latest review to be approved**. Evaluate membership/latest decision together; a later rejection or removal blocks new access through that working Dataset. Counts/hours include only visible distinct clips. Do not require the job to equal `recordings.currentJobId`.

Name/membership changes lock the Dataset and check `expectedRevision`, then increment its revision. Membership never copies files. Future Dataset versions freeze the Dataset revision plus **every member's** approved review/label; unreviewed/rejected members block export until reviewed or removed. Published versions require publication and a live Dataset grant, keep named frozen contexts and never retarget when working membership changes. [Data browser](data-browser-and-datasets.md)

Job states: `queued`, `submitting`, `submit_unknown`, `running`, `result_pending`, `succeeded`, `failed`, `cancel_requested`, `cancelled`, `needs_attention`. State changes are conditional API transactions. Workflows orchestrate; Postgres preserves durable job/output references. Expired controller ownership permits monitoring recovery, not another Python execution. No outbox, dispatch ledger or stage DAG is needed. [Job protocol](job-orchestration.md)

## Objects and sealed uploads

Use private environment-specific R2 buckets; MinIO is the local development substitute. Logical source identity is stable. An unfinished source transport may restart with a new epoch/key only after old provider operations are reconciled and the old MPU is retired; completed keys are never reused. Each job writes under a unique job prefix; each export uses a new unpublished prefix. No shared writable dataset, Lance history or checkpoint takeover is needed.

For **every file, including small JSON**, the API allocates the key and multipart ID. Workers/phones receive bounded part URLs. The API completes that recorded upload; completion consumes its ID. It never reopens a completed key or supplies reusable whole-object PUT URLs/broad worker credentials. Replacements get new keys. Track parts through recorded receipts/provider `ListParts` rather than a new table.

The worker computes hashes and runs inline content/QC checks. API completion checks the expected object/key/size and bounded inventory, not media bytes. Sealing pins the manifest/hash, requires every declared file completed and prevents further uploads for that job. Success additionally requires known execution termination and current lifecycle checks. Qualify provider completion/replay behavior before pilot; metadata alone is not independent model verification.

Published archives reference only closed completed files. Never grant another writer to a published key. Corrections create another release. Customers receive approved portable outputs, not raw MCAP by default.

Each clip's required viewer artifact is one immutable, customer-safe RRD shared by both roles. Retain it while working membership, review or published-version references need it. Internal QC, notes, contributor identities, raw paths and internal provenance stay outside the RRD. Hiding entities is not access control. A future training TAR can omit RRD explicitly: MP4, arrays, masks, mappings and labels remain independently readable.

## Database access

Use paid Render Postgres 17 beside the web service in the same workspace/region. Only Next holds `API_DATABASE_URL`, using an explicit least-privilege application role and a bounded pool of five. Migrations use a separate direct owner URL in a controlled invocation. Workflows, cron and Python workers use APIs, never database credentials.

Disable external database access. Require internal TLS with the supported driver equivalent of `sslmode=require`; Render's internal certificates are self-signed. No extra pooler is needed for the initial single web instance. [Render connections](https://render.com/docs/postgresql-creating-connecting)

Use provider PITR initially and perform a restore drill. Preserve object references; database recovery does not restore deleted media. Staff handles retention/deletion manually: revoke access first, preserve referenced releases, resolve active jobs/uploads, then remove eligible objects. No automatic purge or cascading domain deletion ships in the pilot.
