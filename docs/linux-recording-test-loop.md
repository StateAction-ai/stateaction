# Linux recording test loop

Research date: 2026-10-22. Scope: the source-built Android Stera recorder and the local processing adapters.

**Use three complementary loops: deterministic recorder fixtures on Linux, an Android emulator for the actual app/framework path, and a reusable ARCore recording on the Pixel.** This lets us debug most changes without asking for another hand demonstration. The emulator cannot validate ARCore depth, and rendered scenes cannot reproduce Android camera API behavior.

## Why the previous tests missed the failure

The first physical test of the geometry-v1 APK produced zero RGB, depth and pose messages, with 310 encoder failures. The exception detail was not retained because the earlier system-log writer was not initialized. The earlier 15 JVM tests checked geometry helpers, plane packing, serialization and recording-state synchronization. They did not execute the complete Android `Image` → `YuvImage.compressToJpeg()` path. The Python MCAP tests write their fixture with a Python writer; they prove the reader handles those fixtures, but do not prove the Kotlin writer and Python reader agree. See [v2 validation receipt](geometry-v2-build-receipt.json), [encoder](../packages/stera_recorder/android/src/main/kotlin/open/fpvlabs/stera/ar_recorder/encoding/CpuImageEncoder.kt), [Android tests](../packages/stera_recorder/android/src/test/kotlin/open/fpvlabs/stera/ar_recorder/geometry/) and [MCAP tests](../tests/test_capture_geometry_mcap.py).

A particularly important fixture must give the ARCore frame and Android camera different timestamps. ARCore documents the frame timestamp's time base as unspecified and exposes a separate Android camera timestamp. Equal-looking values are insufficient evidence that all streams share a clock. The updated recorder compares the acquired RGB image against `Frame.getAndroidCameraTimestamp()`, retains the acquisition association separately, and reports the values that caused any rejection. The zero-RGB capture alone does not establish which failing check was responsible. [Official Frame contract](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame).

## What is available and what remains work

| Layer | Useful evidence | Important limit | Local status at this research snapshot |
|---|---|---|---|
| Pure JVM/Python fixtures | Coordinate transforms, strides, explicit failure handling, MCAP association, export masks | A helper pass says nothing about unexecuted Android framework calls | Prior baseline: 15 JVM and 44 Python tests; current suites passed 24 JVM and 65 Python tests |
| Robolectric encoder fixture | Production encoder's rejection, cleanup and diagnostic paths with controlled `Image` inputs | Robolectric 4.14.1 does not implement the actual `YuvImage.compressToJpeg()` path used here | Three stale-timestamp/truncated-plane/calibration-mismatch tests passed; JPEG success is tested on native Android instead |
| Android instrumented fixtures | Production encoder using real Android JPEG implementation, then production Kotlin MCAP writer | Input `Image` is controlled test data, not a live camera image | **Five tests passed on the emulator**; Python decoded the exported three-frame RGB/pose/depth fixture with separate clocks and repeated-depth association preserved |
| Android emulator app | APK installation, permissions, UI, lifecycle and framework/camera integration with VirtualScene | **ARCore Depth API unsupported**; no Pixel sensor accuracy or thermal evidence | API35 fails on camera ID `0` versus `10`. Pinned emulator36.4.10 with API33r17 initializes/resumes ARCore and receives camera `0` frames, but tracking remains `PAUSED`; no live app MCAP saved |
| Native ARCore session playback on Pixel | Repeat a recorded environment through ARCore and the production recorder | Real-time, nondeterministic outputs; requires a native ARCore dataset | Proposed integration, not present in the current Stera capture workflow |
| Rendered synthetic scenes | Known geometry, visibility, poses and controlled calibration mistakes | Cannot exercise the Android camera driver or establish real-world model accuracy | Optional later fixture generator |

