# Repair-data platform: technical design

Updated: 2026-10-26. Status: audited domain design; hosting/runtime recommendations under review. Platform qualification and deployment remain future work.

**Current decision:** the frontend is Next.js. Render hosting and Render Workflows are being evaluated. API hosting/identity and the workflow engine are not finalized; the October 23 Node/Lightsail recommendation was not deployment approval. [Current hosting evaluation](components/hosting-evaluation.md) takes precedence over older deployment assumptions in the component documents.

## Product and scope

A repair worker signs in, records offline and reliably uploads finalized MCAP/sensor files. Cloud workers extract evidence, prepare clips and run requested annotation models. Our team corrects/reviews the results and publishes a fixed dataset release. Robotics customers inspect their granted releases and download the complete training package. Customers do not approve individual episodes.

The first profile is **reviewed RGB and semantic labels**. Metric hand trajectories, robot actions and policy-training benefit require separate qualification. All extraction, annotation and packaging run in cloud workers; the phone captures/transfers, and the API handles small control requests.

## Reference platform and current choices

Use one domain backend, identity authority and workflow engine. The earlier audit described a Node deployment; its domain contracts remain useful, while hosting-specific adapters must follow the final decision.

| Component | Choice | Reason |
| --- | --- | --- |
| Frontend | Next.js; Render is under evaluation | Confirmed framework; choose full server hosting versus static export deliberately |
| Domain API | Supabase Edge/Deno proposal or owned Node.js/TypeScript service | Hosting/runtime under review; Node/Fastify remains a reference implementation option |
| Login | Better Auth in the Node reference option; integration/provider under review with API hosting | Preserve or deliberately migrate the recorder's identity/session protocol; qualify real devices |
| Application database | Supabase Postgres | Managed relational catalog, access rules, job records and audit |
| Bulk storage | Private R2; S3 fallback if qualification fails | Low transfer cost for processing and customer delivery |
| Workflow | Inngest reference; Render Workflows under evaluation | Select one engine after recovery/waiting tests |
| Processing | Modal CPU/GPU Functions; Ray inside Curator workers | Scale to zero; resources independent of the API |
| Dataset state | Lance files in object storage, per bounded batch | Reuse Curator's versioned tables and checkpoint recovery |

Supabase Edge/Deno and Node are alternative API implementations, not two backends to build. Their identity/SDK adapters need separate qualification. Render Workflows is a candidate alternative to Inngest; Temporal/Airflow remain alternatives described in [orchestration](components/job-orchestration.md). The Stera backend is protocol evidence, not a production foundation.

## Data flow

1. **Phone → object storage:** authorize a recording, transfer resumable parts directly and seal required files. API/database/workflow requests contain no video bytes.
2. **Modal CPU ingest:** verify hashes/MCAP, preserve clocks/calibration, and produce bounded video, native frame/sensor shards, preview and QC.
3. **Modal CPU preparation:** Curator plans spans and materializes clips in a stable per-batch Lance/media/checkpoint root.
4. **Optional enrichment:** qualified GPU workers add embeddings/captions; a separate hand adapter uses native evidence. Workers fetch referenced objects and save durable results.
5. **Validation/review:** a read-only cloud validator checks candidates; the API accepts exact versions. Our team reviews those versions and creates immutable label revisions.
6. **Export/delivery:** freeze approved items, package independent shards/loader/checksums, validate, then publish through the API. Customers receive scoped resumable downloads.

The [execution contract](components/pipeline-execution-and-data-flow.md) owns stages, locations and handoffs. Separate ingest, bounded-batch, review-assembly and release workflows prevent a long recording from exhausting one workflow's step budget.

## Correctness rules

- Uploaded bytes, verified source, accepted results, approved labels and published release are separate states.
- Compatible Curator retries reuse their batch root/checkpoints. One writer owns it; takeover requires old execution termination and retirement of all write capabilities.
- Workers cannot approve their own outputs. The API checks trusted validation, current ownership, inputs and lifecycle before acceptance/publication.
- Releases pin source/dataset/label/rights/schema revisions. Later processing cannot change published bytes.
- Missing sensors, unsupported timing, unqualified geometry and failed predictions remain explicit masks/limitations.

Detailed rules live in their component contracts, rather than being repeated across every document.

## Reuse and scaling

Reuse Curator/Lance recovery, Better Auth, Inngest and S3 clients. Build the domain/access layer, MCAP adapter, worker ownership/validation, review workflow and exporter. Small provider adapters isolate external APIs; switches still require protocol tests and migration.

| Project | Reuse decision / inspected license |
| --- | --- |
| Cosmos Curator | Native preparation/enrichment/recovery; Apache-2.0 code. Exact source/image and model gates are in [processing](components/cloud-processing.md). |
| HFlow | Catalog/provenance patterns; avoid adding its second catalog/controller. [Inspected Apache-2.0 code](https://github.com/Hebbian-Robotics/hflow/blob/6cf6e9849ab3386541eec2f26906c755a2fa3ac5/LICENSE). |
| Open-AoE | Selected viewer/projection and consumer examples. [Pinned Apache-2.0 code](https://github.com/ant-research/Open-AoE/blob/3504ac7e0639963cf9103ff29579504fc00989bd/LICENSE); datasets/assets/models have separate terms. Do not assume a complete raw-phone processor is released. |
| FLORA / WiLoR / MANO | Research comparators or optional adapters; no default commercial reuse. Restrictions and evidence are in [model rights](components/cloud-processing.md#model-rights). |

Pin copied components, retain license/notices and inventory external assets. Code licenses do not grant rights to model weights or private recordings. Pareto remains a reference given the maintenance concern, not a UI dependency.

Start with one global GPU job, bounded CPU jobs and zero warm GPUs. Scale independent batches by raising measured concurrency limits, then separate the API/control process or add API replicas using DB claims. Keep corpus-wide search/deduplication optional. No company-wide mutable Lance table, second catalog or Kubernetes is required initially.

## Handoff and launch gates

Read [implementation milestones](implementation-plan.md), [shared contracts](contracts.md), then your component from the [index](README.md). The [audit](design-audit.md) records fixes and remaining qualification gates.

Shared contracts, domain modeling and Next.js UI work can proceed. Resolve hosting/identity/workflow choices before their runtime-specific adapters. Production activation requires real-device auth/upload tests, representative two-hour ingest sizing, R2/Lance recovery qualification, confirmed project rights/regions and a full review-to-download canary. Optional models stay disabled until image, memory, quality and commercial rights pass.

The earlier Node/Lightsail plus Postgres example was about **$37/month**, not the selected hosting budget. [Hosting evaluation](components/hosting-evaluation.md) compares Render costs; [operations](components/operations-and-costs.md) owns spend/recovery controls. Public credits are not an account balance or spending approval.
