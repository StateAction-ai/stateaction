# Cloud processing implementation plan

Status: proposed design; source and local capture evidence inspected on 2026-10-22. No cloud image, Function, Volume, Secret or processing job was deployed as part of this plan. Modal CLI and local skill both report version 1.6.2.

This component converts a finalized MCAP recording into verified, reviewable, versioned artifacts. It runs entirely on cloud CPU/GPU workers. The [canonical processing execution and data-flow document](pipeline-execution-and-data-flow.md) defines the topology, read/write boundaries and handoffs; it supersedes earlier per-attempt Lance-copy proposals. Our team subsequently reviews the results; robotics customers receive published delivery versions and bulk downloads. Processing success, internal approval and suitability for a particular training task are separate decisions.

See the [main technical design](../technical-design.md), [upload contract](mcap-upload.md), [storage and data model](storage-and-data-model.md), [orchestration](job-orchestration.md), [auth and access](auth-and-access.md), and [review and delivery](review-and-delivery.md).

## 1. Decisions and scope

1. Use private, finite Modal Functions for CPU/GPU execution with Postgres domain records and a transactional `event_outbox`. Inngest Cloud coordinates application jobs; alternatives are compared in the [orchestration design](job-orchestration.md). The existing Bun/Hono backend is inspected reference code, not a production-quality assumption or approved foundation. The canonical diagram illustrates Supabase Edge TypeScript Functions on Deno; an independently hosted Node.js/TypeScript service implements the same contracts. Hosting/auth adoption remains a separate decision, and SDK/runtime compatibility must be qualified. Curator's Ray runtime remains inside one Function invocation and does not orchestrate application jobs.
2. Validate file integrity, capture structure, timestamp provenance and raster/calibration consistency before admitting expensive inference. A failed capture must not consume GPU time.
3. Decode Stera MCAP with our versioned capture adapter. Curator accepts prepared video; it does not replace MCAP decoding, sensor association or hand-pose estimation.
4. Start with compact QC, source frame mappings, native sensor sidecars and a browser preview. Curator clipping, corpus embeddings, captions, hand inference and large diagnostic replays are enabled by the requested processing profile. They are not prerequisites for preserving a recording or showing it to our reviewers.
5. Reuse Curator's stable canonical Lance/media/checkpoint root per bounded processing batch across compatible attempts. Attempt IDs identify logs, ownership and accounting, not replacement datasets. Initially one external writer owns the batch at a time; confirmed termination and capability expiry/revocation are required before takeover. Published release roots remain inaccessible to processing writers.
6. Treat inferred hand joints, captions and similarity scores as model outputs with explicit provenance. Missing or unverified measurements retain false validity masks and missing values. Never synthesize robot actions, torso pose, metric world motion or verified depth synchronization from absent evidence.

## 2. Existing implementation versus proposed service

| Component | Existing evidence | Proposed implementation |
|---|---|---|
| MCAP decoding | `stera-sdk` ROS2/CDR reader and local inspection scripts | Pinned, isolated CPU image with bounded decoding and structured error codes |
| Capture geometry | `scripts/capture_geometry.py` supports Android contracts v1/v2/v3, exact event association and per-frame calibration | Preserve these semantics in the cloud adapter; new versions require explicit adapters and fixtures |
| Local processing | `scripts/process_geometry_capture.py` writes HDF5, preview, Rerun and reports, defaults CUDA off, and requires audited SDK commit | Reuse tested geometry logic; separate production extraction from research inference and expensive diagnostics |
| Existing video export | SDK `_RGBMP4Writer` writes constant-FPS MP4 | Keep a presentation artifact plus an independent exact source-frame/PTS mapping |
| Hand reconstruction | MediaPipe observations and experimental reconstruction; separate WiLoR research environment | Optional cloud adapters with model-specific images, licensing admission and independent quality masks |
| Curator | Pinned source inspected; no Modal deployment qualified | Source-built image, direct recipe CLI, local Ray, stable per-batch Lance/media root and native recovery |
| Scheduling | No cloud pipeline implementation established by this audit | Inngest durable control flow; Postgres outbox/domain attempts and private Modal calls; batch-writer ownership around native recipes |
| Delivery | SDK episode files are useful export inputs | Product-specific, versioned exporter after internal review; explicit supported fields and omissions |

The physical Pixel v3 receipt records 186 RGB frames and successful decoding, but zero geometry-consistent hand estimates and `metric_accuracy_validated=false`. Successful capture and export therefore do not establish valid 3D hand supervision. The acquisition repair and independent accuracy assessment remain separate. See [v3 regression](../geometry-v3-capture-regression.md) and [physical processing receipt](../validation/pixel-v3-processing.json).

## 3. Stage graph and required artifacts

Versioned Inngest workflow code defines control flow and persists the domain stage graph/results in `stage_jobs`; the UI reads the application records. These processing contracts are independent of API hosting. A profile determines which optional branches exist. Missing optional branches have an explicit `not_requested` capability, not a fabricated successful result. V1 coalesces source verification, extraction, compact QC and preview into one physical `ingest_capture` job, using one raw MCAP network stream per fresh ingest followed by local parser reads. A failed fresh ingest may download it again; native Curator checkpoints do not automatically supply MCAP-ingest recovery.

