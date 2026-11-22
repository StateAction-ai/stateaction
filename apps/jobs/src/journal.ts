import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Stage, StageReceiptV1 } from "@stateaction/contracts";

/**
 * Local execution journal: the controller's durable memory of what it intended
 * and did physically for one job. It holds NO secret except the one-time
 * bootstrap token file, which is deleted once handed to the child. Every phase
 * transition is written (fsync + atomic rename) BEFORE the effect it describes,
 * so a crash can only leave a phase whose effect is provably absent or
 * explicitly uncertain (`spawning`).
 */
export type Phase =
  | "intent" // server submission intent recorded, token + executionRef saved locally
  | "execution_recorded" // legacy checkpoint after recording the executionRef
  | "spawning" // written BEFORE spawn; without a pid the child may or may not exist
  | "running" // child identity (pid/pgid/start ticks/boot) recorded
  | "exited"; // child proven gone; evidence may still need recording

export type Journal = {
  version: 1;
  jobId: string;
  /** SA-91: the recipe stage this journal belongs to (absent for a job without a recipe). */
  stage?: Stage;
  runRef: string;
  executionRef: string;
  phase: Phase;
  bootId: string;
  startDeadline: string;
  executionDeadline: string;
  pid?: number;
  pgid?: number;
  sid?: number;
  startTicks?: string;
  singleProcess?: true;
  threadedPipeline?: true;
  pidNamespace?: string;
  exit?: { code: number | null; signal: string | null };
  evidenceRecorded?: boolean;
  /** SA-91 stage only: the stage wall budget ends here (fixed when the spawn is journaled). */
  budgetDeadline?: string;
  /** SA-91 stage only: why the child ended (natural_exit, budget_exceeded, ...), once exited. */
  termination?: string;
};

/**
 * SA-42 Modal journal: the same write-before-effect discipline, but the physical
 * identity is a provider function call ID that exists only AFTER the spawn.
 * `spawning` without a `callId` therefore means "the spawn may or may not have
 * happened": it is never repeated. Stored in its own file so a local controller
 * can never misread it (and vice versa).
 */
export type ModalPhase =
  | "intent" // server submission intent recorded, token saved locally; nothing spawned
  | "spawning" // written BEFORE the single spawn; without a callId the outcome is uncertain
  | "submitted" // callId durably known; supervise/poll only
  | "terminal"; // a structured terminal result for this exact call was observed

export type ModalJournal = {
  version: 1;
  executor: "modal";
  jobId: string;
  /** SA-91: the recipe stage this journal belongs to (absent for a job without a recipe). */
  stage?: Stage;
  runRef: string;
  phase: ModalPhase;
  startDeadline: string;
  executionDeadline: string;
  callId?: string;
  /** The server acknowledged record_execution for callId (or the worker claim already set it). */
  executionRecorded?: boolean;
  /** A provider cancel REQUEST was sent. A request is never termination proof. */
  cancelRequestedAt?: string;
  termination?: string;
  exitCode?: number;
  evidenceRecorded?: boolean;
  /** SA-91 stage only: the stage wall budget ends here (fixed when the spawn is journaled). */
  budgetDeadline?: string;
  /** SA-91 stage only: the validated stage receipt of the terminal result, if it carried one. */
  receipt?: StageReceiptV1;
};

export class JournalCorrupt extends Error {}

