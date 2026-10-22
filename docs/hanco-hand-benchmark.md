# External hand reconstruction reference check

The hand problem is not solved by reducing an overlay's fitted pixel error.
An independent public reference check exposes a substantial absolute-position
error in the calibrated perspective experiment. Keep it experimental while
improving scale, depth evidence and the underlying model.

## Data and reproducibility

The official [HanCo dataset](https://lmbweb.informatik.uni-freiburg.de/resources/datasets/HanCo.en.html)
provides camera calibration, short sequences from eight views, and MANO-derived
hand annotations. Its `is_valid` flag means a fitted hand was manually reviewed.
These are external reference annotations, not directly measured anatomical
joint centres. Research use is permitted; commercial dataset use is prohibited.
No images or joint annotations are committed or used as product training data.

The 61,720,728-byte official tester archive has SHA-256
`ba3403b1997a06881341953de8d24d3e630169a9ef7b8bd279300bf10ef84603`.
Sequence 0110 contains only three manually validated timesteps. All eight views
give 24 images; those views and timesteps are correlated. This is a diagnostic
sample, not evidence about the general egocentric population.
Overlap with the pretrained model's training data is unknown, so this is not
a confirmed unseen-data generalization benchmark.

[benchmark_hanco_hands.py](../scripts/benchmark_hanco_hands.py) uses the
publisher's [world-to-camera and projection conventions](https://github.com/lmb-freiburg/contra-hand/blob/master/show_dataset.py).
It selects only `has_fit` and `is_valid` frames by default. All 24 reference
camera-recovery controls pass a maximum joint error below 0.01 mm when given
the reference shape and its projections. This tests solver/calibration plumbing;
it says nothing about the learned model's accuracy.

```sh
.venv-stera/bin/python scripts/benchmark_hanco_hands.py \
  captures/public-hand-benchmarks/hanco \
  --model captures/session_20261022_152005/stera_processed_geometry_v3/models/hand_landmarker.task \
  --output artifacts/hanco-validated-hand-benchmark-v2
```

The script requires a fresh output directory. Model SHA-256 is
`fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.
[Machine-readable results](validation/hanco-hand-benchmark.json) retain per-image
metrics, hashes and protocol. The reference shape/pose is never used to fit
the ordinary prediction. There is no reference-based Procrustes, rotation or
scale alignment. Root-relative error explicitly subtracts each hand's wrist;
absolute error does not. Detection misses remain in the denominator.

## Results

All 24 images produce a hand detection. Mean 2D landmark error against projected
reference joints is 8.37 px on 224×224 images. No per-joint visibility annotations
are supplied here; scores include annotated joints that may be occluded.

| Reconstruction | Mean wrist-relative joint error | Mean absolute joint error |
|---|---:|---:|
| Raw MediaPipe wrist-relative shape | 36.26 mm | Not globally positioned |
| Calibrated rigid perspective solve, learned metric scale | 33.62 mm | 86.22 mm |
| Raw shape anchored using **reference wrist depth** | 36.26 mm | 35.83 mm |
| Fitted camera rotation, **reference wrist depth** | 33.62 mm | 32.22 mm |
| Uniformly scaled perspective reconstruction using **reference wrist depth** | 28.26 mm | 27.03 mm |

The perspective solver's mean wrist-position error is 100.34 mm. A lower
projection fit residual therefore does not establish accurate position.
Providing true wrist depth substantially reduces absolute error, but even this
privileged oracle leaves centimetre-scale joint errors. **The last three rows
are diagnostic oracle controls, not deployable algorithms:** true wrist depth
comes from the external reference, not from the Pixel.

## Consequence for the Pixel pipeline

MediaPipe's [v0.10.21 hand graph](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarks_detector_graph.cc)
uses [WorldLandmarkProjectionCalculator](https://github.com/google-ai-edge/mediapipe/blob/v0.10.21/mediapipe/calculators/util/world_landmark_projection_calculator.cc).
It rotates the model's crop-relative XYZ into image axes; it does not use our
camera's intrinsics to recover a perspective camera. Translation-only depth
anchoring consequently leaves an important camera-model assumption unchecked.
Adding a proper calibrated solve is useful, but learned hand scale and shape
remain estimates.

On the two actual Pixel recordings, the perspective experiment lowers median
same-model fitted pixel residual from 97.45 to 21.79 px and from 90.03 to 16.57 px.
Held-out finger residuals remain 58.49 and 34.58 px. Median wrist disagreement
with native surface depth is 155 and 178 mm. Consecutive-frame position changes
also increase in the latest recording. Those are failure evidence, not reasons
to promote the reconstruction as training-qualified.

Keep both raw and alternative candidate estimates, distinguish fitted residuals
from external-reference errors, and retain rejection reasons. Next tests need
an accurate hand-specific scale/depth constraint and a stronger hand-object
model, evaluated on independent annotations and held-out recordings. Simply
lifting every predicted 2D joint onto a depth ray can produce a perfect overlay
while deforming bones, so it is not an accepted repair.

HaMeR and WiLoR are possible research comparisons. Their official setup requires
separately obtained MANO assets; WiLoR also declares a noncommercial model
license. These are evaluation candidates, not automatically usable commercial
dependencies: [HaMeR setup](https://github.com/geopavlakos/hamer),
[WiLoR setup and licensing](https://github.com/rolpotamias/WiLoR).
