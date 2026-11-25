# SA-150 mock: independent user test report

Target: `file:///home/wearaway/flora-work/mocks/SA-150-test-snapshot/index.html` (frozen snapshot). Tester role: skeptical first-time staff researcher, then customer. Nothing was built, fixed or committed. Screenshots: `SA-150-test-snapshot/usertest/` (names below are relative to it).

How it was driven: Orca's embedded browser through the `orca` CLI (real click / type / keypress / back / forward / reload / new tab). Playwright was not used: `agent-resource run` refused admission every time ("1 lane job already holds 6 GiB"), so I did not run a headless browser. `eval` was used only to read state (URL, focus, text, sizes), not to perform actions, except where noted.

Viewport caveat: desktop pane was 1045–1305 px wide and tall, not exactly 1280x800. Mobile used device emulation "iPhone 12" (390x844 CSS px). See section 7.

Mock caveats, so nobody mistakes them for product bugs: example clips have no video; review decisions live only in memory (lost on reload / new tab); the retry never finishes.

---

## 1. Summary

The app is clear in its overall shape (Recordings / Data browser / Recipes / Settings), search/filter/pagination are strong, and failure diagnosis on the clip processing page is good. The review loop is the weak spot: it is slow, has no Undo, no "Same as last clip", no auto-advance, and the dataset picker described in the brief (search, pinned/recent, create) does not exist in this snapshot. The customer side hides staff pages well, but leaks staff page names and shows misleading errors.

### Top 10 issues, ranked

| #   | ID   | Severity | Issue                                                                                                                                                                                                                                                                                                         |
| --- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | I-01 | major    | Review loop costs 6 actions and 3 mouse trips per clip. No auto-advance, no "Same as last clip", task label not pre-filled, form hidden behind a tab and a header button.                                                                                                                                     |
| 2   | I-02 | major    | "Add to dataset" control in the brief does not exist: it is a "Move to dataset" checkbox list of 2 datasets, with no search, pinned/recent, or create-new dataset anywhere in the app.                                                                                                                        |
| 3   | I-03 | major    | No Undo after saving to datasets or rejecting. Only Restore (rejects) and per-dataset "Remove" (saves), both two-step and not announced as undo.                                                                                                                                                              |
| 4   | I-04 | major    | "Review next" and the whole Pending Review queue open example clips with no video. A new reviewer lands on a dead player first. Disabled controls look enabled.                                                                                                                                               |
| 5   | I-05 | major    | Customer URL space leaks staff names and shows a wrong error. `#/data-browser?datasetId=pending-review`, `recycle-bin`, private "Internal holdout" id and `?recordingId=<id>` show the real title (even a recording name) over "This view is temporarily unavailable. Try again". Should be "Page not found". |
| 6   | I-06 | major    | A failed recording does not say what failed or why on the Recordings list or recording page. Only "Failed". The reason is two clicks deeper (Processing details → clip → stage).                                                                                                                              |
| 7   | I-07 | major    | "Needs setup" is a dead end: "View capture sources" leads to a page where nothing can be set up ("Defined in code"). The held "Choose a recipe" case contradicts the Devices tab, which shows a default recipe for the same source.                                                                           |
| 8   | I-08 | major    | Recording names are unusable for identification: three recordings are all "Unknown camera · Date not recorded · 4 min 59 s", two held recordings are identical and share a recording ID with a processed recording. No search, sort or filter on the Recordings list.                                         |
| 9   | I-09 | minor    | Long unbroken recording name makes the page scroll horizontally (scrollWidth 1998 vs 1045) and the heading is clipped. No length limit in Rename.                                                                                                                                                             |
| 10  | I-10 | minor    | Sort and facets are confusing: "Newest" shows #1.. oldest-looking order; a just-rejected clip appears last in Recycle Bin "Newest"; "Problems" lumps unrelated failures; List view is taller than Grid.                                                                                                       |

Counts: 0 blockers, 8 major, 12 minor, 10 polish (listed in section 3).

---

## 2. Scenario log

Verdicts: ok / confusing / broken. "N/A" = feature not present.

### S1 Staff: land, find next clip, review, undo, reject, restore

