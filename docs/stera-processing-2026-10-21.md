# Stera Process and Evaluate — second Pixel capture

The [documented processing pipeline](https://www.fpvlabs.ai/stera/docs/process) and [evaluation workflow](https://www.fpvlabs.ai/stera/docs/evaluate) completed locally on `session_20261021_210417`. This was the existing Pixel 9 Pro XL recording, with no ultrawide experiment or new recording. Processing took about 32.5 seconds after dependency/model setup.

## Open the results

| Artifact | Contents |
| --- | --- |
| [Interactive evaluation](../captures/session_20261021_210417/stera_processed/evaluation.html) | SDK offline HTML report with Plotly charts and our clock-label correction; read the limitations below |
| [Episode directory](../captures/session_20261021_210417/stera_processed/episode/) | `rgb.mp4`, `annotation.hdf5`, calibration arrays/metadata and `visualization.rrd` |
| [Hand coverage](../captures/session_20261021_210417/stera_processed/hand_coverage.csv) | Detection counts and handedness classifications for every RGB frame |
| [Skeleton estimates](../captures/session_20261021_210417/stera_processed/skeleton_estimates.npz) | Estimated joints, visibility flags, joint names and source-frame indices |
| [Evaluation metrics](../captures/session_20261021_210417/stera_processed/evaluation_metrics.json) | Machine-readable official metrics |
| [Execution receipt](../captures/session_20261021_210417/stera_processed/receipt.json) | Inputs, versions, model URL/hash, settings, runtime adapters and validation |
| [Independent capture QA](../captures/session_20261021_210417/inspection/QA.md) | All-message checks, including defects absent from the official score |

To open the replay from a Linux desktop:

```bash
cd ~/projects/robotics-data-collection
python3 scripts/view_capture.py
```

## Measured results

| Measurement | Result | Meaning |
| --- | --- | --- |
| RGB frames processed/exported | 252/252, 1920×1080 | Full recording processed |
| Recording span | 17.015 seconds across recorded streams | RGB timestamps span approximately 16.833 seconds |
| At least one hand detected | 135/252 frames, 53.57% | Detector coverage, not an annotation of hand visibility or detection accuracy |
| Handedness classifications | 4 left, 131 right | Predictions may contain errors; these counts do not establish two distinct hands |
| Both hands detected | 0/252 frames | Both hands are not required to run the pipeline |
| Depth-anchored hand outputs | 135 | Produces estimated 3D positions; does not validate their accuracy |
| Skeleton outputs | 243 | Nine warmup frames omitted; default body model and camera assumptions apply |
| Depth/pose exports | 252 each | Matched to RGB frames |
| IMU samples exported | 13,404 | Includes repeated timestamps and held values described in independent QA |
| SDK health | 97/100 | 100 minus 1 RGB-gap point and 2 points for missing its default two-hand target |

The health score's hand target is generic. A one-handed activity should not be rejected simply because both hands were not detected. Equally, 53.6% detector coverage does not prove hands were outside the image for the remaining frames: blur, occlusion, truncation and detector failures can also cause missed detections. Human review is needed to separate those causes.

## Why 97/100 is not a training-quality verdict

The official score establishes a limited set of stream-presence, timing and detection checks. It does not establish metric geometry, camera calibration accuracy or downstream policy improvement.

- **The bad cloud is largely invisible to the SDK report.** Its default selection uses the first sparse-cloud message: 24 finite points. Independent QA examined all 252 messages and found 15,023 of 18,821 point records with nonfinite coordinates/confidence. The generated replay therefore does not demonstrate that the full sparse-cloud stream is healthy.
- **Depth is Android ARCore depth, not iPhone LiDAR.** All 252 depth images in this take are distinct and positive. Positive pixels and matched frames are not measurements of physical depth accuracy. The previous take's frozen depth did not recur, but its cause remains unresolved.
- **Reported perfect RGB/depth timing uses shared headers.** The Android app discarded the native depth acquisition timestamp and assigned the RGB timestamp. Zero header offset cannot prove simultaneous physical acquisition.
- **Hand and skeleton geometry are inferred.** MediaPipe detections are depth-anchored; the upper-body estimator uses assumed body dimensions and a camera near the head. This capture was handheld, before obtaining a head mount. Treat its body estimates as a pipeline demonstration, not subject-specific motion capture.
- **Some displayed metrics require interpretation.** The upstream report showed January 1970 because the SDK treated device uptime as Unix time. Our corrected report marks calendar timestamps unavailable and shows native uptime explicitly; the original HTML and metrics remain in `evaluation.upstream.html` and `evaluation_metrics.upstream.json`. The session filename contains a local-clock hint but no timezone or measured offset to sensor time. All numeric sensor metrics are unchanged. The approximately 7,481° cumulative rotation value sums changes in the direction of position increments, not camera attitude rotation; tiny position jitter can inflate it. Wrist-speed metrics also assume uniform intervals despite gaps between detections.
- **The exported video uses a constant frame rate.** It contains all 252 frames over approximately 17.015 seconds. Native frame timestamps remain the timing reference; playback does not preserve every original interval. The largest native RGB interval was approximately 200 ms.

The Process example calls `Evaluate(session)` without its separately estimated skeleton list. We preserved that behavior, so the HTML/JSON skeleton evaluation section is absent even though skeleton outputs exist in the replay and NPZ file. No mesh stream exists in this Android capture; the requested mesh-refinement branch was consequently skipped.

## Reproduce on a new recording

```bash
cd ~/projects/robotics-data-collection
.venv-stera/bin/python scripts/process_capture.py \
  captures/session_YYYYMMDD_HHMMSS/session_data_YYYYMMDD_HHMMSS.mcap
```

The runner refuses to replace an existing completed output. Supply `--output` with a new directory to repeat an experiment. See the project [README](../README.md#run-stera-process-and-evaluate) for fresh-environment installation.

SDK source is pinned to `df6a5ec8919053c5cd448db83d4816e1faaaec62` and remains unchanged. The isolated environment uses Python 3.11, NumPy 1.26.4, MediaPipe 0.10.21, Rerun 0.22.1 and PyArrow 19.0.1. Our runner maps the SDK's newer Rerun timestamp/scalar/flush calls to equivalent older APIs because newer Rerun versions conflict with the SDK's NumPy requirement. The initial unadapted failure is retained under `stera_processed/attempt_unadapted/`.

The raw MCAP SHA-256 remained `8e508a5605ad01cf51de77e9d5600a8fcb5e65a4180dcc45a3261e63cb97c6bf`. Validation reread every exported HDF5 dataset, decoded/count-checked all video frames, loaded calibration arrays and skeleton data, and parsed the Rerun file. The runner now explicitly closes Rerun before hashing, including its final eight-byte footer. Clock-normalization checks confirm numerical sensor metrics are preserved. All processing remained local; no paid compute was used.

The ordinary Rerun file loader also encountered the machine's exhausted file-watch allowance. `view_capture.py` streams the recording through stdin to avoid that dependency; complete viewer ingestion was verified. The README includes an optional prepared system configuration for increasing the allowance with administrator authentication.

## What this changes for the startup

We now have an executable capture-to-episode baseline. This recording also demonstrates a concrete processing gap: a high aggregate health score can coexist with unusable geometry and unvalidated labels. The next useful work is to review missed-hand intervals, verify image/depth calibration and timestamp provenance, and assess every cloud message. Those checks should feed a task-specific acceptance report before any dataset is described as training-ready.
