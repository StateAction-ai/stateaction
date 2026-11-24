# SA-24 CPU hand overlays and Rerun playback

**Decision:** Keep detection and presence at **0.5** as the reproducible baseline. This baseline did not qualify for staff use. The sampled worn gloves went undetected, and a high frame-level detection count did not establish fingertip accuracy under occlusion. The historical Android bottle-grip result remains **0/29** at 0.5. No thresholds or model files changed. [SA-61 historical replay receipt](../../spikes/android/processing/receipts/historical-replay.json)

## Inputs and runtime

| Input                                   |   Frames processed | Frames with any hand | CPU p50 / p95 per frame | Probe peak RSS | Total RRD bytes |
| --------------------------------------- | -----------------: | -------------------: | ----------------------: | -------------: | --------------: |
| SA-50 mixed-schema golden MCAP, 64 × 48 |                5/5 |                    0 |       52.74 / 174.91 ms |      290.5 MiB |          67,553 |
| HomER 33, 1920 × 1080                   | first 120 of 2,167 |                  104 |        47.76 / 72.04 ms |      459.4 MiB |       2,332,961 |
| HomER 37, 1920 × 1080                   | first 120 of 1,984 |                  118 |        62.32 / 89.12 ms |      463.6 MiB |       3,514,758 |
| IndEgo Allen wrench, 480 × 480          |            140/140 |                  131 |       80.86 / 181.48 ms |      289.6 MiB |       2,384,835 |
| IndEgo putting on gloves, 480 × 480     |            234/234 |                   68 |       66.35 / 188.31 ms |      304.9 MiB |       2,406,977 |

- HomER inputs were the two local SA-86 simulation MCAPs. Their SHA-256 digests start with `28625cff` and `0da5e4da`. The strict reader and official MCAP cross-check validated the full sources. Inference and playback used their first four complete GOPs, about four seconds each, with original simulated AU bytes, frame IDs and timestamps intact. An earlier whole-episode probe was terminated before completion. [SA-86 fixture provenance](../components/flora-fixture-store.md)
- IndEgo inputs were two 480px egocentric exports, 14.0 s and 23.4 s of video. SA-86's converter re-encoded H.264 with B-frames disabled and wrapped the original presentation order and PTS in labelled simulation MCAPs. The public MP4 SHA-256 digests are `71ea074f4ab7de3108ccebfc7b7eb5e3fd9b36d5b097cee3ca21fd53064af63e` and `3330d6aa1b257fd210b73aa9d6e97eb7ae32faf58d0dcb8c2fde7a772292fbcc`. [Chavan et al., IndEgo, CC BY 4.0 dataset card](https://huggingface.co/datasets/FraunhoferIPK/IndEgo), [Allen wrench video at the tested revision](https://huggingface.co/datasets/FraunhoferIPK/IndEgo/blob/c822468b5e0c9c42ebbf2939d3be936c2b203704/8_Singular_Actions/1_Screwing_screw_with_allen_wrench/mp4_480/User_15_Short_1_480.mp4), [Glove video at the tested revision](https://huggingface.co/datasets/FraunhoferIPK/IndEgo/blob/c822468b5e0c9c42ebbf2939d3be936c2b203704/8_Singular_Actions/18_Putting_on_working_gloves/mp4_480/User_14_Short_18_480.mp4)
- The fresh locked environments resolved on Linux x86_64 with uv 0.13.6 and CPython 3.12.13. The probe ran MediaPipe 1.2.0 in CPU IMAGE mode with up to two hands, PyAV 19.0.2, NumPy 2.5.4, MCAP 1.6.0 and Rerun SDK 0.41.0. The official Apache-2.0 MediaPipe Hand Landmarker full float16 v1 task was hash-verified as `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`. The downloaded model card matched `43127ff8a92e22717f0d8c30dab3efef4641a29cbf50b15ae3de001be94ab76b`. [Worker model card and asset pins](../../workers/processing/src/stateaction_processing/hand_model.json), [Probe lock](../../spikes/android/processing/uv.lock), [Worker lock](../../workers/processing/uv.lock)

