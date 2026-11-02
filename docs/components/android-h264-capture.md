# Android H.264 capture (SA-51)

The existing Stera recorder (`packages/stera_recorder`) can record RGB as hardware H.264 access units inside the
published `stateaction.capture.v1.1` MCAP contract ([wire contract](../../packages/contracts/capture/README.md)).
JPEG remains the default; H.264 is an explicit build selection. Nothing here claims physical-device, clock
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
  downgraded to `failed` whenever frames are unresolved.

## Clock and identity rules

- `Frame.timestamp` has an undefined time base; it is kept as `native_timestamps.arcore_frame_timestamp_ns` only.
- The native RGB clock is `Frame.androidCameraTimestamp` (`android.camera.sensor_timestamp`, mapped through one fixed
  elapsed-realtime→Unix anchor). `ImageMetadata.SENSOR_TIMESTAMP` is kept only when it equals that value. SA-60 saw it
  one capture behind on about 10 of 110 emulator frames; such frames are no longer aborted, and the stale value is
  excluded from that frame and counted (`metadata_timestamp_stale`/`_ahead`).
- Hardware profile: the encoded CPU image must carry the accepted native camera clock written as the RGB clock (`Image.timestamp == accepted cameraNs`, i.e. `Frame.androidCameraTimestamp`), decided by `CpuImageIdentityPolicy`. `Frame.timestamp` is separate evidence and never an equality requirement. A mismatch is a counted, skipped drop.
  A different or repeated CPU image is skipped and counted, never relabelled.
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

Depth and confidence (SA-55), saved calibration values and calibration resets (SA-54; the one declared calibration is
`state=unknown`), inventory hashing/manifest (SA-18), iOS.

## Reproduce locally

```sh
source scripts/env.sh
scripts/start_capture_emulator.sh --ar -no-window      # dedicated single-user emulator-5582
python3 scripts/test_android_h264_e2e.py --serial emulator-5582
```

The harness builds the recorder instrumentation APK, installs it with an explicit `--user 0` on the verified emulator,
runs `H264RecorderLifecycleInstrumentedTest` (actual ARCore/camera/`ArRecorderImpl`/MediaCodec; only Flutter's
texture registry is substituted), pulls every take into a new ignored `artifacts/android-h264-e2e/` directory and
validates it with `scripts/validate_h264_capture.py`. The validator reads each file with the official `mcap` reader
(CRC validation), flattens an in-memory copy for the SA-50 Python reference checker (the source file is never
rewritten) and decodes the access units with ffprobe/ffmpeg.

A separate development identity keeps test installs away from the existing collector:

```sh
cd apps/mobile
flutter build apk --debug --dart-define=STATEACTION_RGB_CODEC=h264 \
  -P stateactionApplicationId=ai.stateaction.collector.dev
```

Add `--target-platform android-x64 --dart-define=STATEACTION_H264_SIMULATION=true` for the emulator profile. Physical
installs and Start are root-only, personal-profile-only and require the user's intentional Start; see
[the personal-device guard](../../scripts/ANDROID_PERSONAL_DEVICE.md).
