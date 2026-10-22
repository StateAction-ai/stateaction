# Full WiLoR hand comparison and replay

Direct official-model WiLoR inference now works on the local RTX3090. It gives
substantially better agreement with the same bounded public reference used for
our MediaPipe baseline. Existing default processing and the native recorder
remain unchanged; this is an explicit standalone research path.

| Same 24 HanCo reference views | MediaPipe IMAGE | WiLoR full model |
|---|---:|---:|
| Images with detections | 24/24 | 24/24 |
| Mean image landmark error | 8.37 px | 2.71 px |
| Raw wrist-relative joint error | 36.26 mm | 11.57 mm |
| Measured-K PnP wrist-relative error | 33.62 mm | 5.47 mm |
| Measured-K PnP absolute joint error | 86.22 mm | 19.82 mm |

These are three correlated **right-hand** timesteps viewed by eight cameras,
from one HanCo sequence. The references are MANO fits, not independently measured
anatomical joints; WiLoR also predicts MANO joints. Shared representation and
unknown training overlap may favor agreement. This establishes improvement on
this reference sample, not population accuracy, left-hand accuracy or Pixel
metric accuracy. No reference rotation, Procrustes alignment or scale fitting
is used. Reference labels only assign a detection by box overlap and score it.

WiLoR's full model documents its canonical 21-joint mapping in
[`mano_wrapper.py`](https://github.com/rolpotamias/WiLoR/blob/fcb911312a38fa8badd30d9656a167485d61b8f9/wilor/models/mano_wrapper.py).
The separate detector's 21-keypoint order remains undocumented; its
[conditional 2D benchmark](wilor-detector-2d.md) must not be confused with the
full model's 2.71 px result.

The full model projects its own 3D joints using an assumed crop camera. Measured-K
PnP uses those predicted pixels and the learned shape, without reference
coordinates entering the fit. Its fitted reprojection is internal consistency;
its independently scored reference joint error is a distinct measurement. The
nominal demo camera produces **5.72 m** mean absolute error on these cropped
reference images: an assumed focal length is not a calibrated depth estimate.
The official crop-to-full camera conversion is approximate. Its projection can
differ from affinely mapped crop pixels for nonzero joint Z/off-center crops;
an earlier invalid exact-equality guard was removed after independent audit.
Exact affine roundtrip, official-helper/algebra and known-camera controls pass.

Full-model results and source/runtime hashes are in
[validation/wilor-full-hand-benchmark.json](validation/wilor-full-hand-benchmark.json).
The initial [full forward-pass receipt](validation/wilor-full-hand-preflight.json)
has zero missing/unexpected checkpoint keys. Source/model checkouts, model
outputs, images and reference labels stay in ignored local directories.

## Actual Pixel recordings

| Recording | Frames | Detected frames | Full 3D observations |
|---|---:|---:|---:|
| Latest `152005` | 186 | 163 | 166 |
| Earlier `151917` | 245 | 174 | 179 |

All 345 Pixel observations are finite. Detection counts are coverage, not recall.
The extra observations include forearm false positives and duplicate left/right
predictions; none are silently discarded. Joint visibility stays unknown.
All training-valid masks stay false.

The dedicated replay verifies prediction hashes, exact JPEG/decoded-MCAP pixel
identity for every frame, the pinned SDK, camera geometry and unchanged raw
MCAP hashes. It uses the existing conservative depth/visibility audit and only
in-image joints for its camera fit; the scalar benchmark uses all 21 predicted
joints. Out-of-image guesses can therefore change the replay fit. Duplicates
remain separate observation entries in HDF5 and separate Rerun paths.

Both complete replays have zero internally consistent hands: RGB/depth exposure
timing remains unverified, 162/166 latest and 168/179 earlier observations have
learned-scale/surface-depth disagreement, and hidden-joint visibility is unknown.
Depth represents skin, objects or background surfaces rather than joint centres.
These contradictions require independent calibration/reference evidence; a
better projected skeleton does not resolve them.

Latest replay, with only the two RGB display panels rotated 180° for readability:

```sh
cd ~/projects/robotics-data-collection
.venv-stera/bin/rerun captures/session_20261022_152005/stera_processed_wilor_research_v2/episode/visualization.rrd
```

Native camera/depth geometry and all saved observation coordinates are preserved.
Move the `frame` timeline to 40–160 to inspect reaching and bottle grasping.
The earlier recording is under
`captures/session_20261022_151917/stera_processed_wilor_research_v1/`.
The readable nine-frame contact sheet is local:
`artifacts/wilor-full-hand-benchmark-v2/pixel_contact.jpg`.

## Reproduce

Use the isolated [WiLoR environment and explicit MANO provenance](wilor-research-preflight.md).
The SDK package is not installed in that environment because of its separate
NumPy dependency contract. The direct-model benchmark uses native OpenCV BGR,
official crop preprocessing, left-hand X restoration, rescale factor 2.0,
detector confidence 0.3 and CUDA autocast. This is not a test of every behavior
of the SDK wrapper, whose detector threshold and other details differ.

```sh
.venv-wilor/bin/python scripts/benchmark_wilor_hands.py \
  --mano-asset artifacts/research-models/wilor-mini-research-assets/MANO_RIGHT.pkl \
  --mano-source-receipt docs/validation/mano-research-asset-source.json \
  --artifacts artifacts/wilor-full-hand-benchmark-repeat \
  --report docs/validation/wilor-full-hand-benchmark-repeat.json

.venv-stera/bin/python scripts/replay_wilor_predictions.py \
  captures/session_20261022_152005/session_data_20261022_152005.mcap \
  --predictions artifacts/wilor-full-hand-benchmark-repeat/predictions.json \
  --benchmark-report docs/validation/wilor-full-hand-benchmark-repeat.json \
  --output captures/session_20261022_152005/stera_processed_wilor_research_repeat \
  --display-rotate180
```

WiLoR/HanCo/MANO use here is a research comparison. The author-linked MANO asset
is explicitly third-party packager provenance, not proof of MPI registration or
commercial/redistribution rights. No paid compute, sensor capture, app install
or default-backend change was required for this comparison.
