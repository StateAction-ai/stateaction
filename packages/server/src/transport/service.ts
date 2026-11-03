import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  inTransaction,
  outputObjectKey,
  reserveSourceFile,
} from "../catalog/catalog.js";
import type { AdmissionDeps } from "../admission/recordings.js";
import { CatalogError } from "../catalog/errors.js";
import {
  assertJobAuthority,
  assertOwnerAuthority,
  authorizeFile,
  FILE_COLUMNS,
  type Authority,
  type FileRow,
} from "./authority.js";
import { TransportError } from "./errors.js";
import {
  MAX_PARTS,
  MAX_SIGN_BATCH,
  normalizeEtag,
  partRange,
  planFor,
  TRANSPORT_LIFETIME_MS,
  URL_TTL_SECONDS,
  type PartPlan,
} from "./plan.js";
import type { MultipartProvider } from "./provider.js";

export type TransportDeps = {
  pool: pg.Pool;
  provider: MultipartProvider;
  now?: () => Date;
  /** Init-claim lease; a crashed initializer is retried after this. */
  claimLeaseMs?: number;
  /** Lease for a recovery transition (complete/reconcile/cancel/restart). */
  transitionLeaseMs?: number;
  /**
   * Recording admission (SA-19). Finalizing a SOURCE file goes through its
   * `recordSourceCompletion` so the eligibility step runs in the same
   * transaction; absent configuration fails closed rather than completing a
   * source file without admission. Resolved lazily so other transport routes
   * do not depend on admission settings.
   */
  admission?: () => AdmissionDeps;
};

export const SOURCE_ROLES = [
  "source_manifest",
  "source_mcap",
  "recorder_metadata",
  "calibration",
] as const;
export const OUTPUT_ROLES = [
  "result_manifest",
  "clip_mp4",
  "hand_arrays_npz",
  "hand_observations_json",
  "frame_map_json",
  "thumbnail_jpeg",
  "viewer_rrd",
] as const;
export const MAX_SOURCE_MANIFEST_BYTES = 1_048_576n;
/** Per-file / per-job caps for worker outputs (bounded inventory). */
export const MAX_OUTPUT_FILE_BYTES = 34_359_738_368n; // 32 GiB
export const MAX_JOB_OUTPUT_FILES = 512;
export const MAX_JOB_OUTPUT_BYTES = 68_719_476_736n; // 64 GiB
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLOT = /^[A-Za-z0-9._-]{1,128}(\/[A-Za-z0-9._-]{1,128}){0,7}$/;

const invalid = (message: string) =>
  new TransportError("invalid_request", message);
export const nowOf = (deps: TransportDeps) =>
  (deps.now ?? (() => new Date()))();

/** Maps SA-13 catalog/DB errors onto transport errors. */
export async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CatalogError)
      throw new TransportError(
        error.code === "idempotency_conflict" ? "conflict" : error.code,
        error.message,
        { cause: error },
      );
    throw error;
  }
}
export async function provider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError(
      "provider_unavailable",
      "Storage provider request failed",
      { cause: error },
    );
  }
}

// ------------------------------------------------------------------ plan DTO

