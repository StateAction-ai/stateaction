# Clickable MVP interface mock

Open [index.html](index.html) directly in a browser, or run `python3 -m http.server 8765` from this folder and open `http://localhost:8765`. It works offline without installs, CDN or service calls.

**DEMO / synthetic only.** View as simulates staff/customer access; it is not authentication. Refresh resets in-memory edits. The Rerun-looking HTML/SVG stand-in does not load real Rerun, RRDs, private media or inference. No release/export/download function is active. [UI/component decision](../components/ui-design.md).

## Names and navigation

**Dataset** is a named group of **approved Clips**; a **Recording** is the original capture/upload. Each clip is an immutable accepted processed segment and may belong to several datasets. A future **Dataset version** will freeze the whole dataset for release/export. [Naming and routes](../components/data-browser-and-datasets.md).

Sidebar: **Pipeline** (staff only), **Data browser** (both actors), and **Collector app** (separate demo). There is no Clip review, Releases or Deliveries tab. Staff default to the Data browser.

| Route | Behavior |
| --- | --- |
| `#/data-browser` | Dataset list: name, visible Clips count and Total hours; URL `q` searches dataset names |
| `#/data-browser?datasetId=<uuid>` | Approved-member screenshot grid for both roles: title, task label, duration and resolution |
| `#/data-browser?recordingId=<uuid>` | All clips generated from that recording; Review clips sets this filter without an automatic review-status filter |
| `#/data-browser?view=clips` | Staff-only All clips review grid, including accepted unreviewed/unassigned clips |
| Grid `q`, `label`, `reviewStatus`, `recordingId` | URL-persisted search/filter state; All clips supports review status and a fixed recording scope with a link back to its Pipeline details |
| `#/pipeline?status=failed&q=…` | Compact recording list: Recording / Collector / Source / Status; no Actions column or row buttons |
| `#/pipeline/<recordingUuid>` | Staff-only recording detail with all actions, source/status/error information and conceptual processing stages; Back retains filters |
| `#/clips/<uuid>` | One shared Rerun-style clip page; role-specific review/read-only controls |
| `#/collector` | Capture, offline ownership, upload and recovery scenarios |

Seeded dataset IDs (technical test references; not shown in the page):

- Electrical bench repairs: `683a8f18-042b-4c7a-9b15-000000000001` — 2 approved clips for staff and customers initially.
- Terminal and cable work: `683a8f18-042b-4c7a-9b15-000000000002` — shares clips with the first dataset.
- Continuity checks: `683a8f18-042b-4c7a-9b15-000000000003` — staff only.

Shared exact clip route: `#/clips/1fd2b602-2c38-4a62-9c1d-000000000002`. The initially unreviewed/unassigned terminal-screw clip ends `000001`; review it from **All clips**. Customers cannot open it until both approval and a shared-dataset assignment exist. The continuity-check clip ending `000004` is approved but assigned only to a staff dataset. Raw UUIDs/paths are not displayed as product labels.

## Walkthrough

1. As staff, open a dataset row. Search/filter the grid, reload a seeded deep link, and open a thumbnail. The clip's backlink preserves the Data browser/filter context. Switch View as on the clip: its URL stays unchanged.
2. Create a **New dataset**, then **Add clips**. The Add clips picker initially contains the three approved clips; the pending clip is excluded. All clips contains all four accepted processed clips. **Assign to datasets** supports several memberships; membership changes reuse the same immutable clip/media.
3. As customer, only shared datasets and their current approved clips appear. Counts/hours exclude unreviewed/rejected data. Staff-only datasets, edit controls, review mutations, notes and internal QC are absent. Labels use the latest approved review.
4. Staff open a Pipeline recording row and use its detail’s **Review clips**, or use the All clips tab, open a clip, enter its task label, optionally select datasets and approve. Selection alone changes nothing; unsaved choices survive viewer rerenders/reloads, and approval saves review and memberships together. Approval/rejection rebases the form from saved memberships. Notes and assignments are optional. Rejection removes the clip from every dataset; reapproval does not restore old memberships. There is no inspection checkbox, rejection modal, other-clips section or large yellow warning.
5. **Review clips** on the completed recording’s Pipeline detail opens `?recordingId=…` for its completed 2:14 recording (three clips of 52, 48 and 34 seconds). No review-status filter is applied automatically; all generated clips are listed. The clip backlink retains the recording filter; the recording name links back to its Pipeline details, with no clear-filter control. Processing completion and review approval stay distinct.
6. Pipeline filters/status and capture recovery remain separate: unknown submission cannot blindly retry; signed URL renewal keeps progress; expired multipart transport resets progress/full-byte cost; only verified, staff-confirmed cloud copies permit explicit local cleanup.