| #   | Action                                   | Expected                        | Actual                                                                                                                                                                                                                        | Verdict             | Shot           |
| --- | ---------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------- |
| 1   | Open file                                | Hint of what to do next         | Workspace page: 3 cards (Recordings, Data browser, Recipes), no count of pending clips, no "N to review". Grey box showing raw route `/`.                                                                                     | confusing           | 01-home        |
| 2   | Click Data browser                       | Datasets                        | Four datasets: Pending Review 1509, Recycle Bin 301, Shared pick-and-place, Internal holdout. Focus moves to H1.                                                                                                              | ok                  |                |
| 3   | Click Pending Review                     | Queue with a Review next button | Works. Cards have no thumbnail, every card carries "Pending review" and "Example data" badges, "no hand named" in the meta line.                                                                                              | confusing           | 02-pending     |
| 4   | Click Review next                        | A clip I can watch              | Opens example clip #6 "Sort wire connectors": black box "Example clip. No source video attached.", Play/seek/overlay disabled but styled like enabled.                                                                        | broken (for review) | 03-review-next |
| 5   | Click Move to dataset                    | Dataset picker                  | Right panel switches to "Review actions": checkboxes for only 2 datasets (Shared pick-and-place, Internal holdout), Task label (empty), Note. No search, no pinned/recent, no create new, no "shared with customers" warning. | N/A / confusing     | 04-move-open   |
| 6   | Save with empty label                    | Clear error                     | Browser-native bubble "Please fill out this field" on Task label only. Label not marked required.                                                                                                                             | ok                  | 05             |
| 7   | Fill label, no dataset, save             | Error                           | Inline "Choose at least one dataset."                                                                                                                                                                                         | ok                  | 06             |
| 8   | Tick both datasets, Save                 | Saved, move on                  | "Saved to the selected datasets." Page stays on same clip. Title is overwritten by the label ("#6 sort connectors"), original title lost. Pending Review count 1509 → 1508. Clip left Pending Review. No toast, no Undo.      | confusing           | 07-after-save  |
| 9   | Look for Undo                            | Undo                            | None. Only "Remove" next to each dataset link.                                                                                                                                                                                | broken (missing)    | 07             |
| 10  | Recordings → recording 2 → click clip #1 | Review page                     | Lands on "Processing" page, not review. Review is behind "Open processed clip".                                                                                                                                               | confusing           | 10-realclip    |
| 11  | Open processed clip, Play                | Video plays                     | Plays (t=3.7 s after 3 s). Badge in corner says "No hand detected" at 0:03 though hand tracks exist, later "L ✓".                                                                                                             | ok / confusing      | 12-playing     |
| 12  | Click a caption, scrubber                | Seek                            | Caption click seeks (0:09.3 → 10.9 s). Follow playback highlights the active caption.                                                                                                                                         | ok                  | 14             |
| 13  | Toggle Hand overlay                      | Skeleton on video               | Works, hand skeleton drawn. On/off differs only by a faint background; no aria-pressed.                                                                                                                                       | ok / polish         | 13, 14         |
| 14  | Review actions on real clip              | Suggested label                 | Label empty, the model's suggested name ("Peel yellow tape") is not offered.                                                                                                                                                  | confusing           | 15             |
| 15  | Label field, type, Enter                 | Save                            | Enter submits. Focus moves to the confirmation text (good for screen readers).                                                                                                                                                | ok                  | 16             |
| 16  | Reject → reason → Enter                  | Submit                          | Reason is a textarea: Enter adds a newline, does not submit (inconsistent with Task label). Must click "Move to Recycle Bin".                                                                                                 | confusing           | 17             |
| 17  | After reject                             | Reason visible somewhere        | Badge "In Recycle Bin", "The rejection remains in decision history". The reason is not shown on the clip or in the Recycle Bin card.                                                                                          | confusing           | 19             |
| 18  | Open Recycle Bin, search "monitor arm"   | Find my clip                    | Found (13 of 302). My clip, rejected today, is the last of 12 on page 1 under sort "Newest".                                                                                                                                  | confusing           | 21             |
| 19  | Open it, click header Restore            | Restored                        | Opens a second "Restore" confirm in the side panel (two clicks). Then "Returned to Pending Review." Works.                                                                                                                    | ok / extra click    | 22b            |

### S2 Staff: review 10 in a row

Sequence per clip (repeated 10 times, all 10 saved, labels "label 1".."label 10"):

1. click "Move to dataset"
2. click dataset checkbox
3. click Task label
4. type label
5. press Enter
6. click "Next clip ›"