const PHASES: readonly Phase[] = [
  "intent",
  "execution_recorded",
  "spawning",
  "running",
  "exited",
];
const KEYS = new Set([
  "version",
  "jobId",
  "runRef",
  "executionRef",
  "phase",
  "bootId",
  "startDeadline",
  "executionDeadline",
  "pid",
  "pgid",
  "sid",
  "startTicks",
  "singleProcess",
  "threadedPipeline",
  "pidNamespace",
  "exit",
  "evidenceRecorded",
  "stage",
  "budgetDeadline",
  "termination",
]);
const STAGES: readonly Stage[] = ["segment", "caption", "hand_pose"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN = /^[A-Za-z0-9._:-]{1,200}$/;
const REF = /^[A-Za-z0-9._:-]{1,128}$/;
const TICKS = /^[0-9]{1,20}$/;
const MAX_ID = 4_194_304; // Linux pid_max upper bound

function bad(): never {
  throw new JournalCorrupt("Journal corrupt");
}
/** A stage journal names exactly the stage it is stored under; a job journal names none. */
function checkStage(j: Record<string, unknown>, stage: Stage | undefined) {
  if (j.stage !== stage) return bad();
  if (stage !== undefined && !STAGES.includes(stage)) return bad();
  if (j.budgetDeadline !== undefined) {
    if (stage === undefined) return bad();
    instant(j.budgetDeadline);
  }
}
const isId = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= MAX_ID;
const instant = (v: unknown): number => {
  if (typeof v !== "string") return bad();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : bad();
};

/**
 * Strict, complete, phase-specific validation. Any deviation is corruption: the
 * original file is preserved untouched and the controller treats the physical
 * state as unknown (never as "gone").
 */
export function validateJournal(
  value: unknown,
  jobId: string,
  stage?: Stage,
): Journal {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return bad();
  const j = value as Record<string, unknown>;
  for (const key of Object.keys(j)) if (!KEYS.has(key)) return bad();
  checkStage(j, stage);
  if (j.version !== 1 || j.jobId !== jobId || !UUID.test(jobId)) return bad();
  if (typeof j.runRef !== "string" || !RUN.test(j.runRef)) return bad();
  if (typeof j.executionRef !== "string" || !REF.test(j.executionRef))
    return bad();
  if (!PHASES.includes(j.phase as Phase)) return bad();
  if (typeof j.bootId !== "string" || !UUID.test(j.bootId)) return bad();
  const start = instant(j.startDeadline);
  const end = instant(j.executionDeadline);
  if (start > end) return bad();
  const phase = j.phase as Phase;
  const identity = [j.pid, j.pgid, j.sid];
  const hasIdentity = identity.every((v) => v !== undefined);
  if (phase === "running" || phase === "exited") {
    if (!hasIdentity || !identity.every(isId)) return bad();
    if (
      j.startTicks !== undefined &&
      !(typeof j.startTicks === "string" && TICKS.test(j.startTicks))
    )
      return bad();
  } else if (
    identity.some((v) => v !== undefined) ||
    j.startTicks !== undefined ||
    j.exit !== undefined
  )
    return bad();
  if (phase === "exited") {
    const e = j.exit as Record<string, unknown> | undefined;
    if (typeof e !== "object" || e === null) return bad();
    if (Object.keys(e).some((k) => k !== "code" && k !== "signal"))
      return bad();
    const codeOk =
      e.code === null ||
      (typeof e.code === "number" && Number.isSafeInteger(e.code));
    const sigOk =
      e.signal === null ||
      (typeof e.signal === "string" && e.signal.length <= 32);
    if (!codeOk || !sigOk) return bad();
  } else if (j.exit !== undefined) return bad();
  if (
    j.singleProcess !== undefined &&
    (j.singleProcess !== true ||
      j.startTicks === undefined ||
      (phase !== "running" && phase !== "exited"))
  )
    return bad();
  if (
    (j.threadedPipeline !== undefined && j.threadedPipeline !== true) ||
    (j.threadedPipeline && j.singleProcess)
  )
    return bad();
  if (
    j.pidNamespace !== undefined &&
    (j.threadedPipeline !== true ||
      typeof j.pidNamespace !== "string" ||
      !/^pid:\[\d+\]$/.test(j.pidNamespace) ||
      j.startTicks === undefined ||
      (phase !== "running" && phase !== "exited"))
  )
    return bad();
  if (
    j.evidenceRecorded !== undefined &&
    (j.evidenceRecorded !== true || phase !== "exited")
  )
    return bad();
  if (
    j.termination !== undefined &&
    (stage === undefined ||
      phase !== "exited" ||
      typeof j.termination !== "string" ||
      !/^[a-z_]{1,40}$/.test(j.termination))
  )
    return bad();
  return j as unknown as Journal;
}

const MODAL_KEYS = new Set([
  "version",
  "executor",
  "jobId",
  "runRef",
  "phase",
  "startDeadline",
  "executionDeadline",
  "callId",
  "executionRecorded",
  "cancelRequestedAt",
  "termination",
  "exitCode",
  "evidenceRecorded",
  "stage",
  "budgetDeadline",
  "receipt",
]);
const MODAL_PHASES: readonly ModalPhase[] = [
  "intent",
  "spawning",
  "submitted",
  "terminal",
];
/** Same shape the contract enforces for a Modal function call ID. */
export const CALL_ID = /^fc-[A-Za-z0-9]{1,77}$/;

export function validateModalJournal(
  value: unknown,
  jobId: string,
  stage?: Stage,
): ModalJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return bad();
  const j = value as Record<string, unknown>;
  for (const key of Object.keys(j)) if (!MODAL_KEYS.has(key)) return bad();
  checkStage(j, stage);
  // The receipt of a terminal stage result (validated against its contract when it was observed).
  if (
    j.receipt !== undefined &&
    (stage === undefined ||
      j.phase !== "terminal" ||
      typeof j.receipt !== "object" ||
      j.receipt === null ||
      Array.isArray(j.receipt))
  )
    return bad();
  if (j.version !== 1 || j.executor !== "modal") return bad();
  if (j.jobId !== jobId || !UUID.test(jobId)) return bad();
  if (typeof j.runRef !== "string" || !RUN.test(j.runRef)) return bad();
  if (!MODAL_PHASES.includes(j.phase as ModalPhase)) return bad();
  if (instant(j.startDeadline) > instant(j.executionDeadline)) return bad();
  const phase = j.phase as ModalPhase;
  const hasId = j.callId !== undefined;
  if (hasId && !(typeof j.callId === "string" && CALL_ID.test(j.callId)))
    return bad();
  // A call ID exists exactly from `submitted` on; before that the spawn has not been acknowledged.
  if (hasId !== (phase === "submitted" || phase === "terminal")) return bad();
  if (j.executionRecorded !== undefined && j.executionRecorded !== true)
    return bad();
  if (j.executionRecorded !== undefined && !hasId) return bad();
  if (j.cancelRequestedAt !== undefined) {
    if (!hasId) return bad();
    instant(j.cancelRequestedAt);
  }
  if (
    j.termination !== undefined &&
    (typeof j.termination !== "string" || !/^[a-z_]{1,40}$/.test(j.termination))
  )
    return bad();
  if (phase === "terminal") {
    if (
      typeof j.exitCode !== "number" ||
      !Number.isSafeInteger(j.exitCode) ||
      Math.abs(j.exitCode) > 255
    )
      return bad();
  } else if (j.exitCode !== undefined || j.evidenceRecorded !== undefined)
    return bad();
  if (j.evidenceRecorded !== undefined && j.evidenceRecorded !== true)
    return bad();
  return j as unknown as ModalJournal;
}

