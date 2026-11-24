import {
  canonicalJson,
  simulationToArtifact,
  type SimulationProvenance,
} from "@stateaction/contracts";

/**
 * Pure semantic checks of a processing-result.v2 (or, for a recipe job,
 * processing-result.v3) manifest against catalog
 * facts. The contract (schema + cross-reference rules) is validated before this
 * runs; this binds the document to the exact job, claim, source, admitted
 * identity and closed output inventory. No I/O: every input is a plain value so
 * the rules are unit-testable without a database.
 */

export type InventoryFile = {
  fileId: string;
  role: string;
  slot: string;
  sizeBytes: string;
  sha256: string;
};
export type SourceFile = {
  fileId: string;
  role: string;
  sizeBytes: string;
  sha256: string;
};

export type ManifestFacts = {
  jobId: string;
  recordingId: string;
  nonce: string;
  outcome: "succeeded" | "failed";
  summary: {
    clipCount: number;
    checks: {
      pass: number;
      warn: number;
      fail: number;
      measured: number;
      notEvaluated: number;
    };
    errorCode: string | null;
  };
  inputs: {
    sourceManifestSha256: string;
    profileRevision: string;
    codeRevision: string;
    imageSpecSha256: string;
    modelSha256: string;
    configSha256: string;
    taskInput: Record<string, unknown>;
  };
  /** Closed output inventory EXCLUDING the result manifest itself. */
  outputs: InventoryFile[];
  sources: SourceFile[];
  /**
   * SA-88 recipe job (processing-result.v3): the admitted recipe and the
   * recorded stage runs. Absent for the single-claim path (v2).
   */
  recipe?: {
    recipeId: string;
    recipeSha256: string;
    modules: Record<string, string>;
    enabled: Record<string, boolean>;
    runs: Record<
      string,
      /** Completed output files the slot policy attributes to the stage (SA-91). */
      { state: string; stageFileIds: string[] } | undefined
    >;
  };
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export type ClipPlanRow = {
  clipId: string;
  ordinal: number;
  title: string;
  sourceStartNs: string;
  sourceEndNs: string;
  durationNs: string;
  clockDomain: string;
  rasterWidth: number;
  rasterHeight: number;
  frameCount: number;
  rgbMp4FileId: string;
  handArraysFileId: string;
  handObservationsFileId: string;
  frameMapFileId: string;
  thumbnailFileId: string;
  viewerRrdFileId: string;
};

/** Recording-level annotation documents a v3 result lists (by file id). */
export type AnnotationFiles = {
  segments: string | null;
  captions: string | null;
  handPresence: string | null;
};

export type ManifestVerdict =
  | { ok: true; clipPlan: ClipPlanRow[]; annotations?: AnnotationFiles }
  | { ok: false; code: string; detail?: string };

const bad = (code: string, detail?: string): ManifestVerdict => ({
  ok: false,
  code,
  ...(detail ? { detail } : {}),
});

const CLIP_FILES: Array<[key: string, name: string]> = [
  ["rgb_mp4", "rgb.mp4"],
  ["hand_arrays_npz", "hand-arrays.npz"],
  ["hand_observations_json", "hand-observations.json"],
  ["frame_map_json", "frame-map.json"],
  ["thumbnail_jpeg", "thumbnail.jpg"],
  ["viewer_rrd", "viewer.rrd"],
];

export function checkManifest(
  manifest: Obj,
  facts: ManifestFacts,
): ManifestVerdict {
  if (
    manifest.job_id !== facts.jobId ||
    manifest.recording_id !== facts.recordingId
  )
    return bad("manifest_job_mismatch");
  if (manifest.source_manifest_sha256 !== facts.inputs.sourceManifestSha256)
    return bad("manifest_source_mismatch");
  const prov = obj(manifest.provenance);
  const model = obj(prov.model);
  if (
    prov.code_revision !== facts.inputs.codeRevision ||
    prov.image_spec_sha256 !== facts.inputs.imageSpecSha256 ||
    prov.config_sha256 !== facts.inputs.configSha256 ||
    prov.profile_revision !== facts.inputs.profileRevision ||
    model.asset_sha256 !== facts.inputs.modelSha256
  )
    return bad("manifest_provenance_mismatch");

  // Claim-bound attestation: exact physical invocation and ACTUAL capture profile.
  const att = obj(manifest.attestation);
  if (att.invocation_nonce !== facts.nonce)
    return bad("manifest_nonce_mismatch");
  const admittedProfile = facts.inputs.taskInput.rgbProfile;
  if (att.rgb_profile !== admittedProfile)
    return bad("manifest_profile_mismatch");
  const admittedSim = facts.inputs.taskInput.simulation;
  if (admittedProfile === "h264_mcap_simulation_v1") {
    if (
      manifest.simulation === undefined ||
      canonicalJson(manifest.simulation) !==
        canonicalJson(simulationToArtifact(admittedSim as SimulationProvenance))
    )
      return bad("manifest_simulation_mismatch");
  } else if (manifest.simulation !== undefined) {
    return bad("manifest_simulation_mismatch");
  }

  // Source identity: every listed source equals the catalog row (id, size, SHA-256).
  const catalog = new Map(facts.sources.map((s) => [s.fileId, s]));
  const listed = arr(manifest.verified_sources).map(obj);
  for (const s of listed) {
    const row = catalog.get(String(s.file_id));
    if (!row || row.sizeBytes !== s.size_bytes || row.sha256 !== s.sha256)
      return bad("source_identity_mismatch", String(s.file_id));
  }
  const mcap = facts.sources.find((s) => s.role === "source_mcap");

  // Summary agrees with the manifest it summarizes.
  const counts = summarizeChecks(arr(manifest.checks).map(obj));
  const clips = arr(manifest.clips).map(obj);
  if (
    canonicalJson(counts) !== canonicalJson(facts.summary.checks) ||
    clips.length !== facts.summary.clipCount
  )
    return bad("summary_mismatch");

  const outputs = arr(manifest.outputs).map(obj);
  if (facts.recipe) {
    const found = checkRecipeNodes(manifest, facts);
    if (found) return found;
  }
  if (facts.outcome === "failed") {
    // A failure report carries diagnostics only: no clips, no accepted outputs.
    return clips.length === 0 && outputs.length === 0
      ? { ok: true, clipPlan: [] }
      : bad("failed_manifest_has_outputs");
  }

  const clipTask = facts.inputs.taskInput.schemaVersion === 4;
  if (clipTask !== (manifest.schema === "stateaction.processing_result.v5")) {
    return bad("manifest_clip_mismatch");
  }
  if (clipTask) {
    const clip = obj(facts.inputs.taskInput.clip);
    if (
      typeof clip.id !== "string" ||
      typeof clip.planSha256 !== "string" ||
      manifest.review_clip_id !== clip.id ||
      manifest.clip_plan_sha256 !== clip.planSha256
    ) {
      return bad("manifest_clip_mismatch");
    }

    const span = obj(clip.sourceRange);
    const frameCount = Number(span.end_ordinal) - Number(span.start_ordinal);
    if (
      clips.length === 0 ||
      clips[0]?.source_start_ns !== span.start_ts_ns ||
      clips.at(-1)?.source_end_ns !== span.end_ts_ns ||
      clips.reduce((sum, chunk) => sum + Number(chunk.frame_count), 0) !==
        frameCount
    ) {
      return bad("manifest_clip_range_mismatch");
    }
  }

  // Succeeded: source verified to EOF, exact source identity, exact inventory.
  if (att.source_eof_verified !== true) return bad("source_not_eof_verified");
  if (!mcap || att.source_file_id !== mcap.fileId)
    return bad("source_identity_mismatch", "source_file_id");
  if (!listed.some((s) => s.file_id === mcap.fileId))
    return bad("source_identity_mismatch", "source_mcap not verified");
  // A recipe result may have no clips: its hand_pose node then still lists
  // hand-presence.json (rule processing_result_nodes), so the recording is
  // reviewable through its annotations.
  if (clips.length < 1 && !facts.recipe) return bad("no_clips");
  const byId = new Map(facts.outputs.map((o) => [o.fileId, o]));
  // Explicit duplicate guards (the contract rules report them too): no file id
  // or slot may be listed twice, whatever the manifest claims.
  if (
    new Set(outputs.map((o) => o.file_id)).size !== outputs.length ||
    new Set(outputs.map((o) => o.relative_path)).size !== outputs.length
  )
    return bad("inventory_mismatch", "duplicate output");
  if (outputs.length !== facts.outputs.length)
    return bad("inventory_mismatch", "output count");
  for (const o of outputs) {
    const row = byId.get(String(o.file_id));
    if (
      !row ||
      row.role !== o.role ||
      row.slot !== o.relative_path ||
      row.sizeBytes !== o.size_bytes ||
      row.sha256 !== o.sha256
    )
      return bad("inventory_mismatch", String(o.file_id));
  }
  const plan: ClipPlanRow[] = [];
  for (const [i, clip] of clips.entries()) {
    const files = obj(clip.files);
    const dir = `clips/${String(i).padStart(3, "0")}`;
    const ids: string[] = [];
    for (const [key, name] of CLIP_FILES) {
      const row = byId.get(String(files[key]));
      if (!row || row.slot !== `${dir}/${name}`)
        return bad("clip_slot_mismatch", `${dir}/${name}`);
      ids.push(row.fileId);
    }
    const raster = obj(clip.raster);
    plan.push({
      clipId: String(clip.clip_id),
      ordinal: i,
      title: String(clip.title),
      sourceStartNs: String(clip.source_start_ns),
      sourceEndNs: String(clip.source_end_ns),
      durationNs: String(clip.duration_ns),
      clockDomain: String(clip.clock_domain),
      rasterWidth: Number(raster.width),
      rasterHeight: Number(raster.height),
      frameCount: Number(clip.frame_count),
      rgbMp4FileId: ids[0]!,
      handArraysFileId: ids[1]!,
      handObservationsFileId: ids[2]!,
      frameMapFileId: ids[3]!,
      thumbnailFileId: ids[4]!,
      viewerRrdFileId: ids[5]!,
    });
  }
  const claimed = plan.flatMap((c) => [
    c.rgbMp4FileId,
    c.handArraysFileId,
    c.handObservationsFileId,
    c.frameMapFileId,
    c.thumbnailFileId,
    c.viewerRrdFileId,
  ]);
  if (new Set(claimed).size !== claimed.length)
    return bad("clip_slot_mismatch", "a file belongs to more than one clip");
  if (new Set(plan.map((c) => c.clipId)).size !== plan.length)
    return bad("manifest_duplicate_clip");
  if (!facts.recipe) return { ok: true, clipPlan: plan };
  const one = (role: string) =>
    outputs.find((o) => o.role === role)?.file_id as string | undefined;
  return {
    ok: true,
    clipPlan: plan,
    annotations: {
      segments: one("segments_json") ?? null,
      captions: one("captions_json") ?? null,
      handPresence: one("hand_presence_json") ?? null,
    },
  };
}

const STAGE_FOR_NODE = ["segment", "caption", "hand_pose"] as const;

/**
 * v3 nodes against the admitted recipe and the recorded stage runs: the same
 * recipe, each node's module is the recipe module, a GPU stage node states
 * what its recorded terminal run states (succeeded, failed or cancelled as
 * failed, not_run) and lists only files attributed to that stage by their
 * slot (segments.json / captions.json / diagnostics/<stage>/...), and a
 * succeeded result has a succeeded hand_pose (seal) node.
 */
function checkRecipeNodes(
  manifest: Obj,
  facts: ManifestFacts,
): ManifestVerdict | null {
  const recipe = facts.recipe!;
  if (
    manifest.recipe_id !== recipe.recipeId ||
    manifest.recipe_sha256 !== recipe.recipeSha256
  )
    return bad("manifest_recipe_mismatch");
  const nodes = arr(manifest.nodes).map(obj);
  for (const [i, stage] of STAGE_FOR_NODE.entries()) {
    const node = nodes[i] ?? {};
    if (node.module !== recipe.modules[stage])
      return bad("manifest_node_mismatch", `${stage} module`);
    if (stage === "hand_pose") {
      if (facts.outcome === "succeeded" && node.status !== "succeeded")
        return bad("manifest_node_mismatch", "hand_pose status");
      // The seal lists only its own files: never a file the slot policy gives an earlier stage.
      const earlier = new Set([
        ...(recipe.runs.segment?.stageFileIds ?? []),
        ...(recipe.runs.caption?.stageFileIds ?? []),
      ]);
      if (arr(node.outputs).some((f) => earlier.has(String(f))))
        return bad("manifest_node_mismatch", "hand_pose output");
      continue;
    }
    const run = recipe.runs[stage];
    // Stages are sequential: before the seal, every enabled GPU stage has a
    // terminal recorded run (the database refuses acceptance otherwise).
    if (
      recipe.enabled[stage] &&
      !["succeeded", "failed", "cancelled", "not_run"].includes(
        run?.state ?? "",
      )
    )
      return bad("stage_not_settled", stage);
    const recorded =
      run === undefined
        ? "not_run"
        : run.state === "cancelled"
          ? "failed"
          : run.state;
    if (node.status !== recorded)
      return bad("manifest_node_mismatch", `${stage} status`);
    // Exactly the stage's files by slot: none from elsewhere, none left out (SA-91).
    const listed = new Set(arr(node.outputs).map(String));
    const owned = new Set(run?.stageFileIds ?? []);
    if (
      listed.size !== owned.size ||
      [...listed].some((fileId) => !owned.has(fileId))
    )
      return bad("manifest_node_mismatch", `${stage} output`);
  }
  return null;
}

export function summarizeChecks(checks: readonly { status?: unknown }[]) {
  const counts = { pass: 0, warn: 0, fail: 0, measured: 0, notEvaluated: 0 };
  for (const c of checks) {
    const status = String(c.status);
    if (status === "not_evaluated") counts.notEvaluated += 1;
    else if (status in counts) counts[status as keyof typeof counts] += 1;
  }
  return counts;
}
