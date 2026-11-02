import type pg from "pg";
import type { ObjectHasher } from "../acceptance/storage.js";
import { ObjectHashError } from "../acceptance/storage.js";

/**
 * Read-only verification of a RESTORED catalog copy (SA-46). Pure and finite:
 * one short READ ONLY snapshot gathers facts and is released BEFORE any object
 * is hashed, then each referenced private object is streamed through SHA-256
 * sequentially under per-object and aggregate wall and byte bounds. Nothing is
 * written, repaired, released or re-enabled, and no credential, object key or
 * token ever enters the report.
 *
 * The report never claims the system is ready: external job/upload state,
 * sessions and capability rotation are always listed as open manual gates. The
 * optional caller-supplied grant allowlist is OFFLINE operator input, not an
 * authoritative source; it can only add blockers.
 */

export const MAX_FILES = 5000;
export const MAX_TOTAL_BYTES = 8 * 1024 ** 3;
export const MAX_LIST = 200;

/**
 * The only NOT VALID constraints the deployed migrations create (007,
 * public.jobs CHECKs). Exact schema.table.name:type; nothing is matched by pattern.
 */
export const KNOWN_NOT_VALID: ReadonlySet<string> = new Set([
  "public.jobs.jobs_admission_complete:c",
  "public.jobs.jobs_claim_complete:c",
]);

export type VerifyLimits = {
  maxFiles: number;
  /** Sum of declared bytes of the objects that would be read; over the cap is refused, not cut. */
  maxTotalBytes: number;
  perObjectTimeoutMs: number;
  /** No object read starts after this much wall time; a started read always settles. */
  totalWallMs: number;
  statementTimeoutMs: number;
};

export const DEFAULT_LIMITS: VerifyLimits = {
  maxFiles: MAX_FILES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  perObjectTimeoutMs: 60_000,
  totalWallMs: 10 * 60_000,
  statementTimeoutMs: 15_000,
};

export class RestoreVerifyError extends Error {
  constructor(
    readonly code:
      | "too_many_files"
      | "too_many_bytes"
      | "invalid_limits"
      | "invalid_allowlist"
      | "snapshot_failed",
    message: string,
  ) {
    super(message);
  }
}

export type ObjectStatus =
  | "match"
  | "missing"
  | "size_mismatch"
  | "sha_mismatch"
  | "unread"
  | "not_checked";

export type FileResult = {
  fileId: string;
  purpose: string;
  role: string;
  state: string;
  sizeBytes: number;
  status: ObjectStatus;
};

type FileRow = {
  id: string;
  purpose: string;
  role: string;
  state: string;
  size_bytes: string;
  sha256: string;
  object_key: string;
};

/** Expected schema from the deployed source. */
export type ExpectedMigration = { version: number; sha256: string };

/** Offline operator input. Not authoritative: only used to find extra active grants. */
export type ExpectedGrants = {
  schema: "stateaction.restore_expected_grants.v1";
  provenance: "operator_supplied_offline_not_authoritative";
  active: string[];
};

const GRANT_KEY = /^[a-z_]+:[A-Za-z0-9_.:@+-]{1,300}$/;

export function parseExpectedGrants(value: unknown): ExpectedGrants {
  const v = value as Partial<ExpectedGrants> | null;
  if (
    !v ||
    v.schema !== "stateaction.restore_expected_grants.v1" ||
    v.provenance !== "operator_supplied_offline_not_authoritative" ||
    !Array.isArray(v.active) ||
    v.active.length > 10_000 ||
    v.active.some((k) => typeof k !== "string" || !GRANT_KEY.test(k))
  )
    throw new RestoreVerifyError(
      "invalid_allowlist",
      "expected grants must be schema stateaction.restore_expected_grants.v1 with provenance operator_supplied_offline_not_authoritative and bounded grant keys",
    );
  return v as ExpectedGrants;
}

export type RestoreReport = {
  schema: "stateaction.restore_report.v1";
  provenance: "isolated_restore_verification";
  generatedAt: string;
  limits: VerifyLimits;
  migrations: {
    status: "match" | "mismatch";
    missing: number[];
    extra: number[];
    checksumMismatch: number[];
  };
  /**
   * NOT VALID constraints. Only the two declared by migration 007 are expected;
   * anything else means the restored DDL differs from the deployed source.
   */
  constraints: { unvalidated: number; unexpected: string[] };
  referenceIssues: Array<{ kind: string; id: string }>;
  objects: {
    complete: boolean;
    counts: Record<ObjectStatus, number>;
    bytesHashed: number;
    files: FileResult[];
  };
  unreconciled: {
    nonTerminalJobs: Array<{
      jobId: string;
      state: string;
      hasExecutionRef: boolean;
    }>;
    uploadsWithProviderRef: Array<{ fileId: string; state: string }>;
    sliceTruncated: boolean;
    slotHolder: { jobId: string; hasExecutionEvidence: boolean } | null;
    sessions: { total: number; unexpired: number };
    verificationTokens: number;
    liveJobCapabilities: number;
    activeGrants: string[];
    grantsAllowlist:
      | "not_supplied"
      | "operator_supplied_offline_not_authoritative";
    staleActiveGrants: string[];
    allowlistedButAbsent: string[];
  };
  blockers: string[];
  manualGatesOpen: string[];
  /** Always false: external state is reconciled by an operator, never inferred. */
  readyToReenable: false;
  notice: string;
};

