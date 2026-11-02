import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

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
  | "execution_recorded" // executionRef recorded on the server; nothing spawned yet
  | "spawning" // written BEFORE spawn; without a pid the child may or may not exist
  | "running" // child identity (pid/pgid/start ticks/boot) recorded
  | "exited"; // child proven gone; evidence may still need recording

export type Journal = {
  version: 1;
  jobId: string;
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
  exit?: { code: number | null; signal: string | null };
  evidenceRecorded?: boolean;
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
  "exit",
  "evidenceRecorded",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN = /^[A-Za-z0-9._:-]{1,200}$/;
const REF = /^[A-Za-z0-9._:-]{1,128}$/;
const TICKS = /^[0-9]{1,20}$/;
const MAX_ID = 4_194_304; // Linux pid_max upper bound

function bad(): never {
  throw new JournalCorrupt("Journal corrupt");
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
export function validateJournal(value: unknown, jobId: string): Journal {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return bad();
  const j = value as Record<string, unknown>;
  for (const key of Object.keys(j)) if (!KEYS.has(key)) return bad();
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
    j.evidenceRecorded !== undefined &&
    (j.evidenceRecorded !== true || phase !== "exited")
  )
    return bad();
  return j as unknown as Journal;
}

export class JournalStore {
  constructor(private readonly root: string) {}

  dir(jobId: string): string {
    return join(this.root, jobId);
  }
  logPath(jobId: string): string {
    return join(this.dir(jobId), "child.log");
  }
  private tokenPath(jobId: string): string {
    return join(this.dir(jobId), "bootstrap.token");
  }

  ensure(jobId: string): void {
    mkdirSync(this.dir(jobId), { recursive: true, mode: 0o700 });
    const info = statSync(this.dir(jobId));
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Journal directory must be private to this user");
  }

  read(jobId: string): Journal | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.dir(jobId), "journal.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new JournalCorrupt("Journal unreadable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Torn or tampered: never guess what happened physically.
      throw new JournalCorrupt("Journal corrupt");
    }
    return validateJournal(parsed, jobId);
  }

  write(journal: Journal): void {
    validateJournal(journal, journal.jobId); // never persist a record we would later reject
    this.ensure(journal.jobId);
    atomicWrite(
      join(this.dir(journal.jobId), "journal.json"),
      JSON.stringify(journal),
    );
  }

  saveToken(jobId: string, token: string): void {
    this.ensure(jobId);
    atomicWrite(this.tokenPath(jobId), token);
  }
  loadToken(jobId: string): string | undefined {
    try {
      return readFileSync(this.tokenPath(jobId), "utf8");
    } catch {
      return undefined;
    }
  }
  discardToken(jobId: string): void {
    rmSync(this.tokenPath(jobId), { force: true });
  }
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
  const dirFd = openSync(join(path, ".."), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}
