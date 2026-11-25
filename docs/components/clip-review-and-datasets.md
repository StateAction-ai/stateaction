# Recordings, clip processing and dataset review

SA-150 design approved on 2026-11-25. [Open the repository mock](../mocks/SA-150/index.html) using example captions and without recording media.

The independent tests of the approved mock are recorded in [round 1](sa-150-user-test-report-1.md) and [round 2](sa-150-user-test-report-2.md).

## Information architecture

- **Recording.** The uploaded video, capture metadata, its clips and processing history. Staff open Recordings to track work.
- **Clip.** A source time range and its processed outputs. The canonical clip page shows the annotations and offers review actions to staff.
- **Dataset.** A collection of clips. Staff review in the Data browser using Pending Review, Recycle Bin and their own datasets. Customers open an authorized shared dataset link.
- Primary navigation is Recordings (staff), Data browser (staff and customers, with access limits), Recipes (staff), and Settings. Staff processing pages contain processing status and history. Review state, actions and navigation belong in the Data browser and the clip page.

## URL map

| URL                                                   | Purpose                                                                                          | Access                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `/recordings`                                         | Searchable, sortable list with a status filter, progress, failure reasons and retries            | Staff                                                              |
| `/recordings/<recordingId>`                           | Video, metadata, overall status, recipe, total estimated cost, Clip planning runs and clip links | Staff                                                              |
| `/recordings/<recordingId>/clips/<clipId>/processing` | The clip’s own stages, runs and access to the processed clip                                     | Staff                                                              |
| `/data-browser`                                       | Datasets, including the built-in Pending Review and Recycle Bin                                  | Staff; customers open their shared dataset                         |
| `/data-browser?datasetId=<id>`                        | Clips in one dataset                                                                             | Staff; customers with a grant to an approved dataset               |
| `/clips/<clipId>?returnTo=...`                        | Canonical clip page                                                                              | Staff; eligible customers have read-only access from their dataset |
| `/recipes`                                            | Read-only visual recipe catalog                                                                  | Staff                                                              |
| `/recipes?tab=devices`                                | StateAction mobile app capture source and its default recipe                                     | Staff                                                              |
| `/recipes/<recipeId>`                                 | Recipe definition and recordings that use it. An optional job parameter opens the exact run.     | Staff                                                              |
| `/settings`, `/login`                                 | Account settings and sign-in                                                                     | Unchanged                                                          |

Only the routes in this map resolve. Earlier console paths return the standard 404.

## Recordings and processing

Use one standalone Recording component wherever a recording is shown. It renders a playable video preview and device, duration, size, resolution, frame rate, capture time, source and IDs. Show which values were recorded. The clip processing page can constrain the preview to the clip's source range.

The recording page shows overall processing status, total estimated run cost and the recipe once above the video and metadata. **Clip planning** is the only recording-level stage. Its card shows the current state, reason and next step, compute, duration, cost and **Runs (n)**. The **Clips** list shows a source time range and one processing status per clip. Each row opens the clip's own processing page. Keep **Retry clip planning** on the recording when planning fails and **Retry failed clips** when planning succeeded and any individual clip needs a retry. Staff use the Data browser to track review progress.

Show the failed stage and its plain-language reason beside the retry action on the list and recording page. **Needs setup** tells staff to ask an engineer and offers a copyable device report. **Choose a recipe** is for a recording paused for manual selection. The capture source's default recipe remains available. Held recordings have distinct IDs and stay on the same recording after processing starts.

Clip processing shows the video preview and metadata with the clip's time range. The header shows the clip status and estimated cost for its own runs. The page contains only the clip's action detection, captioning and hand-tracking stages and their clip job history. Clip planning stays at recording scope and is excluded from clip cost and retries. **Open processed clip** opens the canonical clip page with a Data browser return path when the result exists. Otherwise disable it and show the reason.

Show the recording's processing recipe name and version once in each header, with a link to its recipe page. Flag a rerun that used a different version where that run is listed. Show which cost and resource fields were recorded. The recording total covers its jobs once each, while the clip total covers only that clip's jobs.

### Runs

- Stage cards show the current status, failure reason and available next step, compute, duration and estimated cost. **Runs (n)** is visible even for one or zero executions. Show the three newest executions by default with **Show all** for older entries.
- Each row shows the short run ID, full run or stage rerun, the parent run link when available, who or what triggered the run, state, start time, duration, CPU or GPU, estimated cost, failure code and reason, and access to available logs. Clicking a run or parent ID highlights matching rows on the page.
- A retry or rerun creates a new job linked to its earlier job. Each executed stage has one `job_stage_runs` row per job and stage. Where `job_stage_reuse` references an earlier output, show **Used output from run <short ID>** with an explanation. That reference does not count as a stage execution.
- Preview processing, planning failure, mixed clip outcomes, partial completion, cancellation, timeout, and successful rerun after a failed stage. Distinguish a missing hand observation from a failed stage. Show failed action windows alongside the processed output that is available.

### Retry

