# Hand backend and temporal inference findings

The local processing runner explicitly selects **MediaPipe**. The audited
Stera SDK's `HandTracker` default is **WiLoR**, with HaMeR also supported.
Consequently the existing MediaPipe results are not a comparison against
Stera's default hand backend, and do not establish how well WiLoR performs.
Those model choices must be explicit in every quality claim.

The local runner also inherited MediaPipe's independent-image mode. It did
not use frame-to-frame ROI tracking. The
[official MediaPipe guide](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/python)
distinguishes image and video inference; video mode reuses hand regions between
frames and requires timestamps. That is a detector/tracker configuration change,
not a new learned temporal 3D model.

## What changed

`--hand-detection-mode video` enables that native MediaPipe video API locally,
using recorded frame-event milliseconds and the same task file, hand count
and 0.3 thresholds. Each processing run starts fresh tracker state. It preserves
the original RGB/depth/calibration and raw model observations; all existing
3D acceptance checks remain active. `image` remains the default while these
tradeoffs are evaluated.

`--hand-model-asset` reuses an exact local task asset, avoiding network access
for repeated processing. The model is copied into the output, hashed in the
receipt and available for both inference and replay provenance.

```sh
.venv-stera/bin/python scripts/process_geometry_capture.py \
  captures/session_20261022_152005/session_data_20261022_152005.mcap \
  --output captures/session_20261022_152005/stera_processed_video_mode_v2 \
  --hand-detection-mode video \
  --hand-model-asset captures/session_20261022_152005/stera_processed_geometry_v3/models/hand_landmarker.task
```

Use a fresh output directory. The local output shown above already exists.

## Results and decision

| Input method | Latest, 186 frames | Earlier, 245 frames |
|---|---:|---:|
| Independent full-frame images | 68 detected frames | 100 detected frames |
| Fixed crop fallback after an image miss | 100 | 127 |
| Full-frame video mode | 135 | 167 |

These are detected-frame coverage counts, not recall or correct pose counts.
Four visually inspected hand-absent frames in the latest recording (0, 5, 180,
185) remain negative in video mode. The small negative sample cannot establish
false-positive performance. A complete annotation of visibility and correctness
is still needed. [Crop diagnostics](hand-crop-coverage.md) include two obvious
partial-hand failures despite the higher coverage.

The complete video-mode pipeline on the latest capture exports 186 frames,
135 hand observations, readable HDF5 and Rerun, with the original MCAP hash
unchanged. **Zero hands pass the existing complete 3D qualification checks.**
Of the 135, 134 fail projection consistency and one has insufficient projectable
joints. More detections did not resolve metric quality.

The external [HanCo reference check](hanco-hand-benchmark.md) was repeated by
replaying all 67 frames in order for each of eight cameras, scoring only the
three manually reviewed timesteps. The video state is reset for every camera.
All 24 reference views are detected in both modes:

| Mean reference error | Image mode | Video mode |
|---|---:|---:|
| 2D landmarks | 8.37 px | 8.08 px |
| Wrist-relative raw 3D joints | 36.26 mm | 39.03 mm |
| Wrist-relative calibrated-PnP 3D joints | 33.62 mm | 35.31 mm |

Video mode increases Pixel coverage, but this tiny reference sample shows
worse 3D shape error. It is therefore exposed as an explicit experiment rather
than promoted as a training-quality fix. HanCo labels are fitted references,
the views are correlated and training overlap is unknown; these numbers do
not measure egocentric Pixel accuracy.

```sh
.venv-stera/bin/python scripts/benchmark_hanco_video.py \
  captures/public-hand-benchmarks/hanco \
  --model captures/session_20261022_152005/stera_processed_geometry_v3/models/hand_landmarker.task \
  --output artifacts/hanco-video-check.json
```

[Video reference results](validation/hanco-video-tracking.json) and
[Pixel mode receipt](validation/hand-video-tracking.json) record the evidence.
The 92 Python regression checks include known camera truth, scale ambiguity,
depth contradictions, preservation of unknown visibility and dispatch of the
unchanged event timestamp to the video API. They validate implementation
behavior, not anatomical accuracy.

## Next model comparison

Prepare WiLoR on the local RTX 3090 in an isolated environment and evaluate
the same raw captures and external reference frames. Its protected MANO asset
must come from registered access via the official setup; model availability
does not itself grant commercial deployment rights. Do not extrapolate either
model's fitted pixel residual into a claim of verified 3D training labels.
