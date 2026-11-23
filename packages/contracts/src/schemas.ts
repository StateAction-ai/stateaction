// Generated listing of the published schema files; keep in sync with api/catalog.v18.json (checked by tests).
// catalog.v18.json is the current registry: an exact superset of the immutable
// catalog.v17.json (adds only the SA-99 segment mark contracts), itself a superset of the immutable
// catalog.v16.json (adds only http.recording-annotations.v1, SA-98), itself a superset of the immutable
// catalog.v15.json (adds only jobs.prior-stages.v1, SA-91), itself a superset of the immutable
// catalog.v14.json (adds only http.output-create.v2 and http.output-plan.v2, SA-103), itself a superset of the immutable
// catalog.v13.json (adds only the SA-87 segment, caption, recipe and stage-run contracts and the
// shared common.v2.schema.json), itself a superset of the immutable
// catalog.v12.json (adds only the SA-73 source-copy confirmation and cleanup-proof contracts), itself a superset of the immutable
// catalog.v11.json (adds only jobs.job-status.v2, SA-42), itself a superset of the immutable
// catalog.v8.json, itself an exact superset of the immutable catalog.v7.json, itself an exact superset of the immutable catalog.v6.json,
// itself an exact superset of the immutable catalog.v5.json,
// catalog.v4.json, catalog.v3.json, catalog.v2.json and catalog.v1.json.
import catalog from "../api/catalog.v18.json" with { type: "json" };
import common from "../api/common.v1.schema.json" with { type: "json" };
import commonV2 from "../api/common.v2.schema.json" with { type: "json" };
import s0 from "../api/artifacts/frame-map.v1.schema.json" with { type: "json" };
import s1 from "../api/artifacts/hand-observations.v1.schema.json" with { type: "json" };
import s2 from "../api/artifacts/processing-result.v1.schema.json" with { type: "json" };
import s3 from "../api/artifacts/recording-source.v1.schema.json" with { type: "json" };
import s4 from "../api/http/error-envelope.v1.schema.json" with { type: "json" };
import s5 from "../api/http/parts-receipts.v1.schema.json" with { type: "json" };
import s6 from "../api/http/parts-sign.v1.schema.json" with { type: "json" };
import s7 from "../api/http/parts-signed.v1.schema.json" with { type: "json" };
import s8 from "../api/http/recording-create.v1.schema.json" with { type: "json" };
import s9 from "../api/http/recording-seal.v1.schema.json" with { type: "json" };
import s10 from "../api/http/recording.v1.schema.json" with { type: "json" };
import s11 from "../api/http/success-envelope.v1.schema.json" with { type: "json" };
import s12 from "../api/http/upload-create.v1.schema.json" with { type: "json" };
import s13 from "../api/http/upload-plan.v1.schema.json" with { type: "json" };
import s14 from "../api/http/upload-transition.v1.schema.json" with { type: "json" };
import s15 from "../api/jobs/claim-grant.v1.schema.json" with { type: "json" };
import s16 from "../api/jobs/controller-input.v1.schema.json" with { type: "json" };
import s17 from "../api/jobs/heartbeat.v1.schema.json" with { type: "json" };
import s18 from "../api/jobs/job-status.v1.schema.json" with { type: "json" };
import s19 from "../api/jobs/result-candidate.v1.schema.json" with { type: "json" };
import s20 from "../api/jobs/task-input.v1.schema.json" with { type: "json" };
import s21 from "../api/jobs/worker-claim.v1.schema.json" with { type: "json" };
import s22 from "../api/native/capture-capabilities.v1.schema.json" with { type: "json" };
import s23 from "../api/native/capture-command.v1.schema.json" with { type: "json" };
import s24 from "../api/native/capture-error.v1.schema.json" with { type: "json" };
import s25 from "../api/native/capture-recoverable.v1.schema.json" with { type: "json" };
import s26 from "../api/native/capture-snapshot.v1.schema.json" with { type: "json" };
import s27 from "../api/http/me.v1.schema.json" with { type: "json" };
import s28 from "../api/http/recording-registration.v1.schema.json" with { type: "json" };
import s29 from "../api/http/profile-update.v1.schema.json" with { type: "json" };
import s30 from "../api/http/profile.v1.schema.json" with { type: "json" };
import s31 from "../api/http/output-create.v1.schema.json" with { type: "json" };
import s32 from "../api/http/output-plan.v1.schema.json" with { type: "json" };
import s33 from "../api/artifacts/simulation-provenance.v1.schema.json" with { type: "json" };
import s34 from "../api/artifacts/recording-source.v2.schema.json" with { type: "json" };
import s35 from "../api/http/simulation-provenance.v1.schema.json" with { type: "json" };
import s36 from "../api/http/recording-create.v2.schema.json" with { type: "json" };
import s37 from "../api/http/recording.v2.schema.json" with { type: "json" };
import s38 from "../api/http/recording-registration.v2.schema.json" with { type: "json" };
import s39 from "../api/jobs/task-input.v2.schema.json" with { type: "json" };
import s40 from "../api/jobs/controller-action.v1.schema.json" with { type: "json" };
import s41 from "../api/jobs/controller-result.v1.schema.json" with { type: "json" };
import s42 from "../api/jobs/reconcile-result.v1.schema.json" with { type: "json" };
import s43 from "../api/jobs/heartbeat-ack.v1.schema.json" with { type: "json" };
import s44 from "../api/http/input-read.v1.schema.json" with { type: "json" };
import s45 from "../api/http/dataset-create.v1.schema.json" with { type: "json" };
import s46 from "../api/http/dataset-update.v1.schema.json" with { type: "json" };
import s47 from "../api/http/dataset-members-add.v1.schema.json" with { type: "json" };
import s48 from "../api/http/clip-read-create.v1.schema.json" with { type: "json" };
import s49 from "../api/http/dataset.v1.schema.json" with { type: "json" };
import s50 from "../api/http/dataset-page.v1.schema.json" with { type: "json" };
import s51 from "../api/http/dataset-clip.v1.schema.json" with { type: "json" };
import s52 from "../api/http/dataset-clip-page.v1.schema.json" with { type: "json" };
import s53 from "../api/http/staff-clip-page.v1.schema.json" with { type: "json" };
import s54 from "../api/http/clip-read.v1.schema.json" with { type: "json" };
import s55 from "../api/http/dataset-change.v1.schema.json" with { type: "json" };
import s56 from "../api/artifacts/processing-result.v2.schema.json" with { type: "json" };
import s57 from "../api/jobs/output-close.v1.schema.json" with { type: "json" };
import s58 from "../api/jobs/output-closure.v1.schema.json" with { type: "json" };
import s59 from "../api/jobs/result-ack.v1.schema.json" with { type: "json" };
import s60 from "../api/http/clip-review-command.v1.schema.json" with { type: "json" };
import s61 from "../api/http/clip-review-state.v1.schema.json" with { type: "json" };
import s62 from "../api/http/clip-review.v1.schema.json" with { type: "json" };
import s63 from "../api/http/job-control-command.v1.schema.json" with { type: "json" };
import s64 from "../api/http/job-control-result.v1.schema.json" with { type: "json" };
import s65 from "../api/jobs/job-status.v2.schema.json" with { type: "json" };
import s66 from "../api/http/source-copy-confirm.v1.schema.json" with { type: "json" };
import s67 from "../api/http/cleanup-proof-request.v1.schema.json" with { type: "json" };
import s68 from "../api/http/source-copy-confirmation.v1.schema.json" with { type: "json" };
import s69 from "../api/http/cleanup-proof.v1.schema.json" with { type: "json" };
import s70 from "../api/artifacts/segments.v1.schema.json" with { type: "json" };
import s71 from "../api/artifacts/captions.v1.schema.json" with { type: "json" };
import s72 from "../api/artifacts/hand-presence.v1.schema.json" with { type: "json" };
import s73 from "../api/artifacts/processing-result.v3.schema.json" with { type: "json" };
import s74 from "../api/jobs/recipe.v1.schema.json" with { type: "json" };
import s75 from "../api/jobs/module-manifest.v1.schema.json" with { type: "json" };
import s76 from "../api/jobs/task-input.v3.schema.json" with { type: "json" };
import s77 from "../api/jobs/controller-action.v2.schema.json" with { type: "json" };
import s78 from "../api/jobs/heartbeat.v2.schema.json" with { type: "json" };
import s79 from "../api/jobs/stage-receipt.v1.schema.json" with { type: "json" };
import s80 from "../api/http/dag-run.v1.schema.json" with { type: "json" };
import s81 from "../api/http/output-create.v2.schema.json" with { type: "json" };
import s82 from "../api/http/output-plan.v2.schema.json" with { type: "json" };
import s83 from "../api/jobs/prior-stages.v1.schema.json" with { type: "json" };
import s84 from "../api/http/recording-annotations.v1.schema.json" with { type: "json" };
import s85 from "../api/http/segment-mark-command.v1.schema.json" with { type: "json" };
import s86 from "../api/http/segment-mark.v1.schema.json" with { type: "json" };
import s87 from "../api/http/segment-marks.v1.schema.json" with { type: "json" };
export { catalog };
export const commonSchema: object = common;
/** Shared definition documents listed in the catalog `shared` key (common.v2). */
export const sharedSchemas: readonly object[] = [commonV2];
export const contractSchemas: Readonly<Record<string, object>> = {
  "artifacts.frame-map.v1": s0,
  "artifacts.hand-observations.v1": s1,
  "artifacts.processing-result.v1": s2,
  "artifacts.processing-result.v2": s56,
  "artifacts.recording-source.v1": s3,
  "artifacts.recording-source.v2": s34,
  "artifacts.simulation-provenance.v1": s33,
  "http.error-envelope.v1": s4,
  "http.dataset-create.v1": s45,
  "http.dataset-update.v1": s46,
  "http.dataset-members-add.v1": s47,
  "http.clip-read-create.v1": s48,
  "http.dataset.v1": s49,
  "http.dataset-page.v1": s50,
  "http.dataset-clip.v1": s51,
  "http.dataset-clip-page.v1": s52,
  "http.staff-clip-page.v1": s53,
  "http.clip-read.v1": s54,
  "http.clip-review-command.v1": s60,
  "http.clip-review-state.v1": s61,
  "http.clip-review.v1": s62,
  "http.job-control-command.v1": s63,
  "http.job-control-result.v1": s64,
  "http.source-copy-confirm.v1": s66,
  "http.cleanup-proof-request.v1": s67,
  "http.source-copy-confirmation.v1": s68,
  "http.cleanup-proof.v1": s69,
  "http.dataset-change.v1": s55,
  "http.input-read.v1": s44,
  "http.me.v1": s27,
  "http.output-create.v1": s31,
  "http.output-plan.v1": s32,
  "http.output-create.v2": s81,
  "http.output-plan.v2": s82,
  "http.parts-receipts.v1": s5,
  "http.parts-sign.v1": s6,
  "http.parts-signed.v1": s7,
  "http.profile-update.v1": s29,
  "http.profile.v1": s30,
  "http.recording-create.v1": s8,
  "http.recording-create.v2": s36,
  "http.recording-registration.v1": s28,
  "http.recording-registration.v2": s38,
  "http.recording-seal.v1": s9,
  "http.recording.v1": s10,
  "http.recording.v2": s37,
  "http.simulation-provenance.v1": s35,
  "http.success-envelope.v1": s11,
  "http.upload-create.v1": s12,
  "http.upload-plan.v1": s13,
  "http.upload-transition.v1": s14,
  "jobs.claim-grant.v1": s15,
  "jobs.controller-input.v1": s16,
  "jobs.heartbeat.v1": s17,
  "jobs.controller-action.v1": s40,
  "jobs.controller-result.v1": s41,
  "jobs.heartbeat-ack.v1": s43,
  "jobs.output-close.v1": s57,
  "jobs.output-closure.v1": s58,
  "jobs.result-ack.v1": s59,
  "jobs.job-status.v1": s18,
  "jobs.job-status.v2": s65,
  "jobs.reconcile-result.v1": s42,
  "jobs.result-candidate.v1": s19,
  "jobs.task-input.v1": s20,
  "jobs.task-input.v2": s39,
  "jobs.worker-claim.v1": s21,
  "native.capture-capabilities.v1": s22,
  "native.capture-command.v1": s23,
  "native.capture-error.v1": s24,
  "native.capture-recoverable.v1": s25,
  "native.capture-snapshot.v1": s26,
  "artifacts.segments.v1": s70,
  "artifacts.captions.v1": s71,
  "artifacts.hand-presence.v1": s72,
  "artifacts.processing-result.v3": s73,
  "jobs.recipe.v1": s74,
  "jobs.module-manifest.v1": s75,
  "jobs.task-input.v3": s76,
  "jobs.controller-action.v2": s77,
  "jobs.heartbeat.v2": s78,
  "jobs.stage-receipt.v1": s79,
  "http.dag-run.v1": s80,
  "jobs.prior-stages.v1": s83,
  "http.recording-annotations.v1": s84,
  "http.segment-mark-command.v1": s85,
  "http.segment-mark.v1": s86,
  "http.segment-marks.v1": s87,
};
