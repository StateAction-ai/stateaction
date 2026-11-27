import {
  sha256Hex,
  validateBytes,
  type ClipPlanV1,
  type CompiledGraph,
} from "@stateaction/contracts";
import { TransportError } from "../transport/errors.js";
import type { AcceptanceDeps } from "./service.js";

export const GRAPH_MANIFEST_CONTRACT = "artifacts.processing-result.v7";

type ProvedFile = {
  node_id: string;
  artifact_type: string;
  file_id: string;
  role: string;
  relative_path: string;
  object_key: string;
  size_bytes: string;
  sha256: string;
};

type GraphNodeFact = {
  node_id: string;
  module: string;
  state: string;
  error_code: string | null;
  receipt_sha256: string | null;
  receipt: Record<string, unknown> | null;
  execution_ref: string | null;
  source_job_id: string | null;
};

export async function graphPublicationFacts(
  pool: AcceptanceDeps["pool"],
  jobId: string,
) {
  const {
    rows: [run],
  } = await pool.query<{
    recording_id: string;
    source_manifest_sha256: string;
    kind: "clip_plan" | "clip_pipeline";
    graph: CompiledGraph;
    source_seconds: number;
    clip: { id: string; planSha256: string } | null;
    nonce: string;
  }>(
    `SELECT j.recording_id, j.source_manifest_sha256, j.kind, g.graph, g.source_seconds,
            i.task_input -> 'clip' AS clip, job_seal_nonce(j.id) AS nonce
     FROM jobs j JOIN job_recipe_graphs g ON g.job_id = j.id
     JOIN job_inputs i ON i.job_id = j.id
     WHERE j.id = $1 AND job_graph_settled(j.id)`,
    [jobId],
  );
  if (!run?.nonce)
    throw new TransportError("conflict", "Graph is not ready to assemble");
  const { rows: nodeFacts } = await pool.query<GraphNodeFact>(
    `SELECT n.node_id, n.spec ->> 'module' AS module, r.state, r.error_code,
            coalesce(r.receipt,original.receipt) AS receipt,
            coalesce(r.receipt_sha256,original.receipt_sha256) AS receipt_sha256,
            e.execution_ref, r.reuse_job_id AS source_job_id
     FROM job_recipe_nodes n JOIN job_recipe_node_results r USING (job_id,node_id)
     LEFT JOIN job_recipe_node_results original ON original.job_id = r.reuse_job_id AND original.node_id = r.node_id
     LEFT JOIN job_recipe_node_evidence e ON e.job_id = coalesce(r.reuse_job_id,r.job_id) AND e.node_id = r.node_id
     WHERE n.job_id = $1`,
    [jobId],
  );
  const { rows: files } = await pool.query<ProvedFile>(
    `SELECT o.node_id, o.artifact_type, f.id AS file_id, f.role, f.object_key,
            s.slot AS relative_path, o.size_bytes::text, o.sha256
     FROM job_recipe_node_outputs o JOIN files f ON f.id = o.file_id AND f.job_id = o.job_id
     JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
     WHERE o.job_id = $1 ORDER BY s.slot`,
    [jobId],
  );
  const byId = new Map(nodeFacts.map((node) => [node.node_id, node]));
  const nodes = run.graph.topoOrder.flatMap((nodeId) => {
    const node = byId.get(nodeId);
    if (!node) return [];
    const { receipt, ...facts } = node;
    return [
      {
        ...facts,
        counts: receipt?.counts ?? {},
        outputs: files
          .filter((file) => file.node_id === nodeId)
          .map((file) => file.file_id),
      },
    ];
  });
  const outputs = files.map(
    ({ node_id, artifact_type, object_key, ...descriptor }) => descriptor,
  );
  return { run, nodes, outputs, files, nodeFacts };
}

const ROLE_FILE_PREFIX = {
  clip_mp4: "rgb",
  hand_arrays_npz: "arrays",
  hand_observations_json: "observations",
  frame_map_json: "frame_map",
  thumbnail_jpeg: "thumbnail",
  viewer_rrd: "rrd",
};