/** `http.upload-plan.v1` payload for a file row. */
export type UploadPlan = {
  fileId: string;
  recordingId: string;
  role: string;
  sizeBytes: string;
  sha256: string;
  transportEpoch: number;
  partSizeBytes: string;
  partCount: number;
  state: string;
  transportExpiresAt: string;
};
export function toUploadPlan(file: FileRow): UploadPlan {
  const expires =
    file.transport_expires_at ??
    new Date(file.created_at.getTime() + TRANSPORT_LIFETIME_MS);
  return {
    fileId: file.id,
    recordingId: file.recording_id,
    role: file.role,
    sizeBytes: file.size_bytes,
    sha256: file.sha256,
    transportEpoch: file.transport_epoch,
    partSizeBytes: file.part_size_bytes,
    partCount: file.part_count,
    state: file.state,
    transportExpiresAt: expires.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}
export function framePlan(file: FileRow): PartPlan {
  const plan = planFor(BigInt(file.size_bytes));
  // The row's frozen plan must be the canonical server plan.
  if (
    String(plan.partSizeBytes) !== file.part_size_bytes ||
    plan.partCount !== file.part_count
  )
    throw new TransportError("conflict", "Stored part plan is not canonical");
  return plan;
}

// --------------------------------------------------------------- reservation

export type SourceUploadRequest = {
  recordingId: string;
  clientUploadId: string;
  role: (typeof SOURCE_ROLES)[number];
  sizeBytes: string;
  sha256: string;
};

/**
 * POST /uploads: reserve the logical file and its server-chosen private key
 * BEFORE any provider call, then initialize the provider upload. The client
 * supplies identity (recording, role, size, hash), never keys/ranges/buckets.
 */
export async function allocateSourceUpload(
  deps: TransportDeps,
  authority: Extract<Authority, { kind: "owner" }>,
  request: SourceUploadRequest,
): Promise<UploadPlan> {
  if (!UUID.test(request.recordingId))
    throw invalid("recordingId must be a UUID");
  if (!UUID.test(request.clientUploadId))
    throw invalid("clientUploadId must be a UUID");
  if (!(SOURCE_ROLES as readonly string[]).includes(request.role))
    throw invalid("Unsupported source role");
  if (!SHA.test(request.sha256)) throw invalid("sha256 must be lowercase hex");
  if (!/^[1-9][0-9]{0,11}$/.test(request.sizeBytes))
    throw invalid("Invalid sizeBytes");
  const size = BigInt(request.sizeBytes);
  if (request.role === "source_manifest" && size > MAX_SOURCE_MANIFEST_BYTES)
    throw invalid("source_manifest is limited to 1 MiB");
  let plan: PartPlan;
  try {
    plan = planFor(size);
  } catch {
    throw invalid("sizeBytes is outside the transport cap");
  }
  await assertOwnerAuthority(deps.pool, authority, request.recordingId);
  const reserved = await mapped(() =>
    reserveSourceFile(deps.pool, {
      fileId: randomUUID(),
      recordingId: request.recordingId,
      ownerUserId: authority.userId,
      clientUploadId: request.clientUploadId,
      role: request.role,
      sizeBytes: request.sizeBytes,
      sha256: request.sha256,
      required: true,
      partSizeBytes: String(plan.partSizeBytes),
      partCount: plan.partCount,
    }),
  );
  return initializeTransport(deps, authority, reserved.fileId);
}

export type OutputRequest = {
  slot: string;
  role: (typeof OUTPUT_ROLES)[number];
  sizeBytes: string;
  sha256: string;
};

/** POST /internal/v1/jobs/{jobId}/outputs: bounded, idempotent per slot. */
export async function allocateJobOutput(
  deps: TransportDeps,
  authority: Extract<Authority, { kind: "job" }>,
  request: OutputRequest,
): Promise<UploadPlan> {
  if (!SLOT.test(request.slot) || /(^|\/)\.{1,2}(\/|$)/.test(request.slot))
    throw invalid("Unsafe output slot");
  if (!(OUTPUT_ROLES as readonly string[]).includes(request.role))
    throw invalid("Unsupported output role");
  if (!SHA.test(request.sha256)) throw invalid("sha256 must be lowercase hex");
  if (!/^[1-9][0-9]{0,11}$/.test(request.sizeBytes))
    throw invalid("Invalid sizeBytes");
  const size = BigInt(request.sizeBytes);
  if (size > MAX_OUTPUT_FILE_BYTES)
    throw invalid("Output exceeds the per-file cap");
  const plan = planFor(size);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        request.slot,
        request.role,
        request.sizeBytes,
        request.sha256,
      ]),
    )
    .digest("hex");
  const fileId = await mapped(() =>
    inTransaction(deps.pool, async (tx) => {
      // Serialize slot allocation and cap accounting for this job, and take the
      // row lock BEFORE the live authority check: a cancellation, deadline or
      // pointer change that already won its transition is then always seen, so
      // no new output allocation is granted after it.
      await tx.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [
        authority.jobId,
      ]);
      const { jobId, recordingId } = await assertJobAuthority(tx, authority);
      const existing = await tx.query<{
        file_id: string;
        request_digest: string;
      }>(
        "SELECT file_id, request_digest FROM job_output_slots WHERE job_id = $1 AND slot = $2",
        [jobId, request.slot],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== digest)
          throw new TransportError(
            "conflict",
            "Output slot already holds a different file",
          );
        return existing.rows[0].file_id;
      }
      const totals = await tx.query<{ n: string; bytes: string }>(
        `SELECT count(*)::text AS n, COALESCE(sum(size_bytes), 0)::text AS bytes
         FROM files WHERE job_id = $1 AND purpose = 'output'
           AND state NOT IN ('cancelled', 'failed', 'expired')`,
        [jobId],
      );
      if (
        Number(totals.rows[0]!.n) >= MAX_JOB_OUTPUT_FILES ||
        BigInt(totals.rows[0]!.bytes) + size > MAX_JOB_OUTPUT_BYTES
      )
        throw new TransportError(
          "conflict",
          "Job output inventory cap reached",
        );
      const id = randomUUID();
      await tx.query(
        `INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256,
           object_key, part_size_bytes, part_count)
         VALUES ($1, $2, $3, 'output', $4, $5, $6, $7, $8, $9)`,
        [
          id,
          recordingId,
          jobId,
          request.role,
          request.sizeBytes,
          request.sha256,
          outputObjectKey(jobId, id, 1, request.slot),
          String(plan.partSizeBytes),
          plan.partCount,
        ],
      );
      await tx.query(
        "INSERT INTO job_output_slots (job_id, slot, file_id, request_digest) VALUES ($1, $2, $3, $4)",
        [jobId, request.slot, id, digest],
      );
      return id;
    }),
  );
  return initializeTransport(deps, authority, fileId);
}

