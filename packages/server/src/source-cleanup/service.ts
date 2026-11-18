import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ObjectHashError, type ObjectHasher } from "../acceptance/storage.js";
import { CatalogError, toCatalogError } from "../catalog/errors.js";
import type { SourceCleanupConfig } from "./config.js";

type Tx = pg.PoolClient;

export type SourceCleanupDeps = {
  /** The restricted application-role pool. */
  pool: pg.Pool;
  /** Streaming SHA-256 of catalog-selected source objects (acceptance/storage). */
  hasher: ObjectHasher;
  config: SourceCleanupConfig;
};

/**
 * Every failure is a stable, actionable code and NEVER a proof. Object keys,
 * bucket names, credentials and storage error text never appear in messages.
 */
export type SourceCleanupErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "inventory_changed"
  | "source_not_eligible"
  | "source_incomplete"
  | "source_object_missing"
  | "source_size_mismatch"
  | "source_hash_mismatch"
  | "source_state_changed"
  | "staff_confirmation_required"
  | "permission_revoked"
  | "verification_budget_exceeded"
  | "verification_timeout"
  | "verifier_busy"
  | "storage_unavailable"
  | "database_unavailable";

const STATUS: Record<SourceCleanupErrorCode, number> = {
  invalid_request: 422,
  not_found: 404,
  forbidden: 403,
  inventory_changed: 409,
  source_not_eligible: 409,
  source_incomplete: 409,
  source_object_missing: 409,
  source_size_mismatch: 409,
  source_hash_mismatch: 409,
  source_state_changed: 409,
  staff_confirmation_required: 409,
  permission_revoked: 409,
  verification_budget_exceeded: 413,
  verification_timeout: 504,
  verifier_busy: 429,
  storage_unavailable: 503,
  database_unavailable: 503,
};

export class SourceCleanupError extends Error {
  constructor(
    readonly code: SourceCleanupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SourceCleanupError";
  }
  get status(): number {
    return STATUS[this.code];
  }
  get retryable(): boolean {
    return (
      this.code === "verifier_busy" ||
      this.code === "storage_unavailable" ||
      this.code === "database_unavailable" ||
      this.code === "verification_timeout"
    );
  }
}
const fail = (code: SourceCleanupErrorCode, message: string) =>
  new SourceCleanupError(code, message);

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);
export const isHex64 = (v: unknown): v is string =>
  typeof v === "string" && HEX64.test(v);

// ----------------------------------------------------------------- views

export type EvidenceFile = {
  fileId: string;
  role: string;
  required: boolean;
  sizeBytes: string;
  sha256: string;
};

export type SourceCopyConfirmation = {
  schemaVersion: 1;
  confirmationId: string;
  recordingId: string;
  clientRecordingId: string;
  sealSha256: string;
  sourceManifestSha256: string;
  fileCount: number;
  totalBytes: string;
  files: EvidenceFile[];
  confirmedByUserId: string;
  verifiedAt: string;
  confirmedAt: string;
};

export type CleanupProof = {
  schemaVersion: 1;
  proofId: string;
  recordingId: string;
  clientRecordingId: string;
  ownerUserId: string;
  sealSha256: string;
  sourceManifestSha256: string;
  confirmationId: string;
  confirmedAt: string;
  verification: "rehash";
  fileCount: number;
  totalBytes: string;
  files: EvidenceFile[];
  issuedAt: string;
  expiresAt: string;
};

export type ExpectedInventory = {
  sealSha256: string;
  sourceManifestSha256: string;
  /** Owner proofs also bind the phone-held client recording id. */
  clientRecordingId?: string;
  /** Staff confirmations bind the number of sealed files the staff reviewed. */
  fileCount?: number;
};

// ------------------------------------------------------- bounded database

/** Rejects after `ms`; the timer never outlives the race. */
async function within<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const dbDown = () =>
  fail("database_unavailable", "The database did not answer in time; retry");

