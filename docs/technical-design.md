# StateAction.ai: technical design

Updated: 2026-10-31. **Selected MVP design; implementation and deployment pending.** This revision keeps Render Workflows for local/cloud parity and simplifies the earlier Curator design. Automatic hand pose and both staff/customer review remain required. Dataset publication/download is follow-up work; no release page is in the initial UI.

Implementation update, 2026-11-01: the [Node/Python foundation](components/platform-foundations.md) and [Android capture simulation](components/android-h264-implementation.md) are runnable. The full product flow below remains the implementation target; the current Render task is only `verify-platform`.

## Product

A repair worker signs in, records offline and uploads large MCAP recordings reliably. Cloud processing extracts RGB and available sensor evidence, estimates **21 hand landmarks plus explicitly marked model-relative 3D estimates**, and produces review media. Our team reviews each clip, enters a task label and adds approved clips to datasets. Robotics customers browse shared datasets and inspect approved clips; review decisions remain with our team. Whole-dataset versions and complete training-package downloads follow later.

The agreed pilot output does not promise validated metric camera/world trajectories, robot actions or demonstrated policy-training benefit. Missing or unreliable observations remain explicit. Representative repair-footage quality is a launch gate.

The [mobile implementation](components/mobile-app-implementation.md) and [capture format](components/capture-format.md) specify hardware H.264 RGB inside generic-profile MCAP, alongside original sensor timestamps/calibration and available depth/confidence. Historical JPEG sources remain readable. Capture format, native sensor fixes, background uploads and paired Rerun 0.41.0 SDK/viewer qualification are implementation gates, not capabilities established by the existing app.

## Smallest complete stack

| Component | MVP choice |
| --- | --- |
| App/UI/API/login | One Next.js / Node.js 24 / TypeScript service on Render; Better Auth with Google sign-in, account Settings and sign-out |
| Access | One pilot project; operator-managed collector, staff and customer allowlist |
| Catalog and queue | Render Postgres; nine active domain tables plus Better Auth tables; future dataset versions add `releases` |
| Workflow | Render Workflows; the same Node task definition runs under its official local runner and in the cloud; add the export task in the follow-up |
| Recovery | Postgres job records plus a short minute cron repair pass; no separate outbox |
| Bulk storage | Private R2; direct multipart phone/worker uploads and direct viewer reads; future customer archive downloads |
| Processing | Finite Modal CPU `process_recording`; future `export_release` reuses its control protocol |
| Hand model | Pinned MediaPipe Hand Landmarker CPU baseline; mandatory inference, quality-gated |
| Review viewer | One pinned Rerun web viewer on `/clips/[clipId]`, opened from the shared Data browser |
| Data organization | Named datasets with many-to-many approved clip memberships; operator-managed customer view grants |
| Repository | One monorepo including existing Flutter mobile/native plugin, Node apps and Python workers |
| Mobile source | Hardware H.264 inside generic-profile MCAP, Foxglove Protobuf video plus original sensor evidence; historical JPEG decoding retained |
| Local development | Official Render local Workflows runner, same task/processing contracts, local Postgres/SeaweedFS and LocalExecutor; no cloud GPU |

The application platform is Render; storage and processing remain explicit external services. Render hosts no video transfer proxy. A bounded workflow controller starts/polls processing using durable job references; the follow-up export task uses the same pattern. A minute cron repairs dispatch/abandoned controllers and exits; it never processes media.

## Complete flow

1. **Phone → R2:** owner-bound resumable multipart uploads; the API seals the required-file inventory. Completion of all files creates one processing job in the same database transaction, then requests its workflow run; cron repairs a lost trigger.
2. **Modal CPU:** one invocation streams/hashes MCAP, extracts bounded native evidence, runs mandatory hand inference, writes RGB clips, bounded Rerun RRDs/thumbnails and pose arrays, and validates outputs inline. Extraction and inference reuse the same decoded frames.
3. **API:** confirm the known execution ended, output inventory is closed and the current job/input references still match. Atomically register immutable clips and make the result reviewable.
4. **Our team / review:** a Pipeline row opens its recording detail and stage visualization; **Review clips** there opens recording-filtered **All clips** → shared Rerun clip page. Inspect automatic check results, enter a task label, select optional Dataset memberships and Approve or Reject; notes are optional. Approval/assignment commits together. Datasets contain approved clips only; rejection removes every working membership.
5. **Customer / same Data browser:** list granted datasets, open their approved clips and inspect the same viewer read-only. A live dataset grant, membership and latest approval control every new viewer URL. Unreviewed/rejected data and internal notes/QC stay private.
6. **Follow-up only:** freeze one whole dataset and its exact approved reviews, export a complete bounded TAR, then publish an immutable Dataset version for download. No release-management page is required now.

