import { createHash } from "node:crypto";
import {
  validateValue,
  type Stage,
  type ModalRerunBinding,
  type StageReceiptV1,
} from "@stateaction/contracts";
import { CALL_ID } from "./journal.js";

/**
 * SA-42 Modal executor seam. The controller talks to Modal ONLY through this
 * interface; a fake implements it in tests and a thin adapter over the official
 * SDK implements it in production (`modal-sdk.ts`). The processing container
 * never sees a Modal credential.
 */

/** Scoped bootstrap handed to the Modal function as its single spawn argument (JSON string). */
export type ModalBootstrap =
  | ModalJobBootstrap
  | StageBootstrap
  | HandPoseBootstrap;
export type ModalJobBootstrap = {
  schemaVersion: 1;
  apiUrl: string;
  jobId: string;
  bootstrapToken: string;
  /** Modal runs the production pipeline only. */
  pipeline: "hand_pose_cpu_v1";
};

/**
 * SA-91 stage bootstrap v2 (the shape `stage_entry.py` parses). It names one recipe stage, its
 * module and the recipe digest; the caption stage also pins the segments output it captions by
 * file ID and sha256. The token is that stage's own single-use claim token. The Modal wrapper adds
 * `executionRef` (its call ID) and `executorKind`; the local executor sets both itself.
 */
export type StageBootstrap = {
  schemaVersion: 2;
  apiUrl: string;
  jobId: string;
  bootstrapToken: string;
  stage: Stage;
  module: string;
  recipeSha256: string;
  segmentsFileId?: string;
  segmentsSha256?: string;
  executionRef?: string;
  executorKind?: "local";
};

/**
 * SA-91/SA-92 sealing stage bootstrap: the v1 `run-job` shape plus the four recipe keys (all or
 * none). `priorStages` are the server's segment and caption rows with every file their slots
 * attribute to them (`jobs.prior-stages.v1`), which the worker closes into processing-result.v3.
 * The Modal wrapper sets `executionRef`/`executorKind`; the local executor sets them itself.
 */
export type HandPoseBootstrap = {
  schemaVersion: 1;
  apiUrl: string;
  jobId: string;
  bootstrapToken: string;
  pipeline: "hand_pose_cpu_v1";
  stage: "hand_pose";
  module: string;
  recipeSha256: string;
  prepareOnly?: true;
  priorStages: {
    stage: "segment" | "caption";
    state: string;
    errorCode: string | null;
    counts: Record<string, number>;
    outputs: {
      fileId: string;
      role: string;
      slot: string;
      sizeBytes: string;
      sha256: string;
    }[];
  }[];
  executionRef?: string;
  executorKind?: "local";
};

/** Worker stdin bound for every bootstrap (`run_job` and `stage_entry`, 8 KiB). */
export const MAX_BOOTSTRAP_BYTES = 8192;

/**
 * What the thin wrapper returns after the shared CLI has exited and been reaped
 * inside the container. It is the ONLY value that can prove a terminal call.
 */
export type ModalRunResult = {
  schemaVersion: 1 | 2;
  functionCallId: string;
  exitCode: number;
  callBinding?: string;
  /** v2 (SA-91 stage): the stage receipt, or null when the stage produced none (crash). */
  receipt?: StageReceiptV1 | null;
};

/** What a stage result must describe: exactly this job, stage and module. */
export type StageExpectation = { jobId: string; stage: Stage; module: string };

/**
 * One bounded observation of a call. Only `returned` can ever lead to
 * `provider_call_terminal` evidence, and only after `parseRunResult` accepts the
 * value for the exact recorded call. A poll timeout, a function timeout, a
 * cancelled/failed/internal error or a lost connection is NEVER terminal proof.
 */
export type CallObservation =
  | { kind: "pending"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "returned"; value: unknown };

/** The adapter stopped before invoking the provider spawn. */
export class ModalSpawnNotSent extends Error {
  constructor() {
    super("modal spawn blocked by its bound or controller authorization");
    this.name = "ModalSpawnNotSent";
  }
}

