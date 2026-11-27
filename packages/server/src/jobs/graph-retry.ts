import { randomUUID } from "node:crypto";
import { requestSha256, type CompiledGraph } from "@stateaction/contracts";
import type pg from "pg";
import { TransportError } from "../transport/errors.js";
import type { JobsDeps } from "./service.js";
import { boundedRun } from "./service.js";
import { dollars } from "./stage-rerun-bindings.js";

type ClipRequest = {
  clipId: string;
  parentJobId: string;
  nodes: string[];
};
type RetryRequest = ClipRequest | { scope: "failed_clips" };

type RetryCommand = RetryRequest & {
  requestId: string;
  expectedPlanSha256: string;
  reason: string;
};

type Parent = {
  id: string;
  state: string;
  ordinal: number;
  source_manifest_sha256: string;
  profile_revision: string;
  clip_selection_seq: number;
  graph: CompiledGraph;
  clip: unknown;
};

type Node = {
  node_id: string;
  state: string;
  fingerprint_sha256: string | null;
  receipt_sha256: string | null;
  counts: Record<string, number> | null;
  gpu_cost_cents: number;
  compute_cost_cents: number;
  binding: Record<string, unknown>;
};

const refuse = (code: string) => new TransportError("conflict", code);
const maxBatchClips = 1000;
type Query = Pick<pg.Pool, "query"> | pg.PoolClient;

export function retryNodeClosure(graph: CompiledGraph, requested: string[]) {
  const ids = graph.topoOrder.filter((id) => graph.nodes[id]!.scope === "clip");
  const execute = new Set(requested);
  if (
    requested.length === 0 ||
    execute.size !== requested.length ||
    requested.some((id) => !ids.includes(id))
  )
    throw refuse("retry_node_unavailable");
  for (const id of ids) {
    if (graph.nodes[id]!.producers.some((parent) => execute.has(parent)))
      execute.add(id);
  }
  return ids.filter((id) => execute.has(id));
}

async function readPlan(
  db: Query,
  actor: string,
  recordingId: string,
  input: ClipRequest,
) {
  const {
    rows: [parent],
  } = await db.query<Parent>(
    `SELECT j.id, j.state, c.ordinal, j.source_manifest_sha256, j.profile_revision, g.graph,
            i.task_input -> 'clip' AS clip,
            coalesce((SELECT max(seq) FROM clip_result_selections WHERE clip_id = c.id),0) AS clip_selection_seq
     FROM recordings r
     JOIN review_clips c ON c.recording_id = r.id AND c.id = $3
     JOIN jobs j ON j.id = c.live_job_id AND j.id = $4
     JOIN job_recipe_graphs g ON g.job_id = j.id JOIN job_inputs i ON i.job_id = j.id
     WHERE r.id = $1 AND r.deleted_at IS NULL AND catalog_has_role($2,'staff')
       AND c.plan_version = (SELECT max(version) FROM clip_plans WHERE recording_id = r.id)
       AND j.state IN ('succeeded','failed','cancelled') AND job_graph_settled(j.id)
       AND j.source_manifest_sha256 = r.source_manifest_sha256
       AND EXISTS (
         SELECT 1 FROM recording_registrations registration
         WHERE registration.recording_id = r.id AND registration.owner_user_id = r.owner_user_id
           AND catalog_has_role(r.owner_user_id, 'collector')
           AND ingest_permission_ok(registration.ingest_permission_id,r.owner_user_id,true)
       )
       AND NOT EXISTS (SELECT 1 FROM dispatch_admission WHERE job_id = j.id)`,
    [recordingId, actor, input.clipId, input.parentJobId],
  );
  if (!parent) throw refuse("retry_source_unproved");
  const { rows } = await db.query<Node>(
    `SELECT n.node_id, n.binding, n.gpu_cost_cents, n.compute_cost_cents, r.state,
            r.fingerprint_sha256, coalesce(r.receipt_sha256,original.receipt_sha256) AS receipt_sha256,
            coalesce(r.receipt,original.receipt) -> 'counts' AS counts
     FROM job_recipe_nodes n JOIN job_recipe_node_results r USING(job_id,node_id)
     LEFT JOIN job_recipe_node_results original ON original.job_id = r.reuse_job_id AND original.node_id = r.node_id
     WHERE n.job_id = $1 ORDER BY n.node_id`,
    [parent.id],
  );
  const failed = rows
    .filter(
      ({ state, counts }) =>
        state !== "succeeded" ||
        (counts?.failed_windows ?? 0) > 0 ||
        (counts?.failed_captions ?? 0) > 0,
    )
    .map(({ node_id }) => node_id);
  const execute = retryNodeClosure(
    parent.graph,
    input.nodes.length
      ? input.nodes
      : failed.length || parent.state === "succeeded"
        ? failed
        : parent.graph.topoOrder
            .filter((id) => parent.graph.nodes[id]?.scope === "clip")
            .slice(-1),
  );
  const executeSet = new Set(execute);
  const kept = rows.filter(({ node_id }) => !executeSet.has(node_id));
  if (
    kept.some(
      ({ state, receipt_sha256, fingerprint_sha256 }) =>
        state !== "succeeded" || !receipt_sha256 || !fingerprint_sha256,
    )
  )
    throw refuse("retry_retained_output_unproved");
  const active = rows.filter(({ node_id }) => executeSet.has(node_id));
  const compute = active.reduce(
    (sum, node) => sum + BigInt(node.compute_cost_cents),
    0n,
  );
  const gpu = active.reduce(
    (sum, node) => sum + BigInt(node.gpu_cost_cents),
    0n,
  );
  const environments = new Set(
    active.map((node) => node.binding.environment ?? "local"),
  );
  if (environments.size !== 1) throw refuse("deployment_binding_unavailable");
  const plan = {
    schemaVersion: 3 as const,
    recordingId,
    clipId: input.clipId,
    ordinal: parent.ordinal,
    parentJobId: parent.id,
    sourceManifestSha256: parent.source_manifest_sha256,
    recipeSha256: parent.graph.recipeSha256,
    sourceRange: parent.clip,
    clipSelectionSeq: parent.clip_selection_seq,
    execute,
    reuse: kept.map((node) => ({
      nodeId: node.node_id,
      receiptSha256: node.receipt_sha256!,
      fingerprintSha256: node.fingerprint_sha256!,
    })),
    bindings: active.map((node) => [node.node_id, node.binding] as const),
    maxComputeCostUsd: dollars(compute),
    maxGpuCostUsd: dollars(gpu),
  };
  return {
    parent,
    plan,
    digest: requestSha256(plan),
    compute,
    gpu,
    environment: [...environments][0],
  };
}

