/**
 * Cross-field rules that JSON Schema cannot express. Each rule returns the first
 * violation in the documented order, so every language reports the same code
 * and path. Decimal strings are compared as exact BigInt values.
 */
export type RuleViolation = { code: string; path: string };
type Json = Record<string, unknown>;
type Rule = (doc: Json) => RuleViolation | null;

import { createHash } from "node:crypto";
import { requestSha256 } from "./canonical.js";
import modulesManifest from "../api/modules.json" with { type: "json" };
import type { ModuleManifestEntry } from "./types.js";

const PART_SIZE = 67108864n;
const obj = (value: unknown) => value as Json;
const list = (value: unknown) => value as unknown[];
const big = (value: unknown) => BigInt(value as string);
const v = (code: string, path: string): RuleViolation => ({ code, path });

function firstDuplicate(
  items: unknown[],
  key: string,
  base: string,
): RuleViolation | null {
  const seen = new Set<unknown>();
  for (const [i, item] of items.entries()) {
    const value = obj(item)[key];
    if (seen.has(value)) return v("duplicate_identity", `${base}/${i}/${key}`);
    seen.add(value);
  }
  return null;
}

const OUTPUT_ROLE: Record<string, string> = {
  rgb_mp4: "clip_mp4",
  hand_arrays_npz: "hand_arrays_npz",
  hand_observations_json: "hand_observations_json",
  frame_map_json: "frame_map_json",
  thumbnail_jpeg: "thumbnail_jpeg",
  viewer_rrd: "viewer_rrd",
};

/** Expected NPZ shapes; "F" is the clip frame_count. Order matches the schema. */
export const HAND_ARRAY_SHAPES: ReadonlyArray<readonly (number | "F")[]> = [
  ["F", 2, 21, 2], // image_landmarks_px
  ["F", 2, 21], // image_landmarks_mask
  ["F", 2, 21, 3], // model_relative_joints
  ["F", 2, 21], // model_relative_mask
  ["F", 2], // hand_detected
  ["F", 2], // handedness_score
  ["F", 2], // handedness: int8 0 left, 1 right, -1 none
  ["F"], // frame_index
];

/** RFC 3339 UTC (schema-validated) to a fixed-width sortable key with 9 fraction digits. */
function instant(value: unknown): string {
  const text = value as string;
  const fraction = text.length > 20 ? text.slice(20, -1) : "";
  return text.slice(0, 19) + fraction.padEnd(9, "0");
}

const count = (items: Json[], role: string, required?: boolean) =>
  items.filter(
    (f) =>
      f.role === role && (required === undefined || f.required === required),
  ).length;

const ACTIVE = new Set(["preflight", "recording", "finalizing"]);
const FINAL_OUTCOMES = new Set(["completed", "interrupted"]);
const RECOVERABLE = new Set(["finalizing", "recovery_required"]);

/** Capture snapshot counter and state/outcome consistency, under a path prefix. */
function captureSnapshot(doc: Json, base: string): RuleViolation | null {
  const c = obj(doc.counters);
  const n = (key: string) => big(c[key]);
  if (n("videoFramesSubmitted") > n("videoFramesAcquired"))
    return v("progress_mismatch", `${base}/counters/videoFramesSubmitted`);
  if (n("videoFramesWritten") > n("videoFramesSubmitted"))
    return v("progress_mismatch", `${base}/counters/videoFramesWritten`);
  if (
    n("videoFramesWritten") +
      n("videoFramesDropped") +
      n("videoFramesUnresolved") >
    n("videoFramesAcquired")
  )
    return v("progress_mismatch", `${base}/counters/videoFramesAcquired`);
  const state = doc.state as string;
  const container = doc.containerState;
  const outcome = doc.captureOutcome;
  const [containerOk, outcomeOk] = ACTIVE.has(state)
    ? [container === null, outcome === null]
    : state === "finalized"
      ? [container === "closed", FINAL_OUTCOMES.has(outcome as string)]
      : state === "recovery_required"
        ? [container === "unclosed", outcome === null]
        : [container !== null, outcome === "failed"]; // quarantined
  if (!containerOk) return v("outcome_mismatch", `${base}/containerState`);
  if (!outcomeOk) return v("outcome_mismatch", `${base}/captureOutcome`);
  if (state === "finalized") {
    // A clean finalized take has no unresolved frames and every acquired
    // frame is accounted for as written or dropped.
    if (n("videoFramesUnresolved") !== 0n)
      return v("progress_mismatch", `${base}/counters/videoFramesUnresolved`);
    if (
      n("videoFramesWritten") + n("videoFramesDropped") !==
      n("videoFramesAcquired")
    )
      return v("progress_mismatch", `${base}/counters/videoFramesAcquired`);
  }
  return null;
}