export async function composeGraphManifest(
  deps: AcceptanceDeps,
  jobId: string,
) {
  const facts = await graphPublicationFacts(deps.pool, jobId);
  const { run, nodes, outputs, files, nodeFacts } = facts;
  const common = {
    schema: "stateaction.processing_result.v7",
    job_id: jobId,
    recording_id: run.recording_id,
    source_manifest_sha256: run.source_manifest_sha256,
    recipe_id: run.graph.recipe,
    recipe_sha256: run.graph.recipeSha256,
    outputs,
    nodes,
  };
  if (run.kind === "clip_plan") {
    const planNodeId = run.graph.fanOut?.clip.split(".")[0];
    const plan = files.find(
      (file) =>
        file.node_id === planNodeId && file.artifact_type === "clip_plan@1",
    );
    const video = files.filter(
      (file) => file.artifact_type === "review_video@1",
    );
    if (!plan || video.length !== 1)
      throw new TransportError(
        "conflict",
        "Plan and original video must both be verified",
      );
    const bytes = await deps.reader.read(plan.object_key, 1048576);
    const verdict = validateBytes("artifacts.clip-plan.v1", bytes);
    if (!verdict.valid || sha256Hex(bytes) !== plan.sha256)
      throw new TransportError(
        "conflict",
        "Verified graph plan bytes are unavailable",
      );
    const span = (verdict.value as ClipPlanV1).spans[0]!;
    if (
      BigInt(span.end_ts_ns) - BigInt(span.start_ts_ns) >
      BigInt(run.source_seconds) * 1000000000n
    )
      throw new TransportError(
        "conflict",
        "Graph plan exceeds admitted source duration",
      );
    return {
      ...common,
      scope: "recording",
      clip_plan: verdict.value,
      clips: [],
      checks: [],
    };
  }

  const hand = nodeFacts.find(
    (node) => node.state === "succeeded" && node.receipt?.handMetadata,
  );
  const metadata = hand?.receipt?.handMetadata as
    | {
        clips: Record<string, unknown>[];
        checks: { status?: unknown }[];
        attestation: Record<string, unknown>;
        [key: string]: unknown;
      }
    | undefined;
  if (
    !hand ||
    !metadata ||
    !Array.isArray(metadata.clips) ||
    !Array.isArray(metadata.checks) ||
    !run.clip
  )
    throw new TransportError(
      "conflict",
      "Graph clip has no verified hand metadata",
    );
  const clips = metadata.clips.map((chunk, index) => {
    const clipFiles = Object.fromEntries(
      Object.entries(ROLE_FILE_PREFIX).map(([role, prefix]) => {
        const expected =
          "nodes/" + hand.node_id + "/" + prefix + "_" + index + ".";
        const file = files.find(
          (item) =>
            item.node_id === hand.node_id &&
            item.role === role &&
            item.relative_path.startsWith(expected),
        );
        if (!file)
          throw new TransportError(
            "conflict",
            "Graph hand chunk output is incomplete",
          );
        return [role, file.file_id];
      }),
    );
    const inherited = hand.source_job_id ? String(chunk.clip_id) : null;
    const identity = inherited
      ? sha256Hex(Buffer.from(jobId + ":" + inherited))
      : null;
    return {
      ...chunk,
      ...(identity
        ? {
            original_clip_id: inherited,
            clip_id: [
              identity.slice(0, 8),
              identity.slice(8, 12),
              "8" + identity.slice(13, 16),
              "8" + identity.slice(17, 20),
              identity.slice(20, 32),
            ].join("-"),
          }
        : {}),
      files: {
        rgb_mp4: clipFiles.clip_mp4,
        ...Object.fromEntries(
          Object.entries(clipFiles).filter(([key]) => key !== "clip_mp4"),
        ),
      },
    };
  });
  return {
    ...metadata,
    ...common,
    clips,
    scope: "clip",
    review_clip_id: run.clip.id,
    clip_plan_sha256: run.clip.planSha256,
    attestation: { ...metadata.attestation, invocation_nonce: run.nonce },
  };
}