= 6 actions, 3 mouse targets (header button, checkbox, Next link) plus typing, per clip. The panel returns to the Segments tab on every new clip, so the form must be reopened each time. After saving, focus moves to the H1 of the next clip (good). "Same as last clip": N/A. Auto-advance: N/A. The task label is not remembered. Next clip skipped the ones already moved correctly. Verdict: slow. No video to watch on these example clips, so real review time is higher still. Keyboard: Tab order is logical, focus ring visible (2.7 px). The "Review actions" tab is only reachable by arrow keys in the tablist (not discoverable).

### S3 Staff: find by content, filter, sort, paginate, URL, history

| Action                                                                        | Result                                                                                                                                                              | Verdict                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Data browser → All clips (3,011), search `tape`                               | 72 results, chip "Search tape ×", "Clear all"                                                                                                                       | ok                          |
| `"sticky notes"`                                                              | 2                                                                                                                                                                   | ok (phrase works)           |
| `cable` 88; `cable -black` 78; `black` 10                                     | exclude works, case-insensitive                                                                                                                                     | ok                          |
| `cabel` (typo)                                                                | 0 clips, no suggestion                                                                                                                                              | polish                      |
| `xyzzy nothing`                                                               | "No clips match. Try a broader search or clear the filters." plus both a "Clear all" chip and a "Clear all filters" link (duplicate); count line "0 of 3,011 clips" | ok / polish (24-no-results) |
| After each search, focus jumps to the H1                                      | Must click the search box again to refine                                                                                                                           | polish                      |
| Duration "Under 5 s (501)", Problems checkbox                                 | 501 → 84, chips "Under 5 s ×", "Problems ×", facet counts update                                                                                                    | ok (26)                     |
| Task label facet + "Find a task"                                              | Works; lists tasks with 0 results while other filters are on                                                                                                        | polish (27, 28)             |
| Sort Newest/Oldest/Recently added                                             | See I-10                                                                                                                                                            | confusing                   |
| Pagination 1 2 … 251 Next, Per page 12/24/48/96 (per-page only at the bottom) | Works, page change scrolls to top, last page "Showing 3,001–3,011"                                                                                                  | ok (30)                     |
| Back / Forward across pages                                                   | Restores page and scroll position                                                                                                                                   | ok                          |
| Copy URL (q, duration, sort, layout, size, page) into a new tab               | Same filters, chips, page, search text, "Showing 25–40"                                                                                                             | ok (32)                     |
| Per page 96, sort change timing                                               | ~1.3 s and ~2.1 s wall time including CLI overhead (~1 s). DOM stays at ~1.4k nodes. No visible lag                                                                 | ok                          |
| Grid → List                                                                   | List rows are taller (≈190 px each) than grid cards; no columns                                                                                                     | confusing (31)              |

### S4 Failed recording, retry, run history

| #   | Action                                        | Result                                                                                                                                                                                                                                                                                                                       | Verdict             |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | Recordings list                               | "Failed hand-pose run" recording shows red "Failed", "0 of 1 clips processed". No reason.                                                                                                                                                                                                                                    | confusing (08)      |
| 2   | Open recording                                | "Failed" + recipe + cost "Not recorded". No reason, no retry here. Clip row says "No accepted caption · Failed".                                                                                                                                                                                                             | confusing (33)      |
| 3   | Processing details                            | Stage 1 "Clip planning: No run recorded". Button "Retry failed clips" (wording differs from "Retry failed stages"). Reason still absent.                                                                                                                                                                                     | confusing (34)      |
| 4   | Open failed clip                              | Clear: "Track hands" Failed, "The hand-tracking model could not load.", code `model_load_failed`. Two buttons "Retry hand pose" and "Retry from here" with no explanation of the difference.                                                                                                                                 | ok / confusing (35) |
| 5   | Click Retry hand pose                         | Dialog: What will run (Track hands), Outputs kept (Find actions, Generate captions from run c0062977), cost estimate $0.0609, "Retry runs only in this mock." Esc closes, focus returns to the button.                                                                                                                       | ok (36)             |
| 6   | Start retry                                   | Stage → "In progress", "Run eadf0001 · Rerun of track hands · Parent c0062977" appears above the failed run. Status text "Retry started." Page still "In progress" after 60 s (mock). No elapsed time, progress or Cancel. A stale "Returned to Pending Review." was left in the hidden live region from my earlier restore. | confusing (37, 39)  |
| 7   | Run history of one stage                      | Inline "Runs (n)" per stage with start, duration, compute, cost, who triggered.                                                                                                                                                                                                                                              | ok                  |
| 8   | View logs                                     | Dialog with 4 lines "This example log comes from the mock." (run id, started, status, compute). Not usable for diagnosis.                                                                                                                                                                                                    | confusing (40)      |
| 9   | Which recipe                                  | Link "IndEgo processing@1 / Default for StateAction mobile app" in each header.                                                                                                                                                                                                                                              | ok                  |
| 10  | "Open processed clip" disabled on failed clip | Reason given: "A processing stage failed. No processed clip is available."                                                                                                                                                                                                                                                   | ok                  |
| 11  | Return                                        | "‹ Recording processing" back link and browser Back both work.                                                                                                                                                                                                                                                               | ok                  |

