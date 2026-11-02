import { randomUUID } from "node:crypto";
import { recordSourceCompletion } from "../admission/recordings.js";
import { inTransaction } from "../catalog/catalog.js";
import { toCatalogError } from "../catalog/errors.js";
import { authorizeFile, type Authority, type FileRow } from "./authority.js";
import { TransportError } from "./errors.js";
import { partRange, type PartPlan } from "./plan.js";
import { ProviderUploadGone, type ProviderObject } from "./provider.js";
import {
  assertWritable,
  checkEpoch,
  framePlan,
  initializeTransport,
  mapped,
  nowOf,
  provider,
  toUploadPlan,
  type TransportDeps,
  type UploadPlan,
} from "./service.js";

/**
 * SA-21 recovery layer: complete, reconcile, cancel and restart.
 *
 * Rules that every path below follows:
 *  - Provider truth comes only from authoritative reads of the exact key:
 *    HEAD of the key, the fully paginated multipart-upload listing for the key
 *    and ListParts of the persisted upload. The journal is evidence, never
 *    truth, and nothing is inferred from two opaque upload IDs being unequal
 *    (R2 returns create-time and list-time IDs that differ for one upload).
 *  - A provider call whose outcome is unknown (lost reply, DB failure after
 *    provider success) is reconciled with reads, never blindly repeated.
 *  - The never-reused object key makes "an object exists at the exact key"
 *    proof that this transport's completion happened; a size mismatch is
 *    ambiguous and blocks, it does not reopen anything.
 *  - ETags are provider receipts and never substitute for the SHA-256, which
 *    is verified later against the full object (not by this layer).
 *  - completed/verified files are closed (database trigger) and are never
 *    restarted, cancelled or reopened.
 */

export const DEFAULT_TRANSITION_LEASE_MS = 300_000;
const MAX_EPOCH = 1000;

const conflict = (message: string) => new TransportError("conflict", message);
const ambiguous = (message: string) =>
  new TransportError("provider_ambiguous", message);

// ------------------------------------------------------------------ claim

/**
 * Serializes provider-facing transitions of one file across processes. The
 * lease row is shared with provider initialization so a transition and an
 * initializer can never overlap for the same epoch.
 */
async function withClaim<T>(
  deps: TransportDeps,
  file: FileRow,
  work: (token: string) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const lease = deps.transitionLeaseMs ?? DEFAULT_TRANSITION_LEASE_MS;
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
  if (!claimed.rowCount)
    throw conflict("Another transport transition is in progress; retry");
  try {
    return await work(token);
  } finally {
    await deps.pool
      .query(
        "DELETE FROM file_transport_claims WHERE file_id = $1 AND claim_token = $2",
        [file.id, token],
      )
      .catch(() => undefined);
  }
}

// ------------------------------------------------------------------ helpers

async function load(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
  expectedEpoch: number,
): Promise<FileRow> {
  const file = await mapped(() => authorizeFile(deps.pool, fileId, authority));
  if (file.transport_epoch !== expectedEpoch)
    throw conflict("Stale transport epoch");
  return file;
}
const reload = (deps: TransportDeps, authority: Authority, fileId: string) =>
  mapped(() => authorizeFile(deps.pool, fileId, authority));

function assertSameTransport(file: FileRow, fresh: FileRow) {
  if (
    fresh.transport_epoch !== file.transport_epoch ||
    fresh.provider_upload_id !== file.provider_upload_id
  )
    throw conflict("Transport changed while the request was in flight");
}

type PartPick = { partNumber: number; etag: string; sizeBytes: bigint };
type Verification =
  | { gone: true }
  | {
      gone: false;
      /** Parts present at the provider with exactly the planned length. */
      picks: PartPick[];
      missing: number[];
      wrongLength: number[];
    };

/**
 * Compares the provider's complete listing (every page, 1..partCount) with the
 * frozen plan. Part numbers above the plan are ignored (the completion list
 * never names them). An ETag is only used to choose between duplicate entries
 * for one part number (SeaweedFS lists a re-uploaded part more than once) and
 * to detect a changed part; it is never treated as a content hash.
 */
