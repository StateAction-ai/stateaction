import type pg from "pg";
import {
  contractMaxBytes,
  SIMULATION_RGB_PROFILE,
  requestSha256,
  sha256Hex,
  validateBytes,
  validateValue,
  type ParamMap,
  type Producer,
  type RecipeV1,
  type Stage,
  type StageReceipt,
} from "@stateaction/contracts";
import type { PublicVideoCanary } from "../admission/public-video-canary.js";
import type { ObjectReader } from "../admission/recordings.js";
import { PREPARED_RECIPE_SLOT } from "../transport/authority.js";
import { TransportError } from "../transport/errors.js";
import {
  executionStages,
  stageFingerprint,
  type RerunScope,
} from "./stage-rerun-plan.js";
import {
  dollars,
  providerCostCents,
  rerunBinding,
  type RerunBinding,
} from "./stage-rerun-bindings.js";
import { boundedRun } from "./service.js";

export type StageRerunRequest = {
  parentJobId: string;
  stage: Stage;
  scope: RerunScope;
  module?: string;
  params?: ParamMap;
};

export type StageRerunCommand = StageRerunRequest & {
  requestId: string;
  expectedPlanSha256: string;
  expectedMaxGpuCostUsd: string;
  reason: string;
};

type ConfirmResult = { jobId: string; parentJobId: string; replayed: boolean };
type Read = Pick<pg.Pool, "query">;
type Parent = {
  id: string;
  recipe: RecipeV1 | null;
  state: string;
  admitted_at: Date | null;
  source_manifest_sha256: string;
  profile_revision: string;
  deleted_at: Date | null;
  processable: boolean;
  admission_allowed: boolean;
  busy: boolean;
  settled: boolean;
  selection_seq: number;
};

type ReusableFile = {
  fileId: string;
  slot: string;
  role: string;
  sizeBytes: string;
  sha256: string;
  originalFileId: string;
  originalJobId: string;
};

type CatalogFile = ReusableFile & { objectKey: string };
type ReuseStage = {
  stage: Stage;
  state: "succeeded" | "failed" | "cancelled" | "not_run";
  sourceJobId: string;
  executionJobId: string | null;
  importJobId: string | null;
  importManifestSha256: string | null;
  importedCounts: Record<string, number> | null;
  receipt: StageReceipt | null;
  receiptSha256: string | null;
  fingerprintSha256: string | null;
  errorCode: string | null;
  files: ReusableFile[];
};

export type StageRerunPlan = {
  schemaVersion: 1;
  recordingId: string;
  parentJobId: string;
  sourceManifestSha256: string;
  requestedStage: Stage;
  scope: RerunScope;
  selectionSeq: number;
  recipe: RecipeV1;
  execute: Stage[];
  reuse: ReuseStage[];
  maxGpuCostUsd: string;
  maxComputeCostUsd: string;
  estimatedComputeCostUsd: string | null;
  bindings: Partial<Record<Stage, RerunBinding>>;
  estimatedSeconds: number | null;
};

export type StageRerunDeps = {
  pool: pg.Pool;
  reader: ObjectReader;
  backend?: "local" | "modal";
  bindings?: ReadonlyMap<string, RerunBinding>;
  publicVideoCanary?: PublicVideoCanary;
  production?: boolean;
};

const terminal = new Set(["succeeded", "failed", "cancelled"]);
const refused = (code: string) => new TransportError("conflict", code);