| Stage key | Runtime | Input | Required output | Admission / downstream behavior |
|---|---|---|---|---|
| `ingest_capture` | CPU | Sealed recording's uploaded raw MCAP and required metadata | Server hash, bounded prepared RGB sources and native frame/sensor shards, calibration/index/mappings, compact QC and preview | Hash verification occurs here; establishes immutable inputs and bounded batch membership |
| `prepare_clips` | CPU with local Ray | Batch's prepared-source manifest and mapping | `video-cut` span rows, `video-transcode` clips, durable Parquet/checkpoints and native publication receipt | Same stable batch `media_root`; freeze row set and verify all required transcode outputs before GPU |
| `embed_clips` | GPU with local Ray, optional | Same dataset, ready clip references and pending owned embedding fields | Native checkpoints then embedding/status columns and Lance commit | Reuses canonical table and compatible workspace; records actual snapshot/version and row errors |
| `caption_clips` | GPU with local Ray, optional | Ready clip table and required transcode receipt | Caption files, recipe-specific recovery state, caption/provenance fields and commit | Initial stage barrier follows requested embedding; preserve caption's own recovery contract |
| `estimate_hands` | Qualified CPU baseline or separate GPU, optional | Native RGB shards and exact calibration/depth/pose windows | External per-frame observations, confidence, transforms, QC and masks; controlled catalog references | License-allowed model only; a controlled writer adds owned reference/summary columns without rewriting row layouts |
| `assemble_review` | CPU | Pinned completed batch versions plus all enabled branch results | Durable review-package manifest and UI summary | Joins enabled branches, checks capabilities and records exact versions; no full dataset copy |
| `export_release` | CPU, separate postapproval workflow | Frozen approved revisions and delivery schema | Shards, checksums, manifest and exporter report | Detailed in review/delivery; no customer episode approval step |

Preview generation is an ingest substep after structural checks. Native stage barriers are `prepare_clips` → requested `embed_clips` → requested `caption_clips`; disabled branches are skipped explicitly. Hand payload computation can be independent, but any canonical-table update must acquire the same batch writer ownership. Redaction is a profile-controlled operation whose required outputs block the affected path if unavailable. Separate CPU/GPU stages reuse the same dataset root; they do not need a copied Lance workspace at every handoff. Export resolves frozen approved versions and label revisions rather than mutable latest state.

Inngest and the API exchange small descriptors: recording/run/batch/job IDs, dataset URI, expected upstream commit/version, result-contract digest and source/selection-manifest reference. Media flows directly between Modal and object storage. Those version/selection values are our preflight/provenance fields, not invented native recipe YAML options. Native recipes register/validate fields and pin their own snapshot; the wrapper records the actual version and receipt used.

## 4. MCAP and geometry contract

### 4.1 Source validation

Admit the first CPU job after the recording is sealed, every required file transfer is uploaded, expected sizes/object identities are recorded and the client-expected application SHA-256 is persisted. The transfer state is `uploaded` and verification remains pending at this point. The `ingest_capture` validator establishes the independent server SHA-256 while reading the source bytes and compares it with that expected identity; only its accepted result marks verification complete. Do not require a server hash before admitting the worker that computes it. ETag is not the recording checksum.

Read MCAP magic, records, channels/schemas and finalization metadata before model work. Validate CRCs where present, and distinguish an absent optional CRC from a failed CRC. Missing summary/index data is not automatically evidence that every message is corrupt: use an explicitly supported bounded scan/reindex path or quarantine. The current SDK summary helper assumes a summary/statistics object exists, so wrap this condition instead of leaking an attribute error. Never silently repair or overwrite the raw MCAP.

Reject recordings whose metadata explicitly declares `capture_result_valid=false` or `finalization_complete=false`. Zero encoded RGB frames is a capture failure even if IMU and geometry diagnostics are present. Preserve capture error counters and distinguish encoding attempts from repeated ARCore render-loop events. Enforce configured compressed size, decompressed bytes, dimensions, frame counts and execution limits to bound malformed-file expansion.

### 4.2 Preserve all clocks and associations

The v3 Android contract is `android_arcore_cpu_v3`:

- `frame_timestamp_ns` identifies the acquiring ARCore Frame event.
- `rgb_timestamp_ns` is the native CPU image timestamp.
- `android_camera_timestamp_ns` is preserved from `Frame.getAndroidCameraTimestamp` and may be zero when unavailable.
- `depth_timestamp_ns` is the native depth acquisition timestamp when depth exists.
- RGB `log_time` identifies the frame event, while its header/publish time preserves the native image clock. Depth and pose must follow their recorded versioned contract.
- `rgb_frame_association=Frame.acquireCameraImage_same_frame` establishes association by acquisition provenance. Equality or proximity between unrelated clock values does not establish synchronization.
- `cross_stream_clock_verified=false` and `depth_time_verified=false` remain false unless a future independently verified clock calibration explicitly supersedes the contract.

Require one encoded RGB event to match exactly one geometry row. Reject duplicate/ambiguous events, metadata/row version disagreement, and incorrect per-topic header/publish associations. Check monotonicity within each documented source clock, not by ordering timestamps across different sources. Preserve raw values before any optional sorting or presentation normalization.

JSON serializes nanosecond values as decimal strings to avoid JavaScript integer precision loss. Columnar storage uses explicitly typed integer fields with declared domains/units. Keep null for missing timestamps; never replace missing data with zero where zero is a legitimate source value. Store any derived normalized timeline alongside its mapping and evidence, not in place of the source clock.

Keep IMU samples on their own native timeline. The current versioned adapter deliberately clears the SDK's nearest-RGB-time IMU association because a shared timebase is unverified. Export the original IMU stream and mark cross-modal alignment unavailable; do not resurrect that nearest-neighbor join in the cloud or dataset exporter.

### 4.3 Pixel geometry and coordinate frames

Retain native RGB/depth pixels, raster dimensions, crop, distortion model, per-frame intrinsics, recorded RGB-to-depth pixel mapping, tracking state and optical-to-link transform. The current versioned Android optical-to-ARCore transform is diagonal `[1, -1, -1]`; verify recorded transforms rather than assume a global display rotation.

Dimension checks, valid focal lengths, finite matrices and mapping consistency are contract checks. They do not prove external metric calibration accuracy or depth age. ARCore map coordinates describe that recording's tracking frame and its tracking validity; they are not a measured robot/world reference or torso trajectory.

