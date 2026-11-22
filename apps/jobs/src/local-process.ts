import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
} from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { LocalControllerSettings } from "./config.js";
import type { Journal, JournalStore } from "./journal.js";
import type { HandPoseBootstrap, StageBootstrap } from "./modal-executor.js";
import {
  bootId,
  cmdlineHas,
  ProcUnavailable,
  readStat,
  type ProcStat,
} from "./proc.js";

/** Private bootstrap: stdin only. Never argv, environment or logs. No taskInput (signed reads come from the claim). */
export type Bootstrap = {
  schemaVersion: 1;
  apiUrl: string;
  jobId: string;
  bootstrapToken: string;
  executionRef: string;
  pipeline: LocalControllerSettings["pipeline"];
  fixtureHoldSeconds?: number;
};

export type Exit = { code: number | null; signal: string | null };

/** What the journal's recorded identity says about the physical child right now. */
export type Inspection =
  | { kind: "alive"; leader: ProcStat }
  | { kind: "gone" }
  | { kind: "unknown"; reason: string };

export function inspect(journal: Journal, python?: string): Inspection {
  try {
    return inspectUnchecked(journal, python);
  } catch (error) {
    if (error instanceof ProcUnavailable)
      // Unavailable facts are never interpreted as "gone".
      return { kind: "unknown", reason: "proc_unavailable" };
    throw error;
  }
}

function inspectUnchecked(journal: Journal, python?: string): Inspection {
  if (journal.bootId !== bootId())
    return { kind: "unknown", reason: "boot_changed" };
  if (
    journal.pid === undefined ||
    journal.pgid === undefined ||
    journal.sid === undefined
  )
    return { kind: "unknown", reason: "no_identity" };
  if (journal.startTicks === undefined)
    return { kind: "unknown", reason: "leader_identity_unconfirmed" };
  const leader = readStat(journal.pid);
  if (leader && !matchesJournal(leader, journal))
    return { kind: "unknown", reason: "leader_identity_changed" };
  if (journal.pidNamespace) {
    if (
      leader &&
      isLive(leader) &&
      cmdlineHas(leader.pid, journal.executionRef)
    )
      return { kind: "alive", leader };
    if (!python) return { kind: "unknown", reason: "worker_exit_unproven" };
    const result = spawnSync(
      python,
      ["-m", "stateaction_processing.local_signal", "--status"],
      {
        input: JSON.stringify({
          bootId: journal.bootId,
          pidNamespace: journal.pidNamespace,
          leader: {
            pid: journal.pid,
            pgrp: journal.pgid,
            session: journal.sid,
            startTicks: journal.startTicks,
          },
        }),
        timeout: 1000,
        killSignal: "SIGKILL",
        stdio: ["pipe", "ignore", "ignore"],
        env: { PATH: process.env.PATH ?? "", PYTHONNOUSERSITE: "1" },
      },
    );
    if (result.status === 0) return { kind: "gone" };
    if (result.status === 1 && leader) return { kind: "alive", leader };
    return { kind: "unknown", reason: "worker_exit_unproven" };
  }
  if (isLive(leader)) {
    if (cmdlineHas(leader.pid, journal.executionRef))
      return { kind: "alive", leader };
    const after = readStat(journal.pid);
    if (after && !matchesJournal(after, journal))
      return { kind: "unknown", reason: "leader_identity_changed" };
    if (isLive(after))
      return { kind: "unknown", reason: "leader_identity_unconfirmed" };
  }
  // A /proc scan can miss descendants that fork as the scan progresses.
  return journal.singleProcess
    ? { kind: "gone" }
    : { kind: "unknown", reason: "execution_isolation_unproven" };
}

function isLive(stat: ProcStat | undefined): stat is ProcStat {
  return stat !== undefined && stat.state !== "Z" && stat.state !== "X";
}

function matchesJournal(stat: ProcStat, journal: Journal): boolean {
  return (
    stat.startTicks === journal.startTicks &&
    stat.pgrp === journal.pgid &&
    stat.session === journal.sid
  );
}

