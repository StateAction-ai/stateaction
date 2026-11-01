# StateAction capture wire contract (SA-50)

`stateaction.capture.v1.1` is the single source contract for the H.264-in-MCAP capture profile `h264_mcap_v1`. Android (Kotlin), iOS (Swift), Flutter (Dart), TypeScript and Python readers/writers test against the same schemas and golden files. The profile is **unqualified**: nothing here claims physical-device, hardware-clock or training qualification, and no field claims model-relative 3D data is metric ground truth.

## Contract files (hash-pinned in `manifest.json`)

| File                                                                                                 | Purpose                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Profile`, `Clocks`, `Inventory`, `FrameEvent`, `MotionEvent`, `SensorEvent`, `Close` `.schema.json` | Strict JSON Schema 2020-12 for the JSON evidence channels (`jsonschema` schema encoding, `json` message encoding). Nanoseconds, IDs and counts are decimal strings; unavailable/unknown states are explicit (`Inventory`: `yes/no/unknown/unavailable`, nullable counts). |
| `foxglove-compressed-video.desc`                                                                     | Complete transitive `FileDescriptorSet` for `foxglove.CompressedVideo` (Foxglove schemas 0.4.0) including `google/protobuf/timestamp.proto`. MIT/BSD licences in `LICENSE-*`; provenance in `schema-provenance.json`.                                                     |
| `fixtures/protocol.json`                                                                             | Small schema-level examples including a >2^53 nanosecond value.                                                                                                                                                                                                           |
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

## Golden corpus and expected outcomes

18 cases; each has `golden/expected/<case>.json` (canonical JSON: `outcome`, sorted `errors`, and for accepted files exact facts: decimal capture/log timestamps, per-video SHA-256, counts, schema hashes). Every language must reproduce it byte for byte.

| Outcome                                            | Cases                                             |
| -------------------------------------------------- | ------------------------------------------------- |
| accept                                             | `valid`, `delayed`, `idr_with_config`             |
| reject `E_CONFIG_ONLY`                             | `config_only`                                     |
| reject `E_PARTIAL_ACCESS_UNIT`                     | `partial_two_access_units`                        |
| reject `E_MISSING_PARAMETER_SETS`                  | `missing_config`                                  |
| reject `E_B_FRAME`                                 | `b_frame` (real x264 B slices)                    |
| reject `E_DUPLICATE_PTS` / `E_MISSING_PTS`         | `duplicate_pts` / `missing_pts`                   |
| reject `E_CLOCK_MISMATCH`                          | `unequal_clock`                                   |
| reject `E_TRACKING_LOSS_UNMARKED`                  | `tracking_loss`                                   |
| reject `E_CALIBRATION_RESET_UNMARKED`              | `calibration_reset`                               |
| reject `E_COUNT_MISMATCH`                          | `close_count_mismatch`                            |
| reject `E_DESCRIPTOR_HASH` / `E_PROFILE_NOT_EMPTY` | `descriptor_hash` / `ros2_profile`                |
| reject `E_TRUNCATED`                               | `truncated_mid_record`, `truncated_before_footer` |
| classify `legacy_jpeg`                             | `legacy_jpeg`                                     |

Fixtures are synthetic (64x48 testsrc video, invented sensor values) and are not physical camera evidence. The goldens are unchunked and uncompressed on purpose so each runner needs no MCAP dependency; chunked/compressed production files are covered by `verify.py --mcap` using the official `mcap` reader.

## Running

```sh
uv run --no-project --with jsonschema==4.25.1 --with mcap==1.6.0 --with protobuf==6.33.0 python packages/contracts/capture/verify.py
python3 packages/contracts/capture/conformance/run_all.py --require python,typescript,dart,kotlin,swift
```

`verify.py` validates schemas, pins, native asset identity, reproduces every expected result, validates all JSON evidence in accepted files against the embedded schemas, and independently decodes them with the official `mcap` reader, the Protobuf runtime on the embedded descriptor and ffmpeg (decoded-frame count when ffmpeg exists). `run_all.py` fails closed: a runner listed in `--require` that cannot run is a failure, never a pass. Toolchain variables: `NODE_BIN`, `DART_BIN`, `GRADLE_BIN` + JDK 21 `JAVA_HOME`, `SWIFT_BIN`.

## Per-language scope and limits

- **Python**: reference checker, JSON Schema validation, independent decode.
- **TypeScript (Node ESM), Dart, Swift**: dependency-free full ports of the checker (MCAP, Protobuf, Annex B, CDR, ledger rules). No JSON-Schema validation in these runners (Python covers it).
- **Kotlin**: replays accepted/rejected goldens through the production Android classes `AnnexB`, `H264FrameLedger` and `VideoWire` (Protobuf bytes must equal the golden bytes). Descriptor, clock, tracking, calibration, close, profile, truncation and legacy rules are _not yet implemented in native Kotlin_ and are therefore not claimed (SA-51 and later).
- **Swift**: runs on Linux Foundation only. It proves the contract and goldens are decodable in Swift, **not** that an iOS recorder, AVFoundation/VideoToolbox encoding or Apple-platform behaviour exists. The iOS capture implementation and physical qualification remain open.
