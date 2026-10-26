# Operations and costs

Selected Render design · updated 2026-10-26 · Owner: platform engineering. Design only; no resources deployed. [Deployment specification](render-deployment.md), [video cost model](video-cost-model.md), [workflow](job-orchestration.md), [storage](storage-and-data-model.md).

## Production services

| Service | Initial proposal | Responsibility |
| --- | --- | --- |
| Next.js public web service | 1 CPU / 2GB RAM, one instance, $25/month | UI, Better Auth and Node/TypeScript API; no media proxy or long-running jobs |
| Render Postgres | 1GB RAM, $19/month; 10GB initial disk budget | Identity, domain catalog, provenance, workflow/outbox and reviews/releases |
| Render Workflow service | Flex; at most 8 application controller leases | Finite orchestration; bounded waits, durable state in Postgres |
| Orchestration cron | Every minute UTC; exits within 45 seconds | Leased outbox delivery, provider reconciliation and due continuations |
| Backup cron | Daily UTC; finite command | Restricted logical database backup to private R2 backup storage |
| R2 | Private raw, derived, release and backup buckets | Direct resumable uploads, canonical datasets and customer downloads |
| Modal | Finite CPU/GPU workers, zero warm containers | Extraction, Curator/custom adapters, independent validation and export |

The two cron services each have a **$1/month minimum**, with active compute billed above that floor. Manual triggering cancels an active cron run; scheduled overlap waits. Work must therefore tolerate interruption and never rely on cron's single-run behavior instead of database claims. The orchestration cron is not a daemon and never waits for a full Modal job. [Cron behavior and pricing](https://render.com/docs/cronjobs)

