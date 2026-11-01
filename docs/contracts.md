# Shared wire and manifest contracts

SA-12 publishes the v1 API, task and artifact contracts in [`packages/contracts`](../packages/contracts/README.md). That README is the normative reference for encoding rules, the `sa-cjson-v1` request digest, error codes, the validation order and the versioning policy.

This version carries forward the reviewed design semantics from the archived `docs/contracts.md` (tag `archive/implementation-before-ticket-prs-2026-11-01`):

- HTTP uses camelCase and durable manifests use snake_case.
- Domain IDs are UUIDs. Identity-provider user IDs are opaque.
- Byte sizes, nanosecond timestamps, PTS and large counters are decimal strings. SHA-256 values are lowercase hex. Wall time is RFC 3339 UTC.
- Commands reject unknown fields, non-finite numbers, unsafe paths and counts above their limits. Control documents are limited to 1 MiB and 2,000 files. Frame and hand rows live in bounded external shards.
- Envelopes are success `{data, requestId}` and failure `{error: {code, message, retryable}, requestId}`.
- Idempotency is scoped to actor, operation and exact request digest. Changed content returns 409.
- Manifests are hashed over their exact stored bytes, and the digest is stored outside the document.
- Job states, `TaskInput`, worker claim/grant and `ResultCandidate` are specified, together with a secret-free controller input `{jobId}`.
- Hand observations have up to two hands with 21 image landmarks each. 3D estimates are model-relative unless a separately qualified metric profile authorizes otherwise.

| Implemented here                                                                                                     | Owned elsewhere / deferred                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Envelopes; recording create/seal/response; upload create/plan, part sign/signed/receipts, transitions                | Route handlers, persistence and provider calls: SA-13/SA-14 and upload tickets                                       |
| Source manifest chain: `source_manifest` role, seal/claim inventory rules, `checkSealedInventory`, digest fixtures   | Phone production of the declaration bytes: SA-18; catalog columns: SA-13                                             |
| Controller input, task input, worker claim, `process_recording` claim grant, heartbeat, result candidate, job status | Export claim grant v-next: export-release ticket; worker output reservation/plan/seal: worker-output ticket          |
| `recording-source/v1`, `processing-result/v1`, `frame-map/v1`, `hand-observations/v1`                                | Capture-format v1 schemas, Profile/Close/evidence, codec/video/sensor fixtures: SA-50 (`packages/contracts/capture`) |
| Generic capture bridge: `native.capture-{command,snapshot,error,capabilities,recoverable}.v1`                        | Native channel binding and recorder integration: SA-18/SA-51; transfer bridge commands: native uploader tickets      |
| Cross-language adapters (TypeScript, Python, Dart) and shared fixtures                                               | `review/v1`, `release-selection/v1`, `release/v1`, catalog/browser routes: their own tickets                         |

Frame-map v1 deliberately carries no per-row sensor list. Capture `SensorEvent.association_source_frame_id` (SA-50) is the explicit association, joined on the frame map's unique `source_frame_id`; no nearest-time join is defined.

Evidence: [validation/sa-12-contracts.json](validation/sa-12-contracts.json).
