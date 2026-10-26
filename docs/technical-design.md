# Repair-data platform: technical design

Updated: 2026-10-26. Status: **Render application stack selected**; implementation, qualification and deployment remain future work.

**Decision:** Next.js/Node.js on Render, Better Auth, Render Postgres and Render Workflows. Keep private R2 media storage and Modal CPU/GPU processing as explicit external services. [Render deployment](components/render-deployment.md) owns service placement/configuration; this is a design decision, not deployment approval.

## Product and scope

A repair worker signs in, records offline and reliably uploads finalized MCAP/sensor files. Cloud workers extract evidence, prepare clips and run requested annotation models. Our team corrects/reviews the results and publishes a fixed dataset release. Robotics customers inspect their granted releases and download the complete training package. Customers do not approve individual episodes.

The first profile is **reviewed RGB and semantic labels**. Metric hand trajectories, robot actions and policy-training benefit require separate qualification. All extraction, annotation and packaging run in cloud workers; the phone captures/transfers, and the API handles small control requests.

## Selected stack

Use one Next.js web service for the UI, mobile HTTP API and login. Shared TypeScript modules contain domain logic; Render workflow tasks call those modules and the separately authenticated acceptance API. The Stera server supplies protocol evidence, not production business logic.

| Component | Choice | Reason |
| --- | --- | --- |
| Frontend and API | Next.js App Router, Node.js 24 LTS, TypeScript; Render paid web service | One origin/deployment; route handlers reuse domain services |
| Login | Better Auth in Next.js; Google sign-in and invitations initially | One identity authority; preserve qualified native cookie/offline-owner behavior |
| Application database | Render Postgres | Private managed catalog, sessions, grants, outbox, jobs and audit |
| Bulk storage | Private R2; S3 fallback if qualification fails | Low transfer cost for processing and customer delivery |
| Workflow | Render Workflows; four bounded controller task types | Managed queue/retries; resume from Postgres and Curator checkpoints |
| Scheduled maintenance | Render minute relay/reconciler cron and daily backup cron | Recover outbox dispatch and create independent database backups |
| Processing | Modal CPU/GPU Functions; Ray inside Curator workers | Scale to zero; resources independent of the API |
| Dataset state | Lance files in object storage, per bounded batch | Reuse Curator's versioned tables and checkpoint recovery |

Render owns application hosting and orchestration. R2 holds MCAP, media, Lance/checkpoints and releases; Modal runs every extraction/annotation/export/validation job. Render's object-storage early access and reviewed CPU-only workflow plans do not replace these qualified-design candidates. Supabase, Inngest, a standalone Fastify service and a permanent Ray cluster are not part of this stack.

## Data flow

1. **Phone → object storage:** authorize a recording, transfer resumable parts directly and seal required files. API/database/workflow requests contain no video bytes.
2. **Modal CPU ingest:** verify hashes/MCAP, preserve clocks/calibration, and produce bounded video, native frame/sensor shards, preview and QC.
3. **Modal CPU preparation:** Curator plans spans and materializes clips in a stable per-batch Lance/media/checkpoint root.
4. **Optional enrichment:** qualified GPU workers add embeddings/captions; a separate hand adapter uses native evidence. Workers fetch referenced objects and save durable results.
5. **Validation/review:** a read-only cloud validator checks candidates; the API accepts exact versions. Our team reviews those versions and creates immutable label revisions.
6. **Export/delivery:** freeze approved items, package independent shards/loader/checksums, validate, then publish through the API. Customers receive scoped resumable downloads.

The [execution contract](components/pipeline-execution-and-data-flow.md) owns stage locations, reads/writes and handoffs. Ingest, bounded-batch, review-assembly and release controllers are separate tasks. A minute cron relays committed commands; normal starts may take a minute plus queue time. Human review holds no running task.

## Correctness rules

- Uploaded bytes, verified source, accepted results, approved labels and published release are separate states.
- Compatible Curator retries reuse their batch root/checkpoints. One writer owns it; takeover requires old execution termination and retirement of all write capabilities.
- Workers cannot approve their own outputs. The API checks trusted validation, current ownership, inputs and lifecycle before acceptance/publication.
- Releases pin source/dataset/label/rights/schema revisions. Later processing cannot change published bytes.
- Missing sensors, unsupported timing, unqualified geometry and failed predictions remain explicit masks/limitations.

Detailed rules live in their component contracts, rather than being repeated across every document.

## Reuse and scaling

Reuse Curator/Lance recovery, Better Auth's Next adapter, Render's TypeScript SDK and S3 clients. Build the domain/access layer, MCAP adapter, worker ownership/validation, review workflow and exporter. Provider adapters preserve explicit protocol boundaries.

| Project | Reuse decision / inspected license |
| --- | --- |
| Cosmos Curator | Native preparation/enrichment/recovery; Apache-2.0 code. Exact source/image and model gates are in [processing](components/cloud-processing.md). |
| HFlow | Catalog/provenance patterns; avoid adding its second catalog/controller. [Inspected Apache-2.0 code](https://github.com/Hebbian-Robotics/hflow/blob/6cf6e9849ab3386541eec2f26906c755a2fa3ac5/LICENSE). |
| Open-AoE | Selected viewer/projection and consumer examples. [Pinned Apache-2.0 code](https://github.com/ant-research/Open-AoE/blob/3504ac7e0639963cf9103ff29579504fc00989bd/LICENSE); datasets/assets/models have separate terms. Do not assume a complete raw-phone processor is released. |
| FLORA / WiLoR / MANO | Research comparators or optional adapters; no default commercial reuse. Restrictions and evidence are in [model rights](components/cloud-processing.md#model-rights). |

Pin copied components, retain license/notices and inventory external assets. Code licenses do not grant rights to model weights or private recordings. Pareto remains a reference given the maintenance concern, not a UI dependency.

Start with one global GPU job, bounded CPU jobs, at most eight Render controllers and zero warm GPUs. Scale batches after measuring resource/DB/cost limits, then add web replicas using DB claims. Corpus-wide search/deduplication is optional; each batch keeps its own versioned Lance root.

## Handoff and launch gates

Read [implementation milestones](implementation-plan.md), [shared contracts](contracts.md), then your component from the [index](README.md). The [service diagram](figures/render-platform.md) shows deployment boundaries; the [audit](design-audit.md) records fixes and remaining qualification gates.

Implement the selected adapters against fake providers first. Production activation requires Render controller restart/continuation and private-network tests, real-device auth/upload tests, representative two-hour ingest sizing, R2/Lance recovery, confirmed rights/regions and a full review-to-download canary. Optional models remain disabled until image, memory, quality and commercial rights pass.

Application/DB allowance: approximately **$47/month for one infrastructure operator or $72 for a Pro workspace**, plus two cron-service minima, workflow usage, R2 and Modal. The [video cost model](components/video-cost-model.md) supplies complete volume scenarios; [operations](components/operations-and-costs.md) owns spend/recovery controls. Credits are not an account balance or spending approval.