If a preview or model input rotates, mirrors, crops or resizes pixels, store the exact transform and coordinate convention. Transform 2D predictions back to native pixels before geometric association. A rotated image with unmodified intrinsics is invalid for reconstruction. Legacy 180-degree hypotheses remain diagnostic-only and cannot be enabled automatically for unrelated recordings. iOS and future Android versions need separate supported adapters; this Android v3 evidence does not qualify them.

### 4.4 Frame index and preview mapping

The authoritative frame index contains at least:

| Field | Meaning |
|---|---|
| `source_frame_index` | Stable decoded-frame order for this source hash and decoder version |
| `frame_event_timestamp_ns` | Native event association, stored without float conversion |
| `rgb_timestamp_ns`, `android_camera_timestamp_ns`, `depth_timestamp_ns` | Separate native clock values |
| `source_channel_id`, `source_message_ordinal` | Reproducible message identity; add offsets when available |
| `geometry_row_id`, `pose_event_id`, `depth_event_id` | Exact recorded associations or null |
| `native_width`, `native_height`, `pixel_transform_id` | Raster and transform identity |
| `preview_frame_index`, `preview_pts`, `preview_time_base` | Presentation mapping, including duplicates/dropped frames |
| `decode_valid`, `tracking_valid`, `depth_present`, `rejection_reasons` | Independent facts, not a single global quality score |

A constant-FPS preview is acceptable for viewing. Its time axis does not become the training clock. If resampling duplicates frames or skips source frames, represent that explicitly. Curator clip boundaries refer to prepared-video PTS; compose the video-to-source mapping into each clip record. Caption sampling and hand inference each retain their own exact source-frame selections. Do not align annotations by `frame_number / advertised_fps`.

### 4.5 Long recordings and bounded preparation

Keep a two-hour capture as one logical recording while processing it in bounded batches. The new ingest adapter streams raw bytes to scratch while computing SHA-256, then parses/indexes progressively. Native frame/sensor/calibration shards and indexes must be written in bounded chunks; the existing geometry helper caches depth and associations and is not established as a memory-safe long-recording implementation.

Generate independently decodable prepared RGB sources with both duration and byte limits. One to five minutes is an initial qualification target, not a memory guarantee. Set the byte ceiling from measured source copies, Ray object-store overhead, worker RAM and concurrency; shorten a source instead of silently reducing required visual quality. Bound output rows/physical Lance fragments and in-flight downloads too. The native publisher materializes whole fragments, so small scanner batches alone do not bound publication RAM.

Preserve original JPEG/native encoded pixels in indexed bounded shards, with native acquisition timestamps and geometry records. A presentation/proxy video is not automatically suitable for metric hand estimation. Frame evidence, sensor windows and clip-to-source mappings let each model select the correct authorized input variant without reopening a complete raw MCAP.

Native `video-transcode` downloads a whole prepared source into bytes, hands it through Ray, stages `source.mp4` and produces bounded FFmpeg output batches. Therefore a small target clip duration does not make a two-hour source safe. Use one canonical Lance table per bounded batch, freeze its row set before inference, and catalog all batches under the recording.

## 5. Artifact and manifest interface

### 5.1 Worker input

All workers accept one versioned input object. The backend resolves and authorizes references before dispatch; clients cannot submit arbitrary buckets, object keys, model paths or commands.

```json
{
  "schema_version": "processing-job/v1",
  "recording_id": "rec_example",
  "processing_run_id": "run_example",
  "batch_id": "batch_example",
  "stage_job_id": "stage_example",
  "job_attempt_id": "attempt_example",
  "stage_key": "embed_clips",
  "claim_epoch": 3,
  "input_manifest_artifact_id": "artifact_input",
  "input_manifest_sha256": "<sha256>",
  "media_root": "<authorized stable owner/org/recording/run/batch prefix>",
  "dataset_uri": "<media_root>/lance",
  "expected_upstream_version": 7,
  "selection_manifest_artifact_id": "artifact_batch_selection",
  "result_contract_digest": "<sha256>",
  "profile_revision": "capture-embed/v1",
  "config_sha256": "<sha256>",
  "attempt_receipt_root": "<authorized owner/org/recording/run/attempt prefix>",
  "deadline_utc": "2026-10-22T23:00:00Z"
}
```

Actual IDs, timestamp and hashes are resolved per invocation; the example is not a runnable job or Curator YAML. Ingest has no upstream Lance version and instead references the sealed source inventory. Credentials and signed download URLs are excluded. The backend authorizes every reference, checks expected versions/contracts/readiness and issues runtime capabilities. Native recipes select their own validated snapshot; schema registration may advance the version before processing. Do not translate `expected_upstream_version` or `selection_manifest_artifact_id` into nonexistent public recipe fields.

### 5.2 Stable canonical batch and attempt layout

Configure each bounded batch's stable `media_root` under its owner/org/recording/run prefix, for example:

`{userId}/orgs/{orgId}/recordings/{recordingId}/runs/{runId}/batches/{batchId}/`

The root contains `lance/`, `clips/` and native recipe `staging/` trees. Prepared sources and immutable frame/sensor/calibration shards live under declared run/batch input prefixes referenced by their manifests. The raw MCAP is referenced rather than rewritten. Exact bucket/key conventions are defined by [storage](storage-and-data-model.md).

Attempt-specific `logs/`, diagnostics and final application `result.json` use:

`{userId}/orgs/{orgId}/recordings/{recordingId}/runs/{runId}/attempts/{attemptId}/`

These receipt directories do not become replacement Lance roots. Transcode, embedding and caption workers open the same canonical batch dataset and add only their owned output fields under compatible native contracts. Stage acceptance records the validated canonical commit/version and immutable payload references in Postgres; it does **not** copy a complete dataset after every stage.

