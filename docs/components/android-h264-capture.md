# Android H.264 capture (SA-51)

The existing Stera recorder (`packages/stera_recorder`) can record RGB as hardware H.264 access units inside the
published `stateaction.capture.v1.1` MCAP contract ([wire contract](../../packages/contracts/capture/README.md)).
JPEG is the default. Android preflights the exact H.264 profile when selected with `STATEACTION_RGB_CODEC=h264`. Nothing here claims physical-device, clock
synchronization, thermal or model-accuracy qualification.

## Profiles

| Profile                   | Where                 | Encoder                                                                     | Notes                                                                                  |
| ------------------------- | --------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `h264_mcap_v1`            | physical Android only | hardware AVC, 1920×1080, requested 30 fps, Main 4.0, no B, 12 Mb/s, 1 s IDR | `qualification=unqualified` until a phone receipt exists                               |
| `h264_mcap_simulation_v1` | emulator only         | any flexible-YUV AVC encoder, 640×480, Main 3.1, 4 Mb/s                     | `qualification=simulation_only`, `mapped_timeline_semantics=simulation_transport_only` |

Start runs a preflight before any file exists. An unsupported encoder, a camera CPU image that is not the exact
required raster, a camera clock source that is not `REALTIME` (hardware profile), the hardware profile on an emulator
or the simulation profile on a phone returns `errorCode=H264_PREFLIGHT`. There is no JPEG, HEVC, software, raster or
frame-rate fallback.

## What runs where

- **Flutter** passes the same validated `rgbCodec`/`h264SimulationMode` (and optional caller `recordingId`, a canonical
  lowercase UUID) to initialize and Start. No imagery crosses the bridge.
- **`H264RecordingController`** (producer thread) owns frame identity: it chooses the native camera clock with
  `CameraTimestampGate`, acquires the ARCore CPU `YUV_420_888` image, assigns the source frame ID and a unique encoder
  PTS, and queues detached evidence and encoded bytes to the writer thread. Pending frames (4), queued encoded bytes
  (16 MiB) and queued writer work (128) are bounded; overflow is a counted drop or an explicit failure.
- **`H264RgbEncoder`** copies the image into MediaCodec input using both images' real strides, requests a sync frame
  every second of PTS, releases every output buffer immediately and checks the emitted SPS (Main profile, requested
  level, stable SPS/PPS). End of stream is drained within a 10 s deadline.
- **`H264AccessUnitAssembler`** turns codec buffers into whole Annex B access units: stored codec configuration, partial
  buffers sharing one PTS, SPS/PPS prepended to IDRs that lack them. It replays the contract's
  `fixtures/encoder_buffers.json` byte for byte in the JVM tests.
- **`H264CaptureWriter`** writes exactly the contract channel table (JSON evidence topics, `/camera/rgb/video`,
  `/tracking/pose`) into the existing chunked, indexed `MCAPWriter`, which now writes real chunk and data-section CRCs.
  Legacy CDR/JPEG streams are not written in H.264 mode. Inventory and Close are written once at stop; `completed` is
  downgraded to `failed` if any frames are unresolved or no video was written.

## Clock and identity rules

- `Frame.timestamp` has an undefined time base; it is kept as `native_timestamps.arcore_frame_timestamp_ns` only.
- The native RGB clock is `Frame.androidCameraTimestamp` (`android.camera.sensor_timestamp`, mapped through one fixed
  elapsed-realtime→Unix anchor). `ImageMetadata.SENSOR_TIMESTAMP` is kept only when it equals that value. SA-60 saw it
  one capture behind on about 10 of 110 emulator frames; such frames are no longer aborted, and the stale value is
  excluded from that frame and counted (`metadata_timestamp_stale`/`_ahead`).