### S5 Recipes and Devices

Recipes tab shows two cards with colour-coded CPU/GPU stage boxes, model names, cost per video-hour, "Supports", "Default for". A newcomer can see which stages run on GPU. They cannot learn what a recipe is: there is no definition line (only "Recipes and capture sources are defined in code."). Both recipes look identical (same stages, same $11.26); the second is described as "a recipe fixture for trying the recipe change flow" (mock-speak), "Supports: None". "Recordings in this mock: 2" does not match what Recordings shows. Devices tab shows one capture source with an arrow to "Default recipe `indego_hosted_canary@1`": a raw ID, not the display name "IndEgo processing@1". "Add a custom capture device / Defined in code." looks like a card with an action but does nothing. The recipe detail page (link from Devices) is good: flow, definition per stage with compute and time budget, "Recordings that used this recipe". Verdict: mostly readable for a developer, not for a first-time researcher. (41, 42, 43)

### S6 "Needs setup" / "Choose a recipe"

| Case            | What you see                                                                                                                                                                                                                                                                                                                                                                                                                 | Can you tell what to do?                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Needs setup     | "No matching capture source for this recording. View capture sources". The link opens the Devices tab, which has no add/map action.                                                                                                                                                                                                                                                                                          | No. Dead end (44)                                     |
| Choose a recipe | Blue "Choose a recipe" button, dropdown of 2 recipes with no description, cost, or CPU/GPU hint (the retry dialog shows cost; this one does not). "This example capture source has no default recipe" contradicts Devices tab. After Start, the recording's name changes from "24 Nov, 1:09 pm" to "Date not recorded (2)" and shows 10 clips and $0.9957 immediately (it merged with another recording that shares the ID). | Partly. Action is clear, consequences are not (45–47) |

### S7 Rename / find by name / duplicates

Rename dialog: one field "Task or place" with explanation "The device and capture time stay in the name." Result in list: "Warehouse aisle 4 picking · Unknown camera · Date not recorded" (the "(2)" suffix disappears). Works. No search box on Recordings, so "find by name" is only possible via the Recording filter picker in Data browser, which I did not exercise in depth. Duplicates: three recordings share the identical title, differ only by "(2)", "(3)" and a source subtitle; nothing warns that two entries are the same video; held recordings share an ID with a processed one. (08, 48, 49)

### S8 Edge cases

| Case                             | Result                                                                                                                                                                                                                                                                                                | Verdict             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Empty dataset (Internal holdout) | "This dataset has no clips yet." Staff banner "Sharing requires approved current results for every clip." (unclear). Facets still shown. No hint how to add clips.                                                                                                                                    | confusing (57)      |
| No search results                | See S3                                                                                                                                                                                                                                                                                                | ok                  |
| Clip with no preview image       | Every clip card in every list has no thumbnail at all (also real clips). Example clips show a black box with text.                                                                                                                                                                                    | confusing (02, 31)  |
| Long names                       | Long unbroken name overflows the page horizontally on the recording page (heading clipped) and list (1175 vs 1045), and on mobile (886 vs 390).                                                                                                                                                       | broken (59, 60)     |
| 3000-clip list                   | 3,011 clips, 96 per page, no lag.                                                                                                                                                                                                                                                                     | ok                  |
| Reload on deep page              | Route and page restored. State changes are lost (a rejected clip returned to Pending after reload; a new tab starts from seed state). Mock limit, but a real user would have no warning.                                                                                                              | ok / mock           |
| Removed URL                      | `#/old-pipeline-view`, `#/clips/does-not-exist`, `#/recordings/nope` → "Page not found / Return to the workspace" (focus moves to H1). `#/data-browser?datasetId=nope` → "This view is temporarily unavailable. Try again" (wrong, should be not found).                                              | ok / confusing (58) |
| Keyboard-only                    | Skip link first, then logical order; visible 2.7 px focus ring. Disabled player controls are skipped. Review tabs need arrows. Enter submits Task label but not Reason.                                                                                                                               | ok                  |
| Focus after route change         | Moves to H1 every time; the H1 shows a thick orange box (looks like an error highlight).                                                                                                                                                                                                              | polish              |
| 200% zoom                        | Not tested (could not set zoom).                                                                                                                                                                                                                                                                      | not tested          |
| Accessible names                 | Buttons and links in the accessibility tree have names (e.g. "Copy clip ID aa000bb8", "Play", "Seek", "Playback speed"). Hand overlay, Grid/List have no pressed/current state. Timeline segment buttons are named by their label only. The document contains two hidden H1s besides the visible one. | ok / polish         |