### 5.3 Writer ownership, native recovery and acceptance

Initially one logical external writer owns a batch at a time, even where native field-level concurrency would be possible. A short DB transaction claims `(batch_id, stage_job_id, attempt_id, claim_epoch)`, reserves resources and records an absolute start/execution deadline. The worker atomically claims its invocation before receiving write capabilities or loading models. Claim expiry alone does not prove storage writes have stopped.

Before another attempt or stage receives access to the same root, confirm prior provider execution is terminal and its write capabilities have expired or been revoked. Then validate checkpoint compatibility and resume the intact native workspace. If ownership is uncertain, pause the batch or deliberately create a separate new run; do not grant competing writers access to the same root. A DB epoch alone is insufficient fencing for an already issued object-store credential.

Recovery identity includes the dataset URI, input field identities, result contract, staged schema and selected fragment/file layout. Keep source media, input values and physical fragments immutable. No compaction, row deletion, data-file rewrite or transaction-history pruning during the recovery lifetime. Changing execution tuning or refreshing credentials need not invalidate compatible recovery, but changed source content or an incompatible contract requires an explicit new run/dataset or versioned field contract. Preserve a saved selection; do not expand it with new work mid-recovery.

Native transcode/embed persist result Parquet and checkpointed IDs together, publish an atomic owned-column update with a receipt, verify canonical files, and then clean eligible staging. Caption currently uses recipe-specific recovery; preserve its own files/history. Cut is a producer with a different append/recovery path, not an enrichment workspace to fabricate. A fresh Ray cluster can recover durable work without old container RAM. Completed payloads must be durable before their IDs are checkpointed.

Treat completion manifests as untrusted even with a valid attempt token. A bounded cloud validator can inspect object checksums, schema, counts, row errors, canonical dataset/receipt state and reference closure; short API requests accept only its small verified receipt. Check active claim, expected inputs and actual canonical commit/version before updating the stage row. No bulk hashing/copying runs inside a long HTTP handler. Callback loss is recovered from the durable dataset/receipt, not by repeating completed inference.

Canonical mutable processing data is distinct from a published customer release. Review packages pin completed batch versions and immutable annotation revisions; later compatible stages may add columns while preserving their input file bindings. A release freezes the approved selection. If isolation or portability requires copying payloads, perform it once as a bounded cloud export/promotion operation to a unique protected destination, validate closure/checksums, and publish only after success. Processing workers never receive write access to that release root. Copying a Lance manifest alone does not close external payload references.

Keep stable logical job identities from source/batch identity, stage, inputs and result-defining revisions. Per-attempt IDs remain useful for claims, logs and spend accounting while the dataset/checkpoint identity remains stable.

### 5.4 Result manifest

`result.json` contains schema version, recording/run/batch/job/attempt/claim IDs, source and selection-manifest hashes, dataset URI, expected and actual upstream versions, resulting canonical commit/version and native receipt/contract identity, SDK/adapter/image/model/config revisions, artifact references/checksums/sizes, coordinate/clock contracts, counts, capabilities, errors, warnings and observed resource use. It records Modal call ID when available and explains unsupported or omitted modalities. Successful staging cleanup must not remove this permanent application receipt.

Required quality distinctions include `decode_valid`, `association_valid`, `calibration_contract_verified`, `depth_registered`, `depth_time_verified`, `tracking_valid`, `model_detected`, `geometry_consistent`, `joint_visibility_supported`, and `metric_accuracy_validated`. A high detector confidence does not set the latter fields. Keep original model predictions separate from accepted observations/masks. Represent unsupported 3D values with null/NaN and false masks; do not zero-fill them as valid labels.

Only the backend/controller updates authoritative `recordings`, `processing_runs`, `stage_jobs`, `job_attempts` and `artifacts`. Worker success responses contain small result references, not bulk arrays or video. Permanent manifests and Postgres remain authoritative after Modal's result retention expires.

## 6. Curator image and runtime adapter

Pin `NVIDIA/cosmos-curator@84f54d844bfc6fdf839848f6644f3fc893f52209` for the first qualification. This inspected source is v2.9.0; the inspected public NGC catalog lists 2.3.0 as its latest image. Do not invent a `:2.9.0` public tag or mix old image behavior with current recipe documentation.

Next is an incubation namespace whose configuration/recovery contracts can change. The inspected transcode note does not claim its full managed-scale/worker-loss benchmark has run. Pin the source, image and native formats and qualify our exact Modal/storage deployment rather than inheriting a production-scale claim.

Build once using Curator's image builder, include `legacy-transformers` for the initial embedding recipe, and retain automatically included `default` and `model-download` environments. Omit optional SAM3, SeedVR, style-transfer and cuML environments until required. Publish the build to our registry and pin its digest in Modal. Use a compatible Linux AMD64 image and ensure the Modal wrapper Python does not replace locked Pixi/Torch/vLLM dependencies. Curator's full internal image/codecs and model assets still require applicable license compliance.

Run this argv in the worker, with `cwd=/opt/cosmos-curator`:

```python
["pixi", "run", "--as-is", "run-pipeline", "/tmp/job.yaml", "--json"]
```

Generate recipes from allowlisted typed configurations. Do not pass client shell fragments or arbitrary `--set` values. Do not invoke `cosmos-curator local launch`, a nested Docker daemon, the image's default NVCF service, or an external persistent Ray cluster.

For `video-cut`, use bounded prepared MP4 sources and fixed-stride spans initially. `video-cut` plans spans; `video-transcode` creates the clip media. Run both as the CPU `prepare_clips` stage against the batch's stable `media_root`. Freeze the batch row set and verify the native transcode publication receipt before inference. CPU H.264 transcode uses the qualified FFmpeg codec and does not require NVENC. Start whole-media I/O concurrency at `COSMOS_CURATOR_RAY_IO_SLOTS_PER_NODE=2`, with source byte/duration and publication fragment limits established by qualification.