/** Finite wait for a pool connection; a late connection is returned at once. */
async function connect(pool: pg.Pool, ms: number): Promise<Tx> {
  const pending = pool.connect();
  try {
    return await within(pending, ms, dbDown);
  } catch (error) {
    void pending.then(
      (client) => client.release(),
      () => undefined,
    );
    throw error;
  }
}

/**
 * Short transaction with finite statement, lock and idle limits. Never held
 * across storage I/O. A pg timeout or lock failure is a retryable
 * database_unavailable, not a verdict.
 */
async function transact<T>(
  deps: SourceCleanupDeps,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const ms = deps.config.dbTimeoutMs;
  const tx = await connect(deps.pool, ms);
  let broken = false;
  try {
    await within(tx.query("BEGIN ISOLATION LEVEL READ COMMITTED"), ms, dbDown);
    await within(
      tx.query(
        `SET LOCAL statement_timeout = ${Math.trunc(ms)};
         SET LOCAL lock_timeout = ${Math.trunc(Math.min(ms, 5000))};
         SET LOCAL idle_in_transaction_session_timeout = ${Math.trunc(ms * 3)}`,
      ),
      ms,
      dbDown,
    );
    const result = await within(work(tx), ms * 3, dbDown);
    await within(tx.query("COMMIT"), ms, dbDown);
    return result;
  } catch (error) {
    await within(tx.query("ROLLBACK"), ms, dbDown).catch(() => {
      broken = true;
    });
    if (error instanceof SourceCleanupError) {
      if (error.code === "database_unavailable") broken = true;
      throw error;
    }
    const state = (error as { code?: unknown })?.code;
    if (state === "57014" || state === "55P03" || state === "25P03")
      throw dbDown();
    const mapped = toCatalogError(error);
    if (mapped instanceof CatalogError) {
      if (mapped.code === "forbidden")
        throw fail(
          "permission_revoked",
          "The required role or permission evidence is no longer active",
        );
      if (mapped.code === "conflict" || mapped.code === "invalid_request")
        throw fail(
          "source_state_changed",
          "The sealed source state changed while it was being verified; retry",
        );
    }
    throw error;
  } finally {
    tx.release(broken ? new Error("connection discarded") : undefined);
  }
}

// ----------------------------------------------------------------- state

type SealEntry = {
  fileId: string;
  role: string;
  sizeBytes: string;
  sha256: string;
  required: boolean;
};

type RecordingState = {
  id: string;
  ownerUserId: string;
  clientRecordingId: string;
  manifestFileId: string | null;
  manifestSha256: string | null;
  currentJobId: string | null;
  sealSha256: string | null;
  inventory: SealEntry[] | null;
  eligible: boolean;
  /** More live source rows than the verification cap allows. */
  overLimit: boolean;
};

type SourceRow = {
  id: string;
  role: string;
  required: boolean;
  size_bytes: string;
  sha256: string;
  object_key: string;
  state: string;
  observed_size_bytes: string | null;
};

type StateRow = {
  id: string;
  owner_user_id: string;
  client_recording_id: string;
  source_manifest_file_id: string | null;
  source_manifest_sha256: string | null;
  current_job_id: string | null;
  seal_sha256: string | null;
  inventory: SealEntry[] | null;
  eligible: boolean;
};