/**
 * Cross-document check: the sealed inventory (http.recording-seal.v1) holds
 * exactly the declaration's files (artifacts.recording-source.v1) plus one
 * source_manifest entry for the declaration itself. Both documents must already
 * be contract-valid. Paths point into the declaration.
 */
export function checkSealedInventory(
  seal: Json,
  declaration: Json,
): RuleViolation | null {
  const sealed = list(seal.files)
    .map(obj)
    .filter((f) => f.role !== "source_manifest");
  const declared = list(declaration.files).map(obj);
  if (declared.length !== sealed.length)
    return v("inventory_incomplete", "/files");
  for (const [i, file] of declared.entries()) {
    const match = sealed.find((f) => f.fileId === file.file_id);
    if (!match) return v("inventory_incomplete", `/files/${i}/file_id`);
    for (const [snake, camel] of [
      ["role", "role"],
      ["size_bytes", "sizeBytes"],
      ["sha256", "sha256"],
      ["required", "required"],
    ] as const)
      if (match[camel] !== file[snake])
        return v("reference_mismatch", `/files/${i}/${snake}`);
  }
  return null;
}

function masks(
  points: unknown[],
  mask: unknown[],
  path: string,
): RuleViolation | null {
  for (let j = 0; j < mask.length; j++)
    if ((points[j] !== null) !== mask[j])
      return v("mask_mismatch", `${path}/${j}`);
  return null;
}

// ---------------------------------------------------------------- SA-87 stage contracts

type Module = {
  moduleId: string;
  version: number;
  stage: string;
  gpu: { minimum: string; supported: string[] };
  outputs: string[];
  provenance: { modelName: string; engine: string; requires: string[] };
};
/** The committed module manifest (api/modules.json, jobs.module-manifest.v1). */
const MODULES = new Map(
  (modulesManifest.modules as Module[]).map((m) => [
    `${m.moduleId}@${m.version}`,
    m,
  ]),
);

/**
 * One published module manifest entry by `module_id@version` (api/modules.json), or undefined.
 * SA-91: the jobs controller checks a recipe stage module against it before any claim.
 */
export function moduleManifestEntry(
  ref: string,
): ModuleManifestEntry | undefined {
  return MODULES.get(ref) as ModuleManifestEntry | undefined;
}

/** Output roles each stage may produce. */
export const STAGE_ROLES: Readonly<Record<string, readonly string[]>> = {
  segment: ["segments_json", "diagnostic_blob"],
  caption: ["captions_json", "diagnostic_blob"],
  hand_pose: [
    "clip_mp4",
    "hand_arrays_npz",
    "hand_observations_json",
    "frame_map_json",
    "thumbnail_jpeg",
    "viewer_rrd",
    "hand_presence_json",
    "recording_mp4",
    "diagnostic_blob",
  ],
};
/** Roles a succeeded stage must list exactly once. */
const PRIMARY_ROLES: Readonly<Record<string, readonly string[]>> = {
  segment: ["segments_json"],
  caption: ["captions_json"],
  hand_pose: ["hand_presence_json", "recording_mp4"],
};
const CODED_STATES = new Set(["failed", "cancelled", "not_run"]);
const STAGE_ORDER = ["segment", "caption", "hand_pose"];

/** UUIDv5 namespace: uuid5(NAMESPACE_URL, "https://stateaction.ai/schemas/artifacts/segments.v1.json"). */
export const SEGMENT_ID_NAMESPACE = "a505457d-7470-5704-b995-1b3d1e3638df";

