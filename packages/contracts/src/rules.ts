/**
 * Cross-field rules that JSON Schema cannot express. Each rule returns the first
 * violation in the documented order, so every language reports the same code
 * and path. Decimal strings are compared as exact BigInt values.
 */
export type RuleViolation = { code: string; path: string };
type Json = Record<string, unknown>;
type Rule = (doc: Json) => RuleViolation | null;

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

export const RULES: Readonly<Record<string, Rule>> = {
  unique_file_ids: (doc) => firstDuplicate(list(doc.files), "fileId", "/files"),
  sealed_inventory: (doc) => {
    const files = list(doc.files).map(obj);
    return count(files, "source_manifest") !== 1 ||
      count(files, "source_manifest", true) !== 1 ||
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
};
