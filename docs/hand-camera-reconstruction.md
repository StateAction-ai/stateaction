# Hand camera reconstruction investigation

The current MediaPipe estimates remain unsuitable as verified 3D training
labels. This pass implements an explicit, experimental calibrated camera
candidate and identifies the remaining model, depth, and temporal failures.
It does not establish hand-pose accuracy.

## Confirmed mechanism

The previous reconstruction added a depth-derived wrist translation directly
to MediaPipe's predicted world shape. This assumed the crop-model XYZ already
formed a metric perspective reconstruction for the Pixel's actual intrinsics.
That assumption was never established and is contradicted by both recordings.

In MediaPipe 0.10.21, the hand graph uses
[WorldLandmarkProjectionCalculator](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/calculators/util/world_landmark_projection_calculator.cc),
which rotates crop X/Y, preserves Z, and does not use the recording's camera K
or estimate its perspective translation. The
[hand landmark graph](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/modules/hand_landmark/hand_landmark_cpu.pbtxt)
connects this calculator to the world-landmark output. World XYZ and image
landmarks are learned predictions, not a guaranteed calibrated reconstruction.

`fit_perspective_camera` now explicitly estimates a rigid calibrated camera
with SQPnP followed by iterative refinement. It preserves all model bone
lengths and rejects degenerate/invalid solves and points behind the camera.
It does not obtain a measured hand scale: the metric scale comes from the
learned model. `reconstruct_perspective_hand` separately checks the native
surface depth and keeps the historical candidate for comparison.

## Results on the two existing raw recordings

The latest recording is the development capture. The earlier recording was
held out from the initial diagnosis. No new physical recording was required.
All scores below use native input orientation and unchanged raw MCAP files.

| Diagnostic | Latest: 186 frames | Held out: 245 frames |
|---|---:|---:|
| Frames with a detected hand | 68 | 100 |
| Historical translation-only median projection mismatch | 97.45 px | 90.03 px |
| Calibrated camera median **fitted** projection mismatch | 21.79 px | 16.57 px |
| Palm-fit mismatch on other predicted finger joints | 58.49 px | 34.58 px |
| Median depth-anchored wrist Z | 0.549 m | 0.652 m |
| Median fitted wrist Z | 0.344 m | 0.428 m |
| Median absolute fitted wrist/native surface-depth disagreement | 0.155 m | 0.178 m |
| Median adjacent-frame fitted wrist step | 0.0238 m | 0.0189 m |
| Median adjacent-frame historical wrist step | 0.0123 m | 0.0175 m |
| P90 adjacent-frame fitted wrist step | 0.0780 m | 0.0546 m |
| P90 adjacent-frame historical wrist step | 0.0428 m | 0.0372 m |

Projection values aggregate the median residual of each detected observation.
They measure agreement between predictions of the **same** model; the lower
fitted error is not independent evidence of anatomical accuracy. The palm-only
fit holds out 16 other predicted joints but still shares the same model.
Wrist steps measure stability, not error, because actual motion is unknown.
Only immediately adjacent detected frame indices are compared; missed spans
are excluded. The fitted candidate is more temporally unstable in these data.

The native surface-depth disagreement is independent of the fitted image
residual, but it does not identify which source is correct: moving hands may
not have reliable surface depth, and learned hand scale may be wrong. The
camera-correction rotation also changes substantially between some adjacent
frames (maximum 44 degrees / 72 degrees); this is not a measurement of true
hand rotation. The full diagnostics are in
[validation/hand-camera-recovery.json](validation/hand-camera-recovery.json).

### Alternative hypotheses tested

Rotating detector input upright by 180 degrees produced 71 versus 68 detections
in the latest capture, and 96 versus 100 in the held-out capture. It did not
reduce the main projection contradiction. A blanket input rotation is not
supported as the hand reconstruction fix.

A separate ray-lift counterfactual assigned every image joint its exact camera
ray while keeping predicted relative Z and the sensor-depth wrist anchor.
Its fitted image residual is zero by construction. However, its bone lengths
became a median 1.28 / 1.42 times the model lengths, P90 1.88 / 1.97 times, with
individual ratios up to 6.38 / 5.21. It was not selected. Fitting the image
alone does not establish physically consistent metric geometry.

## Implementation and inspection

The pipeline accepts `--hand-reconstruction calibrated-pnp` or
`--hand-reconstruction translation-depth`. The historical mode remains the
default because the independent reference test below did not support replacing
it with unconstrained PnP. The fitted mode is an explicit experiment.
Rerun shows an orange candidate marked `ESTIMATE: NOT TRAINING-QUALIFIED`.
`--hide-hand-estimates` hides these candidates. Neither display setting
changes accepted training masks.