- [`Frame.acquireCameraImage()`](<https://developers.google.com/ar/reference/java/com/google/ar/core/Frame.html#acquireCameraImage()>)
  associates the CPU image with the current Frame. The Android camera timestamp supplies the RGB timeline and encoder
  PTS. The image's source-specific `Image.timestamp` and the original ARCore frame timestamp remain in
  `native_timestamps`. The sidecar counts differing image and RGB timestamp values for diagnosis.
  The recorder skips repeated CPU images and rejects missing or regressing image timestamps.
- When the emulator camera does not report a `REALTIME` source, the simulation profile uses the disclosed host receipt
  clock `android.elapsed_realtime_receipt`. This is not camera timing evidence.
- Tracking never gates RGB. Every acquired frame gets one `arcore_pose` SensorEvent; non-tracking frames are
  `pose_valid=false` with their tracking state.

## Raw motion

SA-53's independent accelerometer/gyroscope producer (`MotionCaptureController`) is unchanged. In H.264 mode its
`writeMotionEvents` output goes to the same recording: identical `MotionEventWire` payloads on
`/stateaction/imu/{accel,gyro}` with the H.264 `recording_id`, both declared as `android.elapsed_realtime` in
`Clocks.stream_clocks`, observed counts in the Inventory and exact per-topic counts in Close. Stop writes every
admitted motion event before the codec end of stream and Close, so SA-53's saturation and uncertain-stop failures
close the take as `failed`.

## Not in this revision

Depth and confidence (SA-55), calibration values inside the MCAP (the v1.1 Inventory carries only the calibration
_state_), and iOS.

## Saved calibration and settings (SA-54)

- **Calibration follows the saved pixels.** The H.264 path encodes ARCore's CPU image without crop, resize, rotation
  or mirroring, so the saved raster is the identity of the actual source image (`geometry/SavedRaster`,
  `geometry/H264Calibration`). Each frame's `camera.imageIntrinsics` must describe the source image and that image
  must match the encoder raster. The recorder rejects and counts mismatches (`calibration_rejected_frames`).
  The Inventory calibration is `state=yes` only when one verified calibration covers every accepted
  frame, `unknown` if intrinsics changed or frames were rejected, `no`/`unavailable` otherwise.
- **Values live in `metadata.json`.** The `saved_calibration` report contains source intrinsics, saved K 3x3 and P 3x4,
  the saved-raster transform, frame counts and the raster dimensions reported by the codec. The MCAP v1.1 Inventory
  carries the calibration state. Storing K/P in MCAP requires an additive contract change.
- **Settings are honored or refused before any side effect.** `RecordingConfig.fromMap` is strict: wrong types,
  unsupported values and conflicting `rgbHz`/`recordingHz` aliases return `INVALID_CAPTURE_SETTINGS` from
  `initializeSession`/`startRecording`. The legacy CPU JPEG profile (`rgbCodec=jpeg`) records 15 Hz only and refuses
  30/60 Hz. Fresh Android JPEG settings request 15 Hz. Saved settings still reach native validation. The
  explicit H.264 hardware profile requests 1080p30. The native motion producer uses
  `imuHz` as its sampling target. Start (`captureSettings`) and `metadata.json` (`capture_settings`) report the request,
  capture targets, and any requested streams the profile omits. Delivered cadence remains unverified.
- **Tracking loss never suppresses RGB.** Pose is exported only for a TRACKING camera; otherwise only an explicit
  `pose_valid=false` sensor event is written and RGB, intrinsics and raw motion continue.

## Reproduce locally

```sh
source scripts/env.sh
scripts/supervise_capture_emulator.sh --ar -no-window      # dedicated single-user emulator-5582
python3 scripts/test_android_h264_e2e.py --serial emulator-5582
```

The harness builds the recorder instrumentation APK, installs it with an explicit `--user 0` on the verified emulator,
runs `H264RecorderLifecycleInstrumentedTest` (actual ARCore/camera/`ArRecorderImpl`/MediaCodec; only Flutter's
texture registry is substituted), pulls every take into a new ignored `artifacts/android-h264-e2e/` directory and
validates it with `scripts/validate_h264_capture.py`. The validator reads each file with the official `mcap` reader
(CRC validation), flattens an in-memory copy for the SA-50 Python reference checker (the source file is never
rewritten) and decodes the access units with ffprobe/ffmpeg.

## Before delivering an H.264 collector APK

Run the Flutter smoke on the same source revision as the phone build. Use a clean, isolated worktree with an
`apps/mobile/.env` that contains only `NO_AUTH_MODE=true`. The smoke uses the phone build's H.264 flag and dev
package, plus the explicit simulation flag and x86_64 target required by the emulator.

```sh
source scripts/env.sh
agent-resource run --lane android-build -- bash -c '
  python3 scripts/mobile/run.py mobile prepare &&
  cd apps/mobile &&
  flutter build apk --debug --target-platform android-x64 --no-pub \
    --dart-define=STATEACTION_RGB_CODEC=h264 --dart-define=STATEACTION_H264_SIMULATION=true \
    --android-project-arg=stateactionApplicationId=ai.stateaction.collector.dev
'
agent-resource run --lane emulator -- python3 scripts/test_android_h264_collector.py \
  apps/mobile/build/app/outputs/flutter-apk/app-debug.apk
```

The smoke verifies KVM and host GPU rendering, installs on emulator user 0 and records through the actual Flutter
Start and Stop controls. It requires a completed MCAP with at least one `/camera/rgb/video` message, decodes every
access unit and checks the saved RGB counts against the file. The receipt is under `artifacts/sa59-collector/`.
The emulator uses software AVC.

After the smoke passes, build the ARM64 APK from the same sources with `--target-platform android-arm64` and
`--dart-define=STATEACTION_H264_SIMULATION=false`. Record the source commit and both APK hashes. Verify personal
profile targeting with [the personal-device guard](../../scripts/ANDROID_PERSONAL_DEVICE.md) before any phone
operation. Have the user intentionally start a short recording before any sustained capture.

Pull the whole short session directory into a private ignored directory. Keep the MCAP, `metadata.json`,
`finalization_journal.json` and any `recovery_required.json` marker together. Check the session before using the
build for longer takes.

```sh
agent-resource run -- uv run --no-project --with mcap==1.6.0 --with jsonschema==4.25.1 --with protobuf==6.33.0 \
  python -I scripts/validate_h264_capture.py --profile h264_mcap_v1 --check-sidecar \
  artifacts/phone-check/session_data.mcap
```

This check reads the full recording, so use it on the short confirmation take. It exits nonzero for a failed
or quarantined session, missing video, inconsistent counts or missing hardware AVC evidence.

## Capture performance diagnostics

The recorder reads each source and codec plane's strides once. Packed planes use bulk transfers. Strided planes
copy rows through reusable scratch buffers and preserve interleaved chroma bytes. The sidecar records the first
observed plane layouts under `h264_terminal.encoder.yuv_plane_layout`. The terminal `timing_ns` maps report call
count, total and maximum nanoseconds for ARCore acquisition, frame-thread work, codec submission and drain, and
writer work. Output drain includes EOS. The frame-thread total overlaps its acquisition and codec subtotals.

```sh
source scripts/env.sh
agent-resource run --lane emulator -- python3 scripts/test_android_h264_e2e.py --throughput-only
```

The synthetic test sends 150 distinct VGA images at nominal 30 Hz to the software AVC encoder. Each input
may wait for a buffer until its own 33.3 ms slot ends. The test allows one input drop and 100 ms of final scheduling
slack, and requires an exactly matching ordered PTS for every accepted input. The live preview path limits its input
poll to 10 ms.
The independent 1080p strided-copy test caps the 95th-percentile thread CPU cost at 10 ms. The 1080p30 hardware
cadence, 1% drop limit and preview responsiveness still require a physical Pixel measurement.

When an app-scoped Perfetto trace is active, the collector adds slices for ARCore update and preview, H.264
capture, YUV copy, codec input and drain, and MCAP chunk flush. The capture trace includes the original camera
timestamp and source-frame ID, so the MCAP can be joined to the trace at a cadence gap. Without a trace the
sidecar reports aggregate timings. Aggregate maxima alone cannot identify which frame stalled.

The sidecar's `h264_terminal.camera_optics` records the configured ARCore camera ID, its available focal lengths,
and the first reported focal length whose metadata timestamp matched the capture. A configured logical camera ID
or an available focal length does not identify the active physical lens. Use matched focal length, saved-raster
intrinsics and the handset camera configuration together when qualifying a lens.

## Why earlier tests missed the Pixel failure

SA-51 introduced the hardware timestamp equality requirement in merge commit `e5d578c` (PR #17).
It was still present in the November 23 development build at `69156c3`. Both Pixel takes reached AVC
configuration and end of stream, but the check rejected every CPU image before submission. The older
emulator lifecycle tests already required positive frame counts and decodable MCAP video. They entered
the native recorder directly and used a simulation-only exception for unequal timestamps. The local CI
gate runs host checks and builds without starting the emulator. Its JVM identity test enshrined the same
cross-clock equality assumption.
