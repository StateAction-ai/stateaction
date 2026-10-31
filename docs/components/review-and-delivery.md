# Data browser and clip review

MVP design · updated 2026-10-31 · Not implemented or deployed. Staff and customer review ship together; Dataset-version creation, export and publication UI are follow-up work.

Use `apps/web` with [auth](auth-and-access.md), [contracts](../contracts.md) and the [Dataset/browser contract](data-browser-and-datasets.md). Customers inspect shared approved videos; they never approve/reject clips.

## Data browser now

| Surface | Behavior |
| --- | --- |
| Pipeline | Staff processing status/errors, cancellation and safe manual retry; not the review entry point |
| `/data-browser` | Shared Dataset list: name, visible video count and total hours |
| `/data-browser?datasetId=UUID` | Video grid: screenshot, friendly title, Task label and basic video metadata |
| Shared clip detail | A grid card opens `/clips/[clipId]` for either role |

Staff creates/names Datasets and adds/removes existing accepted clips. Videos are immutable processing clips; many-to-many membership copies no media. Name/membership edits use `expectedRevision`. Adding videos selects from the accepted catalog, not failed/in-progress jobs. A default human-readable clip title needs no UUID debug field.

Staff sees working membership. Customer counts/hours/grid include only currently approved members of explicitly granted Datasets. Evaluate each response consistently; never leak hidden draft/rejected counts. Operator-managed Dataset grants suffice initially; no sharing or release-management UI is required.

## Shared clip review

Use one Rerun component with separate 2D and estimated-3D panes, preserving missingness/frame mappings without metric claims. There is no Clip review sidebar entry, inspection checkbox, yellow warning box or Other clips section. Staff alone has a Task label, optional notes and approve/reject controls. Approval requires a nonblank label; notes and rejection reasons remain optional. Reviews append against the exact job/manifest/clip/revision; stale edits conflict. Keep clips whole; joint/trim editors remain deferred. [Viewer contract](rerun-clip-review.md)

The compact staff-only **Automatic quality checks** panel shows actual worker statuses for checksum, decode, frame mapping and finite/mask validity, plus measured hand-coverage/missingness percentages. Do not hardcode successful checks; a failed accepted-result invariant blocks acceptance. Coverage is not accuracy. QC, notes and internal provenance remain outside the common RRD/customer payload.

`GET /api/v1/clips/:clipId` returns scoped data/capabilities. `POST /api/v1/clips/:clipId/viewer-access` rechecks the live Dataset grant, membership and approval before issuing the safe RRD URL. Staff reviews use `POST /api/v1/clips/:clipId/reviews` with `expectedRevision`. Membership alone is not permission; another authorized Dataset may independently grant the same clip.

Customers see current approved labels and named authorized Dataset contexts. Removing a member, withdrawing approval or revoking access blocks new working access through that context. Previously issued URLs/loaded bytes cannot be recalled immediately. Test real customer review with operator grants and approved local clips; no published fixture is a prerequisite.

## Whole-Dataset versions and export — follow-up

There is no release builder, publish page or generated Download all requirement in the current UI. The following remains a future contract:

1. Freeze `datasetId`, Dataset name/revision and **every member's** exact approved review/label/file references. Block export if any member is unreviewed/rejected; staff must review or remove it. Never silently select only the approved subset.
2. `export_release` reads that complete frozen selection, stages one TAR on scratch, closes/hashes it, then uses API-issued multipart uploads. API sealing, known execution termination and current lifecycle checks precede `ready`.
3. Staff checks rights/privacy and unchanged Dataset revision/membership and approval before publication. Published Dataset versions require a live Dataset grant and retain named frozen members/labels; subsequent working edits never retarget them. Corrections create another version.

Cap the complete archive at 32 GiB. Reject oversize Datasets; organize smaller Datasets, then version each whole. Include MP4, hand arrays/masks, mappings, labels, format/provenance README and member hashes. RRD can be omitted explicitly; retain the viewer artifact while referenced. The TAR checksum stays outside it. No raw MCAP or hidden scratch dependency is delivered by default.

Future Download all uses direct R2 archive/manifest/checksum URLs, live authorization and Range support. Archive URLs may last 24 hours; revocation stops renewal, and automatic cross-URL resume is not promised. Validate export/extraction/checksums when this follow-up is built; fixture downloads must not imply an implemented exporter.