async function verifyParts(
  deps: TransportDeps,
  file: FileRow,
  plan: PartPlan,
): Promise<Verification> {
  let listed;
  try {
    listed = await provider(() =>
      deps.provider.listParts(
        file.object_key,
        file.provider_upload_id!,
        1,
        plan.partCount,
      ),
    );
  } catch (error) {
    if (
      error instanceof TransportError &&
      error.cause instanceof ProviderUploadGone
    )
      return { gone: true };
    throw error;
  }
  const journal = new Map(
    (
      await deps.pool.query<{ part_number: number; etag: string }>(
        `SELECT part_number, etag FROM file_part_receipts
         WHERE file_id = $1 AND transport_epoch = $2`,
        [file.id, file.transport_epoch],
      )
    ).rows.map((r) => [r.part_number, r.etag]),
  );
  const byNumber = new Map<number, typeof listed>();
  for (const part of listed) {
    const entries = byNumber.get(part.partNumber) ?? [];
    entries.push(part);
    byNumber.set(part.partNumber, entries);
  }
  const picks: PartPick[] = [];
  const missing: number[] = [];
  const wrongLength: number[] = [];
  for (let n = 1; n <= plan.partCount; n++) {
    const entries = byNumber.get(n);
    if (!entries?.length) {
      missing.push(n);
      continue;
    }
    const want = partRange(plan, n).lengthBytes;
    const sized = entries.filter((e) => e.sizeBytes === want);
    if (sized.length === 0) {
      wrongLength.push(n);
      continue;
    }
    const journaled = journal.get(n);
    const match = sized.filter((e) => e.etag === journaled);
    const chosen = match.length ? match : sized;
    if (new Set(chosen.map((e) => e.etag)).size > 1)
      throw ambiguous(`Provider lists conflicting entries for part ${n}`);
    picks.push({ partNumber: n, etag: chosen[0]!.etag, sizeBytes: want });
  }
  return { gone: false, picks, missing, wrongLength };
}

const brief = (numbers: number[]) =>
  numbers.slice(0, 8).join(",") + (numbers.length > 8 ? ",…" : "");

function assertComplete(v: Extract<Verification, { gone: false }>) {
  if (v.missing.length || v.wrongLength.length)
    throw conflict(
      `Provider part set is incomplete: missing [${brief(v.missing)}], wrong length [${brief(v.wrongLength)}]`,
    );
}

/** Writes provider-confirmed receipts the journal lacks or has stale (lost DB write). */
async function syncJournal(
  deps: TransportDeps,
  authority: Authority,
  file: FileRow,
  picks: PartPick[],
): Promise<number> {
  if (!picks.length) return 0;
  const have = new Map(
    (
      await deps.pool.query<{ part_number: number; etag: string }>(
        `SELECT part_number, etag FROM file_part_receipts
         WHERE file_id = $1 AND transport_epoch = $2`,
        [file.id, file.transport_epoch],
      )
    ).rows.map((r) => [r.part_number, r.etag]),
  );
  const todo = picks.filter((p) => have.get(p.partNumber) !== p.etag);
  if (!todo.length) return 0;
  await mapped(() =>
    inTransaction(deps.pool, async (tx) => {
      const locked = await authorizeFile(tx, file.id, authority, {
        lock: true,
      });
      assertWritable(locked, file.transport_epoch, nowOf(deps));
      assertSameTransport(file, locked);
      await tx.query(
        `INSERT INTO file_part_receipts (file_id, transport_epoch, part_number, etag, size_bytes, corroborated_at)
         SELECT $1, $2, t.n, t.e, t.s, now()
         FROM unnest($3::int[], $4::text[], $5::bigint[]) AS t(n, e, s)
         ON CONFLICT (file_id, transport_epoch, part_number) DO UPDATE
           SET etag = EXCLUDED.etag, corroborated_at = now()
           WHERE file_part_receipts.etag <> EXCLUDED.etag`,
        [
          file.id,
          file.transport_epoch,
          todo.map((p) => p.partNumber),
          todo.map((p) => p.etag),
          todo.map((p) => String(p.sizeBytes)),
        ],
      );
    }),
  );
  return todo.length;
}