// -------------------------------------------------------------- provider init

/**
 * Creates (or adopts) the provider multipart upload for the reserved key and
 * persists its ID before returning. Provider calls run outside transactions
 * behind a lease claim; an uncertain earlier creation is found by listing the
 * exact key instead of being blindly repeated.
 */
export async function initializeTransport(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
): Promise<UploadPlan> {
  const file = await mapped(() => authorizeFile(deps.pool, fileId, authority));
  if (file.provider_upload_id) return toUploadPlan(file);
  if (file.state !== "reserved")
    throw new TransportError("conflict", `File is ${file.state}`);
  framePlan(file);
  const token = randomUUID();
  const lease = deps.claimLeaseMs ?? 60_000;
  const claimed = await deps.pool.query(
    `INSERT INTO file_transport_claims (file_id, transport_epoch, claim_token, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)
     ON CONFLICT (file_id) DO UPDATE
       SET transport_epoch = EXCLUDED.transport_epoch, claim_token = EXCLUDED.claim_token,
           expires_at = EXCLUDED.expires_at
       WHERE file_transport_claims.expires_at < now()
          OR file_transport_claims.transport_epoch <> EXCLUDED.transport_epoch
     RETURNING claim_token`,
    [file.id, file.transport_epoch, token, String(lease)],
  );
  if (!claimed.rowCount) {
    // Another initializer owns the lease; if it already finished, use that.
    const current = await authorizeFile(deps.pool, fileId, authority);
    if (current.provider_upload_id) return toUploadPlan(current);
    throw new TransportError(
      "conflict",
      "Upload initialization is in progress; retry",
    );
  }
  try {
    let created: { uploadId: string; initiatedAt: Date | null } | undefined;
    let adopted = false;
    const upload = await provider(async () => {
      const existing = await deps.provider.listUploadsForKey(file.object_key);
      if (existing.length > 1)
        throw new TransportError(
          "provider_ambiguous",
          "Several provider uploads exist for the reserved key",
        );
      if (existing[0]) {
        adopted = true;
        return existing[0];
      }
      created = await deps.provider.createUpload(file.object_key);
      return created;
    });
    const initiated = upload.initiatedAt ?? nowOf(deps);
    const expires = new Date(initiated.getTime() + TRANSPORT_LIFETIME_MS);
    const updated = await deps.pool.query(
      `UPDATE files SET provider_upload_id = $3, state = 'uploading', transport_expires_at = $4
     WHERE id = $1 AND transport_epoch = $2 AND provider_upload_id IS NULL AND state = 'reserved'`,
      [file.id, file.transport_epoch, upload.uploadId, expires],
    );
    if (!updated.rowCount && created && !adopted) {
      // Lost the persist. Another initializer may have adopted the very upload
      // we created (our lease expired mid-creation, it listed the exact key and
      // persisted it). Provider IDs are opaque: R2 returns a create-time ID and
      // list-time IDs that differ yet address the same upload, so ID inequality
      // alone never proves an orphan. Retire ours only when the exact-key
      // listing shows both the persisted ID and our ID as separate uploads;
      // anything ambiguous is left to the bounded lifecycle / SA-21 reconcile.
      const persisted = (
        await deps.pool.query<{ provider_upload_id: string | null }>(
          "SELECT provider_upload_id FROM files WHERE id = $1",
          [file.id],
        )
      ).rows[0]?.provider_upload_id;
      if (!persisted) {
        // The file no longer points at any upload (cancelled or restarted while
        // we were creating), so ours can never be used: retire it.
        await deps.provider
          .abortUpload(file.object_key, created.uploadId)
          .catch(() => undefined);
      } else if (persisted !== created.uploadId) {
        const listed = await deps.provider
          .listUploadsForKey(file.object_key)
          .catch(() => []);
        const ids = new Set(listed.map((u) => u.uploadId));
        if (ids.has(persisted) && ids.has(created.uploadId))
          await deps.provider
            .abortUpload(file.object_key, created.uploadId)
            .catch(() => undefined);
      }
    }
  } finally {
    // The claim only serializes the in-flight provider call; a retry after any
    // failure reconciles the exact key, so releasing it is always safe.
    await deps.pool
      .query(
        "DELETE FROM file_transport_claims WHERE file_id = $1 AND claim_token = $2",
        [file.id, token],
      )
      .catch(() => undefined);
  }
  return toUploadPlan(await authorizeFile(deps.pool, fileId, authority));
}

