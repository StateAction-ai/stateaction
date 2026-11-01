# StateAction contracts (v1)

Versioned wire and durable-document contracts shared by the phone, API, workflow controller and processing worker. JSON Schema 2020-12 files in [`api/`](api/) are normative. Three adapters load the same files and run the same fixtures:

| Adapter                               | Location / Nx project                            | Validator                                                                                                         |
| ------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| TypeScript (`@stateaction/contracts`) | `packages/contracts` · `contracts`               | Ajv 8.20 `Ajv2020`, `strict: true`, `allErrors: true`                                                             |
| Python (`stateaction-contracts`)      | `packages/contracts/python` · `contracts-python` | `jsonschema` 4.26 `Draft202012Validator`, with ECMA-262 end-of-input `$` semantics                                |
| Dart (`stateaction_contracts`)        | `packages/contracts/dart` · `contracts-dart`     | `json_schema` 5.2.2, draft 2020-12; pure Dart (no `dart:io` in `lib/`), so Flutter can supply schemas from assets |

Capture-format schemas (`capture/`, MCAP channels, codec/video and sensor fixtures) are owned by SA-50 and are not part of this package's v1 API surface. They can reference the shared definitions in [`common.v1.schema.json`](api/common.v1.schema.json) by absolute `$ref`, for example `https://stateaction.ai/schemas/common.v1.json#/$defs/timestampNs`.

## Contracts

[`api/catalog.v1.json`](api/catalog.v1.json) lists each contract: its schema, casing, version discriminator, byte bound and cross-field rules.

| Group         | Casing / version                                                                                         | Contracts                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.*`      | camelCase; the `/api/v1` or `/internal/v1` path is the version                                           | success/error envelopes, recording create/seal/response, upload create/plan, part sign/signed/receipts, upload transition (`reconcile`/`complete`/`cancel`/`restart`) |
| `jobs.*`      | camelCase; `schemaVersion: 1` in the payload (controller input and job status use the task name or path) | controller input `{jobId}`, compute task input, worker claim, claim grant, heartbeat, result candidate, job status                                                    |
| `artifacts.*` | snake_case; `"schema": "stateaction.<name>.v1"`                                                          | recording source declaration, processing result manifest, frame-map shard, hand-observation shard                                                                     |

Deferred to their own tickets: `review/v1` (review), `release-selection/v1` and `release/v1` (dataset versions), and the catalog/browser routes.

### Value encoding

- **Domain IDs** (recording, file, job, clip, manifest) are canonical lowercase UUIDs. **Auth user IDs** are opaque strings (`^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$`). They are never parsed and never required to be UUIDs.
- **Byte sizes and offsets** are decimal strings: file sizes 1..107374182400 (the 100 GiB transport cap), byte counts 0..107374182400.
- **Timestamps, PTS, native frame IDs and large counters** are exact non-negative int64 decimal strings (0..9223372036854775807). The bound is enforced by a generated regular expression, so every standard validator checks it identically; `test/policy.test.ts` regenerates and checks the expression. Convert with `BigInt`/`int`/`BigInt.parse`, never floating point.
- **Clocks**: each timestamp names its `clock_domain`. Domains are never merged or converted. A frame map keeps `source_frame_id`, `timestamp_ns`, `clock_domain`, `source_pts`, `clip_pts` and a rational `time_base {num, den}`. `clip_pts = source_pts − first source_pts`. Wall time is RFC 3339 UTC with a `Z` suffix only.
- Part numbers, epochs, counts and raster sizes are bounded JSON integers within the safe range. Every object is closed (`additionalProperties: false`, or a bounded map), every array and string is bounded, and every number has limits.
- **3D hands**: `points_3d.space` is either `model_relative` (`metric_accuracy_validated: false`, units `model_estimated_meters`, origin `hand_geometric_center`) or `camera_metric` (`metric_accuracy_validated: true` plus a validation profile and evidence file reference). The metric branch is reserved for a future separately qualified profile. Its metadata is checked for shape only, and the presence of evidence fields does not prove physical accuracy. Production output stays model-relative, and the result manifest pins `metric_accuracy_validated: false`. Image landmarks are 21 `(x, y)` pixels in `joint_order`. Missing points are `null` with mask `false`, `handedness_score` is not per-joint confidence, and visibility is always `"unknown"`.

## Validation order and error codes

`validateBytes` / `validate_bytes` / `ContractRegistry.validateBytes` apply these steps in order and return the first failing code:

1. `document_too_large`: more bytes than the contract's `maxBytes` (1 MiB for control documents, 16 MiB for frame-map and hand shards).
2. `malformed_json`: a UTF-8 BOM, invalid UTF-8, invalid JSON (including `NaN`/`Infinity` literals and trailing data), non-finite numbers such as `1e400`, lone surrogates, or nesting deeper than 32.
3. `unsupported_version`: the discriminator (`schemaVersion` or `schema`) is present but not in the accepted set. Matching is JSON-typed, so `"1"` is not `1`.
4. `schema_violation`: JSON Schema errors, each reported with its instance JSON pointer.
5. Cross-field rules, applied in a fixed order (`src/rules.ts`, `rules.py`, `rules.dart`): `duplicate_identity`, `part_plan_mismatch` (`partCount ≠ ceil(sizeBytes / 64 MiB)`), `progress_mismatch`, `inventory_incomplete`, `reference_mismatch`, `ordering_violation`, `clock_mismatch`, `dimension_mismatch` (frame counts, crop bounds, NPZ shapes `[F,2,21,2]` / `[F,2,21]` / `[F,2,21,3]` / `[F,2]` / `[F]`) and `mask_mismatch`.

HTTP mapping for the error envelope: `unauthenticated` 401, `forbidden` 403, `not_found` 404 (absent or inaccessible), `conflict`/`idempotency_conflict` 409, `payload_too_large` 413, `invalid_request`/`unsupported_version` 422, `rate_limited` 429, `provider_unavailable` 503, `internal` 500. Error messages never include credentials, URLs with signatures or raw provider errors.

## Digests

Request hashing and manifest hashing are different operations.

**Idempotency request digest (`sa-cjson-v1`).** Creation routes store `requestSha256` with the scope `(actor, operation, idempotency key)`. An exact replay, even with different whitespace or key order, returns the original object. Changed content returns 409 `idempotency_conflict`. The digest is the lowercase hex SHA-256 of these UTF-8 bytes:

- Value domain: `null`, `true`, `false`, integers in ±9007199254740991, well-formed strings, arrays and objects. Any other number is rejected with `noncanonical_value` and is never rounded. Integral spellings such as `1.0`, `1e3` and `-0` are the same value as `1`, `1000` and `0`, because JavaScript cannot distinguish them. Invalid JSON is `malformed_json`.
- Integers are printed in shortest decimal form, without a sign on zero.
- Strings use `\"`, `\\`, `\b`, `\f`, `\n`, `\r` and `\t`. Other code points below U+0020 become `\u00xx` with lowercase hex. Everything else, including `/`, U+007F, U+2028 and non-BMP characters, is written as literal UTF-8.
- Object keys are sorted ascending by UTF-16 code units. Output has no whitespace, and array order is preserved.

