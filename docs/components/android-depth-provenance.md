# Android depth, confidence and camera provenance (SA-55, Android first)

Status: **helper layer and explicit declarations only.** The strict `stateaction.capture.v1.1` contract has no depth,
confidence, camera-metadata or mesh/point-cloud channel, and its objects are closed. This ticket therefore does **not**
write depth bytes to MCAP. It adds the pure, tested model a contract revision would carry, and makes the existing
Inventory state honest. A permissive undocumented payload was deliberately not added. Nothing here is physical-device,
clock-accuracy or metric-accuracy evidence; iOS is deferred (SA-65).

## What exists

`DepthEvidence`, `CameraProvenance`, `OptionalGeometry` (`data/h264/DepthEvidence.kt`, JVM-tested by `DepthEvidenceTest`):

| Concern            | Rule                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source kind        | `arcore_raw_depth_estimated` (stream `depth_raw`) and `arcore_dense_depth_estimated` (stream `depth_dense`) are distinct kinds; both are flagged `estimate=true`.                                                                                                                            |
| Shape / precision  | `copyPlane` removes only row/pixel stride padding (optional recorded crop). Sample bytes are copied unchanged: DEPTH16 stays little-endian uint16 millimetres, confidence stays uint8.                                                                                                       |
| Confidence         | `separate_image` (native plane), `not_provided_by_source`, or `unavailable_for_frame`. Never a zero-filled plane.                                                                                                                                                                            |
| Time / source      | Native timestamp, native clock id, optional mapped time, optional `association_source_frame_id` and `calibration_id` are carried verbatim; unknown values are `null`.                                                                                                                        |
| Cadence            | `CadenceGuard` rejects a repeated or regressing native depth timestamp per kind, so low-rate depth is never re-emitted at RGB cadence.                                                                                                                                                       |
| Stream states      | `disabled`, `unsupported`, `unavailable`, `unknown`, `observed` (`availability()`); non-observed states carry a reason label and no values.                                                                                                                                                  |
| Camera metadata    | Exposure, ISO, focus distance, frame duration, rolling-shutter skew: `reported` value or `unavailable` + reason (non-finite platform values become unavailable). Lens distortion, extrinsics and confidence noise are labelled `assumption`, `measured=false`; `timing_accuracy=unverified`. |
| Mesh / point cloud | Modes `actual_events`, `final_snapshot`, `unsupported`, `disabled`, `unknown`; only `actual_events` claims per-event timing. Non-finite coordinates keep raw IEEE-754 bits plus a `nan`/`positive_infinity`/`negative_infinity` flag.                                                        |

Production change in this revision: the Inventory `depth` sensor (strict contract, unchanged schema) now states why no
depth was recorded: not requested (no reason), `device_reports_unsupported`, or `depth_payload_not_in_contract_revision`
(replaces `depth_not_in_profile_revision`). `enabled`/`observed` are `no` and `observed_count` is `null`.

## Contract extension needed (root coordination)

To record depth, the contract needs (all closed schemas, with golden fixtures in all five language runners):

1. A `DepthEvent` JSON schema on `/stateaction/depth/raw` and `/stateaction/depth/dense` carrying exactly the map built by
   `DepthEvidence.event` (and `streamState` for non-observed streams), with the plane descriptor fields above.
2. A binary payload framing for the plane bytes (plane descriptor + native-precision samples) and its confidence plane.
3. `Clocks.stream_clocks` entries for `depth_raw` / `depth_dense`, and Inventory sensor ids for them.
4. A camera-metadata evidence schema and a mesh/point-cloud stream-state schema (`OptionalGeometry.streamState`).

Wiring ARCore `acquireRawDepthImage16Bits` / `acquireRawDepthConfidenceImage` / `acquireDepthImage16Bits` into the
recorder, and SA-54's calibration values for `calibration_id`, follow that revision.

## Validation

- JVM: `./gradlew :stera_recorder:testDebugUnitTest` (stride, crop, pixel stride, byte preservation, confidence states,
  raw vs dense, availability states, cadence guard, camera/assumption labelling, non-finite flags, Inventory reasons).
- Emulator (verified accelerated emulator-5582, API 33, user 0): `scripts/test_android_h264_e2e.py` now includes a take
  with `recordDepth=true`; `scripts/check_depth_declaration.py` confirms the Inventory declares depth explicitly, no depth
  channel exists, and RGB/IMU are observed. The emulator reports depth **unsupported**, so supported-depth bytes are only
  exercised by pure fixtures. This is simulation evidence, not physical qualification.
