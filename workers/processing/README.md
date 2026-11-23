# Python worker foundation

Python 3.12.13 / uv 0.13.6. `make install` installs the locked worker and developer checks. Nx calls native uv commands; it does not replace Python packaging.

```sh
pnpm exec nx run-many --projects=processing --targets=build,typecheck,test,format
```

`stateaction-worker health` reads a bounded UUID request from stdin and returns a versioned JSON response. Render's `LocalExecutor` invokes this actual installed module with a bounded child process. The build produces a standalone wheel in `dist/`.

## Streaming capture reader (SA-29)

Forward-only reader for indexed MCAP sources. Hand inference, artifact export and recording admission are separate interfaces.

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

- `mcap_stream.py` reads uncompressed, indexed MCAP in file order and verifies chunk and data CRCs, message and chunk indexes, metadata records and indexes, statistics, summary offsets, the footer and EOF. Chunk, record, message and metadata limits apply before reading their bodies. Unique schema and channel bodies share an 8 MiB retention limit by default. The report carries SHA-256, bytes read, peak buffer size and retained schema and channel bytes. Compressed chunks, including zstd and lz4, fail with `E_STREAM_UNSUPPORTED_COMPRESSION`. Trailing bytes and flat layouts also fail.
- `capture_stream.py` selects the v1.1 or v1.2 wire contract using the embedded Profile channel schema. Both revisions can declare `h264_mcap_v1`. The reader verifies pinned schemas, frame identities, clocks and Close counts, and joins frame and sensor evidence within bounded windows. v1.2 adds checks for saved-raster calibration revisions, depth and confidence associations, and camera metadata. An explicit H.264 source profile must match the value in the embedded Profile.
- The worker caps v1.2 JSON evidence at 64 KiB and MCAP messages at 16 MiB by default. Depth event IDs and image sequences must increase within each stream. By default each optional association table holds up to 64 entries. The worker rejects associations outside the window and mesh or point-cloud payloads.
- `h264_decode.py` preflights coded raster dimensions in each SPS and decodes each access unit once with a persistent PyAV decoder and at most four pending access units. `FrameTransform` records the decoded raster. v1.1 leaves capture crop, rotation and mirror unknown. The worker checks each available v1.2 saved-raster calibration against the decoded dimensions. Preview overlays use the decoded raster.
- `FrameStream.require_accepted()` requires successful container and Close checks, a decoder flush with matching counts, and a completed H.264 capture. An aborted, failed or unknown outcome can be structurally valid but cannot be published automatically.

For an original Stera ROS2 JPEG recording pass `source_profile="stera_jpeg_mcap_v1"` to `FrameStream`. This lane requires the Stera `sensor_msgs/msg/CompressedImage` CDR channel, checks JPEG dimensions before decode, and decodes each image once. It preserves the ROS header, MCAP publish and MCAP log timestamps separately, together with the original sequence and per-image hashes. The frame ordinal and microsecond PTS are derived for processing. Clock mapping, camera acquisition IDs and H.264 Close evidence remain unavailable. The reader rejects a JPEG recording through the H.264 entry point.

The JPEG lane reports `rgb_only` and counts excluded messages by domain in `excluded_messages_by_domain`. The full-source hash covers those messages. Depth, pose, inertial measurements, calibration, transforms and other non-RGB payloads stay in the source. JPEG headers and decoded pixels establish the saved raster. The stream cannot establish frame-linked crop, rotation, mirror, depth alignment or camera geometry. The sidecar geometry diagnostic retains session-wide associations and runs separately.

Frames are provisional until `require_accepted()` returns. Compare `report.source.sha256` and `report.source.bytes_read` with the sealed source inventory before publishing any result.

`av` and `numpy` are in the locked `decode` group. Current fixtures cover small native-format examples and bounded synthetic workloads. They leave physical capture, long recordings and hardware qualification open.

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

To run inference on original Stera JPEG, pass `source_profile="stera_jpeg_mcap_v1"` to `run_hand_inference`, or use `--source-profile stera_jpeg_mcap_v1` with the CLI. Each JPEG observation exposes `identity.jpeg_source`. Its `source_message` preserves the ROS header timestamp, the MCAP publish and log timestamps, channel, sequence, frame name and JPEG SHA-256. `stream_ordinal` and `derived_pts_us` are processing values. The reported landmarks use the saved JPEG raster. Camera transforms and cross-stream timing remain unverified.

The CPU model detected hands in 43 of 51 frames in the selected phone H.264 capture. The recorded counts are eight frames with no hands, 19 with one and 24 with two. The 0.5 thresholds remain unchanged. The SA-61 bottle-grip replay recorded no detections in 29 frames at that threshold. Held-tool usefulness, handedness, 3D scale and orientation still need qualification. Set `STATEACTION_HAND_FIXTURE=/path/indexed.mcap` to enable the positive-capture test.

## Clip artifacts and portable reader (SA-31)

`artifact_export.export_artifacts(raw, sink, context)` streams a verified capture into bounded, immutable clips (native MP4 remux, NPZ, hand-observation JSON, frame map, thumbnail, customer-safe Rerun 0.41.0 RRD) and a `processing_result.v1` manifest written last, only after the whole source is accepted. `artifact_reader.open_result(prefix)` is the stdlib + numpy reader; `python -m stateaction_processing.artifact_cli export|read` is the local CLI. Full description, limits and non-goals: [`docs/components/processing-artifacts.md`](../../docs/components/processing-artifacts.md). Real browser check of an exported RRD: `tools/viewer_check.py`.

For v1.2, the processing result records verified counts for calibration revisions, camera metadata, raw depth, raw confidence and dense depth. Native payloads stay in the original, access-controlled MCAP. A derived copy of any native evidence would require a versioned artifact contract and explicit access authorization. The customer RRD retains its RGB, hand-overlay, model-relative hand and notes allowlist. Its `source_frame` and `clip_time` timelines join to the frame map, which keeps the original acquisition ID, native clock and timestamp, and encoder PTS.
