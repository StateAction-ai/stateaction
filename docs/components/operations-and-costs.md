# MVP operations and costs

Design · 2026-10-31 · Not deployed. [Deployment](render-deployment.md), [jobs](job-orchestration.md), [processing](cloud-processing.md), [local development](local-development.md), [volume assumptions](video-cost-model.md).

## Deploy these services

| Service | Initial size / purpose |
| --- | --- |
| Render Next.js web service | 1CPU / 2GB RAM; UI, Better Auth and bounded JSON APIs |
| Render Postgres | Paid 1GB RAM instance; about 10GB initial disk; nine active domain tables plus auth; `releases` brings the planned total to ten later |
| Render Workflow service | Active `process-recording` Node controller; `export-release` is a specified follow-up using the same executor/runner pattern |
| One Render cron | Every minute UTC; requests repair of pending workflow dispatch through the API and exits within 45 seconds |
| Private R2 | Source MCAP/metadata, job outputs, bounded clip RRDs and previews; release archives follow later; media bypasses Render |
| Modal CPU Functions | Deploy `process_recording` initially; `export_release` follows with delivery; scale to zero, no required GPU |

Use one production Render workspace/region for web, workflows, cron and Postgres. **Only the web API connects to the database** using its internal URL, provider-supported TLS and a bounded pool; disable public database access. Workflow controllers and the repair cron use scoped internal API operations. Controllers invoke Modal through its JavaScript SDK; cron repairs Render task dispatch rather than waiting for recording processing. Separate local/test secrets and buckets; preview builds receive no production data.

Deploy the proposed monorepo: `apps/mobile` (Flutter), `apps/web` (Next.js), `apps/jobs` (Node workflow controllers and repair cron), `packages/server`, `packages/contracts`, `packages/stera_recorder`, `packages/stera-sdk`, `workers/processing` (Python). These are implementation targets; source movement is coordinated with the recording-fix agent. Use pinned builds and reviewed additive migrations, then deploy compatible web/controller/cron/worker versions. No automatic destructive startup migration.

## Low-spend defaults

Automatic **21 hand landmarks and clearly marked 3D estimates are required MVP output**. Use the pinned MediaPipe CPU baseline, subject to the rollout checks below; embeddings, captions and GPU hand models are outside the initial deployment. Learned 3D is not calibrated metric supervision. Quality checks must include occluded hands, gloves, missed detections, left/right errors and visible overlay accuracy on representative repair tasks.

Start with **one active Modal job globally**, zero warm containers, finite source/output counts and byte limits, bounded frame buffers and explicit runtime/cost limits. Neither the current local whole-recording geometry script nor short sample success proves two-hour memory safety. Do not auto-resubmit an uncertain call or upgrade resources. Staff authorizes a fresh job/prefix after diagnosis; only the current job can complete outputs. The follow-up exporter shares this admission limit. [Job recovery](job-orchestration.md)

Set account spending alerts and an application admission limit before cloud activation. Count startup, source reads, processing/export, failures, controller compute, output transfer and retained objects. Alerts/admission are not billing hard caps. The API requests an initial controller after committing a job; failed/due dispatch is repaired each minute. Keep queued and uncertain states visible rather than claiming immediate execution.

No suspended sleep or step checkpoint API is assumed. Controllers use an eight-hour task limit covering the bounded worker budget; no planned continuations are needed. A native controller retry resumes API-owned state and the same known worker call. Exact timeouts and leases live in [jobs](job-orchestration.md).

## Cost model

