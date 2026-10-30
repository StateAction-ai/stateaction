# Curator integration: later-stage reference

Archived design research, 2026-10-26. **Not part of the MVP implementation.** The current [processing contract](cloud-processing.md), [orchestration](job-orchestration.md) and [technical design](../technical-design.md) supersede the runtime, storage and validation protocols below. Preserve this reference for a later Curator/Lance adoption decision; its old build targets and optional-hand scope are historical.

# Cloud processing implementation

Updated: 2026-10-26. Render controllers coordinate the selected Modal worker design; no cloud image, Function or paid processing run has been qualified.

The [execution document](pipeline-execution-and-data-flow.md) owns stage dependencies and read/write handoffs. [Orchestration](job-orchestration.md) owns claims, retries, validation authority and acceptance. [Shared contracts](../contracts.md) define serialization and manifests. This document owns extraction, robotics semantics, native Curator integration and model/resource qualification.

## 1. Minimal v1 and code ownership

Implement CPU ingest, prepared clips, compact QC and review artifacts first. Embeddings, captions and hand estimates are separate optional profiles. Preserve all available sensor evidence, but do not label estimated hands or unsynchronized depth as validated metric supervision. Do not infer robot actions, torso pose or a globally calibrated world trajectory from phone video.

| New module | Responsibility |
| --- | --- |
| `processing/contracts/` | Generated/shared schema bindings and conformance fixtures |
| `processing/capture/` | Bounded MCAP validation, native extraction, geometry, sources, preview and mappings |
| `processing/curator/` | Pinned recipe generation, direct CLI, canonical result inspection |
| `processing/models/` | Shared model/version/rights registry |
| `processing/hand_pose/` | Isolated optional hand-model adapters and observations/masks |
| `processing/validation/` | Read-only `validate_stage` checks after quiescence; receipts bind candidate and barrier/grant generation |
| `processing/export/` | Frozen release packaging, not application publication |
| `processing/images/`, `processing/modal_app.py` | Reproducible CPU/model images and private Functions |

Existing app/SDK scripts are reference evidence. Keep their checkout read-only while capture bugs are being fixed; pin reviewed logic rather than importing an unversioned working tree. The local Pixel v3 receipt established acquisition, not annotation accuracy: it reports zero geometry-consistent hands and `metric_accuracy_validated=false`. [Physical receipt](../validation/pixel-v3-processing.json)

## 2. MCAP ingest and materialized inputs

Ingest starts after seal and transfer completion, with client-expected sizes/hashes. Stream each raw file to scratch while computing its independent server SHA-256, then parse locally; compare before admitting downstream work. ETag is not SHA-256. A fresh failed ingest may need another download. Do not silently edit raw bytes or treat native Curator checkpoints as MCAP-ingest recovery.

Validate MCAP structure, schemas/channels, CRCs where present, recorder finalization and actual encoded-frame counts. Explicit failed finalization, bad checksum or zero RGB is a classified capture failure. Missing optional summary/index data needs a supported bounded scan/reindex or classified rejection; the current SDK summary helper assumes it exists. Bound decompressed bytes, dimensions, frames, scratch and runtime before large allocations.

Write outputs progressively: frame index, calibration/geometry records, indexed native-frame and sensor shards, prepared RGB sources, compact QC and preview. Upload completed bounded shards and release local buffers/scratch where safe. Current `GeometrySession` caches depth/associations; it is not a demonstrated two-hour streaming processor. New ingest must pass a representative long-recording test.

Prepared videos must be independently decodable and limited by **both** duration and bytes. Start qualification at one-to-five-minute segments; configure a tested mandatory byte ceiling. If a source exceeds it, shorten/re-encode from preserved evidence without silently reducing required pixel quality. Bound batch rows, physical fragments, outstanding downloads and total batches. Unset/unmeasured capacity limits block activation; an upload allowance of 100GiB does not establish processing capacity.