/** Owner-scoped when `owner` is given: a foreign or missing id is one 404. */
async function loadState(
  tx: Tx,
  config: SourceCleanupConfig,
  recordingId: string,
  owner?: string,
): Promise<{ state: RecordingState; files: SourceRow[] } | null> {
  const found = await tx.query<StateRow>(
    `SELECT r.id, r.owner_user_id, r.client_recording_id::text, r.source_manifest_file_id,
            r.source_manifest_sha256, r.current_job_id, s.request_sha256 AS seal_sha256,
            s.inventory, public.source_cleanup_eligible(r.id) AS eligible
     FROM recordings r LEFT JOIN recording_seals s ON s.recording_id = r.id
     WHERE r.id = $1 AND r.deleted_at IS NULL
       AND ($2::text IS NULL OR r.owner_user_id = $2::text)`,
    [recordingId, owner ?? null],
  );
  const row = found.rows[0];
  if (!row) return null;
  // Bounded row set even if the catalog holds an oversized inventory.
  const files = await tx.query<SourceRow>(
    `SELECT id, role, required, size_bytes::text, sha256, object_key, state,
            observed_size_bytes::text
     FROM files
     WHERE recording_id = $1 AND purpose = 'source'
       AND state NOT IN ('cancelled', 'failed', 'expired')
     ORDER BY id LIMIT $2`,
    [recordingId, config.maxFiles + 1],
  );
  const overLimit =
    files.rows.length > config.maxFiles ||
    (row.inventory?.length ?? 0) > config.maxFiles;
  return {
    state: {
      id: row.id,
      ownerUserId: row.owner_user_id,
      clientRecordingId: row.client_recording_id,
      manifestFileId: row.source_manifest_file_id,
      manifestSha256: row.source_manifest_sha256,
      currentJobId: row.current_job_id,
      sealSha256: row.seal_sha256,
      inventory: row.inventory,
      eligible: row.eligible === true,
      overLimit,
    },
    files: files.rows.slice(0, config.maxFiles),
  };
}

function expectIdentity(state: RecordingState, expected: ExpectedInventory) {
  if (
    !state.sealSha256 ||
    !state.manifestSha256 ||
    state.sealSha256 !== expected.sealSha256 ||
    state.manifestSha256 !== expected.sourceManifestSha256 ||
    (expected.clientRecordingId !== undefined &&
      state.clientRecordingId !== expected.clientRecordingId) ||
    (expected.fileCount !== undefined &&
      state.inventory?.length !== expected.fileCount)
  )
    throw fail(
      "inventory_changed",
      "The sealed source inventory is not the one you named; reload the recording",
    );
}

const budgetError = (config: SourceCleanupConfig) =>
  fail(
    "verification_budget_exceeded",
    `Source verification is limited to ${config.maxFiles} files, ${config.maxObjectBytes} bytes per object and ${config.maxTotalBytes} bytes in total; no proof is possible for this recording at the current limits`,
  );

/**
 * The server derives the inventory from the sealed rows and the live file
 * rows; both must agree for every sealed file and no other live source file
 * may exist. Nothing here comes from the request.
 */
function derivedFiles(
  config: SourceCleanupConfig,
  state: RecordingState,
  files: SourceRow[],
): SourceRow[] {
  if (!state.eligible)
    throw fail(
      "source_not_eligible",
      "The recording must be reviewable with accepted processing and active permission evidence",
    );
  if (state.overLimit) throw budgetError(config);
  const sealed = state.inventory;
  if (!sealed || sealed.length === 0 || sealed.length !== files.length)
    throw fail(
      "source_incomplete",
      "The live source files do not match the sealed inventory",
    );
  const byId = new Map(files.map((f) => [f.id, f]));
  for (const entry of sealed) {
    const f = byId.get(entry.fileId);
    if (
      !f ||
      (f.state !== "completed" && f.state !== "verified") ||
      f.observed_size_bytes !== f.size_bytes ||
      f.role !== entry.role ||
      f.size_bytes !== String(entry.sizeBytes) ||
      f.sha256 !== entry.sha256 ||
      f.required !== entry.required
    )
      throw fail(
        "source_incomplete",
        `Sealed source file ${entry.fileId} is not a complete upload of the sealed inventory`,
      );
  }
  return [...files];
}

function checkBudget(config: SourceCleanupConfig, files: SourceRow[]) {
  const total = files.reduce((n, f) => n + BigInt(f.size_bytes), 0n);
  const largest = files.reduce(
    (n, f) => (BigInt(f.size_bytes) > n ? BigInt(f.size_bytes) : n),
    0n,
  );
  if (
    files.length > config.maxFiles ||
    total > BigInt(config.maxTotalBytes) ||
    largest > BigInt(config.maxObjectBytes)
  )
    throw budgetError(config);
}

