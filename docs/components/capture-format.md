# Mobile capture format v1

Selected design · 2026-10-31 · **Implementation target, not qualified recorder output.** This is the normative source-format contract for [mobile implementation](mobile-app-implementation.md), [upload](mcap-upload.md) and [processing](cloud-processing.md). Existing source files stay immutable. The [capture audit](mobile-capture-and-upload-readiness.md) records current gaps.

## Format and initial profile

New captures use `capture_schema=stateaction.capture.v1`, `rgb_profile=h264_mcap_v1`: hardware H.264 RGB inside MCAP, with original sensor evidence. No separate source MP4 or duplicate JPEG track is required. The worker retains an explicitly identified `jpeg_mcap_v1` reader for historical captures; missing legacy evidence stays unknown. Legacy decoding is not permission to silently fall back when a new H.264 request is unsupported.

| Setting | Initial implementation request / acceptance |
| --- | --- |
| RGB raster/cadence | 1920×1080, 30 frames/s; saved raster and display rotation are separate. Record actual cadence and every intentional/dropped frame |
| Encoder | Hardware H.264, Main profile, Level 4.0, 8-bit YUV 4:2:0 SDR, no B frames; initial target bitrate **12 Mb/s**, IDR interval at most **one second** |
| Raw motion | Independent accelerometer and gyro, request 100 Hz each; retain every delivered original event and actual rate, without pairing/latest-value substitution |
| Conditional depth | Request up to 30 unique samples/s when supported; preserve actual native rate, source kind, precision, confidence/validity and timestamps. No duplicate frames to manufacture the requested rate |
| Duration/transport | Up to two hours; 100 GiB per source file remains a transport cap, not qualified capture/processing capacity |

The numeric encoder settings are **candidate engineering defaults**, not a measured quality, file-size or hardware-support guarantee. Query support before starting, verify the actual bitstream, and freeze the qualified per-device configuration/version after short and two-hour tests. Unsupported RGB/required motion returns an explicit error before capture; conditional streams declare unavailable. Do not silently lower bitrate/raster/cadence, change codec or switch to a software encoder. An intentionally changed profile is explicit and versioned. At 12 Mb/s RGB alone is nominally 5.4 decimal GB/hour; include sensors and overhead in actual budgeting.

Target bitrate allows normal hardware rate-control variation; measure actual bytes/rate rather than require exactly 12 Mb/s. Requested codec level may be only a platform hint: actual profile/level/no-B/IDR output must qualify or the device/profile remains unsupported.

Preserve color primaries, transfer, matrix, range, pixel format, orientation/mirror and camera identity. Do not assume Android and iOS produce equivalent color/raster transforms. Hardware status and all requested/supported/enabled/observed settings belong in final metadata. No audio/GPS expansion, inferred robot actions or validated metric trajectories are added.

## MCAP container and schemas

