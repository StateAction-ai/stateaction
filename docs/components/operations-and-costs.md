# Deployment, operations and cost controls

Status: proposed implementation. Updated: 2026-10-22. No infrastructure deployment or processing run was performed while writing this plan.

Parent: [Technical design](../technical-design.md). Canonical topology: [processing execution/data flow](pipeline-execution-and-data-flow.md). Related: [orchestration](job-orchestration.md), [processing](cloud-processing.md), [storage](storage-and-data-model.md), [Node hosting variant](backend-architecture.md), [implementation plan](../implementation-plan.md).

## Hosting variants and shared services

API/auth hosting remains provisional. Choose one owned control plane: Supabase Edge Functions on Deno/TypeScript, or a separately hosted Node.js 24 LTS/TypeScript service with a qualified Fastify/auth integration. The clone's Bun/Hono deployment is source/protocol evidence, not our production architecture or an instruction to copy its process/proxy configuration. Do not deploy two API backends or two identity authorities by default.

| Hosting variant | API and console | Outbox and reconciliation | Qualification / cost boundary |
| --- | --- | --- | --- |
| Supabase-hosted Edge | Small Deno/TypeScript API functions; static console hosted separately or through a qualified application-origin arrangement | Scheduled finite functions process bounded pages using persisted leases/cursors; no permanent process inside an Edge invocation | Identity/cookie or deliberate native auth migration, origin/CSRF, signed Inngest handling and exact Modal SDK canary; no separate VM is assumed |
| Standalone Node | Owned Node 24/TypeScript/Fastify API; static console may share its HTTPS origin | One supervised companion process or bounded scheduled entrypoint, with independent restart and restricted DB role | Measure 2GB host fit and qualify Node integrations, supervision/TLS/patching/backups; Supabase still supplies Postgres |

The Edge option uses `pg_cron` plus `pg_net` or another approved scheduler to invoke narrow service-authenticated relay/reconciler functions. Store scheduler secrets in Vault/provider secret storage; a public publishable API key is not authorization for a privileged relay. Each invocation claims a bounded batch, performs short remote requests, persists outcomes and exits. Concurrent schedules use row leases/CAS and an invocation limit; lease expiry or another scheduled run must not admit a duplicate GPU writer. A missed schedule delays work, and the next scan recovers pending records. [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions)

