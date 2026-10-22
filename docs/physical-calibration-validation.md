# Measuring Pixel depth and camera motion

The installed v3 app still needs a new physical capture. No available recording
proves that its real RGB/depth/pose acquisition has recovered. First make the
short textured-tabletop recording already requested. Check that it finalizes,
has decodable RGB and matching acquisition records, and contains actual depth
and tracked poses before running this accuracy protocol.

## Printed reference

Use [target-a4.pdf](targets/charuco-a4/target-a4.pdf). It is one A4 page with a
140 × 200 mm ChArUco board, seven by ten 20 mm squares, 14 mm markers, and a
50 mm scale line. Print at **100% / Actual size**. Measure the line and the
board's full width/height; divide width by seven and height by ten to obtain
square sizes. If horizontal and vertical scale disagree, fix the printing
settings before using one scalar reference size. Attach the print to a flat,
rigid surface without wrinkles or reflections.

The reference uses identified corners from
[OpenCV's ChArUco detector](https://docs.opencv.org/4.x/df/d4a/tutorial_charuco_detection.html).
[PnP estimates board-to-camera pose](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html)
using known board dimensions, detected image corners and the recorded RGB K.
Depth is not used to fit or select that pose. Both planar IPPE candidates are
checked; ambiguous solutions are excluded instead of selecting one using the
depth being evaluated. These are image-derived references, with uncertainty
from print dimensions/flatness, corner localization and the supplied intrinsics.

## Capture after acquisition is confirmed

1. Keep the board fixed. Warm up tracking with surrounding textured surfaces
   visible. Use steady light and avoid motion blur.
2. Keep the whole board visible and large enough for its marker IDs to decode.
   Record stationary intervals near roughly 0.4, 0.6 and 0.8 m, adjusting if the
   markers become too small. A ruler measurement to the phone's camera plane
   is useful additional evidence, with its own measurement uncertainty.
3. Move the phone slowly left/right, up/down and toward/away from the board,
   then vary its angle. Include all translation directions: a coordinate error
   can remain invisible when moving only along an unchanged axis. Keep the
   board still throughout.
4. Stop, let saving finish, and copy the completed session. Preserve its raw
   MCAP and adjacent metadata.

An oblique view helps resolve planar ambiguity. A tilted depth surface also
makes image/depth orientation defects easier to expose than a constant-distance
frontal plane. Do not move the board to create the angle during a camera-motion
test; move the camera around the stationary board.

## Run the read-only auditor

Replace the MCAP path and square measurement. Use a fresh output directory:

```sh
cd ~/projects/robotics-data-collection
.venv-stera/bin/python scripts/validate_calibration_target.py audit \
  /absolute/path/to/session/session_data.mcap \
  --output captures/physical_target_test \
  --measured-square-mm 20.0 --static-board --stride 5
```

Without a measured square size, the tool uses nominal 20 mm and explicitly
marks print scale unverified. Without `--static-board`, it does not compute
camera-motion agreement. It rejects failed/unversioned captures and leaves the
raw file unchanged. It produces `audit.json` and up to six images showing the
detected reference corners.

| Evidence | Meaning and limit |
|---|---|
| Per-frame board corner count and candidate reprojection errors | Evidence for the image reference; ambiguity and missing corners remain explicit. |
| Signed and absolute depth residuals in millimetres | Native positive depth samples versus the image-derived board plane inside an eroded corner hull. Missing depth is counted; large residuals are retained. |
| Relative camera translation/rotation disagreement | Recorded ARCore motion versus motion inferred from a stationary board, after the explicit optical-to-physical camera conversion. Arbitrary world origin cancels. |
| Board position drift in ARCore world coordinates | Additional consistency evidence if the board truly stayed fixed. |
| Raw timestamps, source hash and reference filters | Reproducible acquisition association. They do not prove cross-stream synchronization. |

The summary reports distributions, not a universal accuracy pass. Its 12-corner,
1.5 px reprojection and 0.25 px solution-margin filters are initial engineering
filters for obtaining a usable reference, not requirements published by a buyer.
Camera K is shared with the reference, and ARCore does not expose the distortion
coefficients needed to prove intrinsic accuracy. Print/target uncertainty must
also be considered before interpreting a small residual.

Same-Frame acquisition does not itself certify temporal alignment:
[ARCore explicitly allows returning an earlier depth image](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame#acquireDepthImage16Bits())
when current depth is unavailable. The auditor preserves native depth times,
but neither it nor the hand exporter upgrades those times to measured RGB/depth
synchronization. Motion tests and independent timing evidence are still needed.

## What remains after this test

A board test does not measure hidden fingers or validate model-generated hand
shapes. Hand annotations still need independent visible-joint review, metric
reference measurements for the intended motion targets, temporal tests, and a
named training/evaluation recipe. See
[training qualification requirements](training-qualification-requirements.md).
Both `metric_accuracy_validated` and `frontier_lab_training_qualified` stay false
until the relevant independent measurements and training-utility evidence exist.

The tool's synthetic tests exercise detection, known metric scale, unit errors,
depth rotation, mapping shifts, camera pose direction/axes, planar ambiguity,
and a real MCAP decoding path. Those tests validate the auditor's behavior;
they do not substitute for the physical Pixel experiment.
