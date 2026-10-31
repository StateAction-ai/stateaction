# Data browser, datasets and naming

Updated: 2026-10-31. Selected product/API design; implementation pending. [UI mock](../mocks/index.html), [storage model](storage-and-data-model.md), [shared clip viewer](rerun-clip-review.md).

## Names users see

| Name | Meaning |
| --- | --- |
| **Pipeline** | Staff screen for upload/processing status, progress, errors and safe retry/cancel actions |
| **Data browser** | Shared screen for finding datasets and opening their clips |
| **Dataset** | Named, editable group of approved clips; a clip may belong to multiple datasets |
| **Recording** | Original phone capture: MCAP plus required sidecars; may be two hours long |
| **Clip** | Bounded processed video with linked hand observations and source-frame mapping; the review unit |
| **Task label** | Human description of the activity in a clip |
| **Review status** | Not reviewed, Approved or Rejected; separate from processing status |
| **Automatic quality checks** | Worker-reported integrity, structure and detection/missingness results; not human approval |
| **Dataset version** | Follow-up: immutable whole-dataset snapshot prepared for publication/download |

Use **Dataset** consistently in UI, API and schema: `datasetId`, `datasets`, `dataset_clips`, `dataset_access`. Do not introduce a second “collection” entity. “Data collection” still describes the activity of recording data. Every Dataset member must have a latest Approved review. Approval still does not establish metric accuracy or training benefit. Reserve “episode” for a future complete task-demonstration unit, rather than calling every fixed-duration clip an episode.

This follows established usage: [FiftyOne](https://docs.voxel51.com/user_guide/basics.html) organizes samples into datasets; [LeRobot](https://huggingface.co/docs/lerobot/main/api/datasets) uses datasets containing episode-aware robot data. [Hugging Face Collections](https://huggingface.co/docs/hub/collections) group repositories, including datasets and models. [Roboflow dataset versions](https://docs.roboflow.com/datasets/versions/dataset-versions.md) freeze data and labels at a point in time. Our names adopt those familiar distinctions; they do not commit us to these products or their storage formats.

## Two main pages

**Pipeline** is staff-only. `/pipeline?status=failed` filters recording/job processing state. Default is all states; changes update the URL and browser history. Rows show recording name, upload/processing state, progress, updated time and concise error, with job detail and allowed recovery actions. Completed rows include **Review clips**, opening the staff All clips view filtered to that recording and Not reviewed clips. Processing remains Completed independently of human review status; this action is the clear handoff to review. Use human-readable status labels while retaining the detailed job-state enum in the API.

**Data browser** is available to staff and authorized customers:

| URL | Content |
| --- | --- |
| `/data-browser` | Dataset table: name, Clips count and Total hours. Click a row to set `datasetId`. |
| `/data-browser?view=clips` | Staff-only All clips grid, including unreviewed, approved, rejected and unassigned accepted results. |
| `/data-browser?view=clips&recordingId=<uuid>&reviewStatus=pending` | Staff review queue reached from a completed Pipeline recording. |
| `/data-browser?datasetId=<uuid>` | Approved clip grid for that dataset: thumbnail, title, task label, duration and raster metadata. Staff also see review status. |
| `/data-browser?datasetId=<uuid>&q=...&label=...` | Same approved grid with URL-backed search/task-label filters. `reviewStatus` belongs to staff All clips. |
| `/clips/<uuid>` | Same Rerun clip page for both roles, with staff-only review/QC controls. No clip-review sidebar item. |

URL state is the source of truth. Encode query values, validate IDs/filter enums, bound search length, reset pagination when filters change and support refresh, pasted links and Back/Forward. A missing `datasetId` means the dataset list unless staff explicitly select `view=clips`. Reject customer requests for All clips. `recordingId` is a staff-only All clips filter; reject incompatible dataset/global-view parameters rather than broadening results. An inaccessible/unknown ID shows unavailable, never silently switches to all data. Search on the list filters dataset names; on the grid it filters clip title/task label. Query changes use Next.js router navigation; query parameters contain no credentials or signed storage URLs.

Compute count and hours from **distinct visible clip IDs** and exact stored clip durations, before rounding for display. Counts are per dataset, so overlapping datasets must not be summed as unique corpus hours. One recording may produce many clips; a clip count is not an original-recording count. Grid filters show matching versus total visible clips; the parent dataset summary remains the full authorized dataset total. Cursor pagination and indexes keep lists bounded; no query loads all manifests into the browser.

## Membership and access

Staff can create a named dataset, add approved clips using a searchable picker, remove a membership and assign a clip to several datasets. All clips is where staff review accepted results before dataset assignment; unreviewed and rejected clips are ineligible for membership through every API. Each `(datasetId, clipId)` is unique; membership references existing artifacts, without copies or inference. An empty new dataset is valid. Optimistic `expectedRevision` prevents one editor overwriting another's membership changes; batches are bounded and transactional. The clip review form includes an optional Dataset multi-select. Approve saves the review and chosen memberships in one transaction after checking the label and expected review/dataset revisions; stale or invalid input changes neither. Reject/withdraw removes the clip from every working Dataset in that same transaction and increments affected Dataset revisions. Reapproval does not restore previous memberships automatically. Removing a membership never deletes a recording, clip, review or shared artifact. Reprocessing creates new clip IDs and does not silently replace membership.

Keep external review useful before release tooling: an operator grants named, enabled customers view access using `dataset_access`, following the pilot's existing manual allowlist approach. Grant creation requires recorded permission for external inspection by that recipient; collection/inference permission alone is insufficient. Customers see only members whose **latest review is Approved**, using that exact approved task label. Unreviewed/rejected clips never belong to working Datasets; internal notes/QC and collector identity are excluded from cards, counts, search and viewer payloads. Recheck the live grant and approval/membership before issuing every viewer URL. Dataset names are shared metadata; staff should use customer-appropriate names.

A shared clip URL authorizes access through any currently granted dataset containing that approved clip. It does not require a dataset query parameter, and never grants access just because the UUID is known. Keep parent filter navigation as local UI state; a direct clip link still works after authorization. Customers cannot edit membership, labels or decisions. Existing issued storage URLs remain capabilities until their short expiry; revocation blocks new issuance rather than erasing previously viewed data.

## Follow-up: publish a whole dataset

There is **no Releases page or separate Deliveries page in this revision**. The future action belongs to a dataset: freeze its membership revision and every member's approved review revision, export, then publish an immutable **Dataset version**. Block version creation if any member is unreviewed/rejected or the whole package exceeds the 32 GiB archive limit; staff must change the working dataset rather than silently omit clips or truncate the package. Freeze checks and publication checks prevent stale approvals/membership from changing the intended delivery.

The existing `releases`/`export_release` design is the internal implementation of a future dataset version, not a second arbitrary selection model. Versioned files/labels stay fixed after publication; changes to the working dataset create another version. Real publication and complete training-package download remain follow-up implementation work. Approved working-dataset browsing and the staff All clips review view are in the MVP; no export workflow or paid compute runs during human review.

When adding or approving a clip in an already shared Dataset, staff/operator must confirm it is cleared for the existing recipients before it becomes externally visible. Revoked permission disables the affected sharing. This is a manual pilot rule recorded with permission evidence, not an extra reviewer checklist or policy engine.