async function loadPlans(
  db: Query,
  actor: string,
  recordingId: string,
  input: RetryRequest,
) {
  if ("clipId" in input) return [await readPlan(db, actor, recordingId, input)];
  const { rows } = await db.query<Omit<ClipRequest, "nodes">>(
    `SELECT c.id AS "clipId", j.id AS "parentJobId"
     FROM recordings r JOIN review_clips c ON c.recording_id = r.id
     JOIN jobs j ON j.id = c.live_job_id JOIN job_recipe_graphs g ON g.job_id = j.id
     WHERE r.id = $1 AND r.deleted_at IS NULL AND catalog_has_role($2,'staff')
       AND c.plan_version = (SELECT max(version) FROM clip_plans WHERE recording_id = r.id)
       AND j.state IN ('succeeded','failed','cancelled') AND job_graph_settled(j.id)
       AND NOT EXISTS (SELECT 1 FROM dispatch_admission WHERE job_id = j.id)
       AND (j.state <> 'succeeded' OR j.failed_window_count > 0 OR j.caption_failed_count > 0
         OR EXISTS (SELECT 1 FROM job_recipe_node_results n
                    WHERE n.job_id = j.id AND n.state <> 'succeeded'))
     ORDER BY c.ordinal, c.id LIMIT $3`,
    [recordingId, actor, maxBatchClips + 1],
  );
  if (!rows.length) throw refuse("no_failed_clips");
  if (rows.length > maxBatchClips) throw refuse("too_many_failed_clips");
  const plans = [];
  for (const target of rows)
    plans.push(
      await readPlan(db, actor, recordingId, { ...target, nodes: [] }),
    );
  return plans;
}

function totals(plans: Awaited<ReturnType<typeof loadPlans>>) {
  const compute = plans.reduce((sum, { compute }) => sum + compute, 0n);
  const gpu = plans.reduce((sum, { gpu }) => sum + gpu, 0n);
  const environments = new Set(plans.map(({ environment }) => environment));
  if (environments.size !== 1) throw refuse("deployment_binding_unavailable");
  return { compute, gpu, environment: [...environments][0] };
}

function batchDigest(plans: Awaited<ReturnType<typeof loadPlans>>) {
  return requestSha256(plans.map(({ digest }) => digest));
}