The locked worker's `stateaction_processing.hand_stream` also accepted the Allen-wrench simulation using one decoder. It decoded and inferred 140/140 frames, matching the probe's 131 frames with hands and 218 hand observations.

The probe decoded H.264 sequentially with one decoder thread and split RRDs at IDRs. Its independent MP4 decode matched each tested frame's PTS, pixels and VCL NAL bytes. For these sources, the viewer cursor is `(encoder_pts_us - first_clip_encoder_pts_us) * 1000` nanoseconds, with original frame IDs preserved on `source_frame`. Converter timestamps come from an MP4 clock with a fixed anchor. A physical Android take is needed to validate the current recorder's native clock mapping. [Probe and timeline contract](../../spikes/android/processing/README.md)

## Browser results

| Input                                       | RRD bytes loaded | Startup to ready |         JS heap used at seeks | Video codec   | Source frame IDs at forward/backward seek |
| ------------------------------------------- | ---------------: | ---------------: | ----------------------------: | ------------- | ----------------------------------------- |
| Regenerated golden, production Next harness |           67,553 |          7.418 s | 9,264,547 B after clip switch | `avc1.42C00A` | Test seeks the golden clip end            |
| HomER 33, clip 000                          |        2,332,961 |         18.982 s |      9,722,177 / 10,605,729 B | `avc1.640028` | 84 / 16                                   |
| HomER 37, clip 000                          |        3,514,758 |         29.600 s |       6,723,636 / 7,472,085 B | `avc1.640028` | 81 / 42                                   |
| IndEgo Allen wrench, clip 001               |          359,696 |         83.972 s |       7,329,648 / 6,788,573 B | `avc1.640016` | 134 / 131                                 |
| IndEgo putting on gloves, clip 000          |        1,430,408 |         38.435 s |       6,771,615 / 6,589,345 B | `avc1.640016` | 54 / 51                                   |

Chrome 155.0.8059.84 used headless Linux with SwiftShader WebGL. All four standalone clips were below the Next viewer's 128 MiB bound. The selected seeks matched exact `clip_time` and WebCodecs timestamps (0 µs delta for the eight samples). Playback advanced, pause held, and stop removed the canvas on all four. Forward screenshots showed image-space overlays and the labelled hand-centred 3D estimate. Backward screenshots showed empty 3D panes, with a fully rendered RGB frame and no 2D overlay on HomER 37 frame 42. Three backward captures showed the video spinner, which limits visual timing evidence at those seeks. Each per-frame mask agreed with finite image and 3D landmarks and with the frame map. The RRD writer emits recursive clears for both 2D and 3D hand paths each frame before writing detections.

The production Next 16.4.6 Rerun suite passed 7/7 with its checked-in golden and 7/7 with the regenerated golden plus the IndEgo clip. This exercised the real embedded viewer, the local broker and fixture storage, immutable 0.41.0 WASM, WebCodecs, clip switch, URL renewal, access revocation and unmount cleanup. The 66,876,216-byte WASM matched `f2831500e6ca8645fbfc94f4ffff78e62a4eb8d864afd84299f9188b9b577cb2`. Standalone startup varied under workstation load. JS heap excludes WASM and GPU allocations. Browser samples establish local playback and seek behavior on this renderer. [Production viewer test](../../apps/web/test-e2e/rerun-viewer.e2e.test.mjs)

## Pilot rubric readback

I sampled 12 frame indices per clip source at `floor((i + 0.5) * N / 12)`, with `i = 0..11` and `N` equal to the number of frames processed above. I inspected decoded RGB for visibility and then projected the masked points into the same raster for alignment. Frame-level detection rates below credit any hand on a frame with at least one visible hand. The glove row also scores the worn glove separately.

