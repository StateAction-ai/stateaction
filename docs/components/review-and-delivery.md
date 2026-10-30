# Internal review and customer delivery

MVP design · updated 2026-10-30 · Both workflows ship first; not implemented or deployed.

**Staff reviews and publishes. Customers inspect granted releases and download all approved trainable data.** They never approve/reject clips. Build both in `apps/web`; follow [auth](auth-and-access.md) and [contracts](../contracts.md).

## Staff workflow

| Screen | Minimum behavior |
| --- | --- |
| Upload/jobs list | Owner, recording, queued/running/failed state, actionable error and manual retry/cancel |
| Clip review | Play bounded clip with 21 hand-landmark overlay; inspect missing detections/QC and source-time mapping |
| Review decision | Set a whole-clip task label/notes and approve or reject the exact job/manifest/clip |
| Release builder | Select approved review revisions, name the release, choose customer recipients and request export |
| Publish | Inspect completed export inventory and publish; revoke future access when needed |

Separate image landmarks from **estimated 3D hand coordinates**. Mask missing/occluded detections; preserve source-frame/time mappings. Overlays do not establish calibrated actions, global trajectories or metric accuracy.

Keep clips whole and rejected clips out of delivery. Defer joint/trim editors, configurable taxonomies and split policies. Reviews append and pin the job, manifest hash, clip and label. Stale edits conflict; reprocessing never rewrites approvals.

## Export and publication

1. Freeze approved reviews and create an export job transactionally. After commit, request `export-release`; repair cron recovers missed starts.
2. The task invokes `export_release` through `LocalExecutor` locally or `ModalExecutor` on Render. Package the approved clips/hands/masks/mappings/labels into bounded scratch TAR, close/hash it, then upload with manifest/checksums. Check archive contents inline.
3. Output keys are unique. Every upload uses API-issued multipart IDs, including manifests; the API completes and seals the output inventory. No worker can reopen those keys or upload after sealing.
4. The finish callback is provisional. API reconciliation requires the known exporter terminal, closed expected outputs, unchanged frozen selection and active release/job before marking `ready`.
5. Staff explicitly publishes the ready release and recipient grants after checking permitted use/privacy. Publication rechecks that every frozen review is still the latest approved revision for that exact job/clip. A withdrawn approval or changed label blocks the draft with a create-new-release action; already-published bytes stay fixed and staff may explicitly revoke access. Corrections create another release; published bytes and checksums never change.

The archive contains **all approved data selected for that release**: videos, 21-landmark observations and declared 3D estimates, validity/missingness masks and handedness scores, source-time mappings, labels, model/schema provenance and format README. The archive checksum stays outside it; internal manifests list member hashes. No hidden scratch/expiring URL dependencies belong inside. Test extraction/sample reads. Exclude raw MCAP by default; identify missing channels rather than fabricate targets.

Operators check collection/model rights and privacy before publication, recording evidence in release metadata. No policy engine is needed. Withhold data requiring unavailable redaction.

## Customer workflow and downloads

Customers list granted published releases with clip examples, archive bytes, inventory and limitations. **Download all** points to the complete TAR, alongside its immutable manifest and checksum file. All media/download bytes come directly from R2.

Authorize each URL issuance against current user access, grant and publication state. Use short preview URLs and up to 24-hour archive URLs for long transfers. R2 must serve Range requests; test normal browser pause/resume while the URL is valid. Expired URLs can be reissued after login; automatic cross-URL resume is not promised. Revocation blocks new issuance, while an existing archive URL may remain usable for its remaining lifetime.

Start with a 32 GiB archive ceiling and measured scratch allowance. Reject larger selections before export and have staff create smaller complete releases; never silently truncate. The archive is staged on scratch so its exact size/SHA are known before reserving its multipart upload. This avoids a new unknown-length upload protocol. No separate download-session service or custom CLI ships initially. Pilot acceptance requires customer isolation, stale-review rejection, complete archive extraction/checksums, valid hand masks/mappings and the full collector-to-customer path.
