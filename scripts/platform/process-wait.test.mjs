import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { waitForGroupExit } from "./process-wait.mjs";

const leader = (code) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", code], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.on("error", reject);
    // The child prints a line once its signal handler is installed.
    child.stdout.once("data", () => resolve(child));
  });

// Live (non-zombie) members of a process group, independent of the code under test.
// A child-subreaper parent (the local-ci runner) keeps killed orphans as zombies, so
// kill(-pgid, 0) cannot be used to prove a group is gone.
const liveMembers = (pgid) =>
  execFileSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([group, state]) => Number(group) === pgid && !state.startsWith("Z"),
    );

const exited = async (child) => {
  if (child.exitCode === null && child.signalCode === null)
    await once(child, "exit");
};

test("returns once a SIGTERM-able group, including a worker, is gone", async () => {
  const child = await leader(
    "const {spawn}=require('node:child_process');" +
      "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
      "process.on('SIGTERM',()=>process.exit(0));console.log('ready');setInterval(()=>{},1000)",
  );
  process.kill(-child.pid, "SIGTERM");
  assert.equal(await waitForGroupExit(child.pid), "SIGTERM");
  await exited(child); // our own zombie leader is reaped once its exit event fires
  assert.deepEqual(liveMembers(child.pid), []);
});

test("escalates to SIGKILL when the group ignores SIGTERM", async () => {
  const child = await leader(
    "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)",
  );
  process.kill(-child.pid, "SIGTERM");
  assert.equal(await waitForGroupExit(child.pid, { termMs: 300 }), "SIGKILL");
  await exited(child); // our own zombie leader is reaped once its exit event fires
  assert.deepEqual(liveMembers(child.pid), []);
});

test("an already-gone group returns immediately", async () => {
  const child = await leader("console.log('ready');process.exit(0)");
  await exited(child);
  assert.equal(await waitForGroupExit(child.pid), "SIGTERM");
});

test("a group whose only members are unreaped zombies counts as gone", async () => {
  // The parent (like the local-ci runner, a child subreaper) kills the group's only
  // member but does not wait for it, so it stays a zombie: kill(-pgid, 0) still
  // succeeds, yet nothing in the group is running.
  const parent = spawn(
    "python3",
    [
      "-c",
      "import os,signal,subprocess,sys,time;" +
        "p=subprocess.Popen(['sleep','60'],start_new_session=True);" +
        "os.kill(p.pid,signal.SIGKILL);" +
        "time.sleep(0.2);print(p.pid,flush=True);sys.stdin.read()",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  try {
    const pgid = await new Promise((resolve, reject) => {
      parent.on("error", reject);
      parent.stdout.once("data", (chunk) => resolve(Number(chunk.toString())));
    });
    process.kill(-pgid, 0); // the zombie keeps the group visible to a signal probe
    assert.equal(await waitForGroupExit(pgid, { termMs: 2000 }), "SIGTERM");
  } finally {
    parent.stdin.end();
    await new Promise((resolve) => parent.once("exit", resolve));
  }
});
