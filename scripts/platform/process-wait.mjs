// Wait for a detached process group (a `next start` leader and its workers) to be
// gone instead of sleeping a fixed time after SIGTERM. A group is gone when no live
// (non-zombie) process has it as its process group. Zombies do not count: under the
// local-ci runner (a child subreaper) an orphaned worker stays a zombie until the
// runner reaps it, and kill(-pgid, 0) would report such a group as alive. If the group
// outlives `termMs` it is SIGKILLed, and the wait throws if it still outlives `killMs`
// (a leaked process must not pass).
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// Live members of process group `pgid`, from /proc (field 3 is the state, 5 the pgrp).
function liveMembers(pgid) {
  let names;
  try {
    names = readdirSync("/proc");
  } catch {
    return null;
  }
  const live = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid && fields[0] !== "Z")
        live.push(Number(name));
    } catch {} // the process exited while we looked
  }
  return live;
}

const alive = (pgid) => {
  const live = liveMembers(pgid);
  if (live) return live.length > 0;
  try {
    process.kill(-pgid, 0); // no /proc: fall back to the signal probe
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

export async function waitForGroupExit(
  pgid,
  { termMs = 10_000, killMs = 5_000, pollMs = 20 } = {},
) {
  for (const [signal, budget] of [
    [null, termMs],
    ["SIGKILL", killMs],
  ]) {
    if (signal) {
      try {
        process.kill(-pgid, signal);
      } catch {}
    }
    const deadline = Date.now() + budget;
    while (alive(pgid)) {
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    if (!alive(pgid)) return signal ?? "SIGTERM";
  }
  throw new Error(
    `process group ${pgid} did not exit after SIGTERM and SIGKILL`,
  );
}

// For `.catch(leaked)` at teardown: report the leak and fail the process, but let the
// remaining cleanup (databases, storage fixtures) run first.
export function leaked(error) {
  console.error(error.message);
  process.exitCode = 1;
}