USD list prices checked 2026-10-30; before tax, credits and engineering/review labor. [Render pricing](https://render.com/pricing), [cron billing](https://render.com/docs/cronjobs), [workflow billing](https://render.com/docs/workflows-limits), [R2](https://developers.cloudflare.com/r2/pricing/), [Modal](https://modal.com/pricing).

| Item | Monthly planning input |
| --- | --- |
| Next.js web | $25 |
| Paid Postgres | $19 |
| Database disk allowance | $3; conservative allowance before included storage/rounding |
| **Application/database subtotal** | **$47 for one infrastructure operator** |
| One cron | **At least $1**; actual active compute can exceed that minimum |
| Render Workflow controllers | Flex: $0.20/active vCPU-hour + $0.05/GB-hour RAM; retained input/result state $0.25/GB |
| Optional Render Pro workspace | +$25 when engineering collaboration/features require it; app users need no workspace seats |
| R2 Standard | $0.015/GB-month, plus $4.50/million writes and $0.36/million reads; free direct internet egress |
| Modal CPU Functions | $0.04716/physical-core-hour + $0.007992/GiB-hour; requested/actual usage rules apply |
| Modal output transfer | Starter includes 1TiB/month, then $0.04/GiB |

The fixed floor is therefore **about $48/month**, or $73 with a Pro workspace, before workflow compute, storage, processing, transfer and ancillary services. The cron's $1 is a minimum, not a flat price for unlimited scheduled compute. A waiting workflow retains billed RAM: a controller averaging 0.1vCPU/0.2GB costs about $0.03/hour, not free suspended waiting. Measure actual controller CPU/RAM across native retries. Model assets can be packaged in the worker image; no separate persistent model cache is necessary for the small hand model.

Budget provisionally **12.5GB uploaded per recording hour**, approximately 25GB for two hours, pending the real long-capture test. Calculate storage from **retained source bytes + measured retained outputs**, including per-clip RRDs, previews, pose arrays and metadata; add archive bytes when delivery ships. Do not assume all derivatives total a fixed multiple of raw video. At that provisional input rate, three months of source alone is about **750GB/$11.25 at 20 new hours/month** or **3.75TB/$56.25 at 100 hours/month**, before R2 allowances/rounding. These are not total platform costs. Retention decisions and referenced published data can prevent roll-off.

The shared clip viewer pins Rerun **0.22.1** and self-hosts its JavaScript/WASM. The WASM asset is approximately **27.6MiB uncompressed per uncached browser**; measure compressed transfer, cache hit rate and Render asset bandwidth. Authorized clip RRDs load directly from R2. Measure their actual encoded bytes, worker encoding time and browser memory; a 60-second clip limit alone does not bound file size. Record the chosen preview frame rate/resolution/byte cap separately from full canonical training outputs. R2's free internet egress does not eliminate storage/requests, Render-hosted viewer assets or Modal output-transfer charges. [Viewer qualification](rerun-clip-review.md)

For illustration, four physical cores and 8GiB RAM cost approximately **$0.253 per worker-hour** at base Modal Function rates. This is a sizing candidate, not measured runtime or a recording-hour price. Budget `worker-hours × actual resource rate`, including export and retries. Region/non-preemptible choices can multiply rates. R2 free outbound does not waive Modal's outbound uploads. Keep media off Render to avoid its metered public outbound bandwidth. [Modal resource billing](https://modal.com/docs/guide/resources), [transfer](https://modal.com/docs/guide/network-egress-billing), [region pricing](https://modal.com/docs/guide/region-selection)

## Local first, then one CPU cloud canary

Run the initial flow locally with **Postgres + MinIO + the official Render local Workflows runner + the CPU hand model**, using `EXECUTION_BACKEND=local` and `HAND_MODEL_PROFILE=mediapipe_cpu`. The local task server at port `8120` runs the same `process-recording` definition used in production; `LocalExecutor` launches the real Python processor, and `ModalExecutor` replaces only execution in production. The specified `export-release` task joins this same pattern in the delivery follow-up. Follow [local setup](local-development.md) for the supported Render CLI/configuration.

Exercise login, Flutter upload, API-issued multipart output uploads, processing, shared clip inspection and staff review. Prove real read-only external inspection through operator-managed `dataset_access`: only current approved dataset members/labels are visible, without staff QC/notes. Synthetic fixtures help UI tests but do not satisfy that production-access gate. Frozen-version publication and complete customer package transfer are separate follow-up acceptance gates. The local execution path requires no GPU or paid cloud processing. A separately qualified local CUDA profile can be added explicitly; it is not an MVP requirement.

Next, qualify one small Modal CPU canary and then one representative two-hour capture before admitting collectors. Local success does not establish Modal memory/scratch, callback authentication, R2 completion semantics, transfer charges or cloud throughput. Record total source/output/RRD bytes, peak memory/scratch, wall time, hand coverage/overlay errors and processing-output checksums. Set concurrency/budgets from these measurements. Measure archive/export costs and verify complete release checksums when the follow-up backend is implemented.

## Secrets, recovery and rollout

The web server holds Better Auth/provider secrets, its database role, R2 signing credentials and the Render task-start credential. The repair cron holds only its restricted internal-API token, with no Render task-start, Modal or database credential. Workflow controllers hold the Modal control token and scoped internal-API token; neither controllers nor cron have database credentials. Workers receive a job capability and API-issued read/part URLs, never database credentials or broad storage/Modal keys. Keep migration credentials separate. Redact cookies, job capabilities and signed URL queries from logs; log recording/file/job/release IDs and reason codes.

Use paid Postgres's built-in PITR: **3 days on Hobby, 7 days on Pro**. Restore creates another database for isolated validation; the most recent ten minutes are outside its selectable window. Create/download a logical export before risky migrations. No separate backup cron is required for this MVP. [Recovery](https://render.com/docs/postgresql-backups)

Before real collection, test restoring the catalog and resolving its referenced R2 objects. Keep admission disabled until external Modal calls are reconciled, stale jobs cannot accept output, and restored sessions/customer access are reviewed or invalidated. Database recovery does not restore deleted object payloads. Never delete raw/local originals after failed verification or age-purge published releases as scratch.

Roll out local capture-to-review checks, production auth/upload with processing disabled, the CPU canaries, staff dataset browsing/review and authorized external inspection, then a limited collection pilot. Staff Pipeline contains status/errors; shared Data browser starts with datasets and opens a video grid using `datasetId=<UUID>`. Frozen-version publication and customer Download all are deferred; no Releases/Deliveries screen, sharing UI or replacement operator publishing tool ships in this increment. Rollback stops new dispatch and restores compatible code while preserving source files and completed immutable outputs. Alert on queued jobs older than five minutes, uncertain/stuck calls, failed source hashes, disk/connection pressure and spending thresholds.
