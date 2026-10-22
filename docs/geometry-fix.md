# Pixel capture geometry: causes, corrections and validation

> **Current status: v2 passes software and native Android codec tests; Pixel validation is pending.**
> The v1 physical test, `session_20261022_001412`, saved zero RGB, depth or pose
> messages and reported 310 encoder failures. Do not use the v1 APK for
> collection. Its exact exception was lost. The v2 replacement fixes an invalid
> timestamp assumption, persists rejection diagnostics and refuses to report
> empty or failed writes as successful recordings. Its **24 JVM, 5 native
> Android, 1 Dart and 65 Python tests pass**. These results do not establish
> physical tracking or depth accuracy. See the [v2 receipt](geometry-v2-build-receipt.json).

**The original 3D hand/body annotations are not reliable training labels.** We
found coordinate-contract defects in the Android recorder and missing geometric
checks in the selected SDK hand pipeline. The v2 debug APK is installed on the
Pixel 9 Pro XL. Installation did not launch the app or start a recording; fresh
physical capture validation is pending. A correct software contract alone does
not establish accurate metric hand poses.

Investigation date: 2026-10-22, Toronto. App base commit:
`fce8de1a44d3b4a8f0bea9bb5f025ea8e04dcc15`; audited SDK commit:
`df6a5ec8919053c5cd448db83d4816e1faaaec62`. The SDK checkout remains unchanged;
local processing adapters provide the new behavior.

## What failed