export async function getUploadPlan(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
): Promise<UploadPlan> {
  return toUploadPlan(await authorizeFile(deps.pool, fileId, authority));
}

// -------------------------------------------------------------------- signing

export type SignedPart = {
  partNumber: number;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  offsetBytes: string;
  lengthBytes: string;
  expiresAt: string;
};

function checkPartNumbers(partNumbers: unknown, partCount: number): number[] {
  if (
    !Array.isArray(partNumbers) ||
    partNumbers.length < 1 ||
    partNumbers.length > MAX_SIGN_BATCH
  )
    throw invalid(`partNumbers must hold 1..${MAX_SIGN_BATCH} entries`);
  const seen = new Set<number>();
  for (const n of partNumbers) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS || n > partCount)
      throw invalid("partNumbers outside the frozen plan");
    if (seen.has(n)) throw invalid("partNumbers must be unique");
    seen.add(n);
  }
  return partNumbers as number[];
}
export function checkEpoch(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 1000
  )
    throw invalid("expectedTransportEpoch must be 1..1000");
  return value as number;
}
export function assertWritable(file: FileRow, expectedEpoch: number, at: Date) {
  if (file.transport_epoch !== expectedEpoch)
    throw new TransportError("conflict", "Stale transport epoch");
  if (file.state !== "uploading" || !file.provider_upload_id)
    throw new TransportError(
      "conflict",
      `File is ${file.state}, not accepting parts`,
    );
  if (!file.transport_expires_at || file.transport_expires_at <= at)
    throw new TransportError(
      "conflict",
      "Transport has expired; restart required",
    );
}

