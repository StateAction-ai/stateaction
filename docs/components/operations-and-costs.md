# Operations and costs

Updated: 2026-10-26. Owner: platform engineering. Node/AWS deployment and prices below are a reference option; [current hosting evaluation](hosting-evaluation.md) compares Next.js/Render and leaves API/workflow selection open. Detailed protocols: [workflow](job-orchestration.md), [storage](storage-and-data-model.md).

## Deployment

If selecting the Node/VM option, run the API and a supervised outbox/reconciliation process on the host. Next.js hosting is selected separately or deliberately co-located. Use TLS, pinned patched Node, bounded database pools, health/readiness and graceful shutdown. The host performs no extraction/inference. A 2GB host is a qualification candidate. An outage delays control requests; phones retain journals and completed cloud work remains durable.

Separate development, staging and production databases/buckets/credentials/Modal/Inngest environments. CI builds immutable artifacts; deploy additive migrations before API/UI changes. Keep old worker/pipeline revisions until active runs drain. Select production regions from project rights/residency requirements before real uploads. Additional paid environments need separate budgets.

Scale processing by independent batches. Raise concurrency after measured sizing/cost; add API replicas or separate the control process when latency/availability requires it. DB claims coordinate replicas. Initial deployment needs no Kubernetes, extra scheduler or warm GPU pool.

## Prices and budget

USD list rates checked 2026-10-23, before tax and credits; not throughput measurements or authorization to spend.

| Item | Planning rate |
| --- | --- |
| API host | Lightsail Linux/public IPv4 2GB example: $12/month |
| Supabase Postgres | Pro from $25/month; compute credit covers one Micro |
| Inngest | Free: 50k executions/month and five concurrent steps; Pro from $99/month |
| R2 Standard | $0.015/GB-month; Class A $4.50/million requests; Class B $0.36/million; free direct egress |
| Modal GPU-hour | L4 $0.7992; L40S $1.9512; H100 $3.9492; CPU/RAM extra |
| Modal Function CPU/RAM | $0.04716/physical-core-hour; $0.007992/GiB-hour |
| Modal Volumes/egress | Volumes: 1TiB/month included then $0.09/GiB-month; Starter egress: 1TiB/workspace/month then $0.04/GiB |

Sources: [Lightsail](https://aws.amazon.com/lightsail/pricing/), [Supabase](https://supabase.com/pricing), [Inngest](https://www.inngest.com/pricing), [R2](https://developers.cloudflare.com/r2/pricing/), [Modal](https://modal.com/pricing).

Host + database starts around **$37/month**. Retaining 1,000 provider-billed GB at R2's list rate adds about $15 before allowances/requests. L40S + four physical cores + 128GiB requested RAM is approximately $3.16/worker-hour before other charges. Worker-hours do not equal recording-hours. Include snapshots, domains, transfer, email and extra environments. Re-cost storage/egress if qualification selects S3.

Modal bills CPU/RAM at the higher of requested or actual use. Disk requests can raise RAM billing at a 20:1 disk-to-memory ratio. Set limits and budget scratch. R2 free egress does not waive Modal result-upload egress. Confirm actual account credits instead of automatically subtracting advertised credits. [Resource billing](https://modal.com/docs/guide/resources), [egress](https://modal.com/docs/guide/network-egress-billing)

## Admission and measurement

Use a proposed $100/month planning envelope and a smaller operator-set qualification budget. Configure approved amounts before activation. Reserve estimated upper cost atomically; include loading, inference, validation/export, allowed retries, transfer, retained data and workflow executions. Hold uncertain usage/reservations until reconciled. Provider alerts and application reservations are not guaranteed billing hard caps.

Start with one global GPU, bounded CPU jobs, zero warm/buffer containers and no automatic larger-GPU retry. Enable only requested, rights-cleared stages after cheap ingest/QC. Profiles must specify upload/source/batch/fragment limits, CPU/RAM/scratch, start/execution deadlines, attempts, workflow allowance and per-run cost ceiling. Unset limits block activation.

Measure representative two-hour peak memory/scratch, read/write bytes, startup/inference time, row failure/retry rate, workflow executions, review minutes and **cost per approved recording hour**. Raise limits only with evidence.

## Secrets and observability

| Credential | Holder |
| --- | --- |
| Auth/OAuth secrets | API identity module |
| Migration DB owner | CI/operator migration job |
| Restricted runtime DB roles | API and control process |
| Modal token, Inngest keys, storage issuer | Intended backend/CI environment |
| Scoped object grants | Current claimed worker, with tracked expiry/revocation |
| Protected release writer / read-only validator | Distinct approved exporter / validator role |
| Model-hub token | Controlled licensed cache preparation |

Inject/rotate secrets; redact cookies, signed URL queries, capabilities, raw frames and environment dumps. Logs carry request/run/batch/job/attempt/provider IDs, durations, reason codes and accepted/observed dataset versions. Permanent provenance lives in Postgres/receipts, not short-lived provider traces.

Alert on outbox age >5 minutes, uncertain submission past deadline, stuck writer/compute ownership, verification/checksum failures and budget thresholds 50/80/100%. Track retained canonical/checkpoint/history bytes separately from disposable logs.

## Retention and recovery

Follow [storage retention](storage-and-data-model.md): seven-day attempt cleanup never deletes recoverable native checkpoints or pinned Lance history. Database backups do not back up object payloads. Ordinary processing cannot write raw originals/published releases. Exercise restoration of database, referenced objects and revocation/deletion records together.

| Incident | Response |
| --- | --- |
| API/auth outage | Restore pinned service/provider; preserve phone journals and operation IDs |
| Unknown submission / expired lease | Reconcile; block blind resubmission and root takeover |
| Native writer loss | Retain workspace; confirm termination and retired grants before compatible recovery |
| OOM/image/license failure | Disable profile and diagnose before another bounded attempt |
| Storage/workflow outage | Bounded retry; retain outbox/checkpoints; timeout is not success |
| Bad labels/customer grant | Revoke future access/use, retain audit and issue corrected release |
| Deletion request | Retention-aware tombstone/cleanup, no shared-data cascade |

Restore into isolation, verify referenced objects/pinned history, replay revocations/tombstones and reconcile external calls before admission. Never restore an old lease as authority to overwrite an active root. Proposed targets: daily DB recovery points and restoration within one business day; prove through an exercise.

Roll out migrations/auth, API/UI with processing disabled, synthetic ingest/recovery, a permissioned two-hour canary, full review/export/download, then collectors. Optional GPUs have separate gates. Rollback disables new admission and reverts code while retaining schema compatibility, recovery state and immutable data.
