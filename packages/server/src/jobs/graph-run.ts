import { randomBytes } from "node:crypto";
import {
  readNodeReceipt,
  requestSha256,
  type CompiledGraph,
} from "@stateaction/contracts";
import {
  ObjectHashError,
  objectVerificationMs,
} from "../acceptance/storage.js";
import { hashServiceToken } from "../auth/service.js";
import { inTransaction } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import { TransportError } from "../transport/errors.js";
import type { JobsDeps } from "./service.js";

type GraphAction = { owner: string; nodeId: string } & (
  | { action: "issue_node_claim"; bindingSha256: string }
  | { action: "begin_node_submission" }
  | {
      action: "record_node_result";
      state: "succeeded" | "failed" | "cancelled" | "skipped";
      errorCode: string | null;
      receipt: string | null;
      files: {
        port: string;
        logicalFile: string;
        name: string;
        fileId: string;
      }[];
    }
  | { action: "record_node_call"; executionRef: string }
  | {
      action: "record_node_terminal";
      executionRef: string;
      kind: "local_child_reaped" | "provider_call_terminal";
      observed: Record<string, unknown>;
    }
);

export async function readGraphRun(
  deps: Pick<JobsDeps, "pool">,
  jobId: string,
) {
  const { rows } = await deps.pool.query(
    `SELECT g.graph, i.task_input AS task, nodes.document -> $1::text AS nodes,
            coalesce(nodes.document -> g.parent_job_id::text, '{}'::jsonb) AS "parentNodes"
     FROM job_recipe_graphs g
     JOIN job_inputs i USING (job_id)
     CROSS JOIN LATERAL (
       SELECT jsonb_object_agg(doc.job_id::text, doc.entries) AS document FROM (
         SELECT n.job_id, jsonb_object_agg(n.node_id, jsonb_build_object(
           'state', coalesce(r.state, CASE
              WHEN c.submission_started_at IS NOT NULL THEN 'outstanding'
              WHEN c.job_id IS NOT NULL THEN 'issued'
              ELSE 'pending' END),
           'executionRef', c.execution_ref, 'binding', n.binding,
           'budgetSeconds', n.budget_seconds,
           'startDeadline', to_char(c.start_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'startedAt', to_char(c.submission_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'claimedAt', to_char(c.claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'verifiedOutputs', coalesce(outputs.inventory, '[]'::jsonb)
         )) AS entries
         FROM job_recipe_nodes n
         LEFT JOIN job_recipe_node_claims c USING (job_id,node_id)
         LEFT JOIN job_recipe_node_results r USING (job_id,node_id)
         CROSS JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'port', o.port, 'artifactType', o.artifact_type, 'fileId', o.file_id,
             'sha256', o.sha256, 'sizeBytes', o.size_bytes::text
           ) ORDER BY o.port,o.file_id) AS inventory
           FROM job_recipe_node_outputs o
           WHERE o.job_id = n.job_id AND o.node_id = n.node_id
         ) outputs
         WHERE n.job_id IN (g.job_id, g.parent_job_id)
         GROUP BY n.job_id
       ) doc
     ) nodes
     WHERE g.job_id = $1::uuid`,
    [jobId],
  );
  if (!rows[0]) throw new TransportError("not_found", "Job graph not found");
  return rows[0];
}

export async function applyGraphAction(
  deps: JobsDeps,
  jobId: string,
  input: GraphAction,
) {
  const { owner, nodeId } = input;
  try {
    if (input.action === "record_node_result")
      return await recordNodeResult(deps, jobId, input);
    return await inTransaction(deps.pool, async (tx) => {
      if (input.action === "issue_node_claim") {
        const {
          rows: [node],
        } = await tx.query<{ binding: Record<string, unknown> }>(
          "SELECT binding FROM job_recipe_nodes WHERE job_id = $1 AND node_id = $2",
          [jobId, nodeId],
        );
        if (!node || requestSha256(node.binding) !== input.bindingSha256)
          throw new TransportError("conflict", "Node binding changed");
        const token = "sa_svc_" + randomBytes(32).toString("base64url");
        const {
          rows: [grant],
        } = await tx.query<{
          issued: boolean;
          start_deadline: Date;
          execution_deadline: Date;
        }>("SELECT * FROM job_graph_issue_claim($1,$2,$3,$4,$5,$6)", [
          jobId,
          nodeId,
          owner,
          node.binding,
          hashServiceToken(token),
          deps.config.startDeadlineSeconds,
        ]);
        if (!grant?.issued) return { state: "already_issued" };
        return {
          state: "issued",
          bootstrapToken: token,
          startDeadline: grant.start_deadline.toISOString(),
          executionDeadline: grant.execution_deadline.toISOString(),
        };
      }
      if (input.action === "begin_node_submission") {
        const { rows } = await tx.query<{ state: string }>(
          "SELECT job_graph_begin_submission($1,$2,$3) AS state",
          [jobId, nodeId, owner],
        );
        return rows[0];
      }
      if (input.action === "record_node_call") {
        await tx.query("SELECT job_graph_bind_call($1,$2,$3,$4)", [
          jobId,
          nodeId,
          owner,
          input.executionRef,
        ]);
      } else {
        await tx.query("SELECT job_graph_record_terminal($1,$2,$3,$4,$5,$6)", [
          jobId,
          nodeId,
          owner,
          input.kind,
          input.executionRef,
          input.observed,
        ]);
      }
      return { state: "recorded" };
    });
  } catch (error) {
    if (error instanceof CatalogError) {
      throw new TransportError(
        error.code === "idempotency_conflict" ? "conflict" : error.code,
        error.message,
        { cause: error },
      );
    }
    throw error;
  }
}