For `video-embed`, the separate GPU `embed_clips` stage uses the same canonical dataset and starts with `variant=336p`, `inference_concurrency=1`, `inference_batch_size=1` and a small read batch. The Ray GPU actors invoke `legacy-transformers`, so that Pixi environment must exist. Batch several clips per invocation to amortize model startup. The optional GPU `caption_clips` stage follows the barrier and uses its required transcode provenance; preserve its recipe-specific workspace. Separate images/GPU sizing can therefore be used without relocating Lance. A warm container does not retain a model after its CLI subprocess exits; persistent-model reuse requires its own measured design.

The inspected reference transcode/embed recipes operate on their validated pending fragments and do not expose a general public arbitrary-selection or input-version YAML field. Keep bounded batch membership frozen and use wrapper preflight/provenance plus exclusive writer ownership. Do not invent `input.version`, `max_fragments` or generic caption engine kwargs as supported recipe options.

With no `RAY_ADDRESS`, Curator initializes local Ray. Allow the recipe to initialize it during the first qualification. If changing object-store allocation requires pre-starting Ray, also advertise its required custom `curator_io` resource and preserve child environment configuration. A missing custom resource can leave work unschedulable even when CPUs/GPUs are present.

Keep stdout JSON separate from stderr and leave `COSMOS_CURATOR_TEE_STDOUT_STDERR` unset. Exit zero may include terminal row errors. Inspect canonical statuses, error fields, selected/remaining/error counts, required object existence and schema before accepting the stage. Curator may clean staging `workspace.json` and checkpoints after successful publication; our permanent result manifest must not depend on those files surviving.

### Actual read and recovery boundaries

| Boundary | What is read or retained |
|---|---|
| Fresh MCAP ingest | One network stream while hashing, followed by local parser passes; an unrecoverable ingest retry may stream again |
| Prepared sources to cut | Probe may read ranges or download the source; scene detection has its own reads |
| Cut to transcode | Checkpoint filtering precedes grouping by source; each needed bounded source is downloaded for remaining spans in that processing pass |
| Transcode memory | Whole source bytes enter Ray, a temporary source MP4 is written, and one bounded FFmpeg output batch is retained; no claim of constant RAM from short clip duration |
| Transcode retry | Durable span IDs/results skip completed work; partially unfinished sources may download again; publication-only retry can reuse staged metadata |
| Embedding / caption | Each recipe reads its clip payloads; prior container decoded frames and scratch are not automatically shared |
| Native checkpoint state | Transcode/embed keep durable Parquet results, row addresses and ID checkpoints until verified publication; caption keeps its own recovery state |
| Hand estimation | Reads native frame/sensor shards, writes external per-frame observations and masks; a controlled owner adds catalog references |

Invoking two stock recipe commands in one container does not establish a shared cache. Reuse scratch or fuse stages only after implementing and validating an explicit adapter; otherwise account for the actual rereads. Native replay can rewrite a deterministic clip destination, so writer termination/capability rules apply before reuse.

## 7. Model cache, secrets and object storage

Mount a Modal Volume at `/config/models`; Cosmos Embed expects `/config/models/nvidia/Cosmos-Embed1-336p/`. Curator's HF download cache is a separate path, `/config/default_workspace/weights/hf_home/`, and must not be confused with staged weights.

Use one controlled CPU cache-preparation job to fetch licensed, pinned assets, verify hashes and commit the Volume. Consumers reload committed state as required. Separate immutable revision directories and a model inventory prevent partial/concurrent downloads from masquerading as a ready model. Keep inference cache writes serialized; do not delete assets while active jobs reference them. Cache model weights here, while canonical data and durable manifests remain in R2/S3.

Keep stable bootstrap/controller and permitted model-hub credentials in Modal Secrets. After the atomic attempt and batch-writer claim, exchange the backend capability for short-lived object credentials scoped to authorized inputs, the batch mutation/recovery prefix and attempt receipts. Compatible retries reuse the same dataset path with newly issued credentials; they do not inherit a still-running writer's access. Never issue a published-release write key to processing workers. Before importing or starting Curator, write credentials into a mode-0600 temporary file and set `COSMOS_S3_PROFILE_PATH` to it. The selected `execution.storage_profile` must exist there. An R2 profile includes access key, secret, `aws_session_token` for temporary credentials, `region=auto` and account S3 endpoint; recipes use `s3://bucket/key` URIs. An AWS profile uses the actual region and normally omits a custom endpoint. The inspected parser propagates session tokens into object and Lance clients; expiry, permissions, renewal and same-root takeover still need qualification.

One Curator recipe selects one storage profile globally. Do not assume it can read an AWS bucket and write an R2 bucket merely because both use `s3://` URI syntax. Resolve cross-provider staging explicitly. Qualify R2 with both the ordinary object client and Lance/PyArrow, including restart, listing, conditional writes and concurrent-writer rejection. An S3-compatible API or a successful MP4 download alone does not qualify Lance commits. Direct object APIs, rather than a FUSE mount, are the first qualification target.

The application enforces authorized input/output references. A worker must atomically claim its assigned attempt/`claim_epoch` and batch ownership through the backend before model download or source/output capability issuance. Duplicate invocations that fail this claim exit before heavy work; container startup cost can remain. Use exact scoped URLs or qualified temporary credentials with session-token propagation. Canonical batch mutation is allowed only for the current owner under the immutable-input/owned-field contract; arbitrary company-wide storage and published-release writes are forbidden. If storage permissions, expiry and confirmed single-writer takeover cannot be enforced, fail qualification or change the provider/isolation design. Do not substitute unrestricted shared credentials. Job JSON, logs and permanent manifests exclude secrets, signed URLs and raw household images. Service roles and final-release publication credentials remain server-side. See [auth and access](auth-and-access.md).

