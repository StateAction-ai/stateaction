# API, task and artifact schemas

JSON Schema 2020-12 sources for the contracts. See the [package README](../README.md) for encoding rules, digests, error codes and the versioning policy.

- `common.v1.schema.json`: shared definitions (`uuid`, `authUserId`, `sha256`, `fileSizeBytes`, `byteCount`, `int64Decimal`, `timestampNs`, `clockDomain`, `rfc3339Utc`, `raster`, `timeBase`, roles and job states).
- `http/`, `jobs/`, `artifacts/`, `native/`: one file per contract. They are listed in `catalog.v5.json`, the current registry. It is an exact superset of the immutable, still-published `catalog.v4.json`, itself an exact superset of `catalog.v3.json`, `catalog.v2.json` and `catalog.v1.json`.
- `schemas.lock.json`: SHA-256 of every published file. Published files are immutable, and the lock only gains entries.
- `platform-verify.v1.schema.json`: the SA-11 foundation probe. It is unchanged and separate from the v1 catalog.

Capture-format schemas belong to the capture contracts (`../capture/`, SA-50).
