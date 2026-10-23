# Shared wire and manifest contracts

Updated: 2026-10-23. Owner: backend + processing leads. Generate OpenAPI/JSON Schema and TypeScript/Python/Dart fixtures from this contract during implementation; these generated files are not shipped yet.

Operation-specific bodies belong to [auth](components/auth-and-access.md), [upload](components/mcap-upload.md), [workflow](components/job-orchestration.md), [processing](components/cloud-processing.md) and [delivery](components/review-and-delivery.md). [Storage](components/storage-and-data-model.md) owns entities and state enums.

## Encoding

| Item | Contract |
| --- | --- |
| Names | HTTP bodies use `camelCase`; durable manifests/event/task payloads use `snake_case`. Use explicit typed mappings. |
| Version | Human domain API `/api/v1`; durable documents have named `schema_version`. Reject unsupported majors; changing meaning requires a new major/contract. Optional additive fields may be ignored. |
| IDs | Opaque strings. Preserve existing auth IDs. IDs never establish permission. |
| Integers | Native timestamps, bytes and unbounded counters are decimal strings on the wire; integer types in DB/Python. Bounded part numbers/counts and revisions may be safe JSON integers. |
| Time/units | Operational timestamps: RFC3339 UTC. Sensor values: integer + clock domain/unit. Coordinates: named frame, units, transform convention and validity. Device ticks are not assumed Unix time. |
| Hashes | Lowercase 64-character SHA-256 hex. File/manifest hashes cover exact stored bytes. Logical inventory/idempotency digests use RFC8785 canonical JSON over the declared fields. Version the digest definition. |
| Missing values | Finite numbers only; no NaN/Infinity. Missing observation uses null/mask plus reason, never a fabricated zero. |
| References | Permanent references contain IDs/approved storage coordinates, never signed URLs, credentials or arbitrary remote URLs. |

Bound document bytes/depth/file counts before work. Large inventories use immutable sharded manifests. Schemas and profile limits must bound resource use. [Canonical JSON specification](https://www.rfc-editor.org/rfc/rfc8785)

## HTTP conventions

Route/auth boundaries: Better Auth `/api/auth/*`; human domain `/api/v1/*`; scoped CLI `/api/download/*`; worker/validator `/internal/v1/*`; signed Inngest `/api/inngest`. Each has separate middleware. Component tables use full paths.

Custom success responses use `{"data":...}`; cursor pages use `{"data":[...],"nextCursor":null}` with an opaque cursor when more results exist. Custom error: `{"error":{"code":"revision_conflict","message":"Revision changed","requestId":"..."}}`.

| Status | Meaning |
| --- | --- |
| 400 / 401 | Invalid schema / missing or expired authentication |
| 403 / 404 | Known-scope access revoked / invisible or missing object |
| 409 / 410 | Identity, revision or state conflict / expired resource |
| 413 / 422 | Request too large / verified invalid content |
| 429 / 503 | Throttled / retryable dependency failure; bounded Retry-After |

Auth-library errors retain their pinned client adapter. A retryable failure preserves operation identity.

Creation/request mutations require `Idempotency-Key` or the component's persistent client ID. Scope by actor + operation; store canonical request digest and result identity before external side effects. Exact replay returns the same operation; changed content returns 409. Recording/upload identities and tombstones survive for their retention lifetime. Review edits require safe-integer `expectedRevision`, never silent last-write-wins.

Source intervals are half-open `[start,end)` in one segment/clock. Use integer nanoseconds, exact frame associations and the pinned mapping's explicit terminal boundary; split intervals crossing segments. Preview seconds are presentation only.

## Common references

| Type | Required fields |
| --- | --- |
| Immutable object | `artifact_id`, provider (`r2`/`s3`), bucket/key, `size_bytes`, `sha256`, `media_type`; structured arrays also name schema/encoding |
| Lance snapshot | `batch_id`, `dataset_uri`, `dataset_version`, source/selection manifest references/digests, `result_contract_digest`; actual validated version, never latest |
| Source association | Recording/source generation, native frame/record ID, native timestamp/clock domain and mapping revision; intervals specify endpoint convention |
| Rights | `rights_policy_revision`, permitted processing/export uses, evidence references, region/retention restrictions; current revocations rechecked at execution/publication |

Resolve scope through server records; allowlist provider/bucket/prefix and reject traversal. Hashes do not authorize reads. Retain snapshot files and every referenced external payload while consumers depend on them.

## Durable documents

Every document has `schema_version`, ID, UTC creation time, tenant/project scope and provenance. These minimum fields are extended by component/channel/model schemas.

| Schema | Required content |
| --- | --- |
| `recording-source/v1` | Recording/seal digest; logical roles/segments and accepted file generations; expected bytes/client SHA; server bytes/SHA after verification; capture/channel/clock/calibration/geometry inventory; required/omitted inputs; rights/profile revision. Before ingest, server verification is explicitly pending. |
| `processing-task/v1` | Run/job/attempt IDs; batch when applicable; claim epoch; source/parent refs and expected versions; pipeline/image/model/config/result-contract digests; rights/profile revisions; absolute start/execution deadlines; resource/size limits; stable workspace and unique receipt location. Bootstrap capability travels separately in private invocation arguments. |
| `stage-result/v1` | Task/claim/input identity; actual dataset version/publication receipt or immutable output inventory; successful/failed/skipped counts and row-errors ref; requested/omitted capability flags; checksums; usage when available. A worker candidate is unaccepted. |
| `validation-result/v1` | Validation ID/candidate digest; checked input/claim identity; write-barrier/grant generation and terminal/retirement/drain evidence; object/snapshot closure and observed versions/checksums; complete pass/fail and diagnostics. Only the distinct validator capability may submit it. |
| `review-package/v1` | Accepted snapshots/artifacts; preview-to-source mapping; QC/missingness; label/taxonomy revision; rights/quality limitations and provenance. |
| `release/v1` | Frozen item/review/label/snapshot IDs; profile/taxonomy/loader/schema versions; grouped split assignments; rights/attribution/limitations; every required relative file/shard path, bytes and SHA; counts/dataset card. No mutable scratch or expiring URL dependency. |

Declared and server-verified source manifests are separate immutable revisions; the latter references the former. Do not fill verification fields by editing a manifest already referenced by hash. A manifest's own digest is stored in its reference/catalog, not recursively inside its hashed body.

Inngest events contain event ID/version/name, tenant/project, target run/batch/release IDs, pipeline revision and request time. Load detailed inputs from authoritative records. No media, bulk arrays or secrets. [Orchestration](components/job-orchestration.md) owns names, service endpoints and replay.

A **write barrier** records that the producer has stopped, its write grants cannot be renewed/used and pending writes are reconciled before validation. Hold exclusive ownership through validation and acceptance. The validator can read payloads and submit its receipt; it cannot write those payloads. **Compare-and-set (CAS)** means accepting only if the expected current identity/revision/lifecycle still matches in one database transaction.

## Required conformance

Commit schemas under `processing/contracts/` and publish the same versions to backend/mobile/console builds. Fixtures cover integers beyond JavaScript precision, clock domains, missing data, seal ordering, malformed/foreign references, version compatibility and hashes. Verify TypeScript/Python/Dart round trips. The release loader must traverse the complete manifest and all required shards.
