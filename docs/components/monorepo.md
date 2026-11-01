# Monorepo and build boundaries

Updated: 2026-11-01. Existing mobile/native source is imported from Stera revision `8044ad672dbf03cd6db8690f260c145b9acd51ea`; web/jobs/server/contracts and Python package foundations are now implemented. Product auth/upload/processing controllers remain planned. [Foundation runbook](platform-foundations.md). A normal clone contains the Flutter app and recorder without initializing an app submodule. The optional Python SDK submodule remains a historical diagnostic dependency.

## Source layout

| Path | Contents / toolchain |
| --- | --- |
| `apps/mobile/` | Existing Flutter app, including Dart, Android/Kotlin and iOS/Swift projects; Flutter/pub |
| `apps/web/` | Next.js UI, API routes and Better Auth entrypoint; Node.js 24 / TypeScript |
| `apps/jobs/` | Shared Render processing task, future export task, finite repair cron and Local/Modal executor adapters; Node.js / TypeScript |
| `packages/server/` | Server-only domain/auth/access/storage services, database schema and migrations; shared by web/control code where appropriate |
| `packages/contracts/` | Versioned JSON Schemas, API definition and small Dart/TypeScript/Python conformance fixtures; no runtime secrets or server imports |
| `packages/stera_recorder/` | Existing Flutter native recording plugin; mobile keeps its relative path dependency |
| `packages/stera-sdk/` (optional) | Only reviewed, attributed Python helpers/fixtures if actually reused; full SDK is reference-only and not a mobile/backend/runtime requirement |
| `workers/processing/` | Python extraction, hand-model adapter, clip RRD/thumbnail, QC, future export, CLI and thin Modal entrypoints; uv |
| `infra/` | Local Postgres/SeaweedFS Compose definition, Render Blueprint and build configuration |
| `scripts/`, `tests/`, `docs/` | Existing diagnostics/evidence and cross-component checks; maintain historical receipt paths |

Use **pnpm workspaces for TypeScript packages only**, Flutter/pub for Dart and uv for Python. Pin Node, pnpm, Flutter, Python and dependency versions; commit their applicable lockfiles. Retain required Gradle/CocoaPods locks. One repository does not require one package manager. No new Bun, Nx, Turbo or Melos dependency is needed for the pilot. A small root Makefile exposes documented setup, check and development commands for the three toolchains.

Mobile consumes an HTTP contract, not TypeScript business logic. Python imports model/MCAP libraries, not web code. Only `apps/web` receives the production database/storage authority; job and worker capabilities follow [orchestration](job-orchestration.md).

## Existing mobile source import

`apps/mobile` and `packages/stera_recorder` retain our existing Android geometry/orientation fixes, Dart tests, Kotlin/Swift, FFI bindings, platform projects, assets and app lockfile. The relative Flutter plugin dependency is unchanged. [Import provenance/notices](../../third_party/stera-app/IMPORT.md) and [verification receipt](../validation/mobile-source-import.json) record source hashes and checks. Upstream history is retained in the monorepo import; the original local checkout/history is also preserved as an ignored migration reference.

The user clarified that the original checkout is our temporary work; no separate recording-engineer handoff is required. Native camera logic is preserved during this move. The new standalone H.264 harness failed its first physical startup; use the imported recorder as the base for further integration and retain that timestamp case as a regression. Moving source does not qualify H.264 capture.

Subsequent implementation: [opt-in Android H.264](android-h264-implementation.md) extends the imported recorder with local end-to-end simulation. The import receipt remains evidence of the unchanged migration baseline; current capture checks have their own receipt.

The old Bun/Hono server and JS packages are excluded. Only reviewed behavior should enter the new Node/TypeScript backend. Full Python SDK import remains optional; initialize `stera-sdk` only for existing diagnostic scripts. No mobile runtime imports it.

Regenerate `.dart_tool`, Flutter plugin metadata, native local properties and build outputs. Preserve private `.env` locally and bootstrap clean builds from the example/no-auth configuration; never commit credentials or signing files. The import includes a verified Gradle 8.14 wrapper/checksum because the prior local wrapper was ignored by upstream. Android builds/tests run on Linux; iOS source is retained but builds require macOS.

All device operations follow [AGENTS.md](../../AGENTS.md): verified personal profile only, explicit `--user`, no company/work-profile installs or runs, and simulation before requesting user testing. The maintained emulator-only [test script](../../scripts/test_android_capture.sh) uses the imported paths. [Local Android loop](../linux-recording-test-loop.md) distinguishes native codec fixtures from real ARCore/camera qualification.

## Independent builds from one commit

Render web, workflow and cron builds run from the **repository root**, with package-specific commands and shared-package build filters. A change to contracts/server code must rebuild its consumers; a mobile-only change need not redeploy the backend. Modal images include `workers/processing`, contracts and only explicitly reviewed helper dependencies. Keep historical SDK/Rerun 0.22 diagnostics in an isolated optional environment; do not import compatibility monkeypatches into the 0.41 worker. Record repository/image/model digests on each job. [Mobile implementation](mobile-app-implementation.md) owns the Flutter/native bridge and [capture format](capture-format.md) owns the generated video descriptors and schemas.

CI checks changed toolchains and shared contracts. Linux runs Node, Python and Android/Flutter checks; iOS signing/builds require a macOS runner. Native release binaries remain separate from Render deployment. [Local end-to-end setup](local-development.md) is the first implementation gate; no cloud GPU is required to pass it.