export interface ModalClient {
  /**
   * Spawn one call and resolve its provider call ID. Check authorization immediately
   * before invoking the provider. A rejected spawn never authorizes a retry.
   */
  spawn(
    bootstrap: ModalBootstrap,
    canSubmit: () => boolean,
    binding?: ModalRerunBinding,
  ): Promise<string>;
  checkFunction?(module: string, binding: ModalRerunBinding): Promise<boolean>;
  /** Read-only container identities for this exact GPU call. A denied lookup is an error. */
  watchGpuCall?(callId: string, binding: ModalRerunBinding): Promise<string[]>;
  /** Bounded observation (never waits longer than the adapter's poll window). */
  poll(callId: string): Promise<CallObservation>;
  /** A cancel REQUEST with container termination. Returning is not proof of anything. */
  cancel(callId: string): Promise<void>;
  /** Release client resources when the controller entry settles. Never throws. */
  close?(): void;
}

export function recoveryBinding(
  jobId: string,
  apiUrl: string,
  bootstrapSha256: string,
  stage?: StageExpectation,
): string {
  return createHash("sha256")
    .update(
      [
        apiUrl,
        jobId,
        stage?.stage ?? "",
        stage?.module ?? "",
        bootstrapSha256,
      ].join("\n"),
    )
    .digest("hex");
}

/**
 * Strict: exact keys, the exact call this controller recorded, a small integer exit code.
 * Without `stage` only the SA-42 v1 shape is accepted (a job without a recipe). For a stage, v2
 * `{schemaVersion: 2, functionCallId, exitCode, receipt}` is required, with a receipt valid
 * against `jobs.stage-receipt.v1` for exactly this job, stage and module (or `null` when the
 * stage produced none).
 */
export function parseRunResult(
  value: unknown,
  callId: string,
  stage?: StageExpectation,
): ModalRunResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  const v2 = v.schemaVersion === 2 && stage !== undefined;
  const v1 = v.schemaVersion === 1 && stage === undefined;
  if (!v1 && !v2) return undefined;
  const allowed = v2
    ? ["schemaVersion", "functionCallId", "exitCode", "receipt"]
    : ["schemaVersion", "functionCallId", "exitCode"];
  const binding = v.callBinding;
  if (binding !== undefined) {
    if (typeof binding !== "string" || !/^[0-9a-f]{64}$/.test(binding))
      return undefined;
    allowed.push("callBinding");
  }
  if (keys.length !== allowed.length || !keys.every((k) => allowed.includes(k)))
    return undefined;
  if (
    typeof v.functionCallId !== "string" ||
    !CALL_ID.test(v.functionCallId) ||
    v.functionCallId !== callId
  )
    return undefined;
  const exitCode = exitCodeOf(v.exitCode);
  if (exitCode === undefined) return undefined;
  const common = {
    functionCallId: callId,
    exitCode,
    ...(binding === undefined ? {} : { callBinding: binding }),
  };
  if (!v2) return { schemaVersion: 1, ...common };
  const receipt =
    v.receipt === null ? null : parseStageReceipt(v.receipt, stage!, exitCode);
  if (receipt === undefined) return undefined;
  return { schemaVersion: 2, ...common, receipt };
}

export function exitCodeOf(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 255
    ? value
    : undefined;
}

/**
 * A stage receipt is accepted only when it is contract-valid (schema and rules), describes this
 * job, stage and module, and agrees with the exit code when one was observed (0 exactly when it
 * reports success).
 */
export function parseStageReceipt(
  value: unknown,
  stage: StageExpectation,
  /** null: the exit was not observed (adopted, proven-gone local child); no agreement check. */
  exitCode: number | null,
): StageReceiptV1 | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !validateValue("jobs.stage-receipt.v1", value).valid
  )
    return undefined;
  const r = value as StageReceiptV1;
  if (
    r.jobId !== stage.jobId ||
    r.stage !== stage.stage ||
    r.module !== stage.module ||
    (exitCode !== null && (r.status === "succeeded") !== (exitCode === 0))
  )
    return undefined;
  return r;
}