This is a project-defined encoding. For this restricted value domain it is intended to produce the same bytes as RFC 8785, but no RFC 8785 conformance is claimed. The golden cases in `conformance/fixtures/digests.v1.json` were written by hand. Their digests are plain SHA-256 values of the literal canonical text, and they cover UTF-16 key ordering, escapes, non-ASCII text, safe-integer extremes and every rejection class.

**Stored manifests.** Durable documents are hashed over their exact stored bytes (`verifyStoredBytes`). The digest lives outside the document, for example `ResultCandidate.manifestSha256`. A document never embeds its own digest, and the result manifest may not list a `result_manifest` output. Re-serializing the same value changes the digest, and a fixture proves this.

## Versioning and compatibility policy

- Every published schema file is immutable. `api/schemas.lock.json` records the SHA-256 of every file, and the policy test fails on any byte change. A breaking or additive change adds a new `*.v2.schema.json` and catalog entry. The v1 entry is never edited.
- Readers accept an explicit set of versions per contract and reject everything else with `unsupported_version`. They never silently ignore unknown fields: unknown fields fail with `schema_violation`.
- Rollout order for a new version: (1) publish vN alongside v(N−1); (2) deploy readers that accept both; (3) switch producers to vN; (4) retire v(N−1) only after no stored or in-flight document uses it. Durable artifacts stay readable for as long as they are retained, so artifact versions are only ever added.
- HTTP versions are route prefixes. A new `/api/v2` route group may coexist with v1, and v1 bodies keep their exact shapes.
- Compatibility examples are in the fixtures: `jobs.task-input.v1` rejects `schemaVersion: 2`, `jobs.worker-claim.v1` rejects the string `"1"`, `artifacts.recording-source.v1` rejects `stateaction.recording_source.v2`, and `artifacts.hand-observations.v1` rejects `…v0`. All of these return `unsupported_version` before schema validation.

## Fixtures and checks

`conformance/fixtures/` holds the shared positive and negative cases. Every case states its expected code and the error paths that must be reported. `conformance/generate_fixtures.py` authors them deterministically, and the Python tests run it with `--check`. The fixture files are excluded from Prettier because their digests cover exact bytes.

```sh
pnpm exec nx run-many -p contracts,contracts-python,contracts-dart -t build,typecheck,test,format
```

The contracts-dart project needs the pinned Dart 3.12.2 (from Flutter 3.44.6), and its runner fails closed on any other SDK. In CI it runs in the Flutter job, and the TypeScript and Python projects run in the server and tooling job. No adapter falls back to a weaker check: an unknown contract, unresolvable `$ref`, unknown rule or unpinned SDK is an error.
