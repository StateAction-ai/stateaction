# StateAction capture wire contract (SA-50)

`stateaction.capture.v1.1` is the single source contract for the H.264-in-MCAP capture profile `h264_mcap_v1`. Android (Kotlin), iOS (Swift), Flutter (Dart), TypeScript and Python readers/writers test against the same schemas and golden files. The profile is **unqualified**: nothing here claims physical-device, hardware-clock or training qualification, and no field claims model-relative 3D data is metric ground truth.

## Contract files (hash-pinned in `manifest.json`)

| File                                                                                                 | Purpose                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Profile`, `Clocks`, `Inventory`, `FrameEvent`, `MotionEvent`, `SensorEvent`, `Close` `.schema.json` | Strict JSON Schema 2020-12 for the JSON evidence channels (`jsonschema` schema encoding, `json` message encoding). Nanoseconds, IDs and counts are decimal strings; unavailable/unknown states are explicit (`Inventory`: `yes/no/unknown/unavailable`, nullable counts). |
| `foxglove-compressed-video.desc`                                                                     | Complete transitive `FileDescriptorSet` for `foxglove.CompressedVideo` (Foxglove schemas 0.4.0) including `google/protobuf/timestamp.proto`. MIT/BSD licences in `LICENSE-*`; provenance in `schema-provenance.json`.                                                     |
| `fixtures/protocol.json`, `fixtures/encoder_buffers.json`                                            | Small schema-level examples including a >2^53 nanosecond value; encoder-buffer-sequence to access-unit contract.                                                                                                                                                          |
| `golden/`                                                                                            | Deterministic MCAP corpus (`cases.json`, `expected/*.json`, `source/*.h264`). Regenerate with `conformance/python/gen_golden.py`.                                                                                                                                         |
| `conformance/`                                                                                       | Reference and per-language checkers (Python, TypeScript, Dart, Kotlin, Swift) and `run_all.py`.                                                                                                                                                                           |

Native Android copies of the contract files live in `packages/stera_recorder/android/src/main/assets/stateaction/capture` and must stay byte-identical (verified).

## Encoding rules

- MCAP header profile is **empty** (`""`): the file mixes Protobuf, CDR and JSON, so it must never claim the `ros2` profile.
- `/camera/rgb/video`: `foxglove.CompressedVideo`, schema encoding `protobuf`, message encoding `protobuf`, embedded descriptor hash must equal the pin. One complete Annex B **image** access unit per message (first image IDR, every IDR carries SPS+PPS, no B slices, codec configuration alone is not an image).
- Distinct identities that round-trip exactly: capture time (Protobuf `timestamp`, also the MCAP log time unless explicitly delayed), `frame_id` = optical frame name (a coordinate frame, never an image ID), `source_frame_id` (FrameEvent), video sequence (MCAP channel sequence = `output_sequence`), encoder PTS (`encoder_pts_us`, time base `1/1000000`), terminal outcome (`written` or `dropped` + reason).
- Original native clocks are preserved (`native_timestamp_ns`, `native_clock_id`, `native_timestamps`); the mapped capture time is derived evidence under `clock_mapping_revision`. `Clocks.stream_clocks` declares each stream's clock; mixing is a defect.
- IMU samples are independent raw `MotionEvent`s, not frame timestamps. CDR channels (e.g. `geometry_msgs/msg/PoseStamped`) use `ros2msg` schema + `cdr` message encoding.
- `Close` carries final frame/drop/video/sensor counts and a terminal outcome; counts must equal the observed lifecycle.
- Historical `sensor_msgs/CompressedImage` JPEG captures are classified `legacy_jpeg` and never accepted as `h264_mcap_v1`.

## Channel table (exact encodings, reviewed schema identity)

Every reader requires exactly this table (`E_CHANNEL_ENCODING` otherwise, including any undeclared topic or schema name/encoding/message-encoding mismatch):

| Topic                                                                                                               | Schema name                     | Schema encoding | Message encoding |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------- | ---------------- |
| `/stateaction/{capture_profile,clocks,inventory,frame_events,sensor_events,close}`, `/stateaction/imu/{accel,gyro}` | `stateaction.capture.<Name>.v1` | `jsonschema`    | `json`           |
| `/camera/rgb/video`                                                                                                 | `foxglove.CompressedVideo`      | `protobuf`      | `protobuf`       |
| `/tracking/pose`                                                                                                    | `geometry_msgs/msg/PoseStamped` | `ros2msg`       | `cdr`            |

Schema bytes are hash-pinned (`E_SCHEMA_MISMATCH`, `E_DESCRIPTOR_HASH`); the PoseStamped definition is pinned as `geometry_msgs-PoseStamped.ros2msg` (copied from the native recorder's `ROS2SchemaDefinitions`).

## Frame lifecycle, counts and finalization rules (every reader)

- `acquired` once per `source_frame_id`; at most one `submitted`; exactly one terminal `written` or `dropped`, or none when the recording ended first (`unresolved`). Every later event must repeat the acquired identity: recording/stream, native timestamp and clock, mapped capture time and mapping revision, calibration id, `encoder_pts_us`, `encoder_time_base`, native timestamps (`E_FRAME_IDENTITY`). `encoder_pts_us` is a canonical decimal integer (`E_PTS_INVALID`), the time base is exactly `1/1000000` (`E_TIME_BASE`), calibrations must be declared in the Inventory (`E_CALIBRATION_UNKNOWN`).
- Written `output_sequence` values are unique and equal the MCAP video message sequences one to one (`E_SEQUENCE`); video timestamp and IDR flag equal the written event (`E_VIDEO_TIMESTAMP_MISMATCH`).
- `Close` must equal the observed frame states, video messages, motion events per topic, sensor events and `drops` by reason (`E_COUNT_MISMATCH`). `completed` requires `unresolved == 0` and `failed` requires a `failure_reason` (`E_OUTCOME_MISMATCH`); `aborted`/`failed` files with unresolved frames are accepted when their counts are exact. A file without a footer/Close is `E_TRUNCATED`.
- Undecodable Protobuf/JSON/CDR messages or records are the defined reject `E_MALFORMED_MESSAGE`; FrameEvents that violate the strict-schema subset (required keys, decimal-string integers) are `E_SCHEMA_MALFORMED`. Runners never crash on these inputs. MCAP `DataEnd` CRCs are not part of the unchunked golden layout and are not checked.

## Encoder buffer sequences (partial / config contract)

`fixtures/encoder_buffers.json` is a contract-level fixture, independent of any producer: MediaCodec-style output buffers (`CODEC_CONFIG=2`, `PARTIAL_FRAME=8`, `END_OF_STREAM=4`, `KEY_FRAME=1`) built from NAL ranges of the public `golden/source/baseline-5.h264`, and the whole access units a writer must assemble from them, or the reject code. Codec configuration is stored and prepended to IDR access units without SPS/PPS; it never becomes an image. Chunks of one frame share a PTS and complete only on a buffer without `PARTIAL_FRAME`. Rejects: `E_INCOMPLETE_AU`, `E_PARTIAL_PTS_MISMATCH`, `E_MISSING_PARAMETER_SETS`, `E_MULTIPLE_ACCESS_UNITS`, `E_PTS_INVALID`. The MediaCodec producer that feeds real buffers is SA-51; this repo only fixes the expected assembly behaviour and tests it in all five language readers.

## Golden corpus and expected outcomes

44 cases. Their outcomes and error codes are **declared by hand in `gen_golden.py` (`case_models`) and stored in `golden/cases.json`**; the generator asserts that the reference checker agrees, and every runner compares its result with both `golden/expected/<case>.json` (canonical facts, byte for byte) and the declared codes. Expected facts of accepted files are additionally checked against values computed from the generator model (capture time, SHA-256, sequence, source frame id, PTS).

| Outcome                                                              | Cases                                                                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| accept                                                               | `valid`, `delayed`, `idr_with_config`, `aborted_unresolved`, `failed_unresolved`                                                                          |
| `E_CONFIG_ONLY`                                                      | `config_only`                                                                                                                                             |
| `E_MULTIPLE_ACCESS_UNITS`                                            | `multiple_access_units` (two complete AUs in one message; formerly misnamed `partial_two_access_units`)                                                   |
| `E_MISSING_PARAMETER_SETS` / `E_B_FRAME`                             | `missing_config` / `b_frame` (real x264 B slices)                                                                                                         |
| `E_DUPLICATE_PTS` / `E_MISSING_PTS`                                  | `duplicate_pts` / `missing_pts`                                                                                                                           |
| `E_CLOCK_MISMATCH`                                                   | `unequal_clock`                                                                                                                                           |
| `E_TRACKING_LOSS_UNMARKED`                                           | `tracking_loss`                                                                                                                                           |
| `E_CALIBRATION_RESET_UNMARKED`                                       | `calibration_reset`                                                                                                                                       |
| `E_CHANNEL_ENCODING`                                                 | `channel_encoding_{video,json,cdr}_message`, `channel_encoding_{video,json,cdr}_schema`, `pose_schema_identity`                                           |
| `E_FRAME_IDENTITY` (+ `E_VIDEO_TIMESTAMP_MISMATCH` for capture time) | `written_pts_mismatch`, `written_capture_time_mismatch`, `written_calibration_mismatch`, `dropped_identity_mismatch`                                      |
| `E_TIME_BASE` / `E_PTS_INVALID`                                      | `time_base_mismatch` / `pts_not_integer`                                                                                                                  |
| `E_SEQUENCE` (+ `E_VIDEO_TIMESTAMP_MISMATCH`)                        | `duplicate_output_sequence`                                                                                                                               |
| `E_COUNT_MISMATCH`                                                   | `close_count_mismatch`, `motion_count_mismatch`, `sensor_count_mismatch`, `drop_reason_mismatch`; `schema_malformed_frame_event` (+ `E_SCHEMA_MALFORMED`) |
| `E_OUTCOME_MISMATCH`                                                 | `completed_with_unresolved`, `failed_without_reason`                                                                                                      |
| `E_DESCRIPTOR_HASH` / `E_PROFILE_NOT_EMPTY`                          | `descriptor_hash` / `ros2_profile`                                                                                                                        |
| `E_MALFORMED_MESSAGE`                                                | `malformed_protobuf_wire_type`, `malformed_protobuf_length`, `malformed_json`, `malformed_cdr`                                                            |
| `E_TRUNCATED`                                                        | `truncated_mid_record`, `truncated_before_footer`                                                                                                         |
| classify `legacy_jpeg`                                               | `legacy_jpeg`                                                                                                                                             |

Fixtures are synthetic (64x48 testsrc video, invented sensor values) and are not physical camera evidence. The goldens are unchunked and uncompressed on purpose so each runner needs no MCAP dependency; chunked/compressed production files are covered by `verify.py --mcap` using the official `mcap` reader.

## Running

```sh
uv run --no-project --with jsonschema==4.25.1 --with mcap==1.6.0 --with protobuf==6.33.0 python packages/contracts/capture/verify.py
python3 packages/contracts/capture/conformance/run_all.py --require python,typescript,dart,kotlin,swift
pnpm exec nx run-many -t syntax,format,test -p capture-conformance,capture-conformance-mobile   # the CI path
```

`verify.py` validates schemas, pins, native asset identity, reproduces every expected result, validates all JSON evidence in accepted files against the embedded schemas, replays the encoder-buffer fixture, and independently decodes with the official `mcap` reader, the Protobuf runtime on the embedded descriptor and ffmpeg (decoded-frame count when ffmpeg and ffprobe exist; a missing ffprobe skips only that count). `run_all.py` fails closed: a runner listed in `--require` that cannot run is a failure, never a pass. Toolchain variables: `NODE_BIN`, `DART_BIN`, `GRADLE_BIN` (else the repository's Gradle wrapper) + JDK 21 `JAVA_HOME`, `SWIFT_BIN`.

Regenerate goldens: `uv run --no-project --with protobuf==6.33.0 python packages/contracts/capture/conformance/python/gen_golden.py` (then `prettier --write` is not needed: the generated `fixtures/encoder_buffers.json` is in `.prettierignore`).

### Nx / CI wiring

- `capture-conformance` (`packages/contracts/capture/project.json`): `syntax`, `format`, `test` (= `verify.py` + the TypeScript runner via `run_all.py --require python,typescript`). Runs in the server `checks` job through `nx affected`; inputs are the capture directory, the native asset copies and the Android `data/h264` sources.
- `capture-conformance-mobile` (`packages/contracts/capture-mobile/project.json`): `format` (`dart format`) and `test` (Dart runner + Kotlin Gradle test via `--require dart,kotlin`). It is excluded from the server job and selected by the existing `mobile_projects` selector, so it runs in the Android/Dart job where the pinned Flutter/Dart and JDK 21 exist (Kotlin uses `apps/mobile/android/gradlew`).
- **Swift is not run in hosted CI**: no Swift toolchain is provisioned on the hosted runner. The Swift 6.1.2 Linux runner passes locally (`SWIFT_BIN=... run_all.py --only swift --require swift`); this is a recorded hosted gap, not a pass.

## Provenance of the Protobuf descriptor

`schema-provenance.json` pins the upstream `foxglove-schemas-protobuf==0.4.0` wheel and sdist by SHA-256 and the exact rebuild command; `conformance/python/build_descriptor.py` rebuilds `foxglove-compressed-video.desc` from that wheel and verifies it is byte-identical to the committed descriptor. There are **no generated bindings** in this change: the descriptor is the Protobuf contract and each language reader contains a small hand-written decoder for the four-field `CompressedVideo` message (the Kotlin writer, `VideoWire`, is hand-written too). Generated code from the descriptor is not part of this ticket.

## Per-language scope and limits

- **Python**: reference checker; JSON Schema validation of accepted files (`verify.py`); independent decode with official libraries.
- **TypeScript (Node ESM), Dart, Swift, Kotlin `ContractReader`**: dependency-free full ports of the checker (MCAP, Protobuf, Annex B, CDR, ledger/lifecycle, close, channel and encoder-buffer rules). They enforce the strict-schema subset described above but do **not** run a JSON-Schema validator; full schema validation of evidence in TypeScript (e.g. Ajv) is deferred until the shared SA-12 validator lands.
- **Kotlin native replay** (`NativeProtocolReplayTest`): drives the production Android classes `AnnexB`, `H264FrameLedger` (including `writtenEvent`) and `VideoWire` with the golden events and checks the exception type and message of each declared rejection it claims (config-only, multiple AU, missing parameter sets, B frame, duplicate PTS, non-integer PTS, time base, written PTS/capture time/calibration identity, dropped identity). The remaining 28 rejecting cases (descriptor, channel encodings, clocks, tracking, calibration reset, close/motion/sensor/drop counts, outcome, sequences, malformed messages, profile, truncation, legacy) are proven by the Kotlin `ContractReader` only and are reported as `portable_only`, not as natively enforced. These android sources are not yet wired into the recorder (SA-51).
- **Swift**: runs on Linux Foundation only. It proves the contract and goldens are decodable in Swift, **not** that an iOS recorder, AVFoundation/VideoToolbox encoding or Apple-platform behaviour exists. The iOS capture implementation and physical qualification remain open.
