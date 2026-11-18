/**
 * SA-45 typed allowlist readers. Nothing here sanitises by string replacement:
 * every output field is rebuilt from a value that passed a closed validator
 * (enum, UUID, bounded integer, strict identifier). Anything else becomes
 * `unknown`; free text, paths, URLs and unknown keys can never be copied.
 */

/** Safe-by-construction input failure: the message never contains an input value. */
export class OpsInputError extends Error {}

export type Measured<T> =
  | { status: "measured"; value: T }
  | { status: "unknown" };

export const UNKNOWN: { status: "unknown" } = { status: "unknown" };
export const measured = <T>(value: T): Measured<T> => ({
  status: "measured",
  value,
});

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_PART =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/**
 * Backend-specific KNOWN identifier forms. A character class that merely
 * allows "token-safe" characters is not a secret boundary, so each backend
 * accepts only the exact shape its executor produces: the controller's
 * `local-<uuid>` (or the fixture `fixture-<uuid>`) and a Modal function call id
 * `fc-<alnum>` (the same patterns the job service enforces).
 */
const EXECUTION_REF = {
  local: new RegExp(`^(local|fixture)-${UUID_PART}$`),
  modal: /^fc-[A-Za-z0-9]{1,77}$/,
} as const;
/**
 * Closed error-code vocabulary: only codes this repository emits are echoed.
 * Anything else (including worker codes derived from exception class names) is
 * reported as unknown instead of being copied.
 */
export const ERROR_CODES = [
  "never_submitted",
  "worker_exited_without_result",
  "source_sha_mismatch",
  "source_checksum_mismatch",
  "worker_failed",
  "worker_error",
  "output_not_completed",
  "output_plan_mismatch",
  "verification_timeout",
  "verification_budget_exceeded",
  "manifest_missing",
  "manifest_too_large",
  "manifest_hash_mismatch",
  "manifest_contract_invalid",
  "clip_id_conflict",
  "job_inputs_missing",
] as const;
export type KnownErrorCode = (typeof ERROR_CODES)[number];
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export const asUuid = (v: unknown): string | undefined =>
  typeof v === "string" && UUID.test(v) ? v : undefined;
export const asExecutionRef = (
  backend: "local" | "modal" | undefined,
  v: unknown,
): string | undefined =>
  backend !== undefined &&
  typeof v === "string" &&
  EXECUTION_REF[backend].test(v)
    ? v
    : undefined;
export const asCode = (v: unknown): KnownErrorCode | undefined =>
  typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v)
    ? (v as KnownErrorCode)
    : undefined;
export const asEnum = <T extends string>(
  v: unknown,
  allowed: readonly T[],
): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
export const asInt = (v: unknown, max = MAX_SAFE): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max
    ? v
    : undefined;
export const asSeconds = (v: unknown, max = 1e9): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max
    ? v
    : undefined;
export const asTime = (v: unknown): number | undefined => {
  const ms =
    v instanceof Date
      ? v.getTime()
      : typeof v === "string" &&
          /^\d{4}-\d{2}-\d{2}T[\d:.]{8,12}(Z|[+-]\d{2}:\d{2})$/.test(v)
        ? Date.parse(v)
        : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};
export const wrap = (n: number | undefined): Measured<number> =>
  n === undefined ? UNKNOWN : measured(n);

export const BYTE_ROLES = ["source", "output", "rrd", "failedOutput"] as const;
export const BYTE_BASES = ["declared", "uploaded", "verified"] as const;
export type ByteRole = (typeof BYTE_ROLES)[number];
export type ByteBasis = (typeof BYTE_BASES)[number];
export type ByteFacts = Partial<
  Record<ByteRole, Partial<Record<ByteBasis, number>>>
>;

export function readByteFacts(v: unknown): ByteFacts {
  const out: ByteFacts = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const role of BYTE_ROLES) {
    const bases = (v as Record<string, unknown>)[role];
    if (typeof bases !== "object" || bases === null || Array.isArray(bases))
      continue;
    for (const basis of BYTE_BASES) {
      const n = asInt((bases as Record<string, unknown>)[basis]);
      if (n !== undefined) (out[role] ??= {})[basis] = n;
    }
  }
  return out;
}

/** The worker's one-line resource record, rebuilt field by field. */
export type WorkerMetrics = {
  jobId: string;
  backend?: "local" | "modal";
  executionRef?: string;
  outcome?: "returned" | "raised";
  exitCode: Measured<number>;
  startupSeconds: Measured<number>;
  importSeconds: Measured<number>;
  wallSeconds: Measured<number>;
  /** Separate process high-water facts; never summed, never a container/cgroup peak. */
  peakRssSelfBytes: Measured<number>;
  peakRssChildrenBytes: Measured<number>;
  scratchHighWaterBytes: Measured<number>;
  scratchStatus: "sampled_lower_bound" | "sampled_incomplete" | "unknown";
  bytes: ByteFacts;
};

export const MAX_METRICS_LINE_BYTES = 2048;
export const MAX_LOG_BYTES = 1024 * 1024;
const PREFIX = "sa_metrics ";

export function parseMetricsLine(line: string): WorkerMetrics | undefined {
  if (!line.startsWith(PREFIX)) return undefined;
  if (Buffer.byteLength(line) > MAX_METRICS_LINE_BYTES + PREFIX.length)
    return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1 || r.kind !== "sa_metrics") return undefined;
  const jobId = asUuid(r.jobId);
  if (!jobId) return undefined;
  const backend = asEnum(r.backend, ["local", "modal"] as const);
  // The reference is only meaningful together with its backend's exact form.
  const executionRef = asExecutionRef(backend, r.executionRef);
  const outcome = asEnum(r.outcome, ["returned", "raised"] as const);
  return {
    jobId,
    ...(backend ? { backend } : {}),
    ...(executionRef ? { executionRef } : {}),
    ...(outcome ? { outcome } : {}),
    exitCode: wrap(asInt(r.exitCode, 255)),
    startupSeconds: wrap(asSeconds(r.startupSeconds)),
    importSeconds: wrap(asSeconds(r.importSeconds)),
    wallSeconds: wrap(asSeconds(r.wallSeconds)),
    peakRssSelfBytes: wrap(asInt(r.peakRssSelfBytes)),
    peakRssChildrenBytes: wrap(asInt(r.peakRssChildrenBytes)),
    scratchHighWaterBytes: wrap(asInt(r.scratchHighWaterBytes)),
    scratchStatus:
      asEnum(r.scratchStatus, [
        "sampled_lower_bound",
        "sampled_incomplete",
        "unknown",
      ] as const) ?? "unknown",
    bytes: readByteFacts(r.bytes),
  };
}

/**
 * Every well-formed metrics line for the job in an already size-bounded log
 * (the reader rejects oversize input; nothing is truncated here). The caller
 * decides trust by matching identity against the durable execution.
 */
export function metricsFromLog(text: string, jobId: string): WorkerMetrics[] {
  if (Buffer.byteLength(text) > MAX_LOG_BYTES)
    throw new OpsInputError("file too large");
  const found: WorkerMetrics[] = [];
  for (const line of text.split("\n")) {
    const m = parseMetricsLine(line);
    if (m?.jobId === jobId) found.push(m);
    if (found.length >= MAX_LINES_PER_JOB) break;
  }
  return found;
}
export const MAX_LINES_PER_JOB = 8;
