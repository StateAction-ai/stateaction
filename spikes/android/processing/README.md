# SA-61 CPU hands + real Rerun viewer probe

Isolated, reproducible local probe for [SA-61](https://linear.app/hw-personal-projects/issue/SA-61). It is **not** the production worker, does not touch `apps/web`, the pnpm workspace or `workers/processing`, and creates no cloud/GPU resources. Same Python code runs anywhere Python 3.12 + uv runs (including a Render native Python runtime); nothing here is deployed.

## Pipeline

1. **Strict gate.** `strict_capture.py` reads the source once (explicit byte bound, default 512 MiB) and runs the published SA-50 reference reader `packages/contracts/capture/conformance/python/capture_conformance.py`. Only `accept` continues. Video payloads are joined back to the reader's own facts (MCAP sequence, SHA-256, encoder PTS, `source_frame_id`, capture/log time) and any disagreement is an error. Decode order must equal PTS order (no B-frame reordering, first AU IDR). Chunked/indexed production layouts are rejected by this reader, never reported complete.
2. **One sequential decode.** PyAV/FFmpeg `h264`, one pass, `thread_count=1`, `err_detect=explode`, at most 4 pending AUs, exact PTS→AU mapping, drained at each IDR clip boundary.
3. **Real CPU inference.** MediaPipe Hand Landmarker (pinned task asset below), CPU delegate, `IMAGE` mode (no cross-frame tracking state), up to 2 hands, on every decoded frame.
4. **Per-clip outputs** (`artifacts/<run>/clip-NNN/`, IDR-only splits, `clip_pts = source_pts − first_included_source_pts`, time base 1/1,000,000):
   - `rgb.mp4`: native remux of the original Annex B access units (no transcode); an independent re-decode verifies exact PTS, decoded pixels and VCL NAL bytes.
   - `hands.npz`: `image_landmarks_px [F,2,21,2]` in the encoded source raster, `model_relative_landmarks_m [F,2,21,3]`, `landmark_mask [F,2,21]`, handedness label/score, `source_frame_id`, `clip_pts_us`. Absent hands are NaN with mask `False`. The hand axis is detection order, **not** tracked identity.
   - `frame-map.jsonl`: one row per frame with original ids/clocks, AU and VCL hashes, decoded-pixel hash and detections.
   - `viewer.rrd`: bounded (256 MiB) customer-safe RRD with only `/rgb` (VideoStream of the **original** AUs), `/rgb/hands/{left,right}` image-pixel overlays, `/model_relative_3d/{left,right}` labelled panes and `/notes`. Each frame logs `Clear` for both sides first, so a missing hand clears prior drawings at that exact time. Timelines: `clip_time` (duration ns = clip_pts × 1000) and `source_frame`.
   - `receipt.json`: input hash/class, reader summary, decoded frame count/order, CPU ms/frame, RSS checkpoints, RRD bytes, exact environment.
5. **Real browser viewer.** `browser_check.py` serves the probe directory on loopback and drives Chrome via `agent-browser` with `viewer.html`, which loads the actual `@rerun-io/web-viewer@0.41.0` JS/WASM (hashes recorded). It wraps (never replaces) WebCodecs `VideoDecoder`, seeks forward to a frame with hands and backward to an earlier frame (preferring one without), asserts the exact `clip_time` cursor, decoder input/output timestamp identity (mirroring pinned Rerun's f64 µs truncation within 1 µs), `avc1` config, display raster, error-free viewer logs/reports, allowlisted entities, playback cursor advance and pause, JS heap, and `viewer.stop()` canvas removal. Screenshots still need visual readback before overlay alignment is claimed.

## Run

Pinned tools: Python 3.12.13, uv 0.13.6, Node 24.22.2 (npm only for this isolated folder), Google Chrome + `agent-browser`.

```sh
cd spikes/android/processing
uv sync --locked --group cpu --group dev
./fetch_model.sh                         # downloads + verifies the pinned model into ~/.cache/mediapipe
npm ci --ignore-scripts --no-audit --no-fund
uv run --locked python -m unittest discover -s tests -v

# Published golden fixture (public, deterministic codec/timeline fixture; no hands expected)
.venv/bin/python probe.py process ../../../packages/contracts/capture/golden/valid.mcap artifacts/golden-001 \
  --input-class published_golden_fixture
.venv/bin/python browser_check.py artifacts/golden-001/clip-000

# Any accepted capture (emulator or physical); pass the expected hash when known
.venv/bin/python probe.py process /abs/capture.mcap artifacts/run-001 --input-class android_emulator_spike \
  --expected-sha256 SOURCE_SHA256
```

Each run needs a new output directory. A rejected source exits 2 with the reader's codes and writes no receipt.

Historical replay (local, private user capture, never committed):

```sh
.venv/bin/python probe.py replay /abs/session_data_20261022_152005.mcap artifacts/replay/historical-90.mcap --frames 90
.venv/bin/python probe.py process artifacts/replay/historical-90.mcap artifacts/historical-001 \
  --input-class historical_android_jpeg_replay_software_h264
```

`replay` decodes the first N historical JPEGs, software-encodes them with libx264 baseline (keyint 30, no B-frames, SPS/PPS on every IDR) at the source raster, and writes a contract-valid MCAP with the published SA-50 golden writer (`gen_golden.render`). Contract timing is synthetic (33,333 µs); the replay must pass the same strict gate. It never qualifies phone hardware capture, codec, clocks, calibration or thermal behaviour.

## External dependency map

| Dependency                   | Pin                                  | Source                            | Licence / notice                                                                                 |
| ---------------------------- | ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Hand landmarker task         | SHA-256 `fbc2a300…cde1`, 7,819,105 B | `model.json` URL (Google storage) | Apache-2.0 per official model card (card SHA-256 in `model.json`); fetched, not committed        |
| mediapipe                    | 1.2.0                                | PyPI via `uv.lock`                | Apache-2.0                                                                                       |
| av (PyAV) + bundled FFmpeg   | 19.0.2                               | PyPI via `uv.lock`                | BSD-3 (PyAV); bundled FFmpeg/libx264 licensing needs its own distribution review before shipping |
| rerun-sdk                    | 0.41.0                               | PyPI via `uv.lock`                | MIT OR Apache-2.0; `VideoStream` is an unstable API, keep SDK/viewer paired                      |
| @rerun-io/web-viewer         | 0.41.0                               | npm via `package-lock.json`       | MIT                                                                                              |
| numpy / psutil / mcap        | 2.5.4 / 7.2.2 / 1.6.0                | PyPI via `uv.lock`                | BSD-3 / BSD-3 / MIT                                                                              |
| SA-50 contract reader/writer | repo                                 | `packages/contracts/capture`      | in-repo; Foxglove/Protobuf notices there                                                         |

## Evidence classes (never merged)

- **Published golden fixture**: codec/timeline/reader correctness only (64×48 baseline, 5 frames, one dropped acquisition). No hand utility.
- **Historical replay**: real hands from the user's own 2026-10-22 Android capture, software H.264, synthetic contract timing. Detection counts and visual alignment only; not accuracy.
- **Android emulator spike** (pending SA-60 merge): actual recorder output; codec/container/timeline path only, virtual scene.
- **Physical Android capture** (pending user recording): the only class that can inform real hand usefulness, codec and clock behaviour.

## Pilot hand-usefulness rubric (proposed thresholds; staff calibration pending)

Scored by two staff on ≥200 sampled frames per condition (bare hands, gloves, tool-in-hand, partial occlusion, motion blur) from representative physical recordings. Staff label "hand visible" and "overlay usable" (wrist and ≥4 of 5 fingertips within about half a finger width of the visible joint).

| Metric                                        | Proposed pilot threshold                                              |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Inter-rater agreement on "usable" (Cohen's κ) | ≥ 0.60 before any threshold below is applied                          |
| Detection recall on visible bare hands        | ≥ 0.80 (gloves/tool/occlusion reported separately; no silent pooling) |
| False detections on frames without hands      | ≤ 0.05                                                                |
| Usable overlays among detections              | ≥ 0.80                                                                |
| Handedness correct on clear frames            | ≥ 0.90                                                                |
| Stale overlay after a missed/absent hand      | 0 (mechanically checked: per-frame `Clear`)                           |

A failed rubric or viewer qualification is a blocking finding. It is not resolved by shipping RGB-only review or by silently switching to a restricted/GPU model.

## Known limitations

- MediaPipe logs `Using NORM_RECT without IMAGE_DIMENSIONS is only supported for the square ROI` in IMAGE mode; projected landmarks were visually aligned on the replay, but non-square-ROI precision is not measured.
- Handedness score is not per-joint confidence/visibility; no depth, occlusion, world trajectory or metric claim (`metric_accuracy_validated=false`).
- Whole-file reads bounded by `--max-source-bytes`; this is not a two-hour/1080p streaming or thermal qualification. Chunked production MCAP needs the official reader path (`verify.py --mcap`), not this probe.
- Headless Linux Chrome with software WebGL only; no signed URL/R2/auth/Next.js/React lifecycle test.
- Generated MCAP/MP4/RRD/NPZ/screenshots stay under ignored `artifacts/`. Only scripts, locks and non-sensitive receipts in `receipts/` are tracked.
