#!/usr/bin/env node
// SA-57 host driver for the emulator OS-scheduler qualification (NativeUploadOsQualificationTest).
//
// It starts a THROWAWAY real stack from a read-only runtime checkout (Postgres + restricted app role, Better Auth,
// the production Next build, SeaweedFS S3), creates a legitimate registration/reservation/plan with real
// throwaway Better Auth sessions, pushes an app-private 0600 scenario (session cookie; never printed) to the test
// package in the PERSONAL user (--user 0) of ONE explicitly named emulator, then runs the test phases serially
// with `am instrument`. It verifies receipts, provider bytes and the full-object SHA-256 itself.
//
//   node scripts/mobile/sa57_os_driver.mjs --runtime <checkout> --serial emulator-5582 --api 33 \
//        --test-apk <path> --scenario complete [--size-mib 150] [--out <dir>]
//
// Root owns the single VM: this script never starts/stops an emulator and refuses anything that is not exactly
// one named `emulator-NNNN` device in state `device`. It must run inside `agent-resource run --` (it spawns Next,
// Postgres/Docker and adb). It never mutates the runtime checkout and never prints cookies, passwords or URLs.
//
// Honest scope: emulator evidence for the real bridge/OS-job/API/S3 path only; not a physical device, reboot,
// Doze, Task-Manager-stop, R2 or cloud qualification. The published signed-URL TTL is 3600 s and is NOT waited
// out: the `expiry` scenario is an expiry-RESPONSE fault injection (one explicit 403 for a really issued URL), i.e.
// it proves the real re-sign + completion path, not provider TTL behaviour (a separately stated gate).
//
// Requires E2E_EXTERNAL_FIXTURES (loopback Postgres + S3 env file, see apps/web/test-e2e/fixtures.mjs) so that no
// Docker container can start outside the resource guard. Run the whole driver inside `agent-resource run --`.
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const TEST_CLASS = "open.fpvlabs.stera.upload.NativeUploadOsQualificationTest";
const RUNNER = "androidx.test.runner.AndroidJUnitRunner";
const MPU_PART = 64 * 1024 * 1024;
const exec = promisify(execFile);

// ---- pure helpers (unit-tested in sa57_os_driver.test.mjs) ---------------------------------------