/** Signal only through a pidfd opened and corroborated by the bounded helper. */
function killVerified(
  python: string,
  journal: Journal,
  state: Extract<Inspection, { kind: "alive" }>,
  leaseUntil: number,
): boolean {
  const timeout = Math.min(1000, leaseUntil - Date.now());
  if (timeout <= 0) return false;
  const result = spawnSync(
    python,
    ["-m", "stateaction_processing.local_signal"],
    {
      input: JSON.stringify({
        bootId: journal.bootId,
        executionRef: journal.executionRef,
        leader: state.leader,
        pidNamespace: journal.pidNamespace,
        leaseUntil,
      }),
      timeout,
      killSignal: "SIGKILL",
      stdio: ["pipe", "ignore", "ignore"],
      env: { PATH: process.env.PATH ?? "", PYTHONNOUSERSITE: "1" },
    },
  );
  return result.status === 0;
}

/** Terminate the verified child and poll for a proven exit. */
export async function awaitWorkerExit(
  python: string,
  journal: Journal,
  graceMs: number,
  pollMs: number,
  leaseDeadline: () => number | undefined,
): Promise<boolean> {
  const until = Date.now() + graceMs;
  for (;;) {
    const leaseUntil = leaseDeadline();
    if (leaseUntil === undefined) return false;
    const state = inspect(journal, python);
    if (state.kind === "gone") return true;
    if (state.kind !== "alive") return false;
    if (!killVerified(python, journal, state, Math.min(leaseUntil, until)))
      return inspect(journal, python).kind === "gone";
    if (Date.now() >= until) return false;
    await sleep(Math.min(pollMs, 50));
  }
}

export type Spawned = {
  journal: Journal;
  exited: Promise<Exit>;
  /** A recipe stage child gets the v2 stage bootstrap (SA-91). */
  provideBootstrap: (
    bootstrap?: Bootstrap | StageBootstrap | HandPoseBootstrap,
  ) => void;
};

function awaitIsolation(proof: Readable, marker: string): Promise<boolean> {
  return new Promise((resolve) => {
    function finish(confirmed: boolean) {
      clearTimeout(timer);
      proof.destroy();
      resolve(confirmed);
    }
    const timer = setTimeout(() => finish(false), 5000);
    proof.once("data", (data: Buffer) => finish(data.toString() === marker));
    proof.once("end", () => finish(false));
    proof.once("error", () => finish(false));
  });
}

/**
 * `threaded` (default for the production pipeline) needs the qualified host: Linux x86-64, a
 * loopback API and the agent-resource cgroup. SA-91 recipe stages always run threaded (their
 * worker heartbeats from a thread), whatever the fixture pipeline setting.
 */
export function supportsLocalPipeline(
  settings: LocalControllerSettings,
  threaded = settings.pipeline !== "local_fixture_noop",
): boolean {
  if (!threaded) return true;
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  try {
    return (
      ["127.0.0.1", "localhost", "[::1]"].includes(
        new URL(settings.apiUrl).hostname,
      ) &&
      readFileSync("/proc/self/cgroup", "utf8").includes(
        "/agent-work.slice/",
      ) &&
      readlinkSync("/proc/self") === String(process.pid)
    );
  } catch {
    return false;
  }
}

/**
 * Spawn the shared Python CLI as a detached session leader. The journal phase
 * `spawning` has ALREADY been written by the caller. stdout/stderr go to a
 * 0600 file so the child survives controller loss; the bootstrap goes only
 * through the stdin pipe.
 */
