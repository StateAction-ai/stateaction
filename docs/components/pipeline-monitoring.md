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

Status is classified in one SQL expression from `recordings.status`, the
current job state and `recording_admissions` (shared by list filter and
detail). The recording title is derived from its start time; the catalog has
no recording name.

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
Error text is humanized from `error_code` and a sanitized, truncated
`error_message` (paths, links, UUIDs and long digests removed).

## Actions

- **Review clips** appears only when the current job is `succeeded` with
  accepted clips and links to `/data-browser?recordingId=<UUID>` with no
  `reviewStatus` (SA-37 consumes it).
- **Cancel / check cancellation / Retry / re-upload guidance / reconcile** are
  behind the `JobControlCapabilities` seam. The only provider is
  `noJobControl`, so no such control renders; a future provider's answer is
  discarded unless it names the exact current job and expected state.
  **Lifecycle gate:** these require the Jobs API (SA-27 dispatch/cancel and
  SA-28 result acceptance), which is not implemented; nothing here fakes
  completion or enables a control.

## Validation

`packages/server/test/pipeline-model.test.ts` (pure rules) and
`packages/server/test-integration/pipeline.test.ts` (real PostgreSQL rows as
the app role) cover classification, filters, wildcard search, role guard,
stages, review-link capability and error sanitising. Browser route/keyboard and
viewport evidence run in the guarded web e2e job.

## Bounded local fixture mode (no Docker)

`packages/server/test-auth/postgres.mjs` `startCatalogPostgres()` uses an
already running guarded Postgres when `CATALOG_TEST_ADMIN_URL`,
`CATALOG_TEST_OWNER_URL` and `CATALOG_TEST_APP_URL` are set (roles
`migration_owner` and `stateaction_app` must exist). It creates a uniquely
named database owned by `migration_owner`, returns the same
`{ownerUrl, appUrl, ownerSql, stop}` shape (synchronous `ownerSql`), and
force-drops the database on `stop()`. Without those variables the original
Docker path is unchanged. Run browser evidence with
`agent-resource run -- node apps/web/test-e2e/pipeline-browser.mjs` (receipt and
screenshots in ignored `artifacts/sa34/browser/`).
