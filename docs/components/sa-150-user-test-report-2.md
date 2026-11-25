# SA-150 mock: independent user test report, round 2

Target: `file:///home/wearaway/flora-work/mocks/SA-150-test-snapshot-2/index.html`. Screenshots: `SA-150-test-snapshot-2/usertest/` (names relative to it). Same tester role and rules as round 1: real actions in Orca's embedded browser through the `orca` CLI, no edits, judged by what I saw. Round-1 report: `SA-150-USER-TEST-REPORT.md`.

## 0. Method and limits (read first)

- Playwright was refused again by `agent-resource` ("1 lane job already holds 6 GiB"), so I did not run a headless browser.
- **True 1280x800**: the Orca pane is 767–880 px wide, and no custom size can be set. I loaded the mock in a 1280x800 `<iframe>` inside a local wrapper page (`file:///tmp/ut/wrap/w1280.html`, scaled down for the screenshot) and verified `window.innerWidth x innerHeight` = `1280x800` inside the frame. Real clicks inside a scaled frame sometimes fail ("covered by form"), so in that frame I focused an element and pressed Enter instead of clicking. Pure keyboard paths are therefore tested at 1280x800; mouse paths were tested at the 767–880 px pane.
- **200% zoom**: browser zoom cannot be set. I emulated it the equivalent way: 1280 CSS px at 200% = a 640 CSS px viewport, so I rendered the mock in a 640x640 frame and checked all main routes for horizontal overflow. This tests layout, not the browser's own zoom UI.
- **Mobile**: Orca device emulation "iPhone 15" (393x852). Orca's emulated clicks did not fire on some elements (`Review next` and `Same as last clip` returned "no changes"), while Enter on the same focused element worked. I treat this as an emulator limit, not a mock bug, but I cannot prove that, so touch tap behaviour is **unverified**.
- In the 1280 frame the page shows "Browser storage is unavailable. Changes will be lost on reload." In the direct tab it did not appear. Likely an iframe/file-origin artifact.
- I used my own new tab and closed it. I did not touch other workers' tabs.

---

## 1. Summary

Round 1's headline problems are mostly fixed. The review loop is now fast (1 action per clip with Alt+Enter, 2 with the mouse, vs 6 in round 1), the dataset picker exists with type-ahead, pinned/recent, create-new, "Same as last clip", auto-advance and Undo, customers get "Page not found" on every staff URL, failure reasons show on list rows and recording pages, the long-name overflow is gone, thumbnails exist. The new caption correction flow works end to end. Remaining problems are smaller: inconsistent customer-visible hidden DOM, cramped list-view thumbnails, verbose recording names, a recipes page that still reads as "mock", and unverified touch behaviour on mobile.

### Top 10 issues now, ranked

