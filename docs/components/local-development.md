# Local development and end-to-end qualification

Selected MVP design · 2026-10-31 · Commands/packages below are planned targets, not shipped tooling

**Use Render's official local workflow runner with the same Node processing task definition (and follow-up export definition) as production.** Locally they execute the shared Python processor through `LocalExecutor`; in cloud they select `ModalExecutor`. Begin with real MediaPipe CPU, then optionally test a small cleared model on the local GPU. No cloud GPU is required for initial testing.

## Monorepo and runtime

| Target | Responsibility |
| --- | --- |
| `apps/web` / `@repair/web` | Next.js UI, Better Auth and mobile/worker/control API |
| `apps/jobs` / `@repair/jobs` | Registered `process-recording` Render task, future `export-release`; finite reconciliation entrypoint |
| `apps/mobile` | Existing Flutter application; native device builds |
| `packages/server`, `packages/contracts` | Shared server/domain modules and versioned cross-language contracts |
| `packages/stera_recorder`, `packages/stera-sdk` | Existing recorder and SDK source, retaining Dart/Python package boundaries |
| `workers/processing` | Shared Python processing/export core, CLI and Modal wrapper; CPU/optional local-CUDA profiles |
| `infra/compose.yaml`, `infra/render.yaml` | Local Postgres/MinIO versus production services |

Use pnpm for TypeScript, Flutter/pub for Dart and uv for Python; no extra monorepo orchestrator is required. A single repository does not imply hosting Flutter on Render. Keep service credentials and server dependencies out of browser/mobile packages.

## Start the real local workflow runtime

