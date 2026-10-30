# MVP interfaces and component decisions

Design target · 2026-10-30 · [Clickable offline prototype](../mocks/index.html), [viewing/scenarios](../mocks/README.md). Synthetic data only; the prototype is not the production app.

## Library and visual system

Use **shadcn/ui + Tailwind CSS, with Radix primitives**, for the Next.js web console. Copy only the required components into `apps/web`; pin the generator/dependencies and explicitly select the Radix base. The upstream currently supports multiple bases, so do not rely on its default. This gives us ordinary accessible forms, dialogs and tables without a paid console framework. [Official documentation](https://ui.shadcn.com/docs), [Radix installation option](https://ui.shadcn.com/docs/cli).

shadcn/ui, Radix Primitives and Tailwind CSS each use MIT licenses; retain their copyright/license notices. This decision covers these libraries, not arbitrary third-party registry blocks, icon sets, fonts or assets. Use system fonts and owned assets initially. [shadcn license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md), [Radix license](https://github.com/radix-ui/primitives/blob/main/LICENSE), [Tailwind license](https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE).

**Flutter mobile keeps native Flutter widgets and the existing theme**; React components do not belong in the recorder. Share terminology, status semantics and color tokens rather than a cross-framework component runtime. The HTML mobile mock describes behavior/layout, not a Flutter implementation.

The visual direction is warm white, dark ink, restrained blue, tabular numbers and explicit status text. Use a plain semantic table initially; defer a data-grid dependency. A video player plus an SVG/canvas hand overlay is sufficient; no 3D viewer. The prototype uses handwritten HTML/CSS, not installed shadcn components.

| Need | Production component |
| --- | --- |
| Queue/catalog | Table, Badge, Input, Native Select, pagination only when needed |
| Review | Card, Label, Input, Textarea, Checkbox; HTML video and landmark overlay |
| Confirm cancel/revoke/publish | Alert Dialog; named action and consequence |
| Release selection | Checkbox, Table, Input, Alert, Progress |
| Loading/empty/error | Skeleton, explicit empty Card, Alert, retry action where safe |
| Feedback | Inline validation; status live region/toast for completed mutations |

## Screens and permissions

| Actor/screen | Required behavior |
| --- | --- |
| Collector/login | Google login, identity, access pending/denied; previously authorized offline capture |
| Collector/capture | Visible owner, recording/offline state, stop then finalize/hash; low-disk error; no upload of growing files |
| Collector/upload | Bytes/progress, pause/resume, expiry login, uploaded versus verified; preserve owner-bound local originals/journal |
| Collector/local storage | Explicit original-owner cleanup only after matching server source-hash verification and staff confirmation of the cloud copy; irreversible-local-deletion confirmation names the file/bytes and says cloud source is retained; pending, unverified, failed and partial captures are retained |
| Staff/queue | Recording/upload/job states, failure reason, cancel, safe manual retry and unresolved-submission attention state |
| Staff/review | Whole clip, playback/seek, 21-point overlay toggle, missing observations, task label/notes, approve/reject exact result/revision |
| Staff/releases | Select approved clips, freeze selection, bounded export, failure/retry, ready inventory, explicit publish and named recipient grants/revocation |
| Customer/deliveries | Granted published releases, clip preview, package inventory/limitations, Download all plus manifest/checksum; no review decisions |

The allowlist and role assignment remain operator-managed; no organization/invitation UI. Customers see no collector identity, internal notes or raw MCAP by default. UI visibility is convenience; API authorization enforces every operation. [Auth](auth-and-access.md), [review/export rules](review-and-delivery.md).

## States that must stay distinct

- Offline, expired session, denied access and expired part URL have different recovery actions. A different account cannot adopt or upload another owner's pending recordings.
- Finalizing is not ready; uploaded is not source-verified; processing completion is not human approval; ready export is not published delivery.
- `submit_unknown` blocks automatic retry. Cancellation remains pending until execution resolves; only then can a new attempt start. Stale review conflicts require reload; an approval cannot silently move to a reprocessed result.
- Show missing landmarks as missing. Label the model-relative 3D output **estimated, not validated metric camera/world pose**. A detection percentage describes coverage, not pose accuracy or per-joint confidence.
- Export freezes the selected approved revisions. Publication rechecks that every frozen review is still the latest approved review for its exact job/clip; withdrawal or relabeling requires a new release/rebuild. Published bytes stay unchanged. Exclude rejected clips. The **single TAR's total bytes, including headers/metadata, must not exceed 32 GiB**; an oversized selection fails before export and staff reselect smaller complete releases. No automatic sharding or silent truncation.
- An expired multipart transport restarts under the original owner using the same logical file/content hash and a new transport epoch/key. Show progress resetting and the full re-upload byte cost; ordinary URL/session renewal preserves confirmed progress.
- Never delete local originals automatically after upload. Once the server confirms the matching source hash **and staff confirms the cloud copy**, the original owner may explicitly confirm irreversible local-file deletion. Retain remote source/catalog evidence and all other pending/failed/partial captures; source verification does not imply hand-pose review approval. Low disk blocks new capture; it never silently purges existing originals.
- Revocation blocks new URLs; previously issued archive URLs can remain valid for up to 24 hours. URL renewal requires login and a live grant. Do not promise automatic resume across new URLs.

## Interaction and accessibility contract

Target keyboard use, visible focus, named controls, semantic headings/tables and non-color status indicators. Dialogs retain/trap focus and return it on close. Form errors identify their field; status messages use a live region. Touch targets are at least 44 px on mobile. Keep essential actions usable at 375 px; allow an explicitly labeled table region to scroll when necessary. Never place information solely in hover/tooltips.

The real review player must synchronize overlay coordinates with each source frame/raster transform, expose missingness at seek positions and support keyboard playback. Model outputs and publication limitations remain visible beside the viewer. The synthetic prototype shows interaction intent; it does not establish model quality, frame synchronization, production accessibility or authentication.

Before implementation sign-off, walk through the [scenario inventory](../mocks/README.md) with a collector, reviewer and customer. Before field use, test the real phone, real inference, conflict/recovery cases and complete package extraction/checksums through [local qualification](local-development.md). UI screenshots alone are insufficient.
