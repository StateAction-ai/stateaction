import {
  asCode,
  asEnum,
  asInt,
  asExecutionRef,
  asTime,
  asUuid,
  readByteFacts,
  UNKNOWN,
  wrap,
  type ByteFacts,
  type Measured,
  type WorkerMetrics,
} from "./redact.js";

export const JOB_STATES = [
  "queued",
  "submitting",
  "running",
  "result_pending",
  "submit_unknown",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
  "needs_attention",
] as const;
export type OpsJobState = (typeof JOB_STATES)[number];
export const TERMINAL: readonly OpsJobState[] = [
  "succeeded",
  "failed",
  "cancelled",
];

/** Durable job facts (epoch ms). Built only through `readJobFacts`. */
export type FactsProvenance = "restricted_db_read" | "offline_operator_file";

export type JobFacts = {
  /**
   * Where these facts came from. An operator-supplied file is explicit offline
   * input, never a production fact source.
   */
  provenance: FactsProvenance;
  jobId: string;
  state: OpsJobState;
  errorCode?: string;
  backend?: "local" | "modal";
  executionRef?: string;
  createdAt?: number;
  admittedAt?: number;
  claimedAt?: number;
  lastHeartbeatAt?: number;
  unknownAt?: number;
  finishedAt?: number;
  executionDeadline?: number;
  /** Inline QC counts as reported by the accepted result (not recomputed here). */
  qc?: {
    pass: number;
    warn: number;
    fail: number;
    measured: number;
    notEvaluated: number;
  };
  bytes: ByteFacts;
};

const QC_KEYS = ["pass", "warn", "fail", "measured", "notEvaluated"] as const;

/** Allowlist reader for untrusted input (file/DB row). Returns undefined if not a job. */
export function readJobFacts(
  raw: unknown,
  provenance: FactsProvenance = "offline_operator_file",
): JobFacts | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  const r = raw as Record<string, unknown>;
  const jobId = asUuid(r.jobId);
  const state = asEnum(r.state, JOB_STATES);
  if (!jobId || !state) return undefined;
  const time = (k: string) => asTime(r[k]);
  let qc: JobFacts["qc"];
  if (typeof r.qc === "object" && r.qc !== null) {
    const counts = QC_KEYS.map((k) =>
      asInt((r.qc as Record<string, unknown>)[k], 64),
    );
    if (counts.every((n) => n !== undefined)) {
      const [pass, warn, fail, m, notEvaluated] = counts as number[];
      qc = {
        pass: pass!,
        warn: warn!,
        fail: fail!,
        measured: m!,
        notEvaluated: notEvaluated!,
      };
    }
  }
  const errorCode = asCode(r.errorCode);
  const backend = asEnum(r.backend, ["local", "modal"] as const);
  const executionRef = asExecutionRef(backend, r.executionRef);
  const opt = <K extends string, V>(k: K, v: V | undefined) =>
    v === undefined ? {} : ({ [k]: v } as Record<K, V>);
  return {
    provenance,
    jobId,
    state,
    ...opt("errorCode", errorCode),
    ...opt("backend", backend),
    ...opt("executionRef", executionRef),
    ...opt("createdAt", time("createdAt")),
    ...opt("admittedAt", time("admittedAt")),
    ...opt("claimedAt", time("claimedAt")),
    ...opt("lastHeartbeatAt", time("lastHeartbeatAt")),
    ...opt("unknownAt", time("unknownAt")),
    ...opt("finishedAt", time("finishedAt")),
    ...opt("executionDeadline", time("executionDeadline")),
    ...opt("qc", qc),
    bytes: readByteFacts(r.bytes),
  };
}

const secondsBetween = (from?: number, to?: number): Measured<number> =>
  from === undefined || to === undefined || to < from
    ? UNKNOWN
    : wrap((to - from) / 1000);

export type MetricsTrust =
  | "matched_execution"
  | "none"
  | "rejected_identity_mismatch"
  | "rejected_identity_unverifiable"
  | "rejected_ambiguous";

