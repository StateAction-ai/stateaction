# Local infrastructure

`make infra-up` starts the isolated `stateaction-local` Compose project. Only loopback Postgres `54329` and S3 `9000` are published. Named volumes survive `make infra-down`; no command here deletes existing user data. Example keys are local-only.

Images are pinned by version and registry digest. Local S3 uses the official Apache-2.0 SeaweedFS image: anonymous pulls of the old official MinIO Docker Hub/Quay images failed, and [upstream MinIO](https://github.com/minio/minio) is archived and unmaintained. [Pin/source receipt](../config/platform-toolchain.json) records this decision. Production R2 is unchanged.

Readiness checks cover the real database migration marker and S3 HeadBucket. `pnpm storage:check` also verifies Put/Get byte integrity and deletes its unique probe object. Multipart finalization, presigned URLs, CORS, R2 semantics and phone-reachable signing endpoints remain separate transport qualification gates. This local Compose setup is not a hosted deployment blueprint.
