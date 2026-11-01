# Server foundation

Server-only configuration, Postgres/storage readiness, local migration/bootstrap and guarded Render dispatch. `pnpm --filter @stateaction/server... build` builds its shared dependency first. Native Node tools importing the guarded package need `--conditions=react-server`; ordinary imports intentionally fail.

`make migrate` applies the idempotent platform version marker; `make storage-init` creates only the local development bucket. No auth/recording/job/review tables are implied by this migration. Hosted migrations and the production domain model are later work.