export async function previewGraphRetry(
  deps: Pick<JobsDeps, "pool">,
  actor: string,
  recordingId: string,
  input: RetryRequest,
) {
  const plans = await loadPlans(deps.pool, actor, recordingId, input);
  const { compute, gpu, environment } = totals(plans);
  if (
    compute > 0n &&
    !(
      await deps.pool.query(
        "SELECT 1 FROM job_rerun_available_spend($1,$2,$3,$4) LIMIT 1",
        [environment, recordingId, gpu.toString(), compute.toString()],
      )
    ).rowCount
  )
    throw refuse("cost_cap_missing");
  const clips = plans.map(
    ({ plan: { bindings: _bindings, ...display }, digest }) => ({
      ...display,
      planSha256: digest,
    }),
  );
  if ("clipId" in input) return clips[0]!;
  return {
    clips,
    planSha256: batchDigest(plans),
    maxComputeCostUsd: dollars(compute),
    maxGpuCostUsd: dollars(gpu),
  };
}

export async function confirmGraphRetry(
  deps: Pick<JobsDeps, "pool">,
  actor: string,
  recordingId: string,
  input: RetryCommand,
) {
  const reason = input.reason.trim();
  if (!reason)
    throw new TransportError("invalid_request", "Retry needs a reason");
  const requestHash = requestSha256({
    ...input,
    reason,
    ...("nodes" in input ? { nodes: input.nodes.toSorted() } : {}),
  });
  return boundedRun(deps.pool, async (tx) => {
    await tx.query("SELECT id FROM recordings WHERE id = $1 FOR UPDATE", [
      recordingId,
    ]);
    const {
      rows: [prior],
    } = await tx.query(
      `SELECT j.recording_id, p.actor_id, p.request_sha256, p.plan -> 'batchJobIds' AS batch_jobs
       FROM jobs j LEFT JOIN job_rerun_plans p ON p.job_id = j.id
       WHERE j.id = $1 AND catalog_has_role($2,'staff')`,
      [input.requestId, actor],
    );
    if (prior) {
      if (
        prior.recording_id !== recordingId ||
        prior.actor_id !== actor ||
        prior.request_sha256 !== requestHash
      )
        throw refuse("request_id_in_use");
      return "clipId" in input
        ? { jobId: input.requestId, replayed: true }
        : { jobIds: prior.batch_jobs as string[], replayed: true };
    }

    await tx.query(
      `SELECT id FROM review_clips WHERE recording_id = $1
         AND ($2::uuid IS NULL OR id = $2) ORDER BY ordinal, id FOR UPDATE`,
      [recordingId, "clipId" in input ? input.clipId : null],
    );
    const plans = await loadPlans(tx, actor, recordingId, input);
    totals(plans);
    const digest = "clipId" in input ? plans[0]!.digest : batchDigest(plans);
    if (digest !== input.expectedPlanSha256) throw refuse("plan_changed");
    const jobIds = plans.map((_, index) =>
      index === 0 ? input.requestId : randomUUID(),
    );
    for (const [index, work] of plans.entries()) {
      const {
        parent,
        plan,
        digest: planDigest,
        compute,
        gpu,
        environment,
      } = work;
      const jobId = jobIds[index]!;
      await tx.query(
        `INSERT INTO jobs (id,kind,recording_id,source_manifest_sha256,profile_revision,clip_id,derived_from_job_id)
       VALUES ($1,'clip_pipeline',$2,$3,$4,$5,$6)`,
        [
          jobId,
          recordingId,
          parent.source_manifest_sha256,
          parent.profile_revision,
          plan.clipId,
          parent.id,
        ],
      );
      await tx.query(
        `INSERT INTO job_rerun_plans (job_id,actor_id,request_sha256,plan_sha256,plan)
       VALUES ($1,$2,$3,$4,$5)`,
        [
          jobId,
          actor,
          requestHash,
          planDigest,
          {
            ...plan,
            reason,
            ...("scope" in input && index === 0 ? { batchJobIds: jobIds } : {}),
          },
        ],
      );
      if (compute > 0n) {
        const {
          rows: [hold],
        } = await tx.query(
          "SELECT job_rerun_reserve_spend($1,$2,$3,$4) AS reserved",
          [jobId, environment, gpu.toString(), compute.toString()],
        );
        if (!hold?.reserved) throw refuse("cost_cap_missing");
      }
      await tx.query("UPDATE review_clips SET live_job_id = $2 WHERE id = $1", [
        plan.clipId,
        jobId,
      ]);
    }
    await tx.query(
      "UPDATE recordings SET status = 'processing' WHERE id = $1",
      [recordingId],
    );
    return "clipId" in input
      ? { jobId: input.requestId, replayed: false }
      : { jobIds, replayed: false };
  });
}
