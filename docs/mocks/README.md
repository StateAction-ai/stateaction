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
| `#/data-browser?view=clips` | Staff-only All clips review grid, including accepted unreviewed/unassigned clips |
| Grid `q`, `label`, `reviewStatus`, `recordingId` | URL-persisted search/filter state; All clips supports review status and a clearable recording scope |
| `#/pipeline?status=failed&q=…` | Upload/processing status, errors and recovery; filters persist in URL |
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
4. Staff use Pipeline **Review clips** or the All clips tab, open a clip, enter its task label, optionally select datasets and approve. Selection alone changes nothing; unsaved choices survive viewer rerenders/reloads, and approval saves review and memberships together. Approval/rejection rebases the form from saved memberships. Notes and assignments are optional. Rejection removes the clip from every dataset; reapproval does not restore old memberships. There is no inspection checkbox, rejection modal, other-clips section or large yellow warning.
5. Pipeline **Review clips** opens `?view=clips&recordingId=…&reviewStatus=pending` for its completed 2:14 recording (three clips of 52, 48 and 34 seconds). The clip backlink retains these filters; the recording filter is clearable. Processing completion and review approval stay distinct.
6. Pipeline filters/status and capture recovery remain separate: unknown submission cannot blindly retry; signed URL renewal keeps progress; expired multipart transport resets progress/full-byte cost; only verified, staff-confirmed cloud copies permit explicit local cleanup.

## Scenarios and checks

There are **31 QA fixtures** across four page types: Pipeline 3, Data browser 4, Clip 7, Collector 17. Pipeline has no Scenario selector: its three fixtures are retained for programmatic QA only. Use its search and status filter to inspect processing activity. Scenario selectors on the other demo pages are prototype controls, not production features. Data browser list/detail and the shared clip page are checked with both actors. Automatic QC covers normal/missing-hand/decode-failed results; customers have no internal QC panel.

This revision's targeted checks cover approved-only datasets/pickers, the staff All clips queue, recording-scoped Pipeline review links, no assignment before approval, blank/stale-save no-mutation behavior, atomic review plus selected assignments, rejection removing all memberships, reapproval not restoring them, customer All clips denial and return-filter retention. The agent checked 124 actor/scope/scenario combinations at 375 px and 1440 px with no page overflow or JavaScript errors. The UI agent reported 124 responsive combinations for this revision; root independently checked 24 responsive combinations and 22 interactions, including dataset draft persistence through viewer toggles. The prior 100-combination result belongs to the earlier revision. These remain synthetic mock checks, not production auth/inference evidence.

Older files in the [screenshots folder](screenshots/) retain earlier navigation revisions; the links below identify current previews. Production uses a pinned `@rerun-io/web-viewer` client adapter and the real dataset/API authorization contract. [Rerun integration](../components/rerun-clip-review.md).

## Current screenshots and verification

[Pipeline review entry](screenshots/20261031-approved/pipeline-review-entry.png), [recording review queue](screenshots/20261031-approved/review-queue.png), [review form](screenshots/20261031-approved/review-example.png), [dataset list](screenshots/20261031-approved/datasets.png), [approved dataset grid](screenshots/20261031-approved/dataset-clips.png), [staff All clips](screenshots/20261031-approved/all-clips.png), [customer dataset](screenshots/20261031-approved/customer-dataset.png) and [mobile review form](screenshots/20261031-approved/review-mobile.png).

Root visually inspected these eight screenshots and the updated processing diagram. The [current receipt](../validation/approved-dataset-review-20261031.json) records the 24 responsive and 22 interaction checks. Earlier screenshots and [the prior receipt](../validation/dataset-browser-review-20261031.json) describe previous revisions. These checks cover the synthetic mock only; real Rerun/Next.js, authentication, database transactions/concurrency, storage and processing remain implementation gates.
