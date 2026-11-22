# Clip artifacts and portable reader (SA-31)

Scope: initial processing only: video decode, CPU hand pose, the formats needed to review it, and a Rerun preview. No geometry, depth, mesh, Lance, legacy SDK or whole-recording arrays. Code lives in `workers/processing/src/stateaction_processing/artifact_*.py` and stacks on SA-29 (`FrameStream`) and SA-30 (`HandInferencer`).

## Flow

```
FrameStream (1 decode/frame) -> HandInferencer (1 inference/frame) -> ClipWriter -> OutputSink.put(file)
                                                                      ... end of source ...
              FrameStream.require_accepted() -> manifest built + contract-validated -> OutputSink.seal(manifest)
```

- **Sharding.** A clip starts at an actual IDR and is cut at the first IDR at or after `clip_target_seconds` (30 s) or `clip_target_frames` (3000). If no IDR arrives before 60 s or `clip_max_frames` (3600) the job fails (`E_NO_IDR_WITHIN_CLIP_CEILING`); it never repairs, transcodes or restarts mid-GOP. The last clip ends at end of stream. Clip IDs and file IDs are job-scoped UUIDv5 values; clip ordinals are contiguous from 0.
- **Bounds.** One decoder (max 4 pending AUs), one clip's arrays/files alive, encoder queue ≤ 4, active-clip scratch ≤ 768 MiB, RRD ≤ 128 MiB, hand JSON ≤ 16 MiB (contract maximum). A closed clip is handed to the sink and its scratch copy deleted before the next clip is written.
- **Provisional until accepted.** Files reach the sink as soon as their clip closes, but nothing is complete until the whole source passed footer/CRC/SHA-256/Close checks and the decoder flushed. Only then is `result-manifest.json` written and passed to `seal()`, strictly last, after every file it lists was closed and hashed. Any error calls `abort()`. A prefix without a manifest is an incomplete result and the reader refuses it.
- **No overwrite.** `LocalDirectorySink` needs a fresh (absent or empty) prefix and places files with exclusive create. A retry uses a new prefix.
- **Uploader seam and identities.** The backend output protocol (SA-28) is not implemented. `OutputSink` (`put`, `seal`, `abort`) or `CallbackSink` is the interface a multipart uploader implements later. `put` receives each closed, hashed file and must return an `OutputReceipt` (store-selected immutable `file_id`, role, size, SHA-256); the exporter rejects a receipt that differs from the file and the manifest cites the receipt ids, so server-reserved random ids flow through unchanged. Production calls must supply `recording_id` and `source_file_id` (`E_IDENTITY_REQUIRED` otherwise); the native capture recording id is kept separately in the `source_accepted` check. `LocalDirectorySink` and the offline CLI use synthetic deterministic fixture ids and the manifest says so in `limitations`. Clip ids are job-scoped UUIDv5 values. This PR does not claim atomic database acceptance.

## Per-clip files (`clips/NNN/`)

