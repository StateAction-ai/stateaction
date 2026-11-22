# API, task and artifact schemas

JSON Schema 2020-12 sources for the contracts. See the [package README](../README.md) for encoding rules, digests, error codes and the versioning policy.

- `common.v1.schema.json`: shared definitions (`uuid`, `authUserId`, `sha256`, `fileSizeBytes`, `byteCount`, `int64Decimal`, `timestampNs`, `clockDomain`, `rfc3339Utc`, `raster`, `timeBase`, roles and job states).
- `common.v2.schema.json` (SA-87): additive shared definitions listed in the catalog `shared` key, including `outputFileRole`, an exact superset of the v1 roles, and the stage, GPU, module, frame-span and producer definitions.
- `http/`, `jobs/`, `artifacts/`, `native/`: one file per contract. They are listed in `catalog.v15.json`, the current registry. Each catalog is an exact superset of the immutable, still-published previous one, back to `catalog.v1.json`.
- `modules.json` (SA-87): the stage module manifest (`jobs.module-manifest.v1`). It is append-only per `module_id@version` and is pinned per entry by the policy test rather than by the byte lock.
- `schemas.lock.json`: SHA-256 of every published file. Published files are immutable, and the lock only gains entries.
- `platform-verify.v1.schema.json`: the SA-11 foundation probe. It is unchanged and separate from the v1 catalog.

Capture-format schemas belong to the capture contracts (`../capture/`, SA-50).