**The Android camera axes were inconsistent.** The recorded optical transform
swapped optical X and Z, placing camera-forward points along the physical
camera's X axis. ARCore's physical camera pose uses +X right, +Y up and −Z
forward; optical coordinates use +X right, +Y down and +Z forward. Their
conversion is `diag(1,-1,-1)`. This is a separate issue from the earlier body
world-up sign correction. [ARCore camera contract](https://developers.google.com/ar/reference/java/com/google/ar/core/Camera).

**Saved RGB pixels did not share the recorded depth/calibration layout.** The
old recorder encoded display-transformed GPU RGB but saved unrotated CPU-image
intrinsics and native depth. It did not retain the exact display warp or texture
calibration. Eight sampled frames align substantially better after a 180-degree
depth rotation; that supports a diagnostic hypothesis, not exact calibration
recovery. CPU RGB and depth can also differ in crop/aspect ratio, so matching
them by dimensions alone is insufficient. [ARCore depth guidance](https://developers.google.com/ar/develop/java/depth/developer-guide).

**The SDK translated an unchecked predicted hand shape into camera space.**
MediaPipe supplies separate image landmarks and hand-centred metric predictions.
The SDK anchored the predicted wrist with depth, kept the remaining shape
unchanged, and displayed the separate 2D predictions as its overlay. Across
135 detected hands, the exported fingers disagreed with those 2D predictions
by **93.17 pixels at the median**. Rotating only the depth lookup reduced this
to 62.37 pixels; another axis flip or smaller sampling patch did not resolve
the remaining error. These are internal-consistency measurements, not error
against ground truth. Old calibration uncertainty, model error and occlusion
cannot be fully separated from this recording.

MediaPipe's [pinned inference graph](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarks_detector_graph.cc#L254)
decodes separate image/world outputs; its
[world projection](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/calculators/util/world_landmark_projection_calculator.cc#L73)
applies an in-plane ROI rotation without calibrated perspective fitting. The
SDK's reported confidence was the **handedness classification score**, not
finger accuracy, visibility or depth confidence.

**The body was synthesized from an invalid mount assumption.** This capture
was handheld. The body estimator assumed the camera was near the wearer's head
and used fixed torso/arm dimensions. Its IK fallback stretched the forearm to
reach implausible wrists. The new runner disables this body estimate. It cannot
infer a reliable torso from a handheld phone.

See the [original audit](hand-geometry-audit-2026-10-21.md) and
[hand reconstruction experiments](../captures/session_20261021_210417/hand_fix_experiments/ROOT_CAUSE.md)
for source locations, images and ablations.

## What changed

The Android recorder now labels new captures `android_arcore_cpu_v2` and saves
JPEGs directly from the native CPU image, with matching intrinsics and physical
camera pose. GPU display transforms affect only the preview. Image packing
handles row/pixel strides and validates image dimensions, crop and timestamp
agreement. Saved RGB may consequently appear rotated relative to the preview.

V1 incorrectly required the CPU image timestamp to equal `Frame.timestamp`.
ARCore leaves that frame time base undefined. V2 validates `Image.timestamp`
against `Frame.androidCameraTimestamp` and preserves both native image time and
frame-event time. This is a demonstrated API-contract error, but the physical
v1 exception cannot be reconstructed from its incomplete logs. Acquired image
properties, validation stage and exception are now saved in the geometry stream
and emitted to logcat. Zero saved RGB, rejected writer submission, stream-write
failure or failed MCAP finalization produces an unsuccessful stop result and
retains diagnostics. The Flutter provider clears the failed saved-output state.

Each acquisition records its RGB-to-depth mapping, intrinsics and native sensor
timestamps in `/capture/frame_geometry`. Depth retains its native pixels.
RGB and depth MCAP **log time identifies the acquiring ARCore frame event**;
their headers and publish times retain their respective native image times. This matters because native depth times
can repeat. The reader selects the exact acquisition payload, rejects unsupported
contracts and exposes timing failures. The detailed
[capture contract](../stera-app/packages/stera_recorder/android/CAPTURE_GEOMETRY.md)
documents these conventions.

The [new runner](../scripts/process_geometry_capture.py) preserves raw hand
predictions and candidate 3D coordinates separately from supported annotations.
It uses the recorded mapping, local depth samples, palm-depth agreement and
reprojection checks. Unknown visibility remains unknown; high handedness
confidence cannot make a hidden finger valid. Candidates are explicitly labeled
unverified or rejected in diagnostic visualization. No shape fitting is used
merely to improve the picture.

The HDF5 export includes per-frame calibration, native depth timestamps and
separate RGB association times. Raw camera poses have an explicit tracking
validity mask. `hand-observations` retains model evidence and candidates;
`hand-pose` masks unsupported joints. The evaluation report explains that the
SDK health score does not measure hand accuracy. Original capture and processing
outputs remain preserved.

## Validation status

| Check | v2 result | Evidence boundary |
|---|---|---|
| JVM/Robolectric | 24 passed | Geometry, packing, image validation/lifetime, producer barriers, serialization and disk/finalization failures |
| Native Android instrumentation | 5 passed on `emulator-5580` | Actual Android JPEG codec and Kotlin MCAP writer with synthetic images/depth |
| Dart provider | 1 passed | Failed stopped recording clears recording/output state and preserves its error |
| Python | 65 passed | Capture decoding, per-frame geometry, clock separation, quality masks, exports and reports |
| Android fixture → complete Python pipeline | 3 frames completed | Real producer bytes decoded and exported; no physical camera/depth or hands |
| Fresh Pixel capture | Pending | Must validate actual acquisition, RGB/depth registration, accuracy and performance |

The [v2 build/validation receipt](geometry-v2-build-receipt.json) records artifact
and source hashes, commands and logs. Its archived arm64/x86_64 APK is
`artifacts/stera-pixel9proxl-geometry-v2-debug.apk`, SHA-256
`75f5848adf7ad8e8f3157d83d61919f2d6d2c7d95b792f1cb61587c8e475fed0`.

The [synthetic producer fixture](../tests/fixtures/android_geometry_v2/README.md)
uses Android's real JPEG encoder with padded YUV planes and the actual Kotlin
MCAP writer. Python verifies 32×16 pixels, calibration and event/native timestamp
separation, and selects three distinct depth payloads despite a repeated native
depth timestamp. Its [complete pipeline receipt](../captures/synthetic_android_geometry_v2/receipt.json)
records three processed frames, unchanged raw input and generated HDF5, report
and Rerun artifacts. There are no hands in this fixture; it cannot establish
hand-label accuracy. Cross-stream synchronization remains unverified.

The native tests deliberately run outside Robolectric because Robolectric does
not implement the real `YuvImage.compressToJpeg` path. Repeat the Linux test loop
against an already running emulator with:

```sh
./scripts/test_android_capture.sh emulator-5580
```

The script checks the selected device is an emulator, incrementally builds/tests,
explicitly installs only its test APK, and exports logs and fixtures. It does not
start a production recording. Live ARCore tests and Pixel validation are separate.

Historical evidence is preserved:

- The [v1 build/install receipt](geometry-build-receipt.json) and
  [v1 validation receipt](geometry-validation-receipt.json) describe the earlier
  15 JVM/44 Python checks and installed v1 APK. The subsequent zero-RGB Pixel
  recording failed; those checks did not cover actual Android JPEG encoding.
- The old-capture replay,
  [stera_processed_geometry_diagnostic_v3](../captures/session_20261021_210417/stera_processed_geometry_diagnostic_v3/receipt.json),
  completed 252 frames and 135 detected hands; zero passed the geometry gate.
  The raw capture is unchanged, and the replay remains an explicitly unvalidated
  legacy hypothesis excluded from automatic viewer selection.

The next physical capture should include an asymmetric target and measured
distances, followed by open palm, fist and tool grip. Check image acquisition,
registration and depth error first; hidden finger positions require stronger
evidence, such as a second synchronized view. Measure CPU JPEG frame rate and
thermal behavior too. Do not treat a passing capture-health report as metric
accuracy certification.

## Run the corrected pipeline

For a **new recording from the v2 app after installation**, replace the path below
with the copied MCAP. Its `metadata.json` must remain beside it. The runner
requires a fresh output directory.

```sh
cd ~/projects/robotics-data-collection
.venv-stera/bin/python scripts/process_geometry_capture.py \
  /absolute/path/to/new/session_data.mcap
```

The old recording cannot acquire calibration metadata retroactively. To inspect
its explicitly unvalidated 180-degree hypothesis, run:

```sh
.venv-stera/bin/python scripts/process_geometry_capture.py \
  captures/session_20261021_210417/session_data_20261021_210417.mcap \
  --output captures/session_20261021_210417/stera_processed_geometry_diagnostic_recheck \
  --legacy-geometry-hypothesis --show-rejected-candidates

.venv-stera/bin/python scripts/view_capture.py \
  captures/session_20261021_210417/stera_processed_geometry_diagnostic_recheck/episode/visualization.rrd
```

This hypothesis is restricted to the audited capture's checksum and is excluded
from automatic default-viewer selection. It remains a diagnostic replay, not a
calibrated replacement dataset.

## Does this mean the published app is broken?

The demonstrated defects concern our source-built **Android** app revision and
the locally selected **MediaPipe** processing path. The
[official download currently leads to the iPhone App Store](https://apps.apple.com/in/app/stera-by-fpv-labs/id6756263398).
FPV Labs documents distinct ARKit/iOS and ARCore/Android capture paths in its
[open-source announcement](https://www.fpvlabs.ai/essays/stera-capture-app).
We have not tested the distributed iOS binary or its production processing
configuration. This evidence establishes problems in the code we ran; it does
not establish that the published iOS app has the same defects or explain the
vendor's internal release/testing decisions.