### Customer scenario

| Action                                                      | Result                                                                                                                                                                                                                                                                                                                                                               | Verdict                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Sign in as Seed Customer                                    | Lands directly on the shared dataset. Nav: Data browser, Settings. No Sitemap, no Recordings/Recipes.                                                                                                                                                                                                                                                                | ok (52)                          |
| Search `pack parcel -fold`                                  | 1 result; search works. Controls available: search, Task label facet, Sort Newest/Oldest, Grid/List.                                                                                                                                                                                                                                                                 | ok                               |
| Open a clip                                                 | Player with disabled controls (example clip, no video, so playing could not be tested as customer), Segments tab only, no Review actions, no Run history, no Reject, no Move.                                                                                                                                                                                        | ok (56)                          |
| Staff-only items shown anyway                               | "In 1 dataset" badge, "This clip is generated for browsing and review practice.", Failures/Hand tier, "Suggested"-free.                                                                                                                                                                                                                                              | minor                            |
| Typed staff URLs                                            | `#/recipes`, `#/recipes?tab=devices`, `#/recordings`, `#/recordings/<id>`, `…/processing`, `…/clips/<id>/processing`, `#/clips/<staff clip id>`, `#/sitemap`, `#/recipes/<id>` → "Page not found".                                                                                                                                                                   | ok                               |
| Typed staff dataset URLs                                    | `datasetId=pending-review` shows title "Pending Review" and subtitle "Clips whose selected result needs a decision."; `recycle-bin` shows "Recycle Bin / Rejected clips. Open a clip to restore it."; private dataset id shows "Internal holdout"; `?recordingId=<id>` shows the recording's name. Each ends with "This view is temporarily unavailable. Try again". | broken (leak + wrong error) (55) |
| Typed `#/login` while signed in                             | Shows the sign-in form without signing out.                                                                                                                                                                                                                                                                                                                          | polish                           |
| Cost, notes, run history, reviewer, retry in customer pages | Not seen anywhere on customer pages reached.                                                                                                                                                                                                                                                                                                                         | ok                               |

Also note: staff's picker offers "Shared pick-and-place" with no indication that customers see it. In my first session, I saved clips with "Caption failed" and "Failed action window" straight into it, and the customer count immediately rose to 1,213 (shown in that session only; a new tab reset it).

### Mobile (390x844, iPhone 12 emulation)

Home, Pending Review and the real clip page render in one column with no horizontal overflow (except the long-name case). Top chrome (brand, 4-item nav, header, URL strip) takes about 200 px before content. Clip page: title, actions at top (good), video, controls, timeline, then the side panel with nested scroll. Small tap targets (measured): timeline segment buttons 8–92 x 22 px, seek slider 16 px tall, prev/next segment 31x33, Hand overlay 107x33, Good/Incorrect/Clear 32 px tall, "Original video" link 20 px. Several clicks were refused by Orca's emulator ("covered by header#console-header"), so I could not drive the review form on mobile. (m02-pending, m03-clip-top, m04-clip-mid)

---

## 3. Issues

Severity: blocker / major / minor / polish. "Real bug" = behaviour contradicts itself or the page; "Design" = my opinion as a user.

### Major

**I-01 Review loop too slow** (design, strong). Route `#/clips/<id>` after Pending Review → Review next. Repro: do S2 above. Expected: one keystroke/click per decision after the first. Actual: 6 actions, 3 mouse targets per clip; panel resets to Segments each clip; label never pre-filled with the suggested name. Fix: keep the Review actions pane open and remembered; preselect last datasets and last label ("Same as last clip", visible default); "Save & next" button; keyboard shortcuts (e.g. 1–9 for pinned datasets, Enter save+next); optional auto-advance. Shot: 07-after-save.