type NodeClaim = {
  nodeId: string;
  invocationNonce: string;
  executionRef: string;
  backend: "local" | "modal";
  bindingSha256: string;
};
type NodeInputFile = {
  id: string;
  sha256: string;
  size_bytes: string;
  object_key: string;
};

export async function claimGraphNode(
  deps: JobsDeps,
  jobId: string,
  input: NodeClaim,
  bootstrapToken: string,
) {
  const uploadToken = "sa_svc_" + randomBytes(32).toString("base64url");
  try {
    return await inTransaction(deps.pool, async (tx) => {
      const {
        rows: [pinned],
      } = await tx.query<{
        graph: CompiledGraph;
        task: Record<string, unknown>;
        binding: Record<string, unknown>;
        inputs: Record<string, { from: string; type: string }>;
        execution_deadline: Date;
        parent_job_id: string | null;
      }>(
        `SELECT g.graph, i.task_input AS task, n.binding, n.spec -> 'inputs' AS inputs,
             j.execution_deadline, g.parent_job_id
         FROM job_recipe_graphs g JOIN jobs j ON j.id = g.job_id
         JOIN job_inputs i ON i.job_id = g.job_id
         JOIN job_recipe_nodes n ON n.job_id = g.job_id
         WHERE g.job_id = $1 AND n.node_id = $2`,
        [jobId, input.nodeId],
      );
      if (!pinned || requestSha256(pinned.binding) !== input.bindingSha256)
        throw new TransportError("not_found", "Node bootstrap is unavailable");
      await tx.query("SELECT job_graph_take_claim($1,$2,$3,$4,$5,$6,$7)", [
        jobId,
        input.nodeId,
        hashServiceToken(bootstrapToken),
        input.invocationNonce,
        input.backend,
        input.executionRef,
        hashServiceToken(uploadToken),
      ]);
      const seconds = Math.min(
        deps.config.readUrlSeconds,
        Math.floor((pinned.execution_deadline.getTime() - Date.now()) / 1000),
      );
      if (seconds <= 0)
        throw new TransportError("forbidden", "Node deadline passed");
      const signed = async (file: NodeInputFile) => ({
        fileId: file.id,
        sha256: file.sha256,
        sizeBytes: file.size_bytes,
        readUrl: await deps.presignRead(file.object_key, seconds),
      });
      const {
        rows: [source],
      } = await tx.query<NodeInputFile>(
        `SELECT f.id, f.sha256, f.size_bytes::text, f.object_key
         FROM jobs j JOIN recording_admissions a ON a.recording_id = j.recording_id
           AND a.source_manifest_sha256 = j.source_manifest_sha256 AND a.outcome = 'admitted'
         JOIN files f ON f.recording_id = j.recording_id
           AND f.purpose = 'source' AND f.role = 'source_mcap'
           AND f.state IN ('verified', 'completed')
           AND a.declared_files @> jsonb_build_array(jsonb_build_object(
             'fileId', f.id::text, 'role', 'source_mcap', 'sha256', f.sha256, 'required', true
           ))
         WHERE j.id = $1`,
        [jobId],
      );
      if (!source)
        throw new TransportError(
          "conflict",
          "Sealed MCAP input is unavailable",
        );
      async function producerFiles(
        producerJobId: string,
        producerId: string,
        port: string,
      ) {
        const { rows } = await tx.query<
          NodeInputFile & { logical_file: string }
        >(
          `SELECT f.id, o.sha256, o.size_bytes::text, f.object_key,
             files.key AS logical_file
           FROM job_recipe_node_outputs o JOIN files f ON f.id = o.file_id
           JOIN job_recipe_node_results result ON result.job_id = o.job_id AND result.node_id = o.node_id
           LEFT JOIN job_recipe_node_results original ON original.job_id = result.reuse_job_id
             AND original.node_id = result.node_id
           JOIN job_output_slots s ON s.job_id = o.job_id AND s.file_id = f.id
           CROSS JOIN LATERAL jsonb_each(
             coalesce(result.receipt, original.receipt) #> ARRAY['outputs',o.port,'files']
           ) AS files
           WHERE o.job_id = $1 AND o.node_id = $2 AND o.port = $3 AND result.state = 'succeeded'
              AND files.value ->> 'name' = split_part(s.slot,'/',3)`,
          [producerJobId, producerId, port],
        );
        if (!rows.length)
          throw new TransportError(
            "conflict",
            "Verified producer file is unavailable",
          );
        return Object.fromEntries(
          await Promise.all(
            rows.map(async (file) => [file.logical_file, await signed(file)]),
          ),
        );
      }
      const inputs: Record<
        string,
        Awaited<ReturnType<typeof producerFiles>>
      > = {};
      for (const [port, edge] of Object.entries(pinned.inputs)) {
        if (edge.from === "recording.source" || edge.from === "clip.video")
          continue;
        const [producerId, producerPort] = edge.from.split(".");
        const producerJobId =
          pinned.parent_job_id &&
          pinned.graph.nodes[producerId!]?.scope === "recording"
            ? pinned.parent_job_id
            : jobId;
        inputs[port] = await producerFiles(
          producerJobId,
          producerId!,
          producerPort!,
        );
      }
      let clipPlan = null;
      if (pinned.parent_job_id) {
        const fanOut = pinned.graph.fanOut?.clip.split(".");
        if (!fanOut)
          throw new TransportError("conflict", "Verified plan is unavailable");
        const plan = await producerFiles(
          pinned.parent_job_id,
          fanOut[0]!,
          fanOut[1]!,
        );
        if (!plan.plan)
          throw new TransportError("conflict", "Verified plan is unavailable");
        clipPlan = plan.plan;
      }
      return {
        task: pinned.task,
        graph: pinned.graph,
        binding: pinned.binding,
        source: await signed(source),
        clipPlan,
        producerFiles: inputs,
        deadline: pinned.execution_deadline.toISOString(),
        uploadToken,
      };
    });
  } catch (error) {
    if (error instanceof CatalogError) {
      throw new TransportError(
        error.code === "idempotency_conflict" ? "conflict" : error.code,
        error.message,
        { cause: error },
      );
    }
    throw error;
  }
}