// ------------------------------------------------------------- verifier

/** Process-wide plus database-wide admission of exactly one verifier. */
const VERIFIER_LOCK_ID = 7430073;
let localBusy = false;

type Scope = {
  /** Registers hash I/O so admission is released only after it has settled. */
  track<T>(work: Promise<T>): Promise<T>;
};

/**
 * Holds the global verifier slot on a dedicated connection. The slot is
 * released only after every tracked hash read has settled or been aborted by
 * its own deadline; a hung read keeps the slot (and the process mutex) until
 * it ends instead of letting a second verifier start. The lock is re-checked
 * on the same connection before the evidence may be used, so a lost
 * connection (which silently drops the advisory lock) can never produce a
 * proof.
 */
async function withVerifier<T>(
  deps: SourceCleanupDeps,
  work: (scope: Scope) => Promise<T>,
): Promise<T> {
  const ms = deps.config.dbTimeoutMs;
  if (localBusy)
    throw fail(
      "verifier_busy",
      "Another verification is running; retry shortly",
    );
  localBusy = true;
  let client: Tx | undefined;
  let lost = false;
  let held = false;
  const onError = () => {
    lost = true;
  };
  const pending = new Set<Promise<unknown>>();
  const scope: Scope = {
    track(promise) {
      pending.add(promise);
      const done = () => void pending.delete(promise);
      promise.then(done, done);
      return promise;
    },
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let destroy = lost;
    try {
      if (client && held && !lost)
        await within(
          client.query("SELECT pg_advisory_unlock($1)", [VERIFIER_LOCK_ID]),
          ms,
          dbDown,
        ).catch(() => {
          destroy = true; // dropping the connection releases the lock
        });
    } finally {
      client?.off("error", onError);
      client?.release(
        destroy ? new Error("verifier connection discarded") : undefined,
      );
      localBusy = false;
    }
  };
  const closeAfterIo = async () => {
    if (pending.size > 0) {
      void Promise.allSettled([...pending]).then(close);
      return;
    }
    await close();
  };
  try {
    client = await connect(deps.pool, ms);
    client.on("error", onError);
    const got = await within(
      client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [
        VERIFIER_LOCK_ID,
      ]),
      ms,
      dbDown,
    );
    if (got.rows[0]?.ok !== true)
      throw fail(
        "verifier_busy",
        "Another verification is running; retry shortly",
      );
    held = true;
    const result = await work(scope);
    // Still the holder on a live connection? (pid-scoped advisory lock row)
    const still = await within(
      client.query<{ held: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
                AND classid = 0 AND objid = $1 AND objsubid = 1 AND granted) AS held`,
        [VERIFIER_LOCK_ID],
      ),
      ms,
      dbDown,
    ).catch(() => undefined);
    if (lost || still?.rows[0]?.held !== true) {
      lost = true;
      throw fail(
        "storage_unavailable",
        "The verification slot was lost while streaming; no proof was produced",
      );
    }
    await closeAfterIo();
    return result;
  } catch (error) {
    await closeAfterIo();
    throw error;
  }
}

/** Streams and hashes every included original sequentially under the bounds. */
async function hashAll(
  deps: SourceCleanupDeps,
  scope: Scope,
  files: SourceRow[],
): Promise<EvidenceFile[]> {
  const { config } = deps;
  const wallEnd = Date.now() + config.wallMs;
  const evidence: EvidenceFile[] = [];
  for (const f of files) {
    const remaining = wallEnd - Date.now();
    if (remaining <= 0)
      throw fail(
        "verification_timeout",
        "Source verification exceeded its wall limit; no proof was produced",
      );
    const timeout = Math.max(1, Math.min(config.objectTimeoutMs, remaining));
    const started = Date.now();
    let hashed: { bytes: number; sha256: string };
    try {
      // The hasher aborts its own request at `timeout`; the backstop only
      // stops waiting, and the tracked read keeps the verifier slot busy.
      hashed = await within(
        scope.track(
          deps.hasher.hash(f.object_key, Number(f.size_bytes), timeout),
        ),
        timeout + 2000,
        () =>
          fail(
            "verification_timeout",
            `Reading file ${f.id} (${f.role}) exceeded its time limit; no proof was produced`,
          ),
      );
    } catch (error) {
      if (error instanceof SourceCleanupError) throw error;
      if (error instanceof ObjectHashError) {
        const where = `file ${f.id} (${f.role})`;
        if (error.code === "object_missing")
          throw fail("source_object_missing", `Stored ${where} is missing`);
        if (error.code === "object_size_mismatch")
          throw fail(
            "source_size_mismatch",
            `Stored ${where} does not have its declared length`,
          );
        if (Date.now() - started >= timeout - 50)
          throw fail(
            "verification_timeout",
            `Reading ${where} exceeded its time limit; no proof was produced`,
          );
      }
      throw fail(
        "storage_unavailable",
        "Object storage could not be read; no proof was produced",
      );
    }
    if (hashed.sha256 !== f.sha256)
      throw fail(
        "source_hash_mismatch",
        `Stored file ${f.id} (${f.role}) does not match its sealed SHA-256`,
      );
    if (String(hashed.bytes) !== f.size_bytes)
      throw fail(
        "source_size_mismatch",
        `Stored file ${f.id} (${f.role}) does not have its declared length`,
      );
    evidence.push({
      fileId: f.id,
      role: f.role,
      required: f.required,
      sizeBytes: f.size_bytes,
      sha256: hashed.sha256,
    });
  }
  return evidence;
}

const sumBytes = (files: EvidenceFile[]) =>
  files.reduce((n, f) => n + BigInt(f.sizeBytes), 0n).toString();

/**
 * Re-reads and re-compares everything the hashes were taken against, inside
 * the writing transaction. Lock order: recordings row (FOR SHARE), then the
 * permission row (FOR SHARE, inside source_cleanup_eligible), then the insert
 * whose triggers re-read roles. The sealed pointer, current job, permission
 * and every file row (id, key, size, SHA-256, role) must be unchanged.
 */
async function recheck(
  tx: Tx,
  config: SourceCleanupConfig,
  recordingId: string,
  owner: string | undefined,
  expected: ExpectedInventory,
  before: RecordingState,
  hashed: SourceRow[],
  hashedEvidence: EvidenceFile[],
) {
  await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR SHARE", [
    recordingId,
  ]);
  const again = await loadState(tx, config, recordingId, owner);
  if (!again) throw fail("not_found", "Recording not found");
  expectIdentity(again.state, expected);
  const current = derivedFiles(config, again.state, again.files);
  const same =
    again.state.manifestFileId === before.manifestFileId &&
    again.state.currentJobId === before.currentJobId &&
    again.state.ownerUserId === before.ownerUserId &&
    current.length === hashed.length &&
    current.every((f, i) => {
      const h = hashed[i]!;
      const e = hashedEvidence[i]!;
      return (
        f.id === h.id &&
        f.object_key === h.object_key &&
        f.size_bytes === h.size_bytes &&
        f.sha256 === h.sha256 &&
        f.role === h.role &&
        f.required === h.required &&
        e.fileId === f.id &&
        e.sha256 === f.sha256
      );
    });
  if (!same)
    throw fail(
      "source_state_changed",
      "The sealed source state changed while it was being verified; retry",
    );
  return again.state;
}

// ----------------------------------------------------------- confirmation

type ConfirmationRow = {
  id: string;
  recording_id: string;
  owner_user_id: string;
  seal_sha256: string;
  source_manifest_file_id: string;
  source_manifest_sha256: string;
  file_count: number;
  total_bytes: string;
  files: EvidenceFile[];
  confirmed_by_user_id: string;
  verified_at: Date;
  confirmed_at: Date;
};
const CONFIRMATION_COLUMNS = `id, recording_id, owner_user_id, seal_sha256, source_manifest_file_id,
  source_manifest_sha256, file_count, total_bytes::text, files, confirmed_by_user_id, verified_at, confirmed_at`;

async function existingConfirmation(tx: Tx, recordingId: string) {
  return (
    await tx.query<ConfirmationRow>(
      `SELECT ${CONFIRMATION_COLUMNS} FROM source_copy_confirmations WHERE recording_id = $1`,
      [recordingId],
    )
  ).rows[0];
}

function confirmationView(
  row: ConfirmationRow,
  clientRecordingId: string,
): SourceCopyConfirmation {
  return {
    schemaVersion: 1,
    confirmationId: row.id,
    recordingId: row.recording_id,
    clientRecordingId,
    sealSha256: row.seal_sha256,
    sourceManifestSha256: row.source_manifest_sha256,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    files: row.files,
    confirmedByUserId: row.confirmed_by_user_id,
    verifiedAt: row.verified_at.toISOString(),
    confirmedAt: row.confirmed_at.toISOString(),
  };
}

/**
 * Explicit staff action for ONE recording. The actor is the authenticated staff
 * principal (re-checked by the database at insert); the sealed inventory is
 * derived by the server and must be named exactly by the caller. Every sealed
 * original is streamed whole and hashed at EOF before the evidence is written.
 * A replay returns the original confirmation without hashing again.
 */
export async function confirmSourceCopy(
  deps: SourceCleanupDeps,
  actor: { userId: string },
  recordingId: string,
  expected: ExpectedInventory,
): Promise<{ confirmation: SourceCopyConfirmation; created: boolean }> {
  const { config } = deps;
  const first = await transact(deps, async (tx) => {
    const loaded = await loadState(tx, config, recordingId);
    if (!loaded) throw fail("not_found", "Recording not found");
    expectIdentity(loaded.state, expected);
    const prior = await existingConfirmation(tx, recordingId);
    return { loaded, prior };
  });
  const { loaded } = first;
  if (first.prior)
    return {
      confirmation: confirmationView(
        first.prior,
        loaded.state.clientRecordingId,
      ),
      created: false,
    };
  const files = derivedFiles(config, loaded.state, loaded.files);
  checkBudget(config, files);

  let evidence: EvidenceFile[];
  try {
    evidence = await withVerifier(deps, (scope) => hashAll(deps, scope, files));
  } catch (error) {
    // A concurrent confirmation may have just finished: converge on it.
    if (error instanceof SourceCleanupError && error.code === "verifier_busy") {
      const raced = await transact(deps, (tx) =>
        existingConfirmation(tx, recordingId),
      );
      if (raced)
        return {
          confirmation: confirmationView(raced, loaded.state.clientRecordingId),
          created: false,
        };
    }
    throw error;
  }
  const verifiedAt = new Date();

  return transact(deps, async (tx) => {
    const state = await recheck(
      tx,
      config,
      recordingId,
      undefined,
      expected,
      loaded.state,
      files,
      evidence,
    );
    const existing = await existingConfirmation(tx, recordingId);
    if (existing)
      return {
        confirmation: confirmationView(existing, state.clientRecordingId),
        created: false,
      };
    const manifest = evidence.find((f) => f.role === "source_manifest");
    if (!manifest || manifest.fileId !== state.manifestFileId)
      throw fail("source_incomplete", "The sealed source manifest is missing");
    const inserted = await tx.query<ConfirmationRow>(
      `INSERT INTO source_copy_confirmations
         (id, recording_id, owner_user_id, seal_sha256, source_manifest_file_id,
          source_manifest_sha256, file_count, total_bytes, files, confirmed_by_user_id, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       ON CONFLICT (recording_id) DO NOTHING
       RETURNING ${CONFIRMATION_COLUMNS}`,
      [
        randomUUID(),
        recordingId,
        state.ownerUserId,
        state.sealSha256,
        manifest.fileId,
        state.manifestSha256,
        evidence.length,
        sumBytes(evidence),
        JSON.stringify(evidence),
        actor.userId,
        verifiedAt,
      ],
    );
    const row = inserted.rows[0];
    if (row)
      return {
        confirmation: confirmationView(row, state.clientRecordingId),
        created: true,
      };
    const winner = await existingConfirmation(tx, recordingId);
    if (!winner)
      throw fail("source_state_changed", "Confirmation could not be recorded");
    return {
      confirmation: confirmationView(winner, state.clientRecordingId),
      created: false,
    };
  });
}

// ------------------------------------------------------------ owner proof

/**
 * Fresh cleanup proof for the authenticated ORIGINAL owner only. The owner id
 * is the session principal; a different or unknown owner gets the same 404.
 * Every included original is streamed and hashed again now (no cached
 * evidence, no HEAD/ETag shortcut) and the proof is written only if the
 * database re-validates the staff confirmation, permissions and inventory in
 * the same transaction. The proof grants nothing on storage; deleting a local
 * original is a separate explicit owner action.
 */
export async function issueCleanupProof(
  deps: SourceCleanupDeps,
  owner: { userId: string },
  recordingId: string,
  expected: ExpectedInventory,
): Promise<CleanupProof> {
  const { config } = deps;
  const first = await transact(deps, async (tx) => {
    const loaded = await loadState(tx, config, recordingId, owner.userId);
    if (!loaded) throw fail("not_found", "Recording not found");
    expectIdentity(loaded.state, expected);
    const files = derivedFiles(config, loaded.state, loaded.files);
    const confirmation = await existingConfirmation(tx, recordingId);
    return { loaded, files, confirmation };
  });
  const { loaded, files, confirmation } = first;
  if (
    !confirmation ||
    confirmation.owner_user_id !== owner.userId ||
    confirmation.seal_sha256 !== loaded.state.sealSha256 ||
    confirmation.source_manifest_sha256 !== loaded.state.manifestSha256
  )
    throw fail(
      "staff_confirmation_required",
      "Staff must explicitly confirm the verified cloud copy of this recording first",
    );
  checkBudget(config, files);
  const evidence = await withVerifier(deps, (scope) =>
    hashAll(deps, scope, files),
  );

  return transact(deps, async (tx) => {
    const state = await recheck(
      tx,
      config,
      recordingId,
      owner.userId,
      expected,
      loaded.state,
      files,
      evidence,
    );
    const current = await existingConfirmation(tx, recordingId);
    if (!current || current.id !== confirmation.id)
      throw fail(
        "staff_confirmation_required",
        "Staff must explicitly confirm the verified cloud copy of this recording first",
      );
    const proofId = randomUUID();
    const inserted = await tx.query<{ issued_at: Date; expires_at: Date }>(
      `INSERT INTO source_cleanup_proofs
         (id, confirmation_id, recording_id, owner_user_id, seal_sha256, source_manifest_sha256,
          verification, file_count, total_bytes, files, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'rehash', $7, $8, $9::jsonb,
               now() + make_interval(secs => $10::double precision))
       RETURNING issued_at, expires_at`,
      [
        proofId,
        current.id,
        recordingId,
        state.ownerUserId,
        state.sealSha256,
        state.manifestSha256,
        evidence.length,
        sumBytes(evidence),
        JSON.stringify(evidence),
        config.proofTtlSeconds,
      ],
    );
    const times = inserted.rows[0]!;
    return {
      schemaVersion: 1 as const,
      proofId,
      recordingId,
      clientRecordingId: state.clientRecordingId,
      ownerUserId: state.ownerUserId,
      sealSha256: state.sealSha256!,
      sourceManifestSha256: state.manifestSha256!,
      confirmationId: current.id,
      confirmedAt: current.confirmed_at.toISOString(),
      verification: "rehash" as const,
      fileCount: evidence.length,
      totalBytes: sumBytes(evidence),
      files: evidence,
      issuedAt: times.issued_at.toISOString(),
      expiresAt: times.expires_at.toISOString(),
    };
  });
}
