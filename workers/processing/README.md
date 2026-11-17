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

- `mcap_stream.py` verifies the indexed container in file order, including the chunk and data CRCs, message and chunk indexes, metadata records and indexes, statistics, summary offsets, footer and EOF. The report carries SHA-256, bytes read, peak buffer size and retained Schema/Channel bytes. Chunk, record, message and metadata limits apply before reading their bodies. Unique schema and channel bodies also share an 8 MiB retention limit by default. Trailing bytes and compressed chunks fail explicitly.
- `capture_stream.py` validates the SA-50 v1.1 H.264 profile, clock declarations, original frame identities and terminal counts. It joins frames and associated sensor evidence within bounded windows. An explicit H.264 profile must match the capture Profile. The SA-68 v1.2 `Profile.v2` and `Close.v2` wire contracts require a v1.2 streaming reader.
- `h264_decode.py` preflights coded raster dimensions in each SPS and decodes each access unit once with a persistent PyAV decoder and at most four pending access units. `FrameTransform` records the decoded raster. Crop, rotation and mirror stay unknown under the v1.1 contract.
- `frames.py`: `FrameStream` composes the above. `accepted` is true only after the footer/CRC/hash checks, the Close counts and the decoder flush all succeed, so a decoder failure after a valid footer cannot be accepted.

For an original Stera ROS2 JPEG recording pass `source_profile="stera_jpeg_mcap_v1"` to `FrameStream`. This lane requires the Stera `sensor_msgs/msg/CompressedImage` CDR channel, checks JPEG dimensions before decode, and decodes each image once. It preserves the ROS header, MCAP publish and MCAP log timestamps separately, together with the original sequence and per-image hashes. The frame ordinal and microsecond PTS are derived for processing. Clock mapping, camera acquisition IDs and H.264 Close evidence remain unavailable. The reader rejects a JPEG recording through the H.264 entry point.

The JPEG lane reports `rgb_only` and counts excluded messages by domain in `excluded_messages_by_domain`. The full-source hash covers those messages. Depth, pose, inertial measurements, calibration, transforms and other non-RGB payloads are excluded from the decoded output. JPEG headers and decoded pixels establish the saved raster. Frame-linked crop, rotation and mirror remain unverified. The existing geometry diagnostic reads a sidecar and retains session-wide associations, so it cannot supply those transforms on this bounded streaming path.

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