Hosted Edge limits currently include 256MB memory, two seconds CPU per request, 150-second request idle timeout and 150/400-second Free/paid worker wall lifetime. These are ceilings, not a target request duration. No Edge function downloads/decodes MCAP, hashes a large dataset, runs Ray, waits for inference, or performs export/payload-copy loops; these are finite Modal CPU/GPU jobs. Bound manifests, signing batches and DB/provider operations to fit the selected runtime. [Edge limits](https://supabase.com/docs/guides/functions/limits)

Modal officially supports its JS SDK on Node 22+, Deno and Bun. That does not prove its exact private Function lookup/spawn/poll/cancel path works within **Supabase's hosted** Deno restrictions. Pin the SDK and canary that path, authenticated callbacks, temporary storage sessions, signed workflow handler and connection cleanup. Add a narrow external submission bridge only if a measured runtime limitation requires it; account for its hosting/secrets/availability and keep domain authorization in the selected API. A bridge is not a default second backend or identity service. [Modal JS SDK](https://modal.com/docs/sdk/js/latest/intro)

The shared data/compute services are:

| Service | Initial deployment | Scaling / failure boundary |
| --- | --- | --- |
| Postgres | One Supabase project, Pro budgeted for operational pilot | Selected identity/domain catalog/outbox plus bounded pools, backups and restore exercise |
| Workflow engine | Inngest Cloud free tier during qualification | Qualified signed handler for selected API runtime; DB state survives trace retention |
| Bulk storage | Private R2 raw/derived/release buckets per environment, proposed | Test native Lance conditional commit/recovery and scoped credentials; S3 alternative |
| CPU processing | Finite Modal Python Functions | Zero warm workers; bounded concurrent jobs and deadlines |
| GPU processing | Stage-specific finite Modal Functions | Zero warm workers; one globally admitted GPU attempt initially |
| Model cache | Versioned Modal Volume | Weights only; prefill via a bounded CPU preparation job |

The standalone host size is a qualification decision. AWS currently lists its Linux public-IPv4 2GB Lightsail bundle at $12/month; together with a $25 Supabase Pro baseline that is **$37/month before** object storage, compute, snapshots, domains, email/monitoring, transfer/usage overages and tax. It is not evidence that 2GB fits the workload or a request to provision it. Edge hosting does not add this VM cost; start from the selected Supabase project plus actual function/other usage. Use existing suitable capacity where available and measure fit before buying more. [Lightsail prices](https://aws.amazon.com/lightsail/pricing/), [Supabase plans](https://supabase.com/pricing)

A single Node host is an availability limit; Edge hosting instead depends on its provider limits, scheduler and integration availability. Record the selected variant, operator escalation and tested recovery before unattended collection. Neither option needs an always-on GPU, Kubernetes or a new load balancer/NAT gateway for this initial design. Scaling the control plane does not change upload object keys or worker contracts.

## Canonical dataset operations and cleanup

Retain one stable Lance/media root and native checkpoint workspace per bounded processing batch across compatible attempts. Attempt logs/diagnostic scratch have their own identity; an attempt does not own a replacement canonical table. Native clip/span/result versions are accepted by publication receipts and final CAS, while immutable original/non-Curator payloads retain hashes. Do not copy the entire dataset at each stage or retry. A protected release export materializes/copies only the selected delivery when isolation/portability requires it. Lance here is dataset files on object storage, not a separately hosted LanceDB/vector service.

Start with one externally enforced native writer per batch. Before reusing its stable writable root, prove prior writer termination **and** expiry/revocation of its outstanding write capabilities. DB fencing protects accepted pointers; it cannot fence a stale storage writer. Block ambiguous takeover and alert rather than regrant access. R2 remains a proposed provider until Lance commit/recovery, listing, hash preservation and temporary-token propagation through Botocore/Arrow/Lance pass. Its one read-write profile may trust the pinned adapter within that scoped batch; do not promise unsupported per-path action isolation or use broad raw/release credentials.

The proposed seven-day failed-attempt cleanup applies only to unaccepted **attempt-only logs/diagnostic scratch** after confirmed terminal execution. It must not delete canonical batch roots, active/recoverable checkpoints, durably saved results awaiting publication, or data/transaction history pinned by review/release consumers. Retain those dependencies until the reference graph, recovery contract and configured retention authorize removal. Native successful-publication cleanup may remove its own staging; retain our permanent application receipts. Prohibit compaction, vacuum/history pruning, row deletion and physical input-file rewrite during the protected recovery/pinned-consumer lifetime. [Canonical data flow](pipeline-execution-and-data-flow.md), [retention and credentials](storage-and-data-model.md)

## Environment and secrets

Separate development, staging and production databases/buckets/auth origins/Modal environments/Inngest environments or apps. Development must not share production upload keys or customer data. CI builds immutable artifacts; deployments select digests/revisions rather than mutable `latest`.

| Secret/config | Holder | Boundary |
| --- | --- | --- |
| Selected identity signing secret, OAuth client secrets | Qualified identity/API adapter (Better Auth in Node variant) | Never phone/web bundle/processing worker; no implicit second identity |
| DB runtime URL | API/relay with restricted roles | No collector/customer credentials |
| Migration/direct URL | Migration job/operator | No auto-migration on app startup |
| R2 parent issuer/protected-release credentials | Trusted issuer or finite cloud export service only | Never ordinary processing worker or client |
| Modal token | Backend/CI with intended workspace/environment scope | Private Function invocation; redact logs |
| Inngest event/signing keys | API/relay/CI as needed | Validate signed service calls separately from human auth |
| Per-attempt API capability/scoped batch storage session | Winning authorized writer invocation | Track expiry/revocation plus provider termination; `claim_epoch` alone does not revoke storage writes; no event/manifest secrets |
| Model repository tokens | Dedicated image/cache preparation or selected worker secret | Licensed assets only; no unrestricted auto-download |

Use the provider secret store or host secret injection with restricted file permissions. Commit `.env.example` placeholders only. Rotate signing keys with a tested overlap mechanism. On rotation, inspect active jobs and credentials before retiring old keys. Do not print `.modal.toml`, full environment variables, cookies or signed URLs into receipts.

Account activation is a separate prerequisite. Modal CLI 1.6.2 is installed and browser login was completed; this is not a deployed worker. The read-only workspace checks during planning returned no listed apps and zero metered/billed cost for the current month. The user saw a $1 allowance display and identified payment-method activation as necessary. Verify the actual account allowance, spend budget and GPU access before any benchmark; never infer a balance from the public pricing page.

## Cost model

Budget in USD before tax and show gross usage independently from grants. These are public list prices checked on 2026-10-22, not measured throughput or a spending authorization.

| Item | Planning rate / caveat |
| --- | --- |
| Supabase Pro | From $25/month; one Micro can be covered by the included compute credit; verify selected project/backups/egress |
| Supabase Edge invocations | Pro currently includes 2 million/month, then $2 per million; count scheduled relay/reconciler and workflow callbacks as well as human API requests |
| Inngest Free | $0 plan, 50k executions/month and five concurrent steps; step/poll count matters; Pro currently starts $99/month |
| R2 Standard | $0.015/GB-month, request charges and included allowances; free direct egress |
| Modal L4 GPU | $0.7992/GPU-hour, CPU/RAM additional |
| Modal L40S GPU | $1.9512/GPU-hour, CPU/RAM additional |
| Modal H100 GPU | $3.9492/GPU-hour, CPU/RAM additional |
| Modal CPU | $0.04716 per physical core-hour for Functions; a physical core is not one AWS vCPU |
| Modal RAM | $0.007992/GiB-hour for Functions; requested/actual billing rules apply |
| Modal Volumes | Published 1TiB/month included, then $0.09/GiB-month; confirm actual workspace terms |
| Modal network egress | Published Starter 1TiB/month included, then $0.04/GiB; verify actual plan/traffic |
| Standalone Node API host, if selected | Lightsail Linux public-IPv4 2GB example $12/month; $37 with $25 Supabase Pro before extras, not a measured capacity guarantee |

Sources: [Supabase](https://supabase.com/pricing), [Lightsail](https://aws.amazon.com/lightsail/pricing/), [Inngest](https://www.inngest.com/pricing), [R2](https://developers.cloudflare.com/r2/pricing/), [Modal](https://modal.com/pricing). Modal Sandbox CPU/RAM pricing differs from Function pricing; this plan uses Functions. Selecting Edge avoids a blanket Node VM line; selecting Node does not require a duplicate Edge API. Additional projects and paid authentication/email/hosting features remain separate decisions.

Example requested-resource totals, excluding startup/idle time, storage/transfer and retries:

| Resource configuration | Approx. gross worker-hour | Use / qualification |
| --- | --- | --- |
| CPU: 2 physical cores + 8GiB | $0.1583 | Initial bounded-ingest smoke-test candidate; two-hour MCAP peak RSS/scratch/byte bounds must be measured |
| L4 + 2 physical cores + 16GiB | $1.0214 | Small embedding candidate; not a measured model fit |
| L40S + 4 physical cores + 32GiB | $2.3956 | Conditional selected model workload |
| L40S + 4 physical cores + 128GiB | $3.1628 | Conservative host-memory caption qualification after bounded-context adapter |
| H100 + 4 physical cores + 128GiB | $5.1608 | Unchanged large-caption qualification candidate, not a guarantee |

Resource amounts are requests and may not cap billed actual CPU/RAM. Curator/Ray memory and model context are discussed in [processing](cloud-processing.md). Do not choose the smallest table row without passing the actual image/model test.

Illustration: 1,000 provider-billed GB retained at R2's list rate is about $15/month before allowances and operations. Twenty L40S worker-hours at the 128GiB example are about $63.26 gross; adding the $25 DB and $15 storage already exceeds $100 before host/CPU/retries. This is an illustration of resources, not twenty recording hours or a forecast. A $100 total pilot envelope requires stage selection and an actual throughput measurement.

Published Modal Starter allowance is $30/month of eligible compute, subject to account activation and current terms. Show this as a possible deduction after confirming eligibility; never assume $30 is available in this account or spend it implicitly. AWS credits and storage transfer exemptions are equally conditional. R2's free egress does not cancel Modal's outbound transfer charge when workers upload results. [Modal billing](https://modal.com/docs/guide/billing), [network egress](https://modal.com/docs/guide/network-egress-billing).

Measure cost per approved recording hour across CPU/GPU loading/inference/retries, workflow and API invocations, transfer, retained raw/canonical media/checkpoints/pinned history/releases, review minutes and packaging. Do not budget a full Lance/media copy for every stage/attempt when the design reuses canonical state. A single short Pixel sample cannot establish long-recording bytes/hour. GPU-hour price alone cannot establish unit economics.

## Admission and spend policy

Implement a proposed $100/month **planning envelope**, with an operator-configured smaller benchmark sub-budget. These values are not approvals or configured provider caps. On deployment, set an explicit allowed paid budget and do not treat credits as unbounded capacity.

- Admit GPU only for requested deliverables after cheap ingest/QC and rights gates.
- Lock and reserve an estimated upper cost before every attempt. Include permitted retry count and stage deadline. Compare reserved plus settled usage with the allowance.
- Stop new admission when the allowance is exhausted or metering is uncertain. Keep active jobs visible; stopping new jobs does not terminate current compute or storage billing.
- Use provider budgets/alerts in addition to application admission. Understand whether the specific provider control stops workloads or merely sends notifications; verify before depending on it.
- Release a global GPU slot/cost reservation only after execution is confirmed terminal. Separately require previous writer termination and credential expiry/revocation before canonical-root takeover; a stale DB lease alone is insufficient.
- No automatic “retry on a larger GPU,” unbounded retry, permanent warm pool or model download inside a paid GPU loop.
- Keep model caches pinned and shared safely; batch multiple short clips per model load. Count startup, inherited idle duration and failure costs.

Collect provider usage with a lag allowance. A reservation is a conservative planning estimate, not a billing hard cap: actual host use, preemption, startup and out-of-band account activity can differ. Settlement must preserve unaccounted residuals until reconciled. Report active/ambiguous jobs and retained storage in the operations UI.

## Observability

Structured logs carry request ID, tenant/project, recording/run/batch/job/attempt, `claim_epoch`, workflow execution ID and Modal call ID. Record accepted/observed dataset versions, native publication receipts and capability expiry/revocation evidence without recording secrets. Log durations and reason codes; omit raw video, exact signed URLs, credentials, cookies and unnecessary personal metadata.

| Signal | Operational question |
| --- | --- |
| Upload bytes/parts, URL renewal/errors, oldest pending upload | Are repair workers blocked or duplicating data? |
| Sealed recordings awaiting ingest/outbox age | Did domain state reach the workflow service? |
| Stage duration, queue wait, cold load and attempt count | Is compute slow or stuck? |
| Claim conflicts, uncertain submits, stale leases | Is replay safe and is capacity trapped? |
| Hash/MCAP/schema failures and missing sensor channels | Is source integrity failing? |
| Per-profile geometry/label missingness and reviewer correction time | Are outputs useful for the declared delivery? |
| Canonical media/checkpoint/pinned-history bytes vs attempt logs | Are actual retained recovery dependencies or diagnostics inflating storage? |
| Batch writer termination and last write-capability expiry | Can a stable root safely be regranted, or must this batch remain blocked? |
| Inngest execution count and remaining plan allowance | Is polling exhausting the free tier? |
| GPU/CPU seconds, cost reservations/actuals, transfer/cache size | Are jobs meeting the budget? |
| Release build/loader failures and downloader checksum errors | Can customers consume the complete package? |

Proposed pilot alerts: undelivered outbox older than five minutes; uncertain active submission past its startup deadline; ingest/artifact verification failure; GPU slot held beyond deadline; projected budget thresholds at 50/80/100%; backup/restore check failure. Values are tunable operational defaults, not service SLAs.

Keep durable application audit/provenance in Postgres and compact receipts in object storage. Inngest free trace retention and provider logs are not the permanent record. Large Rerun/full JSON/HTML diagnostics are on demand with retention, because they can exceed the original short recording's size.

## Operational runbooks

| Incident | Required response |
| --- | --- |
| Selected API unavailable | Node: restart pinned service/control process; Edge: inspect provider/runtime and scheduled-handler errors. Persisted outbox/leases recover records; phone keeps offline journal |
| Auth/provider outage | Pause upload control requests; preserve local bytes/parts; do not switch identities or clear the queue |
| Object store unavailable | Retry bounded transfer; never mark verified/success on timeout; preserve manifests/checkpoints |
| Modal submit uncertain | Inspect attempt claim/call/result; retain slot/reservation; no blind duplicate attempt |
| Native batch writer fails/checkpoint remains | Keep canonical root/workspace; reconcile native commits and recover only under compatible input/config contract after termination plus credential expiry/revocation; do not delete/re-copy the dataset |
| Worker OOM or incompatible Ray/NVDEC | Mark configuration failure; stop that profile; inspect bounded diagnostics before another test |
| Inngest unavailable/quota reached | Leave pending outbox/application state; continue independent safety reconciliation of active compute |
| Bad annotation/model revision | Disable new use; preserve existing evidence; reprocess into new run; issue new release/revocation if needed |
| Leaked signed URL | Revoke future grant/session, assess finite URL lifetime and access logs; do not promise recall of downloaded data |
| Account deletion request | Suspend new processing/access as policy requires; retention-aware deletion task, no direct cascade |
| Wrong customer grant | Revoke immediately for new requests, audit scope, notify through approved human process; no automatic external messages |

Restore runbook: recover DB to an isolated environment, restore/verify referenced objects and pinned Lance versions/history/checkpoints, replay deletion/revocation tombstones, validate source/release checksums, reconcile external calls and writer credentials without re-launching paid work, then enable endpoints. Never restore a stale lease as permission to overwrite a potentially active batch. Proposed pilot recovery targets: within one day of DB changes using daily backups and within one business day to restore service; these are targets requiring an exercise, not achieved guarantees. Improve if customer commitments require tighter recovery.

## Deployment sequence and rollback

1. Select and qualify API/auth hosting without cloning backend business logic; prove the Edge Modal/identity/workflow canary or the Node/Fastify equivalents. Separate credentials/backups in staging. Record source/app/image/model/SDK versions.
2. Deploy additive migrations and auth/user-delete guards. Verify old read compatibility and canonical upload adapters.
3. Deploy the chosen API/console and scheduled Edge or supervised Node relay/reconciler with processing admission disabled. Exercise auth, bounded scheduling and resumable uploads against synthetic files.
4. Register the signed Inngest handler and deploy bounded Modal CPU Functions. Enable only synthetic ingest, then one permissioned canary after explicit deployment scope is established.
5. Qualify optional GPU profiles individually. Keep failed/unlicensed profiles disabled rather than make them a default dependency.
6. Validate internal review at pinned batch versions, cloud packaging, customer grant, complete resumable download and loader. Exercise cancellation, duplicate delivery, canonical checkpoint/commit recovery, single-writer takeover, restore and budget behavior.
7. Enable the approved collector cohort. Record app build, profile and operator ownership. Monitor gross costs and correction time.

Rollback disables new admission/upload protocol versions and reverts the selected API/UI artifacts while retaining additive schema, canonical recovery state and immutable data. Already issued URLs/calls remain bounded external effects; reconcile rather than delete records. Do not drop tables, prune pinned Lance history, reset native checkpoint namespaces or mutate source/release bytes to roll back software. Keep older worker revisions until active calls finish or are confirmed cancelled; require safe writer/capability handoff before reuse.

## Operations deliverables

Before launch, provide environment inventory, configuration template, secret owner/rotation record, tested backup/restore receipt, production app build receipt, one cloud run receipt with full cost, release/download validation receipt and an operator runbook. All remain implementation tasks; the current repository changes are documentation only.
