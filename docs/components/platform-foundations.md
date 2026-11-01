# Platform foundations

Implemented 2026-11-01 for SA-11. This is the reproducible local starting point for the planned product. [Exact versions and sources](../../config/platform-toolchain.json) · [Setup commands](../../scripts/platform/README.md) · [Validation receipt](../validation/platform-foundations.json).

## Working path

`make web` runs Next.js on loopback; `make workflows` starts Render's **official** local workflow server and our Node task process. `make smoke` checks the real database/storage and submits `verify-platform` through the Next API. Render invokes `LocalExecutor`, which runs the installed Python health command with a validated request ID. The smoke checks that same ID in the actual task result. This is a runtime probe; production `process-recording` is not registered yet.

| Component | Implemented boundary |
| --- | --- |
| `apps/web` | Next.js build, `/api/v1/health`, guarded development dispatch; no product login or review UI |
| `packages/server` | Server-only database/storage clients, bootstrap migration and local environment checks |
| `packages/contracts` | Strict probe request/result JSON Schema and TypeScript parsers; existing capture schemas preserved |
| `apps/jobs` | Render SDK task registration and a bounded Python subprocess; no shell or inherited provider secrets |
| `workers/processing` | Installable Python CLI, health protocol and optional CPU compatibility adapter |
| `infra/compose.yaml` | Private local Postgres and S3-compatible SeaweedFS, digest-pinned images and separate persistent volumes |

The development dispatch route requires an explicit local environment, a loopback workflow endpoint and a random bearer token. It is disabled in production. This token is a development harness credential; Better Auth and role enforcement remain future work. Database/storage credentials stay in the web process. The workflow environment has only local execution settings.

## Local storage choice

Use **SeaweedFS 4.51** for local S3 development. Official MinIO pinned images were unavailable during setup and its upstream repository is archived; the chosen official SeaweedFS image has an [Apache-2.0 license](https://github.com/seaweedfs/seaweedfs/blob/4.51/LICENSE). Production storage remains private R2. This substitution changes no production provider decision. [Pinned provenance](../../config/platform-toolchain.json)

Postgres listens on `127.0.0.1:54329`; S3 listens on `127.0.0.1:9000`. The test runner uses a separate Compose project and unused ports. It cleans up its own services and preserves named volumes. Do not expose the development credentials publicly. The successful S3 probe writes, reads and deletes a small object; multipart, signing, CORS and real-R2 behavior still require their own tests.

## Verification and next increment

A source-only checkout passed locked installs, independent builds/typechecks, eight Node tests, four Python tests, strict mypy, formatting and the real official-runner smoke using fresh Postgres/storage volumes. The built Python wheel was installed and executed separately. The GitHub workflow is checked in and passes actionlint; **a hosted CI run is still pending publication**.

The optional CPU adapter packages a hash-verified frozen copy of the proven interoperability spike, including its notices and descriptor. It supports explicit local file input and produces CPU hand landmarks, clips and RRDs. It retains the spike's resource/accuracy limits. It is not wired into a production Render task, storage capability protocol or Modal deployment. [Worker commands](../../workers/processing/README.md)

Next implement auth/roles and capture ownership, source registration and direct resumable upload, then the durable `process-recording` controller and worker capability protocol. Extend the same official local runner to exercise those real handlers. Review UI, cloud deployment and GPU spending are separate gates in the [implementation plan](../implementation-plan.md).
