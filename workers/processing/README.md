# Python worker foundation

Python 3.12.13 / uv 0.13.6. `make install` installs the locked worker and developer checks. Nx calls native uv commands; it does not replace Python packaging.

```sh
pnpm exec nx run-many --projects=processing --targets=build,typecheck,test,format
```

`stateaction-worker health` reads a bounded UUID request from stdin and returns a versioned JSON response. Render's `LocalExecutor` invokes this actual installed module with a bounded child process. The build produces a standalone wheel in `dist/`.

## Streaming capture reader (SA-29)

Forward-only path from a raw `h264_mcap_v1` source to decoded RGB frames. Hand inference is SA-30 (below); output artifacts (SA-31) and geometry are separate tickets.

```python
from stateaction_processing.frames import FrameStream

stream = FrameStream(
    open(path, "rb")
)  # only read(n) is used: no seek, tell, mmap or whole-file buffer
for frame in stream:  # DecodedFrame: .rgb (uint8 [H,W,3]), .access_unit, .transform
    ...  # provisional work only, with bounded temporary artifacts
report = (
    stream.require_accepted()
)  # raises unless the whole source verified AND decoded
```

- `mcap_stream.py`: indexed MCAP in file order. Every byte through the footer and closing magic feeds one SHA-256; bytes after the closing magic are hashed then rejected. Chunk CRCs are checked before a chunk's messages are yielded; data-section CRC, MessageIndex, ChunkIndex, Statistics, SummaryOffset and summary CRC are checked in the same pass. Bounds (`Limits`): chunk, record and message bytes, records per chunk, chunk count, definitions, optional source cap (an honest cap, not a qualified 100 GiB limit). Only uncompressed chunks are supported; zstd/lz4 fail with `E_STREAM_UNSUPPORTED_COMPRESSION`.
- `capture_stream.py`: the SA-50 contract rules applied per message with the reference module's own schema/AU code (`contract.py` locates `packages/contracts/capture`, or `STATEACTION_CAPTURE_CONTRACT_DIR`). Frame lifecycle state is limited to in-flight frames; video is joined to its `written` FrameEvent inside a bounded window; sensor events attach to a frame for `sensor_hold_videos` later video messages, later ones are rejected (`E_SENSOR_ASSOCIATION_LATE`). Source frame ids and encoder PTS must increase, B-frames, missing config, wrong first IDR, unknown/legacy JPEG profiles, clock and count mismatches are rejected. Original frame ids, PTS, native clocks/timestamps, calibration id and hashes are preserved unmodified.
- `h264_decode.py`: one persistent PyAV decoder (`thread_count=1`, `err_detect=explode`, original PTS as packet PTS, at most 4 pending access units). Each frame is converted to RGB once. `FrameTransform` records the decoded raster; crop, rotation and mirror are `None` (unknown) because contract v1 does not record them.
- `frames.py`: `FrameStream` composes the above. `accepted` is true only after the footer/CRC/hash checks, the Close counts and the decoder flush all succeed, so a decoder failure after a valid footer cannot be accepted.

Provisional rule: frames are yielded before the footer is read. Inference or encoding may start, but success, publication and acceptance wait for `require_accepted()`.

Not covered: compressed chunks, hardware qualification, a 100 GiB or two-hour run, physical-phone captures, non-increasing PTS/B-frame streams. `av` and `numpy` live in the locked `decode` group (also in `default-groups`).

## CPU hand inference (SA-30)

`hand_stream.run_hand_inference(raw, sink)` consumes `FrameStream`: one decode and one MediaPipe Hand Landmarker inference per frame (CPU delegate, IMAGE mode, so no cross-frame tracking state; up to 2 hands; 21 landmarks; the pinned 0.5 detection/presence thresholds). Each `HandObservation` goes to `sink` immediately and is never accumulated. The returned `HandRunSummary` exists only after `require_accepted()` (footer, CRCs, source SHA-256, Close counts, decoder flush). Any model, decode or source error raises, so no job can succeed with RGB-only output. A frame with no hand is a valid fully-masked observation.

```sh
uv sync --locked                         # default groups include dev, decode, cpu (mediapipe==1.2.0)
../../spikes/android/processing/fetch_model.sh   # hash-verified model into ~/.cache/mediapipe
uv run --locked python -m stateaction_processing.hand_stream INDEXED.mcap [--expected-sha256 HEX]
```

Model provenance and pins are in `src/stateaction_processing/hand_model.json` (reused from the merged SA-61 spike: SHA-256 `fbc2a300…cde1`, 7,819,105 B, Apache-2.0, mediapipe 1.2.0). The model is not committed; `STATEACTION_HAND_MODEL` overrides the cache path, and a missing file, wrong size or wrong hash fails before any decode.

Observation conventions (also carried on every observation as `semantics`):

| Field                                      | Meaning                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `image_landmarks_px [2,21,2]`              | pixels of the decoded raster; may lie outside it; crop/rotation/mirror unknown in contract v1  |
| `model_relative_landmarks_m [2,21,3]`      | MediaPipe hand-centred world estimate in metres, model-relative only                           |
| `landmark_mask [2,21]`, `hand_present [2]` | finite-coordinate mask and detection flag; absent/non-finite entries are NaN, never fabricated |
| `handedness_score [2]`                     | hand-level classification score, **not** per-joint confidence                                  |
| `joint_confidence`, `joint_visibility`     | unsupported (`None`)                                                                           |
| `handedness_label`                         | model label under a mirrored-input assumption; the capture mirror state is unknown             |
| `metric_accuracy_validated`                | always `False`                                                                                 |

The hand axis is detection order, not identity. Original frame id, encoder PTS, native clocks/timestamps, calibration id and access-unit SHA-256 are copied unchanged.

Limits: the 0.5 thresholds are unchanged and the model is weak when a hand holds a tool (SA-61 replay: a bottle grip was detected in 0/29 frames at 0.5, 2/29 at 0.3). Real emulator captures contain no hands. A real hand example comes only from the historical Android JPEG replay (software H.264, synthetic timing), which gives detection counts and visual alignment, not accuracy or phone-hardware qualification. Handedness, 3D scale and orientation are unvalidated. Tests: `STATEACTION_HAND_FIXTURE=/path/indexed.mcap` enables a real positive-example test.

## Clip artifacts and portable reader (SA-31)

`artifact_export.export_artifacts(raw, sink, context)` streams a verified capture into bounded, immutable clips (native MP4 remux, NPZ, hand-observation JSON, frame map, thumbnail, customer-safe Rerun 0.41.0 RRD) and a `processing_result.v1` manifest written last, only after the whole source is accepted. `artifact_reader.open_result(prefix)` is the stdlib + numpy reader; `python -m stateaction_processing.artifact_cli export|read` is the local CLI. Full description, limits and non-goals: [`docs/components/processing-artifacts.md`](../../docs/components/processing-artifacts.md). Real browser check of an exported RRD: `tools/viewer_check.py`.