| Condition                                       | Observed result at 0.5                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HomER 33, bare right hand reaching and gripping | At least one hand detected on 11/11 visible-hand samples. The orange overlay followed the wrist and the visible contour in the knife grip. Cropping, blur or the closed grip obscured enough joints to prevent confirming wrist plus four fingertips.                                                                           |
| HomER 37, knife and stabilizing hand            | At least one hand detected on 12/12 visible-hand samples. Both hands were visible in all 12, and both received detections in 8/12. The model missed the stabilizing hand in three samples and the knife hand at frame 115. The projected tips and the visible grip boundaries did not establish the strict fingertip criterion. |
| IndEgo Allen wrench and occlusion               | At least one hand detected on 11/11 visible-hand samples, including 8/8 samples during wrench manipulation (frames 29–110). At frames 40 and 64 the model assigned both hands the same right label while both were visible. The overlapped grips obscured individual tips.                                                      |
| IndEgo gloves                                   | At least one hand detected on 3/12 visible-hand samples. Worn glove detected in 0/9 samples with a visibly worn glove (frames 68–224 in the sample). The clear open palms at frame 204 received no overlay. The earlier detections followed bare hands.                                                                         |
| Sampled no-hand frames                          | 0/2 false detections (HomER 33 and IndEgo Allen wrench frame 5). The synthetic golden also produced 0/5 detections.                                                                                                                                                                                                             |
| Missing-hand clearing                           | Zero stale overlays in the settled HomER 37 backward screenshot. Masks and source frame IDs separately preserved misses.                                                                                                                                                                                                        |

The proposed staff thresholds are Cohen's κ ≥0.60 on usable labels, ≥80% visible bare-hand recall, ≤5% false detections on absent frames, ≥80% usable overlays among detections, ≥90% handedness on clear frames and zero stale overlays. A usable overlay requires the wrist and at least four fingertips to be within about half a finger width of the visible joints. Score gloves, held tools, partial occlusion and blur separately. This diagnostic had one reviewer, small samples and too few clearly visible fingertips for a strict usable-overlay estimate. Staff calibration needs two raters and at least 200 sampled frames per condition on representative physical recordings. [SA-61 rubric and limitations](../../spikes/android/processing/README.md#pilot-hand-usefulness-rubric-proposed-thresholds-staff-calibration-pending)

## Reproduce locally

Use the [locked SA-61 setup](../../spikes/android/processing/README.md#run). For the public examples run the [SA-86 converter](../../workers/processing/tools/mp4_to_sim_mcap.py) with `--camera-label IndEgo`, then call `probe.process` from the locked spike Python environment with `max_clip_seconds=10.0` and an explicit simulation input class. The golden uses the unmodified `probe.py process` CLI.

For HomER, run the following from `spikes/android/processing`, setting `HOMER_MCAP` to a fixture's `source.mcap` and `HOMER_OUTPUT` to a new ignored output directory. Only this invocation wraps the probe's loader. The loader validates the original full source before selecting the same first 120 AUs.

```sh
.venv/bin/python - "$HOMER_MCAP" "$HOMER_OUTPUT" <<'PYTHON'
from dataclasses import replace
from pathlib import Path
import sys

import probe

strict_load = probe.sc.load

def load_excerpt(*args, **kwargs):
    capture = strict_load(*args, **kwargs)
    assert capture.access_units[0].idr and capture.access_units[120].idr
    return replace(capture, access_units=capture.access_units[:120])

probe.sc.load = load_excerpt
probe.process(
    Path(sys.argv[1]), Path(sys.argv[2]),
    model=probe.MODEL_DEFAULT, max_clip_seconds=10.0,
    expected_sha256=None, max_source_bytes=probe.sc.DEFAULT_MAX_SOURCE_BYTES,
    input_class="homer_video_to_sim_mcap_first_120_frames",
)
PYTHON
```

Pass the selected `clip-NNN` folder to `browser_check.py`. Keep raw media, generated files and screenshots in ignored artifacts directories. The production viewer test accepts the golden and a distinct clip as `a.rrd` and `b.rrd` under `SA38_RRD_DIR`. [Next harness and fixture requirements](../components/rerun-clip-review.md#local-evidence)

## Remaining qualification

A fresh physical Pixel take from the latest collector (`NO_AUTH_MODE=true`, verified personal profile, user taps Start) is still required. Capture representative tool use, glove, occlusion and motion examples. Run strict ingest, CPU inference, native MP4 remux and Rerun on that source, then record native frame mapping, forward and backward seeking, overlay timing, resource use and the two-staff rubric. The fixture results leave the 0.5 usefulness finding open, including the bottle-grip failure. No phone recording was started during this run.
