import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const module = fileURLToPath(new URL("./free-port.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "free-port-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.STATEACTION_PORT_CLAIM_DIR = dir;
const env = { ...process.env };

// Each child allocates ports, prints them, then waits for a line on stdin so all
// workers hold their claims at the same time.
const childScript = `
import(${JSON.stringify(module)}).then(async ({ freePort }) => {
  const ports = [];
  for (let i = 0; i < 25; i++) ports.push(await freePort());
  console.log(JSON.stringify(ports));
  process.stdin.once("data", () => process.exit(0));
});`;

function worker() {
  const child = spawn(process.execPath, ["-e", childScript], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const ports = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", () => {
      if (out.endsWith("\n")) resolve(JSON.parse(out));
    });
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { child, ports, exited };
}

test("concurrent workers never receive the same port", async () => {
  const workers = Array.from({ length: 6 }, worker);
  const all = (await Promise.all(workers.map((w) => w.ports))).flat();
  assert.equal(all.length, 150);
  assert.equal(new Set(all).size, 150, "every allocated port is distinct");
  assert.deepEqual(
    readdirSync(dir)
      .map(Number)
      .sort((a, b) => a - b),
    [...all].sort((a, b) => a - b),
    "one claim file per live port",
  );
  for (const w of workers) w.child.stdin.end("go\n");
  await Promise.all(workers.map((w) => w.exited));
  assert.deepEqual(
    readdirSync(dir),
    [],
    "claims are released on a normal exit",
  );
});

test("a claim left by a killed worker is reclaimed", async () => {
  const { claimPort } = await import(module + "?dead");
  const w = worker();
  const [port] = await w.ports;
  w.child.kill("SIGKILL");
  await w.exited;
  assert.ok(readdirSync(dir).includes(String(port)), "kill leaves the claim");
  assert.equal(claimPort(port), true, "a dead owner's claim is taken over");
  rmSync(join(dir, String(port)), { force: true });
});

test("a live owner's claim is refused", async () => {
  const { claimPort } = await import(module + "?live");
  writeFileSync(join(dir, "1"), String(process.ppid), { mode: 0o600 });
  assert.equal(claimPort(1), false);
  rmSync(join(dir, "1"), { force: true });
});

// Mutual exclusion on ONE contended port: four processes loop claim/release on the
// same port; while a process holds the claim it owns an exclusive "holder" file,
// so a second simultaneous holder (or any throw) is detected.
const contendScript = `
import(${JSON.stringify(module)}).then(({ claimPort, releasePort }) => {
  const fs = require("node:fs");
  const port = 54999, holder = process.env.HOLDER_FILE;
  let won = 0, violations = 0;
  for (let i = 0; i < 400; i++) {
    if (!claimPort(port)) continue;
    won++;
    try { fs.writeFileSync(holder, String(process.pid), { flag: "wx" }); }
    catch { violations++; }
    fs.rmSync(holder, { force: true });
    releasePort(port);
  }
  console.log(JSON.stringify({ won, violations }));
});`;

test("a contended port has at most one holder at a time and claiming never throws", async () => {
  const holder = join(dir, "holder");
  const children = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ["-e", contendScript], {
      env: { ...env, HOLDER_FILE: holder },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve(JSON.parse(out))
          : reject(new Error(`exit ${code}`)),
      );
    });
  });
  const results = await Promise.all(children);
  assert.deepEqual(
    results.map((r) => r.violations),
    [0, 0, 0, 0],
  );
  assert.ok(results.reduce((n, r) => n + r.won, 0) > 0, "someone held it");
  assert.equal(existsSync(join(dir, "54999")), false, "released");
});

test("allocated ports lie below the kernel's ephemeral range when one exists", async () => {
  const { freePort } = await import(module + "?range");
  const range = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8");
  const start = Number(range.trim().split(/\s+/)[0]);
  for (let i = 0; i < 20; i++) assert.ok((await freePort()) < start);
});