export type OpsReceipt = {
  schemaVersion: 1;
  provenance: FactsProvenance;
  jobId: string;
  /**
   * Whether the worker's measured line was matched to the authoritative
   * physical execution (backend AND execution reference). Mismatched or
   * unverifiable lines are discarded: their values are never labelled measured.
   */
  workerMetricsTrust: MetricsTrust;
  state: OpsJobState;
  backend: Measured<"local" | "modal">;
  /** Provider execution reference (an identifier, never a credential). */
  executionRef: Measured<string>;
  errorCode: Measured<string>;
  /** Derived from durable timestamps. */
  queueDelaySeconds: Measured<number>;
  durableClaimToFinishSeconds: Measured<number>;
  /** Only from the worker's own measured line. Unknown otherwise (never 0). */
  worker: {
    startupSeconds: Measured<number>;
    importSeconds: Measured<number>;
    wallSeconds: Measured<number>;
    peakRssSelfBytes: Measured<number>;
    peakRssChildrenBytes: Measured<number>;
    rssScope: "process_high_water_not_aggregate";
    scratchHighWaterBytes: Measured<number>;
    scratchStatus: WorkerMetrics["scratchStatus"];
    exitCode: Measured<number>;
  };
  /** Per role, declared / uploaded / verified kept separate. Absent basis = unknown. */
  bytes: Record<
    "source" | "output" | "rrd" | "failedOutput",
    Record<"declared" | "uploaded" | "verified", Measured<number>>
  >;
  qc: Measured<NonNullable<JobFacts["qc"]>>;
};

/**
 * A worker line is measured evidence for a job only when it names the same
 * backend AND the same execution reference the durable record holds. The
 * durable facts are authoritative; the line never supplies identity.
 */
function trust(
  facts: JobFacts,
  candidates: readonly WorkerMetrics[],
): { use?: WorkerMetrics | undefined; trust: MetricsTrust } {
  const mine = candidates.filter((m) => m.jobId === facts.jobId);
  if (mine.length === 0) return { trust: "none" };
  if (facts.backend === undefined || facts.executionRef === undefined)
    return { trust: "rejected_identity_unverifiable" };
  const ok = mine.filter(
    (m) => m.backend === facts.backend && m.executionRef === facts.executionRef,
  );
  if (ok.length === 0) return { trust: "rejected_identity_mismatch" };
  if (ok.length > 1) return { trust: "rejected_ambiguous" };
  return { use: ok[0], trust: "matched_execution" };
}

export function buildReceipt(
  facts: JobFacts,
  metrics?: WorkerMetrics | readonly WorkerMetrics[],
): OpsReceipt {
  const list =
    metrics === undefined ? [] : "jobId" in metrics ? [metrics] : metrics;
  const { use, trust: workerMetricsTrust } = trust(facts, list);
  const bytes = {} as OpsReceipt["bytes"];
  for (const role of ["source", "output", "rrd", "failedOutput"] as const) {
    // The worker's own counts only fill a basis the durable facts do not state.
    const merged = { ...use?.bytes[role], ...facts.bytes[role] };
    bytes[role] = {
      declared: wrap(merged.declared),
      uploaded: wrap(merged.uploaded),
      verified: wrap(merged.verified),
    };
  }
  const backend = facts.backend;
  const ref = facts.executionRef;
  return {
    schemaVersion: 1,
    provenance: facts.provenance,
    jobId: facts.jobId,
    workerMetricsTrust,
    state: facts.state,
    backend: backend ? { status: "measured", value: backend } : UNKNOWN,
    executionRef: ref ? { status: "measured", value: ref } : UNKNOWN,
    errorCode: facts.errorCode
      ? { status: "measured", value: facts.errorCode }
      : UNKNOWN,
    queueDelaySeconds: secondsBetween(
      facts.admittedAt ?? facts.createdAt,
      facts.claimedAt,
    ),
    durableClaimToFinishSeconds: secondsBetween(
      facts.claimedAt,
      facts.finishedAt,
    ),
    worker: {
      startupSeconds: use?.startupSeconds ?? UNKNOWN,
      importSeconds: use?.importSeconds ?? UNKNOWN,
      wallSeconds: use?.wallSeconds ?? UNKNOWN,
      peakRssSelfBytes: use?.peakRssSelfBytes ?? UNKNOWN,
      peakRssChildrenBytes: use?.peakRssChildrenBytes ?? UNKNOWN,
      rssScope: "process_high_water_not_aggregate",
      scratchHighWaterBytes: use?.scratchHighWaterBytes ?? UNKNOWN,
      scratchStatus: use?.scratchStatus ?? "unknown",
      exitCode: use?.exitCode ?? UNKNOWN,
    },
    bytes,
    qc: facts.qc ? { status: "measured", value: facts.qc } : UNKNOWN,
  };
}
