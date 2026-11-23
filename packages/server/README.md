# Server foundation

Server-only configuration, Postgres/storage readiness, migrations, the catalog access layer and guarded Render dispatch. `pnpm --filter @stateaction/server... build` builds its shared dependency first. Native Node tools importing the guarded package need `--conditions=react-server`; ordinary imports intentionally fail.

`make migrate` applies ordered, checksummed migrations: platform marker, Better Auth 1.7.15 tables and the SA-13 catalog. `pnpm --filter @stateaction/server seed` adds deterministic local identities and catalog examples; set `LOCAL_SEED_PASSWORD` (≥ 12 characters) for local sign-in accounts. `make storage-init` creates only the local development bucket. See [catalog design](../../docs/components/catalog.md) for constraints, lock order and privileges.

`pnpm exec nx run server:catalog-integration` runs the real catalog integration tests on a throwaway Postgres with an unprivileged owner and the restricted `stateaction_app` role. Hosted migration invocation and Render role provisioning are SA-14 wiring.

SA-19 adds `src/admission/` (recording registration, inventory seal, the shared eligibility transaction and operator-only pilot permission evidence via `pnpm --filter @stateaction/server ingest-permission`) and migration 004. See [recording admission](../../docs/components/recording-admission.md).
