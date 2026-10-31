# MVP interfaces and component decisions

Design target · 2026-10-31 · [Offline prototype](../mocks/index.html), [routes and scenarios](../mocks/README.md). Synthetic data only; no production application or real Rerun runtime is installed by this mock. Pipeline list/detail have no Scenario selector. The list has search/status filtering; recording actions live only on the detail page. Scenario selectors elsewhere are demo-only.

## Components

Use **shadcn/ui + Tailwind CSS, with Radix primitives**, around the web application. Copy only required components into `apps/web`; pin their versions and explicitly select Radix. These libraries use MIT licenses; retain required notices. This does not cover arbitrary third-party registry blocks, fonts or assets. Use system fonts and owned assets initially. [shadcn docs](https://ui.shadcn.com/docs), [shadcn license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md), [Radix license](https://github.com/radix-ui/primitives/blob/main/LICENSE), [Tailwind license](https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE).

**Use Rerun for the shared clip viewer.** The selected implementation embeds framework-agnostic `@rerun-io/web-viewer` **0.22.1** in a small Next.js client-only React adapter, with matching Python Rerun SDK/assets. Keep the browser runtime out of server rendering, give it explicit dimensions and self-host pinned assets. The package/version decision and authorized RRD loading belong to [Rerun clip review](rerun-clip-review.md). Do not introduce a second custom production video/skeleton renderer. Rerun's open-source SDK/viewer is dual licensed MIT or Apache-2.0; preserve required notices and review bundled dependencies. This does not require buying a hosted Rerun service. [Official embed guide](https://rerun.io/docs/howto/integrations/embed-web), [license overview](https://rerun.io/docs/reference/about), [MIT](https://github.com/rerun-io/rerun/blob/main/LICENSE-MIT), [Apache-2.0](https://github.com/rerun-io/rerun/blob/main/LICENSE-APACHE).

Flutter keeps its existing native widgets/theme. Share terminology and status semantics, not a React runtime. The mock uses handwritten HTML/CSS/SVG, including a **clearly marked synthetic stand-in for Rerun**; it does not load private data, WASM, RRDs or external scripts.

| Need | Production component |
| --- | --- |
| Pipeline list | Compact four-column recording table; wrapped fields, semantic recording links and no row action controls |
| Pipeline recording detail | Source/status/error cards, responsive milestone list and the applicable review/recovery action |
| Dataset list | Table rows with dataset name, visible Clips count and Total hours |
| Dataset detail | Responsive screenshot grid: title, task label, duration and resolution |
| Dataset editing | Dialog/Input for New dataset; Approved-only Checkbox picker for Add clips and Assign to datasets |
| Clip inspection | One Rerun embed: RGB, 21 landmarks and timeline; optional data/estimated-3D panes |
| Staff clip review | Task-label Input, optional notes, optional dataset checklist, direct Approve/Reject |
| Automatic QC | Staff-only neutral worker-results list; integrity, decode, mapping, arrays and coverage |

## Names and navigation

Use **Dataset** for a named group of approved clips, **Recording** for the original capture/upload and **Clip** for an immutable accepted processing-result segment. A clip can belong to several datasets. Dataset version means a future frozen release of the **whole dataset**. [Naming/routes](data-browser-and-datasets.md).

The sidebar contains **Pipeline** (staff only), **Data browser** (staff and customers), and a separate collector demo. There is no Clip review, Releases or Deliveries navigation/page. Staff default to the Data browser. The Pipeline shows operational status/errors and recoveries. Each recording row opens its staff-only Pipeline detail. All actions live there. The completed example detail has **Review clips**, which opens the recording-scoped All clips grid; completed processing does not mean human approval.

The Data browser initially lists datasets with name, Clips count and Total hours. Selecting a row opens its screenshot grid. Staff can create a named dataset, add only approved clips through a picker, and assign an approved clip to multiple datasets without copying media. The staff-only **All clips** tab exposes every accepted processing-result clip, including unreviewed/unassigned clips; it is not a separate sidebar page. New datasets are staff-only; an operator manages customer dataset grants. Do not add grant administration, publication or export controls to this UI.

| URL state | Behavior |
| --- | --- |
| `/data-browser` | Dataset list; `q` searches visible dataset names |
| `/data-browser?datasetId=…` | Dataset-scoped grid of approved members only, for staff and customers |
| `/data-browser?view=clips` | Staff-only All clips review grid, including unreviewed and unassigned clips |
| Grid `q`, `label`, `reviewStatus`, `recordingId` | URL-persisted title/task filters; staff All clips supports review status and a fixed recording filter; its recording-name link returns to Pipeline details |
| `/data-browser?recordingId=<uuid>` | Staff grid of all generated clips from that recording; optional manual review-status filter |
| `/pipeline?status=…&q=…` | Compact Recording / Collector / Source / Status list; no Actions column or buttons |
| `/pipeline/[recordingId]` | Recording-specific stages, source metadata, progress/errors and all applicable actions; Back retains list filters |
| `/clips/[clipId]` | Same immutable clip page/viewer for both roles; no raw ID/path shown in page |

The offline prototype mirrors these routes in its hash. Opening a clip retains its Data browser return URL/filter context in memory. Changing the DEMO actor on a clip keeps its URL unchanged. Reprocessing creates a new clip ID; old links never resolve through `latest`.


Pipeline detail shows **Upload → Queued → Processing → Quality checks → Ready for review** with text/icons for done, in progress, failed, unknown, stopped and not started. These are conceptual progress milestones, not separate workflow tasks. Decode, hand estimation, review-media writing and checks overlap in one streaming pass; source SHA verification completes at EOF within quality checks. Never imply the entire source is verified before it is read.

Use only the applicable detail action: Review clips, Cancel, Check status, Retry, Request re-upload or Check execution. Unknown acknowledgement never exposes a blind retry. Cancellation must be confirmed terminal before Retry. List rows and recording anchors open the detail; at mobile width their four fields stack so source/status/error text remains visible without horizontal clipping.

## Sharing and clip review

**Datasets contain approved clips only for both staff and customers.** New dataset membership requires the current approved review; rejected clips are reviewed but ineligible. Rejection/withdrawal removes every working membership; reapproval never silently restores earlier assignments. Customers see only datasets explicitly shared with them. Counts/hours derive from that visible set; unreviewed/rejected clips, draft memberships, internal notes, collector identity and staff-only QC never enter the customer payload. Dataset membership alone does not bypass review/access checks. Removal, review withdrawal/rejection and grant revocation block newly authorized access. A clip with another valid shared-dataset context may remain accessible through that independent grant. Customer labels come from the current approved review in an authorized dataset.

No release is required to test the customer workflow. **Dataset versions, whole-dataset export, publication and downloads are follow-up work**; the mock has no active release/export/download controls. Future versions pin the whole dataset's immutable membership and labels, with a separately defined delivery/download contract.

Both roles use the same Rerun viewer. Staff see task label, optional notes, an optional dataset checklist and Approve/Reject; customers see the approved label and read-only dataset context. Keep review simple: **watch → task label → approve/reject**. Approval validates a nonblank label, current review revision and affected dataset revisions, then saves the review and exact selected memberships together. Unsaved dataset selections stay with the clip through viewer rerenders and stale-review reloads, then rebase from saved memberships after approval/rejection. Checking a dataset changes no membership before approval; failed/stale saves change neither review nor membership. No dataset selection is required. Already approved clips initially show their existing assignments; unreviewed/rejected clips show none. Rejection notes are optional and rejection removes all memberships. No inspection checkbox, rejection modal, other-clips section or large yellow warning. Label estimated 3D quietly in the viewer.

**Automatic quality checks** below the staff viewer report actual worker status/explanation: source SHA match, MCAP/RGB decode, frame mapping, valid/masked 21-point arrays, detection coverage and missing-frame percentage. Mapping completeness does not establish cross-clock synchronization; coverage is not pose accuracy. Missing-frame scenarios show warnings. Failed decode makes the preview unavailable and blocks review. Anatomical/metric accuracy remains not evaluated.

Authorize the **actual Rerun payload**, not just its visible entities. Do not send raw MCAP, staff notes or unapproved clips and rely on a blueprint to hide them. Direct customer links choose a deterministic authorized dataset context rather than a latest draft. The HTML includes synthetic fixtures for both demo actors and proves no production security. [Auth](auth-and-access.md), [viewer contract](rerun-clip-review.md).

## Capture and recovery

Preserve owner-bound offline journals. Separate signed-part URL renewal, session reauthentication and seven-day transport restart; restart keeps logical file/hash/owner, advances transport epoch/key and warns of full re-upload cost. Finalizing is not upload-ready; uploaded is not verified; processing completion is not approval. Camera denial, unclosed capture and low disk never trigger silent file deletion.

Unknown compute submission blocks blind retry; cancellation must resolve to a known terminal execution before a new attempt. Stale reviews require reload. Only the original owner may explicitly delete a local original after matching server SHA verification and staff cloud-copy confirmation; show file/bytes and irreversible local-only confirmation. Retain pending/unverified/failed/partial captures and cloud evidence.

## Accessibility and implementation checks

Use named controls, visible focus, semantic tables/headings, keyboard playback and status live regions. Destructive dialogs retain/return focus. Make mobile targets usable at 375 px; scope horizontal scrolling to tables. The prototype's controls are review aids, not evidence of production accessibility, anatomical accuracy or synchronized RRD playback.

Walk the [scenario inventory](../mocks/README.md) with staff, a collector and a customer. Qualify the real Rerun embed, authorized payloads, representative hand observations, recovery paths and real dataset access and capture recovery through [local development](local-development.md) before field use.