- Use **Retry clip planning** on the recording page when planning failed. Otherwise show **Retry failed clips** when a clip failed, was cancelled or timed out. Confirmation identifies each eligible clip and its time range, the stages to rerun, any successful outputs it keeps and their source runs, and estimated cost.
- Clip processing offers **Retry segmentation and captions**, **Retry captions**, **Retry hand pose**, and **Retry from here** on the relevant failed stages. Captions must follow segmentation when enabled. Hand pose is independent. Clip retry confirmation includes only work for that clip.
- Show the reason when processing is active, the source is inaccessible, permission is missing or the remaining cost cap is too low.
- The stage retry command accepts a set of stages. The preview and confirmation bind the exact selected jobs, required dependent stages, reused outputs and compute estimates. A recording-level confirmation commits its batch together.

## Datasets

- **Your datasets.** Explicit membership. A clip can belong to more than one dataset.
- **Pending Review.** Staff-only derived dataset of clips whose current selected result has no decision or was restored. If processing changes the selected result, the clip returns here.
- **Recycle Bin.** Staff-only derived dataset of clips rejected on their current selected result. Preserve the raw source, frame and timestamp identity, and decision history.
- Built-in datasets cannot be renamed, shared or deleted.
- The dataset header shows **Last updated** for staff and customers. The timestamp reflects changes to membership and effective captions.

## Dataset search

Search caption text, task labels and recording names. Quoted phrases match together, and a prefixed minus excludes a term or phrase. A pasted short ID also matches. Caption results show a highlighted snippet and a link to its segment time.

Staff filters are searchable **Task label** and **Recording** lists with counts, **Duration** presets (under 5 s, 5–30 s, over 30 s) and a custom minimum/maximum, and a **Problems** group with **Failed action window**, **Caption failed** and **No hand detected** options. Selecting more than one problem matches any of those problems. Pending Review hides the Task label filter. Show removable filter chips and Clear all.

Staff can sort by **Best match** while searching, capture date in either direction, or **Recently added**. Show the date used by the chosen sort, using the added date where capture time is missing. Recycle Bin sorts by rejection time, most recent first. Pending Review opens oldest first and offers **Review next**, which starts with playable footage in the mock. Other datasets open newest first. Customers have search, Task label and capture-date order on their shared dataset.

Show filtered and total counts, pagination and a page size control. Preserve search, filters, sort, page, page size and grid or list selection in the URL. Distinguish empty datasets, no matches, loading and errors. The mock combines the seeded clips with labeled example data at approximately 500 recordings and 3,000 clips.

Result acceptance indexes the caption text in PostgreSQL under the accepted job and manifest digest. Review reads combine this index with the latest correction, task label, recording and clip duration and problem fields. Existing results can be indexed by replaying an exact cached import or accepting a new result.

## Clip posters

Show a 16:9 midpoint poster on the clip header and every clip row, including grids, compact lists, search results and the recording page. Letterbox when required. Overlay duration everywhere and show relevant review or problem flags in the Data browser and on the clip page. Use labeled example tiles for generated clips, a loading skeleton, a preview-unavailable fallback and lazy loading.

The exporter selects a midpoint frame from the review clip. Accepted files carry verified JPEG references. The poster broker checks the selected result and, for a shared clip, the exact authorized dataset.

## Naming

Generate recording names from task or place, device and captured day/time. If capture metadata lacks a task or place, show device, captured day/time and duration. When the device or capture time is missing, show a source or subject, added date, duration and an eight-character ID suffix. Display duration, resolution, frame rate and clip count on a secondary line. Disambiguate duplicates with a numeric suffix. Wrap long names and expose the full title on hover. Include the generated name, source label and ID in search.

A clip name uses its ordinal and a verb/object suggestion of up to four words from the model's caption rule. Show the source time range and duration. Mark unreviewed model names as suggested. If no caption can provide a label, show the ordinal and time range, with a reason. Use the reviewer's task label after approval and keep it stable across result selection. Dataset and search results prefix the clip with its recording's task or human name.

## Clip review

The canonical clip page serves review, browsing and sharing. It includes playable video, the hand overlay, segment and caption cards that follow playback, annotation tiers for segments, left and right hands and failures, model labels, and a link to **Clip processing** for staff. The clip page has no run history and no Rerun debug tab. Run history lives on the recording page and the clip processing page.

- **Add to dataset.** Choose at least one dataset and enter a task label. A note is optional. One transaction appends an approved decision and adds the chosen memberships. Use **Remove from this dataset** to remove one membership and retain the other memberships and all decisions.
- **Reject.** Enter a reason. One transaction appends a rejected decision and removes active memberships so the clip appears in Recycle Bin. Show the reason, reviewer and time. **Undo** appends a reversal and restores the previous decision state and memberships. Preserve the source and past decisions.
- **Restore.** Append a `reopened` decision and return the clip to Pending Review.
- Previous and Next follow the dataset in `returnTo`. Clip cards and headers show Not reviewed, Rejected or Problem when those apply. Display memberships only in Add to dataset.

### Add to dataset at review scale

The staff **Review actions** tab and clip-header action open the same form. Use a type-ahead for dataset names with a scrollable, height-capped list and removable chips for chosen datasets. Show current memberships as **Already in**. Before typing, show the three most recently used datasets and any pinned suggestions. Staff can pin suggestions for themselves. Offer **Create new dataset** when the name has no match. Provide empty, loading and error states. The mock includes 54 labeled example datasets across Training, Eval and Holdout.

