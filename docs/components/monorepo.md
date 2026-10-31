# Monorepo and build boundaries

Updated: 2026-10-30. Target layout; source migration has not happened. One Git repository contains mobile, web, job control, processing, contracts, infrastructure and documentation. Normal cloning must eventually work without submodules.

## Source layout

| Path | Contents / toolchain |
| --- | --- |
| `apps/mobile/` | Existing Flutter app, including Dart, Android/Kotlin and iOS/Swift projects; Flutter/pub |
| `apps/web/` | Next.js UI, API routes and Better Auth entrypoint; Node.js 24 / TypeScript |
| `apps/jobs/` | Shared Render processing task, future export task, finite repair cron and Local/Modal executor adapters; Node.js / TypeScript |
| `packages/server/` | Server-only domain/auth/access/storage services, database schema and migrations; shared by web/control code where appropriate |
| `packages/contracts/` | Versioned JSON Schemas, API definition and small Dart/TypeScript/Python conformance fixtures; no runtime secrets or server imports |
| `packages/stera_recorder/` | Existing Flutter native recording plugin; mobile keeps its relative path dependency |
| `packages/stera-sdk/` | Imported, attributed SDK source needed for capture/model adapters; reviewed dependency, not the production backend |
| `workers/processing/` | Python extraction, hand-model adapter, clip RRD/thumbnail, QC, future export, CLI and thin Modal entrypoints; uv |
| `infra/` | Local Postgres/MinIO Compose definition, Render Blueprint and build configuration |
| `scripts/`, `tests/`, `docs/` | Existing diagnostics/evidence and cross-component checks; maintain historical receipt paths |

Use **pnpm workspaces for TypeScript packages only**, Flutter/pub for Dart and uv for Python. Pin Node, pnpm, Flutter, Python and dependency versions; commit their applicable lockfiles. Retain required Gradle/CocoaPods locks. One repository does not require one package manager. No new Bun, Nx, Turbo or Melos dependency is needed for the pilot. A small root Makefile exposes documented setup, check and development commands for the three toolchains.

Mobile consumes an HTTP contract, not TypeScript business logic. Python imports model/MCAP libraries, not web code. Only `apps/web` receives the production database/storage authority; job and worker capabilities follow [orchestration](job-orchestration.md).

## Migrate after the recording fixes land

The current root tracks `stera-app` and `stera-sdk` as Git submodules. `stera-app` already contains the Flutter app and recorder plugin, plus a legacy Bun/Hono server. Merely adding a root workspace would leave independently versioned source behind.

1. Coordinate a source-move window with the recording engineer. Record both submodule commit IDs and preserve all committed and uncommitted work before changing Git structure.
2. Import their source into ordinary tracked directories, preserve history where practical and retain upstream license/notices plus an import-commit record. Exclude credentials, captures, APKs, virtual environments, caches and downloaded weights.
3. Move the mobile app and recorder plugin together; update relative paths and native scripts. Preserve app IDs, signing identity, local database migrations, capture IDs and owner-bound upload journals. Re-run the physical-device recording/playback checks.
4. Create the new Node/web/worker packages. The old server is a migration reference; port only reviewed auth/upload behavior. Remove the submodule entries only after the imported source and root clone/build checks pass.

Do not move the active mobile checkout during parallel bug fixing. No such move is performed by this documentation change.

## Independent builds from one commit

Render web, workflow and cron builds run from the **repository root**, with package-specific commands and shared-package build filters. A change to contracts/server code must rebuild its consumers; a mobile-only change need not redeploy the backend. Modal images are built from `workers/processing` plus explicitly included SDK/contracts source. Record the repository commit and image/model digests on each job.

CI checks changed toolchains and shared contracts. Linux runs Node, Python and Android/Flutter checks; iOS signing/builds require a macOS runner. Native release binaries remain separate from Render deployment. [Local end-to-end setup](local-development.md) is the first implementation gate; no cloud GPU is required to pass it.
