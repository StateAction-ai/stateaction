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

A separate development identity keeps test installs away from the existing collector:

```sh
cd apps/mobile
flutter build apk --debug --dart-define=STATEACTION_RGB_CODEC=h264 \
  -P stateactionApplicationId=ai.stateaction.collector.dev
```

Add `--target-platform android-x64 --dart-define=STATEACTION_H264_SIMULATION=true` for the emulator profile. Physical
installs and Start are root-only, personal-profile-only and require the user's intentional Start; see
[the personal-device guard](../../scripts/ANDROID_PERSONAL_DEVICE.md).

## Local replay format evaluation (SA-139)

The current Android replay reads MCAP video messages by index and sends each Annex B access unit from Dart to Android. `MediaMuxer` writes a temporary MP4, and leaving replay deletes it. Opening the same clip repeats the full export. The track takes SPS/PPS from the opening IDR as `csd-0`/`csd-1`, makes presentation timestamps relative to the first MCAP `log_time`, and marks IDRs as sync samples. There is no re-encode. Android supports MP4 B-frame muxing from API 25, but this capture profile rejects B slices and expects increasing timestamps. Arbitrary H.264 streams would need separate validation. [Android MediaMuxer](https://developer.android.com/reference/android/media/MediaMuxer)

### Direct playback feasibility

Media3 can use a custom `Extractor` with `ProgressiveMediaSource`. An extractor for this profile would announce AVC format, emit the access units one sample at a time, and expose a `SeekMap`. MCAP indexes map `log_time` to message offsets but carry no sync-frame flag. Use the recorder’s encoded frame evidence or inspect the NALs to map IDRs to chunk/file positions. To scrub, seek to the preceding IDR, supply SPS/PPS, then decode up to the requested time. The index offsets inside compressed chunks address uncompressed data, so the reader must inflate those chunks with bounded memory. Missing indexes, corrupt chunks, invalid samples and incompatible codec configuration need explicit handling. Consecutive scrub requests should cancel superseded work. [Media3 customization](https://developer.android.com/media/media3/exoplayer/customization), [ProgressiveMediaSource.Factory](https://developer.android.com/reference/androidx/media3/exoplayer/source/ProgressiveMediaSource.Factory), [SeekMap](https://developer.android.com/reference/androidx/media3/extractor/SeekMap), [MCAP specification](https://mcap.dev/spec)

Feeding Annex B to `MediaCodec` with a render surface is also possible. The decoder needs a sync frame after a seek/flush and appropriate codec configuration. The app would additionally own the playback clock, buffer lifecycle, surface lifecycle and scrubbing. A narrow Media3 extractor is the smaller direct-playback option, estimated at several engineering days for this contract plus seek, error and device testing. Startup and seek latency are unmeasured. Foxglove documents playback by log time and decoding per-frame Annex B video messages in its image panel. That establishes a viewer precedent, with no Android timing claim. [Android MediaCodec](https://developer.android.com/reference/android/media/MediaCodec), [Foxglove compressed video](https://docs.foxglove.dev/docs/sdk/schemas/compressed-video), [Foxglove image panel](https://docs.foxglove.dev/docs/visualization/panels/image), [Foxglove playback](https://docs.foxglove.dev/docs/visualization/playback)

CameraX uses MP4 and supports MediaStore destinations. Android’s platform playback format list includes MP4 and omits MCAP. A direct in-app player would still need an export if users need to share clips with ordinary gallery or video apps. The existing StateAction upload and worker input use the MCAP, so web ingestion needs no phone-generated MP4. [CameraX video capture](https://developer.android.com/media/camera/camerax/video-capture), [Android supported media formats](https://developer.android.com/media/platform/supported-formats)

### Measured on the emulator

Three replays each of synthetic 1080p/30, 13 Mb/s, indexed H.264 MCAPs on the guarded API33 emulator. The table reports medians. The full export timer runs from Android export creation through `MediaMuxer.stop()` and includes the Dart reader and per-frame bridge. Native time sums validation, sample writes and muxer setup/close. First visible frame is measured from opening the video topic to the first test pattern seen in an ADB screenshot, which includes sampling overhead.

| Clip | MCAP bytes | MP4 bytes added | Complete export | Native validation and muxing | First visible frame |
| --- | ---: | ---: | ---: | ---: | ---: |
| 15 s | 25,057,838 | 25,019,912 | 2.76 s | 0.77 s | 4.16 s |
| 60 s | 100,228,181 | 100,078,157 | 6.23 s | 1.79 s | 6.94 s |

An MP4 made from a separate captured emulator take had `ftyp`, `moov`, `free`, then `mdat`. Pixel replay times and actual 60-second disk use are unverified. One sealed 15.57-second Pixel MCAP exists at 25,717,446 bytes. That build had no playback timers.

### Container and decision

A normal MP4 is usable after `MediaMuxer.stop()` writes the complete file. For a derived sidecar, write a temporary file, verify that its first frame decodes, and atomically publish it with the source MCAP SHA-256. A killed or failed export can be discarded and retried from the intact source. Fragmented MP4 preserves completed fragments better across interruption but adds an unnecessary recovery path for that disposable output. For progressive HTTP, Android requires `moov` before `mdat`. A local seekable MP4 can read a trailing `moov` without a fast-start rewrite. Check placement on the supported devices before relying on it. [Android supported media formats](https://developer.android.com/media/platform/supported-formats), [FFmpeg MP4 fragmentation](https://ffmpeg.org/ffmpeg-formats.html#Fragmentation), [Media3 FragmentedMp4Muxer](https://developer.android.com/reference/androidx/media3/muxer/FragmentedMp4Muxer)

**Recommendation.** Keep MP4 generation out of Stop & Save until the Pixel measurement. The current 60-second path took 6.23 s in simulation and the MP4 nearly doubled video storage, about 100 MB per minute at this fixture bitrate. For long takes where local playback is the only requirement, prefer the Media3 extractor if that storage cost is unacceptable. If the complete Pixel export is under about two seconds for 60 seconds and extra storage fits the product budget, generate one normal MP4 during Stop & Save to keep the standard player and shareable output. The emulator’s native time suggests that eliminating one Dart round trip per sample may help, but native end-to-end performance is unmeasured. Build only the chosen path.
