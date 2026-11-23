// SA-114: an exiting child loses its command line (address space released) a moment BEFORE
// the kernel marks it a zombie. A single read in that window saw a live process with an
// unreadable identity and answered "leader_identity_unconfirmed" (needs_operator) instead of
// "gone". inspect() now re-checks a fixed number of times over a constant short window.
// The /proc reads are injected here, so every interleaving is deterministic.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Journal } from "../src/journal.js";
import {
  RECHECKS,
  RECHECK_MS,
  inspect,
  type ProcProbe,
} from "../src/local-process.js";
import { ProcUnavailable, bootId, type ProcStat } from "../src/proc.js";

const PID = 4_000_001;
const REF = "local-race";
const stat = (state: string, startTicks = "100"): ProcStat => ({
  pid: PID,
  state,
  ppid: 1,
  pgrp: PID,
  session: PID,
  startTicks,
});
const journal = (extra: Partial<Journal> = {}): Journal => ({
  version: 1,
  jobId: "00000000-0000-4000-8000-000000000001",
  runRef: "run",
  executionRef: REF,
  phase: "running",
  bootId: bootId(),
  startDeadline: new Date(Date.now() + 60_000).toISOString(),
  executionDeadline: new Date(Date.now() + 60_000).toISOString(),
  pid: PID,
  pgid: PID,
  sid: PID,
  startTicks: "100",
  singleProcess: true,
  ...extra,
});
/** Scripted /proc: stats are consumed in order (the last repeats); cmdline answers likewise. */
function probe(
  stats: (ProcStat | undefined | "unavailable")[],
  cmdline: boolean[] = [false],
) {
  const calls = { stat: 0, cmdline: 0, pauses: [] as number[] };
  const p: ProcProbe = {
    readStat: () => {
      const v = stats[Math.min(calls.stat++, stats.length - 1)];
      if (v === "unavailable")
        throw new ProcUnavailable("stat unreadable: EIO");
      return v;
    },
    cmdlineHas: () => cmdline[Math.min(calls.cmdline++, cmdline.length - 1)]!,
    pause: (ms) => calls.pauses.push(ms),
  };
  return { p, calls };
}

describe("inspect() while the child is exiting", () => {
  test("live with an unreadable command line, then gone: the child exited", () => {
    const { p, calls } = probe([stat("S"), stat("S"), stat("S"), undefined]);
    assert.deepEqual(inspect(journal(), undefined, p), { kind: "gone" });
    assert.deepEqual(calls.pauses, [RECHECK_MS, RECHECK_MS]);
  });

  test("live with an unreadable command line, then a zombie: the child exited", () => {
    const { p } = probe([stat("S"), stat("Z")]);
    assert.deepEqual(inspect(journal(), undefined, p), { kind: "gone" });
  });

  test("the identity becomes readable again: still alive", () => {
    const leader = stat("S");
    const { p } = probe([stat("S"), leader], [false, true]);
    assert.deepEqual(inspect(journal(), undefined, p), {
      kind: "alive",
      leader,
    });
  });

  test("still live and unreadable after every re-check stays ambiguous (never gone) in a bounded number of reads", () => {
    const { p, calls } = probe([stat("S")]);
    assert.deepEqual(inspect(journal(), undefined, p), {
      kind: "unknown",
      reason: "leader_identity_unconfirmed",
    });
    assert.equal(calls.stat, 1 + RECHECKS + 1);
    assert.deepEqual(calls.pauses, Array(RECHECKS).fill(RECHECK_MS));
  });

  test("a different process with the same pid during the re-check is never declared gone", () => {
    const { p } = probe([stat("S"), stat("S", "999")]);
    assert.deepEqual(inspect(journal(), undefined, p), {
      kind: "unknown",
      reason: "leader_identity_changed",
    });
  });

  test("unreadable /proc facts during the re-check are never interpreted as gone", () => {
    const { p } = probe([stat("S"), "unavailable"]);
    assert.deepEqual(inspect(journal(), undefined, p), {
      kind: "unknown",
      reason: "proc_unavailable",
    });
  });

  test("a child that is not proven single-process is never declared gone from a /proc miss", () => {
    const { p } = probe([stat("S"), undefined]);
    assert.deepEqual(
      inspect(journal({ singleProcess: undefined }), undefined, p),
      { kind: "unknown", reason: "execution_isolation_unproven" },
    );
  });

  test("a live process whose command line names the child needs no re-check", () => {
    const { p, calls } = probe([stat("S")], [true]);
    assert.equal(inspect(journal(), undefined, p).kind, "alive");
    assert.deepEqual(calls.pauses, []);
  });
});
