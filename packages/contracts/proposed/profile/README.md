# Proposed profile contracts (SA-16): not published

`PATCH /api/v1/me/profile` is served today by `packages/server/src/auth/profile.ts`. These files describe its wire format ahead of publication. They are **not** in any catalog, `schemas.lock.json` or the Python/Dart/TypeScript registries, so no client may depend on them yet.

- `http/profile-update.v1.schema.json` (`http.profile-update.v1`): request `{ "name": string }`, closed. It states the wire bound only (1-1013 code points, body at most 1024 bytes). The service NFC-normalizes and trims, then requires 1-80 code points without control, bidi, zero-width or separator characters. Identity, email and roles are never accepted.
- `http/profile.v1.schema.json` (`http.profile.v1`): success `data` inside `http.success-envelope.v1`: `{ "user": { "id", "email", "name" } }`. `name` is the stored, normalized value (1-80 code points, no forbidden characters, no leading or trailing whitespace). NFC is guaranteed by the service and not expressible in JSON Schema. Failures use the existing `http.error-envelope.v1` (`invalid_request`, `forbidden`, `unauthenticated`, `rate_limited`, `provider_unavailable`).
- `fixtures/` use the shared conformance format and are authored by `generate_fixtures.py` (`--check` proves they are reproducible).

Evidence: `test/proposed-profile.test.ts` (Ajv, same options as the registry, plus a deterministic 20 000-string differential check against `parseDisplayName`) and the real-stack cases in `apps/web/test-e2e/console.e2e.test.mjs`. The fixtures were also run through the Python (`jsonschema` with the registry's ECMA pattern shim) and Dart (`json_schema`, `ContractRegistry`) validators with identical results, including astral code points at the 80/81 boundary.

## Publication plan

Only after SA-19's `catalog.v3` is merged: move the schemas into `api/http/`, the fixtures into `conformance/fixtures/contracts/`, and add `catalog.v4.json` as an exact superset of v3 (v1, v2 and v3 bytes, locks and fixtures stay untouched), append the new lock entries, and switch the three registries to v4. Until then nothing here changes a published byte.
