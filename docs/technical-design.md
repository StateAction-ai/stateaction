# Technical design: repair recording and cloud processing platform

Status: proposed architecture for review. Updated: 2026-10-22. This documentation does not deploy infrastructure or change the capture app.

## Purpose and required behavior

A repair worker signs in, records offline when necessary, and reliably uploads finalized MCAP/sensor data. Cloud CPU/GPU workers produce reviewable evidence and annotations. Our team corrects, reviews and publishes exact revisions. Robotics customers inspect granted deliveries and download the complete training package defined by each release.

All extraction, annotation and dataset packaging run in cloud workers. The phone handles capture and transfer; API functions handle short authorization/control requests. A two-hour recording must not require a two-hour API request, unbounded RAM, a permanently running GPU or repeated raw-MCAP downloads at every stage.

Stera's recorder/client and SDK are source/protocol evidence, not an endorsement of the cloned backend's production quality. The owned backend is designed independently. Existing app/SDK checkouts remain untouched during this documentation work because another agent is fixing capture bugs.

## Read the architecture in this order

| Document | Responsibility |
| --- | --- |
| [Execution and data flow](components/pipeline-execution-and-data-flow.md) | **Canonical processing topology:** exact stage locations, reads/writes, descriptors, native Curator checkpoints and stable batch roots |
| [Backend architecture](components/backend-architecture.md) | Independently selected Node.js/TypeScript service variant and library/migration rationale |
| [Auth and access](components/auth-and-access.md) | Identity, enrollment, collector/staff/customer permissions, offline ownership and session lifecycle |
| [MCAP upload](components/mcap-upload.md) | Finalization, resumable multipart, sealing, part receipts, verification and recovery |
| [Storage and data model](components/storage-and-data-model.md) | App records, object namespaces, Lance batches, retention and recovery |
| [Understanding Lance](components/lance-datasets.md) | Concrete clip-table example, use cases and where dataset files live |
| [Job orchestration](components/job-orchestration.md) | Inngest/alternatives, transactional outbox, Modal submission, claims, waits, retries and budgets |
| [Cloud processing](components/cloud-processing.md) | MCAP/geometry contracts, image/model integration, resource/licensing gates and worker qualification |
| [Review and delivery](components/review-and-delivery.md) | Internal corrections/publication and customer inspection/complete resumable downloads |
| [Operations and costs](components/operations-and-costs.md) | Hosting options, environments, spend admission, observability and runbooks |
| [Implementation plan](implementation-plan.md) | Work packages, dependencies and acceptance gates; no application code implemented yet |

The execution/data-flow document is authoritative for the processing boundaries. In particular, compatible native Curator retries keep the same dataset/media/checkpoint root; a fresh copied Lance table per attempt is not the recovery design.

## Architecture decisions and open choices

| Area | Current recommendation / constraint | Status |
| --- | --- | --- |
| API language | TypeScript; the user selected Node.js/TypeScript when discussing a standalone service | Confirmed preference |
| API hosting | Supabase Edge Functions are a viable managed alternative, but use Deno rather than a conventional Node server; an owned Node service needs a host such as AWS | Hosting/runtime choice still to finalize before implementation |
| Application database | Managed Supabase Postgres; application authorization remains explicit | Recommended |
| Authentication | One human identity authority; qualified Better Auth for the Node variant, Supabase Auth should be evaluated if choosing Supabase-native hosting | Provider/runtime integration remains to finalize; no automatic inheritance from Stera |
| Bulk objects | Private R2 is the cost candidate; S3/Supabase Storage remain alternatives after protocol, transfer and Lance tests | Provider qualification required |
| Orchestration | Inngest Cloud for durable outer workflows; Temporal Cloud remains a credible alternative | Recommended, not activated |
| Compute | Finite Modal CPU/GPU Functions, zero warm GPUs initially | Recommended; CLI installed/authenticated, workers not deployed |
| Internal processing | Curator's Ray Data, canonical Lance clip/span table and native checkpoints | Reuse scoped to qualified pinned recipes |
| Customer contract | Our team approves/publishes; customers inspect/download releases, never accept/reject individual episodes | Required |
| Cost | Minimize fixed services, cheap ingest before requested GPUs, one global GPU admission slot and bounded attempts | Required; no spend configured/authorized by this doc |

The detailed stage diagram shows the Supabase-hosted API option to make physical locations concrete. A Node-hosted API can implement the same contracts without changing object storage, Modal workers or Curator's dataset model. Do not implement both identity systems or two complete backends.

## Control and data paths

| Path | Flow | Payload |
| --- | --- | --- |
| Human control | Phone/browser to authenticated API to Postgres | Identity, assignments, recording metadata, review decisions and grants |
| Upload bytes | Phone directly to authorized object-storage endpoint | MCAP and required sidecars, transferred in resumable parts |
| Workflow control | Postgres outbox relay to Inngest to short API handler to Modal | IDs, contracts, dataset/artifact references and small receipts |
| Processing bytes | Object storage to Modal CPU/GPU workers and back | Prepared sources, clips, frames/sensors, checkpoints and results |
| Native Curator state | Modal/Ray to versioned Lance and recipe staging trees | Span/clip rows, owned enrichment columns and publication evidence |
| Delivery bytes | Protected release objects directly to customer | Complete manifest, independent shards, masks/mappings, schema and loader |

No video payload belongs in Postgres rows, Inngest event state or an API proxy response. A storage URL is not an authorization decision; the API derives exact paths/capabilities from current domain grants.

## Physical processing groups