## 8. Resource selection and model admission

These are qualification targets, not measured minimums or throughput commitments. Choose the final shape using representative recordings and record wall time, startup, peak VRAM/RAM, scratch bytes and failure rate.

| Workload | Initial qualification target | Important limit |
|---|---|---|
| Structural validation / bounded decode | CPU, 2–4 physical cores, 8–16GiB RAM | Stream/index/shard a long recording; current helper caches depth/associations and is not a proven two-hour processor |
| Curator cut/transcode | CPU, 4–6 physical cores, 32GiB RAM | Byte/duration-capped prepared sources, bounded fragments, I/O slots and scratch; source and publication memory are not bounded by output clip duration |
| Cosmos Embed1 336p | L4 24GB, 4–6 CPU cores, 32GiB RAM, batch 1 | GPU fit is inferred, not benchmarked on Modal; NVDEC and child Pixi environment must work |
| Bounded caption adapter | L40S 48GB, conservatively 128GiB host RAM | Explicit context/KV/concurrency controls and adapter qualification required |
| Unchanged inspected caption recipe | H100 80GB, conservatively 128GiB host RAM | Safer first test target, still unqualified for actual input length and default context |
| WiLoR research | Isolated 24GB-class qualification target | Local RTX 3090 forward evidence is not a Modal benchmark or commercial permission |

The inspected caption model, Qwen3.8-27B-FP8, stores roughly 28.74GiB of tensors, already exceeding a 24GB GPU before activations/KV cache. Its native 262,144-token context makes default sizing materially different from a deliberately bounded context. The inspected plain Next recipe does not expose a generic model-engine kwargs YAML override; an L40S plan requires an explicit adapter/patch, not an invented configuration field. Ada FP8 execution and Ampere fallback execution are not interchangeable performance evidence.

Curator's image defaults Ray object-store memory to 40% of host RAM. On 64GiB, remaining logical memory can fall below the caption graph's 24GiB and 16GiB actor reservations. Start caption qualification at 128GiB or deliberately tune and verify object-store/actor allocation. Modal shared memory and Ray spill behavior remain unqualified; a Docker launcher's shared-memory setting does not carry into Modal.

NVIDIA A100/H100 support video decoding, while NVENC availability is a different capability. Check the actual GPU, host-exposed video libraries, container codecs and any partitioning; never infer NVDEC from CUDA availability alone. Current Modal CUDA guidance is compatible in generation with the inspected CUDA 13.0.3 image, but a documented driver version is not a successful container canary.

Use separate images for MCAP/MediaPipe, Curator and experimental WiLoR. The audited WiLoR research environment uses legacy NumPy/Chumpy requirements that conflict with the SDK's NumPy floor. Do not force them into one production environment or disable safe checkpoint loading globally.

Model admission is an explicit registry check before dispatch: source revision, weight hash, intended usage, license status, consent scope, required hardware and validation status must match the processing profile. WiLoR's noncommercial terms, MANO's separate terms and detector dependencies block treating that branch as commercially cleared. MediaPipe code/model terms and notices must also be recorded for the actual pinned asset. FLORA's full annotation workflow has a released GPU-memory guard of at least 75GiB aggregate and noncommercial restrictions; it is not a bootstrap default. Cosmos Curator's Apache license does not relicense every model it can run.

## 9. Execution limits, reliability and cost

Initial Modal Functions use `min_containers=0`, `buffer_containers=0`, `max_containers=1`, finite stage-specific `timeout`/`startup_timeout` and no provider automatic retries. Use single-use containers initially to simplify Ray cleanup. Model loading inside the Function consumes the execution timeout; startup timeout is not an unlimited model-loading allowance.

GPU caps are per Function. Separate embedding, caption and hand Functions therefore need a global Postgres GPU admission lease and budget reservation before submission. A batch writer lease is a separate constraint: CPU preparation and GPU enrichments also serialize mutation of the same canonical root. Release reservations only after reconciling terminal compute state. Before granting that root to another writer, also confirm old write capabilities expired/revoked. An expired DB lease or cancellation request alone does not establish either fact. Cancellation uses the stored Modal call ID and reconciles its observed state; unresolved execution pauses takeover.

Inngest uses short control steps to invoke private Functions through the qualified TypeScript/Modal adapter, persist `functionCallId`, and observe accepted `stage_jobs`/`job_attempts` and batch dataset versions. The canonical diagram's Supabase Edge/Deno deployment needs its own SDK/HTTP adapter and signature verification tests; previously inspected Node/Bun examples do not establish that deployment. A separately hosted Node.js/TypeScript service can implement the same JSON contracts without inheriting Stera's backend. Use durable waits and bounded status checks/events instead of holding an HTTP handler open during inference, validation or export. Engine state contains IDs, dataset/version/contract/selection descriptors and receipts, never media or bulk arrays. Postgres `event_outbox` closes the DB-to-event-publication gap.

Durable step completion does not make Modal submission exactly once: `.spawn()` may succeed before its response is lost. Retry-aware bounded submission policy, atomic startup claims, confirmed batch-writer termination and native commit reconciliation remain required. An uncertain queued invocation must fail any later claim after its absolute start deadline; do not blindly reissue a billable submission while `dispatch_unknown`. Inngest cancellation prevents later steps but does not terminate a spawned Modal job. The reconciler must observe cancellation/termination, reconcile receipts and settle reservations before takeover. See [orchestration](job-orchestration.md).

