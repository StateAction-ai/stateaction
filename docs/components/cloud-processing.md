# Processing and required hand landmarks

Updated: 2026-10-31. MVP implementation target. The same Python core runs locally and inside Modal; only the executor/storage configuration changes. No new cloud worker has been deployed.

## Required output

Use **MediaPipe Hand Landmarker on CPU** for the first end-to-end implementation: up to two hands, 21 native-image landmarks per detected hand and clearly marked model-relative 3D estimates. The user confirmed this output is sufficient for the pilot. Detection quality on repair footage still has to pass review; CPU-first is a starting profile, not a quality guarantee.

Keep hand inference mandatory in `process_recording`. No-hand frames are legitimate masked observations; a model failure is a job failure, not a successful RGB-only result. The shared Rerun viewer shows a spatial RGB proxy with 2D hands and clearly marked local 3D estimates; staff additionally see automatic check results. Native-resolution RGB and full frame mappings remain separate evidence.

| Output | Required semantics |
| --- | --- |
| `image_landmarks_px` | 21 `(x,y)` coordinates transformed back into the native RGB raster; exact joint order and image dimensions |
| `model_relative_joints_m` | Raw model-estimated local 3D coordinates; record origin/axes/model convention; not a measured global/camera trajectory |
| Detection/quality fields | Left/right prediction and handedness score, detected/finite masks, processing error; unsupported visibility/confidence remains unknown |
| Frame mapping | Native source frame/event ID, original integer timestamps/clock domains, clip/preview PTS and every crop/rotation/mirror transform |
| Provenance | Model asset/source/hash/license, code/image/config/profile revisions, thresholds, sampling and decoder versions |

Do not treat a handedness score as per-joint confidence or visibility. MediaPipe does not establish measured hand depth, occlusion or metric accuracy. Invalid coordinates use masks/NaN in arrays and null in JSON. Keep `metric_accuracy_validated=false`. Any future camera/world reconstruction is a separate qualified field, never a relabelled model-relative array. [Official Python output semantics](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/python)

## Reuse existing work, replace unbounded loading

The local [geometry runner](../../scripts/process_geometry_capture.py) already uses MediaPipe; the SDK defaults to WiLoR. Reuse reviewed capture/raster/hand conversion functions and existing fixtures from the pinned SDK import. Do **not** wrap the current whole-session runner as a two-hour production function: it accumulates sensor/frame/observation arrays and produces large diagnostics.

Implement one bounded streaming reader/decoder using `mcap.reader.NonSeekingReader` on the source response through a SHA-256 wrapper. Iterate in file order (`log_time_order=false`); its default sorted path can buffer the recording. Keep only bounded source-specific association windows and explicitly reject unsupported out-of-order joins. Set a tested record-size limit and bound decompressed chunk bytes before allocation; the library's 4 GiB default is not an appropriate pilot memory budget. Consume/hash all source bytes, including the MCAP footer, before accepting the candidate. No full raw-MCAP scratch copy is required. [MCAP reader API](https://mcap.dev/docs/python/mcap-apidoc/mcap.reader)

 Read each source MCAP once per fresh attempt, compute SHA-256 while consuming it and reject the result if its final source identity differs. Bound decompression chunks, decoded dimensions, frame queues and encoder buffers. Decode each RGB frame once and feed both inference and viewing encoders. Close/upload bounded clips and array shards progressively; retain only the current shard plus a small overlap/state window. Do not load the full video or all depth into RAM.

Start with 60-second clips and a measured byte ceiling; shorten a clip if necessary without silently reducing required image quality. Output native RGB MP4, NPZ hand arrays, frame-map rows, available sensor evidence, a thumbnail and a customer-safe `viewer.rrd` per clip. Preserve native frame cadence; spatial proxy transforms must be explicit. The initial RRD proposal is at most 128 MiB and 1280×720 proxy, shortening clips when necessary; qualify these bounds, never silently drop frames to fit. A small JSON manifest references them. A simple documented Python reader loads the portable arrays; no Lance dependency is required. Whole-session Rerun/HTML audit reports remain opt-in diagnostics; bounded clip RRDs are required review artifacts. [Rerun payload, access and version contract](rerun-clip-review.md).

