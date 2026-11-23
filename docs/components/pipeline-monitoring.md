# Pipeline monitoring and recording details (SA-34 read increment)

Staff-only `/pipeline` list and `/pipeline/[recordingId]` detail, rendered on
the server from real catalog rows. No new HTTP schema, JSON DTO or table: the
pages call the read functions in `packages/server/src/pipeline` (exported as
`@stateaction/server/pipeline`) through the restricted application-role pool.
Design source: the approved mocks in the archive tag
(`docs/mocks/screenshots/20261031-pipeline`) and the Stage model below.

## Access

Both pages call `requireConsoleSession(["staff"])` (Better Auth session plus
the enabled `access` row). A customer, collector, pending/disabled or signed-in
non-staff request gets 404; signed-out requests redirect to `/login`. Every
query also re-checks the enabled `staff` access row in SQL for the caller, so a
direct call without the page guard returns nothing. Malformed `recordingId`
values 404 before any query.

## List

`/pipeline?q=&status=&page=` — four columns: Recording, Collector, Source,
Status. No action column, Scenario selector, UUID or path text. The whole row
and its name link open the detail and carry the validated filters so Back
returns to the same list. Search is bounded (80 chars, LIKE wildcards escaped)
and matches the collector display name and the recording start label; status
is one of `uploading, queued, processing, needs_attention, failed, cancelled,
completed`; pages hold 25 rows (limit+1 lookahead, page ≤ 200). Collector is
the display name only (no email or owner id).

The list and detail share a status calculation based on `recordings.status`,
admission and the job named by `recordings.current_job_id`. A recording marked
processing or reviewable without a current job needs staff attention. The
recording title comes from its start time.

## Detail and stages

Upload → Queued → Processing → Quality checks → Ready for review are display
stages, not workflow tasks. Each is `done | in progress | failed | cancelled |
unknown | not started | blocked`, rendered as text plus icon. Only recorded
evidence is used: sealed source inventory, confirmed upload bytes, job state,
whether the job was submitted, admission rejection and accepted clip count.
No worker heartbeat is stored, so Quality checks is _unknown_ while a job runs
or after a failure, and Duration and Source hash show _Unknown/Not reported_
(the hash only completes at end of source). A failed job marks Processing
failed with "the stage is not recorded"; an uncertain submission stays unknown.
Staff see curated explanations for recognized error codes and a generic
message for unknown codes. The read query leaves worker error text in storage.

### Recipe stages (SA-97)

When the job has a recipe, the stage card lists one row per recipe stage from
`job_stage_runs` (via the same document as `GET /api/v1/jobs/{jobId}/dag-run`):
module, state, duration, cost estimate, GPU requested/observed/VRAM/rate,
output counts (failed counts shown as failed), error code, `not_run` reasons and
the stage receipt digest, plus the `dag-run.json` panel with Copy and Download.
A job without a recipe keeps the five derived stages. The list adds segment,
caption and team-check counts (team checks count segments with a team mark, see [Segment marks](segment-marks.md); an em dash means none) and a
Review column that says review is not available yet once annotations are
accepted (no link until the SA-98 route exists).

## Actions

- **Review clips** appears only when the current job is `succeeded` with
  accepted clips and links to `/data-browser?recordingId=<UUID>` with no
  `reviewStatus` (SA-37 consumes it).
- **Cancel / check cancellation / Retry / re-upload guidance / reconcile** come
  from the `JobControlCapabilities` seam. The Pipeline reads now inject SA-27's
  `jobControlCapabilities`, which answers from live rows and advertises a
  control only if its authenticated mutation (`POST /api/v1/jobs/{jobId}/control`)
  is wired; an answer is discarded unless it names the exact current job and
  expected state. Cancel is a request (not a stop); Retry appears only after
  exact termination evidence; a failed source hash shows corrected-source
  guidance instead of a retry. See [job orchestration](job-orchestration.md).

## Validation

`packages/server/test/pipeline-model.test.ts` (pure rules) and
`packages/server/test-integration/pipeline.test.ts` (real PostgreSQL rows as
the app role) cover classification, filters, wildcard search, role guard,
stages, review-link capability, stale jobs and curated errors. Browser route/keyboard and
viewport evidence run in the guarded web e2e job.

## Bounded local fixture mode (no Docker)

Use the guarded PostgreSQL and object storage services described in [Local CI](../local-ci.md).
Set `STATEACTION_LOCAL_FIXTURES` to the managed fixture environment file. The
harness creates a run-owned database and bucket and removes them on teardown.
The browser check writes its receipt and screenshots to ignored
`artifacts/sa34/browser/`.

```sh
STATEACTION_LOCAL_FIXTURES=/path/to/fixtures.env \
  agent-resource run -- node apps/web/test-e2e/pipeline-browser.mjs
```
