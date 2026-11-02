import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { ControllerSettings } from "./config.js";
import type { Journal, JournalStore } from "./journal.js";
import {
  bootId,
  liveMembers,
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
  pipeline: ControllerSettings["pipeline"];
  fixtureHoldSeconds?: number;
};

export type Exit = { code: number | null; signal: string | null };

/** What the journal's recorded identity says about the physical child right now. */
export type Inspection =
  | { kind: "alive"; leader: ProcStat; members: ProcStat[] }
  /** The leader is gone and no process remains in its group/session. */
  | { kind: "gone_group_empty" }
  /** Identity cannot be proven (other boot, no start ticks, leader gone but strangers remain). */
  | { kind: "unknown"; reason: string };

const ticks = (value: string) => BigInt(value);

export function inspect(journal: Journal): Inspection {
  try {
    return inspectUnchecked(journal);
  } catch (error) {
    if (error instanceof ProcUnavailable)
      // Unavailable facts are never interpreted as "gone".
      return { kind: "unknown", reason: "proc_unavailable" };
    throw error;
  }
}

function inspectUnchecked(journal: Journal): Inspection {
  if (journal.bootId !== bootId())
    return { kind: "unknown", reason: "boot_changed" };
  if (
    journal.pid === undefined ||
    journal.pgid === undefined ||
    journal.sid === undefined
  )
    return { kind: "unknown", reason: "no_identity" };
  const leader = readStat(journal.pid);
  const members = liveMembers(journal.pgid, journal.sid);
  if (journal.startTicks === undefined) {
    // The child exited before its identity could be read; only an empty group proves it is gone.
    return members.length === 0
      ? { kind: "gone_group_empty" }
      : { kind: "unknown", reason: "identity_unread_members_remain" };
  }
  const sameLeader =
    leader !== undefined &&
    leader.state !== "Z" &&
    leader.startTicks === journal.startTicks;
  if (sameLeader) return { kind: "alive", leader, members };
  // Leader exited (or the PID was recycled). Members of the exact old session that started after
  // the leader are still ours; anything else makes the picture ambiguous.
  const ours = members.filter(
    (m) =>
      m.session === journal.sid &&
      ticks(m.startTicks) >= ticks(journal.startTicks!),
  );
  if (members.length === 0) return { kind: "gone_group_empty" };
  if (ours.length === members.length)
    return { kind: "alive", leader: ours[0]!, members: ours };
  return { kind: "unknown", reason: "foreign_members_in_group" };
}

/** SIGKILL exactly the verified members (never a bare recycled PID or an unverified group). */
export function killVerified(journal: Journal): number {
  const state = inspect(journal);
  if (state.kind !== "alive") return 0;
  let killed = 0;
  for (const member of state.members) {
    // Re-read immediately before signalling to narrow the recycle window.
    let again: ProcStat | undefined;
    try {
      again = readStat(member.pid);
    } catch {
      continue; // cannot verify: do not signal
    }
    if (again?.startTicks !== member.startTicks) continue;
    try {
      process.kill(member.pid, "SIGKILL");
      killed++;
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/** Poll until the whole child group/session is provably empty, or give up (caller keeps it unknown). */
export async function awaitGroupEmpty(
  journal: Journal,
  graceMs: number,
  pollMs: number,
): Promise<boolean> {
  const until = Date.now() + graceMs;
  for (;;) {
    const state = inspect(journal);
    if (state.kind === "gone_group_empty") return true;
    if (state.kind === "alive") killVerified(journal);
    else return false; // unknown stays unknown
    if (Date.now() >= until) return false;
    await sleep(Math.min(pollMs, 50));
  }
}

export type Spawned = { journal: Journal; exited: Promise<Exit> };

/**
 * Spawn the shared Python CLI as a detached session leader. The journal phase
 * `spawning` has ALREADY been written by the caller. stdout/stderr go to a
 * 0600 file so the child survives controller loss; the bootstrap goes only
 * through the stdin pipe.
 */
export function spawnChild(
  settings: ControllerSettings,
  store: JournalStore,
  journal: Journal,
  bootstrap: Bootstrap,
): Spawned {
  const log = openSync(store.logPath(journal.jobId), "a", 0o600);
  const child = spawn(
    settings.python,
    [
      "-m",
      "stateaction_processing",
      "run-job",
      "--execution-ref",
      journal.executionRef,
    ],
    {
      shell: false,
      detached: true,
      stdio: ["pipe", log, log],
      // No inherited provider, database, storage or controller credentials.
      env: {
        PATH: process.env.PATH ?? "",
        PYTHONNOUSERSITE: "1",
        PYTHONUNBUFFERED: "1",
        APP_ENV: process.env.APP_ENV ?? "",
        WORKER_PIPELINE: settings.pipeline,
      },
    },
  );
  closeSync(log);
  if (child.pid === undefined) throw new Error("Local child failed to start");
  const pid = child.pid;
  const exited = new Promise<Exit>((resolve) => {
    child.once("error", () => resolve({ code: null, signal: "spawn_error" }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const stdin = child.stdin;
  if (!stdin) throw new Error("Local child has no stdin pipe");
  stdin.on("error", () => undefined);
  stdin.end(JSON.stringify(bootstrap));
  let stat: ProcStat | undefined;
  try {
    stat = readStat(pid);
  } catch {
    stat = undefined; // identity left unread: only an empty group can later prove exit
  }
  const running: Journal = {
    ...journal,
    phase: "running",
    pid,
    // detached => setsid before exec: the child is its own session and group leader.
    pgid: pid,
    sid: pid,
    ...(stat ? { startTicks: stat.startTicks } : {}),
  };
  return { journal: running, exited };
}