Use **`Header.profile=""`** (generic MCAP), not `ros2`: the registered ROS 2 profile requires every channel to use CDR. New files mix the following explicitly declared encodings; this is not a promise of direct rosbag2 replay. Write bounded chunks with channel/message indexes and a normal footer on successful close. Start with 1 MiB target uncompressed chunks and a 16 MiB hard per-message/chunk-input bound; a large record may exceed the chunk target but never the hard bound. Bound index growth in the two-hour test. [MCAP registry](https://mcap.dev/spec/registry)

| Topic / purpose | Schema and encoding |
| --- | --- |
| `/camera/rgb/video` | Exact schema name `foxglove.CompressedVideo`; Schema.encoding=`protobuf`; Channel.message_encoding=`protobuf`. Embed the complete binary `FileDescriptorSet`, including transitive Timestamp imports |
| Existing camera calibration, pose, depth and other retained sensors | Keep reviewed ROS message schemas with `ros2msg`/CDR per channel, including full referenced definitions. Do not reinterpret old bytes as a new schema |
| `/stateaction/capture_profile` | `stateaction.capture.Profile.v1`, JSON Schema / JSON; once at start, revision changes explicitly recorded |
| `/stateaction/clocks` | `stateaction.capture.Clocks.v1`, JSON Schema / JSON; native clock definitions and mapping revisions |
| `/stateaction/frame_events` | `stateaction.capture.FrameEvent.v1`, JSON Schema / JSON; acquisition and terminal encode/write/drop evidence |
| `/stateaction/imu/accel`, `/stateaction/imu/gyro` | `stateaction.capture.MotionEvent.v1`, JSON Schema / JSON; one original native event per message, independent counters/times/units |
| `/stateaction/sensor_events` | `stateaction.capture.SensorEvent.v1`, JSON Schema / JSON; native event IDs/times, calibration revisions and references to saved conditional/derived messages |

JSON schema encoding is `jsonschema`, message encoding `json`. Integers that may exceed safe JavaScript range use decimal strings, including nanoseconds and event IDs; actual MCAP binary sequence fields remain uint32. Generate Kotlin/Swift/Python bindings for the pinned Foxglove Protobuf descriptor. Own the custom JSON Schemas and Dart/TypeScript/Python conformance fixtures in `packages/contracts`; native serializers use the same fixtures. Pin source revision/hash and preserve schema/library license notices. Never download mutable schemas at runtime.

## Video packetization and identity

Each video message has `format="h264"`, the **capture** timestamp described below, optical coordinate-frame `frame_id`, and Annex B bytes for **exactly one complete frame/access unit**. `frame_id` means a coordinate frame, not a unique image number. Include SPS and PPS with the first and every subsequent actual IDR. Codec-config callbacks alone are not image frames. Never split an MP4 into arbitrary MCAP payload chunks. [Foxglove schema](https://docs.foxglove.dev/docs/sdk/schemas/compressed-video)

Assign `source_frame_id` and retain native capture time before encoding. Allocate a unique encoder PTS using a rational time base; preserve nanoseconds separately from Android microsecond quantization. Keep a bounded acquisition-to-PTS pending map. On output, recover identity using PTS/native source reference, not callback arrival order, and assign the video channel sequence explicitly. One acquired frame has exactly one terminal outcome: `written`, `dropped` with reason, or a finalization failure identifying unresolved IDs. Reconcile acquisition and actual video-message counts before declaring complete.

Android uses `MediaCodec`: handle output offsets/lengths and format changes, assemble any partial-frame output, extract codec configuration, and release input/output buffers promptly. iOS uses VideoToolbox: disable frame reordering, carry acquisition identity in the source-frame reference, read actual parameter sets and NAL length size, and convert length-prefixed AVC output into Annex B. Query hardware support and inspect emitted profile/B-frame/IDR behavior on both platforms. [Android API](https://developer.android.com/reference/android/media/MediaCodec), [Apple parameter sets](https://developer.apple.com/documentation/coremedia/cmvideoformatdescriptiongeth264parametersetatindex(_:parametersetindex:parametersetpointerout:parametersetsizeout:parametersetcountout:nalunitheaderlengthout:))

The profile must declare finite limits for pending frames, complete access-unit bytes, writer-queue bytes, IMU-queue bytes, encoder lag and close timeout. Start with four pending visual input frames and a 16 MiB writer byte budget, with independent bounded motion/evidence queues. These are candidate bounds to measure, not a RAM guarantee: codec buffers, decoded images and writer indexes also count. If required evidence cannot be retained within the bounds, stop/finalize visibly rather than accumulate indefinitely or silently discard it. Mid-stream codec/raster changes terminate the recording; start a new recording/profile rather than silently restart one video stream.

## Clock and evidence fields

At recording start sample a fixed pair of host monotonic time and Unix time. Use this anchor to project recorder-time values to Unix nanoseconds without following later wall-clock jumps. Keep original native times and clock IDs unchanged. A host projection is a display-time mapping, **not proof of cross-sensor synchronization**.

Android implementation finding: ARCore `Frame.timestamp` has an undefined timebase. The [capture simulation](../../spikes/android/capture/emulator-result.json) also observed CPU Image timestamps differing from camera `SENSOR_TIMESTAMP` in all 30 frames. Preserve Image, Frame and Android-accessor times separately. Prefer the acquiring Frame's `imageMetadata` `SENSOR_TIMESTAMP` under documented Camera2 `SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME` before applying the monotonic anchor; check a positive Android-accessor timestamp for disagreement. Optional metadata/timestamps can be unavailable during startup: record that state and use a finite availability deadline rather than fail on the first update or invent a CPU-image clock mapping. Raw SensorEvent time retains its documented elapsed-realtime domain. Unsupported clocks fail qualification; proximity cannot establish a mapping. Native depth times remain unmapped until qualified. [ARCore Frame](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame), [Camera2 timestamp source](https://developer.android.com/reference/android/hardware/camera2/CameraCharacteristics#SENSOR_INFO_TIMESTAMP_SOURCE).

| Time | Meaning |
| --- | --- |
| Original native event time | Exact platform value/unit/clock domain, retained in FrameEvent/MotionEvent/SensorEvent |
| Mapped capture time | Original capture time projected through a declared mapping revision to Unix; Foxglove `timestamp` and mapped sensor header time |
| Encoder PTS / time base | Encoder/decoder frame association and video timing; never acquisition time reconstructed from frame number/FPS |
| MCAP `publish_time` | Time the producer publishes the complete message, projected to Unix |
| MCAP `log_time` | Time the recorder accepts/appends that message, projected to Unix; may follow capture because encoding is asynchronous |

Every clock mapping declares source/target IDs, fixed anchor/offset and any rational scale, method, revision, uncertainty (unknown allowed) and status `same_domain|measured|unverified`. When no defensible capture-to-host mapping exists, retain the original event and explicitly unavailable mapped time; do not fill a false mapped timestamp. The required RGB profile must have a usable mapped capture timeline or fail capability/start qualification. Conditional sensors with unverified mappings remain unverified and cannot be nearest-time-associated as if synchronized. Update the current iOS writer's uptime-only plausibility guard for the new epoch-based MCAP policy; historical JPEG reading retains its original clock rules. [MCAP timestamp semantics](https://mcap.dev/spec)

For mapped new CDR sensor channels, normalize the header time using the declared capture mapping and retain the exact native value in SensorEvent. An unmapped conditional CDR channel instead retains its native header time and declares channel metadata `timestamp_semantics=native_unmapped` plus `clock_id`; its mapped capture time is null. Never invent epoch zero or substitute arrival time. The worker selects explicit mapping/timeline semantics rather than assume direct Rerun import aligns these channels.

Minimum custom evidence fields, expanded into strict schemas in the contract ticket:

| Record | Required content |
| --- | --- |
| Profile | Capture/profile/schema revisions; app/native/device/OS/camera IDs; exact encoder/color settings; stream requested/supported/enabled/observed states; requiredness; limits; calibration and clock references |
| FrameEvent | Recording/stream/source-frame ID; acquired/terminal state; original native time/unit/clock; mapping revision/mapped capture time if available; calibration/raster transform reference; encoder PTS/time base when submitted; output channel/sequence and IDR flag when written; failure/drop reason otherwise |
| MotionEvent | Sensor/event ID; native time/unit/clock; mapped time if available; original axes/units/values and accuracy status; accelerometer includes gravity or is explicitly derived; no fabricated covariance |
| SensorEvent | Source/stream/event IDs; exact native time/clock; matching saved channel/sequence; source kind, raster/precision/units, confidence/validity provenance and calibration revision; unknown association explicitly null |
| Final metadata | Separate `container_state=closed|unclosed|invalid` and `capture_outcome=completed|interrupted|failed|recovered`, reason and integrity result; source file roles/lengths; actual acquired/submitted/written/dropped/unresolved counts; sensor sample counts/gaps; writer/encoder errors; actual settings; sidecar closure; clock/calibration/schema hashes |

Raw accelerometer and gyro use separate native sensor APIs. Fused attitude, gravity-removed acceleration, estimated depth, mesh and point clouds remain separate, honestly labelled observations. Save matching calibration for the actual encoded pixels and conditional depth; initialize/reset calibration, counters and logs for every recording. RGB must continue during pose-tracking loss; pose validity changes independently. Preserve exposed camera exposure/focus/readout information and unavailable states. Confidence belongs to the depth source that produced it, never a different dense/raw-depth stream.

## Finalization, processing and conformance

Normal stop orders: stop producers → drain encoder to EOS with a finite timeout → reconcile every submitted frame → drain/close MCAP → close required sidecars → write final metadata atomically → acknowledge closed files → hash stable bytes → register/seal/upload. Encoder/writer failure cannot become a successful complete recording. Persist acquisition/outcome evidence; count successful samples only after writer acceptance. Never discard inline evidence until its sidecar has durably closed. A force-closed/crashed source remains unfinished; any explicit salvage produces a new derived file/identity/hash with original provenance, leaving the original bytes intact. No automatic incomplete-source upload as complete.

Final `metadata.json` inventories the other source files; it excludes its own size/hash entry. After atomic close, calculate its actual byte size/hash and place those in the external owner-bound journal and sealed source manifest. No self-hash or rewrite-after-hashing cycle.

A clean EOS/close after an early thermal/camera interruption can be `container_state=closed`, `capture_outcome=interrupted`, with full integrity evidence and shorter duration. It may upload/process with the interruption visible in QC; it is never labelled an uninterrupted two-hour success. Unclosed, malformed or unresolved-frame sources stay recovery-required/quarantined and are not auto-admitted. Structural closure, capture outcome and annotation usefulness are distinct checks.

The worker dispatches by capture profile, verifies every source hash and decodes H.264 sequentially once for hand inference. Remux native encoded frames to MP4 without reencoding, using actual IDR clip boundaries. Preserve original PTS/time base/origin in the frame map; set `clip_pts = source_pts - first_included_source_pts` in that rational time base. With no B frames, DTS equals PTS. Map preview/overlay time explicitly to that clip-relative origin. Choose the last valid IDR boundary within the 60-second ceiling; the final clip can end at EOS. Do not prepend an undecodable predicted frame, assume every frame is independently decodable, manufacture constant FPS or silently transcode a broken source. Violations fail with a specific decode/profile error. The spatial review proxy is a separate explicit transform/encode; RRD generation uses only clip-safe data. [Processing](cloud-processing.md), [Rerun](rerun-clip-review.md)

Required fixtures: mixed Protobuf/CDR/JSON schema decoding; delayed output interleaved with motion; varying frame intervals; SPS/PPS/IDR; partial/config-only output; missing/duplicate PTS; dropped and unresolved acquisitions; absent codec config; forbidden B frames; tracking loss; unequal clocks; calibration/raster changes; consecutive sessions; truncated close; full-content hash mismatch; IDR-safe clip remux; and historical JPEG. Compare decoded frame identities/times across Kotlin, Swift and Python fixture readers, then prove real signed Android/iOS samples through the local workflow, hand inference and embedded viewer. Synthetic fixtures do not establish device quality or two-hour reliability.