## Scenarios and checks

There are **31 QA fixtures** across four page types: Pipeline 3, Data browser 4, Clip 7, Collector 17. Pipeline list and recording detail have no Scenario selector: its three fixtures are retained for programmatic QA only. Use the list search/status filter, then open a recording row or its keyboard-accessible name link. All review/recovery buttons belong to that recording’s detail page. Scenario selectors on the other demo pages are prototype controls, not production features. Data browser list/detail and the shared clip page are checked with both actors. Automatic QC covers normal/missing-hand/decode-failed results; customers have no internal QC panel.

The prior approved-Dataset revision checked approval/assignment, rejection cleanup, draft persistence and customer isolation; its [receipt](../validation/approved-dataset-review-20261031.json) is historical. The recording-detail revision below has separate checks. All evidence is for the synthetic mock, not production authentication or inference.

Older files in the [screenshots folder](screenshots/) retain earlier navigation revisions; the links below identify current previews. Production uses a pinned `@rerun-io/web-viewer` client adapter and the real dataset/API authorization contract. [Rerun integration](../components/rerun-clip-review.md).

## Pipeline recording detail revision

All six fixtures have UUID detail routes. The list has four compact columns and no row buttons; at phone width fields stack. Source metadata, stage state, errors and every review/recovery action appear on the recording detail. Unknown recording IDs show not found; customer access is denied.

Stages are conceptual milestones: Upload → Queued → Processing → Quality checks → Ready for review. The processor decodes, estimates hands, writes previews and checks evidence in one pass; source SHA verification completes at EOF. They are not five independently scheduled tasks.

Focused checks passed all six details at **375, 768, 1024 and 1440 px** (24 detail/viewport cases), including visible action controls, list row/keyboard navigation, filter-preserving Back, cancellation/terminal/retry ordering, unknown execution without Retry, source re-upload, recording review queue, not found and customer denial. No page overflow or JavaScript errors were found. Root independently checked 56 recording/list/viewport combinations, 16 navigation/action cases and seven recording-filter follow-up cases. Review clips now uses only `recordingId`, showing all three generated clips; review status can be filtered manually. [Current receipt](../validation/pipeline-recording-details-20261031.json). Older receipts predate this layout.

## Current screenshots and verification

[Compact list at 1024 px](screenshots/20261031-pipeline/pipeline-list-1024.png), [phone list](screenshots/20261031-pipeline/pipeline-list-mobile.png), [processing detail](screenshots/20261031-pipeline/recording-processing.png), [completed detail / Review clips](screenshots/20261031-pipeline/recording-completed.png), [error/recovery detail](screenshots/20261031-pipeline/recording-error.png), [phone detail](screenshots/20261031-pipeline/recording-mobile.png) and [recording clips with Pipeline backlink](screenshots/20261031-pipeline/recording-review-backlink.png) and [phone recording review](screenshots/20261031-pipeline/recording-review-mobile.png).

Root inspected these seven screenshots and the updated processing diagram. Earlier [review/Dataset previews](screenshots/20261031-approved/) and their receipt describe the previous Pipeline navigation. Real Rerun/Next.js, authentication, database transactions/concurrency, storage and live progress telemetry remain implementation gates.

Recording review now keeps its recording scope and replaces the clear-filter button with a recording-name link back to Pipeline details. The link and three-clip round trip were checked at 1440 and 375 px; both updated screenshots were visually inspected. The earlier receipt predates this control change.
