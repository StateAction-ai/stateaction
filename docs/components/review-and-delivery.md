# Data browser and clip review

MVP design · updated 2026-10-31 · Not implemented or deployed. Staff and customer review ship together; Dataset-version creation, export and publication UI are follow-up work.

Use `apps/web` with [auth](auth-and-access.md), [contracts](../contracts.md) and the [Dataset/browser contract](data-browser-and-datasets.md). Customers inspect shared approved videos; they never approve/reject clips.

## Data browser now

| Surface | Behavior |
| --- | --- |
| `/pipeline` | Compact staff status rows with no action buttons; click a row to open its source recording detail |
| `/pipeline/[recordingId]` | Staff stage visualization, metadata/errors and all applicable actions: Review clips, Cancel, Retry, reupload and reconcile |
| `/data-browser` | Shared Dataset list: name, visible video count and total hours |
| `/data-browser?datasetId=UUID` | Video grid: screenshot, friendly title, Task label and basic video metadata |
| `/data-browser?view=clips` | Staff All clips: accepted pending/approved/rejected clips; optional `recordingId` and `reviewStatus=pending` filters |
| Shared clip detail | A grid card opens `/clips/[clipId]` for either role |

Pipeline detail presents **Upload → Queued → Processing → Quality checks → Ready for review** using actual upload/job/worker evidence. Unknown progress stays unknown; inferred stages are marked. Decode, hand estimation and RRD generation share one invocation, and source hashing completes at EOF in final quality checks; the visualization introduces no task DAG. Keep recording titles friendly and omit raw IDs/paths. Preserve Pipeline filters/back navigation. [Pipeline contract](pipeline-monitoring.md)

From recording detail, **Review clips** opens `/data-browser?recordingId=UUID`. A thumbnail opens `/clips/[clipId]`, where staff reviews and chooses Datasets. Cancellation/retry/reupload/reconciliation controls live on recording detail, subject to current server capabilities; none appear in Pipeline rows.

Staff creates/names Datasets and adds/removes **approved** clips. Add videos offers only clips whose latest review is approved. Many-to-many membership copies no media; edits use the expected Dataset revision. Datasets never contain pending/rejected clips for either role. Review unassigned clips through staff All clips; it is forbidden to customers. Friendly titles need no UUID debug field.

Staff/customers share approved-only Dataset eligibility; customer grants further restrict visibility. Counts/hours/grid use consistent membership/review state. Operator grants suffice; no sharing or release-management UI is required.

## Shared clip review

Use one Rerun component with separate 2D/estimated-3D panes and source-frame mappings. No Clip review sidebar, inspection checkbox, yellow warning box or Other clips section. Staff form: **Task label, optional Datasets multi-select, optional notes, Approve/Reject**. Approval requires a nonblank label; notes/rejection reasons are optional. Keep clips whole; defer joint/trim editors. [Viewer contract](rerun-clip-review.md)

Reviewing a pending clip may select destination Datasets, but assignment happens only with successful approval. Submit optional `datasetSelection:{datasetIds,expectedRevisions}` as the complete desired membership set; the UI sends its current choices. Omission preserves membership; explicit `datasetIds:[]` clears it. Expected Dataset revisions cover current and selected memberships. The API appends approval and applies membership atomically; stale/failed approval changes neither. Record that selection with the immutable review.

Reject/withdraw ignores selection and removes the clip from **every working Dataset** in the same transaction, advancing affected revisions. Reapprove with explicit choices to assign again; previous memberships are not restored. All direct-add/review operations share clip-first/Dataset-order locking. Test concurrent add versus rejection. Published follow-up versions remain frozen; revoke their access separately.

The compact staff-only **Automatic quality checks** panel shows actual worker statuses for checksum, decode, frame mapping and finite/mask validity, plus measured hand-coverage/missingness percentages. Do not hardcode successful checks; a failed accepted-result invariant blocks acceptance. Coverage is not accuracy. QC, notes and internal provenance remain outside the common RRD/customer payload.

`GET /api/v1/clips/:clipId` returns scoped capabilities. `POST /api/v1/clips/:clipId/viewer-access` rechecks the customer's live Dataset grant/membership/approval; staff can inspect All clips independently. Staff reviews use `POST /api/v1/clips/:clipId/reviews` with `expectedRevision`. Membership alone is not permission.

Customers see current approved labels and named authorized Dataset contexts. Removing a member, withdrawing approval or revoking access blocks new working access through that context. Previously issued URLs/loaded bytes cannot be recalled immediately. Test real customer review with operator grants and approved local clips; no published fixture is a prerequisite.

## Whole-Dataset versions and export — follow-up

There is no release builder, publish page or generated Download all requirement in the current UI. The following remains a future contract:

1. Freeze `datasetId`, Dataset name/revision and **every member's** exact approved review/label/file references. Block export if any member is unreviewed/rejected; staff must review or remove it. Never silently select only the approved subset.
2. `export_release` reads that complete frozen selection, stages one TAR on scratch, closes/hashes it, then uses API-issued multipart uploads. API sealing, known execution termination and current lifecycle checks precede `ready`.
3. Staff checks rights/privacy and unchanged Dataset revision/membership and approval before publication. Published Dataset versions require a live Dataset grant and retain named frozen members/labels; subsequent working edits never retarget them. Corrections create another version.

Cap the complete archive at 32 GiB. Reject oversize Datasets; organize smaller Datasets, then version each whole. Include MP4, hand arrays/masks, mappings, labels, format/provenance README and member hashes. RRD can be omitted explicitly; retain the viewer artifact while referenced. The TAR checksum stays outside it. No raw MCAP or hidden scratch dependency is delivered by default.

Future Download all uses direct R2 archive/manifest/checksum URLs, live authorization and Range support. Archive URLs may last 24 hours; revocation stops renewal, and automatic cross-URL resume is not promised. Validate export/extraction/checksums when this follow-up is built; fixture downloads must not imply an implemented exporter.