/** Atomic, epoch-guarded state move. Returns false when nothing matched. */
async function moveState(
  deps: TransportDeps,
  file: FileRow,
  from: string[],
  to: string,
): Promise<boolean> {
  try {
    const res = await deps.pool.query(
      `UPDATE files SET state = $4
       WHERE id = $1 AND transport_epoch = $2 AND provider_upload_id IS NOT DISTINCT FROM $5
         AND state = ANY($3)`,
      [file.id, file.transport_epoch, from, to, file.provider_upload_id],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (error) {
    throw toCatalogError(error);
  }
}

/** HEAD proof that the exact key now holds this file's whole object. */
async function finalizeFromObject(
  deps: TransportDeps,
  authority: Authority,
  file: FileRow,
  plan: PartPlan,
  object: ProviderObject,
): Promise<UploadPlan> {
  if (object.sizeBytes !== plan.sizeBytes)
    throw ambiguous(
      `Object at the reserved key has ${object.sizeBytes} bytes, expected ${plan.sizeBytes}`,
    );
  // Some providers report the multipart part count; a mismatch is not ours.
  if (object.partsCount !== null && object.partsCount !== plan.partCount)
    throw ambiguous("Object at the reserved key has an unexpected part count");
  if (file.purpose === "source") {
    // Source files finalize through admission: the file becomes completed and
    // the recording's eligibility step runs in one transaction. An identical
    // replay (already completed) is accepted and re-runs that idempotent step.
    if (authority.kind !== "owner") throw conflict("Not a source owner");
    const admission = deps.admission?.();
    if (!admission)
      throw new TransportError(
        "provider_unavailable",
        "Recording admission is not configured",
      );
    await mapped(() =>
      recordSourceCompletion(
        admission,
        { userId: authority.userId },
        {
          recordingId: file.recording_id,
          fileId: file.id,
          expectedTransportEpoch: file.transport_epoch,
          observedSizeBytes: String(object.sizeBytes),
        },
      ),
    );
  } else {
    await mapped(() =>
      inTransaction(deps.pool, async (tx) => {
        const locked = await authorizeFile(tx, file.id, authority, {
          lock: true,
        });
        if (locked.transport_epoch !== file.transport_epoch)
          throw conflict("Stale transport epoch");
        if (locked.state === "completed" || locked.state === "verified") return;
        if (locked.state !== "uploading" && locked.state !== "completing")
          throw conflict(`File is ${locked.state}`);
        await tx.query(
          `UPDATE files SET state = 'completed', observed_size_bytes = $2, completed_at = now()
           WHERE id = $1`,
          [file.id, String(object.sizeBytes)],
        );
      }),
    );
  }
  return toUploadPlan(await reload(deps, authority, file.id));
}

/**
 * Only an explicit, named refusal of the completion request proves nothing was
 * applied. Generic 403/404, timeouts, 5xx and 200-with-error bodies prove
 * nothing about an earlier or in-flight attempt.
 */
const DEFINITIVE = new Set([
  "InvalidPart",
  "InvalidPartOrder",
  "EntityTooSmall",
]);
const isDefinitiveRejection = (error: unknown) =>
  DEFINITIVE.has((error as { name?: string })?.name ?? "");

async function singleListing(deps: TransportDeps, file: FileRow) {
  const uploads = await provider(() =>
    deps.provider.listUploadsForKey(file.object_key),
  );
  if (uploads.length > 1)
    throw ambiguous("Several provider uploads exist for the reserved key");
  return uploads;
}

// ----------------------------------------------------------------- complete

/**
 * POST /uploads/{fileId}/complete. The server builds the completion list from
 * the provider's own part listing checked against the frozen plan; clients
 * never supply parts. The file is durably `completing` BEFORE the provider is
 * asked to complete, so a lost reply or a failed database write afterwards is
 * reconciled with reads (HEAD of the exact key, listing, ListParts).
 */
export async function completeTransport(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
  body: { expectedTransportEpoch: unknown },
): Promise<UploadPlan> {
  const epoch = checkEpoch(body.expectedTransportEpoch);
  const file = await load(deps, authority, fileId, epoch);
  switch (file.state) {
    case "completed":
    case "verified":
      return toUploadPlan(file);
    case "uploading":
      return withClaim(deps, file, () =>
        completeUploading(deps, authority, file),
      );
    case "completing":
      return reconcileTransport(deps, authority, fileId, body);
    default:
      throw conflict(`File is ${file.state}, not accepting completion`);
  }
}

async function completeUploading(
  deps: TransportDeps,
  authority: Authority,
  stale: FileRow,
): Promise<UploadPlan> {
  const file = await reload(deps, authority, stale.id);
  assertSameTransport(stale, file);
  if (file.state === "completed" || file.state === "verified")
    return toUploadPlan(file);
  if (file.state !== "uploading") return reconcileLocked(deps, authority, file);
  assertWritable(file, file.transport_epoch, nowOf(deps));
  const plan = framePlan(file);
  const verified = await verifyParts(deps, file, plan);
  if (verified.gone) {
    const object = await provider(() =>
      deps.provider.headObject(file.object_key),
    );
    if (object) return finalizeFromObject(deps, authority, file, plan, object);
    throw conflict("Provider upload is gone; restart required");
  }
  assertComplete(verified);
  await syncJournal(deps, authority, file, verified.picks);
  if (!(await moveState(deps, file, ["uploading"], "completing")))
    throw conflict("Transport changed while completing");
  const marked = { ...file, state: "completing" };
  return callProviderComplete(deps, authority, marked, plan, verified.picks);
}

/** Runs the provider completion (state is already `completing`) and settles. */
async function callProviderComplete(
  deps: TransportDeps,
  authority: Authority,
  file: FileRow,
  plan: PartPlan,
  picks: PartPick[],
): Promise<UploadPlan> {
  let failure: unknown;
  try {
    await deps.provider.completeUpload(
      file.object_key,
      file.provider_upload_id!,
      picks.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    );
  } catch (error) {
    failure = error;
  }
  // Success is proven by the object, never by the (possibly lost) reply.
  let object: ProviderObject | null;
  try {
    object = await deps.provider.headObject(file.object_key);
  } catch (error) {
    throw new TransportError(
      "provider_unavailable",
      "Completion outcome is uncertain; reconcile before retrying",
      { cause: error },
    );
  }
  if (object) return finalizeFromObject(deps, authority, file, plan, object);
  if (failure && isDefinitiveRejection(failure)) {
    // The provider refused the request, so nothing was applied: reopen the
    // same epoch for further parts.
    await moveState(deps, file, ["completing"], "uploading");
    throw conflict(
      `Provider rejected the completion (${(failure as Error).name}); verify parts and retry`,
    );
  }
  throw new TransportError(
    "provider_unavailable",
    "Completion outcome is uncertain; reconcile before retrying",
    { cause: failure },
  );
}

// --------------------------------------------------------------- reconcile

/**
 * POST /uploads/{fileId}/reconcile: settle an uncertain create/complete or a
 * lost receipt write from provider reads. Safe to call repeatedly.
 */
export async function reconcileTransport(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
  body: { expectedTransportEpoch: unknown },
): Promise<UploadPlan> {
  const epoch = checkEpoch(body.expectedTransportEpoch);
  const file = await load(deps, authority, fileId, epoch);
  switch (file.state) {
    case "reserved":
      // Lost create response / DB write: list the exact key, adopt or create.
      return initializeTransport(deps, authority, fileId);
    case "uploading":
    case "completing":
      return withClaim(deps, file, () =>
        reconcileLocked(deps, authority, file),
      );
    default:
      return toUploadPlan(file);
  }
}

async function reconcileLocked(
  deps: TransportDeps,
  authority: Authority,
  stale: FileRow,
): Promise<UploadPlan> {
  const file = await reload(deps, authority, stale.id);
  assertSameTransport(stale, file);
  if (file.state !== "uploading" && file.state !== "completing")
    return toUploadPlan(file);
  const plan = framePlan(file);
  const object = await provider(() =>
    deps.provider.headObject(file.object_key),
  );
  if (object) return finalizeFromObject(deps, authority, file, plan, object);
  await singleListing(deps, file); // >1 listed uploads blocks (ambiguous)
  if (file.state === "completing") {
    // An unknown completion stays visibly uncertain. Elapsed time, an alive or
    // vanished upload, or a 403/404 never prove the earlier provider call has
    // stopped, so nothing is repeated, aborted or advanced here: only the
    // exact-key HEAD above can settle it (or a definitive rejection recorded
    // by the call that made it).
    throw conflict(
      "Completion outcome is unknown; it stays pending until the provider object is visible",
    );
  }
  const verified = await verifyParts(deps, file, plan);
  if (verified.gone)
    throw conflict("Provider upload is gone; restart required");
  // Lost receipt writes are healed from the provider's listing.
  await syncJournal(deps, authority, file, verified.picks);
  return toUploadPlan(await reload(deps, authority, file.id));
}

// ------------------------------------------------------------------- cancel

/**
 * POST /uploads/{fileId}/cancel. The database transition comes first and is
 * the arbiter against a racing completion: once `completing`, cancel is
 * refused. Provider cleanup of every upload at the (never reused) exact key
 * follows and is repeated by a cancel replay; a leftover upload is bounded by
 * the seven-day lifecycle.
 */
export async function cancelTransport(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
  body: { expectedTransportEpoch: unknown },
): Promise<UploadPlan> {
  const epoch = checkEpoch(body.expectedTransportEpoch);
  const file = await load(deps, authority, fileId, epoch);
  if (file.state === "cancelled") {
    await cleanup(deps, file);
    return toUploadPlan(file);
  }
  if (file.state === "completing")
    throw conflict("Completion is outstanding; reconcile first");
  if (file.state !== "reserved" && file.state !== "uploading")
    throw conflict(`File is ${file.state} and cannot be cancelled`);
  await mapped(() =>
    inTransaction(deps.pool, async (tx) => {
      const locked = await authorizeFile(tx, file.id, authority, {
        lock: true,
      });
      if (locked.transport_epoch !== epoch)
        throw conflict("Stale transport epoch");
      if (locked.state !== "reserved" && locked.state !== "uploading")
        throw conflict(`File is ${locked.state} and cannot be cancelled`);
      await tx.query("UPDATE files SET state = 'cancelled' WHERE id = $1", [
        file.id,
      ]);
    }),
  );
  await cleanup(deps, file);
  return toUploadPlan(await reload(deps, authority, file.id));
}

/** Aborts every upload at the exact key plus the persisted ID; never throws. */
async function cleanup(deps: TransportDeps, file: FileRow): Promise<void> {
  try {
    const ids = new Set<string>();
    if (file.provider_upload_id) ids.add(file.provider_upload_id);
    for (const u of await deps.provider.listUploadsForKey(file.object_key))
      ids.add(u.uploadId);
    for (const id of ids)
      await deps.provider
        .abortUpload(file.object_key, id)
        .catch(() => undefined);
  } catch {
    // Bounded by the provider lifecycle; a cancel replay retries.
  }
}

// ------------------------------------------------------------------ restart

/**
 * POST /uploads/{fileId}/restart: replace a PROVEN retired, unfinished
 * transport with the next epoch, a new never-reused key and a new provider
 * upload. The logical file (identity, size, SHA-256, owner/job) is unchanged;
 * old receipts belong to the old epoch and are never read again, so the whole
 * object must be sent again.
 */
export async function restartTransport(
  deps: TransportDeps,
  authority: Authority,
  fileId: string,
  body: { expectedTransportEpoch: unknown },
): Promise<UploadPlan> {
  const epoch = checkEpoch(body.expectedTransportEpoch);
  const file = await load(deps, authority, fileId, epoch);
  switch (file.state) {
    case "reserved":
      return initializeTransport(deps, authority, fileId);
    case "uploading":
    case "completing":
      break;
    default:
      throw conflict(
        file.state === "completed" || file.state === "verified"
          ? "A completed file cannot be reopened"
          : `File is ${file.state} and cannot be restarted`,
      );
  }
  const outcome = await withClaim(deps, file, () =>
    restartLocked(deps, authority, file),
  );
  if (outcome.restarted) {
    // Provider outage here leaves a `reserved` file at the new epoch; the
    // returned plan says so and reconcile completes the initialization.
    return initializeTransport(deps, authority, fileId).catch(
      () => outcome.plan,
    );
  }
  return outcome.plan;
}

async function restartLocked(
  deps: TransportDeps,
  authority: Authority,
  stale: FileRow,
): Promise<{ restarted: boolean; plan: UploadPlan }> {
  const file = await reload(deps, authority, stale.id);
  assertSameTransport(stale, file);
  if (file.state !== "uploading" && file.state !== "completing")
    throw conflict(`File is ${file.state} and cannot be restarted`);
  if (file.transport_epoch + 1 > MAX_EPOCH)
    throw conflict("Transport restart limit reached");
  const plan = framePlan(file);
  const object = await provider(() =>
    deps.provider.headObject(file.object_key),
  );
  if (object)
    return {
      restarted: false,
      plan: await finalizeFromObject(deps, authority, file, plan, object),
    };
  if (file.state === "completing")
    throw conflict(
      "Completion outcome is unknown; restart is refused until it is settled",
    );
  const expired =
    !file.transport_expires_at ||
    file.transport_expires_at.getTime() <= nowOf(deps).getTime();
  let uploads = await singleListing(deps, file);
  if (expired) {
    // The seven-day window has passed: everything at the exact key belongs to
    // this retired epoch, so abort it all (ID inequality is irrelevant here).
    const ids = new Set(uploads.map((u) => u.uploadId));
    ids.add(file.provider_upload_id!);
    await provider(async () => {
      for (const id of ids)
        await deps.provider.abortUpload(file.object_key, id);
    });
  } else {
    // Not expired: only a provider that no longer has the upload retires it.
    const verified = await verifyParts(deps, file, plan);
    if (!verified.gone || uploads.length > 0)
      throw conflict("Transport is still active; continue, complete or cancel");
  }
  // Re-prove: nothing may remain at the old key before the epoch advances.
  uploads = await provider(() =>
    deps.provider.listUploadsForKey(file.object_key),
  );
  const late = await provider(() => deps.provider.headObject(file.object_key));
  if (late)
    return {
      restarted: false,
      plan: await finalizeFromObject(deps, authority, file, plan, late),
    };
  if (uploads.length > 0)
    throw ambiguous("Provider still lists an upload for the retired key");
  const marker = `/${file.id}/e${file.transport_epoch}/`;
  const at = file.object_key.lastIndexOf(marker);
  if (at < 0) throw conflict("Stored object key is not canonical");
  const nextKey =
    file.object_key.slice(0, at) +
    `/${file.id}/e${file.transport_epoch + 1}/` +
    file.object_key.slice(at + marker.length);
  await mapped(() =>
    inTransaction(deps.pool, async (tx) => {
      const locked = await authorizeFile(tx, file.id, authority, {
        lock: true,
      });
      assertSameTransport(file, locked);
      if (locked.state !== "uploading" && locked.state !== "completing")
        throw conflict(`File is ${locked.state} and cannot be restarted`);
      await tx.query(
        `UPDATE files SET transport_epoch = transport_epoch + 1, object_key = $2,
           provider_upload_id = NULL, state = 'reserved', transport_expires_at = NULL
         WHERE id = $1`,
        [file.id, nextKey],
      );
    }),
  );
  return {
    restarted: true,
    plan: toUploadPlan(await reload(deps, authority, file.id)),
  };
}