| #   | ID   | Severity       | Issue                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | N-01 | minor (verify) | Staff-only data stays in the page DOM, hidden, after switching role in the same session (customer view contained hidden "Edited by Seed Staff", "Original model caption", model revision). Not visible, but a script, "view source" or screen reader quirk may reach it. Needs confirming with a fresh customer load (not possible: edits are lost on reload). |
| 2   | N-02 | minor          | List view thumbnails are cramped: "Example data" is clipped to "Exan", the duration chip and status badges overlap the image text (`r2-36-list`).                                                                                                                                                                                                              |
| 3   | N-03 | minor          | Recording names are now unique but long and repetitive: "IndEgo · SA-142 hosted run · Added 24 Nov 2026 · 4 min 59 s · b676a7d4" in lists, headings and breadcrumbs. After rename, the pattern truncates the user's name at 80 characters plus the suffix. All recordings show the same "Added 24 Nov 2026".                                                   |
| 4   | N-04 | minor          | Alt+Enter (repeat last add) works but is only discoverable from the sitemap/README text; the in-page hint says only "Enter selects. Alt+P stars a suggestion". Also Alt+Enter keeps working past the last clip (clip #10 stayed on screen and re-added, no "no more clips" message).                                                                           |
| 5   | N-05 | minor          | "Retry hand pose" vs "Retry from here" on a failed clip still have no explanation of the difference (round-1 I-16 still open).                                                                                                                                                                                                                                 |
| 6   | N-06 | minor          | Recipes: the two main recipes are still visually identical (same stages, same $11.26), one is "a recipe fixture for trying the recipe change flow", counts say "Recordings in this mock"; Devices tab shows raw `indego_hosted_canary@1` instead of "IndEgo processing@1".                                                                                     |
| 7   | N-07 | polish         | Task label field is prefilled with the model's suggested name ("Peel yellow tape") but is a dropdown; with the picker open, `Ctrl+Enter` does nothing in it (only in textareas). Users may expect it to save.                                                                                                                                                  |
| 8   | N-08 | polish         | On mobile, jumping to the Add to dataset form scrolls the page 957 px and leaves the header and the clip title off screen; the "Add to dataset" panel is far below the video. There is no sticky "Save".                                                                                                                                                       |
| 9   | N-09 | polish         | Mobile tap targets: Play/prev/next now 44 px high (fixed), but timeline segment buttons are 22 px, "‹ Pending Review" and "Original video" links 20 px, Save 35 px, dataset search 32 px, "Unstar suggestion" 31 px.                                                                                                                                           |
| 10  | N-10 | polish         | "Page URL" strip is still shown on every page (round-1 P-01).                                                                                                                                                                                                                                                                                                  |

No blockers, no majors found in round 2. Counts: 0 blocker, 0 major, 5 minor, 5 polish listed above (plus the open round-1 items in section 2).

---

## 2. Round-1 issue status

Status: FIXED / STILL OPEN / REGRESSED, with evidence from this round.

| Round-1 ID       | Issue                                                                   | Status                        | Evidence                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-01             | Review loop too slow (6 actions)                                        | **FIXED**                     | Section 5: 2 mouse actions per clip with "Same as last clip", 1 with Alt+Enter; auto-advance after save.                                                                                                                                                |
| I-02             | No real dataset picker                                                  | **FIXED**                     | 58 datasets; type-ahead, Recent / Pinned groups, "Create new dataset “…”", "Same as last clip", keyboard-only works (`r2-10-picker-open`, `r2-12-picker-create`).                                                                                       |
| I-03             | No Undo                                                                 | **FIXED**                     | After add and after reject a green "Undo" bar appears; Undo returned the clip to Pending Review (`r2-14`, `r2-15`, `r2-29`).                                                                                                                            |
| I-04             | Queue opens on dead example clips                                       | **FIXED (partly)**            | Review next starts on a playable real clip (`r2-09`). After the real ones it reaches example clips with "No source video attached", now clearly greyed out (`r2-28`).                                                                                   |
| I-05             | Customer URL leak and wrong error                                       | **FIXED**                     | Customer: 15 staff URLs incl. `datasetId=pending-review`, `recycle-bin`, private dataset id, `?recordingId=`, `datasetId=nope`, processing page, sitemap all show "Page not found".                                                                     |
| I-06             | Failure reason hidden                                                   | **FIXED**                     | List row: "Hand tracking failed. The hand-tracking model could not load." + "Retry failed clips" (`r2-02`, `r2-03`). Recording page repeats it with the same button (`r2-39`).                                                                          |
| I-07             | Needs setup dead end / contradiction                                    | **FIXED**                     | "No capture source matches this phone. Ask an engineer to add it." + "Copy device report" (status "Device report copied.") (`r2-33`). Choose a recipe dialog shows "IndEgo processing@1 · mobile app default" and "Estimated cost $0.93 USD" (`r2-34`). |
| I-08             | Recordings cannot be told apart or searched                             | **FIXED (with N-03)**         | Search by name, source, ID, status filter, sort (Newest/Oldest/Name A–Z). Unique IDs for held items. Names are unique but long.                                                                                                                         |
| I-09             | Long names overflow                                                     | **FIXED**                     | Rename limited to 80 chars (`maxlength=80`); page `scrollWidth 872 = clientWidth 872`; heading wraps (`r2-37`).                                                                                                                                         |
| I-10             | Sort and list semantics                                                 | **FIXED (partly)**            | Cards show "Captured 7 Nov, 1:07 pm"; Recycle Bin sort "Most recently rejected" and my rejected clip is first (`r2-30`); Problems split into Failed action window / Caption failed / No hand detected. List view is denser but cramped (N-02).          |
| I-11             | Clip row opens Processing, not review                                   | **STILL OPEN (by design)**    | Recording row → clip processing page, review via "Open processed clip". README says deliberate.                                                                                                                                                         |
| I-12             | Header Restore then second Restore                                      | **STILL OPEN (by design)**    | Same two-step; README says deliberate.                                                                                                                                                                                                                  |
| I-13             | Reject reason invisible, Enter inconsistent                             | **FIXED**                     | "Rejected · blurry frames · Seed Staff · Nov 24, 8:42 PM" on the clip and on the Recycle Bin card; Ctrl+Enter submits and the field hint says so (`r2-29`, `r2-30`).                                                                                    |
| I-14             | Title overwritten by task label                                         | **STILL OPEN (by design)**    | README: approved label stays as the name. Not retested in detail.                                                                                                                                                                                       |
| I-15             | Hand overlay state unclear, badge cryptic                               | **FIXED**                     | Button text "Hand overlay on", badge "Right hand tracked" / "No hand detected". (Corner badge still reads "No hand detected" at 0:03 of the customer playback while the overlay is on; see S-cust.)                                                     |
| I-16             | Retry choices and logs unexplained                                      | **STILL OPEN**                | "Retry hand pose" vs "Retry from here" still unexplained. Retry dialog is good (what will run, kept outputs, cost).                                                                                                                                     |
| I-17             | Recipes does not define recipe; recipes identical                       | **STILL OPEN (partly fixed)** | Definition added: "A processing recipe defines the steps and models used for a recording." Third recipe card added. FP8 still "fixture", "in this mock", Devices shows raw id (N-06).                                                                   |
| I-18             | Search focus and duplicate clear controls                               | **FIXED**                     | After search focus stays in the search box ("INPUT:q"), typing continues. One "Clear all".                                                                                                                                                              |
| I-19             | Customer sees staff status words                                        | **FIXED**                     | Customer cards/clip: no "In 1 dataset", no "review practice", no staff badges. (See N-01 for hidden DOM.)                                                                                                                                               |
| I-20             | Mobile tap targets below 44 px                                          | **FIXED (partly)**            | Play/prev/next 44 px, Undo 34. Still small: timeline buttons 22 px, links 20 px (N-09).                                                                                                                                                                 |
| P-01             | Page URL strip                                                          | **STILL OPEN**                | Shown on all pages.                                                                                                                                                                                                                                     |
| P-02..P-04, P-07 | Repeated badges, "no hand named", heavy H1 focus box, zero-count facets | **FIXED / changed**           | Cards now show "Not reviewed", "Problem", duration; "no hand named" gone. H1 focus box not re-measured.                                                                                                                                                 |
| P-05             | Home pending count                                                      | **CHANGED**                   | Home no longer exists: login lands on Recordings. Staff still have no "N to review" signal on the first page.                                                                                                                                           |
| P-06             | Demo examples on real Recordings list                                   | **FIXED**                     | Held examples and processing examples are under separate headings.                                                                                                                                                                                      |
| P-08             | Stale live-region text                                                  | **STILL OPEN**                | Live region still keeps the previous message ("Rejected and sent to the Recycle Bin." was announced twice on `r2-29`).                                                                                                                                  |
| P-09             | `#/login` reachable while signed in                                     | **not rechecked**             |                                                                                                                                                                                                                                                         |
| P-10             | No pressed state on toggles                                             | **FIXED (partly)**            | Hand overlay says "on"; Grid/List still show state only by colour.                                                                                                                                                                                      |

No REGRESSED round-1 item found. New, small defects are listed as N-01..N-10.

---

## 3. Scenario log

### S1 Staff review (round 2)

| #   | Action                                            | Result                                                                                                                                                                                    | Verdict        | Shot  |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----- |
| 1   | Open app, sign in as staff                        | Lands on Recordings with search, status filter, sort; 3 processed + held + processing examples. No "N to review" nudge.                                                                   | ok / confusing | r2-01 |
| 2   | Data browser                                      | 4 datasets + 54 example datasets (Training / Eval / Holdout).                                                                                                                             | ok             | r2-07 |
| 3   | Pending Review                                    | Posters, durations, "Not reviewed", "Problem", capture date, "Oldest capture first", Review next.                                                                                         | ok             | r2-08 |
| 4   | Review next                                       | Opens real playable clip (#1 Peel yellow tape) with video, hand overlay on, 75 captions, big timeline.                                                                                    | ok             | r2-09 |
| 5   | Add to dataset                                    | Picker opens with focus in the search box, Recent: Shared pick-and-place (starred), Pinned: Internal holdout; label prefilled with "Peel yellow tape". Hint "Enter selects. Alt+P stars". | ok             | r2-10 |
| 6   | Type "wire", ↓, Enter                             | Chip "Training · Wire a terminal block ×" added; list closes; focus stays in search.                                                                                                      | ok             | r2-11 |
| 7   | Type "shelf", Enter; type "My new holdout 2026"   | Option "Create new dataset “My new holdout 2026”"; Enter creates a chip. 3 chips.                                                                                                         | ok             | r2-12 |
| 8   | Tab to Task label, Enter                          | Saved. Green bar "Added to … It is no longer in Pending Review. Undo". Page advanced to next clip (#1 of other recording).                                                                | ok             | r2-14 |
| 9   | Click Undo                                        | "Returned to Pending Review.", back on the clip.                                                                                                                                          | ok             | r2-15 |
| 10  | Alt+Enter                                         | Repeats last add and advances; kept working on 7 more clips.                                                                                                                              | ok             |       |
| 11  | Reject → Reason → Ctrl+Enter                      | "Rejected and sent to the Recycle Bin. Undo", reason, who, when shown, Restore button below.                                                                                              | ok             | r2-29 |
| 12  | Open Recycle Bin                                  | My clip is first ("Rejected 25 Nov, 1:42 am · blurry frames · Seed Staff"). Sort "Most recently rejected".                                                                                | ok             | r2-30 |
| 13  | "Add to dataset" on a clip, Shared pick-and-place | Helper text "Customers with access to the shared dataset can see this clip after approval." and "Already in: … Remove from this dataset" list.                                            | ok             | r2-24 |

### S2 10 clips in a row (speed test, section 5)

### S3 Find, filter, sort, paginate

| Action                                | Result                                                                                         | Verdict          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| Search `"using the left hand"`        | finds the clip with my corrected caption ("Also matches original" shown for original wording)  | ok               |
| `cable -black`                        | 78 of 3,011, highlights hit text and time ("0:01.0 Coil the power cable…")                     | ok               |
| Typing in the box after a search      | focus stays, text accumulates ("cable -black x")                                               | ok               |
| Filters panel                         | Task label, Recording, Duration, Problems (split in 3); all collapsed by default on this build | ok               |
| Grid / List                           | grid good; list cramped (thumbnail text clipped)                                               | confusing (N-02) |
| Sort names                            | "Newest capture first", "Oldest capture first", "Most recently rejected"                       | ok               |
| URL state, Back/Forward, new-tab copy | not re-tested in full; the same hash scheme as round 1 (layout, q) is used                     | not re-tested    |

### S4 Failed recording and retry

| #   | Action                     | Result                                                                                                                                                                                                            | Verdict                      |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | Recordings list            | Red "Failed", "Hand tracking failed. The hand-tracking model could not load." and "Retry failed clips" right on the row                                                                                           | ok (r2-02/03)                |
| 2   | Click "Retry failed clips" | Dialog per clip: What will run (Track hands), Outputs kept (Find actions / Generate captions from run c0062977), cost "$0.0609 USD (estimate)", "Retry runs only in this mock."                                   | ok (r2-04)                   |
| 3   | Start retry                | Goes to the recording page with `?attempt=1`: "In progress", cost shown, stage list. Merged page: Video preview, Recording details, Clip planning (own runs), Clips with thumbnails. No separate processing page. | ok (r2-05, r2-06)            |
| 4   | Find which recipe          | "IndEgo processing@1 · Default for StateAction mobile app" in header, link opens the recipe page with the job highlighted (`?job=…`).                                                                             | ok                           |
| 5   | Clip processing page       | Find actions / Generate captions / Track hands with Runs (1) each, "Retry hand pose" and "Retry from here", "Open processed clip"                                                                                 | ok / confusing (two retries) |

### S5 Recipes and Devices

Recipes now start with "A processing recipe defines the steps and models used for a recording." Three cards with CPU/GPU tagged stages and a graph that now shows the parallel branch (Track hands beside Find actions). A newcomer can tell CPU vs GPU and which source uses which recipe ("Supports"/"Default for"). Still: the first two recipes look identical, "fixture"/"in this mock" wording, no explanation what "Supports: None" means. Devices tab: one capture source (StateAction mobile app) with a solid arrow to its default recipe, "Add a custom capture device / Defined in code." (looks like an action but is a note). The arrow label is the raw ID. (r2-31, r2-32)

### S6 Needs setup / Choose a recipe

"Fixture inspection · Needs setup": next step is clear (ask an engineer, copy the report), Clip planning stage shows "Waiting", Clips says "Clips appear after planning." "Pixel 9 Pro XL · Choose a recipe": dialog with default preselected and cost; Start processing sent me to the recording page "In progress". ok. (r2-33, r2-34)

### S7 Rename, find, duplicates

Rename takes up to 80 characters and wraps. Recordings search finds by ID (`f4878995`), by source (`User_15`), by word ("hosted"), by device ("stateaction" matched the Pixel/StateAction held row), and shows nothing for "zzzz" (empty list with no message, see below). Duplicates: all rows are now unique, but a name like "Pixel 9 Pro XL · 24 Nov, 1:11 pm · 4 min 59 s" vs "Fixture inspection · Added 24 Nov 2026 …" mixes two formats.

Minor: with the search "zzzz" the Recordings list showed an empty "All recordings" area with no "No recordings match" text (the empty-state message was not found in the page text) (r2-02).

### S8 Edge cases

| Case              | Result                                                                                                                                                                                                           | Verdict   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Long name         | 80-char cap, no overflow                                                                                                                                                                                         | ok        |
| Empty dataset     | not re-run; example datasets show "0 clips" and are clickable (54 empty datasets on the Data browser page make the page long)                                                                                    | confusing |
| No preview image  | every clip now has a poster; example clips show a grey tile "Example data" with duration                                                                                                                         | ok        |
| Removed URL       | "Page not found" (customer and staff)                                                                                                                                                                            | ok        |
| Keyboard          | picker, Tab to label, Enter to save, Alt+Enter, Ctrl/⌘+Enter, Esc all work                                                                                                                                       | ok        |
| 1280x800          | layout fine: sidebar + content, 2-column grid, review page with player and side panel                                                                                                                            | ok        |
| 200% (640 CSS px) | no horizontal overflow on 8 routes (`scrollWidth 630 = clientWidth 630`), nav stays flex, buttons wrap; Settings 640=640 (r2-z02, r2-z03)                                                                        | ok        |
| Accessible names  | Spot checks via snapshot: "Hand overlay on", "Undo last edit", "Copy clip ID …", picker combobox has name "datasetSearch" as input name; the Add form's search has a visible label "Choose one or more datasets" | ok        |

---

## 4. New features

### Caption correction

| Step                                                                                          | Result                                                                                                                                                                                                                                              | Verdict       | Shot  |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----- |
| Segments tab: buttons per caption: Correct / Incorrect / Other issue (Boundary, Hand pose, …) | present                                                                                                                                                                                                                                             | ok            |       |
| Click Incorrect                                                                               | Inline editor "Corrected caption" prefilled with model text, "Caption not needed" checkbox, Save correction / Cancel, hint "Ctrl+Enter or ⌘+Enter saves. Esc cancels." Focus in the textarea.                                                       | ok            | r2-16 |
| Save unchanged (Ctrl+Enter)                                                                   | Error "Change the caption or choose Caption not needed."                                                                                                                                                                                            | ok            |       |
| Empty then save                                                                               | "Enter a corrected caption or choose Caption not needed."                                                                                                                                                                                           | ok            | r2-17 |
| Type new text, Ctrl+Enter                                                                     | "Caption correction saved." Caption in list, in the video overlay and the timeline label ("Caption") update; row shows "Caption issue · Edited by Seed Staff, Nov 24, 8:38 PM", Show original / history, Undo last edit. Focus on "Undo last edit". | ok            | r2-18 |
| Show original / history                                                                       | "Original model caption: nvidia/Flora-Captioner · revision 669b3f49…" then "Revision 1 · Seed Staff · time · text"                                                                                                                                  | ok            | r2-19 |
| Typing then Esc                                                                               | Dialog "Discard your unsaved changes?" with Keep editing / Discard changes; focus on Keep editing                                                                                                                                                   | ok            | r2-20 |
| Discard                                                                                       | editor closes                                                                                                                                                                                                                                       | ok            |       |
| "Caption not needed"                                                                          | Textarea disabled; saved; caption shows "Caption not needed"                                                                                                                                                                                        | ok            | r2-21 |
| Undo last edit (twice)                                                                        | first Undo restored the previous text (history entry added); second Undo button was gone (no more edits to undo)                                                                                                                                    | ok            | r2-22 |
| Ctrl+Enter and ⌘+Enter (Meta+Enter)                                                           | both save                                                                                                                                                                                                                                           | ok            |       |
| Edited text in search                                                                         | `"using the left hand"` finds it; `"off the top of the projector"` (original wording) finds it too, labelled "Also matches original" and "1 caption corrected"                                                                                      | ok            | r2-23 |
| Customer: search the edited phrase                                                            | 1 result with the edited text                                                                                                                                                                                                                       | ok            |       |
| Customer: search the original phrase                                                          | 0 results                                                                                                                                                                                                                                           | ok            |       |
| Customer clip page                                                                            | no Review actions tab, no Correct/Incorrect/Edited by, no Show original / history in visible text; shows the edited caption and "Download captions"                                                                                                 | ok            | r2-27 |
| Customer hidden DOM                                                                           | 4 hidden leaf nodes with "Edited by" / "Original model" / model revision still exist from the previous staff view in the same session                                                                                                               | verify (N-01) |       |

### Merged recording page

Video preview, Recording details, **Clip planning** (with its own status pill, compute/duration/cost, "Runs (0)" and a collapsed "Measured planning example from another recording"), and **Clips** with thumbnails, ranges, status. No separate processing page. Header: status, total estimated cost, recipe, Rename, Retry. Clear and a good replacement. The page title was "IndEgo · Failed hand-pose run · Added 24 Nov 2026 · 4 min 59 s · f4878995" (long). A hidden heading "Restore to Pending Review" and "Annotation tiers" exist in the heading list from other hidden pages (assistive tech risk: `main h2` returned them though invisible).

### Failed reasons and retry on list rows, Needs setup wording

See S4 and S6. Fixed.

### Recording list search / sort / filter

Search by name/ID/source/device works; status filter has All, Failed, In progress, Held, Succeeded; sort Newest/Oldest/Name A–Z. Focus stays on H1 after a search submit in the Recordings list (unlike clip search, which keeps the box) — inconsistent. Empty-result message missing.

### Thumbnails for each clip

Real clips: midpoint frames (varied, e.g. hands near projector, PC internals). Example clips: grey tile "Example data" + duration chip + badges ("Not reviewed", "Problem", "Rejected"). In lists and on clip pages (top right). Good. In list view cramped (N-02). On the clip page the poster in the header is redundant with the video right below.

---

## 5. 10-clips speed test

Setup: Pending Review, 1280x800 frame, keyboard focus + Enter (equivalent to a click).

| Clip                                              | Actions    | Detail                                                                                                                                                                      |
| ------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First clip (cold start)                           | 7          | Review next, Add to dataset, type "Shared", Enter (select), Tab, (Ctrl+A and type label), Enter.                                                                            |
| Clips 2–11, method A (mouse, "Same as last clip") | **2 each** | click "Add to dataset", click "Same as last clip". Saved, auto-advanced, 10 of 10 clips succeeded (hash moved each time: bb2, ba7, ba8, ba4, ba5, ba6, b9b, b9c, b9d, b9e). |
| Clips 2–11, method B (keyboard)                   | **1 each** | Alt+Enter. Saved and advanced 7 of 7 times, then stuck on the last example clip.                                                                                            |
| Choose different dataset + new label              | 5          | Add to dataset, type, Enter, Tab, Enter (label prefilled).                                                                                                                  |

Round 1 was 6 actions per clip and 3 mouse trips. Round 2: **1 action (keyboard) or 2 clicks per clip** with zero mouse travel in the keyboard case; no tab switching, no label typing. No video was played in this test; adding "watch the clip" adds Play and a seek in the real loop. Mobile (393 px): "Same as last clip" worked via keyboard Enter, taps unverified.

Notes: the picker needs one extra Tab after selecting to reach the label; Alt+Enter is not shown in the picker hint (N-04).

---

## 6. Customer scenario (re-run)

| Action                                                       | Result                                                                                                              | Verdict                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Sign in as customer                                          | Lands on Shared pick-and-place (1,202 clips: it counted the clip I added as staff). Nav: Data browser, Settings.    | ok                     |
| Controls                                                     | Search, Filters (Task label), Sort ("Newest capture first"), Grid/List, Download captions, thumbnails with duration | ok                     |
| Search, open a clip, play                                    | Real clip plays (3.3 s after 3 s), hand overlay and captions shown, Segments tab only                               | ok (first time tested) |
| Typed staff URLs (15)                                        | all "Page not found"                                                                                                | ok                     |
| Staff-only text                                              | none visible; hidden DOM caveat N-01                                                                                | ok / verify            |
| Customer "No hand detected" badge at 3 s while overlay is on | content question (data), badge may be right; I could not verify the overlay at that frame                           | unclear                |

---

## 7. Terminology (new or still open)

| Term                                          | Why unclear                         | Plain wording                                  |
| --------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| Held examples / Held                          | Still "waiting for you" in disguise | "Waiting for setup"                            |
| Retry from here                               | Not explained                       | "Retry this step and later steps"              |
| Caption issue (label under an edited caption) | Reads like a status, not "edited"   | "Edited"                                       |
| Boundary / Hand pose (under Other issue)      | Jargon                              | "Start/end is wrong", "Hand tracking is wrong" |
| "Example dataset · 0 clips"                   | 54 empty datasets read as real      | group them under "Examples"                    |
| `indego_hosted_canary@1`                      | raw ID shown as name on Devices     | "IndEgo processing (v1)"                       |

---

## 8. Suggestions

**Review speed.** Show "Alt+Enter: repeat last add" in the picker hint; stop at the end of the queue with a clear message; keep "Same as last clip" visible without opening the picker.

**Search/filter.** Fix the clipped list thumbnails; add an empty state to the Recordings list; keep focus in the search box on Recordings too.

**Processing/retry.** Explain "Retry hand pose" vs "Retry from here".

**Recipes.** Collapse the fixture recipes behind "Show test recipes"; show display names on Devices.

**Customer view.** Confirm the hidden DOM issue in a fresh customer session.

**Accessibility.** Remove hidden pages from the DOM or `inert` them; announce Undo with a status that clears; Grid/List `aria-pressed`.

**Mobile.** 44 px targets for timeline segments, links, Save; keep the header and a sticky Save when the picker is open.

---

## 9. What worked well

- Add-to-dataset flow: type-ahead, create new, Recent/Pinned, Same as last clip, Alt+Enter, Undo, auto-advance.
- Reject shows reason/who/when and has Undo; Recycle Bin sorted by rejection time.
- Caption correction: inline editor, clear validation, history with model revision, Undo, discard warning, both Ctrl and ⌘ Enter, edited text drives search/captions/customer view, originals hidden from customers.
- Failure info on the row with the reason and retry; retry dialog states what runs, what is kept, and cost.
- Merged recording page.
- Customer: clean "Page not found" everywhere, real video plays, controls limited as promised.
- Real clips have thumbnails.
- 640 px width (200% zoom equivalent): no horizontal scroll on 8 routes.

---

## 10. What I could not test, and why

- Playwright / headless: refused by the resource guard.
- Browser zoom UI: emulated with a 640 CSS px frame instead. Touch taps on mobile: Orca's emulated clicks did not fire on some elements; keyboard on the same elements worked, so end-to-end mobile review was done by keyboard (Review next → Add to dataset → Same as last clip → saved and advanced, Undo bar shown), not by touch.
- Reload persistence (README says the review decisions survive reload): storage reported "unavailable" in the iframe, so I could not confirm.
- Fresh customer session with the staff edit present, to confirm N-01.
- Browser Back/Forward and new-tab URL copy across filters, the "Recently added" sort, the sitemap pages for loading poster and picker states, Settings, Download captions JSON contents.
- "Retry failed clips" on a multi-clip partial failure, cancelled/timed-out examples, "Reprocess with another recipe".
- Screen-reader audio.
