import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  asExecutionRef,
  asInt,
  asUuid,
  metricsFromLog,
  readRegularFile,
} from "@stateaction/server/ops";
import type { Stage } from "@stateaction/contracts";
import type { JobsApi } from "./api-client.js";
import { JournalStore } from "./journal.js";
import { lastLogLine } from "./local-process.js";
import { parseStageReceipt } from "./modal-executor.js";

/**
 * SA-96 stage diagnostics bundle. Nothing is copied from a file as-is: every journal field is
 * rebuilt from a closed validator (the SA-45 allowlist readers), metrics come from the
 * allowlisted `sa_metrics` parser, the receipt only if it validates as `jobs.stage-receipt.v1`,
 * and cached diagnostic blobs are scrubbed text under a hard size bound. Raw child logs, bootstrap
 * token files, URLs and recording bytes are never included.
 */
export const STAGES: readonly Stage[] = ["segment", "caption", "hand_pose"];
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 256 * 1024;
const TEXT_ROLES = new Set(["diagnostic_blob"]);

type Api = Pick<JobsApi, "status" | "recipe" | "dagRun" | "priorStages">;

/** Replace anything that looks like a capability or Authorization value. */
export function scrubText(text: string): string {
  return text
    .replace(/sa_svc_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /([A-Za-z0-9_.-]*(?:token|secret|password|passwd|authorization|signature|credential|api[_-]?key|access[_-]?key|private[_-]?key|session|cookie|x-amz-[a-z-]+)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)(?:Bearer\s+|Basic\s+)?[^\s"',}]+/gi,
      "$1$2$3[redacted]",
    )
    .replace(
      /https?:\/\/[^\s"']*[?&](?:X-Amz-|token=)[^\s"']*/gi,
      "[redacted-url]",
    );
}

type Entry = { path: string; data: Buffer };

function journalFacts(store: JournalStore, jobId: string, stage: Stage) {
  const out: Record<string, unknown> = { stage };
  try {
    const local = store.read(jobId, stage);
    if (local) {
      out.local = {
        phase: local.phase,
        executionRef: asExecutionRef("local", local.executionRef) ?? null,
        pid: asInt(local.pid) ?? null,
        exit: local.exit ?? null,
        termination: local.termination ?? null,
        startDeadline: local.startDeadline,
        executionDeadline: local.executionDeadline,
        budgetDeadline: local.budgetDeadline ?? null,
      };
    }
    const modal = store.readModal(jobId, stage);
    if (modal) {
      out.modal = {
        phase: modal.phase,
        callId: modal.callId ?? null,
        exitCode: modal.exitCode ?? null,
        termination: modal.termination ?? null,
      };
    }
  } catch {
    // A journal that fails strict validation is reported as such, never copied.
    out.unreadable = true;
  }
  return out;
}

function logFacts(store: JournalStore, jobId: string, stage: Stage) {
  const path = store.logPath(jobId, stage);
  const out: Record<string, unknown> = { stage, metrics: [], receipt: null };
  if (!existsSync(path)) return out;
  try {
    const text = readRegularFile(path, 1024 * 1024).toString("utf8");
    out.metrics = metricsFromLog(text, jobId);
  } catch {
    out.metricsUnreadable = true;
  }
  const raw = lastLogLine(path);
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    const parsed =
      typeof r.stage === "string" && typeof r.module === "string"
        ? parseStageReceipt(
            raw,
            { jobId, stage: r.stage as Stage, module: r.module },
            null,
          )
        : undefined;
    out.receipt = parsed ?? { unvalidated: true };
  }
  return out;
}

export type DiagDeps = {
  api: Api;
  store: JournalStore;
  /**
   * Optional dev-stack cache of stage output bytes: `<cacheDir>/<jobId>/outputs/<slot>`.
   * Only roles listed as text are read, scrubbed and bounded; any other role is listed only.
   */
  cacheDir?: string | undefined;
};

export async function collectDiag(deps: DiagDeps, jobId: string) {
  if (!asUuid(jobId)) throw new Error("--job must be a job UUID");
  const entries: Entry[] = [];
  const add = (path: string, value: unknown) =>
    entries.push({
      path,
      data: Buffer.from(JSON.stringify(value, null, 2) + "\n"),
    });
  add("job-status.json", await deps.api.status(jobId));
  const recipe = await deps.api.recipe(jobId);
  if (recipe) add("recipe.json", recipe);
  if (recipe) add("dag-run.json", await deps.api.dagRun(jobId));
  const prior = recipe ? await deps.api.priorStages(jobId) : undefined;
  if (prior) add("outputs.json", prior);
  for (const stage of STAGES) {
    add(`journals/${stage}.json`, journalFacts(deps.store, jobId, stage));
    add(`logs/${stage}.json`, logFacts(deps.store, jobId, stage));
  }
  const blobs: unknown[] = [];
  for (const s of prior?.stages ?? []) {
    for (const o of s.outputs) {
      const listed: Record<string, unknown> = {
        stage: s.stage,
        fileId: o.fileId,
        role: o.role,
        slot: o.slot,
        sizeBytes: o.sizeBytes,
      };
      if (TEXT_ROLES.has(o.role) && deps.cacheDir) {
        const file = resolve(deps.cacheDir, jobId, "outputs", o.slot);
        const root = resolve(deps.cacheDir, jobId, "outputs") + "/";
        if (file.startsWith(root) && existsSync(file)) {
          const text = readRegularFile(file, MAX_BLOB_BYTES).toString("utf8");
          entries.push({
            path: `blobs/${o.fileId}.txt`,
            data: Buffer.from(scrubText(text)),
          });
          listed.included = true;
        }
      }
      blobs.push(listed);
    }
  }
  add("blobs.json", blobs);
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  if (total > MAX_BUNDLE_BYTES)
    throw new Error(`diagnostic bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  return entries;
}

/** Writes the entries as a gzip tar (mode 0600) atomically; returns the byte size. */
export function writeBundle(entries: Entry[], out: string): number {
  const dir = mkdtempSync(join(tmpdir(), "sa96-diag-"));
  try {
    for (const e of entries) {
      const p = join(dir, e.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, e.data);
    }
    const tmp = `${out}.part`;
    const r = spawnSync("tar", ["-czf", tmp, "-C", dir, "."], {
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error("tar failed");
    renameSync(tmp, out);
    return statSync(out).size;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function buildDiag(deps: DiagDeps, jobId: string, out: string) {
  if (existsSync(out) && lstatSync(out).isSymbolicLink())
    throw new Error("--out must not be a symlink");
  const entries = await collectDiag(deps, jobId);
  const bytes = writeBundle(entries, out);
  return { files: entries.length, bytes };
}