Robolectric runs instrumented Android framework code on a JVM and substitutes selected system/native behavior. Test names should describe the exercised encoder path without claiming physical camera coverage. [Robolectric architecture](https://robolectric.org/architecture/). Google's explicit emulator depth restriction controls the emulator row above. [Depth quickstart](https://developers.google.com/ar/develop/java/depth/quickstart).

The final geometry-v2 debug APK contains arm64 and x86_64 libraries and was installed successfully on the Pixel. Its SHA-256 is `75f5848adf7ad8e8f3157d83d61919f2d6d2c7d95b792f1cb61587c8e475fed0`. Installation did not launch the app or produce a new physical recording. The test totals are **24 JVM, five native Android instrumented, 65 Python and one Dart regression**; they establish software coverage, not measured hand/depth accuracy. The original geometry-v1 capture's exact encoder exception was not retained, so the subsequent changes should not be presented as a conclusively reproduced cause of that particular zero-RGB run. [Build, installation and test provenance](geometry-v2-build-receipt.json).

## 1. Make the Linux fixtures exercise the production boundary

The immediate regression should call the actual `CpuImageEncoder.encodeImage()` implementation, supply a synthetic `Image`, decode its JPEG, and inspect the decoded pixels. An asymmetric four-quadrant image detects orientation errors; separate chroma patterns detect swapped U/V channels. JPEG is lossy, so compare decoded values with tolerances rather than comparing compressed bytes.

The new [native Android instrumented tests](../packages/stera_recorder/android/src/androidTest/kotlin/open/fpvlabs/stera/ar_recorder/encoding/CpuImageEncoderInstrumentedTest.kt) cover a nonzero buffer position, row padding, interleaved chroma, a distinct frame clock, stale image rejection, truncated planes and calibration mismatch. **All five instrumented tests passed on `emulator-5580`.** They use controlled `Image` inputs but call Android's actual JPEG implementation. A separate [Robolectric version](../packages/stera_recorder/android/src/test/kotlin/open/fpvlabs/stera/ar_recorder/encoding/CpuImageEncoderAndroidTest.kt) is not interchangeable with that native result. Follow with these additions:

1. Exercise camera-image unavailability, encoding failure and rejected writer enqueue. Require an explicit failure reason and correct image release; a failed frame must not increment successful RGB count. ARCore permits transient image unavailability, including after startup, so a brief warm-up failure differs from a session containing no saved RGB. [Acquisition exceptions](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame#acquireCameraImage()).
2. **Implemented and checked:** successful encoded fixtures pass through the **production Kotlin MCAP writer**, close normally, and decode with `GeometrySession`. The resulting three-frame fixture preserves distinct RGB/frame clocks and differently valued depth payloads sharing a native timestamp. The [archived fixture and regeneration commands](../tests/fixtures/android_geometry_v2/README.md) include producer/artifact provenance; [Python regression tests](../tests/test_android_writer_fixture.py) verify the original Android-produced bytes.
3. Include repeated native depth timestamps with different acquisition events, dropped RGB, missing depth, paused tracking, a crop-aware mapping, two clock domains and an unknown contract version. Assert exact acquisition association and explicit invalid/unknown status.
4. Run one full start → capture → pause → resume → stop sequence with queued work. Assert that finalization cannot precede an in-flight producer and that every emitted JPEG has a matching geometry row.

Existing commands, from the project root:

```sh
source scripts/env.sh
cd apps/mobile/android
./gradlew :stera_recorder:testDebugUnitTest
cd ../../../..
.venv-stera/bin/python -m unittest discover -s tests -p 'test_capture_geometry*.py'
.venv-stera/bin/python -m unittest discover -s tests -p test_android_writer_fixture.py -v
```

The commands above cover the local suites. The [Android test runner](../scripts/test_android_capture.sh) builds/runs the JVM suite, installs only the instrumented test APK on an explicitly selected emulator, runs native tests, and pulls the generated producer fixture and logs. It refuses physical devices:

```sh
scripts/test_android_capture.sh emulator-5580
```

The final run passed **24 JVM tests and five native instrumented tests**. Writer-failure tests now inject an output-stream failure after a successful RGB frame: sticky errors invalidate the capture, and a broken MCAP cannot prevent the independent metadata sidecar being marked invalid. Successful frames cannot mask later write/finalization failures. Python decoding remains a separate check against the archived Android-produced fixture.

**The full synthetic producer pipeline also completed:** Android encoder/writer fixture → `GeometrySession` → MediaPipe → MP4/HDF5/HTML/Rerun, for all three frames. No hands are expected in this artificial image. HDF5 retained exact clock mappings and all three known camera poses; cross-stream synchronization remained explicitly unverified. Rerun's headless ingestion check exited successfully. This is real software integration coverage using synthetic sensor inputs, not a live AR camera test. [Pipeline receipt](../captures/synthetic_android_geometry_v2/receipt.json).

## 2. Run the actual app in an Android emulator

Google supports ARCore on x86/x86_64 Google APIs system images from API 27 onward, with the rear camera configured as **VirtualScene**. Native libraries must include a compatible emulator ABI. Google Play Services for AR may require its emulator-specific x86 APK. The selected local target is API 35 Google APIs x86_64. [ARCore emulator setup](https://developers.google.com/ar/develop/java/emulator).

The host is Linux x86_64 with accessible KVM and sufficient disk space, as checked during setup. Installed emulator: **37.2.12.0**; system image: **API 35 Google APIs x86_64 revision 09**. The AVD is `stera_ar_api35`, using port 5580 and ADB serial `emulator-5580`. This custom SDK location needs an explicit `ANDROID_AVD_HOME`; otherwise the emulator does not find the created AVD.

```sh
source scripts/env.sh
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
"$ANDROID_HOME/emulator/emulator" -accel-check
"$ANDROID_HOME/emulator/emulator" -list-avds
scripts/start_capture_emulator.sh -no-window
```

The [launcher](../scripts/start_capture_emulator.sh) defaults to `stera_ar_api35`, port 5580, rear `virtualscene`, no front camera/audio/snapshots, and `swiftshader_indirect` graphics. It accepts `-no-window` for headless use. The launch reached **`sys.boot_completed=1`**. Google Play Services for AR **1.57.262640093** installed successfully from the 1.57.0 x86 emulator APK, SHA-256 `92741f6f873c232a07173b50adeee6b1c2f5a048bc071c80cf741b0cde0f73c4`. Linux VM acceleration uses KVM. [Acceleration](https://developer.android.com/studio/run/emulator-acceleration), [emulator CLI](https://developer.android.com/studio/run/emulator-commandline).

Prefer an `android-x64` app build for this AVD to avoid relying on native-library translation. This specific system image advertises both x86_64 and arm64-v8a, with `libndk_translation.so`. **Both the ARM64 and native x64 builds failed AR session creation**, reporting unknown camera device `0` while the emulator HAL exposed rear ID `10`. Logs verify that the x64 attempt loaded x86_64 ARCore native libraries, so ARM translation does not explain that failure. In `apps/mobile`, after sourcing the environment:

```sh
flutter build apk --debug --target-platform android-x64
```

**The targeted compatibility experiment achieved partial progress locally.** A firsthand report in the official ARCore tracker encountered this camera-ID failure on API 35/36, but camera `0` existed on API 33 revision 17. Its working Linux configuration used emulator 36.4.10 build 15004761, ARCore's 1.56 emulator APK, host OpenGL and Vulkan disabled; newer emulator versions had a separate camera-timestamp regression. Another reporter independently found API 33 workable. [ARCore issue 1788](https://github.com/google-ar/arcore-android-sdk/issues/1788), [API 33 report in issue 1647](https://github.com/google-ar/arcore-android-sdk/issues/1647#issuecomment-3478556035).

Our separate `stera_ar_api33` AVD uses API33 Google APIs x86_64 revision17, pinned emulator36.4.10, ARCore1.57, software OpenGL (`swiftshader_indirect`) and disabled Vulkan. It runs as `emulator-5582`. The actual app now initializes, configures and resumes ARCore and receives camera `0` frames, resolving the earlier session-creation blocker. Tracking still stays `PAUSED`. Logs show visual-inertial processing around 2.5–3.1Hz and `RESOURCE_EXHAUSTED`/initialization failures, including after reducing the UI to 720×1280 and stopping the API35 emulator. Host OpenGL could not initialize in this headless environment because `DISPLAY` was unset. These observations do not establish a single remaining cause. **No live app MCAP was saved and the end-to-end live app test has not passed.** The app was stopped after testing. [Local emulator validation receipt](linux-emulator-validation.json).

Launch this separate compatibility target with:

```sh
scripts/start_capture_emulator.sh --ar -no-window
```

Preserve both AVD configurations: API35 already supports the native instrumented codec tests, while API33 is the current live-AR investigation target. `CAPTURE_EMULATOR_GPU=host` selects host graphics when a usable display/GPU is available; that configuration is not verified on this host. Do not confuse the test APK's synthetic writer fixture with a recording made by the live app.

**Proposed acceptance run:** record a 20-second virtual-scene session, pause/resume once, stop, pull the MCAP and inspect it. Require at least one decoded RGB frame initially; then measure expected versus actual frame counts, valid JPEG dimensions, per-frame calibration, explicit timestamp fields and final file readability. Report missing depth as expected emulator behavior. Do not fake depth or disable production geometry rejection to make this run pass.

Place a custom asymmetric calibration image in the virtual scene and replay emulator camera-motion macros for repeated UI tests. These are useful controlled inputs, not deterministic ARCore outputs or real hand motion. Google documents imported PNG/JPEG scene images and preset AR-action macros. [Emulator camera support](https://developer.android.com/studio/run/emulator-use-camera).

## 3. Record a native ARCore dataset once, replay it on the Pixel

This is the useful next step after the encoder works: capture a short calibration-and-hand sequence once, then iterate on the recorder while the phone stays on the desk. Add a debug-only native-session recording/playback mode and record its configuration/version alongside output MCAP. This remains proposed work.

Use ARCore's `RecordingConfig` and `Session.startRecording()` to create the dataset. Supply that dataset through `setPlaybackDatasetUri()` before resuming the replay session. Playback runs at recorded speed, and results can vary across runs. Pausing a playback session can discard intervening data; reset the dataset to restart an experiment. Prefer invariant and tolerance checks over byte-for-byte comparisons. [Native recording/playback API](https://developers.google.com/ar/develop/java/recording-and-playback/developer-guide).

The input must be a **native ARCore recording with its sensor/data tracks**. An ordinary phone MP4 or our existing Stera MCAP is not an interchangeable playback dataset; no converter is implemented here. The native recording stores CPU-image video and sensor information. Configure the desired CPU resolution during recording; do not assume it preserves the displayed GPU image. Its RGB depth-visualization track is for preview, not metric depth labels. [Recording contents](https://developers.google.com/ar/develop/recording-and-playback).

First verify that the selected dataset/device configuration exposes the CPU/depth APIs the recorder needs. Record per-run availability and tracking status. Replay is not a promise of identical depth estimates, and it does not establish cross-stream clock synchronization or calibrated accuracy. Keep native images/metadata captured at the recorder boundary as the deterministic regression input.

## When a robotics simulator becomes useful

For today's missing-JPEG problem, a full physics simulator adds no coverage of the failing Android API path. After capture works, synthetic geometry is valuable for testing whether we correctly preserve known camera poses, project joints, reject occluded evidence and export depth units. This is an engineering recommendation, not an empirical comparison of simulators.

| Option | Appropriate later experiment | Effort decision |
|---|---|---|
| MuJoCo | A calibrated camera viewing a simple articulated hand/tool fixture; render RGB/depth/segmentation and export known landmark positions | First choice if an existing research model can be reused; its renderer supports offscreen camera output and depth/segmentation modes. [Official rendering documentation](https://mujoco.readthedocs.io/en/latest/programming/rendering.html) |
| Isaac Sim / Replicator | Larger scene variation, multiple cameras and labeled synthetic images | Use when those scene-generation needs justify it; official examples expose RGB, semantic labels and camera parameters. [Replicator examples](https://docs.isaacsim.omniverse.nvidia.com/latest/replicator_tutorials/tutorial_replicator_getting_started.html) |

Neither automatically supplies a correct human-hand landmark schema: define anatomical landmark locations, visibility rules and camera conventions explicitly. Begin with an analytically projected asymmetric target, then add a hand mesh only when testing the hand estimator. Keep synthetic sensor behavior labeled as synthetic. Real motion blur, sensor timing, depth failure and grasp occlusion still need measured physical evidence.

## Immediate completion criteria

1. Reproduce the failed RGB contract in a Linux test and make the production encoder regression pass.
2. Obtain an emulator MCAP containing decoded RGB and matching geometry rows through the actual app/writer. Archive setup versions and counts, with depth marked unavailable.
3. Preserve the now-verified Kotlin-writer/Python-reader fixture as a repeatable regression, including its source/build provenance. Keep the implemented writer-failure tests in the same test loop.
4. Confirm one short Pixel capture has RGB before requesting a longer hand sequence. Then validate registration and depth on an asymmetric measured target.
5. Add native ARCore recording/playback only after those checks pass, to reduce repeated manual capture effort.

A separate proposed test will run a publicly available egocentric video through the video-processing path. It can test visible hand detections and export behavior without a new user recording. Ordinary video has no measured ARCore pose, calibrated metric depth or synchronized IMU, so it must remain a video-only deliverable with missing geometry explicit. This work is independent of the live-AR emulator blocker and was not complete at this source snapshot.

Do not treat the old geometry-v1 build receipt or passing helper tests as evidence that these newer milestones have passed. Record their results in a new receipt tied to the tested APK and source hashes.