Render documents CLI **2.12.0+** for local workflows; pin a current compatible CLI during implementation. It starts task processes on the host, which permits Node controllers to launch the local Python worker. Docker-based workflow projects do not currently support this local server, so use the native Node workflow runtime. [Official local-development guide](https://render.com/docs/workflows-local-development)

Proposed setup, after dependencies/scripts/fixtures exist:

```sh
docker compose -f infra/compose.yaml up -d
pnpm install --frozen-lockfile
uv sync --project workers/processing --locked
pnpm --filter @repair/web dev
```

In another terminal:

```sh
render workflows dev --env-file .env.workflows.local -- pnpm --filter @repair/jobs dev
```

`@repair/jobs dev` imports the implemented task definitions using the local TypeScript entrypoint; it is not another polling daemon or nested watch process. The production start script executes the compiled version of that same entrypoint. Register tasks synchronously and open provider clients only inside handlers.

Configure the web dispatch client in `apps/web/.env.local` and the task runtime in `.env.workflows.local` consistently; keep these private files ignored:

```dotenv
RENDER_USE_LOCAL_DEV=true
RENDER_LOCAL_DEV_URL=http://localhost:8120
EXECUTION_BACKEND=local
```

The official server defaults to **8120**; use `--port` plus the corresponding URL for another port. SDK 1.6.0 can construct `new Render()` without a cloud token in local mode. Set the local process/export task references to their registered names; cloud references name the deployed workflow/task version. Production rejects local endpoints and `EXECUTION_BACKEND=local`. Cloud Render credentials stay in the API, Modal credentials in the Workflow runtime, and the finite cron has only its reconciliation API credential; none is needed for fully local execution.

Check registration and optionally trigger a pre-created authorized job:

```sh
render workflows tasks list --local
render workflows start process-recording --local --input-file=job-input.json
```

`job-input.json` contains the positional array, for example `[{"jobId":"an-existing-local-job-id"}]`; the API/database still authorize it. Normal end-to-end runs start through the application's upload flow (and follow-up Dataset-version flow). Use `pnpm --filter @repair/jobs tick` to invoke the same finite reconciliation pass as production when testing dispatch/recovery failures. Every manual Render task command must keep `--local`. [Current CLI reference](https://render.com/docs/cli-reference)

The local task server reloads definitions and holds logs/results in memory; restarting loses that history and regenerates local IDs. It does not supply durable Postgres state, R2 semantics, Modal scheduling/preemption or cloud billing. Persist jobs/results through our real APIs and test recovery against Postgres. Do not infer worker termination from the disappearance of a local task.

## Shared worker and executor contract

`EXECUTION_BACKEND` chooses `LocalExecutor` or `ModalExecutor` inside the same Render task code; freeze the selected backend/profile on the job. Keep worker task/result schemas, job claims, source access, output allocation/upload/finalization, inline QC and candidate reporting identical. Controllers load authoritative state through the control API and never treat local task-server memory as the catalog.

`LocalExecutor` invokes the CLI in `workers/processing`, importing the same Python functions as the Modal wrapper. Use argv plus `shell: false`; pass bootstrap/input through stdin or a mode-0600 file, never a logged command line. Generate a job-specific execution ID before launch and a fresh nonce inside every physical worker execution. Store private local logs/results in ignored job directories; atomically write result JSON.

An eight-hour controller normally retains its child handle through the six-hour processing/one-hour export budget. There are no arbitrary hourly continuations or detached supervisor service. If the local task/host crashes, the child may survive or be killed. A saved PID can also be reused: do not adopt, respawn or kill based on PID alone. Mark interrupted local executions `needs_attention`; inspect job/host/process-start identity, confirm termination and manually retry with a new job/prefix. An atomic result file or expired heartbeat alone does not prove termination.

Modal workers report their actual `modal.current_function_call_id()` on claim; local workers report local execution identity instead. A surviving known Modal call can be polled by a controller retry. That capability does not justify pretending a lost local child handle is recoverable. Test these differences explicitly. [Execution/recovery contract](job-orchestration.md)

## Storage, auth and physical phones

Apply local migrations and seed separate collector/staff/customer identities, accepted pending/rejected/approved clips, approved-only dataset memberships and operator-managed view grants. Keep local database volumes, MinIO keys and datasets separate from staging/production. MinIO uses the same API reserve/sign/parts/complete protocol, including one-part multipart for small files; never bypass it with direct filesystem output. Local success still needs a small real-R2 transport canary.

A phone's `localhost` is the phone. Host services normally use API port `3000` and MinIO `9000`; containers use their Compose service names; an Android emulator can use a qualified host alias such as `10.0.2.2`; physical devices need the development machine's reachable LAN hostname/IP. Bind only the intended development interfaces/firewall rules. The workflow task server remains host-local; phones call the web API, not port 8120.

Configure API/callback origins and S3 signing/public endpoints explicitly. Sign MinIO URLs against a phone-reachable address from the outset: rewriting a signed URL's hostname invalidates its signature. Storage CORS permits the selected UI origin/methods and ETag exposure. Callers never choose provider endpoints, buckets or keys.

Use isolated seeded/test identities for deterministic tests; any test-login adapter must be development-only. Google/OAuth redirects, app signing fingerprints and secure-cookie behavior require real-device testing with a registered HTTPS development origin. Local HTTP/debug CA allowances do not qualify production cookies/TLS and must not enter release builds. [Auth contract](auth-and-access.md)

## Test ladder before paid processing

| Step | Execution | Evidence |
| --- | --- | --- |
| 1. Fixture smoke | Official local Render runner + fixture worker; no learned model | Login/grants, source/output multipart, Pipeline → recording detail → recording clip grid → shared viewer, approve-and-assign transaction, approved-only membership and customer All clips denial; clearly synthetic outputs |
| 2. Real CPU | Same runner/task + MediaPipe CPU on a short MCAP | Actual 21-point inference, bounded RRD/thumbnail generation, real embedded Rerun playback/frame mapping, 3D-estimate labels, masks, hashes, QC and loader round trip |
| 3. Local size/failures | Same CPU path, progressively longer captures including representative two-hour size | Bounded RAM/disk, source read counts, elapsed time, cancellation, corrupt source, task-runner loss, uncertain launch and manual retry |
| 4. Optional local CUDA | Same contracts plus an explicit small cleared profile on the available local GPU | CUDA visibility, memory/resource limits and schema/mask behavior; substitute-model results do not qualify another model's quality or memory |
| 5. Small staging CPU | Same processing task definition on Render + R2 + Modal CPU | Real origins/auth/private routing, workflow/worker claim recovery, R2 closeout, measured time/bytes/cost |
| 6. Qualified cloud scale/GPU | Only a separately approved need/run | Representative cloud limits/cost; GPU only after actual model/image/rights/quality fit, with no automatic upgrade |

MediaPipe CPU already supplies the required landmark/estimate product. Pin the exact small model asset/hash and environment from [processing](cloud-processing.md). A successful end-to-end test does not establish metric/anatomical accuracy.

Inject duplicate task/worker claims, lost Render/Modal acknowledgements, native controller retry, late starts, stale callbacks, incomplete/uncertain uploads and access revocation. Include transactional review/membership fixtures below; an HTML mock cannot prove database races. For the follow-up Dataset-version flow, read the complete release archive through the real loader and verify checksums. Before cloud deployment, only environment/provider configuration and packaging should change; business handlers and contracts remain the tested ones. Local success still does not emulate provider failure modes.

## Real Rerun and Data browser gate

The HTML mock does not qualify Rerun. Build the production Next.js bundle with matched 0.22.1 viewer/SDK, self-hosted JavaScript/WASM and a real worker-generated bounded RRD. Confirm MIME/import paths, private MinIO/R2 CORS and loading on supported desktop/mobile browsers; measure frame fidelity, startup, peak memory and bytes. Test missing-hand clearing, quiet 3D-estimate labels, expired URL reload retaining staff edits and viewer cleanup on route changes. No live Rerun server or external hosted iframe is required. [Viewer integration](rerun-clip-review.md)

Prove `/data-browser` defaults to the dataset list and `?datasetId=...` opens its approved-only grid for either role. Staff may explicitly use `?view=clips` for all accepted clips, including pending/rejected/unassigned ones. A Pipeline row opens `/pipeline/[recordingId]` with the stage visualization and all actions; its **Review clips** action opens `/data-browser?recordingId=<UUID>`, then a card opens the same `/clips/[clipId]` page. There is no separate Review sidebar item. Pipeline has status/search filters, no scenario selector; `/pipeline?status=failed` remains staff-only. Preserve URL state on refresh/paste/Back/Forward.

Test the real review API/database, not just mock controls:

| Case | Required evidence |
| --- | --- |
| Approve and assign | A nonblank task label, current review revision and affected dataset revisions commit one review decision plus the optional selected memberships. Empty selection leaves an approved unassigned clip. |
| Blank/stale/failed command | Blank approval label, stale review/dataset revision or assignment failure rolls back the whole operation, including decision, memberships and revision bumps. |
| Membership picker/direct mutation | Only latest-approved clips are offered or accepted; forged pending/rejected clip IDs fail for staff as well as customers. |
| Reject/withdraw | One transaction removes all working dataset memberships, increments affected dataset revisions and records the decision; unrelated clips remain unchanged. |
| Reapprove and concurrent writes | No automatic membership restoration. Racing approval/add against rejection cannot leave an unapproved dataset member or partially assigned approval. |
| Shared identity/counts | One approved clip in two datasets has one immutable artifact set; counts/hours use distinct approved authorized members. |
| Customer scope | Customer All clips/recording-wide routes are forbidden; current grant/membership/latest approval gates metadata, thumbnails and every fresh viewer URL. Revocation/removal/withdrawal denies new access. |

Keep staff QC/notes out of customer payloads. A known clip ID is not authority. Test recipient permission when granting or changing shared membership. No release page or exporter is required to pass this initial internal/external review gate; frozen dataset versions remain separate follow-up work.
