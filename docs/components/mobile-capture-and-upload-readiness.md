# Mobile capture and upload readiness

Baseline audited 2026-10-31. **Not qualified for high-volume field collection.** The baseline findings below describe the imported recorder. Our temporary Stera work is now in the monorepo; the [2026-11-01 Android H.264 integration](android-h264-implementation.md) adds an opt-in native adapter and local capture→CPU→Rerun tests. Hardware, signed-device, long-run, ownership and upload gates remain open.

## JPEG, MP4 and MCAP are separate choices

MCAP is a timestamped sensor-message container. MP4 is a media container. JPEG compresses each image independently; H.264/H.265 can compress across frames. The current Android/iOS MCAP paths write timestamped JPEG RGB frames at quality 80/0.8. This is compressed source imagery, not lossless Bayer/raw camera data.

| Recording option | Strength | Cost / qualification work |
| --- | --- | --- |
| JPEG frames + sensors in MCAP | Independently decodable images; straightforward acquisition timestamps and mixed sensors | Higher RGB bytes; current implementation needs sensor/capture fixes regardless |
| H.264 RGB + sensors in MCAP | Retains one log and timestamped sensors with temporally compressed RGB | Requires a versioned video message/decoder, keyframes/configuration and exact original frame mapping |
| H.264 MP4 + sensor MCAP + frame map | Familiar video tooling and independent sensor log | Must seal both files and an exact acquisition-to-video-PTS map; continuous or fragmented/segmented output needs crash/finalization qualification |