export class JournalStore {
  constructor(private readonly root: string) {}

  /** `<stateDir>/<jobId>`, or `<stateDir>/<jobId>/<stage>` for one recipe stage (SA-91). */
  dir(jobId: string, stage?: Stage): string {
    return stage === undefined
      ? join(this.root, jobId)
      : join(this.root, jobId, stage);
  }
  logPath(jobId: string, stage?: Stage): string {
    return join(this.dir(jobId, stage), "child.log");
  }
  private tokenPath(jobId: string, stage?: Stage): string {
    return join(this.dir(jobId, stage), "bootstrap.token");
  }

  ensure(jobId: string, stage?: Stage): void {
    mkdirSync(this.dir(jobId, stage), { recursive: true, mode: 0o700 });
    requirePrivateDirectory(lstatSync(this.dir(jobId)));
    if (stage !== undefined)
      requirePrivateDirectory(lstatSync(this.dir(jobId, stage)));
  }

  private readJournal(jobId: string, filename: string, stage?: Stage): unknown {
    let raw: string;
    try {
      const dir = openSync(
        this.dir(jobId, stage),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        requirePrivateDirectory(fstatSync(dir));
        // Anchor the read to the directory we validated, even if it is renamed.
        const fd = openSync(
          `/proc/self/fd/${dir}/${filename}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = fstatSync(fd);
          if (
            !info.isFile() ||
            info.uid !== process.getuid?.() ||
            (info.mode & 0o077) !== 0
          )
            return bad();
          raw = readFileSync(fd, "utf8");
        } finally {
          closeSync(fd);
        }
      } finally {
        closeSync(dir);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new JournalCorrupt("Journal unreadable");
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new JournalCorrupt("Journal corrupt");
    }
  }

  read(jobId: string, stage?: Stage): Journal | undefined {
    const parsed = this.readJournal(jobId, "journal.json", stage);
    return parsed === undefined
      ? undefined
      : validateJournal(parsed, jobId, stage);
  }

  readModal(jobId: string, stage?: Stage): ModalJournal | undefined {
    const parsed = this.readJournal(jobId, "modal-journal.json", stage);
    return parsed === undefined
      ? undefined
      : validateModalJournal(parsed, jobId, stage);
  }

  writeModal(journal: ModalJournal): void {
    validateModalJournal(journal, journal.jobId, journal.stage);
    this.ensure(journal.jobId, journal.stage);
    atomicWrite(
      join(this.dir(journal.jobId, journal.stage), "modal-journal.json"),
      JSON.stringify(journal),
    );
  }

  /** True when a MODAL journal exists for this job or stage (a local controller must not guess around it). */
  hasModalJournal(jobId: string, stage?: Stage): boolean {
    return this.hasJournal(jobId, "modal-journal.json", stage);
  }

  /** True when a LOCAL journal exists for this job or stage (a Modal controller must not guess around it). */
  hasLocalJournal(jobId: string, stage?: Stage): boolean {
    return this.hasJournal(jobId, "journal.json", stage);
  }

  private hasJournal(jobId: string, filename: string, stage?: Stage): boolean {
    try {
      lstatSync(join(this.dir(jobId, stage), filename));
      return true;
    } catch (error) {
      // An unreadable entry cannot prove that the other executor left no journal.
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  write(journal: Journal): void {
    // never persist a record we would later reject
    validateJournal(journal, journal.jobId, journal.stage);
    this.ensure(journal.jobId, journal.stage);
    atomicWrite(
      join(this.dir(journal.jobId, journal.stage), "journal.json"),
      JSON.stringify(journal),
    );
  }

  /** A marker's presence means the one spawn opportunity (of the job or stage) was consumed. */
  reserveSpawn(jobId: string, stage?: Stage): boolean {
    this.ensure(jobId, stage);
    const dir = this.dir(jobId, stage);
    let fd: number;
    try {
      fd = openSync(join(dir, "spawn.reserved"), "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      fsyncSync(fd);
      syncDirectory(dir);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  saveToken(jobId: string, token: string, stage?: Stage): void {
    this.ensure(jobId, stage);
    atomicWrite(this.tokenPath(jobId, stage), token);
  }
  loadToken(jobId: string, stage?: Stage): string | undefined {
    try {
      return readFileSync(this.tokenPath(jobId, stage), "utf8");
    } catch {
      return undefined;
    }
  }
  discardToken(jobId: string, stage?: Stage): void {
    rmSync(this.tokenPath(jobId, stage), { force: true });
  }
}

function requirePrivateDirectory(info: Stats): void {
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o7777) !== 0o700
  )
    throw new JournalCorrupt("Journal directory must be private to this user");
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDirectory(join(path, ".."));
}

function syncDirectory(path: string): void {
  const dirFd = openSync(path, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}
