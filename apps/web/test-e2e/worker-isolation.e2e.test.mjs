// SA-114: parallel e2e workers must never share a database, role, bucket or
// port, and every one of them must be reaped after a normal run and after a
// killed run. Three real worker processes allocate through the same helpers the
// e2e worlds use, each with its own run directory and ledger.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  FixtureSession,
  createRunDir,
  resolveFixtures,
} from "../../../scripts/platform/local-fixtures.mjs";

const CLI = fileURLToPath(
  new URL("../../../scripts/platform/local-fixtures.mjs", import.meta.url),
);
const WORKER = fileURLToPath(
  new URL("./isolation-worker.mjs", import.meta.url),
);
// Private claim directory: the workers and this test must not share port claims
// with concurrently running e2e files that allocate from the same helper.
const claimDir = mkdtempSync(join(tmpdir(), "iso-port-claims-"));
process.env.STATEACTION_PORT_CLAIM_DIR = claimDir;
const { claimPort } = await import("../../../scripts/platform/free-port.mjs");
const KINDS = ["database", "role", "bucket"];
const workers = [];
let admin;
let probeDir;

function startWorker() {
  const { dir } = createRunDir({ purpose: "iso" });
  const values = resolveFixtures(process.env);
  const session = new FixtureSession({ values, dir });
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, STATEACTION_FIXTURE_RUN_DIR: dir },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise((resolve, reject) => {
    let out = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.endsWith("\n")) resolve(JSON.parse(out));
    });
    exited.then(() => reject(new Error(`worker exited early: ${out}`)));
  });
  const worker = { dir, session, child, exited, ready };
  workers.push(worker);
  return worker;
}

const live = (w) =>
  Object.fromEntries(
    KINDS.map((k) => [
      k,
      w.session
        .live(k)
        .map((e) => e.name)
        .sort(),
    ]),
  );

async function present(w) {
  const dbs = (
    await admin.query(
      "SELECT datname FROM pg_database WHERE datname = ANY($1)",
      [live(w).database],
    )
  ).rows.map((r) => r.datname);
  const roles = (
    await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [
      live(w).role,
    ])
  ).rows.map((r) => r.rolname);
  const s3 = w.session.drivers.s3();
  const buckets = [];
  try {
    for (const name of live(w).bucket) {
      try {
        await s3.listObjects(name);
        buckets.push(name);
      } catch (error) {
        if (!/NoSuchBucket|NotFound/.test(String(error?.name ?? error)))
          throw error;
      }
    }
  } finally {
    s3.close?.();
  }
  return {
    database: dbs.sort(),
    role: roles.sort(),
    bucket: buckets.sort(),
  };
}

before(async () => {
  assert.ok(
    process.env.STATEACTION_LOCAL_FIXTURES,
    "bounded external fixtures are required; Docker is never used",
  );
  probeDir = createRunDir({ purpose: "iso" }).dir;
  const probe = new FixtureSession({
    values: resolveFixtures(process.env),
    dir: probeDir,
  });
  admin = await probe.admin();
});

after(async () => {
  for (const w of workers) {
    if (w.child.exitCode === null && w.child.signalCode === null)
      w.child.kill("SIGKILL");
    await w.exited;
    // Backstop only: the cases below already assert exact reaping.
    spawnSync(process.execPath, [CLI, "reap", w.dir], { env: process.env });
    rmSync(w.dir, { recursive: true, force: true });
  }
  await admin?.end();
  if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  rmSync(claimDir, { recursive: true, force: true });
});

test("parallel workers get distinct databases, roles, buckets and ports, and all are reaped after a normal and after a killed run", async () => {
  const [a, b, killed] = [startWorker(), startWorker(), startWorker()];
  const reports = await Promise.all(workers.map((w) => w.ready));

  // Distinct per worker: ports, and every resource name (names embed the run id).
  assert.equal(new Set(reports.map((r) => r.port)).size, 3, "ports");
  const ledgers = workers.map(live);
  for (const kind of KINDS) {
    const names = ledgers.flatMap((l) => l[kind]);
    assert.equal(
      names.length,
      new Set(names).size,
      `${kind} names are distinct`,
    );
  }
  assert.deepEqual(
    ledgers.map((l) => [l.database.length, l.role.length, l.bucket.length]),
    [
      [2, 1, 1],
      [2, 1, 1],
      [2, 1, 1],
    ],
    "each worker owns two databases, one role and one bucket",
  );
  assert.equal(
    new Set(workers.map((w) => w.session.runId)).size,
    3,
    "one run id per worker",
  );
  for (const w of workers)
    assert.deepEqual(
      await present(w),
      live(w),
      "everything exists while running",
    );

  // Normal run: the worker removes exactly its own resources.
  for (const w of [a, b]) {
    const before = live(w);
    w.child.stdin.write("stop\n");
    assert.deepEqual(await w.exited, { code: 0, signal: null });
    assert.deepEqual(live(w), { database: [], role: [], bucket: [] });
    assert.deepEqual(await present({ ...w, session: fixed(w, before) }), {
      database: [],
      role: [],
      bucket: [],
    });
  }
  // The other worker is untouched by its neighbours' cleanup.
  assert.deepEqual(await present(killed), live(killed));

  // Killed run: SIGKILL leaves the resources and a dead port claim; the exact
  // ledger reap removes them, and the port can be claimed again.
  const leftover = live(killed);
  killed.child.kill("SIGKILL");
  assert.deepEqual(await killed.exited, { code: null, signal: "SIGKILL" });
  assert.deepEqual(await present(killed), leftover, "kill leaves them behind");
  const reap = spawnSync(process.execPath, [CLI, "reap", killed.dir], {
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(reap.status, 0, reap.stderr);
  assert.deepEqual(
    reap.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(" ").slice(0, 3).join(" "))
      .sort(),
    KINDS.flatMap((kind) =>
      leftover[kind].map((name) => `${kind} ${name} removed`),
    ).sort(),
    "reap removed exactly the ledgered resources",
  );
  assert.equal(
    existsSync(killed.dir),
    false,
    "a fully reaped run dir is removed",
  );
  assert.deepEqual(
    await present({ ...killed, session: fixed(killed, leftover) }),
    { database: [], role: [], bucket: [] },
  );
  assert.equal(
    claimPort(reports[2].port),
    true,
    "a killed worker's port claim is reclaimable",
  );
});

// `live()` is empty after reaping, so presence checks of removed resources use
// the names recorded before the stop.
function fixed(w, names) {
  return {
    drivers: w.session.drivers,
    live: (kind) => names[kind].map((name) => ({ name })),
  };
}