export function parseArgs(argv) {
  const out = {
    api: "33",
    sizeMib: 150,
    scenario: "complete",
    timeoutMs: 240000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} needs a value`);
    const map = {
      runtime: "runtime",
      serial: "serial",
      api: "api",
      "test-apk": "testApk",
      scenario: "scenario",
      "size-mib": "sizeMib",
      out: "out",
      "timeout-ms": "timeoutMs",
      "fault-part": "faultPart",
    };
    if (!map[key]) throw new Error(`unknown option --${key}`);
    out[map[key]] = ["sizeMib", "timeoutMs", "faultPart"].includes(map[key])
      ? Number(val)
      : val;
  }
  for (const k of ["runtime", "serial", "testApk"])
    if (!out[k])
      throw new Error(`--${k === "testApk" ? "test-apk" : k} is required`);
  if (!/^emulator-\d{4,5}$/.test(out.serial))
    throw new Error(
      "--serial must be an explicit emulator-NNNN (never a physical device)",
    );
  if (!["33", "34", "35"].includes(String(out.api)))
    throw new Error("--api must be 33, 34 or 35");
  if (!Number.isFinite(out.sizeMib) || out.sizeMib < 1 || out.sizeMib > 400)
    throw new Error("--size-mib must be 1..400");
  if (!(out.scenario in SCENARIOS))
    throw new Error(
      `--scenario must be one of ${Object.keys(SCENARIOS).join(", ")}`,
    );
  out.faultPart ??= 2;
  if (!Number.isInteger(out.faultPart) || out.faultPart < 1)
    throw new Error("--fault-part must be a positive part number");
  return out;
}

/** `pm list users` -> [{id, flags}] */
export function parseUsers(text) {
  const users = [];
  for (const line of text.split("\n")) {
    const m = /UserInfo\{(\d+):[^:}]*:([0-9a-fA-F]+)\}/.exec(line);
    if (m)
      users.push({
        id: Number(m[1]),
        flags: parseInt(m[2], 16),
        line: line.trim(),
      });
  }
  return users;
}
const FLAG_FULL = 0x400;
const FLAG_PROFILE = 0x1000;
const FLAG_MANAGED = 0x20;
export const isFullUser = (u) =>
  (u.flags & FLAG_FULL) !== 0 && (u.flags & FLAG_PROFILE) === 0;
export const isProfile = (u) => (u.flags & (FLAG_PROFILE | FLAG_MANAGED)) !== 0;

/** Result of `am instrument -r`: pass only on status 0 for the single test; -4 (assumption) is a SKIP, never a pass. */
export function parseInstrument(text) {
  const codes = [...text.matchAll(/INSTRUMENTATION_STATUS_CODE: (-?\d+)/g)].map(
    (m) => Number(m[1]),
  );
  const result =
    /INSTRUMENTATION_RESULT: stream=[\s\S]*?(OK \((\d+) tests?\)|FAILURES!!!)/.exec(
      text,
    );
  const skipped =
    codes.includes(-4) ||
    (/Tests run:\s*\d+,\s*Failures: 0.*Skipped|ignored/i.test(text) &&
      codes.includes(-3));
  const failed =
    codes.includes(-1) ||
    codes.includes(-2) ||
    /FAILURES!!!/.test(text) ||
    /INSTRUMENTATION_FAILED/.test(text);
  if (failed)
    return {
      status: "failed",
      detail: firstLines(
        text,
        /(AssertionError|Exception|Failure|timed out)/,
        3,
      ),
    };
  if (skipped)
    return {
      status: "skipped",
      detail: "assumption not met (no scenario or API < 33)",
    };
  if (codes.includes(0) && result?.[2] === "1") return { status: "passed" };
  return { status: "unknown", detail: firstLines(text, /./, 3) };
}
const firstLines = (t, re, n) =>
  t
    .split("\n")
    .filter((l) => re.test(l))
    .slice(0, n)
    .join(" | ")
    .slice(0, 400);

export function sourcePlan(sizeMib, scenario) {
  const sizeBytes = Math.floor(sizeMib * 1024 * 1024);
  return {
    seed: `sa57-${scenario}-${randomUUID().slice(0, 8)}`,
    sizeBytes,
    parts: Math.ceil(sizeBytes / MPU_PART),
  };
}

// ---- scenarios: ordered phases; `host` steps run on the driver, others are instrument phases --------

const P = (phase, extra = {}) => ({ phase, ...extra });
export const SCENARIOS = {
  // Observe the OS after process death, then use visible Resume if needed.
  complete: [
    P("start", { startUntilLanded: 1, interruptAfterCheckpoint: true }),
    { host: "observeScheduler" },
    P("resumeToCompletion"),
    { host: "verifyUploaded" },
    P("finalReport"),
  ],
  // Charging is required but absent: nothing may transfer until it is provided.
  policy: [
    { host: "setCharging", on: false },
    P("start", {
      requireCharging: true,
      startUntilLanded: 0,
    }),
    P("expectState", { state: "queued|waiting_policy" }),
    { host: "verifyNoFurtherPuts", expectedParts: 0 },
    { host: "setCharging", on: true },
    P("resumeToCompletion"),
    { host: "verifyUploaded" },
  ],
  capture: [
    P("start", { startUntilLanded: 1, pauseAfterCheckpoint: true }),
    P("capturePauseRelease"),
    { host: "verifyUploaded" },
  ],
  logout: [
    P("start", { startUntilLanded: 1, logoutAfterCheckpoint: true }),
    { host: "verifyNoFurtherPuts", expectedParts: 1 },
    P("otherOwnerBinds"),
    P("finalReport"),
  ],
  // Expiry-response fault injection (NOT real TTL): the fault proxy answers one PUT of a really issued URL with an S3
  // "Request has expired" 403; native must renew through parts/sign and still complete with the right bytes.
  expiry: [
    P("start", { startUntilLanded: 1 }),
    P("resumeToCompletion"),
    { host: "verifyUploaded" },
    { host: "expectRenewal" },
  ],
};

// ---- adb (always an explicit serial and explicit --user 0 for app mutations) ------------------

class Adb {
  constructor(serial, log) {
    this.serial = serial;
    this.log = log;
  }
  run(args, opts = {}) {
    return execFileSync("adb", ["-s", this.serial, ...args], {
      encoding: "utf8",
      timeout: opts.timeout ?? 120000,
      input: opts.input,
      maxBuffer: 64 << 20,
    });
  }
  shell(cmd, opts) {
    return this.run(["shell", cmd], opts);
  }
  prop(name) {
    return this.shell(`getprop ${name}`).trim();
  }
}

function preflight(a, args) {
  const devices = execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c[0]);
  const emulators = devices.filter((d) => d[0].startsWith("emulator-"));
  if (emulators.length !== 1)
    throw new Error(
      `expected exactly one emulator row, found ${emulators.length} (ambiguous); refusing`,
    );
  const mine = devices.filter((d) => d[0] === args.serial);
  if (mine.length !== 1 || mine[0][1] !== "device")
    throw new Error(`${args.serial} is not exactly one online device`);
  if (!args.serial.startsWith("emulator-")) throw new Error("not an emulator");
  if (
    a.prop("ro.kernel.qemu") !== "1" &&
    !/sdk|emulator|ranchu/i.test(
      a.prop("ro.product.model") + a.prop("ro.hardware"),
    )
  )
    throw new Error("target is not an emulator");
  const api = a.prop("ro.build.version.sdk");
  if (api !== String(args.api))
    throw new Error(`device API ${api} != --api ${args.api}`);
  const users = parseUsers(a.shell("pm list users"));
  const u0 = users.find((u) => u.id === 0);
  if (!u0 || !isFullUser(u0))
    throw new Error("user 0 is not the personal full user; refusing to mutate");
  return {
    api,
    users,
    workIds: users.filter((u) => u.id !== 0 && isProfile(u)).map((u) => u.id),
  };
}

function apkFacts(apk) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk)
    throw new Error("ANDROID_HOME is required to read the merged manifest");
  const bt = join(sdk, "build-tools");
  const ver = readdirSync(bt).sort().pop();
  const aapt2 = join(bt, ver, "aapt2");
  const pkg = execFileSync(aapt2, ["dump", "packagename", apk], {
    encoding: "utf8",
  }).trim();
  const tree = execFileSync(
    aapt2,
    ["dump", "xmltree", "--file", "AndroidManifest.xml", apk],
    { encoding: "utf8" },
  );
  return { pkg, ...manifestFlags(tree) };
}

/** Reads `aapt2 dump xmltree` text (boolean attributes print as `=true`). */
export function manifestFlags(tree) {
  const metaOn = (key) =>
    new RegExp(
      `name\\(0x01010003\\)="${key.replace(/\./g, "\\.")}"[^\\n]*\\n\\s*A: [^\\n]*value\\(0x01010024\\)=true`,
    ).test(tree);
  return {
    enabled: metaOn("ai.stateaction.native_upload.enabled"),
    cleartext: metaOn("ai.stateaction.native_upload.allow_cleartext_loopback"),
    debuggable: /debuggable\(0x0101000f\)=true/.test(tree),
  };
}

function productionManifestIsOff() {
  const m = readFileSync(
    join(
      repoRoot,
      "packages/stera_recorder/android/src/main/AndroidManifest.xml",
    ),
    "utf8",
  );
  const off = (k) =>
    new RegExp(`${k.replace(/\./g, "\\.")}"[^>]*android:value="false"`).test(m);
  return (
    off("ai.stateaction.native_upload.enabled") &&
    off("ai.stateaction.native_upload.allow_cleartext_loopback")
  );
}