type NodeResult = Extract<GraphAction, { action: "record_node_result" }>;
type NodeOutput = NodeResult["files"][number] & {
  artifactType: string;
  sizeBytes: string;
  sha256: string;
};

async function recordNodeResult(
  deps: JobsDeps,
  jobId: string,
  input: NodeResult,
) {
  const { nodeId, owner } = input;
  if (input.state !== "succeeded") {
    if (input.receipt !== null || input.files.length)
      throw new TransportError(
        "conflict",
        "Unproved output cannot settle a node",
      );
    return settleNode(deps, jobId, input);
  }
  if (!deps.acceptance || !input.receipt)
    throw new TransportError(
      "conflict",
      "Node receipt verification is unavailable",
    );
  let receipt;
  try {
    receipt = readNodeReceipt(JSON.parse(input.receipt));
  } catch {
    throw new TransportError("invalid_request", "Invalid node receipt");
  }
  const {
    rows: [facts],
  } = await deps.pool.query<{
    spec: { producers: string[] };
    binding: Record<string, unknown>;
    parent_job_id: string | null;
    clip: unknown;
    state: string;
    execution_deadline: Date;
    expired: boolean;
  }>(
    `SELECT n.spec, n.binding, g.parent_job_id, i.task_input -> 'clip' as clip,
            j.execution_deadline, j.state, j.execution_deadline <= clock_timestamp() AS expired
     FROM job_recipe_nodes n JOIN jobs j ON j.id = n.job_id
     JOIN job_recipe_graphs g ON g.job_id = j.id JOIN job_inputs i ON i.job_id = j.id
     JOIN job_recipe_node_evidence e ON e.job_id = n.job_id AND e.node_id = n.node_id
     WHERE n.job_id = $1 AND n.node_id = $2 AND j.controller_lease_owner = $3
       AND j.controller_lease_expires_at > clock_timestamp() AND e.execution_ref = $4`,
    [jobId, nodeId, owner, receipt.executionRef],
  );
  if (!facts)
    throw new TransportError("conflict", "Node terminal proof is unavailable");
  if (facts.state !== "running" || facts.expired)
    return settleNode(deps, jobId, input);
  if (
    input.files.length !==
      Object.values(receipt.outputs).reduce(
        (n, p) => n + Object.keys(p.files).length,
        0,
      ) ||
    new Set(input.files.map((file) => file.fileId)).size !== input.files.length
  )
    throw new TransportError("conflict", "Node output inventory is incomplete");

  const { rows } = await deps.pool.query<
    NodeInputFile & { slot: string; verified: boolean }
  >(
    `SELECT f.id, f.object_key, f.size_bytes::text, f.sha256, s.slot,
            (v.file_id IS NOT NULL) AS verified
     FROM files f JOIN job_output_slots s ON s.job_id = f.job_id AND s.file_id = f.id
     LEFT JOIN job_graph_file_verifications v ON v.file_id = f.id AND v.job_id = f.job_id
       AND v.node_id = $3 AND v.sha256 = f.sha256 AND v.size_bytes = f.size_bytes
     WHERE f.job_id = $1 AND f.id = ANY($2::uuid[])
       AND f.purpose = 'output' AND f.state IN ('completed','verified')`,
    [jobId, input.files.map((file) => file.fileId), nodeId],
  );
  const storedFiles = new Map(rows.map((file) => [file.id, file]));
  const files = input.files.map((file) => {
    const port = receipt.outputs[file.port];
    const expected = port?.files[file.logicalFile];
    const stored = storedFiles.get(file.fileId);
    if (
      !port ||
      !expected ||
      expected.name !== file.name ||
      !stored ||
      stored.slot !== `nodes/${nodeId}/${file.name}` ||
      Number(stored.size_bytes) !== expected.sizeBytes ||
      stored.sha256 !== expected.sha256
    )
      throw new TransportError(
        "conflict",
        "Node output does not match its receipt and stored slot",
      );
    return { file, stored, artifactType: port.kind, size: expected.sizeBytes };
  });

  const sliceEnd = Date.now() + deps.acceptance.config.verifySliceMs;
  for (const { file, stored, size } of files) {
    if (stored.verified) continue;
    if (Date.now() >= Math.min(sliceEnd, facts.execution_deadline.getTime()))
      return { state: "verifying" };
    let actual;
    try {
      actual = await deps.acceptance.hasher.hash(
        stored.object_key,
        size,
        objectVerificationMs(size, facts.execution_deadline),
      );
    } catch (error) {
      if (
        !(error instanceof ObjectHashError) ||
        error.code === "object_read_failed"
      )
        return { state: "verifying" };
      return settleNode(deps, jobId, {
        ...input,
        state: "failed",
        errorCode:
          error.code === "object_missing"
            ? "node_output_missing"
            : "node_output_hash_mismatch",
        receipt: null,
      });
    }
    if (actual.bytes !== size || actual.sha256 !== stored.sha256)
      return settleNode(deps, jobId, {
        ...input,
        state: "failed",
        errorCode: "node_output_hash_mismatch",
        receipt: null,
      });
    const {
      rows: [proof],
    } = await inTransaction(deps.pool, (tx) =>
      tx.query<{ recorded: boolean }>(
        "SELECT job_graph_verify_file($1,$2,$3,$4,$5,$6,$7) AS recorded",
        [jobId, nodeId, owner, file.fileId, file.name, actual.sha256, size],
      ),
    );
    if (!proof?.recorded) return settleNode(deps, jobId, input);
  }
  if (Date.now() >= sliceEnd) return { state: "verifying" };

  const inputs = await deps.pool.query(
    `SELECT o.node_id, o.port, o.sha256, o.artifact_type
     FROM job_recipe_node_outputs o
     WHERE o.job_id IN ($1,$2::uuid) AND o.node_id IN (
      SELECT jsonb_array_elements_text($3::jsonb)
     )
     ORDER BY o.node_id,o.port,o.artifact_type,o.sha256`,
    [jobId, facts.parent_job_id, JSON.stringify(facts.spec.producers)],
  );
  return settleNode(
    deps,
    jobId,
    input,
    files.map(({ file, stored, artifactType }) => ({
      ...file,
      artifactType,
      sizeBytes: stored.size_bytes,
      sha256: stored.sha256,
    })),
    requestSha256({
      spec: facts.spec,
      binding: facts.binding,
      input: inputs.rows,
      sourceSha256: receipt.sourceSha256,
      clip: facts.clip,
    }),
  );
}

async function settleNode(
  deps: JobsDeps,
  jobId: string,
  input: NodeResult,
  verified: NodeOutput[] = [],
  fingerprint: string | null = null,
) {
  const { state, errorCode } = input;
  await inTransaction(deps.pool, async (tx) => {
    await tx.query("SELECT job_graph_record_result($1,$2,$3,$4,$5,$6,$7,$8)", [
      jobId,
      input.nodeId,
      input.owner,
      state,
      errorCode,
      state === "succeeded" ? input.receipt : null,
      JSON.stringify(state === "succeeded" ? verified : []),
      state === "succeeded" ? fingerprint : null,
    ]);
  });
  return { state: "recorded" };
}
