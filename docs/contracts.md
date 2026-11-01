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

| Implemented here                                                                                      | Owned elsewhere / deferred                                                                   |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Envelopes; recording create/seal/response; upload create/plan, part sign/signed/receipts, transitions | Route handlers, persistence and provider calls: SA-13/SA-14 and upload tickets               |
| Controller input, task input, worker claim, claim grant, heartbeat, result candidate, job status      | Workflow/executor implementation                                                             |
| `recording-source/v1`, `processing-result/v1`, `frame-map/v1`, `hand-observations/v1`                 | Capture-format v1 schemas, codec/video/sensor fixtures: SA-50 (`packages/contracts/capture`) |
| Cross-language adapters (TypeScript, Python, Dart) and shared fixtures                                | `review/v1`, `release-selection/v1`, `release/v1`, catalog/browser routes: their own tickets |

Evidence: [validation/sa-12-contracts.json](validation/sa-12-contracts.json).