async function loadParent(
  db: Read,
  actorId: string,
  recordingId: string,
  parentJobId: string,
  policy: Pick<StageRerunDeps, "publicVideoCanary" | "production"> = {},
): Promise<Parent> {
  const {
    rows: [parent],
  } = await db.query<Parent>(
    `SELECT j.id, j.recipe, j.state, j.admitted_at, j.source_manifest_sha256, j.profile_revision,
            r.deleted_at,
            j.kind = 'process_recording' AND r.source_manifest_sha256 = j.source_manifest_sha256
              AND r.status IN ('uploaded', 'processing', 'reviewable', 'failed', 'cancelled')
              AND catalog_source_inventory_ok(r.id, true)
              AND catalog_has_role(r.owner_user_id, 'collector')
              AND EXISTS (
                SELECT 1 FROM recording_registrations g WHERE g.recording_id = r.id
                  AND g.owner_user_id = r.owner_user_id
                  AND ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true)
              ) AS processable,
            EXISTS (
              SELECT 1 FROM jobs x WHERE x.recording_id = r.id
                AND x.state NOT IN ('succeeded', 'failed', 'cancelled')
            ) AS busy,
            CASE WHEN $4::uuid IS NULL THEN NOT $6::boolean OR r.rgb_profile <> $7
              ELSE r.client_recording_id = $4 AND r.owner_user_id = $5 AND r.rgb_profile = $7
                AND EXISTS (
                  SELECT 1 FROM recording_admissions a
                  WHERE a.recording_id = r.id AND a.outcome = 'admitted' AND a.job_id = j.id
                    AND a.source_manifest_sha256 = j.source_manifest_sha256
                    AND a.declared_files @> jsonb_build_array(
                      jsonb_build_object('role', 'source_mcap', 'required', true, 'sha256', $8::text)
                    )
                )
            END AS admission_allowed,
            EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = j.id)
              AND NOT EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.job_id = j.id) AS settled,
            coalesce((SELECT max(s.seq) FROM recording_result_selections s WHERE s.recording_id = r.id), 0) AS selection_seq
     FROM recordings r JOIN jobs j ON j.id = $3 AND j.recording_id = r.id
     WHERE r.id = $2 AND catalog_has_role($1, 'staff')`,
    [
      actorId,
      recordingId,
      parentJobId,
      policy.publicVideoCanary?.clientRecordingId ?? null,
      policy.publicVideoCanary?.ownerUserId ?? null,
      policy.production === true,
      SIMULATION_RGB_PROFILE,
      policy.publicVideoCanary?.sourceSha256 ?? null,
    ],
  );
  if (!parent || parent.deleted_at)
    throw new TransportError("not_found", "Run not found");
  if (!terminal.has(parent.state)) throw refused("parent_not_terminal");
  if (parent.admitted_at && !parent.settled)
    throw refused("termination_unproven");
  if (!parent.processable) throw refused("recording_not_processable");
  if (!parent.recipe) throw refused("parent_recipe_unavailable");
  if (!parent.admission_allowed) throw refused("rerun_outside_admission_scope");
  if (parent.busy) throw refused("recording_busy");
  return parent;
}

/** Cheap eligibility check for a run page. Planning validates the actual output bytes. */
export async function stageRerunBlock(
  pool: Read,
  actorId: string,
  recordingId: string,
  jobId: string,
  policy?: Pick<StageRerunDeps, "publicVideoCanary" | "production">,
): Promise<string | null> {
  try {
    await loadParent(pool, actorId, recordingId, jobId, policy);
    return null;
  } catch (error) {
    if (error instanceof TransportError) {
      if (error.code === "conflict") return error.message;
      if (error.code === "not_found") return "parent_unavailable";
    }
    throw error;
  }
}

const primaryRoles = {
  segment: ["segments_json", "artifacts.segments.v1"],
  caption: ["captions_json", "artifacts.captions.v1"],
  hand_pose: ["hand_presence_json", "artifacts.hand-presence.v1"],
} as const;

async function loadCatalogFiles(
  db: Read,
  parent: Parent,
  stage: Stage,
): Promise<CatalogFile[]> {
  const { rows } = await db.query<CatalogFile>(
    `SELECT f.id AS "fileId", s.slot, f.role, f.size_bytes::text AS "sizeBytes", f.sha256,
            f.object_key AS "objectKey",
            coalesce(c.original_file_id, f.id) AS "originalFileId",
            coalesce(c.original_job_id, f.job_id) AS "originalJobId"
     FROM files f JOIN job_output_slots s ON s.job_id = f.job_id AND s.file_id = f.id
     LEFT JOIN job_rerun_copies c ON c.job_id = f.job_id AND c.file_id = f.id
     WHERE f.job_id = $1 AND f.purpose = 'output' AND f.state IN ('completed', 'verified')
       AND f.role <> 'result_manifest'
       AND CASE
         WHEN s.slot = 'segments.json' THEN 'segment'
         WHEN s.slot = 'captions.json' THEN 'caption'
         WHEN s.slot LIKE 'diagnostics/%' THEN split_part(s.slot, '/', 2)
         ELSE 'hand_pose'
       END = $2
     ORDER BY s.slot`,
    [parent.id, stage],
  );
  return rows;
}

