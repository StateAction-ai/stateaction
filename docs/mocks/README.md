# Clickable MVP interface mock

Open [index.html](index.html) directly in a browser, or run `python3 -m http.server 8765` from this folder and open `http://localhost:8765`. It works offline without installs, CDN or service calls.

**DEMO / synthetic only.** View as simulates staff/customer access; it is not authentication. Refresh resets in-memory edits. The Rerun-looking HTML/SVG stand-in does not load real Rerun, RRDs, private media or inference. No release/export/download function is active. [UI/component decision](../components/ui-design.md).

## Names and navigation

**Dataset** is a named group of **Clips**; a **Recording** is the original capture/upload. Each clip is an immutable accepted processed segment and may belong to several datasets. A future **Dataset version** will freeze the whole dataset for release/export. [Naming and routes](../components/data-browser-and-datasets.md).

Sidebar: **Pipeline** (staff only), **Data browser** (both actors), and **Collector app** (separate demo). There is no Clip review, Releases or Deliveries tab. Staff default to the Data browser.

| Route | Behavior |
| --- | --- |
| `#/data-browser` | Dataset list: name, visible Clips count and Total hours; URL `q` searches dataset names |
| `#/data-browser?datasetId=<uuid>` | Screenshot clip grid with title, task label, duration and resolution |
| Grid `q`, `label`, `reviewStatus` | URL-persisted search/filter state; `reviewStatus` is staff only |
| `#/pipeline?status=failed&q=…` | Upload/processing status, errors and recovery; filters persist in URL |
| `#/clips/<uuid>` | One shared Rerun-style clip page; role-specific review/read-only controls |
| `#/collector` | Capture, offline ownership, upload and recovery scenarios |

Seeded dataset IDs (technical test references; not shown in the page):

- Electrical bench repairs: `683a8f18-042b-4c7a-9b15-000000000001` — staff 3 clips, customer 2 approved clips initially.
- Terminal and cable work: `683a8f18-042b-4c7a-9b15-000000000002` — shares clips with the first dataset.
- Continuity checks: `683a8f18-042b-4c7a-9b15-000000000003` — staff only.

Shared exact clip route: `#/clips/1fd2b602-2c38-4a62-9c1d-000000000002`. The initially unreviewed terminal-screw clip ends `000001`; customers cannot open it until a current approved review and valid shared-dataset membership exist. Raw UUIDs/paths are not displayed as product labels.

## Walkthrough

1. As staff, open a dataset row. Search/filter the grid, reload a seeded deep link, and open a thumbnail. The clip's backlink preserves the Data browser/filter context. Switch View as on the clip: its URL stays unchanged.
2. Create a **New dataset**, then **Add clips**. The picker contains all four accepted processed clips, including clips already assigned elsewhere. **Assign to datasets** supports several memberships; membership changes reuse the same immutable clip/media.
3. As customer, only shared datasets and their current approved clips appear. Counts/hours exclude unreviewed/rejected data. Staff-only datasets, edit controls, review mutations, notes and internal QC are absent. Labels use the latest approved review.
4. Staff approve/reject directly with optional notes; approval needs a task label. Rejecting/withdrawing a clip removes customer visibility/access. There is no inspection checkbox, rejection modal, other-clips section or large yellow warning.
5. Pipeline filters/status and capture recovery remain separate: unknown submission cannot blindly retry; signed URL renewal keeps progress; expired multipart transport resets progress/full-byte cost; only verified, staff-confirmed cloud copies permit explicit local cleanup.

## Scenarios and checks

There are **31 named scenarios** across four page types: Pipeline 3, Data browser 4, Clip 7, Collector 17. Data browser list/detail and the shared clip page are checked with both actors. Automatic QC covers normal/missing-hand/decode-failed results; customers have no internal QC panel.

The agent checked **100 viewport/scenario combinations at 375 px and 1440 px**, plus dataset creation, all-clips picker, multiple assignments, URL/deep-link retention, customer counts/permissions, current approved labels, review withdrawal and absence of release/export UI. No page overflow or JavaScript errors were found. These are synthetic mock checks, not production upload/auth/inference evidence.

The [screenshots folder](screenshots/) may show an earlier navigation revision; root will regenerate the current previews. Production uses a pinned `@rerun-io/web-viewer` client adapter and the real dataset/API authorization contract. [Rerun integration](../components/rerun-clip-review.md).

## Current screenshots and verification

[Dataset list](screenshots/20261031/datasets.png), [clip grid](screenshots/20261031/dataset-clips.png), [Pipeline errors](screenshots/20261031/pipeline.png), [staff clip review / automatic checks](screenshots/20261031/clip-review.png), [customer dataset](screenshots/20261031/customer-dataset.png), [customer clip on mobile](screenshots/20261031/customer-clip-mobile.png), [mobile grid](screenshots/20261031/dataset-mobile.png) and [collector](screenshots/20261031/collector.png). Earlier screenshots are historical.

Root independently checked 84 actor/page/scenario/viewport combinations and 19 interaction cases, then visually inspected the eight current screenshots and both architecture diagrams. [Current verification receipt](../validation/dataset-browser-review-20261031.json). These checks cover the synthetic mock only; real Rerun/Next.js, auth, storage and processing integration remain implementation gates.
