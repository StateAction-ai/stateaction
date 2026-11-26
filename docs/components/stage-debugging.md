# Stage debugging, dev seed and replay (SA-96)

For engineers working on recipe stages (segment, caption, hand*pose). Everything here is local, uses stub or replay modules and spends nothing. A stub or replay stage is never a live model run: replayed output carries `module_id=replay*\*` and the original FLORA run record in provenance.

## Where stage artifacts live

- **Server rows:** `job_stage_runs` (state, module, `error_code`, call id), `job_stage_claims`, `job_stage_evidence`. Read them as `GET /internal/v1/jobs/{id}/dag-run` (workflow credential) or inspect the stage attempts in Recordings and clip Processing.
- **Stage outputs:** `segments.json`, `captions.json` and `diagnostics/<stage>/*` are job output files with a slot (`job_output_slots`). `GET /internal/v1/jobs/{id}/prior-stages` lists them for segment and caption.
- **Controller journals (this host):** `$JOBS_STATE_DIR/<jobId>/<stage>/{journal.json|modal-journal.json,child.log}`. The bootstrap token file is deleted once handed to the child.

## Stage diagnostics in Recordings

Open a recording at `/recordings/<recordingId>` for clip planning, or follow its clip link to `/recordings/<recordingId>/clips/<clipId>/processing` for recipe stages. Expand a stage attempt to see its details. Each stage attempt lists its completed `diagnostics/<stage>/<name>` files (role `diagnostic_blob`, e.g. `log.txt`) by file name. Clicking one calls `POST /api/v1/jobs/{jobId}/diagnostics/{fileId}/read` (staff session, same mutation checks as the other staff POSTs; customers, collectors, outsiders and no session are refused as on the dag-run route). The route signs one GET for that single object key, valid 60 s (the dataset read maximum), `Cache-Control: no-store`, content type `text/plain`, files over 64 MiB refused. The file must belong to that job, be a completed or verified `output` with role `diagnostic_blob` and a `diagnostics/` slot; any other id answers 404 without revealing whether it exists. The URL is returned only to the caller: it is not in the page HTML, not logged and not stored. The stage receipt row still shows only the receipt digest, since the run document records nothing else about it.

## Reading a `submit_unknown` row

The controller journaled `spawning` (or lost the answer) and cannot prove whether the stage child exists. It never respawns. Check `journals/<stage>.json` in a bundle: `phase: spawning` without a `pid` means the child may or may not exist; a `pid` means look at `termination`. The job is marked for the operator; re-entry adopts the recorded call, it never starts a second one.

## Bundle a job

```
export STATEACTION_API_URL=<origin> CONTROLLER_CAPABILITY_FILE=<workflow token file> JOBS_STATE_DIR=<state dir>
pnpm --filter @stateaction/jobs build
pnpm --filter @stateaction/jobs diag -- --job <jobId> --out job.tgz [--cache-dir <seed cache>]
```

The `.tgz` holds the job status, recipe, `dag-run`, the output listing, per-stage journals (rebuilt field by field from the strict journal validator; an invalid journal is reported `unreadable`, never copied) and, per stage, the `sa_metrics` lines and the stage receipt if it validates. Raw child logs and token files are never included. With `--cache-dir`, `diagnostic_blob` files are included as scrubbed text (capabilities, bearer values, signed URLs removed, 256 KiB per file, 8 MiB per bundle). It goes through the SA-45 allowlist readers (`packages/server/src/ops/redact.ts`, `bounded-read.ts`); no recording pixels are read.

## Replay a failed stage from cache

```
pnpm --filter @stateaction/jobs replay-stage -- --job <jobId> --stage caption \
  [--module stub_captioner|replay_captioner] --io-dir /tmp/io [--cache-dir <seed cache>]
```

It reads the recipe from the jobs API, the cached inputs of the job (`source.mcap`, `task-input.json` and, for caption, `outputs/segments.json`) from `<cache>/<jobId>/`, writes the file-backed bootstrap into `--io-dir` and runs `run-stage --io-dir` (APP*ENV=local, no claim, no server write). Outputs, `receipt.json`, `heartbeats.jsonl` and `log.txt` land in `--io-dir`. Only `segment` and `caption` replay. A `flora*\*`module is refused without`--allow-spend`, and even with it only the Modal harness may run it, never this command. The cache is the dev-stack seed cache (below); staff-credential download of a production job's inputs is not implemented.

## Seed a dev stack for UI work

```
pnpm --filter @stateaction/web build && pnpm --filter @stateaction/jobs build
agent-resource run -- node apps/web/test-e2e/serve-console.mjs --seed failure-fixtures
```

Needs the processing venv and the Render CLI (`RENDER_CLI`, `PYTHON_EXECUTABLE` override the defaults). It starts the real stack with storage, uploads simulated recordings through the SA-71 path (a generated test pattern, never a real recording), runs each through the real local controller and prints one JSON line with the origin, users, `recordings` (scenario, recording id, job id, job state, stage rows), the cache and state directories and the workflow token file.

| scenario          | stages                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ok`              | stub segments, stub captions, hand_pose                                                                                                                                        |
| `caption_failed`  | `fail_captions` on two captions (failed rows inside a succeeded caption stage)                                                                                                 |
| `segment_failed`  | segment fails (no receipt), caption `not_run` (`upstream_failed`)                                                                                                              |
| `running`         | segment `hang` stopped at its 20 s budget (`budget_exceeded`)                                                                                                                  |
| `replay_homer_33` | replayed FLORA output (segment, caption, hand_pose succeeded); only when `artifacts/fixtures/flora-homer` passes `fixture_store.py verify`, otherwise reported under `skipped` |
| `replay_homer_37` | the cached FLORA segments overlap and the adapter refuses them: segment `failed (replay_segment_overlap_unresolvable)`, caption `not_run`, hand_pose succeeded                 |

The seed asserts each scenario's expected job and stage states (`expect` in `seed-scenarios.mjs`) and exits non-zero otherwise. There is no retry: a scenario that does not end in its expected states on the first attempt fails the seed. It refuses a non-local `APP_ENV`, a Render deployment, any `flora_*` or GPU recipe.

### Local recipe override

`STATEACTION_LOCAL_RECIPE_DIR` (absolute) holds one `<recording-id>.json` recipe per recording; admission reads it and writes the v3 task input with that recipe. It is accepted only with `APP_ENV=local` and no Render markers. In every other environment `jobsConfigFromEnv` throws, so `hosted:preflight` refuses to start. A malformed file rejects only that job at admission (`task_input_invalid`); a recording without a file keeps the v2 input.