async function loadReuse(
  deps: StageRerunDeps,
  parent: Parent,
  recordingId: string,
  stage: Stage,
  segmentsSha256: string | undefined,
): Promise<ReuseStage> {
  const {
    rows: [run],
  } = await deps.pool.query<{
    state: ReuseStage["state"];
    execution_job_id: string | null;
    receipt: StageReceipt | null;
    receipt_sha256: string | null;
    error_code: string | null;
    fingerprint_sha256: string | null;
  }>(
    `SELECT r.state, r.job_id AS execution_job_id, r.receipt, r.receipt_sha256, r.error_code,
            NULL::text AS fingerprint_sha256
     FROM job_stage_runs r WHERE r.job_id = $1 AND r.stage = $2
     UNION ALL
     SELECT x.state, x.execution_job_id, r.receipt, x.receipt_sha256, x.error_code, x.fingerprint_sha256
     FROM job_stage_reuse x
     LEFT JOIN job_stage_runs r ON r.job_id = x.execution_job_id AND r.stage = x.stage
        WHERE x.job_id = $1 AND x.stage = $2`,
    [parent.id, stage],
  );
  const spec = parent.recipe!.stages.find((entry) => entry.stage === stage)!;
  const base = {
    stage,
    sourceJobId: parent.id,
    executionJobId: run?.execution_job_id ?? null,
    receipt: run?.receipt ?? null,
    receiptSha256: run?.receipt_sha256 ?? null,
    importJobId: null,
    importManifestSha256: null,
    importedCounts: null,
  };
  if (!run || run.state !== "succeeded") {
    if (run && !["failed", "cancelled", "not_run"].includes(run.state)) {
      throw refused("reuse_unavailable");
    }
    return {
      ...base,
      state: run?.state ?? "not_run",
      fingerprintSha256: null,
      errorCode:
        run?.error_code ?? (spec.enabled ? "not_spawned" : "stage_disabled"),
      files: [],
    };
  }
  if (stage === "hand_pose" && parent.state !== "succeeded") {
    throw refused("reuse_unavailable");
  }
  const receipt = run.receipt;
  if (
    !receipt ||
    !validateValue(
      receipt.schemaVersion === 2
        ? "jobs.stage-receipt.v2"
        : "jobs.stage-receipt.v1",
      receipt,
    ).valid ||
    requestSha256(receipt) !== run.receipt_sha256 ||
    receipt.jobId !== run.execution_job_id ||
    receipt.stage !== stage ||
    receipt.module !== spec.module ||
    receipt.status !== "succeeded"
  )
    throw refused("reuse_unavailable");
  const catalog = await loadCatalogFiles(deps.pool, parent, stage);
  const [role, contract] = primaryRoles[stage];
  const primary = catalog.find((file) => file.role === role);
  if (
    !primary ||
    !receipt.outputs.some(
      (output) =>
        output.fileId === primary.originalFileId &&
        output.role === primary.role &&
        output.sha256 === primary.sha256 &&
        output.sizeBytes === primary.sizeBytes,
    )
  ) {
    throw refused("reuse_unavailable");
  }
  let bytes: Uint8Array;
  try {
    bytes = await deps.reader.read(
      primary.objectKey,
      contractMaxBytes(contract),
    );
  } catch {
    throw refused("reuse_unavailable");
  }
  const validation = validateBytes(contract, bytes);
  if (
    !validation.valid ||
    String(bytes.byteLength) !== primary.sizeBytes ||
    sha256Hex(bytes) !== primary.sha256
  ) {
    throw refused("reuse_unavailable");
  }
  const doc = validation.value as {
    job_id: string;
    recording_id: string;
    source_manifest_sha256: string;
    segments_sha256?: string;
    producer: Producer;
  };
  if (
    doc.job_id !== run.execution_job_id ||
    doc.recording_id !== recordingId ||
    doc.source_manifest_sha256 !== parent.source_manifest_sha256 ||
    `${doc.producer.module_id}@${doc.producer.module_version}` !==
      spec.module ||
    doc.producer.params_sha256 !== requestSha256(spec.params) ||
    (stage === "caption" &&
      (!segmentsSha256 || doc.segments_sha256 !== segmentsSha256))
  ) {
    throw refused("reuse_unavailable");
  }
  const fingerprint = stageFingerprint({
    stage,
    module: spec.module,
    paramsSha256: doc.producer.params_sha256,
    sourceManifestSha256: parent.source_manifest_sha256,
    inputDigests:
      segmentsSha256 && stage === "caption"
        ? [{ role: "segments_json", sha256: segmentsSha256 }]
        : [],
    producer: doc.producer,
  });
  if (run?.fingerprint_sha256 && run.fingerprint_sha256 !== fingerprint) {
    throw refused("reuse_unavailable");
  }
  const receiptFiles = new Map(
    (receipt?.outputs ?? []).map((file) => [file.fileId, file]),
  );
  // The hand receipt is bounded. Its accepted result closure also owns the clip files.
  // The worker draft is an intermediate document with the source invocation identity.
  const files = catalog
    .filter((file) =>
      stage === "hand_pose"
        ? file.slot !== PREPARED_RECIPE_SLOT
        : receiptFiles.has(file.originalFileId),
    )
    .map(({ objectKey: _key, ...file }) => file);
  const storedById = new Map(
    catalog.map((file) => [file.originalFileId, file]),
  );
  for (const output of receipt?.outputs ?? []) {
    const file = storedById.get(output.fileId);
    if (!file && stage === "hand_pose" && output.role === "diagnostic_blob")
      continue;
    if (
      !file ||
      file.role !== output.role ||
      file.sha256 !== output.sha256 ||
      file.sizeBytes !== output.sizeBytes
    )
      throw refused("reuse_unavailable");
  }
  return {
    ...base,
    state: "succeeded",
    fingerprintSha256: fingerprint,
    errorCode: null,
    files,
  };
}