Use native timestamps, not `frame_number / fps`. Preserve distinct RGB, depth, ARCore, IMU and camera-tracking clocks. Unverified clock joins remain unverified; the Android v3 optical-to-link transform and per-frame raster/intrinsics rules still apply. Preserve available evidence without presenting ARCore tracking or guessed depth association as ground truth. [Capture regression](../geometry-v3-capture-regression.md)

## Inline checks and outputs

Before reporting a result, verify source hashes, MCAP decoding, per-shard dimensions/frame counts, joint-array shapes/masks, source-frame/PTS mapping, required files and output hashes. Inspect all declared errors. Persist check status/measurements for the staff Automatic quality checks panel; coverage is not accuracy. Check the archive/reader in the follow-up `export_release`. Await all writes, complete them through the API and seal the inventory; no output upload is allowed afterwards. API acceptance also checks known execution termination/current job references. These checks replace the independent validator for the trusted-code MVP; they do not prove pose accuracy.

Outputs use unique job prefixes and API-issued multipart capabilities, including small manifests. Workers have no broad write credentials or database access. Upload/download behavior is shared by local MinIO and R2 modes. [Transport](mcap-upload.md), [control protocol](job-orchestration.md), [stage handoffs](pipeline-execution-and-data-flow.md).

## 5. Models and resources

Initial qualification candidates, not measured capacity:

| Function/profile | Candidate resource limits |
| --- | --- |
| `process_recording` / `mediapipe_cpu` | 4 physical CPU cores, 8 GiB RAM, GPU unset; finite 6-hour timeout; bounded scratch/shards |
| Follow-up `export_release` | 2 physical CPU cores, 4 GiB RAM, GPU unset; finite 1-hour timeout; stage a bounded TAR on scratch, then hash/multipart-upload it |
| Optional local CUDA profile | Use an already available GPU and a separately pinned, rights-cleared model; no automatic cloud submission |
| Future cloud GPU | Select only after measured VRAM/quality/throughput; no default H100/large caption model |

One intentional processing/export attempt runs globally at first; zero warm cloud workers; no automatic expensive retry or GPU upgrade. An input that exceeds measured duration/bytes/scratch/deadline fails visibly. The two-hour target must be demonstrated on the exact image/profile before field deployment. Extend a limit only after sizing it; do not advertise the 100 GiB upload cap as proven processing capacity.

MediaPipe's documented mobile latency is not a Modal throughput estimate. Measure full extraction, encoding, uploads, peak RSS/scratch and model coverage. A future local GPU can replace only the model adapter while keeping the same 21-joint order, coordinates, masks and handoff schemas. [Local testing](local-development.md)

### Model rights

The selected **version-1 `hand_landmarker.task`** is 7,819,105 bytes, SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`, matching the prior local capture receipt. Pin the versioned [official asset](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task), not `latest`. Google's [overview](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker) links the model and [model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf). Page 2 of that card explicitly identifies Apache License 2.0. Preserve the asset source/hash, card and applicable license/notices; this conclusion is based on the model card, not the documentation footer.

The card identifies gloves/occlusions, including holding objects, as outside its intended scope. That is directly relevant to repair work: benchmark representative footage and withhold unusable clips. Its 3D coordinates are learned estimates, including synthetic-data supervision. The local [Pixel receipt](../validation/pixel-v3-processing.json) detected 68 hands across 186 frames but accepted **zero** as metric geometry; that remains a limitation, not cloud readiness.

WiLoR has noncommercial restrictions and MANO has separate terms; do not deploy either commercially without appropriate permission. FLORA remains a research/scale reference, not a bootstrap model. Curator/HFlow/Open-AoE Apache-licensed code does not relicense their external models/assets. [WiLoR terms](https://github.com/rolpotamias/WiLoR/blob/fcb911312a38fa8badd30d9656a167485d61b8f9/license.txt), [MANO terms](https://mano.is.tue.mpg.de/license.html), [deferred Curator/FLORA research](curator-integration-reference.md).

## Activation evidence

Pass unequal-clock/raster/missingness fixtures, real local dataset assignment and shared Rerun review (archive round trip in the follow-up), a representative long-input memory/scratch test and a small Modal CPU/R2 canary. On repair footage, report hand-detection coverage, handedness errors and manually checked landmark accuracy over agreed examples, including tools/gloves/occlusion. If quality is inadequate, improve/qualify the model before promising useful annotations; do not drop automatic hands from the MVP.
