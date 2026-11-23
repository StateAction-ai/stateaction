import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Stage } from "@stateaction/contracts";
import type { DatasetAuthenticate } from "../datasets/http.js";
import { READ_TTL_SECONDS, type ReadSigner } from "../datasets/broker.js";
import { TransportError } from "../transport/errors.js";
import { errorResponse } from "../transport/http.js";
import { MAX_DIAGNOSTIC_BLOB_BYTES } from "../transport/service.js";
import { STAGES } from "./stages.js";

/**
 * SA-96: staff access to a job's `diagnostic_blob` outputs (slot
 * `diagnostics/<stage>/<name>`; the same slot-to-stage rule as STAGE_SLOT_SQL).
 * The listing feeds the Pipeline detail page; the read route mints one
 * short-lived GET URL for one such file. Both statements re-check the enabled
 * staff role in SQL and match the file to its job, role, purpose and state,
 * so an unknown, foreign or ineligible id is the same "not found".
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  vary: "Cookie, Authorization",
};
const CONTENT_TYPE = "text/plain; charset=utf-8";

export type DiagnosticFile = {
  fileId: string;
  stage: Stage;
  /** Slot path below `diagnostics/<stage>/`, e.g. `log.txt`. */
  name: string;
  sizeBytes: string;
};

/** `diagnostics/<stage>/<name>` to its stage and file name; null for any other slot. */
export function diagnosticSlot(
  slot: string,
): { stage: Stage; name: string } | null {
  const parts = slot.split("/");
  const stage = parts[1] as Stage;
  if (parts[0] !== "diagnostics" || parts.length < 3 || !STAGES.includes(stage))
    return null;
  return { stage, name: parts.slice(2).join("/") };
}

const ELIGIBLE = `f.purpose = 'output' AND f.role = 'diagnostic_blob'
  AND f.state IN ('completed', 'verified') AND s.slot LIKE 'diagnostics/%'
  AND catalog_has_role($1, 'staff')`;

/** Completed diagnostic_blob files of a job (empty for a non-staff viewer). */
export async function listJobDiagnostics(
  pool: Pick<pg.Pool, "query">,
  staffUserId: string,
  jobId: string,
): Promise<DiagnosticFile[]> {
  if (!UUID.test(jobId)) return [];
  const { rows } = await pool.query<{
    id: string;
    slot: string;
    size_bytes: string;
  }>(
    `SELECT f.id, s.slot, f.size_bytes::text
     FROM job_output_slots s JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
     WHERE s.job_id = $2 AND ${ELIGIBLE}
     ORDER BY s.slot`,
    [staffUserId, jobId],
  );
  return rows.flatMap((r) => {
    const d = diagnosticSlot(r.slot);
    return d
      ? [
          {
            fileId: r.id,
            stage: d.stage,
            name: d.name,
            sizeBytes: r.size_bytes,
          },
        ]
      : [];
  });
}

export type DiagnosticReadDeps = {
  pool: Pick<pg.Pool, "query">;
  signer: ReadSigner;
  authenticate: DatasetAuthenticate;
  now?: () => Date;
};

/**
 * POST /api/v1/jobs/{jobId}/diagnostics/{fileId}/read (staff only): a presigned
 * GET for that one object key, valid READ_TTL_SECONDS, never cacheable. The URL
 * is returned to the caller only; it is not logged or stored.
 */
export function jobDiagnosticRoutes(deps: DiagnosticReadDeps) {
  return {
    read: async (
      request: Request,
      jobId: string,
      fileId: string,
    ): Promise<Response> => {
      const auth = await deps.authenticate(request, "staff");
      if (!auth.ok) return auth.response;
      const requestId = auth.requestId ?? randomUUID();
      const headers = new Headers(auth.headers);
      try {
        if (!UUID.test(jobId) || !UUID.test(fileId))
          throw new TransportError("not_found", "Diagnostic file not found");
        const { rows } = await deps.pool.query<{
          object_key: string;
          size_bytes: string;
        }>(
          `SELECT f.object_key, f.size_bytes::text
           FROM job_output_slots s JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
           WHERE f.id = $3 AND s.job_id = $2 AND ${ELIGIBLE}
             AND split_part(s.slot, '/', 2) = ANY($4::text[])`,
          [auth.principal.userId, jobId, fileId, [...STAGES]],
        );
        const row = rows[0];
        if (!row)
          throw new TransportError("not_found", "Diagnostic file not found");
        if (BigInt(row.size_bytes) > MAX_DIAGNOSTIC_BLOB_BYTES)
          throw new TransportError("conflict", "File exceeds the read limit");
        const url = await deps.signer.presignRead({
          key: row.object_key,
          expiresInSeconds: READ_TTL_SECONDS,
          contentType: CONTENT_TYPE,
        });
        const issuedAt = (deps.now ?? (() => new Date()))();
        for (const [k, v] of Object.entries(JSON_HEADERS)) headers.set(k, v);
        return new Response(
          JSON.stringify({
            data: {
              url,
              fileId,
              contentType: CONTENT_TYPE,
              sizeBytes: row.size_bytes,
              expiresAt: new Date(
                issuedAt.getTime() + READ_TTL_SECONDS * 1000,
              ).toISOString(),
              ttlSeconds: READ_TTL_SECONDS,
            },
            requestId,
          }),
          { status: 200, headers },
        );
      } catch (error) {
        if (!(error instanceof TransportError))
          console.error(
            "[jobs] diagnostic read error",
            error instanceof Error ? error.name : "error",
          );
        const res = errorResponse(error, requestId);
        for (const [k, v] of res.headers) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
    },
  };
}
export type JobDiagnosticRoutes = ReturnType<typeof jobDiagnosticRoutes>;
