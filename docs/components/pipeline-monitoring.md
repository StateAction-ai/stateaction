# Pipeline monitoring and recording details

Updated: 2026-10-31. UI/API implementation target; [offline mock](../mocks/index.html), [execution contract](job-orchestration.md).

## List and entry point

`/pipeline?status=...&q=...` is a staff-only recording status list. Show compact Recording, Collector, Source and Status columns. Wrap long names/errors and use stacked labeled rows on small screens; fields must not require horizontal scrolling to discover. The list has **no action column or buttons**. Clicking a row or its accessible recording-name link opens `/pipeline/[recordingId]`. Preserve the list filters in its Back link. No Scenario selector appears on either Pipeline screen.

## Per-recording page

Show a friendly recording title/breadcrumb, source duration/size, current job state, progress/error and a stage visualization. All actions live here: Review clips, Cancel, check cancellation, Retry, source re-upload recovery or execution reconciliation as allowed by current server capabilities. There is no separate Details/Inspect/Cancel button in list rows. Disable conflicting mutations while a request is unresolved; after any action, refresh this recording's authoritative detail rather than another row.

Review clips opens `/data-browser?recordingId=<uuid>`; showing all generated clips regardless of review status. Review-status filtering is optional and user-selected; a thumbnail opens the shared Rerun clip page. Staff review and select Dataset destinations there. Approval and membership commit together; working Datasets contain approved clips only. The recording's completed-processing state is independent of how many clips still need human review.

## Stages reflect evidence

| Stage | Evidence / display |
| --- | --- |
| Upload | Completed sealed source inventory; otherwise confirmed bytes/parts and pending transfer |
| Queued | Required sources received and processing job admitted or awaiting capacity |
| Processing | Worker claimed; streaming read/decode, hands and review-asset generation share one invocation |
| Quality checks | Worker-reported validation/sealing phase; source hash is established only after reading through EOF, with output integrity/closure checks |
| Ready for review | API accepted terminal execution, sealed outputs and current references, and inserted immutable clips |

These are product progress labels, **not separate workflow tasks**. Hashing/extraction/inference overlap, so do not show “source verified” as a prerequisite to reading the whole source. Render completed, active, failed, cancelled, not started or unknown using text/icons as well as color. Show recorded frame/byte progress when available; do not invent precise stage times, percentages or successful upstream checks from a generic failure. An uncertain submission stays explicitly unknown until reconciled; it never authorizes a second launch.

## Detail API

`GET /api/v1/internal/recordings/:recordingId` returns recording metadata, exact current job ID/revision, bounded stage/progress evidence, actionable error summary, review counts and permitted actions. Derive stages from upload/job state plus a compact latest worker heartbeat/result summary. No new stage ledger, queue or database table is required. Source manifests and immutable artifacts remain authoritative; polling returns metadata only.

Existing cancellation/retry/control operations stay bound to the exact job and expected lifecycle. Reload on a stale current-job reference; do not apply an old screen's action to a newer attempt. Retrying creates a fresh job only after the existing execution is known terminal. Re-upload recovery is instructions for the source owner, not a silently sent message or a retry of corrupt bytes. Reconciliation identifies the original execution before any retry. Normal user authorization and private-response caching rules apply to both the detail API and page.

## Acceptance

Check every seeded recording state, direct/unknown detail URLs, customer denial, list-filter Back behavior and keyboard row links. At 375, 768, 1024 and 1440 px, recording names, status/error text and detail actions must remain readable. Prove row → recording detail → Review clips → recording clip grid → clip review, and ensure cancellation/reconciliation/manual retry retain the existing execution guards. The synthetic visualization is not evidence that live worker telemetry has shipped.
