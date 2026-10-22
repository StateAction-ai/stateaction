# Android CPU capture geometry contract

`capture_geometry_version = android_arcore_cpu_v3` identifies the recorder contract described here. It is **not** a claim that inferred depth or hands are accurate. Existing captures without this version retain their original geometry and must not be silently relabeled.

RGB is JPEG encoded directly from the full native `Frame.acquireCameraImage()` YUV image. The recorder verifies full `cropRect`, even dimensions, exact agreement with `camera.imageIntrinsics.imageDimensions`, and strictly increasing saved timestamps within the native CPU RGB stream. It associates the CPU image through `Frame.acquireCameraImage()` on the same frame; it does not compare independent clocks for equality or use an arbitrary tolerance. It handles planar/interleaved chroma, row/pixel strides, buffer positions and trailing-padding absence. It closes the acquired image on success or failure. GPU UV transforms remain exclusively in the display preview; consequently recorded pixels can look rotated relative to the preview.

`camera.pose` remains the physical ARCore camera-to-world transform. The optical frame (+X right, +Y down, +Z forward) maps into this camera (+X right, +Y up, −Z forward) by `diag(1,-1,-1)`, quaternion XYZW `[1,0,0,0]`. The same transform is recorded in `/tf`.

Depth retains its native `acquireDepthImage16Bits()` pixels, 16-bit millimeters, and native `Image.timestamp`. It can have a different aspect ratio/crop from CPU RGB. For each acquisition, `Frame.transformCoordinates2d(IMAGE_PIXELS, TEXTURE_NORMALIZED)` maps RGB corners into the depth domain. Multiplying normalized coordinates by depth dimensions gives the row-major affine `rgb_pixel_to_depth_pixel` matrix H. Depth intrinsics are `H * K_rgb`; positive axis-aligned scale/translation is supported. Unsupported rotation, reflection, non-affinity or partial image crop rejects depth instead of guessing. The saved pixels are not resampled or rotated.

## Per-frame MCAP record

Topic `/capture/frame_geometry`, schema `std_msgs/msg/String`, CDR `data` field containing JSON. It records:

- `capture_geometry_version`, `frame_timestamp_ns`, `android_camera_timestamp_ns`, `tracking_state`, `cross_stream_clock_verified=false`.
- `rgb_frame_association="Frame.acquireCameraImage_same_frame"`, `rgb_timestamp_clock="ARCore_Image_timestamp_source_specific"`, `frame_timestamp_clock="ARCore_Frame_timestamp_timebase_undefined"`, `android_camera_timestamp_clock="Frame.getAndroidCameraTimestamp"`.
- `rgb_capture_diagnostics`: acquisition stage, observed image format/dimensions/crop/plane strides/timestamps, and exception class/message on rejection.
- `rgb_encoded`, `rgb_timestamp_ns`, `rgb_width`, `rgb_height`, `rgb_intrinsics`.
- `depth_available`, `depth_timestamp_ns`, `depth_width`, `depth_height`, `depth_intrinsics`, `rgb_pixel_to_depth_pixel` (nine row-major numbers).

Unavailable or rejected images have null timestamps/calibration, not fabricated zeros. Intrinsics objects use `focalLengthX`, `focalLengthY`, `principalPointX`, `principalPointY`, `imageWidth`, `imageHeight`.

Frame-geometry MCAP log/publish times and pose timestamps equal `frame_timestamp_ns`. RGB and depth MCAP log times identify that acquiring frame; their publish times and Image headers preserve their respective native image times. RGB CameraInfo headers use native RGB time. `android_camera_timestamp_ns` is retained independently; it need not numerically equal either native RGB time or ARCore frame time. Join image messages to frame geometry by log time, then verify their native header/publish time. Do not join only by native depth time: native timestamps can repeat across acquisitions. Depth CameraInfo headers retain native time, while frame geometry carries the exact intrinsics for the acquisition event.

Session metadata contains top-level `capture_geometry_version` and detailed `capture_geometry` conventions. Native timestamps are preserved in nanoseconds, not interpreted as Unix time. ARCore explicitly leaves the Frame timestamp time base undefined; no cross-stream clock calibration is claimed. The API acquisition associates CPU RGB with this Frame; none of the three timestamp fields is substituted for another. Display rotation does not alter this saved coordinate contract.

## Validation boundary

