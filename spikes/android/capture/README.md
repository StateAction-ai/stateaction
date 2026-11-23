# Android native capture feasibility spike — SA-60

Isolated package **`ai.stateaction.spike.capture`**. Does not replace or modify Stera/collector code. This is a foreground technical harness, not a shippable mobile app. Capture starts only after the user presses **Start camera recording**; no camera starts merely by installing/launching it. No upload/network permission, cloud workload or paid GPU.

## What it implements

- Native ARCore camera OES texture → OpenGL/EGL render → hardware `MediaCodec` encoder Surface. No CPU RGB readback; internal GPU/driver copies and total memory are **not yet measured**. The recorded claim is this path, not “zero-copy.”
- Probes for a native 1920×1080 ARCore image configuration at requested 30 Hz and hardware H.264 Main/Level 4.0 support at 12 Mb/s. Unsupported requests fail visibly; no silent lower resolution, software encoder, JPEG fallback or invented frame cadence. Checks actual SPS profile/level and slice headers for B frames; phone decoding/resource/quality tests remain required.
- Preserves complete Annex B access units, includes SPS/PPS at IDRs, assembles partial output, ignores config-only callbacks as frames, matches output to the original acquisition via a bounded unique-PTS map. Original nanoseconds survive microsecond encoder quantization. Encoder EOS and writer close have finite deadlines.
- Generic indexed MCAP (`Header.profile=""`), pinned full Foxglove Protobuf descriptor including Timestamp. CDR CameraInfo/PoseStamped/raw-depth/confidence channels coexist with JSON profile/clocks/frame/motion/sensor evidence. The mixed recording is not a `ros2`-profile file.
- Independent raw Android accelerometer and gyro callbacks requested at 100 Hz each; original native event times, axes, units, accuracy and actual callback/write counts. No fused/latest-value substitution.
- RGB continues through tracking loss. ARCore camera pose validity stays separate. Per-frame source raster/intrinsics and explicit image→texture UV geometry are retained; fixed full-image output raster has no crop/rotate/mirror. Camera metadata values are retained when exposed, otherwise null/unavailable.
- Conditional unique raw depth and its matching confidence are retained in native precision; native timestamps are retained with **unverified depth clock mapping and unqualified depth calibration**. No fabricated alignment or metric-accuracy claim. Mesh and point clouds are explicitly not collected in this narrow spike.
- Four pending visual frames; 16 MiB access-unit and writer-queue bounds plus 8,192 queued item bound; bounded MCAP chunk indexes. A required-evidence queue failure stops capture, rather than silently discarding evidence. Final metadata reports actual writer counts, unresolved outcomes and failure/interruption separately from structural closure.
- Stops on Activity pause, severe thermal state, low storage or the configured duration; keeps screen awake during the intentional foreground test. Periodic health evidence records sampled PSS, thermal status, battery and free storage. A crashed process leaves an explicit initial unclosed/interrupted metadata marker; **crash recovery/salvage is not implemented**.

Capture/profile identifiers are deliberately `stateaction.capture.spike.android.v1` / `android_h264_spike_v1`; JSON schemas are experimental evidence envelopes. They are not frozen production contracts/generated native bindings. The minimal protobuf wire encoder was independently decoded using the pinned descriptor in the processing spike; production generated bindings still require adoption/review.

## Important clock result

ARCore documents `Frame.timestamp` as nanoseconds with a **specifically undefined timebase**. Preserve that exact value, but do not treat it as `elapsedRealtime` by proximity. The initial harness required the chosen Camera2 camera's `SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME` and a positive `Frame.androidCameraTimestamp` immediately; the first physical run failed that assumption. The contained regression now prefers positive same-Frame `ImageMetadata.SENSOR_TIMESTAMP`, retains the optional accessor independently, checks disagreement and waits only a finite time for required clock evidence before rejecting. Only an explicitly documented REALTIME camera-clock source is projected through the fixed wall/monotonic anchor; Image/Frame native timestamps are never reclassified by proximity. Independent SensorEvent timestamps use their documented elapsed-realtime domain. Wall-anchor uncertainty is recorded; this is not a laboratory cross-sensor synchronization measurement. Conditional depth times remain native/unmapped.

