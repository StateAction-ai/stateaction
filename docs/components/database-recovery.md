# Database restore and operational recovery (SA-46)

How to recover the catalog database into isolation, decide what may be trusted,
and re-enable service **without** restarting uncertain work or reopening revoked
access. **Nothing here creates, restores or bills a managed resource.** The
managed-Postgres drill is an operator action that has not been run; the local
drill (below) is a source-level rehearsal only and is not evidence of it.

Status of this document: the runbook is the contract. The read-only verifier
(`restore-check`) and the local drill are described under
[Local drill](#local-drill-simulation); neither is evidence of a managed restore.

## What a database restore can and cannot recover

| Recovers                                                            | Does **not** recover                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Catalog rows (recordings, files, jobs, clips, reviews, datasets)    | Object payloads in R2/SeaweedFS. A deleted or overwritten object stays gone    |
| Immutable evidence rows (ingest permissions, execution evidence)    | Anything written after the restore point (the **gap**)                         |
| Migration ledger (`platform_schema_migrations`, checksums)          | Provider state: Render workflow runs, Modal calls, in-flight multipart uploads |
| Roles/grants **as rows** (`access`, `dataset_access`, capabilities) | The fact that a grant/session was revoked or a job finished _after_ the point  |

A restored row is a claim about the past. Every row that grants access or says
"work is in progress" is **unreconciled** until checked against the outside.

## Invariants

1. Restore only into a **new, isolated** database/instance. Never restore over
   the live database; never write to it during a drill.
2. Ingest, dispatch, repair cron and workflow controllers stay **off** on the
   restored database (no service points at it; `ipAllowList: []`; no controller
   or cron capability is configured) until every gate below is closed. The
   repair pass and `flagUncertain` would otherwise act on stale `submitting`/
   `running` rows.
3. Immutable sources and accepted artifacts are never deleted, overwritten or
   age-purged by recovery or rollback. Recovery never invents a termination
   proof, rewrites an `execution_deadline` or releases the admission slot
   without genuine `job_execution_evidence`.
4. Backups and dumps contain credentials hashes, sessions and tokens: handle as
   secrets, never commit, never paste into tickets, delete after the drill.

## Restore window and gaps (record real values, never assume)

Record in the receipt, from the provider and the drill, not from this page:

- backup type and **restore point timestamp** (snapshot, or PITR target);
- **RPO gap** = `incident_time − restore_point`; list what was written in it
  (uploads sealed, jobs admitted/finished, grants revoked) from the live DB if it
  is still readable, otherwise from R2 listings, Render/Modal run history and the
  audit trail;
- **measured RTO**: request → restored instance reachable → schema/checksum
  verified → object verification done. Times come from the run, per phase;
- backup retention/PITR window actually configured on the plan (an external
  fact; unknown until read from the dashboard).

The Render plan's retention and PITR window are provider settings that this
repository does not control or know. Do not state them here until read.

## Runbook

### 0. Contain

Stop writers first: disable web ingest and dispatch (Blueprint/env, not code),
pause the repair cron and workflow controller. Record who and when. Do not
delete anything in R2 or the live database.

### 1. Restore into isolation

Create a **new** managed Postgres from the chosen backup/PITR target (or, for a
logical dump, `pg_restore --no-owner --role=<migration_owner> -d <new_db>`).
Keep it unreachable by services. Then, as the migration owner:

1. confirm `platform_schema_migrations` versions and checksums equal the
   deployed source (`hosted:migrate` is idempotent and re-applies grants only;
   a checksum mismatch stops here);
2. re-apply least-privilege grants (`stateaction_grant_*` through `hosted:migrate`)
   instead of trusting restored ACLs; verify the app role has no superuser,
   create-role or bypass-RLS attribute.

### 2. Verify catalog and private objects

Read-only, bounded, against the isolated copy:

- every `files` row that is `completed`/`verified` and every file referenced by
  `recordings.source_manifest_*`, `jobs.result_manifest_*` and accepted
  `clips` has its object read **in full** (finite size from the row, deadline,
  streaming SHA-256) and compared with `files.sha256` and `size_bytes`;
- classify each: `match`, `missing` (payload gone: **not recoverable from the
  database**), `size_mismatch`, `sha_mismatch`, `unread` (store unavailable).
  Only `match` is verified. `missing`/mismatch stays reported, never "fixed" by
  editing rows;
- DDL: the only `NOT VALID` constraints are the two `jobs` CHECKs migration 007 declares
  (`jobs_admission_complete`, `jobs_claim_complete`); any other blocks, because
  matching migration checksums does not prove the restored catalog DDL is unchanged;
- referential integrity: all foreign keys validate; sealed recordings have
  their manifest file; accepted candidates have verification rows.

### 3. Reconcile external state (blocks re-enable)

| State restored from the past                                                                                                                      | Reconcile against                                                                                                              | Rule                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jobs not in `succeeded`/`failed`/`cancelled` (`submitting`, `submit_unknown`, `running`, `result_pending`, `needs_attention`, `cancel_requested`) | Render workflow run and Modal call status, read out of band with the provider's own tools, plus the worker's last output in R2 | Provider is the authority. Record genuine evidence only through the existing guarded paths (`job-recovery`, execution evidence). Unknown stays unknown; `cancelled`/retry only after exact termination. Never restart blindly                                                                                         |
| `files` in `uploading`/`completing` with a `provider_upload_id`                                                                                   | List multipart uploads and objects in R2                                                                                       | An upload completed or aborted after the restore point is unknown to the DB. Re-run the transport reconcile path; do not assume a part list                                                                                                                                                                           |
| Better Auth `session`, `verification`, `account` tokens                                                                                           | The identity provider/policy                                                                                                   | Sessions are bearer state and resurrect logged-out or revoked users. **Delete all sessions and verification rows on the restored copy** before any service connects; users sign in again                                                                                                                              |
| `access.enabled`, `dataset_access.enabled`, `ingest_permissions.status='active'`, unexpired `service_capabilities`                                | The out-of-band record of revocations since the restore point (live DB diff if readable, audit trail, tickets)                 | Default is fail-closed: a restored active grant or capability **not** in the operator's reconciled list stays blocked. Revoke through the existing guarded paths (`dataset-sharing`, `ingest-permission`, capability revoke). Rotate every service capability and job bootstrap token; never re-enable by bulk-update |
| `dispatch_admission` slot holder                                                                                                                  | `job_execution_evidence`                                                                                                       | Slot is released only by genuine evidence. Never clear it by hand                                                                                                                                                                                                                                                     |

### 4. Re-enable (all gates, in order)

1. catalog and object verification clean, or every exception ticketed and
   accepted (missing payloads are data loss and are reported as such);
2. external jobs/uploads reconciled and recorded;
3. sessions cleared; grants/capabilities reconciled and rotated;
4. point services at the restored instance (new `DATABASE_URL`, rotated secrets);
5. enable read paths first, then ingest, then dispatch. Dispatch last, one job.

The automated verifier can show that 1 is clean and list what blocks 2 and 3.
It never declares the system ready: the external gates are an operator decision.

## Deployment rollback

Application rollback (Render redeploy of an earlier commit) does not undo
migrations. Migrations are forward-only; a rollback target must be compatible
with the current schema. Rolling back the app or restoring the DB never deletes
sources or accepted artifacts, and no `files` row is removed to "match" storage.
Roll the database back only through the restore procedure above, and expect the
same unreconciled-state gates.

## Retention

No retention job or purge exists. Original sources, accepted outputs and
anything referenced by a recording, clip, dataset or published manifest are
retained and are **never** treated as scratch or purged by age. Only unreferenced
scratch (for example an abandoned `reserved`/`expired` upload with no completed
object) may be cleaned, by a separately reviewed change that keys on catalog
state, not object age. Any retention policy needs its own ticket.

## Local drill (simulation)

`pnpm --filter @stateaction/server restore-check` verifies a restored copy; the
integration test `test-integration/restore-drill.test.ts` rehearses the whole
path. The database comes only from `RESTORE_CHECK_DATABASE_URL` and is refused
when its host:port/name equals any live identity the process can see
(`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `DATABASE_HOST`/`PORT`/`NAME`). That is a
wrong-database guard only; the report states how many identities were compared
and never asserts network or instance isolation. Failures print fixed messages,
never a URL, host or credential. Objects are read through the `S3_*` settings (GET,
streamed SHA-256, bounded files, bytes, per-object and total time). The report
always has `readyToReenable: false` and the open manual gates; an
`--expected-grants` file is offline operator input and can only add blockers.
Bounded rehearsal on the loopback
Postgres and SeaweedFS fixtures: a synthetic catalog (source, accepted output,
a grant revoked after the dump, an uncertain job) is dumped with `pg_dump` and
restored with `pg_restore` into a **new** database; the verifier hashes the
referenced objects, reports the stale grant and the unresolved job, and
records phase timings. The live fixtures' own databases are not written.

It establishes: the dump/restore mechanics and timings **on this machine**, the
verifier's classification logic, that restored revocation gaps are detected, and
that the guarded paths refuse unproven recovery. It does **not** establish:
managed backup or PITR availability, real restore time or size, Render/R2/Modal
behaviour, provider-side job state, real session invalidation, network isolation
of a managed instance, or R2 checksum/versioning semantics. Those need the
authorized managed drill, whose receipt is kept on the ticket.
