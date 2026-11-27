import type pg from "pg";
import { assertJobOutputOpen } from "../jobs/current.js";
import { TransportError } from "./errors.js";

/**
 * Who is calling, as resolved by the (later) route layer. The service never
 * trusts this blindly: every operation re-checks the live database state, so a
 * revoked role, expired/removed session, finished job or rotated capability
 * stops working immediately and nothing is cached.
 */
export type Authority =
  /** Collector-owned Better Auth session uploading its own recording. */
  | { kind: "owner"; userId: string; sessionId: string }
  /**
   * Worker principal already authenticated by the route layer with
   * authenticateService({ kinds: ["worker"], scope: "job:output", jobId }),
   * i.e. a server-issued credential bound to exactly this job. Never a human
   * session and never a client-supplied key.
   */
  | {
      kind: "job";
      jobId: string;
      sealLeaseOwner?: string;
      stage?: string;
      nodeId?: string;
    };

export const PREPARED_RECIPE_SLOT =
  "diagnostics/hand_pose/prepared-result.json";
export const RESULT_MANIFEST_SLOT = "result-manifest.json";

export type FileRow = {
  id: string;
  recording_id: string;
  job_id: string | null;
  purpose: "source" | "output";
  role: string;
  size_bytes: string;
  sha256: string;
  state: string;
  transport_epoch: number;
  object_key: string;
  provider_upload_id: string | null;
  part_size_bytes: string;
  part_count: number;
  transport_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const FILE_COLUMNS = `f.id, f.recording_id, f.job_id, f.purpose, f.role, f.size_bytes::text, f.sha256,
  f.state, f.transport_epoch, f.object_key, f.provider_upload_id, f.part_size_bytes::text,
  f.part_count, f.transport_expires_at, f.created_at, f.updated_at`;

type Db = pg.Pool | pg.PoolClient;
const forbidden = () =>
  new TransportError("forbidden", "Not authorized for this upload");

/**
 * Live owner check: enabled collector role, unexpired session of that user,
 * the recording they own and its still-active capture permission evidence
 * (revoking the evidence stops uploads immediately).
 */
export async function assertOwnerAuthority(
  db: Db,
  authority: Extract<Authority, { kind: "owner" }>,
  recordingId: string,
): Promise<void> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM recordings r
       JOIN "session" s ON s."userId" = r.owner_user_id AND s.id = $2 AND s."expiresAt" > now()
       WHERE r.id = $3 AND r.owner_user_id = $1 AND r.deleted_at IS NULL
         AND r.status IN ('registered', 'uploading', 'sealed', 'uploaded')
         AND catalog_has_role(r.owner_user_id, 'collector')
         AND EXISTS (
           SELECT 1 FROM recording_registrations g
           WHERE g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
             AND ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, false)
         )
     ) AS ok`,
    [authority.userId, authority.sessionId, recordingId],
  );
  // Another user's recording is indistinguishable from a missing one.
  if (!rows[0]?.ok) throw new TransportError("not_found", "Upload not found");
}

/**
 * Live job check for output mutations: the full current-claim predicate
 * (state, claim, slot, absolute deadline, current recording pointer, owner
 * role and permission), re-read on every call.
 */
export async function assertJobAuthority(
  db: Db,
  authority: Extract<Authority, { kind: "job" }>,
  expectedJobId?: string | null,
): Promise<{ jobId: string; recordingId: string }> {
  if (expectedJobId && expectedJobId !== authority.jobId) throw forbidden();
  try {
    const current = await assertJobOutputOpen(db, authority.jobId);
    if (authority.nodeId) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM job_recipe_node_claims c
         WHERE c.job_id = $1 AND c.node_id = $2 AND c.claimed_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM job_recipe_node_evidence e
                           WHERE e.job_id = c.job_id AND e.node_id = c.node_id)`,
        [authority.jobId, authority.nodeId],
      );
      if (!rowCount) throw forbidden();
    }
    if (authority.sealLeaseOwner !== undefined) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM jobs WHERE id = $1
           AND controller_lease_owner = $2 AND controller_lease_expires_at > now()
           AND ((recipe_parallel AND job_recipe_stages_settled(id))
             OR (job_graph_settled(id) AND EXISTS (SELECT 1 FROM job_graph_seals WHERE job_id = jobs.id)))`,
        [authority.jobId, authority.sealLeaseOwner],
      );
      if (!rowCount) throw forbidden();
    }
    return { jobId: current.jobId, recordingId: current.recordingId };
  } catch {
    throw forbidden();
  }
}

/** The prepared and final manifest slots each have a single writer. */
export async function assertResultSlotAuthority(
  db: Db,
  authority: Extract<Authority, { kind: "job" }>,
  slot: string,
): Promise<void> {
  if (authority.nodeId && !slot.startsWith("nodes/" + authority.nodeId + "/"))
    throw forbidden();
  if (slot === PREPARED_RECIPE_SLOT && authority.stage !== "hand_pose")
    throw forbidden();
  if (slot === RESULT_MANIFEST_SLOT && authority.sealLeaseOwner === undefined) {
    const { rows } = await db.query<{ recipe_parallel: boolean }>(
      "SELECT recipe_parallel OR EXISTS (SELECT 1 FROM job_recipe_graphs WHERE job_id = jobs.id) AS recipe_parallel FROM jobs WHERE id = $1",
      [authority.jobId],
    );
    if (rows[0]?.recipe_parallel) throw forbidden();
  }
}

/**
 * Loads a file and authorizes the caller for exactly its kind: humans only
 * reach source files of their own recordings, workers only the outputs of their
 * own running job. Human cookies can never call job routes and vice versa.
 */
export async function authorizeFile(
  db: Db,
  fileId: string,
  authority: Authority,
  options: { lock?: boolean } = {},
): Promise<FileRow> {
  const { rows } = await db.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM files f WHERE f.id = $1${options.lock ? " FOR UPDATE" : ""}`,
    [fileId],
  );
  const file = rows[0];
  if (!file) throw new TransportError("not_found", "Upload not found");
  if (authority.kind === "owner") {
    if (file.purpose !== "source") throw forbidden();
    await assertOwnerAuthority(db, authority, file.recording_id);
  } else {
    if (file.purpose !== "output") throw forbidden();
    await assertJobAuthority(db, authority, file.job_id);
    if (authority.nodeId) {
      const {
        rows: [output],
      } = await db.query<{ slot: string }>(
        "SELECT slot FROM job_output_slots WHERE job_id = $1 AND file_id = $2",
        [authority.jobId, file.id],
      );
      if (!output) throw forbidden();
      await assertResultSlotAuthority(db, authority, output.slot);
    }
    if (file.role === "result_manifest")
      await assertResultSlotAuthority(db, authority, RESULT_MANIFEST_SLOT);
    if (file.role === "diagnostic_blob" && authority.stage !== "hand_pose") {
      const { rowCount } = await db.query(
        "SELECT 1 FROM job_output_slots WHERE job_id = $1 AND file_id = $2 AND slot = $3",
        [authority.jobId, file.id, PREPARED_RECIPE_SLOT],
      );
      if (rowCount) throw forbidden();
    }
  }
  return file;
}