Local JVM tests cover transform basis vectors, crop-derived calibration and ray invariance, YUV/depth packing including padding/strides, rejection of unsupported crops/dimensions and repeated or nonmonotonic timestamps within the native RGB stream, and CDR timestamp serialization. A debug APK build verifies Android integration. Device validation must still measure RGB/depth registration, native timestamps, CPU JPEG performance, thermal behavior and ARCore depth error against known targets. Open-palm and grasp recordings require independent hand-label evaluation; passing this capture contract cannot certify occluded finger positions.

`LATEST_CAMERA_IMAGE` can return the same frame repeatedly. Recording metrics count one camera frame per changed Frame timestamp, retain render-loop observations separately, and report encoder failures divided by actual encode attempts. The configured target FPS is reported without a hard-coded 30 FPS label. Native metadata counts acquired depth by frame event; cross-clock overlap, jitter and synchronization rates remain unavailable until calibrated. Normal stop/start resets writer counters, thumbnail state, cached point clouds and latency state.

Official API references:

- https://developers.google.com/ar/reference/java/com/google/ar/core/Camera
- https://developers.google.com/ar/reference/java/com/google/ar/core/Frame
- https://developers.google.com/ar/develop/java/depth/developer-guide
- https://github.com/google-ar/arcore-android-sdk/blob/v1.44.0/libraries/include/arcore_c_api.h (`ArImage_getTimestamp`: source-specific time bases)
- https://developers.google.com/ar/reference/java/com/google/ar/core/Config.UpdateMode

## Regression tests and the v1/v2 failures

The first Pixel run of v1 saved zero RGB images while reporting success. Its errors were lost because the original system log writer was never initialized. We cannot retrospectively identify its exact exception. Inspection found an invalid clock assumption: v1 required Image timestamp equality with ARCore Frame time; v2 instead compared to the Android camera timestamp, which was also an invalid equality assumption. The physical v2 recording `session_20261022_010013` rejected all 291 encode attempts. Its first observed tuple was native Image `1467836033014624`, Android camera `1467836019878654`, and ARCore Frame `1467836032984466` nanoseconds. v3 preserves all three values and relies on the same-Frame acquisition API contract. The actual Android JPEG regression now uses this exact tuple; the older tests incorrectly encoded the equality assumption and could not expose it. Geometry rejection now records observations in MCAP and emits Android logcat errors. A recording with zero written RGB images, a rejected writer queue submission, a failed stream write, or failed MCAP finalization returns a failed result while preserving its raw diagnostic files. The first writer failure remains sticky even when earlier RGB frames succeeded. Final sidecar metadata records `capture_result_valid`, `first_writer_error` and `finalization_complete`; the Flutter provider clears its saved-output/recording state. Disk-failure regressions exercise an actual MCAP writer with an injected failing output stream.

`testDebugUnitTest` includes Robolectric tests exercising encoder validation, failure diagnostics and image closure. Robolectric has no YuvImage native implementation; JPEG-success tests therefore run on a Linux Android emulator under `assembleDebugAndroidTest` followed by an explicitly serial-targeted install/instrument invocation. The maintained instrumentation test encodes asymmetric padded YUV through Android's real JPEG codec, decodes it to verify dimensions/orientation, and writes three synthetic frame events with the actual MCAP writer. It retains all three distinct observed clock values and repeated depth timestamps to test downstream association.

Never run an unscoped `connectedAndroidTest` with a personal phone connected. Example emulator-only invocation after assembling the test APK:

```bash
adb -s emulator-5580 install -r apps/mobile/build/stera_recorder/outputs/apk/androidTest/debug/stera_recorder-debug-androidTest.apk
adb -s emulator-5580 shell am instrument -w -r open.fpvlabs.stera.ar_recorder.test/androidx.test.runner.AndroidJUnitRunner
```

Synthetic fixtures are saved under the test APK's `files/geometry-fixtures/`. These validate the encoder/serialization chain, not ARCore tracking, physical depth accuracy or hardware synchronization.

For the dedicated Linux workspace, the maintained wrapper builds incrementally, runs JVM tests and the native codec/fixture/session-reset tests, then exports the producer fixture and logs:

```bash
~/projects/robotics-data-collection/scripts/test_android_capture.sh emulator-5580
```

The wrapper checks that the selected serial is an emulator and never installs the production app or starts ARCore recording. Its synthetic tests need no physical camera/depth device. The emulator must already be running. Live ARCore tracking/depth tests are separate.

Known deployment follow-up: authenticated orphan-session recovery currently adopts finalized MCAP files without checking `capture_result_valid`. Before enabling distributed uploads, reject explicitly failed captures in that recovery path. The current `NO_AUTH_MODE` local build bypasses the orphan sweeper.
