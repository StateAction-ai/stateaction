# Public egocentric RGB validation — 22 October 2026

The complete RGB inference and export workflow runs on a real public recording.
It also exposes a substantial limitation: the current MediaPipe configuration
often misses clearly visible gloved hands. This test validates decoding,
inference, observation preservation and visualization. It does **not** validate
metric 3D hand accuracy or the physical Pixel recording path.

## Public source and attribution

**Humaid Tech Inc., EgoViz-120 (2026)**, clip
`c59801fe4172cf9b430cd9232dda3909`, “Wiping bathroom sinks and faucets.”
The publisher licenses the dataset under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as stated on its
[official dataset card](https://huggingface.co/datasets/humaidtech/EgoViz-120).
The source is an openly accessible
[150,184,348-byte MCAP](https://huggingface.co/buckets/humaidtech/EgoViz-120/resolve/data/cleaning_restroom/c59801fe4172cf9b430cd9232dda3909/c59801fe4172cf9b430cd9232dda3909.mcap).
It was downloaded without authentication, payments, or uploads.

Source SHA-256:

```text
c86d1d69df71953b0b7fe1d61cfbc919743d1c108a2a0adc30b5c1a449e2e7d4
```

Changes made to this attributed source: extracted its clean ego-left H.264
stream, inferred landmarks, added comparison overlays, and exported observations.
The original MCAP remains unchanged. Downloads and generated artifacts live under
`captures/public-egocentric/` and are excluded from Git.

The source card describes a head-mounted stereo rig and wrist cameras, with
calibration, depth, odometry and IMU channels. Its hand/action labels are
model-generated and not human-verified; **we did not use those labels as ground
truth or inference input**. The publisher's MP4 dashboard already has overlays,
so we extracted the clean `/ego/zed_head/left/image/compressed` channel instead.
[Publisher stream and label documentation](https://huggingface.co/datasets/humaidtech/EgoViz-120).

Stera-10M was also checked. Its official page currently requires controlled
access and separate license review; we did not substitute a preview for an
authorized raw recording. [Official Stera dataset page](https://huggingface.co/datasets/fpvlabs/stera-10m).

## What ran

The runner uses the same installed Stera `HandTracker(model="mediapipe")`,
model asset, configuration and `detect_observations` adapter as our processing
pipeline. It uses IMAGE mode and the CPU XNNPACK inference delegate. The model
accepts up to two hands; detection, presence and tracking thresholds are each
0.3. No thresholds were tuned on this clip.

For this diagnostic, `deduplicate_by_side=False` preserves every detection.
Production's default selection remains unchanged: keep the highest handedness
score per predicted side. Both counts are reported, so selection losses cannot
be mistaken for detector failures. Export slots represent individual per-frame
observations, with the model's predicted side stored separately. They are not
anatomical identities or temporal tracks.

Actual decoded input: **449 frames, 1920 × 1200**, with 14.966609 seconds between
the first and last native RGB timestamps. The publisher lists this as a 15-second
clip. We preserve native packet, MCAP log and publish timestamps as int64 values;
the generated MP4 uses nominal presentation FPS. We checked packet/frame counts
and the absence of H.264 B-frame reordering before associating decoded frames.
Source camera-info records are retained in `source_streams.json`; they are not
used to invent a calibrated hand reconstruction.

## Results and visual evidence

Final artifact directory: `captures/public-egocentric/validation_v3/`.

| Check | Observed result |
| --- | --- |
| Frames processed and exported | 449 / 449 |
| Frames with any hand prediction | 71 / 449, or 15.8% |
| Frames with two hand predictions | 0 |
| Raw hand observations | 71 |
| Observations after production side selection | 71 |
| Predicted side labels | 41 left, 30 right |
| Predicted joints outside the image | 0 |
| Accepted metric hand poses | 0; unsupported validity masks remain false |
| Exported comparison video decoded again | 449 frames |
| Rerun ingestion | `--test-receive` exits 0 |
| Original source hash after processing | Unchanged |
| Inference, export and automatic validation time | 31.008 seconds |

**15.8% is prediction coverage, not accuracy or recall.** We have no independently
annotated per-frame hand-presence or joint ground truth. A joint lying inside the
image is also not evidence that it is correctly located.

The contact sheet compares the source RGB with our overlay at frames 0, 89, 179,
268, 358 and 448. Visual inspection shows missed hands at frames 0 and 89, a
detected hand alongside an undetected moving hand at frame 179, and further
misses during tool/contact activity. The source contains blue gloves, motion and
occlusions. These are possible contributors, not isolated causal findings from
an ablation. Handedness labels and mirroring conventions remain unverified;
the runner never silently swaps labels.
The separate [MediaPipe handedness audit](mediapipe-handedness-audit.md) checks
the installed Tasks API with upstream reference images; it does not certify
every prediction or the source recording's mirror convention.

Open `comparison.mp4` for the full side-by-side sequence or
`contact_sheet.jpg` for the six sampled moments. `visualization.rrd` provides
source and prediction views on the same RGB timeline. `observations.jsonl` and
`observations.hdf5` retain image landmarks and the model's uncalibrated 3D shape
predictions. Their accepted metric masks stay false. MediaPipe documents image
landmarks, predicted world landmarks and handedness as separate outputs;
handedness is not a per-joint accuracy estimate.
[MediaPipe output documentation](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/python#handle_and_display_results).

The report's `summary.json` includes source/model/script hashes, UTC run times,
library versions, configuration, output hashes and validation results. Tested
versions: Stera SDK 0.0.4, MediaPipe 0.10.21, OpenCV 4.11.0.86, Rerun 0.22.1.

## Reproduce and inspect

From `~/projects/robotics-data-collection`, use a fresh output directory:

```sh
.venv-stera/bin/python scripts/test_public_egocentric_video.py \
  --download-default \
  --output captures/public-egocentric/my_validation

python3 scripts/view_capture.py captures/public-egocentric/my_validation/visualization.rrd
```

The first run downloads the reviewed 150 MB MCAP, subject to a 160 MB hard
download bound and SHA-256 check. Later runs reuse it. A local ordinary video is
also supported with `--input path/to/video.mp4`; that path uses presentation
timing and does not gain native sensor calibration. The workflow automatically
reopens the HDF5/video, tests Rerun ingestion, and checks that the source is
unchanged before reporting completion.

The targeted regression tests cover raw versus default side deduplication and
two detections with the same predicted side surviving HDF5 export separately:

```sh
.venv-stera/bin/python -m unittest discover -s tests -p test_hand_geometry.py -v
.venv-stera/bin/python -m unittest discover -s tests -p test_public_video_export.py -v
```

The next useful experiment is to label a small fixed set of frames for visible
hand presence, handedness and observable 2D joints, then compare models and
recording conditions against those labels. This public RGB test already gives
us a reproducible failure case; it cannot replace a new physical Pixel capture
or an independently validated metric-geometry experiment.