Retain original JPEG/native encoded pixels separately from presentation/video proxies. Use indexed bounded shards to avoid millions of tiny objects. Every prepared/preview/clip frame maps back to native source frame and clock evidence; separate model sampling variants retain their own mappings. Caption proxies are not automatically suitable for geometric hand estimation.

### Timestamp and geometry invariants

For Android `android_arcore_cpu_v3`, preserve:

- ARCore acquiring `frame_timestamp_ns`, native `rgb_timestamp_ns`, `android_camera_timestamp_ns` and native `depth_timestamp_ns` separately, with documented clock domains.
- `rgb_frame_association=Frame.acquireCameraImage_same_frame`; numerical equality/proximity of unrelated clocks is not synchronization.
- One encoded RGB event to one geometry row. Validate topic header/publish/log-time relationships, duplicates, source-specific monotonicity, dimensions, calibration and recorded transforms.
- Per-frame intrinsics, distortion/crop, RGB-to-depth pixel mapping, tracking state and optical-to-link transform. The current Android optical-to-ARCore transform is diagonal `[1,-1,-1]`; verify it rather than applying a display rotation indiscriminately.
- `cross_stream_clock_verified=false`, `depth_time_verified=false` and metric accuracy unvalidated until independent evidence changes those claims. Spatial registration does not establish depth age.

Keep IMU on its native timeline. The versioned adapter deliberately clears the SDK's nearest-RGB-time IMU join because the shared clock is unverified. Retain tracked camera poses only with their exact acquiring-event association; ARCore coordinates are recording-relative tracking evidence, not robot actions or global ground truth.

Store rotations/crops/resizes/mirrors explicitly and transform predictions back to native pixels before geometry. A rotated raster with unchanged intrinsics is invalid. Legacy rotation hypotheses remain diagnostic-only. Android evidence does not qualify iOS or a future recorder contract.

The frame index includes native message identity/order, source frame index, all timestamps/clock domains, geometry/depth/pose association IDs, raster/transform IDs, and preview/clip PTS plus time base. Constant-FPS viewing media is allowed; `frame_number / fps` never replaces the native annotation clock. Missing values and per-field/per-joint validity masks stay explicit. Use [shared serialization](../contracts.md), not float-converted nanoseconds or fabricated valid zeros. [Capture adapter](../../scripts/capture_geometry.py), [v3 regression](../geometry-v3-capture-regression.md)

## 3. Native Curator adapter

