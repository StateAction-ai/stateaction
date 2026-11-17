import { readdirSync, readFileSync } from "node:fs";

/** Linux /proc facts used to prove a local child's identity and that its whole group is gone. */
export type ProcStat = {
  pid: number;
  state: string;
  ppid: number;
  pgrp: number;
  session: number;
  startTicks: string;
};

/** A /proc fact could not be read for a reason other than "the process does not exist". */
export class ProcUnavailable extends Error {}

export function bootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

export function readStat(pid: number): ProcStat | undefined {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    // ENOENT/ESRCH: the process is gone. Permission or I/O errors prove nothing.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw new ProcUnavailable(`stat unreadable: ${code ?? "unknown"}`);
  }
  // comm may contain spaces and parentheses: split after the LAST ')'.
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new ProcUnavailable("stat malformed");
  const f = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // f[0]=state f[1]=ppid f[2]=pgrp f[3]=session ... f[19]=starttime
  if (f.length < 20) throw new ProcUnavailable("stat malformed");
  return {
    pid,
    state: f[0]!,
    ppid: Number(f[1]),
    pgrp: Number(f[2]),
    session: Number(f[3]),
    startTicks: f[19]!,
  };
}

/** Live (non-zombie) processes in the group or session. Zombies already exited. */
export function liveMembers(pgid: number, sid: number): ProcStat[] {
  const members: ProcStat[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    throw new ProcUnavailable("/proc unreadable");
  }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    const stat = readStat(Number(name));
    if (!stat || stat.state === "Z" || stat.state === "X") continue;
    if (stat.pgrp === pgid || stat.session === sid) members.push(stat);
  }
  return members;
}

export function cmdlineHas(pid: number, needle: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .includes(needle);
  } catch {
    return false;
  }
}