Use the same Render workspace/region for application, workflow, cron and database. Runtime role-specific connections use private managed PgBouncer; migrations/backups use direct internal connections. Disable public database access. [Storage](storage-and-data-model.md#database-access) specifies exact roles, URLs, TLS and pool budgets. Use graceful HTTP shutdown and bounded transactions; an outage delays control requests while phones retain journals and cloud state remains durable.

Separate local development, staging and production databases, buckets, credentials, callback origins and Modal environments. Within each deployment, use ordinary Render environments with services in the same workspace/region. Do not enable Render's current network-isolated-environment feature for this topology until Workflow private-network support is proven. For a hard staging/production network boundary, use separately budgeted workspaces or a newly qualified supported design. Preview builds receive no production secrets or datasets. Select production regions from rights/residency requirements before real uploads, and reprice any Modal region pinning. Extra paid environments require their own budget.

CI builds pinned immutable revisions. Run reviewed additive migrations explicitly before compatible application/task changes. Never migrate destructively on web startup. Keep old pipeline/model images and compatible task handlers until their runs drain; task definitions and continuation versions are part of the rollout contract. Increase concurrency or replicas only after latency, memory, database and cost measurements. No Kubernetes, separate Redis queue, always-on control worker or warm GPU pool is required initially.

## Prices and budget

USD list rates checked 2026-10-26, before tax/credits. These are planning inputs, not workload measurements or authorization to spend.

| Item | Planning rate |
| --- | --- |
| Render application | 2GB/1CPU web service $25/month |
| Render Postgres | 1GB RAM $19/month; expandable disk $0.30/GB-month |
| Render workspace | Hobby $0 for one infrastructure operator; Pro $25/month for the engineering team |
| Render cron | Two services: at least $2/month total; compute above the minima is extra |
| Render Workflows Flex | $0.20/active vCPU-hour + $0.05/GB-hour RAM; task input/output state $0.25/GB, retained 30 days |
| Render public outbound | $0.15/GB above workspace allowance; media never traverses Next.js |
| R2 Standard | $0.015/GB-month; Class A $4.50/million, Class B $0.36/million; free direct egress |
| Modal GPU-hour | L4 $0.7992; L40S $1.9512; H100 $3.9492; CPU/RAM extra |
| Modal Function CPU/RAM | $0.04716/physical-core-hour; $0.007992/GiB-hour |
| Modal Volumes/egress | Volumes: 1TiB/month included then $0.09/GiB-month; Starter outbound: 1TiB/workspace/month then $0.04/GiB |

Sources: [Render services/workspace](https://render.com/pricing), [workflow rates](https://render.com/docs/workflows-limits), [bandwidth](https://render.com/docs/outbound-bandwidth), [R2](https://developers.cloudflare.com/r2/pricing/), [Modal](https://modal.com/pricing).

The application/database/disk allowance is **about $47/month for one operator or $72 for a Pro team workspace**, before cron/workflow, video storage, processing, transfer, email and backups. This uses $3 as a conservative 10GB database-disk allowance; actual included storage/rounding follows the bill. Reviewer/customer app accounts do not require Render workspace seats. The [video cost model](video-cost-model.md) already includes a $2 scheduling allowance: it covers the two cron floors approximately, **not an additional $2 line or an execution cap**. Task-state usage and cron compute above the floors remain extra.

At 12.5GB raw per recording hour, twice-raw retained bytes and three-month rolling retention, the model estimates **$108/month at 20 hours, $251 at 100 hours and $2,209 at 1,000 hours before optional GPU stages**, using the Pro workspace. Subtract $25 for the single-operator workspace. These include unmeasured CPU/controller/transfer assumptions; backups and ancillary services are additional. Storage continues growing when policy or published releases prevent deletion.

Controllers retain billed RAM while waiting. Resume from Postgres through bounded continuations; do not assume a suspended-wait/checkpoint primitive. Modal bills CPU/RAM at the higher of requested or actual use, and disk requests can increase billed RAM. R2 free outbound does not waive Modal result-upload egress. Region pinning can multiply Modal rates. Confirm actual account credits; do not automatically subtract advertised credits. [Modal resource billing](https://modal.com/docs/guide/resources), [egress](https://modal.com/docs/guide/network-egress-billing), [region pricing](https://modal.com/docs/guide/region-selection)

## Admission and measurement

Configure an approved monthly envelope and a smaller qualification allowance before activation; do not assume the earlier $100 target covers the team scenario. Reserve estimated upper cost atomically, including loading, inference, validation/export, allowed retries, network output and retained data. Hold uncertain usage/reservations until reconciled. Provider alerts and application reservations are not guaranteed billing hard caps.

Start with one global GPU, bounded CPU jobs and no automatic larger-GPU retry. Enable requested, rights-cleared stages after cheap ingest/QC. Profiles must specify upload/source/batch/fragment limits, CPU/RAM/scratch, start/execution deadlines, attempts, controller allowance and per-run ceiling. Unset limits block activation. Reserve database capacity independently of Modal compute and batch writer ownership.

Measure a representative two-hour capture's complete upload size, peak memory/scratch, read/write bytes, startup/inference time, failures/retries, controller consumption, review minutes and **cost per approved recording hour**. Track retained canonical/checkpoint/history bytes separately from disposable logs. Raise limits with evidence rather than assuming recording hours equal worker hours.

## Secrets and observability

| Credential | Holder |
| --- | --- |
| Better Auth/OAuth/email secrets; API database role | Next.js server only |
| Migration/schema-owner URL | Explicit migration job only |
| Control database role | Workflow service and orchestration cron |
| Render dispatch API key | Orchestration cron only; absent from public web and media workers |
| Workflow API token / cleanup-only reconciliation token | Workflow / minute cron respectively; independent verifiers in web, no cross-use for acceptance or grant issuance |
| Modal control token | Workflow controllers and reconciliation cron only; never media workers |
| R2 multipart signing/temporary-grant issuance keys | Next API only, separated by raw/derived/release purpose; controllers/cron coordinate through scoped APIs, and media workers receive only issued grants |
| Backup reader / backup-only R2 writer | Daily backup cron only; no auth, Modal or dispatch token |
| Scoped object grants | Current claimed worker; every issue/renewal tracked |
| Protected release writer / read-only validator | Distinct approved exporter / validator capabilities |
| Model-hub token | Controlled, licensed model-cache preparation |

Use separate service secret sets; an environment group must not distribute migration/backup credentials to every service. Rotate role-specific passwords separately from Render's default database credentials. Redact cookies, signed URL queries, capabilities, raw frames and environment dumps. Next public environment variables contain no secrets.

Logs carry request/run/batch/job/attempt/dispatch/provider IDs, durations, reason codes and observed/accepted versions. Provenance resides in Postgres/immutable receipts, not Render's 30-day task-state retention. Alert on outbox age >5 minutes, uncertain submissions, overdue backup, database/disk/pool saturation, stuck writer ownership, failed verification and budget thresholds 50/80/100%.

## Backups and recovery

Paid Render Postgres provides continuous PITR: **3 days on Hobby, 7 days on Pro**. Recovery creates a new database for isolated validation; the latest ten minutes are outside the selectable restore window. Provider logical exports last seven days and need explicit creation. Free databases lack managed recovery. [Render recovery](https://render.com/docs/postgresql-backups)

Run a daily `pg_dump` logical backup of every application/identity/audit schema into a separate encrypted private R2 backup bucket with **30-day retention**. Use a compatible PostgreSQL client, backup-reader role and backup-prefix-only write credential. Verify success, byte count and checksum; alert after 26 hours without success. Keep a recorded role/grant/migration recipe because an application database dump alone does not restore cluster-level roles. Restrict backup access because sessions and identity evidence are sensitive. Backup bytes/requests and the cron's actual compute are additional usage.

Backups do not contain MCAP, MP4, Lance fragments/history or native checkpoints. Their reference closure must survive catalog restoration. Seven-day attempt cleanup never applies to recoverable checkpoints or pinned dataset history. Apply reference-aware retention and replay deletion/revocation records after recovery; do not resurrect a deleted or revoked delivery.

| Incident | Response |
| --- | --- |
| Web/auth outage | Roll back compatible web revision; preserve phone journals and operation IDs |
| Unknown submission / expired controller lease | Reconcile external calls; block blind resubmission and writer takeover |
| Native writer loss | Keep its workspace; confirm execution termination, all grants retired and accepted writes drained before recovery |
| OOM/image/license failure | Disable profile and diagnose before another bounded attempt |
| R2/Render/Modal outage | Bounded retry; retain outbox/checkpoints; timeout is not success |
| Bad labels/customer grant | Revoke future access/use, retain audit and issue a corrected release |
| Deletion request | Tombstone first; wait for references/holds/writers before purge |

Restore into isolation with admission disabled. Verify object references, pinned history, schema/roles, rights holds and external provider calls before switching all service URLs. Invalidate restored login/download sessions; replay post-recovery-point revocations/deletion tombstones from retained audit evidence. If that evidence is unavailable, keep affected grants disabled until reauthorized. Never restore an old lease as authority to write an active root. Target **15-minute database RPO within PITR and one-business-day RTO**, subject to a measured drill; daily off-provider backups provide a coarser fallback, not equivalent recovery.

Roll out migrations/auth, UI/API with processing disabled, synthetic recovery tests, a permissioned two-hour canary, review/export/full download, then collectors. Optional GPUs have separate gates. Rollback stops new admission and reverts compatible code while retaining schema, recovery state and immutable datasets. Test restore before real collection, after material storage/schema changes and at least quarterly.
