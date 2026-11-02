// Generated listing of the published schema files; keep in sync with api/catalog.v4.json (checked by tests).
// catalog.v4.json is the current registry: an exact superset of the immutable
// catalog.v3.json, itself an exact superset of the immutable catalog.v2.json and
// catalog.v1.json.
import catalog from "../api/catalog.v4.json" with { type: "json" };
import common from "../api/common.v1.schema.json" with { type: "json" };
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
export { catalog };
export const commonSchema: object = common;
export const contractSchemas: Readonly<Record<string, object>> = {
  "artifacts.frame-map.v1": s0,
  "artifacts.hand-observations.v1": s1,
  "artifacts.processing-result.v1": s2,
  "artifacts.recording-source.v1": s3,
  "http.error-envelope.v1": s4,
  "http.me.v1": s27,
  "http.parts-receipts.v1": s5,
  "http.parts-sign.v1": s6,
  "http.parts-signed.v1": s7,
  "http.profile-update.v1": s29,
  "http.profile.v1": s30,
  "http.recording-create.v1": s8,
  "http.recording-registration.v1": s28,
  "http.recording-seal.v1": s9,
  "http.recording.v1": s10,
  "http.success-envelope.v1": s11,
  "http.upload-create.v1": s12,
  "http.upload-plan.v1": s13,
  "http.upload-transition.v1": s14,
  "jobs.claim-grant.v1": s15,
  "jobs.controller-input.v1": s16,
  "jobs.heartbeat.v1": s17,
  "jobs.job-status.v1": s18,
  "jobs.result-candidate.v1": s19,
  "jobs.task-input.v1": s20,
  "jobs.worker-claim.v1": s21,
  "native.capture-capabilities.v1": s22,
  "native.capture-command.v1": s23,
  "native.capture-error.v1": s24,
  "native.capture-recoverable.v1": s25,
  "native.capture-snapshot.v1": s26,
};