// ---- stack ----------------------------------------------------------------------------------------

/**
 * HTTP forwarding proxy in front of S3 with ONE bounded fault: the first PUT whose query names `partNumber=<faultPart>`
 * gets an S3 "Request has expired" 403 (after its body is drained so the client sees a clean response) instead of
 * being forwarded. Everything else is streamed with `pipe` (socket back-pressure, nothing buffered in RAM) and every
 * socket has a deadline. The Host header is preserved, so the presigned signature stays valid.
 */
function transferProxy(listenPort, getUpstream, faultPart, stats, getHold) {
  const server = createHttpServer(async (req, res) => {
    req.socket.setTimeout(180000, () => req.socket.destroy());
    const q = new URL(req.url, "http://x").searchParams;
    const held = getHold();
    if (req.method === "PUT") stats.puts++;
    if (held && req.method === "PUT" && Number(q.get("partNumber")) > 1) {
      await held;
      // The request crossed the old process boundary but never reached S3.
      // Drop it on transition. A new attempt can reach the provider.
      req.destroy();
      return;
    }
    if (
      req.method === "PUT" &&
      !stats.faulted &&
      q.get("partNumber") === String(faultPart)
    ) {
      stats.faulted = true;
      req.on("end", () => {
        res.writeHead(403, { "content-type": "application/xml" });
        res.end(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
        );
      });
      req.resume();
      return;
    }
    const up = httpRequest(
      {
        ...getUpstream(),
        method: req.method,
        path: req.url,
        headers: req.headers,
        timeout: 180000,
      },
      (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      },
    );
    up.on("timeout", () => up.destroy());
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => up.destroy());
    req.pipe(up);
  });
  server.requestTimeout = 600000;
  return new Promise((res) =>
    server.listen(listenPort, "127.0.0.1", () => res(server)),
  );
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(
    args.out ??
      join(
        repoRoot,
        "artifacts/emulator-verification/sa57",
        `${args.scenario}-api${args.api}-${Date.now()}`,
      ),
  );
  mkdirSync(out, { recursive: true });
  const evidence = {
    scenario: args.scenario,
    api: args.api,
    serial: args.serial,
    startedAt: new Date().toISOString(),
    phases: [],
    notes: [],
  };
  const flush = () =>
    writeFileSync(
      join(out, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
  const adb = new Adb(args.serial);
  const pre = preflight(adb, args);
  evidence.users = { personal: 0, workProfileIds: pre.workIds };
  if (!productionManifestIsOff())
    throw new Error(
      "production plugin manifest does not keep both native_upload switches false",
    );
  const facts = apkFacts(args.testApk);
  if (!facts.enabled || !facts.cleartext)
    throw new Error(
      "test APK merged manifest does not enable the gate and loopback cleartext (checked on the package the runtime reads)",
    );
  if (!facts.debuggable)
    throw new Error(
      "test APK is not debuggable: run-as (private scenario push) would fail",
    );
  if (facts.pkg !== "open.fpvlabs.stera.upload.qualification")
    throw new Error("build the dedicated APK with -Psa57Qualification");
  evidence.testPackage = facts.pkg;
  evidence.manifest = { gateEnabledInTestApk: true, productionGateFalse: true };

  // Start each run with a fresh private journal and never replace an existing APK.
  for (const { id } of pre.users)
    if (
      adb
        .shell(`pm list packages --user ${id} ${facts.pkg}`)
        .includes(facts.pkg)
    )
      throw new Error(`test package already present for user ${id}; stop`);

  const runtime = resolve(args.runtime);
  const harness = await import(
    pathToFileURL(join(runtime, "apps/web/test-e2e/harness.mjs")).href
  );
  const serverDir = join(runtime, "packages/server");
  const sreq = createRequire(join(serverDir, "package.json"));
  const dist = (p) => import(pathToFileURL(join(serverDir, "dist", p)).href);

  let proxy;
  let stack;
  let owner;
  let installed = false;
  const faultStats = { faulted: false, puts: 0 };
  let hold = ["complete", "capture", "logout"].includes(args.scenario)
    ? Promise.withResolvers()
    : null;
  if (!process.env.E2E_EXTERNAL_FIXTURES)
    throw new Error(
      "E2E_EXTERNAL_FIXTURES is required: no Docker path may start outside the resource guard",
    );
  const cleanup = async () => {
    try {
      adb.shell("dumpsys battery reset");
    } catch {}
    for (const p of portsReversed)
      try {
        adb.run(["reverse", "--remove", `tcp:${p}`]);
      } catch {}
    hold?.resolve();
    proxy?.closeAllConnections();
    proxy?.close();
    await owner?.end();
    try {
      await stack?.stop();
    } finally {
      if (installed) adb.shell(`pm uninstall --user 0 ${facts.pkg}`);
    }
  };
  const portsReversed = [];
  try {
    adb.run(["install", "--user", "0", "-t", args.testApk], {
      timeout: 240000,
    });
    installed = true;
    if (
      !adb.shell(`pm list packages --user 0 ${facts.pkg}`).includes(facts.pkg)
    )
      throw new Error("test package not in user 0");
    for (const id of pre.workIds)
      if (
        adb
          .shell(`pm list packages --user ${id} ${facts.pkg}`)
          .includes(facts.pkg)
      )
        throw new Error(`test package present in profile ${id}; stop`);
    adb.shell(
      `pm grant --user 0 ${facts.pkg} android.permission.POST_NOTIFICATIONS`,
    );
    // The fault proxy needs presigned URLs that point at it: S3_PUBLIC_ENDPOINT is local-only config.
    let proxyPort;
    let upstream;
    if (hold || args.scenario === "expiry") {
      if (hold && args.sizeMib <= 64)
        throw new Error("this scenario needs multiple parts (--size-mib > 64)");
      proxyPort = await freePort();
      proxy = await transferProxy(
        proxyPort,
        () => upstream,
        args.scenario === "expiry" ? args.faultPart : null,
        faultStats,
        () => hold?.promise,
      );
    }
    stack = await harness.startStack({
      storage: true,
      storagePublicEndpoint: proxyPort
        ? `http://127.0.0.1:${proxyPort}`
        : undefined,
    });
    const s3url = new URL(stack.s3.endpoint);
    upstream = { host: "127.0.0.1", port: Number(s3url.port) };
    const apiPort = Number(new URL(stack.origin).port);
    for (const p of [
      apiPort,
      proxyPort ?? Number(new URL(stack.outage.endpoint).port),
    ]) {
      adb.run(["reverse", `tcp:${p}`, `tcp:${p}`]);
      portsReversed.push(p);
    }

    owner = new (sreq("pg").Pool)({
      connectionString: stack.db.ownerUrl,
      max: 3,
    });
    const { storageClient } = await dist("storage.js");
    const { GetObjectCommand, ListMultipartUploadsCommand, ListPartsCommand } =
      sreq("@aws-sdk/client-s3");
    const s3 = storageClient(
      {
        endpoint: stack.s3.endpoint,
        publicEndpoint: stack.s3.endpoint,
        region: "us-east-1",
        bucket: stack.env.S3_BUCKET,
        accessKeyId: stack.s3.accessKeyId,
        secretAccessKey: stack.s3.secretAccessKey,
      },
      30000,
    );

    const sessionJar = await harness.signIn(stack, "collector");
    const owner1 = stack.users.collector;
    const native = (jar, body, method = "POST") => ({
      method,
      jar,
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-stateaction-client": "android",
      },
    });
    const rec = await harness.call(
      stack.origin,
      "/api/v1/recordings",
      native(sessionJar, {
        clientRecordingId: randomUUID(),
        captureFormat: "stateaction.capture.v1",
        rgbProfile: "h264_mcap_v1",
        startedAt: new Date().toISOString(),
        device: {
          model: "emulator",
          osVersion: String(args.api),
          appVersion: "sa57-driver",
        },
      }),
    );
    if (rec.status !== 201) throw new Error(`register failed ${rec.status}`);
    const recordingId = JSON.parse(rec.text).data.recording.recordingId;

    const src = sourcePlan(args.sizeMib, args.scenario);
    const sha = execFileSync(
      "python3",
      ["-I", join(here, "sa57_source.py"), src.seed, String(src.sizeBytes)],
      { encoding: "utf8" },
    ).trim();
    const created = await harness.call(
      stack.origin,
      "/api/v1/uploads",
      native(sessionJar, {
        recordingId,
        clientUploadId: randomUUID(),
        role: "source_mcap",
        sizeBytes: String(src.sizeBytes),
        sha256: sha,
      }),
    );
    if (created.status !== 200)
      throw new Error(`reserve failed ${created.status}`);
    const plan = JSON.parse(created.text).data;
    evidence.plan = {
      fileId: plan.fileId,
      parts: plan.partCount,
      sizeBytes: plan.sizeBytes,
      epoch: plan.transportEpoch,
    };

    // A second throwaway account for the owner-switch phase (operator action with the migration-owner credential).
    const other = {
      id: "sa57-collector-2",
      email: "sa57-collector2@stateaction.local",
    };
    const { hashCredentialPassword } = await dist("catalog/password.js");
    await owner.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,'SA57 Other',$2,true)`,
      [other.id, other.email],
    );
    await owner.query(
      `INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt") VALUES ($1,$2,'credential',$2,$3,now())`,
      [
        `${other.id}-credential`,
        other.id,
        await hashCredentialPassword(stack.password),
      ],
    );
    await owner.query(
      `INSERT INTO access (user_id, role, enabled, granted_by) VALUES ($1,'collector',true,'sa57-driver')`,
      [other.id],
    );
    const otherJar = new harness.Jar();
    const si = await harness.call(stack.origin, "/api/auth/sign-in/email", {
      method: "POST",
      jar: otherJar,
      body: JSON.stringify({ email: other.email, password: stack.password }),
      headers: harness.browserHeaders(stack.origin),
    });
    if (si.status !== 200) throw new Error(`other sign-in ${si.status}`);

    const cookiesOf = (jar) =>
      [...jar.cookies].map(([name, value]) => ({
        name,
        value,
        path: "/",
        secure: false,
        expiresAtMs: null,
      }));
    const scenarioBase = {
      origin: stack.origin,
      ownerId: owner1.id,
      sessionRevision: 1,
      cookies: cookiesOf(sessionJar),
      planJson: JSON.stringify(plan),
      source: {
        name: `${args.scenario}.bin`,
        seed: src.seed,
        sizeBytes: src.sizeBytes,
        sha256: sha,
      },
      otherOwnerId: other.id,
      otherSession: { cookies: cookiesOf(otherJar) },
      timeoutMs: args.timeoutMs,
      requireUnmetered: false,
      requireCharging: false,
    };
    const pushScenario = (extra) => {
      const json = JSON.stringify({ ...scenarioBase, ...extra });
      // App-private, 0600, via run-as in the personal user; the cookie never touches shared storage or stdout.
      adb.run(
        [
          "exec-in",
          `run-as ${facts.pkg} --user 0 sh -c 'umask 077; mkdir -p files/sa57; cat > files/sa57/sa57-scenario.json'`,
        ],
        { input: json },
      );
    };
    const readResult = (phase) => {
      try {
        return JSON.parse(
          adb.run([
            "exec-out",
            `run-as ${facts.pkg} --user 0 cat files/sa57/sa57-result-${phase}.json`,
          ]),
        );
      } catch {
        return null;
      }
    };
    const query = async (sql, params) => (await owner.query(sql, params)).rows;
    const objectKey = async () =>
      (
        await query(
          "SELECT object_key, state, provider_upload_id FROM files WHERE id=$1",
          [plan.fileId],
        )
      )[0];

    const hashObject = async (key) => {
      const r = await s3.send(
        new GetObjectCommand({ Bucket: stack.env.S3_BUCKET, Key: key }),
      );
      const h = createHash("sha256");
      let n = 0;
      for await (const c of r.Body) {
        h.update(c);
        n += c.length;
      }
      return { sha256: h.digest("hex"), bytes: n };
    };

    const hostSteps = {
      setCharging: async (s) => {
        adb.shell(s.on ? "dumpsys battery set ac 1" : "dumpsys battery unplug");
        adb.shell(`dumpsys battery set status ${s.on ? 2 : 3}`);
      },
      verifyUploaded: async () => {
        const f = await objectKey();
        const receipts = await query(
          "SELECT part_number, size_bytes, corroborated_at IS NOT NULL AS corroborated FROM file_part_receipts WHERE file_id=$1 ORDER BY part_number",
          [plan.fileId],
        );
        const view = {
          state: f.state,
          receiptParts: receipts.map((r) => r.part_number),
          allCorroborated: receipts.every((r) => r.corroborated),
        };
        if (!["completed", "verified"].includes(f.state))
          throw new Error(`file state ${f.state}`);
        if (receipts.length !== plan.partCount)
          throw new Error(`receipts ${receipts.length}/${plan.partCount}`);
        if (!view.allCorroborated)
          throw new Error("API completion left an uncorroborated receipt");
        const obj = await hashObject(f.object_key);
        if (obj.bytes !== src.sizeBytes || obj.sha256 !== sha)
          throw new Error(
            "provider object bytes/SHA-256 differ from the source",
          );
        const open =
          (
            await s3.send(
              new ListMultipartUploadsCommand({
                Bucket: stack.env.S3_BUCKET,
                Prefix: f.object_key,
              }),
            )
          ).Uploads ?? [];
        if (open.some((upload) => upload.Key === f.object_key))
          throw new Error(
            "completed object still has an open multipart upload",
          );
        evidence.verified = {
          ...view,
          objectBytes: obj.bytes,
          objectSha256Matches: true,
          openMultipartUploads: open.length,
          note: "provider size completion by API; full SHA checked by this driver, not by API complete",
        };
      },
      verifyNoFurtherPuts: async ({ expectedParts }) => {
        const f = await objectKey();
        const parts = async () =>
          (
            (
              await s3.send(
                new ListPartsCommand({
                  Bucket: stack.env.S3_BUCKET,
                  Key: f.object_key,
                  UploadId: f.provider_upload_id,
                }),
              )
            ).Parts ?? []
          ).length;
        const a = await parts();
        const putsBefore = faultStats.puts;
        if (expectedParts !== undefined && a !== expectedParts)
          throw new Error(
            `expected ${expectedParts} provider parts while constrained, observed ${a}`,
          );
        await sleep(20000);
        const b = await parts();
        if (faultStats.puts !== putsBefore)
          throw new Error("a new provider PUT started after the owner fence");
        if (a !== b)
          throw new Error(
            `provider parts changed while stopped (${a} -> ${b})`,
          );
        if (["completed", "verified"].includes((await objectKey()).state))
          throw new Error(
            "file completed before stopped-transfer verification",
          );
        evidence.stoppedTransfer = {
          providerParts: b,
          stable: true,
          fileStateStillIncomplete: true,
        };
      },
      observeScheduler: async () => {
        const checkpoint = evidence.phases.find(
          (phase) => phase.phase === "start",
        ).result;
        const pidBefore = String(checkpoint.pid);
        const deadline = Date.now() + Math.min(args.timeoutMs, 35000);
        do {
          const pid = adb.shell(`pidof ${facts.pkg} || true`).trim();
          const task = JSON.parse(
            adb.run([
              "exec-out",
              `run-as ${facts.pkg} --user 0 cat no_backup/native_upload/journal.v1.json`,
            ]),
          ).tasks[0];
          const landed = task.parts.filter((p) =>
            ["LANDED", "REPORTED"].includes(p[1]),
          ).length;
          evidence.schedulerRecovery = {
            pid,
            state: task.state,
            reason: task.reason,
            landed,
          };
          if (
            pid !== pidBefore &&
            (landed > checkpoint.tasks[0].landed ||
              task.state === "needs_visible_resume")
          )
            return;
          await sleep(1000);
        } while (Date.now() < deadline);
      },
      expectRenewal: async () => {
        const r = evidence.phases
          .map((p) => p.result)
          .filter(Boolean)
          .pop();
        if (!faultStats.faulted)
          throw new Error(
            `the fault was never delivered (no PUT for part ${args.faultPart}); use a larger --size-mib`,
          );
        if ((r?.rejectedRenewals ?? 0) < 1)
          throw new Error(
            "the engine did not count a rejected-signature renewal after the injected 403",
          );
        evidence.expiry = {
          mode: "expiry-response fault injection (one 403 for a really issued URL)",
          faultPart: args.faultPart,
          rejectedRenewals: r.rejectedRenewals,
          expiryRenewals: r.expiryRenewals,
          notRealTtl: true,
          note: "published URL TTL is 3600 s and was not waited out; provider TTL expiry remains a separate gate",
        };
      },
    };

    const toRun = SCENARIOS[args.scenario];
    for (const step of toRun) {
      if (step.host) {
        const t0 = Date.now();
        try {
          await hostSteps[step.host](step);
          evidence.phases.push({
            host: step.host,
            status: "passed",
            ms: Date.now() - t0,
          });
        } catch (e) {
          evidence.phases.push({
            host: step.host,
            status: "failed",
            detail: String(e.message).slice(0, 300),
          });
          throw e;
        }
        flush();
        continue;
      }
      pushScenario({ ...step, expectState: step.state });
      if (!adb.shell(`pidof ${facts.pkg} || true`).trim())
        adb.shell(
          `am start -W --user 0 -n ${facts.pkg}/open.fpvlabs.stera.upload.Sa57VisibleActivity`,
        );
      const t0 = Date.now();
      // The storage proxy runs on this event loop while Android uploads.
      let exited = false;
      const instrument = exec(
        "adb",
        [
          "-s",
          args.serial,
          "shell",
          `am instrument -w -r --user 0 --no-restart -e class ${TEST_CLASS}#${step.phase} ${facts.pkg}/${RUNNER}`,
        ],
        {
          encoding: "utf8",
          timeout: args.timeoutMs + 60000,
          maxBuffer: 32 << 20,
        },
      )
        .catch((error) => error)
        .finally(() => {
          exited = true;
        });
      let interrupted = false;
      if (step.interruptAfterCheckpoint) {
        while (!exited && Date.now() - t0 < args.timeoutMs + 20000) {
          const checkpoint = readResult("start");
          if (checkpoint && Number.isInteger(checkpoint.pid)) {
            const task = checkpoint.tasks[0];
            if (task.landed > 0 && task.landed < task.parts) {
              const pid = String(checkpoint.pid);
              if (
                !adb
                  .shell(`pidof ${facts.pkg} || true`)
                  .trim()
                  .split(/\s+/)
                  .includes(pid)
              )
                throw new Error("checkpoint process is already gone");
              adb.shell(
                `run-as ${facts.pkg} --user 0 touch files/sa57/kill-at-checkpoint`,
              );
              await instrument;
              if (
                adb
                  .shell(`pidof ${facts.pkg} || true`)
                  .trim()
                  .split(/\s+/)
                  .includes(pid)
              )
                throw new Error("checkpoint process survived SIGKILL");
              interrupted = true;
              evidence.notes.push(
                `SIGKILL after ${task.landed}/${task.parts} parts landed, pid ${checkpoint.pid}`,
              );
              await sleep(1500);
            }
            break;
          }
          await sleep(500);
        }
      }
      const raw = await instrument;
      const verdict = interrupted
        ? {
            status: "passed",
            detail: "process killed during checkpointed transfer",
          }
        : parseInstrument((raw.stdout ?? "") + (raw.stderr ?? ""));
      const result = readResult(step.phase);
      if (step.pauseAfterCheckpoint)
        evidence.captureCheckpoint = readResult("capturePause");
      if (step.logoutAfterCheckpoint)
        evidence.logoutCheckpoint = readResult("logout");
      if (step.phase === "start" && hold) {
        hold.resolve();
        hold = null;
      }
      const jobs = adb
        .shell(`dumpsys jobscheduler | grep -c ${facts.pkg} || true`)
        .trim();
      evidence.phases.push({
        phase: step.phase,
        status: verdict.status,
        detail: verdict.detail,
        ms: Date.now() - t0,
        result,
        jobSchedulerLines: Number(jobs) || 0,
      });
      flush();
      if (step.interruptAfterCheckpoint && !interrupted)
        throw new Error(
          "process-death phase never reached a live partial checkpoint",
        );
      if (verdict.status !== "passed")
        throw new Error(
          `phase ${step.phase}: ${verdict.status} ${verdict.detail ?? ""}`,
        );
    }
    evidence.outcome = "passed";
  } catch (e) {
    evidence.outcome = "failed";
    evidence.error = String(e.message).slice(0, 500);
    process.exitCode = 1;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    flush();
    await cleanup();
    console.log(
      JSON.stringify({
        outcome: evidence.outcome,
        out,
        error: evidence.error ?? null,
        phases: evidence.phases.map((p) => `${p.phase ?? p.host}:${p.status}`),
      }),
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
