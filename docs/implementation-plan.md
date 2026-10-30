# MVP implementation milestones

Updated: 2026-10-30. Target: [technical design](technical-design.md). All paths/commands are implementation targets, not newly shipped services. Automatic 21-point hand inference and both review/delivery interfaces are required.

## Build sequence

| Milestone | Deliverable | Exit evidence |
| --- | --- | --- |
| M0. Monorepo and contracts | Coordinate the active mobile fixes; import Flutter/native plugin/SDK into one root repository. Pin Node/pnpm, Flutter and Python/uv; add local Postgres/MinIO configuration, official Render local task server and shared schemas. | Clean clone without submodules; Flutter/native regression checks; Node/Python builds and Dart/TypeScript/Python contract fixtures |
| M1. Local login and upload | Next.js UI/API, Better Auth, manual allowlist with pilot collection/processing permission evidence, owner-bound mobile journals, direct resumable multipart transfer and sealed file inventory. | Real-device login/expiry/account-switch tests; killed app/expired URL/lost completion resumes without changing ownership or duplicating a recording |
| M2. Local complete processor | The same Render workflow task definitions invoke LocalExecutor to run the shared streaming extractor, mandatory MediaPipe CPU hand inference, RGB/overlay previews, pose arrays, masks/frame mappings and inline checks. Jobs, controller recovery and output uploads follow the production control contract. | Short real MCAP through upload → processing → review; corrupt input/missing hand/stale callback failures; bounded memory and scratch on a representative two-hour input |
| M3. Local review and delivery | Staff view overlays/QC, label/approve clips, freeze a release and run the same CPU exporter. Customer sees only granted published releases and downloads the entire archive/manifest. | Collector → automatic hands → staff approval → customer download; hashes/loader pass, unauthorized access fails, previous release stays unchanged after corrections |
| M4. Small cloud CPU canary | Render web/Postgres/Workflows/minute repair cron, private R2, Modal CPU wrapper over the same processing core, native Google sign-in configuration. | Known/unknown submission recovery, duplicate physical worker claim, cancel/timeout, output write closure, direct transfer, backup restore and measured gross cost |
| M5. Field pilot | Signed mobile build, confirmed collection/processing/export permissions and retention policy; repair-footage hand-quality review; representative two-hour upload/cloud processing and complete delivery. | Recorded device/build/model/image/input versions, latency/resources/bytes/cost, reviewer decisions and customer loader receipt |
| Later, if needed | Optional local CUDA model profile, then explicit cloud GPU qualification. Curator/Lance only after workload measurements justify another system. | Cleared weights/dependencies; stable 21-joint semantics, quality comparison, peak VRAM/throughput and authorized cloud cost cap |

M2 and M3 must pass without cloud GPU access. Stub models are useful for protocol tests but never substitute for real hand inference in the end-to-end acceptance run. An optional local GPU uses the same processor contract; it does not replace the CPU pipeline with a different product.

## Minimum acceptance cases

| Inject | Required outcome |
| --- | --- |
| Logout, expired session or account switch mid-upload | Original owner's files/journal retained; new user cannot claim them |
| Lost part/complete response, required sidecar/seal race | Same logical upload reconciles; one queued job only when all required sources are complete |
| Corrupt MCAP, unsupported clock/raster or oversized input | Explicit failure/limitation; no silent sensor reassociation or GPU escalation |
| Lost spawn acknowledgement or dispatcher crash | Existing claim/call ID reconciled; no blind spawn or automatic costly retry |
| Container replay, late old-job result or cancelled job | One admitted worker; stale result cannot replace the current job |
| Write after output seal | Denied; published bytes cannot be reopened through an old worker upload capability |
| Occlusion, gloves, missing hand or ambiguous handedness | Visible missingness/limitations; no fabricated valid joints or validated metric claim |
| Concurrent review or changed approved labels | Conflict or a new explicit review/release; no overwritten published selection |
| Interrupted archive transfer, expired link or revoked user | Range download works while authorized; renewed links require live grants; documented resume limits |
| Database restore | Reconcile external jobs/uploads and reapply revocations before resuming new work |

Use synthetic data/fake providers for faults, short real MCAP for the full local flow, then a representative long capture. Reuse meaningful existing capture/geometry tests. Record the same input/model/config versions across local and cloud comparisons. Do not repeat expensive model runs when a contract fixture answers the question.

## Ownership

[Monorepo](components/monorepo.md) defines the exact target paths. Mobile owns capture/auth/journal transport; backend owns access/catalog/uploads/jobs/reviews/releases; robotics owns streaming extraction, model outputs and exporter; platform owns shared workflow definitions, executor adapters, local services, Render/Modal configuration and recovery. No second API, identity authority or catalog is needed.

The [contract](contracts.md), [component index](README.md) and [local development plan](components/local-development.md) are the implementation entrypoints. No source relocation, production deployment or paid processing is performed by this planning change.