References: [ARCore Frame](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame), [CameraCharacteristics timestamp source](https://developer.android.com/reference/android/hardware/camera2/CameraCharacteristics#SENSOR_INFO_TIMESTAMP_SOURCE), [SensorEvent timestamp](https://developer.android.com/reference/android/hardware/SensorEvent#timestamp), [MediaCodec](https://developer.android.com/reference/android/media/MediaCodec), [Foxglove CompressedVideo](https://docs.foxglove.dev/docs/sdk/schemas/compressed-video), [MCAP specification](https://mcap.dev/spec).

## Build and local tests

From project root:

```sh
source scripts/env.sh
spikes/android/capture/gradlew -p spikes/android/capture :app:assembleDebug :app:testDebugUnitTest --no-daemon --console=plain
```

APK: `app/build/outputs/apk/debug/app-debug.apk` relative to this directory. Seventeen JVM tests cover Annex B/length-prefixed conversion, B-slice detection, invalid packets, unique PTS quantization, wire content, indexed mixed-schema MCAP fixture writing, oversized/closed-writer rejection, the exact expanded-chunk hard bound, CDR timestamp precision and missing/mismatched/duplicate/regressed native camera clock evidence. These do not exercise Android's camera/hardware encoder.

Generated synthetic cross-language fixture: `app/build/spike-fixtures/native-writer.mcap`. The included 64×48 blue IDR test resource is generated by FFmpeg/libx264 solely for serializer validation; it is not phone/hardware/1080p evidence.

Build/source/APK/test receipt: `result.json`. The initial installed build A is preserved in `build-a-receipt.json`; a later bounded-chunk hardening build B has a separate APK/source hash. Physical evidence must name the installed build, not assume it uses the latest source. The first physical build B run failed before RGB acquisition; see `physical-failure.json`. A subsequent emulator-only native ARCore/OES/Surface software-encoding test passed 30 frames; see `emulator-result.json`. It does not qualify the imported Stera app, production hardware profile or recording lifecycle. [Use Stera as the base](STERA-INTEGRATION.md) records the exact findings and minimal integration path.

## Deliberate phone test (root agent coordinates)

Physical testing is currently blocked by the failed first camera run; do not hand another unexercised build to the user. First run the local regression/emulator paths and use the monorepo Stera recorder as the acquisition base. Before any future physical install, verify profiles with `adb -s "$SPIKE_ANDROID_SERIAL" shell cmd user list -v`, confirm personal full user 0 and verify this exact package is absent from managed profiles. Never install/run in a work profile. Confirm the user has intentionally chosen a scene before pressing Start. Installing the separate debug package does not install over the collector. Use the actual serial privately; do not commit it or captured video.

```sh
source scripts/env.sh
adb -s "$SPIKE_ANDROID_SERIAL" install --user 0 -r spikes/android/capture/app/build/outputs/apk/debug/app-debug.apk
adb -s "$SPIKE_ANDROID_SERIAL" shell am start --user 0 -n ai.stateaction.spike.capture/.MainActivity --ei duration_seconds 60
```

The duration extra sets a limit only; it never starts capture. Grant camera permission if prompted, then press Start again. Press Stop to drain/finalize, or wait for the duration. For a 10–20-minute controlled run, use 600–1200 seconds only after the short sample passes; first capture is not a two-hour qualification. No background/lock-screen camera run is claimed.

Read/copy the resulting session to a private ignored directory:

```sh
adb -s "$SPIKE_ANDROID_SERIAL" shell ls /sdcard/Android/data/ai.stateaction.spike.capture/files/sessions/
adb -s "$SPIKE_ANDROID_SERIAL" pull /sdcard/Android/data/ai.stateaction.spike.capture/files/sessions/ /tmp/stateaction-android-capture-physical/
```

Each session has `capture.mcap`, atomically written `metadata.json` and diagnostic capability/profile JSON files. Check metadata state/outcome and actual counts before attempting worker validation. Recompute MCAP SHA-256 after pull and compare with the stable closed-file hash. The final metadata excludes its own hash; external verification can hash it after close.

Required physical evidence still includes: initial sample decode/PTS identity, visual calibration/orientation, raw IMU actual rates/gaps, tracking loss, supported/unsupported depth, hardware output SPS/IDR/no-B behavior, two consecutive takes, intentional stop and interrupted stop. Then measure 10–20-minute bytes/hour, sampled/full peak memory, heat/battery, drop reasons, close time and hand/tool quality. Native clock/camera/codec output must actually satisfy the profile; build success is not device support.

## Scope still outside this spike

Production Flutter bridge/capture journal, strict shared schemas/generated bindings, auth/ownership, native uploads, full crash/power-loss recovery, all retained optional streams, depth geometry/synchronization qualification, signed release builds and the two-hour release gate. See the main capture/mobile design and the separate Android transfer and processing spikes. Reuse the narrow proved components after review; do not merge this harness wholesale into the app.

## Reproduce the contained emulator regression

These commands target **only** the verified synthetic-camera emulator personal user 0. Never substitute a physical serial; the instrumentation test also refuses non-`ranchu`/`goldfish` hardware. Root owns the product-path integration after this probe.

```sh
source scripts/env.sh
scripts/start_capture_emulator.sh --ar -no-window
```

Run the emulator command in its own terminal; after boot, build and test:

```sh
source scripts/env.sh
adb -s emulator-5582 shell getprop ro.kernel.qemu
adb -s emulator-5582 shell cmd user list -v
spikes/android/capture/gradlew -p spikes/android/capture :app:assembleDebug :app:assembleDebugAndroidTest :app:testDebugUnitTest --no-daemon --console=plain
adb -s emulator-5582 install --user 0 -r spikes/android/capture/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5582 install --user 0 -r spikes/android/capture/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5582 shell pm grant --user 0 ai.stateaction.spike.capture android.permission.CAMERA
adb -s emulator-5582 shell am instrument --user 0 -w -r ai.stateaction.spike.capture.test/androidx.test.runner.AndroidJUnitRunner
adb -s emulator-5582 exec-out run-as ai.stateaction.spike.capture --user 0 cat files/simulation-camera/report.json
```

Require `ro.kernel.qemu=1`, verified full personal user 0 and `OK (1 test)`; an instrumentation shell exit code alone is insufficient. Reports/encoded virtual-scene samples stay in ignored local/private paths. Seventeen JVM tests plus the one instrumentation test are distinct evidence. No new build is being handed to the physical phone as a result of this probe.

## SA-60 harness and qualification (current branch)

`harness/` holds the independent MCAP/H.264 verifier (`capture_verify.py`), the emulator-only driver and 32 Python tests; `app/src/androidTest/.../EmulatorMcapPathTest.kt` drives the real spike recording classes on the emulator. See [QUALIFICATION.md](QUALIFICATION.md) for commands, the evidence matrix and the gates that remain physical. Nx projects: `android-capture-spike` (`test`, `syntax`, `format`, `build`: the cached Gradle/APK/lint/MCAP cross-check; mobile-toolchain tag, so CI runs it inside the single guarded Android `run-many` (one storage reservation and one low-water watcher)).
