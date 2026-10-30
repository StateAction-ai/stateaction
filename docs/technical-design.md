# Repair-data platform: technical design

Updated: 2026-10-30. **Selected MVP design; implementation and deployment pending.** This revision keeps Render Workflows for local/cloud parity and simplifies the earlier Curator design. Automatic hand pose and both staff/customer interfaces remain required.

## Product

A repair worker signs in, records offline and uploads large MCAP recordings reliably. Cloud processing extracts RGB and available sensor evidence, estimates **21 hand landmarks plus explicitly marked model-relative 3D estimates**, and produces review media. Our team labels, approves and publishes. Robotics customers inspect their delivery and download its complete training package; they do not accept/reject episodes.

The agreed pilot output does not promise validated metric camera/world trajectories, robot actions or demonstrated policy-training benefit. Missing or unreliable observations remain explicit. Representative repair-footage quality is a launch gate.

## Smallest complete stack

| Component | MVP choice |
| --- | --- |
| App/UI/API/login | One Next.js / Node.js 24 / TypeScript service on Render; Better Auth with Google sign-in |
| Access | One pilot project; operator-managed collector, staff and customer allowlist |
| Catalog and queue | Render Postgres; seven domain tables plus Better Auth tables |
| Workflow | Render Workflows; the same two Node task definitions run under its official local runner and in the cloud |
| Recovery | Postgres job records plus a short minute cron repair pass; no separate outbox |
| Bulk storage | Private R2; direct multipart phone/worker uploads and direct customer downloads |
| Processing | Two finite Modal CPU functions: `process_recording` and `export_release` |
| Hand model | Pinned MediaPipe Hand Landmarker CPU baseline; mandatory inference, quality-gated |
| Repository | One monorepo including existing Flutter mobile/native plugin, Node apps and Python workers |
| Local development | Official Render local Workflows runner, same task/processing contracts, local Postgres/MinIO and LocalExecutor; no cloud GPU |

The application platform is Render; storage and processing remain explicit external services. Render hosts no video transfer proxy. Two bounded workflow controllers start/poll compute using durable job references. A minute cron repairs dispatch/abandoned controllers and exits; it never processes media.

## Complete flow

1. **Phone → R2:** owner-bound resumable multipart uploads; the API seals the required-file inventory. Completion of all files creates one processing job in the same database transaction, then requests its workflow run; cron repairs a lost trigger.
2. **Modal CPU:** one invocation streams/hashes MCAP, extracts bounded native evidence, runs mandatory hand inference, writes RGB/overlay previews and pose arrays, and validates outputs inline. Extraction and inference reuse the same decoded frames.
3. **API:** confirm the known execution ended, output inventory is closed and the current job/input references still match. Make the result reviewable.
4. **Our team:** inspect video/hand overlay and coverage, enter task labels and approve/reject bounded clips. Approval pins the exact processing result and labels.
5. **Modal CPU:** after staff freeze a release, stream the approved files/labels into a bounded local TAR, then hash/upload the archive and manifest. No model is rerun.
6. **Our team → customer:** explicitly publish the completed package and grant named users access. Customers inspect it and use **Download all** directly from storage.

The [execution table](components/pipeline-execution-and-data-flow.md) specifies every read/write/handoff; [orchestration](components/job-orchestration.md) owns recovery. Human review holds no running compute.

## What we cut

| Defer | Replacement for the pilot |
| --- | --- |
| Additional engines, separate outbox and generic stage DAG | Two Render workflow task types, one durable jobs table and a short repair pass |
| Cosmos Curator, Ray and Lance | Streaming MCAP/FFmpeg/model adapter, ordinary files and versioned manifests |
| Independent cloud validator and shared-writer takeover protocols | Inline checks, API-controlled consumed multipart writes and unique job prefixes |
| Captions, embeddings, semantic search and deduplication | Human-entered task labels and basic coverage/QC |
| Organization/admin/invitation interfaces | Manual user allowlist and explicit release grants |
| Per-joint correction, advanced 3D annotation and multiple export adapters | Video/hand overlay, whole-clip labels and one documented portable format |
| Automatic processing retries, GPU upgrades and warm workers | Visible failures, manual bounded retries with new job IDs and prefixes |
| Custom backup cron and downloader framework | Managed paid Postgres recovery; standard archive/manifest downloads |

Curator's bounded processing and provenance lessons remain useful. Its integration and licensing research is retained as a [later-stage reference](components/curator-integration-reference.md); it is not an MVP dependency. WiLoR/MANO/FLORA are not default commercial models. [Model rights](components/cloud-processing.md#model-rights) records exact evidence.

## UI handoff

Use shadcn/ui with Tailwind CSS and Radix primitives for the Next.js console; keep the existing Flutter widget/theme approach for mobile. The [UI design](components/ui-design.md) maps components, roles and states; [clickable offline mocks](mocks/index.html) cover collection/upload, internal review and customer delivery. These are design artifacts, not a deployed application.

## Guards worth keeping

Keep immutable capture ownership, offline journals, source hashes, native frame/time mappings and explicit missingness. Record submission intent before invoking processing; a lost acknowledgement never causes a blind second invocation. Workers claim before expensive work, receive scoped upload capabilities and cannot overwrite closed outputs. A retry creates another job/prefix. Reviews and published releases pin exact manifests; later processing cannot silently replace them. Every customer query checks a live grant.

This is a trusted-code pilot with human release approval. Inline integrity checks establish structure/provenance, not independent pose accuracy. Model quality and collection/processing permission evidence are checked before real ingest admission; customer export permission is checked again before publication.

## Build and prove locally first

[Monorepo](components/monorepo.md) defines source/build ownership, including migration of the current mobile submodule after active recording fixes. [Local development](components/local-development.md) defines fake-provider tests, full local CPU end-to-end testing, optional local GPU substitution and the small cloud CPU canary. Changing executor/model profile must preserve the same task/output contracts.

Build in the order in [implementation milestones](implementation-plan.md). Before field use, prove device login, interrupted two-hour upload, bounded long-recording processing, useful hand overlays on real repair footage, staff approval and complete customer download/checksums. Local tests do not establish Modal/R2 production behavior; qualify those on a bounded CPU canary before spending on cloud GPUs.

Budget approximately **$47/month for web/database/disk plus a $1 cron minimum**, measured workflow/CPU usage and storage; a Pro workspace adds $25 if needed. Cron usage may exceed its minimum. No GPU is required for the agreed baseline. Throughput/quality remain unmeasured, so there is no defensible all-in per-video price yet. [Operations/costs](components/operations-and-costs.md) owns assumptions and spend limits.