/** POST /uploads/{fileId}/parts/sign: scoped presigned PUTs, JSON control only. */
export async function signParts(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
  body: { expectedTransportEpoch: unknown; partNumbers: unknown },
): Promise<{ transportEpoch: number; parts: SignedPart[] }> {
  const epoch = checkEpoch(body.expectedTransportEpoch);
  const file = await mapped(() => authorizeFile(deps.pool, fileId, authority));
  const plan = framePlan(file);
  const numbers = checkPartNumbers(body.partNumbers, plan.partCount);
  const at = nowOf(deps);
  assertWritable(file, epoch, at);
  const ttl = Math.min(
    URL_TTL_SECONDS,
    Math.floor((file.transport_expires_at!.getTime() - at.getTime()) / 1000),
  );
  if (ttl < 1)
    throw new TransportError(
      "conflict",
      "Transport has expired; restart required",
    );
  const expiresAt = new Date(at.getTime() + ttl * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const parts = await provider(() =>
    Promise.all(
      numbers.map(async (n): Promise<SignedPart> => {
        const range = partRange(plan, n);
        return {
          partNumber: n,
          method: "PUT",
          url: await deps.provider.presignUploadPart({
            key: file.object_key,
            uploadId: file.provider_upload_id!,
            partNumber: n,
            lengthBytes: range.lengthBytes,
            expiresInSeconds: ttl,
          }),
          headers: { "Content-Length": String(range.lengthBytes) },
          offsetBytes: String(range.offsetBytes),
          lengthBytes: String(range.lengthBytes),
          expiresAt,
        };
      }),
    ),
  );
  // Re-check after the (offline) signing: authority or epoch may have changed.
  const after = await mapped(() => authorizeFile(deps.pool, fileId, authority));
  assertWritable(after, epoch, nowOf(deps));
  return { transportEpoch: epoch, parts };
}

// ------------------------------------------------------------------- receipts

export type ReceiptInput = {
  partNumber: number;
  etag: string;
  sizeBytes: string;
};
export type ReceiptResult = {
  transportEpoch: number;
  journaled: number[];
  alreadyJournaled: number[];
};

/**
 * PUT /uploads/{fileId}/parts/receipts. Receipts are exact {part, ETag, size}
 * facts. Each is corroborated against the provider's ListParts before it is
 * journaled, so a client cannot invent receipts; an identical replay is a no-op;
 * a different ETag for a journaled part is accepted only when the provider
 * confirms it (a re-uploaded part) and otherwise conflicts. ETags are provider
 * receipts, never content hashes.
 */
export async function journalReceipts(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
  body: { expectedTransportEpoch: unknown; receipts: unknown },
): Promise<ReceiptResult> {
  const epoch = checkEpoch(body.expectedTransportEpoch);
  if (
    !Array.isArray(body.receipts) ||
    body.receipts.length < 1 ||
    body.receipts.length > MAX_SIGN_BATCH
  )
    throw invalid(`receipts must hold 1..${MAX_SIGN_BATCH} entries`);
  const file = await mapped(() => authorizeFile(deps.pool, fileId, authority));
  const plan = framePlan(file);
  const receipts = new Map<number, { etag: string; size: bigint }>();
  for (const raw of body.receipts as ReceiptInput[]) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !Number.isInteger(raw.partNumber) ||
      typeof raw.etag !== "string" ||
      typeof raw.sizeBytes !== "string" ||
      !/^(?:"[A-Za-z0-9-]{1,128}"|[A-Za-z0-9-]{1,128})$/.test(raw.etag) ||
      !/^[1-9][0-9]{0,11}$/.test(raw.sizeBytes)
    )
      throw invalid("Malformed receipt");
    checkPartNumbers([raw.partNumber], plan.partCount);
    if (receipts.has(raw.partNumber)) throw invalid("Duplicate receipt part");
    const size = BigInt(raw.sizeBytes);
    if (size !== partRange(plan, raw.partNumber).lengthBytes)
      throw invalid(`Part ${raw.partNumber} has the wrong planned length`);
    receipts.set(raw.partNumber, { etag: normalizeEtag(raw.etag), size });
  }
  const numbers = [...receipts.keys()].sort((a, b) => a - b);
  const stored = await deps.pool.query<{ part_number: number; etag: string }>(
    `SELECT part_number, etag FROM file_part_receipts
     WHERE file_id = $1 AND transport_epoch = $2 AND part_number = ANY($3)`,
    [file.id, epoch, numbers],
  );
  if (file.transport_epoch !== epoch)
    throw new TransportError("conflict", "Stale transport epoch");
  const have = new Map(stored.rows.map((r) => [r.part_number, r.etag]));
  const already = numbers.filter((n) => have.get(n) === receipts.get(n)!.etag);
  const todo = numbers.filter((n) => !already.includes(n));
  if (todo.length === 0)
    return { transportEpoch: epoch, journaled: [], alreadyJournaled: already };
  assertWritable(file, epoch, nowOf(deps));
  const listed = await provider(() =>
    deps.provider.listParts(
      file.object_key,
      file.provider_upload_id!,
      todo[0]!,
      todo[todo.length - 1]!,
    ),
  );
  // S3/R2 list one entry per part number. SeaweedFS may list a re-uploaded part
  // more than once, so a receipt is corroborated by any exactly matching entry.
  for (const n of todo) {
    const want = receipts.get(n)!;
    const entries = listed.filter((p) => p.partNumber === n);
    if (entries.length === 0)
      throw new TransportError(
        "conflict",
        `Provider has no part ${n}; upload it first`,
      );
    if (!entries.some((e) => e.etag === want.etag && e.sizeBytes === want.size))
      throw new TransportError(
        "conflict",
        `Receipt for part ${n} does not match the provider`,
      );
  }
  const journaled: number[] = [];
  const replaced: number[] = [];
  await mapped(() =>
    inTransaction(deps.pool, async (tx) => {
      // Lock the file row: serializes with transport transitions, and revalidates
      // authority/epoch/state at the moment of the write.
      const locked = await authorizeFile(tx, fileId, authority, { lock: true });
      assertWritable(locked, epoch, nowOf(deps));
      for (const n of todo) {
        const want = receipts.get(n)!;
        const res = await tx.query(
          `INSERT INTO file_part_receipts (file_id, transport_epoch, part_number, etag, size_bytes, corroborated_at)
           VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT DO NOTHING`,
          [file.id, epoch, n, want.etag, String(want.size)],
        );
        if (res.rowCount) {
          journaled.push(n);
          continue;
        }
        // Raced with a replay or a re-uploaded part: provider already confirmed this ETag.
        const upd = await tx.query(
          `UPDATE file_part_receipts SET etag = $4, corroborated_at = now()
           WHERE file_id = $1 AND transport_epoch = $2 AND part_number = $3 AND etag <> $4`,
          [file.id, epoch, n, want.etag],
        );
        (upd.rowCount ? replaced : already).push(n);
      }
    }),
  );
  return {
    transportEpoch: epoch,
    journaled: [...journaled, ...replaced].sort((a, b) => a - b),
    alreadyJournaled: [...new Set(already)].sort((a, b) => a - b),
  };
}

export { FILE_COLUMNS };