**I-02 No real dataset picker** (feature gap vs the brief). `#/clips/<id>` → Move to dataset. Expected: searchable, pinned/recent datasets, create new. Actual: 2 checkboxes only; nowhere in the app can a dataset be created, renamed or shared. Wording is "Move to dataset" (the brief says "Add to dataset"), and it adds rather than moves. Fix: combobox with type-ahead, Pinned and Recent groups, "Create dataset…" row, keyboard-only; rename the action to "Add to dataset". Shot: 04-move-open.

**I-03 No Undo** (design). After Save/Reject. Expected: "Saved. Undo" for ~10 s. Actual: no Undo; recovery is Restore (two clicks) or Remove per dataset. Fix: toast with Undo that restores the clip to Pending Review and the prior state; also keep Restore. Shot: 07-after-save, 19-rejected-done.

**I-04 Review queue opens on dead clips** (real, content/data). `#/data-browser?datasetId=pending-review` → Review next → example clip. Expected: a playable clip. Actual: "Example clip. No source video attached." with disabled controls that look enabled (blue Play). Fix: grey out disabled controls clearly; explain "preview data"; seed the queue with real clips first. Shot: 03-review-next.

**I-05 Customer URL leak + wrong error** (real bug, security-relevant to the claim "absent from the URL space"). Signed in as customer, type `#/data-browser?datasetId=pending-review` (also `recycle-bin`, `…d002`, `?view=clips`, `?recordingId=<id>`). Expected: "Page not found". Actual: staff page title/subtitle, and for recordingId the recording name, then "This view is temporarily unavailable. Try again". Fix: same not-found response for any dataset or recording the customer cannot access, never echo a title. Shot: 55-customer-pending-url.

**I-06 Failure reason hidden** (design). `#/recordings` → failed recording. Expected: "Failed: hand tracking model could not load" on the list and recording page, with a Retry. Actual: bare "Failed". Fix: show the failed stage and first-line reason on list rows and the recording page; put "Retry failed stages" there; align wording ("Retry failed clips" vs stages vs "Retry hand pose" vs "Retry from here"). Shots: 08, 33, 34, 35.

**I-07 "Needs setup" dead end** (design + contradiction). `#/recordings/<id>?hold=setup`. Actual: only a link to the Devices tab, which has nothing to configure. `?hold=choose` says the source has no default recipe while Devices lists one. Fix: say who does what ("Ask a developer to register this device" or provide a mapping form), link to the specific device, remove the contradiction. Shots: 44, 45, 42.

**I-08 Recordings cannot be told apart or searched** (real-ish, partly seed data). `#/recordings`. Three identical titles, two identical held titles with ID `b676a7d4` (same as a processed recording). Fix: show a title from the task/place or filename, first line "device · date", a search box, sort, status filter; ensure IDs are unique. After "Choose a recipe" the held row turned into the other recording. Shots: 08, 47.

### Minor

**I-09 Long names overflow** (real bug). `#/recordings/<id>` → Rename → 190-char name without spaces. Expected wrap/truncate. Actual horizontal scroll 1998 px, heading clipped; list 1175 px; mobile 886 px. Fix: `overflow-wrap:anywhere`, max length (e.g. 80) in the dialog, ellipsis in lists. Shots: 59, 60.

**I-10 Sort and list semantics** (real/confusing). (a) All clips, sort "Newest" opens with `#1 … aa000001` ascending, Oldest starts with "Organize electrical parts #1 Nov 7"; the Pending Review cards show no date, so users cannot check the order. (b) Recycle Bin "Newest": the clip rejected a minute ago was last of the first 12. (c) "Problems" (517) mixes caption failed, failed action window and no hand detected. (d) List view uses more vertical space than Grid. Fix: show the sort date on every card, sort by decision time in Recycle Bin, split Problems into named filters, make List a dense table. Shots: 21, 26, 31.

**I-11 Clip-row link goes to Processing, not review** (design). Recording page → clip row opens `/recordings/<id>/clips/<id>/processing`; review needs "Open processed clip". Staff expect the clip. Fix: row opens the review page, with "Processing" as a secondary link. Shot: 10.

**I-12 Header Restore needs a second Restore** (design). Shot: 22.