Keep compact QC on the normal path. The existing 186-frame Pixel receipt includes approximately 93MB of Rerun replay, 25MB of upstream metrics JSON and 12.6MB of report HTML. Preserve those research tools for on-demand diagnostics instead of generating them for every recording. Prefer bounded columnar records and aggregate summaries; stream or chunk new extraction outputs rather than accumulate every decoded frame/depth array. Keep an explicitly capped compatibility path for existing in-memory helpers until a streaming adapter is validated.

Price accounting includes startup/model load, GPU/CPU/RAM execution, failures, cache storage, object requests and transfer. Reserve against maximum allowed duration and retries, then settle actual usage when available. Store a dated rate-card revision; do not promise a hard cost ceiling based only on billing alerts. Optional embeddings/captions remain disabled by default until customers or internal search require them. Budget proposals in the broader research are not authorization to run paid jobs.

## 10. Failure and validation matrix

| Scenario | Required behavior | Verification |
|---|---|---|
| Hash mismatch, truncated file or failed CRC | Quarantine; no GPU; retain raw source and reason | Corrupted/truncated fixture and changed-hash upload |
| Missing MCAP summary | Explicit supported scan/reindex or classified rejection | Valid MCAP fixture without summary; no uncaught SDK assumption |
| Recorder metadata reports failure / zero RGB | Capture failure, not a successful empty episode | Physical v2 regression and synthetic zero-RGB fixture |
| Unequal v3 image/Frame/Android timestamps | Preserve values; accept valid acquisition association | Native v3 fixture using observed Pixel timestamp tuple |
| Duplicate events or inconsistent geometry | Reject affected contract; do not nearest-neighbor repair | Duplicate RGB/geometry, wrong raster and wrong transform fixtures |
| Missing depth / untracked pose | Preserve valid RGB; capability false and masks false | Video-only and tracking-loss fixtures |
| Unverified RGB/depth clock relation | No verified depth age or metric hand-validity promotion | Existing v3 geometry expectations and explicit rejection reason |
| Preview rotation/resampling | Predictions map back to exact source raster/events | Asymmetric checkerboard, variable cadence, duplicated preview frames |
| Malformed large input / excessive dimensions | Bounded resource rejection | Size/decompression/raster limits before heavy allocation |
| Curator exits zero with row errors | Record partial/failed rows; never blanket-success media | Inject one invalid clip into a mixed valid batch |
| GPU OOM / missing codec / missing weights | Classified failure; no unlimited retry; persist diagnostics | Small canary for each exact image/model/GPU revision |
| Worker dies after checkpoints/commit but before receipt | Reconcile native receipt/canonical version; reuse staged work instead of repeating completed inference | Fault injection before/after Parquet durability, Lance commit and application receipt |
| Duplicate event/Modal submission / stale writer | One startup claim; no takeover until prior execution ended and write capabilities expired/revoked | Concurrent invocations, expired DB claim with live storage writer and delayed completion |
| Compatible retry | Reuse same dataset URI, native contract namespace and intact saved selection after confirmed exclusive ownership | Fresh container/Ray recovery skips checkpointed IDs; no per-attempt dataset copy |
| Changed physical fragment/input layout | Fail and retain recovery evidence; deliberately create new run/dataset for incompatible changes | Attempt compaction/deletion/input rewrite or changed result contract |
| R2 Lance commit failure or ambiguous response | Retain workspace/history; reconcile publication receipt and canonical files before retrying | Crash during commit, recovery on fresh cluster and same-root permission qualification |
| Final release closure invalid | Do not publish; retain unique export destination for diagnosis/recovery | External clip/array references, missing payloads and checksum mismatch |
| Export requests unavailable labels | Reject or explicitly omit per schema; no fabricated actions | Video-only capture requested as metric-pose/robot-action dataset |

Existing local tests are useful regression inputs, not proof of Modal compatibility: `tests/test_capture_geometry_v3.py`, `test_capture_geometry_mcap.py`, `test_geometry_export.py`, `test_hand_geometry.py` and `test_geometry_report.py`. The first cloud canary uses one permissioned short recording plus synthetic timestamp/calibration fixtures. Separate acquisition correctness, deterministic mapping, inference execution and independent annotation accuracy checks.

## 11. Implementation sequence and proposed file ownership

These are new implementation targets, not files created by this documentation change. Keep app/SDK work coordinated with the agent already fixing capture bugs; pin tested revisions and avoid changing their in-progress work.

| Phase | Proposed paths | Done when |
|---|---|---|
| P0: contracts and fixtures | `processing/contracts/`, `processing/tests/fixtures/` | Source/frame-index, batch descriptor, stage receipt and final-release schemas accepted; v3 timestamps round-trip exactly |
| P1: cloud CPU foundation | `processing/capture/`, `processing/images/capture.Dockerfile`, `processing/modal_app.py` | Two-hour bounded ingest, native shards, prepared source byte/duration limits, compact QC, preview and source mappings pass |
| P2: workflow integration | Control-plane workflow/admission/outbox modules and DB migrations under the independently selected backend root | Hosting/runtime choice qualified; transactional outbox, private submission, startup/batch-writer claims, confirmed takeover, version acceptance and budget admission work |
| P3: Curator materialization | `processing/curator/`, `processing/images/curator/`, `processing/tests/test_curator_contracts.py` | CPU `prepare_clips` runs cut/transcode under stable per-batch root; frozen bounded row set, native receipt and fresh-Ray recovery pass |
| P4: optional enrichment | `processing/curator/embed.py`, `processing/curator/caption.py`, native checkpoint fixtures | Separate `embed_clips` and `caption_clips` reuse canonical dataset under stage barriers; L4 embedding and bounded caption GPU/context qualification, row errors and recovery measured |
| P5: annotation profiles | `processing/models/`, `processing/annotations/`, license/model registry | Actual allowed models have separate pinned images, masks and accuracy evaluation; restricted research branches cannot enter commercial delivery |
| P6: approved delivery export | `processing/exporters/`, `processing/tests/test_export_contracts.py` | Review pins completed canonical versions; export freezes exact revisions and copies required payloads only as needed into unique protected release output with closure/checksums |
| P7: optimization | Per-stage benchmark receipts and observability dashboards | Measured cost per source/accepted hour; change batch size or GPU only when evidence improves total cost |