The [execution table](components/pipeline-execution-and-data-flow.md) specifies every read/write/handoff; [orchestration](components/job-orchestration.md) owns recovery. Human review holds no running compute.

## What we cut

| Defer | Replacement for the pilot |
| --- | --- |
| Additional engines, separate outbox and generic stage DAG | One initial processing task, shared jobs table and short repair pass; reuse for future export |
| Cosmos Curator, Ray and Lance | Streaming MCAP/FFmpeg/model adapter, ordinary files and versioned manifests |
| Independent cloud validator and shared-writer takeover protocols | Inline checks, API-controlled consumed multipart writes and unique job prefixes |
| Captions, embeddings, semantic search and deduplication | Human-entered task labels and basic coverage/QC |
| Organization/admin/invitation/sharing interfaces | Manual user allowlist and named dataset view grants |
| Release/Deliveries pages, publication and download | Shared Data browser now; whole-dataset versions/export later |
| Per-joint correction, advanced 3D annotation and multiple export adapters | Rerun video/hand viewer, whole-clip labels and one documented portable format |
| Automatic processing retries, GPU upgrades and warm workers | Visible failures, manual bounded retries with new job IDs and prefixes |
| Custom backup cron and downloader framework | Managed paid Postgres recovery; future standard archive/manifest downloads |

Curator's bounded processing and provenance lessons remain useful. Its integration and licensing research is retained as a [later-stage reference](components/curator-integration-reference.md); it is not an MVP dependency. WiLoR/MANO/FLORA are not default commercial models. [Model rights](components/cloud-processing.md#model-rights) records exact evidence.

## UI handoff

Use shadcn/ui with Tailwind CSS and Radix primitives for the Next.js console; keep the existing Flutter widget/theme approach for mobile. The [UI design](components/ui-design.md) maps components, roles and states; [clickable offline mocks](mocks/index.html) cover collection/upload, Pipeline monitoring and the shared Data browser/clip page. Pipeline rows open recording details with stage visualization and all actions; list rows contain no buttons. [Pipeline monitoring](components/pipeline-monitoring.md). Staff navigation is **Pipeline** and **Data browser**; customers use **Data browser**. It lists datasets by default and an approved thumbnail grid when `datasetId` is present in the URL. Staff also have an explicit All clips view for reviewing processed results before dataset assignment. Clips can belong to multiple datasets without copied artifacts. [Naming and browser contract](components/data-browser-and-datasets.md), [Rerun integration](components/rerun-clip-review.md). These are design artifacts, not a deployed application.

## Guards worth keeping

Keep immutable capture ownership, offline journals, source hashes, native frame/time mappings and explicit missingness. Record submission intent before invoking processing; a lost acknowledgement never causes a blind second invocation. Workers claim before expensive work, receive scoped upload capabilities and cannot overwrite closed outputs. A retry creates another job/prefix. Reviews pin exact manifests; later processing cannot silently replace dataset members. Every customer query checks a live dataset grant and current approval. Future published versions pin exact membership, labels and files.

This is a trusted-code pilot with human clip approval. Inline integrity checks establish structure/provenance, not independent pose accuracy. Model quality and collection/processing permission evidence are checked before real ingest admission; external-review permission is checked before enabling dataset grants, and future export permission before publication.

## Build and prove locally first

[Monorepo](components/monorepo.md) defines source/build ownership and the imported existing Flutter/native recorder. [Local development](components/local-development.md) defines fake-provider tests, full local CPU end-to-end testing, optional local GPU substitution and the small cloud CPU canary. Changing executor/model profile must preserve the same task/output contracts.

Build in the order in [implementation milestones](implementation-plan.md). Before field use, prove device login, interrupted two-hour upload, bounded long-recording processing, useful hand overlays on real repair footage, dataset assignment, staff approval and authorized customer viewing. Complete customer download/checksums are a follow-up dataset-version gate. Local tests do not establish Modal/R2 production behavior; qualify those on a bounded CPU canary before spending on cloud GPUs.

Budget approximately **$47/month for web/database/disk plus a $1 cron minimum**, measured workflow/CPU usage and storage; a Pro workspace adds $25 if needed. Cron usage may exceed its minimum. No GPU is required for the agreed baseline. Throughput/quality remain unmeasured, so there is no defensible all-in per-video price yet. [Operations/costs](components/operations-and-costs.md) owns assumptions and spend limits.
