# Official WiLoR detector: bounded 2D evaluation

The official detector independently produces 21 image keypoints without MANO.
It provides substantially more detections than our MediaPipe baseline, but
duplicate/phantom hands and high-confidence occluded-joint estimates remain.
This result does not establish 3D accuracy or training qualification.

| Diagnostic | Latest Pixel | Earlier Pixel |
|---|---:|---:|
| Frames | 186 | 245 |
| Detected frames | 163 (87.6%) | 174 (71.0%) |
| Detection observations | 166 | 179 |
| Prior MediaPipe IMAGE detected frames | 68 | 100 |

These are detected-frame coverage counts, **not recall**: hand presence and
occlusion are not exhaustively annotated. Latest known-negative frames 0, 5,
180 and 185 each produce zero detections. Those four checks do not establish
general false-positive performance.

On the exact same 24 HanCo validated views used earlier (three correlated
timesteps, eight cameras), all 24 images have detections. Assuming identity
joint order, mean image error is **4.89 px**, median per-image mean 4.11 px,
versus MediaPipe's 8.37 px mean. The order-independent symmetric nearest-point
distance is 3.72 px. Ground truth only matches/scores predictions; no joint
permutation, pose, scale, or image transformation is fitted.

**Joint semantics remain unverified.** The checkpoint identifies a Pose head,
`kpt_shape=[21,3]`, and a training file `config_hand_side_interhand.yaml` that is
absent from the official source. It supplies no named joint mapping. The
[official InterHand source](https://github.com/facebookresearch/InterHand2.6M/blob/main/data/InterHand2.6M/dataset.py)
uses wrist index 20, illustrating why a filename cannot establish equivalence
with MediaPipe/HanCo ordering. Numbered overlays look consistent with wrist 0
and thumb 1–4, but this visual plausibility is not definitive documentation.
The indexwise comparison above is therefore explicitly conditional.

Ultralytics 8.1.34 zeroes keypoint XY where confidence <0.5 when constructing
its display object. The benchmark copies original-image coordinates before
that mask, keeping **all 21 predictions** for scoring. A separate fixed 0.5
confidence summary is reported without selecting a threshold on these data.
All 504 HanCo joint scores exceed 0.9; a joint scored >=0.99 still differs from
the fitted reference by 78.57 px. Confidence is not independently established
visibility or anatomical accuracy.

Targeted visual review found concrete limitations:

- Frames 50/60/80/100/120/140 all contain grasp detections. Finger chains span
  bottle-occluded regions, whose anatomical locations cannot be checked from
  the image. All their joint scores are at least 0.976.
- Latest frames 9 and 10 each contain an extra predicted hand on the forearm.
- Frame 110 predicts the same hand as left and right, with box IoU 0.963.

These selected examples are not an unbiased precision estimate. The reviewed
contact sheets are local at `artifacts/wilor-detector-2d/latest_grasp_contact.jpg`
and `latest_multiple_contact.jpg`. Their presentation is rotated 180° for reading;
inference always uses the unchanged native BGR raster.

Reproduce the numeric benchmark:

```sh
.venv-wilor/bin/python scripts/benchmark_wilor_detector.py \
  --artifacts artifacts/wilor-detector-2d-repeat
```

The committed [scalar report](validation/wilor-detector-2d.json) contains source,
model, runtime, input/prediction hashes, per-image scalar errors and the
separately recorded qualitative review. Complete model keypoints/confidences
remain in ignored `artifacts/wilor-detector-2d/predictions.json`; no personal
images or reference joint payloads are committed. Settings are fixed bbox
confidence 0.3, image size 640, CUDA half precision, no crops/rotation/tracking.
WiLoR weights remain research-only. No MANO was loaded or replaced in this test.