The cloud CPU foundation is the first deployable slice. Curator enrichment is added after the reviewable acquisition path works; it should not delay reliable uploads, exact clock preservation and internal data inspection.

## 12. Qualification gates before production

- Confirmed build digest, dependency lockfiles, permitted model assets and reproducible cache preparation.
- MCAP/metadata checksum identity, v3 event mapping, native calibration/orientation and privacy policy preserved end to end.
- Actual Modal `/dev/shm`, Ray resource detection/spill behavior, scratch sizing and whole-source download limits measured.
- Actual NVDEC/codec availability and selected model/GPU memory fit measured; any caption context adapter tested explicitly.
- Stable per-batch URI/contract/selection recovery, bounded publication fragments and full native receipt retention demonstrated on the chosen object store.
- Prior-writer termination plus write-capability expiry/revocation proven before same-root takeover; DB lease expiry alone cannot satisfy this gate.
- Actual per-stage rereads and read/write bytes measured; no unqualified automatic scratch/download reuse or per-stage full-copy requirement.
- Compact manifests and per-field masks drive review; no human-data estimate is advertised as independently validated metric ground truth without that validation.

## References

Local inspected sources: [capture adapter](../../scripts/capture_geometry.py), [geometry processing](../../scripts/process_geometry_capture.py), [WiLoR research preflight](../../scripts/preflight_wilor_research.py), [SDK export](../../stera-sdk/src/stera/data/export.py), [SDK reader](../../stera-sdk/src/stera/data/mcap/_reader.py), and [v3 physical receipt](../validation/pixel-v3-processing.json).

Primary documentation and pinned implementation:

- [MCAP format specification](https://mcap.dev/spec) and [ARCore image timestamp semantics](https://developers.google.com/ar/reference/c/group/ar-image#arimage_gettimestamp).
- [Inngest hosting adapters](https://www.inngest.com/docs/learn/serving-inngest-functions), [durable steps](https://www.inngest.com/docs/durable-execution/primitives), [sleep](https://www.inngest.com/docs/durable-execution/primitives/step-sleep), [cancellation](https://www.inngest.com/docs/durable-execution/guides-and-advanced/cancellation), and [current limits](https://www.inngest.com/docs/durable-execution/limits). The JavaScript SDK is [Apache-2.0](https://github.com/inngest/inngest-js/blob/main/packages/inngest/LICENSE.md); the server/CLI has [SSPL and a future Apache grant](https://github.com/inngest/inngest/blob/main/LICENSE.md), so this design uses managed Cloud rather than assuming the server is permissively licensed.
- [Modal existing images](https://modal.com/docs/guide/existing-images), [model weights](https://modal.com/docs/guide/model-weights), [Volumes](https://modal.com/docs/guide/volumes), [Secrets](https://modal.com/docs/guide/secrets), [resources](https://modal.com/docs/guide/resources), [CUDA](https://modal.com/docs/guide/cuda), [JavaScript SDK for Node/Deno/Bun](https://modal.com/docs/sdk/js/latest/intro), [invocation methods](https://modal.com/docs/guide/function-invocation-methods) and [Function configuration](https://modal.com/docs/reference/modal.App).
- [Curator image builder](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/client/image_cli/image_app.py), [image template](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/package/cosmos_curator/default.dockerfile.jinja2), [runtime CLI](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/pipelines/pipeline_runtime.py), and [local Ray initialization](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/next/core/ray_runtime.py).
- [Curator cut recipe](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/next/recipes/video_cut/config.py), [transcode recipe](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/next/recipes/video_transcode/config.py), [embedding recipe](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/next/recipes/video_embed/config.py), [S3 profile handling](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/core/utils/storage/s3_client.py), [Lance storage options](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/core/utils/storage/storage_utils.py), and [terminal-row error semantics](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/next/enrichment/attempts.py).
- [Native checkpoint/recovery and concurrency contract](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/docs/curator/design/curator-next-checkpoint-recovery.md), [whole-source transcode behavior](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/docs/curator/design/curator-next-video-transcode.md), [transcode implementation](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/next/recipes/video_transcode/processing.py), and [caption-specific recovery](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/docs/curator/design/curator-next-video-captioning.md).
- [Official NGC container tags](https://catalog.ngc.nvidia.com/orgs/nvidia/cosmos/containers/cosmos-curator/-/tags), [pinned caption model configuration](https://huggingface.co/Qwen/Qwen3.8-27B-FP8/blob/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/config.json), [WiLoR license](https://github.com/rolpotamias/WiLoR/blob/fcb911312a38fa8badd30d9656a167485d61b8f9/license.txt), [MANO model terms](https://mano.is.tue.mpg.de/license.html), [FLORA project](https://research.nvidia.com/labs/gear/flora/), and [released FLORA Captioner card](https://huggingface.co/nvidia/Flora-Captioner/blob/ad744f46335aec671f5caac09ac97d817fbdb114/README.md).

Prior source audits are retained in the sibling wiki repository: `wiki/startup/references/bootstrap-cloud-processing-costs.md`, `raw/notes/2026-10-22-model-gpu-memory-compatibility-audit.md` and `raw/notes/2026-10-22-modal-curator-adaptation-source-audit.md`. Current Modal image/Volume API behavior was additionally checked through Context7's official Modal documentation index; local SDK-aligned skill/API references are version 1.6.2.