**I-13 Reject reason invisible and Enter inconsistent.** Reason is not shown on clip or Recycle Bin card; Enter in the Reason textarea adds a line. Fix: show reason + who + when; offer reason presets. Shots: 17, 19.

**I-14 Title overwritten by task label.** After saving "peel tape", the H1 and the cards show "#1 peel tape" instead of the original clip name. Shot: 07.

**I-15 "Hand overlay" state unclear; status badge cryptic.** On/off differs by background only; corner badge shows "No hand detected", "R ✓", "L ✓" without legend; at 0:10 the caption says right hand but badge shows "L ✓". Fix: aria-pressed + label "Hand overlay: on", legend. Shots: 12–14.

**I-16 "Retry hand pose" vs "Retry from here"** have no explanation; "View logs" is a placeholder; "In progress" has no elapsed time or cancel. Shots: 35, 40, 39.

**I-17 Recipes page does not define recipe** and the two recipes are indistinguishable; Devices shows the raw id; "Recordings in this mock 2" mismatch. Shots: 41, 42.

**I-18 Search focus and duplicate clear controls.** After each search/filter focus jumps to H1, search field loses focus; "Clear all" and "Clear all filters" both shown on empty results. Shot: 24.

**I-19 Customer sees staff status words** ("In 1 dataset", "review practice", Failures tier). Shot: 56.

**I-20 Mobile tap targets** below 44 px (see Mobile).

### Polish

P-01 Grey "Page URL" box with the raw route on every page (looks like a debug strip, wastes space, URLs of 120+ chars on clips). P-02 Every card repeats "Pending review" in Pending Review and "Example data". P-03 "no hand named" on every card. P-04 Heavy orange focus box on H1 after navigation. P-05 Home gives no pending count. P-06 "Processing examples" section on the real Recordings list mixes demo cases with data. P-07 Recipe/Task facets list zero-count items. P-08 Stale text left in a live region ("Returned to Pending Review.") after later actions. P-09 `#/login` reachable while signed in. P-10 Hand overlay and Grid/List lack pressed/current state for assistive tech.

---

## 4. Terminology problems

| Term                                                           | Why unclear                                                    | Plain wording                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Recipe                                                         | Never defined on the page                                      | "Processing recipe: the steps and models used to process a recording"        |
| `@1`, `indego_hosted_canary@1`, `stateaction_mobile@1`         | Version/ID shown as name                                       | Display name + "version 1"; hide IDs in details                              |
| Capture source / Device / Lens / Pose source                   | Unclear difference; "Not recorded" everywhere                  | "Camera app", "Phone", "Lens"; hide empty rows                               |
| Held recordings                                                | Not obvious it means "waiting for you"                         | "Waiting for setup"                                                          |
| Needs setup / Choose a recipe                                  | No next step stated                                            | "Needs a device setup by a developer" / "Pick how to process this recording" |
| Find actions / Generate captions / Track hands / Clip planning | Mixed verbs vs elsewhere ("Segments", "Captions", "Hand pose") | One vocabulary: "Find actions" okay, but link to "Segments" in the player    |
| Used output from run c00dc30c                                  | Run IDs mean nothing                                           | "Reused the result from the earlier run (Nov 24, 10:28)"                     |
| Run / Full run / Rerun / Parent                                | Four related words                                             | "Attempt", "First attempt", "Retry"                                          |
| Retry hand pose vs Retry from here vs Retry failed clips       | Three retries with no difference stated                        | "Retry this step" and "Retry this step and later steps"                      |
| Select parent result / Selected result                         | Jargon for choosing an earlier run                             | "Use the result from an earlier attempt"                                     |
| Rerun debug                                                    | Dev term                                                       | "Frame inspector" (staff)                                                    |
| no hand named / Suggested                                      | "no hand named" = no hand mentioned in caption?                | "Hand not mentioned" / "Suggested name"                                      |
| L ✓ / R ✓                                                      | Unexplained                                                    | "Left hand tracked"                                                          |
| Problems                                                       | Mixed meaning                                                  | "Has failures" with named sub-filters                                        |
| Pending Review / Recycle Bin / Move to dataset / Reject        | "Move" adds; "Reject" sends to Recycle Bin                     | "Needs review", "Rejected", "Add to dataset", "Reject"                       |
| Sharing requires approved current results for every clip       | Unclear policy sentence                                        | "Only reviewed clips can be shared"                                          |
| Workspace ("Return to the workspace")                          | Never named elsewhere                                          | "Go to Home"                                                                 |
| Example data / This preview combines seeded recordings         | Mock wording                                                   | Remove in product                                                            |
| Time budget (recipe)                                           | Unit of what?                                                  | "Max time per step"                                                          |
| IMU, ARCore, H.264                                             | Unexplained                                                    | Hide or tooltip                                                              |