HDF5 preserves raw model shape and image predictions, the historical
depth-anchored candidate, the fitted candidate, the fitted camera R/t, and
separate supported training arrays. Unknown visibility stays unknown; no
handedness score is promoted to pose confidence. No numeric policy threshold
was relaxed to make these results pass.

```sh
.venv-stera/bin/python scripts/process_geometry_capture.py \
  captures/session_20261022_152005/session_data_20261022_152005.mcap \
  --output captures/session_20261022_152005/stera_processed_perspective_v1 \
  --hand-reconstruction calibrated-pnp

.venv-stera/bin/python scripts/benchmark_hand_reconstruction.py \
  captures/session_20261022_152005/session_data_20261022_152005.mcap \
  --output artifacts/hand-ablation-latest.json

.venv-stera/bin/python scripts/benchmark_hand_reconstruction.py \
  captures/session_20261022_151917/session_data_20261022_151917.mcap \
  --output artifacts/hand-ablation-heldout.json

.venv-stera/bin/python scripts/summarize_hand_ablation.py \
  artifacts/hand-ablation-latest.json artifacts/hand-ablation-heldout.json \
  --output docs/validation/hand-camera-recovery.json
```

The comparison image is available locally at
`artifacts/hand-camera-recovery-comparison.jpg`. Yellow is the 2D model
prediction; orange is projected 3D. Neither is verified ground truth.

## Independent HanCo reference and oracle-depth hybrids

The separate HanCo benchmark uses 24 correlated camera views of three manually
validated timesteps, with publisher MANO-derived reference fits and calibrated
K/M. These are fitted reference annotations, not direct anatomical joint
measurements, and this is not an egocentric Pixel benchmark. The research-only
dataset is not redistributed or proposed as commercial training material.

The following hybrid experiment uses the exact image list from
`artifacts/hanco-validated-hand-benchmark/report.json`. Every `oracle depth`
method is deliberately privileged with the reference wrist Z. This privilege
is unavailable for the Pixel recordings and must not be silently replaced by
unverified moving-hand ARCore depth.

| Method | Mean absolute MPJPE | Mean wrist-relative MPJPE |
|---|---:|---:|
| Raw model shape + oracle wrist-depth translation | 35.83 mm | 36.26 mm |
| Calibrated rigid PnP | 86.22 mm | 33.62 mm |
| PnP rotation + oracle wrist-depth translation | 32.22 mm | 33.62 mm |
| PnP XYZ uniformly scaled to oracle wrist Z | 27.03 mm | 28.26 mm |

The scaled candidate keeps its fitted projection unchanged but receives a
median scale factor of 0.880 from the privileged independent depth reference.
These results support an orientation/scale problem and the value of reliable
metric depth. They do not establish that Pixel's current surface depth is
reliable or that any of these candidates meets a buyer's training requirement.
Unconstrained PnP has lower fitted image residual while being much worse in
absolute 3D, which is why it remains experimental.

The canonical reproducible benchmark is
`scripts/benchmark_hanco_hands.py`; its protocol and committed aggregate
results are documented in [hanco-hand-benchmark.md](hanco-hand-benchmark.md).
No dataset images, annotations, or local model-output caches are committed.

## Verification and outstanding work

Synthetic independent camera truth tests cover known local-to-camera rotation
and translation, preservation of bone lengths, proper rotations, positive
camera depth, invalid geometry, bad joint correspondence, wrong focal length,
and learned-scale ambiguity. A model scaled by two can fit the same image
perfectly while giving twice the metric camera coordinates; the independent
depth audit rejects it. Unknown visibility and missing depth never become
verified training labels. These tests validate implementation behavior, not
real-hand anatomical accuracy.

The complete pipeline ran on both raw recordings and produced readable
HDF5, video, reports and Rerun output with 68 / 100 fitted candidates. No hands
passed the existing full qualification checks. Important unresolved issues
are low detection coverage, imperfect articulated shape/2D correspondence,
metric scale, native hand-surface depth, pose ambiguity, temporal instability,
and unknown occlusion. Independent annotated hand evaluation is the next
required step; the overall hand-estimation issue remains active.

No additional weights or paid compute were used. The existing MediaPipe task
model SHA-256 is
`fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.
Exact raw capture hashes and diagnostics accompany the JSON report.