Pin `NVIDIA/cosmos-curator@84f54d844bfc6fdf839848f6644f3fc893f52209` (inspected source v2.9.0). Next is an incubation namespace; do not inherit production-scale or compatibility claims. The inspected NGC catalog exposed 2.3.0, not a matching public 2.9 image. Build our own image once, publish privately and pin its digest. [Builder](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/client/image_cli/image_app.py), [NGC tags](https://catalog.ngc.nvidia.com/orgs/nvidia/cosmos/containers/cosmos-curator/-/tags)

Preserve the locked Linux AMD64/Pixi environment. Initial embedding builds include `legacy-transformers`; the builder also includes `default` and `model-download`. Omit unused optional models. The inspected image uses CUDA 13.0.3/Ubuntu 24.04 and Python 3.13. Adding the thin Modal wrapper must not replace pinned Torch/vLLM dependencies or codec requirements.

Execute this argv with `cwd=/opt/cosmos-curator`, stdout JSON separated from stderr:

```python
["pixi", "run", "--as-is", "run-pipeline", "/tmp/job.yaml", "--json"]
```

Generate strict allowlisted recipes. Do not launch nested Docker, `cosmos-curator local launch` or the image's NVCF service. Keep `COSMOS_CURATOR_TEE_STDOUT_STDERR` unset. With no `RAY_ADDRESS`, the recipe starts local Ray; do not deploy a permanent cluster. If pre-starting Ray for memory tuning, advertise required `curator_io` resources and preserve child environment settings. [Runtime](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/pipelines/pipeline_runtime.py), [Ray initialization](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/next/core/ray_runtime.py)

Initial qualification settings, not performance guarantees:

| Recipe | Supported starting settings |
| --- | --- |
| `video-cut` | Fixed-stride profile; `execution.sources_per_checkpoint=1`, `execution.spans_per_fragment=256`; inspect every source outcome |
| `video-transcode` | CPU FFmpeg; small `ffmpeg_batch_size`; `parquet_rows_per_file=32`; codec/profile pinned |
| `video-embed` | `variant=336p`, `inference_concurrency=1`, `inference_batch_size=1`, small `lance_read_batch_size` |
| Native I/O | `COSMOS_CURATOR_RAY_IO_SLOTS_PER_NODE=1` initially; increase only after memory/read-byte measurements |

Cut plans spans; transcode creates media and its downstream publication receipt. Freeze the bounded row set and require complete clip readiness before inference. Native transcode reads whole source bytes into Ray, stages a source MP4 and holds a bounded output batch. Whole-fragment publication also materializes data; small scanner/checkpoint batches do not bound every allocation. CPU H.264 transcode does not require NVENC.

Transcode/embed select validated pending fragments; the inspected public YAML does not accept arbitrary input-version/selection fields. Application descriptors provide preflight/provenance, then record the actual snapshot pinned after native schema registration. A completed rerun may select zero rows; selected-row counts may include terminal media errors. Exit zero alone is insufficient acceptance.

Use the same batch `media_root`/Lance URI across compatible attempts. Preserve native result Parquet/checkpoint layout, immutable media/input fields, physical fragments and transaction history. Transcode/embed share enrichment recovery; caption has its own recipe-specific recovery and cut is a producer. No compaction, row deletion, data-file rewrite or history pruning while recovery/pinned consumers depend on it. Stage validation records the verified canonical commit without copying the table. [Recovery contract](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/docs/curator/design/curator-next-checkpoint-recovery.md)

## 4. Weights, storage and credential qualification

Cache pinned weights in a Modal Volume mounted at `/config/models`; Embed expects `nvidia/Cosmos-Embed1-336p/` beneath it. Curator's HF cache path is separate. Prepare/verify/commit weights through a controlled CPU job, then reload for consumers. Serialize cache writes and retain an asset/hash/license inventory. Bulk datasets remain in object storage; temporary container scratch is not durable.

After the backend authorizes the current writer, write short-lived credentials to a mode-0600 file and set `COSMOS_S3_PROFILE_PATH` before Curator starts. Select that profile through `execution.storage_profile`. R2 uses `region=auto`, its account endpoint and `aws_session_token` where issued; recipes use `s3://` URIs. AWS uses the matching region/policy. A recipe chooses one profile; do not invent per-URI/multi-profile behavior.

The inspected parser passes session tokens into Botocore/Lance, but actual R2 commits, listing, permissions, expiration and recovery are unqualified. A batch read-write credential is not field-level ACL or storage-enforced read-only input access. Keep raw and published roots outside scope and verify the trusted pinned adapter preserves existing input hashes. If stricter per-action isolation is required, qualify the provider/adapter policy or block that profile. Never fall back to a company-wide key. [Profile handling](https://github.com/NVIDIA/cosmos-curator/blob/84f54d844bfc6fdf839848f6644f3fc893f52209/cosmos_curator/core/utils/storage/s3_client.py)

Before validation, require confirmed writer termination, disabled renewal, every write capability expired/revoked, and reconciled outstanding writes/object visibility. Expiry does not cancel accepted PUTs/MPUs: qualify provider-specific operation tracking, bounded request/drain behavior and cleanup; unknown writes block adoption, not a fixed sleep. Retain batch ownership through the read-only validator and API CAS; its receipt binds unchanged barrier/grant generation and candidate. The validator cannot obtain canonical write access. Unpublished release exporters need the same barrier. Exact authority is in [orchestration](job-orchestration.md).

## 5. Models and resources

These are test targets, not measured minima or throughput commitments:

| Workload | Initial target / gate |
| --- | --- |
| Bounded ingest | CPU 2–4 physical cores, 8–16GiB RAM; scratch/long-recording qualification required |
| Cut/transcode | CPU 4–6 cores, 32GiB RAM, byte/fragment/I/O bounds |
| Embed1 336p | L4 24GB, batch 1; actual image, NVDEC and memory fit unvalidated |
| Bounded caption adapter | L40S 48GB with explicit context/concurrency changes; conservatively 128GiB host RAM |
| Unchanged caption recipe | H100 80GB/128GiB host RAM is a safer canary target, still unqualified |
| WiLoR research | Separate legacy dependency image; local RTX 3090 inference does not qualify commercial cloud delivery |

The inspected Qwen3.8-27B-FP8 checkpoint contains about 28.74GiB of stored tensors and inherits a 262,144-token context. This is not measured VRAM. Do not budget the unchanged captioner onto 24GB, or assume 48GB works by parameter arithmetic. Plain Next YAML does not expose generic vLLM context/KV kwargs; an L40S plan needs an explicit tested adapter/patch. [Pinned model configuration](https://huggingface.co/Qwen/Qwen3.8-27B-FP8/blob/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/config.json)

Ray's inspected image defaults object-store RAM to 40%. Caption actor reservations of 24+16GiB can exceed the remainder of a 64GiB host. Qualify 128GiB or deliberate memory tuning. Check actual `/dev/shm`, spilling, logical resources, codecs and GPU video libraries; CUDA availability alone does not establish NVDEC. A100/H100 decoding capability differs from encoding capability. Each model gets its own compatible pinned environment; do not force WiLoR's legacy NumPy/Chumpy into the SDK/Curator environment.

Scratch must accommodate the raw MCAP plus in-flight native/prepared shards and temporary video/output files, with verified headroom. Modal's default quota is 512GiB, subject to host disk capacity; requests can reach 3TiB. Disk requests can raise billed RAM at 20:1, while CPU/RAM billing uses the higher of request/usage. Streaming/shard release and measured limits are required before accepting a large processing job. [Modal resources](https://modal.com/docs/guide/resources)

Use zero warm containers and finite deadlines; orchestration sets retries/admission. Avoid per-recording large Rerun/HTML diagnostic exports by default. Measure startup, bytes, peak RSS/VRAM/scratch, validation and actual cost before tuning.

### Model rights

Curator Apache-2.0 does not relicense weights. Maintain source/revision/hash, dependency notices, allowed use and validation status per enabled model. WiLoR is noncommercial research; MANO and detector dependencies have separate terms. FLORA releases have noncommercial restrictions; its full annotation guard requires at least 75GiB aggregate GPU memory and it is not the bootstrap default. MediaPipe's actual model asset also needs recorded terms/notices. [WiLoR license](https://github.com/rolpotamias/WiLoR/blob/fcb911312a38fa8badd30d9656a167485d61b8f9/license.txt), [MANO terms](https://mano.is.tue.mpg.de/license.html), [FLORA card](https://huggingface.co/nvidia/Flora-Captioner/blob/ad744f46335aec671f5caac09ac97d817fbdb114/README.md)

## 6. Required implementation gates

- Pass v3 unequal-clock, duplicate-event, raster/rotation, missing-depth/tracking and native-frame mapping fixtures; retain false unsupported masks.
- Process a representative two-hour recording with bounded RSS/scratch and independently materialized outputs. Set tested source/batch/fragment/validator budgets; oversize fails explicitly.
- Build/pin the real image, cache and storage profile; prove FFmpeg/NVDEC/Ray/model fit on the selected Modal hardware.
- Recover after checkpoint/ambiguous commit; prove quiescence before validation, retired grants/in-flight writes and safe takeover. Measure retirement/drain latency; qualify R2 or choose S3.
- Verify read-only validator receipts, unchanged barrier/candidate binding, row errors and final release closure; no self-approval or implied metric ground truth.

The reviewed [local geometry runner](../../scripts/process_geometry_capture.py) and tests are regression evidence, not proof that any cloud or commercial qualification gate has passed.