/** RFC 9562 UUIDv5 of a UTF-8 name. */
export function uuid5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name, "utf8")]))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * segment_id: uuid5(SEGMENT_ID_NAMESPACE, "<source_manifest_sha256>|<module_id>@<module_version>|
 * <params_sha256>|<start source_frame_id>|<end source_frame_id, or "end" at end of stream>").
 */
export function segmentId(
  sourceManifestSha256: string,
  moduleRef: string,
  paramsSha256: string,
  startFrameId: string,
  endFrameId: string | null,
): string {
  return uuid5(
    SEGMENT_ID_NAMESPACE,
    [
      sourceManifestSha256,
      moduleRef,
      paramsSha256,
      startFrameId,
      endFrameId ?? "end",
    ].join("|"),
  );
}

/** Frame refs compare on both identity and timestamp; a null end is end of stream. */
const isEnd = (ref: Json) => ref.source_frame_id === null;
function before(a: Json, b: Json): boolean {
  if (isEnd(b)) return !isEnd(a);
  if (isEnd(a)) return false;
  return (
    big(a.source_frame_id) < big(b.source_frame_id) &&
    big(a.timestamp_ns) < big(b.timestamp_ns)
  );
}
function atOrBefore(a: Json, b: Json): boolean {
  if (isEnd(b)) return true;
  if (isEnd(a)) return false;
  return (
    big(a.source_frame_id) <= big(b.source_frame_id) &&
    big(a.timestamp_ns) <= big(b.timestamp_ns)
  );
}
const sameRef = (a: Json, b: Json) =>
  a.source_frame_id === b.source_frame_id && a.timestamp_ns === b.timestamp_ns;

/** The producer names a manifest module of this stage and carries its required provenance. */
function producerRule(doc: Json, stage: string): RuleViolation | null {
  const p = obj(doc.producer);
  if (p.stage !== stage) return v("reference_mismatch", "/producer/stage");
  if (typeof doc.schema === "string" && doc.schema.endsWith(".v2"))
    return p.module_id === `imported_${stage}` && p.module_version === 1
      ? null
      : v("reference_mismatch", "/producer/module_id");
  const module = MODULES.get(`${p.module_id}@${p.module_version}`);
  if (!module || module.stage !== stage)
    return v("reference_mismatch", "/producer/module_id");
  if (module.provenance.modelName !== p.model_name)
    return v("reference_mismatch", "/producer/model_name");
  if (module.provenance.engine !== obj(p.engine).name)
    return v("reference_mismatch", "/producer/engine/name");
  const gpu = obj(p.gpu);
  for (const field of module.provenance.requires) {
    const [value, path] =
      field === "observed_gpu"
        ? [gpu.observed_type, "/producer/gpu/observed_type"]
        : [p[field], `/producer/${field}`];
    if (value === null) return v("reference_mismatch", path);
  }
  if (!module.gpu.supported.includes(gpu.requested_type as string))
    return v("reference_mismatch", "/producer/gpu/requested_type");
  return null;
}

function recipeRule(doc: Json, base: string): RuleViolation | null {
  const stages = list(doc.stages).map(obj);
  if (stages[1]!.enabled === true && stages[0]!.enabled !== true)
    return v("reference_mismatch", `${base}/stages/1/enabled`);
  for (const [i, stage] of stages.entries()) {
    const module = MODULES.get(stage.module as string);
    if (!module || module.stage !== stage.stage)
      return v("reference_mismatch", `${base}/stages/${i}/module`);
    if (!module.gpu.supported.includes(obj(stage.resources).gpu as string))
      return v("reference_mismatch", `${base}/stages/${i}/resources/gpu`);
  }
  return null;
}

function stageReceiptRule(doc: Json, base: string): RuleViolation | null {
  if ((doc.status === "succeeded") !== (doc.errorCode === null))
    return v("outcome_mismatch", `${base}/errorCode`);
  const outputs = list(doc.outputs).map(obj);
  const dup = firstDuplicate(outputs, "fileId", `${base}/outputs`);
  if (dup) return dup;
  const allowed = STAGE_ROLES[doc.stage as string]!;
  for (const [i, output] of outputs.entries())
    if (!allowed.includes(output.role as string))
      return v("reference_mismatch", `${base}/outputs/${i}/role`);
  if (doc.status === "succeeded" && doc.stage !== "hand_pose")
    for (const role of PRIMARY_ROLES[doc.stage as string]!)
      if (outputs.filter((o) => o.role === role).length !== 1)
        return v("inventory_incomplete", `${base}/outputs`);
  if (instant(doc.finishedAt) < instant(doc.startedAt))
    return v("ordering_violation", `${base}/finishedAt`);
  return null;
}

/** text split on commas, each step trimmed of spaces and tabs, empty steps dropped. */
export function captionSteps(text: string): string[] {
  return text
    .split(",")
    .map((step) => step.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter((step) => step.length > 0);
}

const STAGE_RULES: Readonly<Record<string, Rule>> = {
  segments: (doc) => {
    const found = producerRule(doc, "segment");
    if (found) return found;
    const windows = obj(doc.windows);
    const failed = list(windows.failed).map(obj);
    const spans = list(windows.failed_core_spans).map(obj);
    if ((windows.ok as number) + failed.length !== windows.total)
      return v("progress_mismatch", "/windows/ok");
    const dup = firstDuplicate(failed, "window_index", "/windows/failed");
    if (dup) return dup;
    for (const [i, span] of spans.entries()) {
      const p = `/windows/failed_core_spans/${i}`;
      if (!before(obj(span.start), obj(span.end)))
        return v("ordering_violation", `${p}/end`);
      if (i > 0 && !atOrBefore(obj(spans[i - 1]!.end), obj(span.start)))
        return v("ordering_violation", `${p}/start`);
    }
    const covered = new Set<number>();
    for (const [i, window] of failed.entries()) {
      const start = obj(window.core_start);
      const end = obj(window.core_end);
      if (!before(start, end))
        return v("ordering_violation", `/windows/failed/${i}/core_end`);
      const k = spans.findIndex(
        (span) =>
          atOrBefore(obj(span.start), start) && atOrBefore(end, obj(span.end)),
      );
      // A failed window must lie inside a recorded failed core span.
      if (k < 0) return v("reference_mismatch", `/windows/failed/${i}`);
      covered.add(k);
    }
    for (const i of spans.keys())
      if (!covered.has(i))
        return v("reference_mismatch", `/windows/failed_core_spans/${i}`);
    const rows = list(doc.rows).map(obj);
    const p0 = obj(doc.producer);
    const moduleRef = `${p0.module_id}@${p0.module_version}`;
    const seen = new Set<unknown>();
    for (const [i, row] of rows.entries()) {
      const p = `/rows/${i}`;
      if (row.ordinal !== i) return v("ordering_violation", `${p}/ordinal`);
      if (seen.has(row.segment_id))
        return v("duplicate_identity", `${p}/segment_id`);
      seen.add(row.segment_id);
      const start = obj(row.start);
      const end = obj(row.end);
      if (!before(start, end)) return v("ordering_violation", `${p}/end`);
      const previous = rows[i - 1];
      const boundary =
        doc.schema === "stateaction.segments.v2" ? "start" : "end";
      if (previous && !atOrBefore(obj(previous[boundary]), start))
        return v("ordering_violation", `${p}/start`);
      const expected = segmentId(
        doc.source_manifest_sha256 as string,
        moduleRef,
        p0.params_sha256 as string,
        start.source_frame_id as string,
        end.source_frame_id as string | null,
      );
      if (row.segment_id !== expected)
        return v("reference_mismatch", `${p}/segment_id`);
    }
    // Failed windows are rows too: failed_window rows equal the failed core spans, in order.
    let k = 0;
    for (const [i, row] of rows.entries()) {
      if (row.status !== "failed_window") continue;
      const span = spans[k];
      if (
        !span ||
        !sameRef(obj(span.start), obj(row.start)) ||
        !sameRef(obj(span.end), obj(row.end))
      )
        return v("reference_mismatch", `/rows/${i}/status`);
      k++;
    }
    if (k < spans.length)
      return v("reference_mismatch", `/windows/failed_core_spans/${k}`);
    return null;
  },
  captions: (doc) => {
    const found = producerRule(doc, "caption");
    if (found) return found;
    const rows = list(doc.rows).map(obj);
    const dup = firstDuplicate(rows, "segment_id", "/rows");
    if (dup) return dup;
    for (const [i, row] of rows.entries()) {
      if (row.status !== "complete") continue;
      const steps = list(obj(row.derived).steps);
      const expected = captionSteps(row.text as string);
      if (
        steps.length !== expected.length ||
        steps.some((step, j) => step !== expected[j])
      )
        return v("reference_mismatch", `/rows/${i}/derived/steps`);
    }
    return null;
  },
  hand_presence: (doc) => {
    const found = producerRule(doc, "hand_pose");
    if (found) return found;
    const lanes = obj(doc.lanes);
    for (const side of ["left", "right"]) {
      const base = `/lanes/${side}`;
      const spans = list(lanes[side]).map(obj);
      let frames = 0;
      for (const [i, span] of spans.entries()) {
        const p = `${base}/${i}`;
        if (!before(obj(span.start), obj(span.end)))
          return v("ordering_violation", `${p}/end`);
        if (i > 0) {
          const prev = spans[i - 1]!;
          if (!sameRef(obj(prev.end), obj(span.start)))
            return v("ordering_violation", `${p}/start`);
          if (prev.state === span.state)
            return v("ordering_violation", `${p}/state`);
        }
        frames += span.frames as number;
      }
      const last = spans.length - 1;
      if (!isEnd(obj(spans[last]!.end)))
        return v("dimension_mismatch", `${base}/${last}/end`);
      if (frames !== doc.frame_count) return v("dimension_mismatch", base);
    }
    return null;
  },
  recipe: (doc) => recipeRule(doc, ""),
  module_manifest: (doc) => {
    const modules = list(doc.modules).map(obj);
    const seen = new Set<string>();
    for (const [i, module] of modules.entries()) {
      const p = `/modules/${i}`;
      const ref = `${module.moduleId}@${module.version}`;
      if (seen.has(ref)) return v("duplicate_identity", `${p}/version`);
      seen.add(ref);
      const gpu = obj(module.gpu);
      if (!list(gpu.supported).includes(gpu.minimum))
        return v("reference_mismatch", `${p}/gpu/minimum`);
      const allowed = STAGE_ROLES[module.stage as string]!;
      for (const [j, role] of list(module.outputs).entries())
        if (!allowed.includes(role as string))
          return v("reference_mismatch", `${p}/outputs/${j}`);
    }
    return null;
  },
  task_input_recipe: (doc) => {
    if (doc.kind !== "process_recording") return null;
    const found = recipeRule(obj(doc.recipe), "/recipe");
    if (found) return found;
    return requestSha256(doc.recipe) === doc.recipeSha256
      ? null
      : v("reference_mismatch", "/recipeSha256");
  },
  processing_result_nodes: (doc) => {
    const isClip = doc.schema === "stateaction.processing_result.v5";
    const outputs = list(doc.outputs).map(obj);
    const roles = new Map(outputs.map((o) => [o.file_id, o.role as string]));
    const claimed = new Set<unknown>();
    for (const [i, node] of list(doc.nodes).map(obj).entries()) {
      const p = `/nodes/${i}`;
      if ((node.status === "succeeded") !== (node.error_code === null))
        return v("outcome_mismatch", `${p}/error_code`);
      const files = list(node.outputs);
      if (node.status === "not_run" && files.length > 0)
        return v("outcome_mismatch", `${p}/outputs`);
      const allowed = STAGE_ROLES[node.stage as string]!;
      const nodeRoles: string[] = [];
      for (const [j, fileId] of files.entries()) {
        const role = roles.get(fileId);
        if (
          role === undefined ||
          !allowed.includes(role) ||
          (isClip && role === "recording_mp4")
        )
          return v("reference_mismatch", `${p}/outputs/${j}`);
        if (claimed.has(fileId))
          return v("duplicate_identity", `${p}/outputs/${j}`);
        claimed.add(fileId);
        nodeRoles.push(role);
      }
      if (node.status === "succeeded")
        for (const role of PRIMARY_ROLES[node.stage as string]!)
          if (
            !(isClip && role === "recording_mp4") &&
            nodeRoles.filter((r) => r === role).length !== 1
          )
            return v("inventory_incomplete", `${p}/outputs`);
    }
    for (const [k, output] of outputs.entries())
      if (!claimed.has(output.file_id))
        return v("reference_mismatch", `/outputs/${k}/file_id`);
    return null;
  },
  heartbeat_stage: (doc) =>
    (doc.phase === "segmenting" && doc.stage !== "segment") ||
    (doc.phase === "captioning" && doc.stage !== "caption")
      ? v("reference_mismatch", "/phase")
      : null,
  stage_receipt: (doc) => stageReceiptRule(doc, ""),
  stage_run_action: (doc) => {
    if (doc.action !== "record_stage_run") return null;
    const state = doc.state as string;
    if ("errorCode" in doc !== CODED_STATES.has(state))
      return v("outcome_mismatch", "/errorCode");
    const terminal = state === "succeeded" || state === "failed";
    if ("receipt" in doc ? !terminal : state === "succeeded")
      return v("outcome_mismatch", "/receipt");
    if (!("receipt" in doc)) return null;
    const receipt = obj(doc.receipt);
    if (receipt.stage !== doc.stage)
      return v("reference_mismatch", "/receipt/stage");
    if (receipt.module !== doc.module)
      return v("reference_mismatch", "/receipt/module");
    if (receipt.status !== state)
      return v("outcome_mismatch", "/receipt/status");
    return stageReceiptRule(receipt, "/receipt");
  },
  dag_run: (doc) => {
    for (const [i, node] of list(doc.stages).map(obj).entries()) {
      const p = `/stages/${i}`;
      if (node.stage !== STAGE_ORDER[i])
        return v("ordering_violation", `${p}/stage`);
      const state = node.state as string;
      if (node.enabled !== true && state !== "not_run")
        return v("outcome_mismatch", `${p}/state`);
      if (CODED_STATES.has(state) !== (node.errorCode !== null))
        return v("outcome_mismatch", `${p}/errorCode`);
      if (state === "succeeded" && node.receiptSha256 === null)
        return v("outcome_mismatch", `${p}/receiptSha256`);
      if (
        node.startedAt !== null &&
        node.finishedAt !== null &&
        instant(node.finishedAt) < instant(node.startedAt)
      )
        return v("ordering_violation", `${p}/finishedAt`);
    }
    return null;
  },
};

export const RULES: Readonly<Record<string, Rule>> = {
  unique_file_ids: (doc) => firstDuplicate(list(doc.files), "fileId", "/files"),
  sealed_inventory: (doc) => {
    const files = list(doc.files).map(obj);
    return count(files, "source_manifest") !== 1 ||
      count(files, "source_manifest", true) !== 1 ||
      count(files, "source_mcap") !== 1 ||
      count(files, "source_mcap", true) !== 1 ||
      count(files, "recorder_metadata", true) < 1
      ? v("inventory_incomplete", "/files")
      : null;
  },
  claim_grant: (doc) => {
    const inputs = list(doc.inputs).map(obj);
    const dup = firstDuplicate(inputs, "fileId", "/inputs");
    if (dup) return dup;
    if (
      count(inputs, "source_manifest") !== 1 ||
      count(inputs, "source_mcap") !== 1
    )
      return v("inventory_incomplete", "/inputs");
    const m = inputs.findIndex((f) => f.role === "source_manifest");
    if (inputs[m]!.sha256 !== obj(doc.digests).sourceManifestSha256)
      return v("reference_mismatch", `/inputs/${m}/sha256`);
    if (instant(doc.startDeadline) > instant(doc.executionDeadline))
      return v("ordering_violation", "/executionDeadline");
    return null;
  },
  result_candidate: (doc) => {
    const summary = obj(doc.summary);
    return (summary.outcome === "succeeded") !== (summary.errorCode === null)
      ? v("outcome_mismatch", "/summary/errorCode")
      : null;
  },
  capture_snapshot: (doc) => captureSnapshot(doc, ""),
  capture_recoverable: (doc) => {
    const captures = list(doc.captures).map(obj);
    const dup = firstDuplicate(captures, "clientRecordingId", "/captures");
    if (dup) return dup;
    for (const [i, capture] of captures.entries()) {
      const found = captureSnapshot(capture, `/captures/${i}`);
      if (found) return found;
      if (!RECOVERABLE.has(capture.state as string))
        return v("outcome_mismatch", `/captures/${i}/state`);
    }
    return null;
  },
  capture_capabilities: (doc) => {
    const accepted = doc.outcome === "accepted";
    if (accepted !== (doc.acceptedProfile !== null))
      return v("outcome_mismatch", "/acceptedProfile");
    if (accepted !== (list(doc.unsupportedReasons).length === 0))
      return v("outcome_mismatch", "/unsupportedReasons");
    return null;
  },
  unique_part_numbers: (doc) =>
    firstDuplicate(list(doc.receipts), "partNumber", "/receipts"),
  upload_plan: (doc) => {
    const parts = (big(doc.sizeBytes) + PART_SIZE - 1n) / PART_SIZE;
    return BigInt(doc.partCount as number) === parts
      ? null
      : v("part_plan_mismatch", "/partCount");
  },
  heartbeat_progress: (doc) =>
    doc.processedFrames !== undefined &&
    doc.totalFrames !== undefined &&
    doc.totalFrames !== null &&
    big(doc.processedFrames) > big(doc.totalFrames)
      ? v("progress_mismatch", "/processedFrames")
      : null,
  recording_source: (doc) => {
    const files = list(doc.files).map(obj);
    const dup = firstDuplicate(files, "file_id", "/files");
    if (dup) return dup;
    // The declaration is the source_manifest file; it never lists itself.
    for (const [i, file] of files.entries())
      if (file.role === "source_manifest")
        return v("reference_mismatch", `/files/${i}/role`);
    if (
      count(files, "source_mcap") !== 1 ||
      count(files, "source_mcap", true) !== 1 ||
      count(files, "recorder_metadata", true) < 1
    )
      return v("inventory_incomplete", "/files");
    const domains = new Set(list(doc.clock_domains));
    for (const [i, channel] of list(doc.channels).entries())
      if (!domains.has(obj(channel).clock_domain))
        return v("reference_mismatch", `/channels/${i}/clock_domain`);
    return null;
  },
  clip_plan: (doc) => {
    const spans = list(doc.spans).map(obj);
    if (
      (doc.mode !== "apply" || doc.state === "failed") &&
      (spans.length !== 1 || spans[0]!.kind !== "clip")
    )
      return v("outcome_mismatch", "/spans");
    if (!spans.some((span) => span.kind === "clip"))
      return v("outcome_mismatch", "/spans");

    let ordinal = 0;
    let lastTimestamp = -1n;
    for (const [index, span] of spans.entries()) {
      const path = `/spans/${index}`;
      const end = span.end_ordinal as number;
      if (span.start_ordinal !== ordinal)
        return v("dimension_mismatch", `${path}/start_ordinal`);
      if (end <= ordinal || end > (doc.frame_count as number))
        return v("dimension_mismatch", `${path}/end_ordinal`);
      const startTime = big(span.start_ts_ns);
      const endTime = big(span.end_ts_ns);
      if (ordinal === 0 && span.start_ts_ns !== doc.origin_ts_ns)
        return v("reference_mismatch", `${path}/start_ts_ns`);
      if (startTime <= lastTimestamp)
        return v("ordering_violation", `${path}/start_ts_ns`);
      const single = end === ordinal + 1;
      if (single ? endTime !== startTime : endTime <= startTime)
        return v("ordering_violation", `${path}/end_ts_ns`);
      if (single !== (span.first_source_frame_id === span.last_source_frame_id))
        return v("reference_mismatch", `${path}/last_source_frame_id`);
      if (
        span.kind === "excluded" &&
        span.filter_version !== doc.filter_version
      )
        return v("reference_mismatch", `${path}/filter_version`);
      ordinal = end;
      lastTimestamp = endTime;
    }
    return ordinal === doc.frame_count
      ? null
      : v("dimension_mismatch", "/spans");
  },
  frame_map: (doc) => {
    const rows = list(doc.rows).map(obj);
    const dup = firstDuplicate(rows, "source_frame_id", "/rows");
    if (dup) return dup;
    if (rows.length !== doc.frame_count)
      return v("dimension_mismatch", "/rows");
    const first = rows[0]!;
    for (const [i, row] of rows.entries()) {
      const p = `/rows/${i}`;
      if (row.frame_index !== i)
        return v("ordering_violation", `${p}/frame_index`);
      if (row.clock_domain !== first.clock_domain)
        return v("clock_mismatch", `${p}/clock_domain`);
      if (i > 0) {
        const prev = rows[i - 1]!;
        if (big(row.timestamp_ns) <= big(prev.timestamp_ns))
          return v("ordering_violation", `${p}/timestamp_ns`);
        if (big(row.source_pts) <= big(prev.source_pts))
          return v("ordering_violation", `${p}/source_pts`);
      }
      if (big(row.clip_pts) !== big(row.source_pts) - big(first.source_pts))
        return v("clock_mismatch", `${p}/clip_pts`);
      const raster = obj(row.raster);
      const crop = obj(obj(row.transform).crop);
      if (
        (crop.x as number) + (crop.width as number) >
          (raster.width as number) ||
        (crop.y as number) + (crop.height as number) > (raster.height as number)
      )
        return v("dimension_mismatch", `${p}/transform/crop`);
    }
    return null;
  },
  hand_observations: (doc) => {
    const frames = list(doc.frames).map(obj);
    if (frames.length !== doc.frame_count)
      return v("dimension_mismatch", "/frames");
    for (const [i, frame] of frames.entries()) {
      const p = `/frames/${i}`;
      if (frame.frame_index !== i)
        return v("ordering_violation", `${p}/frame_index`);
      const hands = list(frame.hands).map(obj);
      const dup = firstDuplicate(hands, "hand_index", `${p}/hands`);
      if (dup) return dup;
      for (const [j, hand] of hands.entries()) {
        const h = `${p}/hands/${j}`;
        const image = masks(
          list(hand.image_landmarks_px),
          list(hand.image_mask),
          `${h}/image_mask`,
        );
        if (image) return image;
        const points = obj(hand.points_3d);
        const joints = masks(
          list(points.joints),
          list(points.mask),
          `${h}/points_3d/mask`,
        );
        if (joints) return joints;
      }
    }
    return null;
  },
  processing_result: (doc) => {
    const outputs = list(doc.outputs).map(obj);
    const dup =
      firstDuplicate(
        list(doc.verified_sources),
        "file_id",
        "/verified_sources",
      ) ??
      firstDuplicate(outputs, "file_id", "/outputs") ??
      firstDuplicate(outputs, "relative_path", "/outputs");
    if (dup) return dup;
    for (const [i, output] of outputs.entries())
      if (output.role === "result_manifest")
        return v("reference_mismatch", `/outputs/${i}/role`);
    const roles = new Map(outputs.map((o) => [o.file_id, o.role]));
    const clips = list(doc.clips).map(obj);
    const clipDup = firstDuplicate(clips, "clip_id", "/clips");
    if (clipDup) return clipDup;
    const claimed = new Set<unknown>();
    for (const [i, clip] of clips.entries()) {
      const p = `/clips/${i}`;
      if (clip.clip_ordinal !== i)
        return v("ordering_violation", `${p}/clip_ordinal`);
      const files = obj(clip.files);
      for (const [key, role] of Object.entries(OUTPUT_ROLE))
        if (roles.get(files[key]) !== role)
          return v("reference_mismatch", `${p}/files/${key}`);
      // Each output file belongs to exactly one clip.
      for (const key of Object.keys(OUTPUT_ROLE)) {
        if (claimed.has(files[key]))
          return v("duplicate_identity", `${p}/files/${key}`);
        claimed.add(files[key]);
      }
      const start = big(clip.source_start_ns);
      const end = big(clip.source_end_ns);
      if (end < start) return v("clock_mismatch", `${p}/source_end_ns`);
      if (big(clip.duration_ns) !== end - start)
        return v("clock_mismatch", `${p}/duration_ns`);
      const arrays = list(obj(clip.hand_arrays).arrays).map(obj);
      for (const [k, expected] of HAND_ARRAY_SHAPES.entries()) {
        const shape = list(arrays[k]!.shape);
        if (
          expected.some(
            (dim, d) => shape[d] !== (dim === "F" ? clip.frame_count : dim),
          )
        )
          return v("dimension_mismatch", `${p}/hand_arrays/arrays/${k}/shape`);
      }
    }
    return null;
  },
  ...STAGE_RULES,
  recording_annotations: (doc) => {
    // Artifact parts may retain producer job IDs. The DAG always names this job.
    const parts: [string, string, string, string][] = [
      ["segments", "job_id", "recording_id", "segments"],
      ["captions", "job_id", "recording_id", "captions"],
      ["hand_presence", "job_id", "recording_id", "hand_presence"],
      ["dag_run", "jobId", "recordingId", "dag_run"],
    ];
    for (const [key, jobKey, recordingKey] of parts) {
      const part = doc[key];
      const producers = doc.producer_jobs;
      const hasProducer = producers !== undefined && key !== "dag_run";
      const expectedJob = hasProducer ? obj(producers)[key] : doc.job_id;
      if (part === null) {
        if (hasProducer && expectedJob !== null)
          return v("reference_mismatch", `/producer_jobs/${key}`);
        continue;
      }
      if (obj(part)[jobKey] !== expectedJob)
        return v("reference_mismatch", `/${key}/${jobKey}`);
      if (obj(part)[recordingKey] !== doc.recording_id)
        return v("reference_mismatch", `/${key}/${recordingKey}`);
    }
    // Each embedded part keeps its own cross-field rules.
    for (const [key, , , rule] of parts) {
      if (doc[key] === null) continue;
      const found = RULES[rule]!(obj(doc[key]));
      if (found) return v(found.code, `/${key}${found.path}`);
    }
    if (doc.segments !== null && doc.captions !== null) {
      const ids = new Set(
        list(obj(doc.segments).rows).map((row) => obj(row).segment_id),
      );
      for (const [i, row] of list(obj(doc.captions).rows).entries())
        if (!ids.has(obj(row).segment_id))
          return v("reference_mismatch", `/captions/rows/${i}/segment_id`);
    }
    return null;
  },
};