export const MANUAL_GATES = [
  "external_jobs_and_uploads_reconciled_out_of_band",
  "sessions_cleared_on_restored_copy",
  "service_capabilities_and_job_tokens_rotated",
  "grants_reconciled_against_authoritative_revocation_record",
  "ingest_and_dispatch_still_disabled",
] as const;

type Queryable = Pick<pg.ClientBase, "query">;

async function q<T extends object>(
  c: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await c.query(text, params)).rows as T[];
}

export type Snapshot = {
  files: FileRow[];
  migrations: Array<{ version: number; sha256: string | null }>;
  unvalidated: string[];
  refIssues: Array<{ kind: string; id: string }>;
  jobs: Array<{ id: string; state: string; ref: boolean }>;
  uploads: Array<{ id: string; state: string }>;
  slot: { job_id: string | null; evidence: boolean } | null;
  sessionTotal: number;
  sessionLive: number;
  verification: number;
  jobCaps: number;
  grants: string[];
};

/** One bounded READ ONLY REPEATABLE READ snapshot; always rolled back. */
export async function readSnapshot(
  client: pg.ClientBase,
  limits: VerifyLimits,
): Promise<Snapshot> {
  const lim = limits.maxFiles + 1;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query(
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '2000', true), set_config('idle_in_transaction_session_timeout', '30000', true)",
      [String(limits.statementTimeoutMs)],
    );
    const files = await q<FileRow>(
      client,
      `SELECT id::text, purpose, role, state, size_bytes::text, sha256, object_key
       FROM files WHERE state IN ('completed', 'verified') ORDER BY id LIMIT $1`,
      [lim],
    );
    const migrations = await q<{ version: number; sha256: string | null }>(
      client,
      "SELECT version, sha256 FROM platform_schema_migrations ORDER BY version",
    );
    // Every NOT VALID constraint in a user schema, as schema.table.name:type.
    const unvalidated = (
      await q<{ k: string }>(
        client,
        `SELECT n.nspname || '.' || coalesce(t.relname, '') || '.' || c.conname || ':' || c.contype::text AS k
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
         LEFT JOIN pg_class t ON t.oid = c.conrelid
         WHERE NOT c.convalidated AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
         ORDER BY 1 LIMIT 201`,
      )
    ).map((r) => r.k);
    // A reference to a file that is not completed/verified (its object cannot be trusted).
    const refIssues = await q<{ kind: string; id: string }>(
      client,
      `(SELECT 'recording_manifest_not_complete' AS kind, r.id::text AS id
          FROM recordings r JOIN files f ON f.id = r.source_manifest_file_id
          WHERE f.state NOT IN ('completed', 'verified') LIMIT 50)
       UNION ALL
       (SELECT 'job_result_manifest_not_complete', j.id::text
          FROM jobs j JOIN files f ON f.id = j.result_manifest_file_id
          WHERE f.state NOT IN ('completed', 'verified') LIMIT 50)
       UNION ALL
       (SELECT 'clip_file_not_complete', c.id::text
          FROM clips c JOIN files f ON f.id IN (c.rgb_mp4_file_id, c.hand_arrays_file_id,
            c.hand_observations_file_id, c.frame_map_file_id, c.thumbnail_file_id, c.viewer_rrd_file_id)
          WHERE f.state NOT IN ('completed', 'verified') LIMIT 50)
       UNION ALL
       (SELECT 'accepted_without_verification', c.job_id::text
          FROM job_result_candidates c
          WHERE c.status = 'accepted' AND NOT EXISTS (
            SELECT 1 FROM job_output_verifications v WHERE v.job_id = c.job_id) LIMIT 50)`,
    );
    const jobs = await q<{ id: string; state: string; ref: boolean }>(
      client,
      `SELECT id::text, state, execution_call_id IS NOT NULL AS ref FROM jobs
       WHERE state NOT IN ('succeeded', 'failed', 'cancelled') ORDER BY created_at, id LIMIT $1`,
      [MAX_LIST + 1],
    );
    const uploads = await q<{ id: string; state: string }>(
      client,
      `SELECT id::text, state FROM files WHERE state IN ('uploading', 'completing')
         AND provider_upload_id IS NOT NULL ORDER BY id LIMIT $1`,
      [MAX_LIST + 1],
    );
    const slot = (
      await q<{ job_id: string | null; evidence: boolean }>(
        client,
        `SELECT d.job_id::text, EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = d.job_id) AS evidence
         FROM dispatch_admission d WHERE d.slot = 1`,
      )
    )[0];
    const sessions = (
      await q<{ total: string; live: string }>(
        client,
        `SELECT count(*)::text AS total, count(*) FILTER (WHERE "expiresAt" > now())::text AS live FROM "session"`,
      )
    )[0]!;
    const verification = Number(
      (
        await q<{ n: string }>(
          client,
          `SELECT count(*)::text AS n FROM verification`,
        )
      )[0]!.n,
    );
    const jobCaps = Number(
      (
        await q<{ n: string }>(
          client,
          `SELECT count(*)::text AS n FROM jobs
           WHERE state NOT IN ('succeeded', 'failed', 'cancelled')
             AND (capability_token_sha256 IS NOT NULL OR bootstrap_token_sha256 IS NOT NULL)`,
        )
      )[0]!.n,
    );
    const grants = (
      await q<{ k: string }>(
        client,
        `(SELECT 'access:' || user_id || ':' || role AS k FROM access WHERE enabled ORDER BY 1 LIMIT 1001)
         UNION ALL
         (SELECT 'dataset_access:' || dataset_id || ':' || user_id FROM dataset_access WHERE enabled ORDER BY 1 LIMIT 1001)
         UNION ALL
         (SELECT 'ingest_permission:' || id FROM ingest_permissions WHERE status = 'active' ORDER BY 1 LIMIT 1001)
         UNION ALL
         (SELECT 'service_capability:' || credential_id FROM service_capabilities
            WHERE revoked_at IS NULL AND expires_at > now() ORDER BY 1 LIMIT 1001)`,
      )
    ).map((r) => r.k);
    return {
      files,
      migrations,
      unvalidated,
      refIssues,
      jobs,
      uploads,
      slot: slot ? { job_id: slot.job_id, evidence: slot.evidence } : null,
      sessionTotal: Number(sessions.total),
      sessionLive: Number(sessions.live),
      verification,
      jobCaps,
      grants,
    };
  } catch (error) {
    // SQLSTATE only: the driver message may echo identifiers or values.
    const code = (error as { code?: unknown })?.code;
    throw new RestoreVerifyError(
      "snapshot_failed",
      `snapshot query failed${typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : ""}`,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

function checkLimits(l: VerifyLimits) {
  const ok = (n: number, max: number) =>
    Number.isSafeInteger(n) && n > 0 && n <= max;
  if (
    !ok(l.maxFiles, 100_000) ||
    !ok(l.maxTotalBytes, 2 ** 50) ||
    !ok(l.perObjectTimeoutMs, 3_600_000) ||
    !ok(l.totalWallMs, 6 * 3_600_000) ||
    !ok(l.statementTimeoutMs, 120_000)
  )
    throw new RestoreVerifyError("invalid_limits", "limits out of range");
}

export async function verifyRestoredCatalog(input: {
  client: pg.ClientBase;
  hasher: ObjectHasher;
  expectedMigrations: ExpectedMigration[];
  expectedGrants?: ExpectedGrants;
  limits?: Partial<VerifyLimits>;
  now?: () => number;
}): Promise<RestoreReport> {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  checkLimits(limits);
  const now = input.now ?? Date.now;
  const snap = await readSnapshot(input.client, limits);
  // The snapshot is released here: hashing never holds a database transaction.
  if (snap.files.length > limits.maxFiles)
    throw new RestoreVerifyError(
      "too_many_files",
      "more referenced files than the cap",
    );
  const total = snap.files.reduce((n, f) => n + Number(f.size_bytes), 0);
  if (total > limits.maxTotalBytes)
    throw new RestoreVerifyError(
      "too_many_bytes",
      "referenced bytes exceed the cap",
    );

  const started = now();
  const counts: Record<ObjectStatus, number> = {
    match: 0,
    missing: 0,
    size_mismatch: 0,
    sha_mismatch: 0,
    unread: 0,
    not_checked: 0,
  };
  const results: FileResult[] = [];
  let bytesHashed = 0;
  for (const f of snap.files) {
    const size = Number(f.size_bytes);
    let status: ObjectStatus;
    if (now() - started >= limits.totalWallMs) status = "not_checked";
    else {
      try {
        // Awaited to settlement even past its deadline: no abandoned read.
        const got = await input.hasher.hash(
          f.object_key,
          size,
          Math.min(
            limits.perObjectTimeoutMs,
            Math.max(1, limits.totalWallMs - (now() - started)),
          ),
        );
        bytesHashed += got.bytes;
        // The hasher's digest alone is never enough: the length it read must equal the catalog size.
        status =
          got.bytes !== size
            ? "size_mismatch"
            : got.sha256 === f.sha256
              ? "match"
              : "sha_mismatch";
      } catch (error) {
        const code =
          error instanceof ObjectHashError ? error.code : "object_read_failed";
        status =
          code === "object_missing"
            ? "missing"
            : code === "object_size_mismatch"
              ? "size_mismatch"
              : "unread";
      }
    }
    counts[status] += 1;
    results.push({
      fileId: f.id,
      purpose: f.purpose,
      role: f.role,
      state: f.state,
      sizeBytes: size,
      status,
    });
  }

  const expected = new Map(
    input.expectedMigrations.map((m) => [m.version, m.sha256]),
  );
  const have = new Map(snap.migrations.map((m) => [m.version, m.sha256]));
  const migrations = {
    missing: [...expected.keys()].filter((v) => !have.has(v)),
    extra: [...have.keys()].filter((v) => !expected.has(v)),
    checksumMismatch: [...expected]
      .filter(([v, s]) => have.has(v) && have.get(v) !== s)
      .map(([v]) => v),
  };
  const migrationOk =
    !migrations.missing.length &&
    !migrations.extra.length &&
    !migrations.checksumMismatch.length;

  const allow = input.expectedGrants
    ? new Set(input.expectedGrants.active)
    : undefined;
  const active = snap.grants;
  const stale = allow ? active.filter((g) => !allow.has(g)) : [];
  const activeSet = new Set(active);
  const absent = allow ? [...allow].filter((g) => !activeSet.has(g)) : [];

  const unexpected = snap.unvalidated
    .filter((k) => !KNOWN_NOT_VALID.has(k))
    .slice(0, MAX_LIST);
  const truncated =
    snap.jobs.length > MAX_LIST ||
    snap.uploads.length > MAX_LIST ||
    snap.grants.length > 1000 ||
    snap.unvalidated.length > MAX_LIST;
  const complete = counts.not_checked === 0;
  const blockers: string[] = [];
  if (!migrationOk)
    blockers.push("schema_migrations_differ_from_deployed_source");
  if (snap.refIssues.length) blockers.push("catalog_reference_issues");
  if (unexpected.length) blockers.push("unexpected_unvalidated_constraints");
  if (!complete) blockers.push("object_verification_incomplete");
  for (const s of [
    "missing",
    "size_mismatch",
    "sha_mismatch",
    "unread",
  ] as const)
    if (counts[s]) blockers.push(`objects_${s}`);
  if (snap.jobs.length) blockers.push("non_terminal_jobs_unreconciled");
  if (snap.uploads.length)
    blockers.push("uploads_with_provider_ref_unreconciled");
  if (snap.slot?.job_id) blockers.push("dispatch_slot_held");
  if (snap.sessionTotal) blockers.push("sessions_present_on_restored_copy");
  if (snap.jobCaps) blockers.push("live_job_capabilities_present");
  if (active.length && !allow)
    blockers.push("active_grants_unreconciled_no_allowlist");
  if (stale.length) blockers.push("active_grants_not_in_operator_allowlist");
  if (truncated) blockers.push("inventory_truncated");

  return {
    schema: "stateaction.restore_report.v1",
    provenance: "isolated_restore_verification",
    generatedAt: new Date(now()).toISOString(),
    limits,
    migrations: { status: migrationOk ? "match" : "mismatch", ...migrations },
    constraints: { unvalidated: snap.unvalidated.length, unexpected },
    referenceIssues: snap.refIssues,
    objects: { complete, counts, bytesHashed, files: results },
    unreconciled: {
      nonTerminalJobs: snap.jobs.slice(0, MAX_LIST).map((j) => ({
        jobId: j.id,
        state: j.state,
        hasExecutionRef: j.ref,
      })),
      uploadsWithProviderRef: snap.uploads
        .slice(0, MAX_LIST)
        .map((u) => ({ fileId: u.id, state: u.state })),
      sliceTruncated: truncated,
      slotHolder: snap.slot?.job_id
        ? { jobId: snap.slot.job_id, hasExecutionEvidence: snap.slot.evidence }
        : null,
      sessions: { total: snap.sessionTotal, unexpired: snap.sessionLive },
      verificationTokens: snap.verification,
      liveJobCapabilities: snap.jobCaps,
      activeGrants: active,
      grantsAllowlist: allow
        ? "operator_supplied_offline_not_authoritative"
        : "not_supplied",
      staleActiveGrants: stale,
      allowlistedButAbsent: absent,
    },
    blockers,
    manualGatesOpen: [...MANUAL_GATES],
    readyToReenable: false,
    notice:
      "Verification of a restored copy only. A database restore never recovers deleted object payloads, provider job state or post-restore-point revocations; the listed manual gates stay open until an operator reconciles them.",
  };
}