export async function spawnChild(
  settings: LocalControllerSettings,
  store: JournalStore,
  journal: Journal,
): Promise<Spawned> {
  // SA-91: a recipe stage runs the stage entrypoint, always with thread-group isolation.
  const stage = journal.stage;
  const fixture =
    stage === undefined && settings.pipeline === "local_fixture_noop";
  const pidNamespace = fixture ? undefined : readlinkSync("/proc/self/ns/pid");
  const log = openSync(store.logPath(journal.jobId, stage), "a", 0o600);
  const replayDir = process.env.STATEACTION_REPLAY_DIR;
  const child = spawn(
    settings.python,
    // The sealing hand_pose stage is the `run-job` worker (SA-92) under its stage claim;
    // segment and caption run the stage entrypoint.
    stage === undefined || stage === "hand_pose"
      ? [
          "-m",
          "stateaction_processing",
          "run-job",
          "--execution-ref",
          journal.executionRef,
        ]
      : ["-m", "stateaction_processing", "run-stage", journal.executionRef],
    {
      shell: false,
      detached: true,
      stdio: ["pipe", log, log, "pipe"],
      // No inherited provider, database, storage or controller credentials.
      env: {
        PATH: process.env.PATH ?? "",
        PYTHONNOUSERSITE: "1",
        PYTHONUNBUFFERED: "1",
        APP_ENV: process.env.APP_ENV ?? "",
        WORKER_PIPELINE:
          stage === "hand_pose" ? "hand_pose_cpu_v1" : settings.pipeline,
        // Replay modules read cached results from this directory (local only, no credential).
        ...(stage !== undefined && replayDir
          ? { STATEACTION_REPLAY_DIR: replayDir }
          : {}),
        ...(fixture
          ? { STATEACTION_FIXTURE_ISOLATION_FD: "3" }
          : { STATEACTION_THREADED_ISOLATION_FD: "3" }),
      },
    },
  );
  const exited = new Promise<Exit>((resolve) => {
    child.once("error", () => resolve({ code: null, signal: "spawn_error" }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  closeSync(log);
  if (child.pid === undefined) throw new Error("Local child failed to start");
  const pid = child.pid;
  const stdin = child.stdin;
  if (!stdin) throw new Error("Local child has no stdin pipe");
  stdin.on("error", () => undefined);
  const proof = child.stdio[3] as Readable | null;
  if (!proof || !(await awaitIsolation(proof, fixture ? "1" : "2"))) {
    stdin.end();
    throw new Error("Local worker isolation was not confirmed");
  }
  let stat: ProcStat | undefined;
  try {
    const before = readStat(pid);
    if (
      isLive(before) &&
      before.ppid === process.pid &&
      before.pgrp === pid &&
      before.session === pid &&
      cmdlineHas(pid, journal.executionRef)
    ) {
      const after = readStat(pid);
      if (
        isLive(after) &&
        after.ppid === before.ppid &&
        after.pgrp === before.pgrp &&
        after.session === before.session &&
        after.startTicks === before.startTicks
      )
        stat = after;
    }
  } catch {
    // Withhold both the bootstrap and proof if the process cannot be identified.
  }
  const running: Journal = {
    ...journal,
    phase: "running",
    pid,
    // detached => setsid before exec: the child is its own session and group leader.
    pgid: pid,
    sid: pid,
    ...(stat ? { startTicks: stat.startTicks } : {}),
    ...(stat && fixture ? { singleProcess: true } : {}),
    ...(stat && pidNamespace ? { pidNamespace } : {}),
  };
  return {
    journal: running,
    exited,
    provideBootstrap: (bootstrap) =>
      stdin.end(stat && bootstrap ? JSON.stringify(bootstrap) : undefined),
  };
}

/** The stage entrypoint prints its receipt as the last stdout line; bounded tail read. */
const RECEIPT_TAIL_BYTES = 128 * 1024;

/**
 * SA-91: the last receipt-shaped JSON line a stage child wrote to its 0600 log (an object with
 * `schemaVersion`, `jobId`, `stage` and `status`), or undefined. Later non-receipt lines (the run-job `sa_metrics` probe,
 * stderr) are skipped. The caller validates it as a stage receipt; none is "no receipt".
 */
export function lastLogLine(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, RECEIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let value: unknown;
      try {
        value = JSON.parse(lines[i]!);
      } catch {
        continue;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "schemaVersion" in value &&
        "jobId" in value &&
        "stage" in value &&
        "status" in value
      )
        return value;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