Use arrow keys to browse, Enter to select, Tab to reach the task label, and Esc to close the dataset suggestions. The required task label suggests existing labels and defaults to the previous clip’s label when the current clip lacks one. **Same as last clip** shows the last datasets and task label and saves them in one action. Alt+Enter uses that shortcut. Staff can add an optional note before manually saving.

After saving from Pending Review, show **Added to <dataset>. It is no longer in Pending Review.** Open the next pending clip in the current browse order and focus the dataset picker. Offer **Undo** to append a reopening decision and restore the membership state from before the add. When no next clip is available, keep the current clip and show the same confirmation.

### Caption corrections

Staff can mark each caption **Correct** or **Incorrect** in Pending Review or a dataset. **Incorrect** opens an inline editor with the model caption on first edit and the current text on later edits. Save requires changed text of up to 2,000 characters after trimming, or an explicit **Caption not needed** choice. A caption correction and its `caption` issue mark are saved together. Keep the boundary and hand-pose marks and their notes supported by migration 012.

The original model output stays immutable. Save appends a revision and shows its author and time. **Show original / history** displays the original model, revision and caption, followed by every reviewer revision. **Undo last edit** appends an entry restoring the previous effective caption. Tab reaches the editor controls, Ctrl+Enter or ⌘+Enter saves, and Esc cancels. Warn before discarding a changed draft. Keep the draft available if saving fails.

The player, clip cards, search and exports use the effective caption. Staff search can also match the original and shows **Also matches original** beside the effective caption. Staff see the corrected count on the clip and in dataset cards. Customer playback, cards, search and exports use the effective caption without edit history or reviewer details. An omitted caption has no customer caption text.

Use an append-only `caption_corrections` table for `segment_id`, the accepted job and result binding, `revision`, `text`, reviewer, `created_at` and `not_needed`. The write must pin the same result as the segment mark and append both changes atomically. The read model should expose the effective and original captions for staff and the effective caption for customer surfaces and exports. Index the effective text and preserve staff search of the source caption.

Caption edits update the dataset in place. Its existing link serves the latest effective caption, and the header's **Last updated** time advances when a correction is saved or undone. Caption revision history is still available to staff on the clip page.

## Sharing and access

A customer receives a link to a specific shared dataset. Provide access only when every member has an approved decision on its current selected result. Built-in, private and unrelated datasets are staff-only. Customer clip pages have playback and annotations with read-only access. Keep internal notes, processing details and run history staff-only.

An operator records the recipient's sharing permission and clears the exact approved result for that recipient. The clearance is bound to the clip, job, manifest digest and selection revision. Approval and membership alone do not grant media access. When staff approve a new selected result into the same dataset, the membership points to the new result and the earlier review remains in history.

Use the same Page not found response for inaccessible and nonexistent routes, including dataset and recording filters a customer cannot open. Resolve access before rendering a title or description.

**Implementation requirement.** The server must exclude staff-only data from every customer HTML and API response, including serialized page state. Build customer pages from customer-safe data and remove staff-only nodes when switching to a customer view. Acceptance tests must fetch raw HTML and API responses using a customer session and verify that accessible pages omit reviewer identities and notes, superseded caption text and edit history, recipes, costs, run history and retry controls. Verify that requests for private datasets, recordings, Pending Review, Recycle Bin and staff processing return a generic 404. The offline mock tests rendered DOM behavior. Raw server-response checks are part of implementation.

Cached results can store their originating recipe or documented workflow reference. Legacy SA-143 evidence identifies FLORA Spike C and the separate CPU hand-tracking export by stage but does not identify a formal recipe ID or version. Its documented workflow is the closest available reference. SA-142 records `indego_hosted_canary@1`.

Reuse the append-only `review_clip_decisions` and selected-result membership in `dataset_review_clips`. Add `reopened` to the allowed decisions. The current migration 018 guards block shared review clips even when approved. Update guard logic to enforce the approved-current-result rule while preserving dataset grants and selected-result checks. Derived datasets do not need stored memberships.

## Validation

Exercise the full Data browser, canonical clip, Recording, processing and recipe navigation in real-seeded Chromium at 1280 and 390 px. Verify keyboard access, routing and removed-route 404s. Test multi-dataset add, membership removal, Reject, Restore, selected-result changes and customer access. Verify recording and clip scopes, cost aggregation, cross-stage run highlighting, execution counts, reuse references, retry confirmation and the disabled processed-clip control. Run changed tests 20 consecutive times, obtain independent review and verify the hosted release in the coordinator-authorized window.

Permanent deletion, bulk membership editing, a sharing UI redesign and model or processing execution changes are outside scope.

## Delivery scope (user decision, 2026-11-24)

Everything in this document and the matching mock, including every open backend item (caption corrections, reopened decision, sharing guard, originating recipe reference, caption search index, review-clip posters, multi-stage retry command, capture-source profiles with default recipes), ships in ONE PR under SA-150.