1. **Modal CPU ingest:** verify source hashes and MCAP, preserve native clocks/calibration, produce bounded prepared sources/frame and sensor shards, compact QC and preview. Stream rather than accumulate two hours of decoded frames.
2. **Modal CPU Curator preparation:** plan spans with `video-cut`, then materialize clips with `video-transcode`. Persist payloads before checkpointing/publishing metadata. Keep input source byte sizes, fragment sizes and outstanding downloads bounded.
3. **Modal GPU enrichment:** run requested embedding then caption recipes against ready batches. Each stage writes its native checkpoint state and commits results to the same canonical dataset. Hand estimation uses a separate qualified adapter and exact native evidence.
4. **Modal CPU review assembly:** join completed requested results, validate references/quality limitations and record an exact dataset/annotation revision for internal review.
5. **Modal CPU release export:** after internal approval, package a frozen selection into portable immutable delivery artifacts. Customers receive grants to this selection and can resume/checksum every file.

Logical stages may share a worker if they actually share a qualified cache/scratch path and have compatible resources. Running two stock CLI recipes in the same container does not guarantee reuse of their downloads or decoded frames. Fresh workers read referenced objects; completed checkpoints avoid recomputing durable work.

## Why use Lance here?

The selected native Curator recipes expect Lance for their canonical table and publication/recovery. It is a versioned dataset format in object storage, not another database server or a mandatory hosted vector database. Keep it inside processing batches. Postgres retains the application catalog; ordinary objects hold raw/media payloads; Parquet/JSON are appropriate for exported arrays, manifests and consumer packages.

The dataset files live in the private derived-data bucket alongside each batch's clips and native checkpoint workspaces. Modal workers open that stable object-store URI using scoped credentials; Postgres records the URI and accepted version. R2 is the proposed provider, subject to pinned Curator/Lance commit and recovery qualification. See the [Lance introduction](components/lance-datasets.md) for a concrete example.

A custom Parquet-and-manifest pipeline could omit Lance, but would replace part of Curator's persistence, column publication and recovery implementation. Reusing those recipes is the reason to accept this format dependency. See [Curator input configuration](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/next/recipes/video_embed/config.py) and [Lance data evolution](https://lance.org/guide/data_evolution/).

Use one dataset per bounded processing batch, linked through the application catalog. Freeze batch row readiness before native downstream enrichment. Preserve the stable dataset URI, input references, physical fragment layouts and compatible result contracts across retries. Initially serialize canonical writers and confirm old worker termination plus write-capability expiry/revocation before takeover. A DB lease alone cannot stop object-store writes.

## Integrity, quality and publication invariants

- A finalized local file, completed storage upload, verified MCAP, successful processing run, approved annotation and published release are distinct states.
- Seal the logical required-file inventory before ingest. Same-content transfer recovery can use another physical generation; changed content requires another sealed revision/run.
- Treat ETags as multipart/object metadata, not a full recording SHA-256. The first cloud CPU ingest computes and compares the independent content hash.
- Preserve native timestamp integers, clock domains, exact frame association, per-frame intrinsics and pixel transforms. Preview FPS is not a training clock.
- Missing hands/depth/alignment remain explicit masks/unknowns. Model predictions and reviewer judgments do not become measured ground truth.
- Stable IDs, native checkpoints and validated commits make retries recoverable; they do not guarantee exactly-once billing or external side effects.
- Review/release selections pin exact dataset/label/artifact revisions. Future curation must not rewrite already published deliveries.
- Commercial model rights and geometry qualification are independent gates. WiLoR/MANO and FLORA restrictions remain relevant even if cloud execution succeeds.
- Domain provenance survives identity retirement through a retention-aware policy. Direct user cascades must not delete shared datasets/releases.

## Long-recording platform feasibility

Supabase-hosted API functions authorize direct uploads; they do not carry the two-hour video body. Supabase Storage's documented paid S3 multipart path allows up to 500GB subject to configured limits, while Free's 50MB cap is unsuitable. Its unfinished multipart uploads expire after 24 hours; evaluate field connectivity and chosen storage provider. Duration/resolution alone do not determine MCAP bytes. [Storage limits](https://supabase.com/docs/guides/storage/uploads/file-limits), [multipart behavior](https://supabase.com/docs/guides/storage/uploads/s3-uploads).

Inngest can wait durably between short job-control steps; Free's published maximum run length is 30 days including waits. Modal asynchronous Functions can be configured up to 24 hours per invocation, with a five-minute default. Set explicit stage limits and divide longer processing into checkpointed batches. An Inngest wait does not extend a Supabase request's own runtime. [Inngest limits](https://www.inngest.com/docs/durable-execution/limits), [Modal timeouts](https://modal.com/docs/guide/timeouts).

These are documented platform capabilities, not an end-to-end qualification of a two-hour Stera recording. Measure peak RSS, scratch capacity, source-byte amplification, throughput, retry behavior and total costs on the exact image/storage/runtime combination.

## Release and cost policy

The first useful profile can be reviewed RGB/semantics with honest limitations; metric motion supervision requires independent evidence. Enable expensive model stages only when a delivery or evaluation requires them. Corpus-wide embeddings/deduplication should earn their cost through an actual selection/retrieval need.

Count CPU/GPU startup, inference, retries, workflow executions, transfer, cache and retained artifact copies. Keep gross costs separate from credits; the publicly advertised Modal allowance is not proof of this account's activated balance. No GPU/image build/cloud processing was run while writing these docs. Public prices and planning examples are in [operations](components/operations-and-costs.md).

## Implementation boundary

Implement an owned backend/client contract, independently qualified identity, resumable upload and core cloud ingest before optional models. Ship internal review and customer delivery together. The [implementation plan](implementation-plan.md) defines work packages and acceptance evidence; coding/deployment starts only after the hosting/auth decisions are settled and appropriate execution scope is established.