| File                     | Contents                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rgb.mp4`                | Original Annex B access units muxed unchanged: no decode, no encode, no frame-rate conversion. Packet PTS = DTS = `clip_pts` in 1/1,000,000. Demux-checked after writing: PTS and VCL NAL bytes equal the source.                                             |
| `hand-arrays.npz`        | `image_landmarks_px [F,2,21,2]`, `image_landmarks_mask`, `model_relative_joints [F,2,21,3]`, `model_relative_mask`, `hand_detected [F,2]`, `handedness_score`, `handedness` (int8: 0 left, 1 right, −1 none), `frame_index`. NaN + `False` mask where absent. |
| `hand-observations.json` | `stateaction.hand_observations.v1`: per frame, per detected hand, image pixels, mask and `model_relative` 3D (`metric_accuracy_validated: false`). Numbers are the shortest decimal of the float32 values, so JSON equals the NPZ.                            |
| `frame-map.json`         | `stateaction.frame_map.v1`: original `source_frame_id`, native `clock_domain` + `timestamp_ns`, `source_pts`, `clip_pts = source_pts − first included source_pts` (time base 1/1,000,000), raster, identity export transform, `timing_verified: false`.       |
| `thumbnail.jpg`          | First frame, ≤ 320 px (software MJPEG).                                                                                                                                                                                                                       |
| `viewer.rrd`             | Customer-safe Rerun 0.41.0 spatial proxy (below).                                                                                                                                                                                                             |

`result-manifest.json` is the frozen `stateaction.processing_result.v1` document. All documents are validated with the shared `stateaction_contracts` v1 validators on the exact bytes written; there is no parallel schema.

## Customer-safe RRD

Allowlist: `/rgb` (H.264 `VideoStream`), `/rgb/hands/{hand0,hand1}` (image-pixel joints and bones), `/model_relative_3d/{hand0,hand1}` (explicitly model-relative) and `/notes`. Entities are detector slots in detection order, never handedness: the model can label two hands the same side, so side-keyed entities would overwrite one another. Both slots are cleared every frame, and the raw model label/score per slot is logged to `/notes/handedness` annotated as a mirrored-input assumption with unknown capture mirror. No MCAP, sensor, QC, internal-note or other clip data; hiding entities is not relied on.

Each RRD video sample is encoded by libx264 from the already-decoded RGB pixels. Source H.264 ancillary data, including SEI user data, stays out of the RRD. The separate native MP4 mux still receives the original access units. An even raster within 1280×720 (or 720×1280 in portrait) keeps its original dimensions. Larger rasters are downscaled, and dimensions are aligned to even values for yuv420p. Overlays follow the same scale, which is also logged to the notes entity. The proxy preserves each frame's microsecond clip PTS and uses a keyframe interval of 30, no B-frames, and explicit frame-rate and bitrate controls. The manifest check `proxy_rrd_bounds` records the configured raster limits and the count of re-encoded clips.

Every output is scanned for the home directory, user name, host name, source/output/scratch paths before being handed on. Timelines: `clip_time` (duration = `clip_pts`) and `source_frame` (original id).

## CLI and reader

```sh
cd workers/processing
uv run --locked python -m stateaction_processing.artifact_cli export SOURCE.mcap --out NEWPREFIX \
    --source-manifest-sha256 HEX [--job-id UUID] [--expected-source-sha256 HEX]
uv run --locked python -m stateaction_processing.artifact_cli read NEWPREFIX --verify-mp4 --json
```

`export` needs `--source-manifest FILE` (hashed) or `--source-manifest-sha256`; the source manifest is not fabricated. The reader (`artifact_reader.py`, stdlib + numpy) verifies every listed byte and rejects unlisted files, then exposes `arrays()`, `frame_map()`, `timestamps()`, `hand_observations()`, `provenance`, `verify_roundtrip()` (NPZ == JSON == frame map) and `verify_mp4()`.

## Recipe seal: review video, hand presence and `processing-result.v3` (SA-92)

With a recipe, `hand_pose_cpu_v1` is the last stage and seals the job; without one nothing below runs and the output is the unchanged `processing-result.v2` path. The bootstrap of the stage carries `stage: "hand_pose"`, `module`, `recipeSha256` and `priorStages` (the server rows of `segment` and `caption`: state, error code, counts and every completed file with its slot, role, size and SHA-256). The worker takes the recipe from `task-input.v3` after the claim and refuses a digest, module or stage mismatch.

In the same single pass that writes the clips (`artifact_export.export_artifacts(seal=...)`, `artifact_seal.py`) it also writes:

- `recording.mp4` (role `recording_mp4`): every access unit of the recording remuxed natively, verified by demuxing (PTS and VCL NAL bytes) like a clip's `rgb.mp4`. No decode, no encode, no frame-rate conversion.
- `hand-presence.json` (`hand-presence.v1`, role `hand_presence_json`): run-length left and right lanes over every frame. `present`, `no_hand` (an explicit result) and `failed` (no inference result) are separate states; the model thresholds are only recorded.

The clip files keep their 60 s ceiling and six roles per clip. The result is `processing-result.v3`: `outputs` lists every completed output of the job (earlier-stage files included), `nodes[]` has one node per stage copied from the server rows (a failed or `not_run` stage appears as such, its files absent or present as diagnostics, never an empty success), and `hand_pose` lists its own files. The worker then closes the inventory and posts the candidate as before. A stage `receipt.json` is not a job output: the server keeps it on the stage run, and a file no node can name would block the seal.

## Not covered

Backend multipart output/acceptance (SA-28), failure manifests (the backend protocol owns them), sensor-evidence files (no output role exists in the frozen contract), physical-phone/hardware-encoder qualification, 100 GiB or two-hour runs, accuracy or metric claims, and hosted CI (billing-blocked). Crop, rotation and mirror of the capture raster remain unknown in contract v1.

The proxy encoder explicitly configures a nominal 30 fps for libx264 rate control while retaining each frame's exact microsecond PTS; it never resamples the source. A microsecond time base without a nominal rate caused near-grey proxies despite successful decoding. The regression check encodes/decodes coloured moving frames with irregular PTS and compares actual pixels, in addition to the real browser overlay check.