The sources establish support for JPEG sensor messages, H.264 inside MCAP, and MP4 with separate robot data. ROS/robotics image transport supports JPEG/PNG and encoded video; Foxglove documents H.264 inside MCAP; LeRobot supports MP4 plus tabular robot data. MP4 plus sensor MCAP is our proposed variant of that separate-file approach. These examples do not establish market prevalence or prove that our particular codec/profile preserves adequate repair/hand detail. [Clearpath image transport](https://docs.clearpathrobotics.com/docs/ros2humble/ros/config/camera_compression/), [Foxglove H.264 in MCAP](https://foxglove.dev/blog/announcing-h264-support-in-foxglove), [CompressedVideo schema](https://docs.foxglove.dev/docs/sdk/schemas/compressed-video), [LeRobot video storage](https://huggingface.co/docs/lerobot/using_dataset_tools).

Foxglove's video schema requires complete per-frame packets, codec configuration with keyframes and no B frames for its player. Browser/decoder support must be verified for the selected profile. Native acquisition times remain separate from video presentation timestamps; encoding cannot silently redefine the sensor clock. Hardware encoding is a candidate, not a measured battery/size win for this app. [Android MediaCodec](https://developer.android.com/reference/android/media/MediaCodec).

Two short Pixel captures extrapolate to **10.79–13.37 decimal GB/hour**, approximately **21.6–26.7 GB for two hours**. They are short-sample rates, not a long-run bound. At an illustrative 10 Mb/s, RGB video alone is 4.5 GB/hour; actual total also includes depth, other sensors, container overhead and sidecars. This is not a matched-quality compression result. [Local volume evidence](video-cost-model.md), [physical capture receipt](../validation/pixel-v3-acquisition.json).

**Selected subsequent decision:** new captures target hardware **H.264 inside MCAP**, as specified by [capture format v1](capture-format.md). Keep current immutable JPEG captures as the reference and legacy decoder fixture. Qualify actual total bytes/hour, capture gaps, hand/tool detail, heat/battery and worker/browser decoding before shipping the profile. MP4-plus-sensor-log and HEVC remain alternatives researched above, not parallel MVP implementations. Losslessly preserve original sensor samples, units, validity and timestamps; do not cut required streams or reduce frame cadence/raster silently to hit a size target. No new cloud GPU is needed.

The default recorder still emits JPEG-bearing MCAP; explicit Android H.264 selection uses the new adapter. The complete target also requires a sealed inventory and production qualification beyond local frame/decoder checks. MP4 alone would not satisfy the sensor contract. Cloud conversion after upload cannot reduce phone storage or upload bytes already spent; the selected encoding happens during capture.

## Required capture evidence

The source contract must declare each stream as required, conditional or disabled, with **requested / supported / enabled / observed** status and actual saved sample counts. Topic registration and configured rates are insufficient evidence.

| Evidence | Requirement |
| --- | --- |
| RGB | Actual saved raster, frame/event identity, capture time/clock and codec/profile; preserve RGB across camera-tracking loss while masking unavailable pose |
| Geometry/calibration | Per-frame or explicitly versioned matching intrinsics; source/output raster, resize/crop/rotation/mirror, coordinate frames and declared distortion/extrinsic availability |
| Raw motion | Independent accelerometer and gyro events with original times, clocks, units, axes, availability and requested/effective rates; fused/derived motion is separate |
| Pose/tracking | Native AR pose, convention, time and tracking state; estimated tracking remains labelled as such |
| Depth/confidence | Conditional on supported/enabled capture profile; preserve native precision/units/source kind, confidence for its matching depth stream, timestamps and validity. ARCore raw depth is still an estimate, not a direct ground-truth measurement |
| Camera metadata | Preserve exposed exposure/focus/sensitivity/readout metadata and source/units; unsupported fields are unavailable, never invented zero/calibration |
| Loss/finalization | Bounded acquisition/outcome records, written-versus-attempted counts, intentional sampling, dropped events/reasons, writer errors and native closed-file acknowledgement |
| File identity | Closed, stable files; SHA-256 of actual bytes, complete sealed required-file inventory and owner-bound local resume journal |

No audio/GPS expansion or validated metric trajectories are introduced. Optional mesh/point-cloud streams must declare whether they are observed samples, derived/final snapshots or unsupported. Original nonfinite observations remain preserved with quality flags.

## Confirmed capture gaps

| Finding | Required correction / proof |
| --- | --- |
| Android combines latest accel/gyro values under one callback time; iOS uses gravity-removed fused motion | Preserve independent raw event streams and original times. Never label these current streams as equivalent raw IMU |
| iOS can resize JPEGs while keeping source intrinsics; depth calibration flag survives a new recording | Match saved-pixel calibration and explicit transforms; reset session state; test consecutive sessions and resolution fallback |
| Flutter/native rate keys differ; Android hardcodes 15 Hz and does not honor all toggles | Version the capture-profile contract and record actual effective settings; reject unsupported requests explicitly |
| Both platforms gate RGB on tracking; iOS drains IMU before dropping a queued visual write | Keep required imagery independent of tracking and IMU independent of visual backpressure; preserve gaps with explicit records |
| Frame/drop log handles are not initialized in both MCAP writers; metrics may count unsaved work | Persist bounded event/outcome evidence; increment successful counts after writer acceptance; externalization succeeds before inline evidence is discarded |
| Depth confidence/native-depth variants are not retained; optional derived channels contain assumed confidence/covariance/extrinsics | Save available matching streams and original precision or declare unavailable. Label assumed/estimated fields; never present placeholder confidence or residuals as measurement |

Source locations: Android [IMU collector](../../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/sensors/ImuCollectorImpl.kt) line 138, [configuration](../../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/RecordingConfig.kt) line 22, [orchestrator](../../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/coordination/RecordingFrameOrchestrator.kt) line 108 and [writer](../../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/data/MCAPDatasetWriter.kt) line 500. iOS [IMU collector](../../packages/stera_recorder/ios/stera_recorder/Sources/stera_recorder/sensors/ImuCollectorImpl.swift) line 95, [orchestrator](../../packages/stera_recorder/ios/stera_recorder/Sources/stera_recorder/coordination/RecordingFrameOrchestrator.swift) lines 81/212/271/435, [frame processor](../../packages/stera_recorder/ios/stera_recorder/Sources/stera_recorder/session/ArFrameProcessorImpl.swift) lines 103/179/368 and [writer](../../packages/stera_recorder/ios/stera_recorder/Sources/stera_recorder/data/MCAPDatasetWriter.swift) lines 179/589. Platform capability references: [Core Motion](https://developer.apple.com/documentation/coremotion/cmmotionmanager), [ARCore depth APIs](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame), [ARKit depth confidence](https://developer.apple.com/documentation/arkit/ardepthdata/confidencemap).

## Upload: useful engineering, unproven volume readiness

The iOS path already has durable SQLite journals, frozen multipart plans, ListParts recovery, file-backed background URLSession tasks, per-part MD5, bounded 2 MiB copy buffers and temporary-file cleanup. Preserve these mechanisms. Its path/size-derived idempotency hash is not SHA-256 of source bytes; the planned real content hash remains necessary.

**Android currently rejects uploads as unsupported**, despite having recording/notification code. Native iOS extraction failures can immediately reselect a failed part; network failure retry can bypass Dart-only backoff while suspended. Its BGProcessing scheduler marks work complete before asynchronous fill finishes. Those are static code findings, not device-reproduced failures. They block a volume-readiness claim.

| Source size | Current iOS part size | Current extra-disk preflight |
| --- | ---: | ---: |
| 25 GiB | 48 MiB | 816 MiB |
| 50 GiB | 64 MiB | 1,088 MiB |
| 100 GiB | 128 MiB | 2,176 MiB |

Current code has one source at a time, a 16-part native backlog and adaptive foreground concurrency 5–10. The proposed MVP transport is fixed 64 MiB parts, two PUTs and three temporary chunks (192 MiB). Neither is a measured optimum. Benchmark throughput, temporary space, memory, flash I/O, battery and recovery before selecting concurrency/window settings. Keep per-source part geometry immutable after transport creation.

Native uploads currently allow expensive/constrained networks. Expose a deliberate Wi-Fi/cellular and charging policy for large collections. Apple background file uploads can continue under OS scheduling, but user force-quit cancels transfers until manual relaunch; signed URL renewal also needs a qualified suspended/relaunch path. Do not advertise uninterrupted force-quit uploads. [Apple background sessions](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:)), [background transfer rules](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background).

Source locations: [platform guard](../../apps/mobile/lib/src/services/upload_service/uploads_service.dart) line 173; [Dart coordinator](../../apps/mobile/lib/src/services/upload_service/coordinator/windowed_upload_coordinator.dart) lines 75/364/541/859/1212; [native fill/retry](../../apps/mobile/ios/Runner/background_uploader/manager/ChunkWindowManager.swift) lines 400/428/742; [part selection](../../apps/mobile/ios/Runner/background_uploader/journal/PartStore.swift) line 79; [BG scheduler](../../apps/mobile/ios/Runner/background_uploader/manager/scheduling/UploadProcessingSchedulerImpl.swift) line 42; [bounded extractor](../../apps/mobile/ios/Runner/background_uploader/chunk_extractor/ChunkExtractor.swift) line 24.

## Release gate

Close the concrete native gaps, validate the declared stream inventory against actual saved events, and run two consecutive sessions per supported platform. Then qualify a signed-device two-hour capture/upload/recovery/processing run with content hashes, actual sample counts/gaps, clock/geometry provenance, peak disk/RAM/heat, total bytes and useful hand overlays. Reconcile transport parts after connectivity changes, app suspension, forced termination/manual relaunch, URL/MPU expiry and uncertain completion. Keep explicit unsupported/unknown sensor states. Existing two short Pixel receipts prove acquisition on that device, not full iOS parity or high-volume readiness. No new Flutter/native tests were run in this audit; executables are not on the current shell PATH.