Inconsistent wording found: Move to dataset (header) vs Save to datasets (button) vs "In 1 dataset" vs the brief's "Add to dataset"; Reject vs "Move to Recycle Bin" vs "Rejected"; "Datasets" back link vs "Data browser" title vs "‹ Data browser" back label on a clip reached from a recording; "Original video" vs "Video preview".

---

## 5. Suggestions by theme

**Navigation.** Add a pending count and a "Start reviewing" button on Home. Make a clip row on the recording page open the review page. Make back links name their destination consistently. Hide the route strip. Add search and filters on Recordings.

**Review speed.** Remember label and datasets, "Save & next", keyboard shortcuts, pinned/recent datasets with a type-ahead, remembered tab, auto-advance toggle, visible Undo, prefill label with the suggested name.

**Search/filter.** Keep the strong parts (quoted phrase, `-exclude`, facet counts, chips, URL state). Fix sort order and date display, split Problems, keep focus in the search box, offer typo hints, move per-page to the top, make List dense.

**Processing/retry.** Surface the failed stage and reason on list and recording pages, one "Retry failed stages" action, name the difference between retry choices, add elapsed time and cancel for in-progress runs, real logs.

**Recipes.** One-sentence definition, difference between recipes, show recipe on each recording row, consistent display names, make "Needs setup" actionable.

**Customer view.** Return the same Not found for any inaccessible route, remove staff wording, tell staff which datasets customers can see before saving.

**Accessibility.** aria-pressed for toggles, current state for Grid/List, discoverable tab keys, tame the H1 focus box, bigger touch targets, no stale live-region text.

**Mobile.** Collapse the top chrome, 44 px targets, wrap long names, check the review form (could not drive it).

---

## 6. What worked well

- Search is strong: quoted phrase, exclusion, case-insensitive, highlighted caption hits with timestamps, result chips, "Clear all".
- State lives in the URL: filters, sort, page, layout and per-page survived copy to a new tab, reload, Back and Forward, including scroll.
- 3,011 clips with pagination and 96-per-page showed no lag.
- Failure page for a clip: clear message, stable code, "outputs kept" in the retry dialog with an estimate; Esc and focus return work.
- Keyboard focus ring, focus moved to the H1 and to confirmation messages, skip link, skip of disabled controls.
- Clip player: seek by caption, follow playback, hand overlay really draws, timeline tiers.
- Recipe detail page (flow, compute, budget, recordings that used it).
- Customer: staff routes (`/recipes`, `/recordings`, clips outside dataset, sitemap) all return Page not found; no cost, notes, reviewer, retry or run history on customer pages.
- Empty and no-result states have messages; Page not found exists and is focused.

---

## 7. What I could not test, and why

- Playwright / headless browser: `agent-resource run` refused admission (lane job holding 6 GiB), so I used Orca's embedded browser. No parallel runs.
- 1280x800: pane size was 1045–1305 wide and ~1300 tall; layout looked the same in that range. 200% browser zoom: cannot set zoom or arbitrary viewport; not tested.
- Mobile review form, Move/Reject on mobile: emulation refused clicks ("covered by header#console-header") and scroll did not move; only read layout and sizes. That sticky-header overlap may be a real mobile bug or an emulation artefact: unknown.
- Customer play: customer's dataset in a fresh tab only has example clips (no video), so play and seek as customer were not tested. The one real clip I added was in the earlier tab session, which was lost.
- Datasets search with 50+ datasets, pinned/recent, create dataset: not present (4 datasets only), see I-02.
- "Retry failed stages" on a partially failed recording, planning-failed, cancelled and timed-out examples, Rerun debug tab, Settings, Sitemap content, Sort "Recently added": not opened in depth.
- Screen reader audio: only the accessibility tree and DOM attributes were checked.
- Side effects of my test: I once navigated another worker's tab (`SA-150/index.html#/recordings`) by mistake and restored it to its original URL; the mobile emulation ("iPhone 12") remains set on my test tab; the long recording name and test labels live only in memory of this snapshot session.
