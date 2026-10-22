# Fixed crop fallback for missed hand detections

The bottle-grasp recording has an input-scale problem in addition to its 3D
geometry failures. A full-frame MediaPipe call misses visible hands that the
same model detects in a closer crop. This is a useful coverage experiment;
it does not validate finger locations or metric pose.

## Reproducible experiment

[benchmark_hand_detection_crops.py](../scripts/benchmark_hand_detection_crops.py)
first runs the unchanged full image. Only when it returns no hands, it tries
three overlapping half-width, full-height windows: left, centre and right.
It maps predictions back into unchanged native RGB pixels by recording crop
offsets and optional input rotation. Raw model output and source hashes stay
in the local diagnostic JSON. No capture settings, training acceptance masks,
or production detector defaults change.

```sh
.venv-stera/bin/python scripts/benchmark_hand_detection_crops.py \
  captures/session_20261022_152005/session_data_20261022_152005.mcap \
  --model captures/session_20261022_152005/stera_processed_geometry_v3/models/hand_landmarker.task \
  --output artifacts/hand-crop-full-latest.json
```

On all 186 frames of the latest capture, full-frame detections cover 68 frames.
Fixed crop fallback raises coverage to 100 frames, with 540 total model calls.
This local run takes 13.3 seconds; it is not a controlled latency benchmark.
The [aggregate receipt](validation/hand-crop-coverage.json) contains exact
recovered indices, source/model hashes and limitations.

With the same model, crops and thresholds on the earlier 245-frame recording,
coverage rises from 100 to 127 frames. This second run makes 680 model calls
and takes 19.8 seconds. Its recovered poses have not received the same visual
review as the latest capture, so this is a held-out coverage check only.

## Visual audit and limitations

A contact sheet of all 32 recovered frames was inspected. A hand is present
in every recovered frame, mostly grasping the bottle. However, frames 111 and
112 show a tiny partial-hand prediction near the thumb rather than a credible
full-hand skeleton. The additional detections therefore cannot be treated as
32 correct poses. Many finger joints are occluded by the bottle and remain
unverified even when the overlay appears plausible.

Four inspected hand-absent frames (0, 5, 180, 185) produce no detections with
either method. This small negative sample does not establish a false-positive
rate. We have not annotated all 186 frames for hand presence or landmark
visibility, so 68/186 and 100/186 are **coverage**, not recall or pose accuracy.
Multiple crop observations can describe the same hand; the script counts
image frames, not unique hands.

The local contact sheet is
`artifacts/hand-crop-recovered-contact-sheet.jpg`. Personal images stay outside
Git. This motivates a better hand-object detector and an independent visibility
audit, while the [external hand reference check](hanco-hand-benchmark.md)
continues to govern 3D claims. Crop fallback is not a repair for metric scale,
incorrect articulated shape, or missing depth evidence.