/** Resolve immutable source evidence before opening the confirmation transaction. */
export async function planStageRerun(
  deps: StageRerunDeps,
  actorId: string,
  recordingId: string,
  request: StageRerunRequest,
): Promise<{ plan: StageRerunPlan; planSha256: string }> {
  const parent = await loadParent(
    deps.pool,
    actorId,
    recordingId,
    request.parentJobId,
    deps,
  );
  const recipe = structuredClone(parent.recipe!);
  const execute = executionStages(recipe, request.stage, request.scope);
  if (
    deps.publicVideoCanary &&
    (execute.length !== 1 || execute[0] !== "hand_pose")
  )
    throw refused("rerun_outside_admission_scope");
  const stage = recipe.stages.find((entry) => entry.stage === request.stage)!;
  stage.module = request.module ?? stage.module;
  stage.params = request.params ?? stage.params;
  if (!validateValue("jobs.recipe.v1", recipe).valid)
    throw refused("stage_configuration_invalid");
  const bindings: StageRerunPlan["bindings"] = {};
  let gpuCents = 0n;
  let computeCents = 0n;
  for (const entry of recipe.stages) {
    if (!execute.includes(entry.stage)) continue;
    if (deps.backend === "modal") {
      const binding = rerunBinding(deps.bindings, entry);
      bindings[entry.stage] = binding;
      const stageGpu = providerCostCents(binding, binding.microUsdPerGpuSecond);
      gpuCents += stageGpu;
      computeCents +=
        stageGpu + providerCostCents(binding, binding.microUsdPerCpuSecond);
    } else if (entry.resources.gpu !== "none") {
      throw refused("deployment_binding_unavailable");
    }
  }
  if (deps.publicVideoCanary && gpuCents !== 0n)
    throw refused("rerun_outside_admission_scope");
  const environment = Object.values(bindings)[0]?.environment;
  if (
    Object.values(bindings).some(
      (binding) => binding.environment !== environment,
    )
  ) {
    throw refused("deployment_binding_unavailable");
  }
  if (computeCents > BigInt(recipe.maxJobCostUsd.replace(".", ""))) {
    throw refused("cost_cap_exceeded");
  }
  if (
    computeCents > 0n &&
    !(
      await deps.pool.query(
        "SELECT 1 FROM job_rerun_available_spend($1, $2::uuid, $3::bigint, $4::bigint) LIMIT 1",
        [
          environment,
          recordingId,
          gpuCents.toString(),
          computeCents.toString(),
        ],
      )
    ).rowCount
  )
    throw refused("cost_cap_missing");
  const reuse: ReuseStage[] = [];
  let reusedSegmentsSha256: string | undefined;
  for (const spec of recipe.stages) {
    if (execute.includes(spec.stage)) continue;
    const evidence = await loadReuse(
      deps,
      parent,
      recordingId,
      spec.stage,
      reusedSegmentsSha256,
    );
    reuse.push(evidence);
    if (spec.stage === "segment") {
      reusedSegmentsSha256 = evidence.files.find(
        (file) => file.role === "segments_json",
      )?.sha256;
    }
  }
  if (
    execute.includes("caption") &&
    !execute.includes("segment") &&
    (!reusedSegmentsSha256 ||
      !reuse.some(
        (row) =>
          row.stage === "segment" && (row.receipt?.counts.segments ?? 0) > 0,
      ))
  ) {
    throw refused("segments_unavailable");
  }
  if (
    !execute.includes("hand_pose") &&
    !reuse.some((row) => row.stage === "hand_pose" && row.state === "succeeded")
  ) {
    throw refused("hand_result_unavailable");
  }
  const original = parent.recipe!;
  const sameConfiguration = recipe.stages.every((entry) => {
    const baseline = original.stages.find(
      (spec) => spec.stage === entry.stage,
    )!;
    return (
      entry.module === baseline.module &&
      requestSha256(entry.params) === requestSha256(baseline.params)
    );
  });
  let estimatedSeconds: number | null = null;
  let estimatedComputeCostUsd = deps.backend === "local" ? "0.00" : null;
  if (sameConfiguration) {
    const { rows: timing } = await deps.pool.query<{
      stage: Stage;
      seconds: number;
    }>(
      `SELECT stage, ceil(extract(epoch FROM (finished_at - started_at)))::integer AS seconds
       FROM job_stage_runs
       WHERE job_id = $1 AND stage = ANY($2::text[]) AND state = 'succeeded'
         AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
      [parent.id, execute],
    );
    if (timing.length === execute.length) {
      const total = timing.reduce((sum, row) => sum + row.seconds, 0);
      if (total <= 43200) {
        estimatedSeconds = total;
        if (deps.backend === "modal") {
          estimatedComputeCostUsd = dollars(
            timing.reduce((sum, row) => {
              const binding = bindings[row.stage]!;
              return (
                sum +
                providerCostCents(
                  binding,
                  binding.microUsdPerCpuSecond + binding.microUsdPerGpuSecond,
                  Math.min(row.seconds, binding.maxBilledSeconds),
                )
              );
            }, 0n),
          );
        }
      }
    }
  }
  const plan: StageRerunPlan = {
    schemaVersion: 1,
    recordingId,
    parentJobId: parent.id,
    sourceManifestSha256: parent.source_manifest_sha256,
    requestedStage: request.stage,
    scope: request.scope,
    selectionSeq: parent.selection_seq,
    recipe,
    execute,
    reuse,
    maxGpuCostUsd: dollars(gpuCents),
    maxComputeCostUsd: dollars(computeCents),
    estimatedComputeCostUsd,
    bindings,
    estimatedSeconds,
  };
  return { plan, planSha256: requestSha256(plan) };
}

async function replay(
  db: Read,
  actorId: string,
  recordingId: string,
  input: StageRerunCommand,
  requestHash: string,
): Promise<ConfirmResult | null> {
  const {
    rows: [existing],
  } = await db.query<{
    recording_id: string;
    derived_from_job_id: string | null;
    actor_id: string | null;
    request_sha256: string | null;
  }>(
    `SELECT j.recording_id, j.derived_from_job_id, p.actor_id, p.request_sha256
     FROM jobs j LEFT JOIN job_rerun_plans p ON p.job_id = j.id
     WHERE j.id = $1 AND catalog_has_role($2, 'staff')`,
    [input.requestId, actorId],
  );
  if (!existing) return null;
  if (
    existing.recording_id !== recordingId ||
    existing.derived_from_job_id !== input.parentJobId ||
    existing.actor_id !== actorId ||
    existing.request_sha256 !== requestHash
  ) {
    throw refused("request_id_in_use");
  }
  return {
    jobId: input.requestId,
    parentJobId: input.parentJobId,
    replayed: true,
  };
}

export async function confirmStageRerun(
  deps: StageRerunDeps,
  actorId: string,
  recordingId: string,
  input: StageRerunCommand,
): Promise<ConfirmResult> {
  const requestHash = requestSha256(input);
  const existing = await replay(
    deps.pool,
    actorId,
    recordingId,
    input,
    requestHash,
  );
  if (existing) return existing;
  const { plan, planSha256 } = await planStageRerun(
    deps,
    actorId,
    recordingId,
    input,
  ).catch(async (error: unknown) => {
    // A concurrent identical request can commit while the storage preview is running.
    const concurrent = await replay(
      deps.pool,
      actorId,
      recordingId,
      input,
      requestHash,
    );
    if (concurrent) return { plan: null, planSha256: "" };
    throw error;
  });
  if (!plan) {
    const concurrent = await replay(
      deps.pool,
      actorId,
      recordingId,
      input,
      requestHash,
    );
    if (concurrent) return concurrent;
    throw refused("plan_changed");
  }
  return boundedRun(deps.pool, async (tx) => {
    await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
      recordingId,
    ]);
    const concurrent = await replay(
      tx,
      actorId,
      recordingId,
      input,
      requestHash,
    );
    if (concurrent) return concurrent;
    const parent = await loadParent(
      tx,
      actorId,
      recordingId,
      input.parentJobId,
      deps,
    );
    if (
      planSha256 !== input.expectedPlanSha256 ||
      input.expectedMaxGpuCostUsd !== plan.maxGpuCostUsd ||
      parent.selection_seq !== plan.selectionSeq
    ) {
      throw refused("plan_changed");
    }
    const inserted = await tx.query(
      `INSERT INTO jobs (id, kind, recording_id, derived_from_job_id, source_manifest_sha256, profile_revision)
       VALUES ($1, 'process_recording', $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.requestId,
        recordingId,
        parent.id,
        parent.source_manifest_sha256,
        parent.profile_revision,
      ],
    );
    if (inserted.rowCount !== 1) throw refused("request_id_in_use");
    await tx.query(
      `INSERT INTO job_rerun_plans (job_id, actor_id, request_sha256, plan_sha256, plan)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.requestId,
        actorId,
        requestHash,
        planSha256,
        JSON.stringify({ ...plan, reason: input.reason }),
      ],
    );
    if (plan.maxComputeCostUsd !== "0.00") {
      const environment = Object.values(plan.bindings)[0]?.environment;
      const {
        rows: [reservation],
      } = await tx.query<{ ok: boolean }>(
        "SELECT job_rerun_reserve_spend($1, $2, $3::bigint, $4::bigint) AS ok",
        [
          input.requestId,
          environment,
          plan.maxGpuCostUsd.replace(".", ""),
          plan.maxComputeCostUsd.replace(".", ""),
        ],
      );
      if (!reservation?.ok) throw refused("cost_cap_missing");
    }
    await tx.query(
      "UPDATE recordings SET current_job_id = $2, status = 'processing' WHERE id = $1",
      [recordingId, input.requestId],
    );
    return {
      jobId: input.requestId,
      parentJobId: input.parentJobId,
      replayed: false,
    };
  });
}
