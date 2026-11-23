// SA-96 dev-stack seed: simulated recordings uploaded through the real SA-71 path (HTTP create and
// seal over the production Next server, library reserve/complete as the SA-71 e2e does), then run
// through the REAL local loopback controller (`render workflows dev` + process-recording) with
// stub or replay stage modules. Zero model spend; nothing here is a live model run. Local only.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { call, browserHeaders, Jar, webDir } from "./harness.mjs";
import {
  REPLAY_SCENARIOS,
  SYNTHETIC_SCENARIOS,
  scenarioMismatch,
} from "./seed-scenarios.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const serverDir = join(repoRoot, "packages/server/");
const serverRequire = createRequire(join(serverDir, "package.json"));
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const SIM = "h264_mcap_simulation_v1";
/** The model digest is the accepted CPU model pin; the config digest is the worker's own value. */
export function jobsEnv(python) {
  const r = spawnSync(
    python,
    ["-m", "stateaction_processing.artifact_cli", "config-digest"],
    { cwd: join(repoRoot, "workers/processing"), encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error("config digest unavailable");
  return {
    PROCESSING_EXECUTION_BACKEND: "local",
    PROCESSING_CODE_REVISION: "sa96-dev-seed",
    PROCESSING_IMAGE_SPEC_SHA256: sha("image"),
    PROCESSING_MODEL_SHA256:
      "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
    PROCESSING_CONFIG_SHA256: JSON.parse(r.stdout).config_sha256,
    ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
  };
}

/** Directory holding one `<recording-id>.json` recipe per recording (the local override). */
export const newSeedDirs = () => {
  const root = mkdtempSync(join(tmpdir(), "sa96-seed-"));
  const dirs = {
    root,
    recipes: join(root, "recipes"),
    state: join(root, "state"),
    cache: join(root, "cache"),
  };
  for (const d of Object.values(dirs))
    mkdirSync(d, { recursive: true, mode: 0o700 });
  return dirs;
};

const simulation = {
  schema: "stateaction.simulation_provenance.v1",
  qualification: "simulation_only",
  mappedTimelineSemantics: "simulation_transport_only",
  productionQualified: false,
  provenance: {
    camera: { status: "known", label: "android-emulator-virtualscene" },
    encoder: { status: "unknown" },
    clock: { status: "known", label: "host-receipt-transport-only" },
  },
};
const artifactSimulation = {
  schema: simulation.schema,
  qualification: simulation.qualification,
  mapped_timeline_semantics: simulation.mappedTimelineSemantics,
  production_qualified: false,
  provenance: simulation.provenance,
};

/** A synthetic simulation-profile MCAP (generated test pattern, no hands). */
function syntheticSource(python, out) {
  const r = spawnSync(
    python,
    ["workers/processing/tools/synthetic_sim_mcap.py", out],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (r.status !== 0)
    throw new Error(`synthetic source failed: ${r.stderr.slice(-300)}`);
}

/** The T01 store counts only when its own verifier passes; otherwise the replay scenarios are skipped. */
export function homerStore(
  python,
  store = join(repoRoot, "artifacts/fixtures/flora-homer"),
) {
  if (!existsSync(join(store, "MANIFEST.json")))
    return { ok: false, reason: "artifacts/fixtures/flora-homer not present" };
  const r = spawnSync(
    python,
    ["workers/processing/tools/fixture_store.py", "--store", store, "verify"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return r.status === 0
    ? { ok: true, store }
    : {
        ok: false,
        reason: "artifacts/fixtures/flora-homer failed verification",
      };
}

/**
 * STATEACTION_SEED_ONLY: comma list of scenario names to seed (default all). Unknown names throw,
 * so a typo never silently seeds nothing.
 */
export function seedOnly(value) {
  if (value === undefined || value.trim() === "") return null;
  const known = Object.keys({ ...SYNTHETIC_SCENARIOS, ...REPLAY_SCENARIOS });
  const names = value
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length || !names.length)
    throw new Error(
      `STATEACTION_SEED_ONLY: unknown scenario ${unknown.join(",")} (known: ${known.join(", ")})`,
    );
  return new Set(names);
}

export async function seedAnnotations(
  stack,
  {
    dirs,
    python,
    renderCli,
    log = () => {},
    source,
    scenarios,
    rgbProfile = SIM,
  },
) {
  const pg = serverRequire("pg");
  const { PutObjectCommand, GetObjectCommand } =
    serverRequire("@aws-sdk/client-s3");
  const { recordSourceCompletion } = await dist("admission/recordings.js");
  const { s3ObjectReader } = await dist("admission/object-reader.js");
  const { reserveSourceFile, sourceObjectKey } =
    await dist("catalog/catalog.js");
  const { storageClient } = await dist("storage.js");
  const { issueControllerCapability } = await dist("jobs/credentials.js");
  const { recordIngestPermission } = await dist("admission/permissions.js");
  const owner = new pg.Pool({ connectionString: stack.db.ownerUrl, max: 3 });
  const app = new pg.Pool({ connectionString: stack.db.appUrl, max: 4 });
  const storageConfig = {
    endpoint: stack.s3.endpoint,
    publicEndpoint: stack.s3.endpoint,
    region: "us-east-1",
    bucket: stack.env.S3_BUCKET,
    accessKeyId: stack.s3.accessKeyId,
    secretAccessKey: stack.s3.secretAccessKey,
  };
  // 120 s: the shared fixture store can answer slowly under host load (a 15 s timeout failed run 10).
  const storage = storageClient(storageConfig, 120_000);
  const deps = {
    pool: app,
    reader: s3ObjectReader(storageConfig),
    config: {
      processingProfileRevision: stack.env.PROCESSING_PROFILE_REVISION,
      supportedRgbProfiles: ["h264_mcap_v1", SIM],
      simulatedCaptureInputs: true,
    },
  };
  const procs = [];
  const childRefs = new Set();
  const workerPids = (ref) =>
    readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .filter((n) => {
        try {
          return readFileSync(`/proc/${n}/cmdline`, "utf8")
            .split("\0")
            .includes(ref);
        } catch {
          return false;
        }
      })
      .map(Number);
  try {
    const collector = stack.users.collector;
    const have = await owner.query(
      "SELECT 1 FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
      [collector.id],
    );
    if (!have.rowCount)
      await recordIngestPermission(owner, {
        permissionRef: "sa96-seed.r1",
        ownerUserId: collector.id,
        pilotScope: "sa96-seed",
        coversCapture: true,
        coversProcessing: true,
        evidenceRef: "doc://pilot/sa96-seed",
        recordedBy: "operator@seed",
      });
    const jar = new Jar();
    const login = await call(stack.origin, "/api/auth/sign-in/email", {
      method: "POST",
      jar,
      body: JSON.stringify({
        email: collector.email,
        password: stack.password,
      }),
      headers: browserHeaders(stack.origin),
    });
    if (login.status !== 200)
      throw new Error(`collector sign-in: ${login.status}`);
    const post = (path, body, native) =>
      call(stack.origin, path, {
        method: "POST",
        jar,
        body: JSON.stringify(body),
        headers: native
          ? {
              "content-type": "application/json",
              "x-stateaction-client": "android",
            }
          : browserHeaders(stack.origin),
      });

    // `source` (a committed MCAP) and `scenarios` (an explicit table) let a test pin both; the dev
    // seed passes neither and generates a test pattern for the built-in synthetic scenarios.
    const synthetic = source ?? join(dirs.cache, "synthetic-source.mcap");
    if (!source) syntheticSource(python, synthetic);
    const only = scenarios ? null : seedOnly(process.env.STATEACTION_SEED_ONLY);
    const wanted = (scenario) => !only || only.has(scenario);
    const table = scenarios ?? SYNTHETIC_SCENARIOS;
    const replay = scenarios ? {} : REPLAY_SCENARIOS;
    const store = Object.keys(replay).some(wanted)
      ? homerStore(python)
      : { ok: false, reason: "not requested" };
    const plan = Object.entries(table)
      .filter(([scenario]) => wanted(scenario))
      .map(([scenario, s]) => ({
        scenario,
        recipe: s.recipe,
        source: s.source ?? synthetic,
        drive: s.drive,
      }));
    const skipped = [];
    for (const [scenario, s] of Object.entries(replay)) {
      if (!wanted(scenario)) continue;
      if (store.ok)
        plan.push({
          scenario,
          recipe: s.recipe,
          source: join(store.store, s.episode, "source.mcap"),
        });
      else skipped.push({ scenario, reason: store.reason });
    }

    // 1. Upload every recording through the real create and seal path (recipe file written first).
    const upload = async (p) => {
      const bytes = readFileSync(p.source);
      const clientRecordingId = randomUUID();
      const created = await post(
        "/api/v1/recordings",
        {
          schema: "stateaction.recording_create.v2",
          clientRecordingId,
          captureFormat: "stateaction.capture.v1",
          rgbProfile,
          ...(rgbProfile === SIM && { simulation }),
          startedAt: "2026-11-02T08:00:00.000000Z",
          device: {
            model: "sdk_gphone64_x86_64",
            osVersion: "15",
            appVersion: "0.1.0+1",
          },
        },
        true,
      );
      if (created.status !== 201)
        throw new Error(
          `${p.scenario}: create ${created.status} ${created.text.slice(0, 200)}`,
        );
      const { recording, collectionPermissionRef } = JSON.parse(
        created.text,
      ).data;
      const recordingId = recording.recordingId;
      // A re-entry scenario holds its stage open until the driver releases it (no timing).
      const releaseFile = p.drive
        ? join(dirs.root, `release-${recordingId}`)
        : undefined;
      const recipe = p.drive
        ? {
            ...p.recipe,
            stages: p.recipe.stages.map((st) =>
              st.stage === p.drive.stage
                ? {
                    ...st,
                    params: { ...st.params, hang_release_file: releaseFile },
                  }
                : st,
            ),
          }
        : p.recipe;
      writeFileSync(
        join(dirs.recipes, `${recordingId}.json`),
        JSON.stringify(recipe),
        { mode: 0o600 },
      );
      const files = [
        { fileId: randomUUID(), role: "source_mcap", body: bytes },
        {
          fileId: randomUUID(),
          role: "recorder_metadata",
          body: Buffer.from(`seed:${recordingId}`),
        },
      ];
      const manifest = Buffer.from(
        JSON.stringify({
          schema: "stateaction.recording_source.v2",
          recording_id: recordingId,
          client_recording_id: clientRecordingId,
          owner_user_id: collector.id,
          capture_format: "stateaction.capture.v1",
          rgb_profile: rgbProfile,
          ...(rgbProfile === SIM && { simulation: artifactSimulation }),
          capture_config_sha256: sha("capture-config"),
          close_status: "closed_clean",
          files: files.map((f) => ({
            file_id: f.fileId,
            role: f.role,
            required: true,
            size_bytes: String(f.body.byteLength),
            sha256: sha(f.body),
          })),
          clock_domains: ["android.elapsed_realtime"],
          channels: [
            {
              topic: "/camera/rgb",
              message_encoding: "protobuf",
              schema_name: "foxglove.CompressedVideo",
              clock_domain: "android.elapsed_realtime",
              message_count: "30",
            },
          ],
          counts: {
            video_frames: "30",
            dropped_video_frames: "0",
            motion_events: "30",
          },
          collection_permission_ref: collectionPermissionRef,
          source_verification: "pending",
        }),
      );
      const manifestId = randomUUID();
      files.push({
        fileId: manifestId,
        role: "source_manifest",
        body: manifest,
      });
      for (const f of files) {
        await reserveSourceFile(app, {
          fileId: f.fileId,
          recordingId,
          ownerUserId: collector.id,
          clientUploadId: randomUUID(),
          role: f.role,
          sizeBytes: String(f.body.byteLength),
          sha256: sha(f.body),
          required: true,
          partSizeBytes: "67108864",
          partCount: 1,
        });
        await storage.send(
          new PutObjectCommand({
            Bucket: storageConfig.bucket,
            Key: sourceObjectKey(recordingId, f.fileId, 1, f.role),
            Body: f.body,
          }),
        );
      }
      for (const f of [files[0], files[1], files[2]])
        await recordSourceCompletion(
          deps,
          { userId: collector.id },
          {
            recordingId,
            fileId: f.fileId,
            expectedTransportEpoch: 1,
            observedSizeBytes: String(f.body.byteLength),
          },
        );
      const sealed = await post(`/api/v1/recordings/${recordingId}/seal`, {
        files: files.map((f) => ({
          fileId: f.fileId,
          role: f.role,
          sizeBytes: String(f.body.byteLength),
          sha256: sha(f.body),
          required: true,
        })),
      });
      if (sealed.status !== 200)
        throw new Error(
          `${p.scenario}: seal ${sealed.status} ${sealed.text.slice(0, 200)}`,
        );
      const job = (
        await owner.query("SELECT id FROM jobs WHERE recording_id = $1", [
          recordingId,
        ])
      ).rows[0];
      log(`uploaded ${p.scenario}`);
      return {
        scenario: p.scenario,
        recordingId,
        jobId: job.id,
        source: p.source,
        drive: p.drive,
        releaseFile,
      };
    };
    const recordings = [];
    for (const p of plan) recordings.push(await upload(p));

    // 2. Run them through the real local loopback controller, one admission slot at a time.
    const secrets = join(dirs.root, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    const issue = async (kind, scopes, name) => {
      const { token } = await issueControllerCapability(owner, {
        kind,
        scopes,
        label: name,
        ttlSeconds: 6 * 3600,
      });
      const file = join(secrets, name);
      writeFileSync(file, token, { mode: 0o600 });
      return { token, file };
    };
    const workflow = await issue(
      "workflow",
      ["jobs:status", "jobs:reconcile"],
      "workflow",
    );
    const cron = await issue("cron", ["jobs:repair"], "cron");
    const port = await freePort();
    const ctl = {
      APP_ENV: "local",
      EXECUTION_BACKEND: "local",
      STATEACTION_API_URL: stack.origin,
      CONTROLLER_CAPABILITY_FILE: workflow.file,
      JOBS_STATE_DIR: dirs.state,
      PYTHON_EXECUTABLE: python,
      WORKER_PIPELINE: "hand_pose_cpu_v1",
      CONTROLLER_RENEW_MS: "1000",
      CONTROLLER_POLL_MS: "200",
      CONTROLLER_LEASE_WAIT_MS: "5000",
      ...(store.ok && { STATEACTION_REPLAY_DIR: store.store }),
    };
    const envFile = join(secrets, "runner.env");
    writeFileSync(
      envFile,
      Object.entries(ctl)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      { mode: 0o600 },
    );
    chmodSync(envFile, 0o600);
    const runner = spawn(
      renderCli,
      [
        "workflows",
        "dev",
        "--port",
        String(port),
        "--env-file",
        envFile,
        "--",
        "node",
        "dist/index.js",
      ],
      { cwd: join(repoRoot, "apps/jobs"), detached: true, stdio: "ignore" },
    );
    procs.push(runner);
    const { Render } = await import(
      new URL(
        `file://${createRequire(join(repoRoot, "apps/jobs/package.json")).resolve("@renderinc/sdk")}`,
      ).href
    );
    const render = new Render({
      useLocalDev: true,
      localDevUrl: `http://127.0.0.1:${port}`,
    });
    for (let i = 0; ; i++) {
      const r = spawnSync(
        renderCli,
        [
          "workflows",
          "tasks",
          "list",
          "--local",
          "--port",
          String(port),
          "-o",
          "text",
        ],
        { encoding: "utf8" },
      );
      if (r.status === 0 && r.stdout.includes("process-recording")) break;
      if (i > 120) throw new Error("the local task runner did not start");
      await sleep(500);
    }
    // Render retry re-entry: the controller dies (SIGKILL) while `drive.stage` runs, the stage child
    // (its own session) survives, and the same run ref re-enters after the lease lapsed. The child
    // must be adopted, never respawned: the caller asserts that from journals, claims and rows.
    const controllerOnce = (rec, runRef) => {
      const child = spawn(
        process.execPath,
        [join(repoRoot, "apps/jobs/test-integration/controller-process.mjs")],
        {
          cwd: join(repoRoot, "apps/jobs"),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            ...ctl,
            TEST_JOB_ID: rec.jobId,
            TEST_RUN_REF: runRef,
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      procs.push(child);
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      const done = new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          resolve({ crashed: out.slice(-2000), timedOut: true });
        }, 240_000);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(out.trim().split("\n").at(-1)));
          } catch {
            resolve({ crashed: out.slice(-2000), code, signal });
          }
        });
      });
      return { child, done };
    };
    const driveControllerLoss = async (rec) => {
      const runRef = `retry-${rec.jobId}`;
      const journal = join(
        dirs.state,
        rec.jobId,
        rec.drive.stage,
        "journal.json",
      );
      const first = controllerOnce(rec, runRef);
      let seen;
      for (let i = 0; !seen; i++) {
        try {
          const j = JSON.parse(readFileSync(journal, "utf8"));
          if (j.phase === "running" && j.executionRef) seen = j;
        } catch {}
        if (!seen) {
          if (i > 480) throw new Error(`${rec.scenario}: stage never ran`);
          await sleep(250);
        }
      }
      const pidsBefore = workerPids(seen.executionRef);
      childRefs.add(seen.executionRef);
      process.kill(-first.child.pid, "SIGKILL");
      await first.done;
      await owner.query(
        "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [rec.jobId],
      );
      const second = controllerOnce(rec, runRef);
      // The re-entered controller holds the lease again while the stage child is still held open.
      let holds = false;
      for (let i = 0; !holds; i++) {
        holds = (
          await owner.query(
            "SELECT controller_lease_expires_at > now() AS held FROM jobs WHERE id = $1",
            [rec.jobId],
          )
        ).rows[0].held;
        if (!holds) {
          if (i > 600) throw new Error(`${rec.scenario}: no re-entry`);
          await sleep(100);
        }
      }
      const aliveAtReentry =
        pidsBefore.length > 0 &&
        pidsBefore.every((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
      writeFileSync(rec.releaseFile, "");
      const outcome = await second.done;
      if (outcome.outcome !== "recipe_run")
        throw new Error(
          `${rec.scenario}: re-entry ${JSON.stringify(outcome).slice(0, 600)}`,
        );
      return {
        task: { status: "completed", results: [outcome] },
        retry: {
          stage: rec.drive.stage,
          runRef,
          executionRef: seen.executionRef,
          pidsBefore,
          aliveAtReentry,
          journalFile: journal,
        },
      };
    };
    const runOne = async (rec) => {
      let dispatched;
      for (let i = 0; !dispatched && i < 600; i++) {
        const res = await call(stack.origin, "/internal/v1/jobs/reconcile", {
          method: "POST",
          headers: {
            authorization: `Bearer ${cron.token}`,
            "content-type": "application/json",
          },
          body: "{}",
        });
        if (res.status !== 200) throw new Error(`reconcile ${res.status}`);
        dispatched = JSON.parse(res.text).data.pendingDispatches.find(
          (d) => d.jobId === rec.jobId,
        );
        if (!dispatched) await sleep(500);
      }
      if (!dispatched) throw new Error(`${rec.scenario}: never admitted`);
      let task;
      let retry;
      if (rec.drive) {
        ({ task, retry } = await driveControllerLoss(rec));
      } else {
        const run = await render.workflows.startTask(
          "process-recording",
          [{ jobId: rec.jobId }],
          {
            idempotencyKey: dispatched.dispatchKey,
            signal: AbortSignal.timeout(10_000),
          },
        );
        for (let i = 0; ; i++) {
          const t = await render.workflows.getTaskRun(run.taskRunId);
          task = t;
          if (["failed", "canceled"].includes(t.status))
            throw new Error(`${rec.scenario}: task ${t.status}`);
          if (t.status === "completed") break;
          if (i > 1200) throw new Error(`${rec.scenario}: controller timeout`);
          await sleep(500);
        }
      }
      // Read the job and its stage rows together. A row still `running` after the task run
      // completed is recorded (settleMs, taskResult) and waited out for at most 30 s; a row that
      // never settles stays in the result and fails the scenario check.
      const readRows = async () => ({
        stages: (
          await owner.query(
            "SELECT stage, state, module, error_code FROM job_stage_runs WHERE job_id = $1 ORDER BY job_stage_ord(stage)",
            [rec.jobId],
          )
        ).rows,
        state: (
          await owner.query("SELECT state FROM jobs WHERE id = $1", [rec.jobId])
        ).rows[0].state,
      });
      const open = (r) =>
        r.stages.some((x) => ["running", "submitting"].includes(x.state));
      let { stages, state } = await readRows();
      const settleStart = Date.now();
      const taskResult = open({ stages })
        ? JSON.stringify(task?.results ?? null).slice(0, 400)
        : undefined;
      while (open({ stages }) && Date.now() - settleStart < 30_000) {
        await sleep(250);
        ({ stages, state } = await readRows());
      }
      const settleMs = taskResult ? Date.now() - settleStart : 0;
      // Cache the inputs and outputs of the job for `jobs diag` and `jobs replay-stage`.
      const jobCache = join(dirs.cache, rec.jobId);
      mkdirSync(join(jobCache, "outputs"), { recursive: true });
      copyFileSync(rec.source, join(jobCache, "source.mcap"));
      const input = (
        await owner.query(
          "SELECT task_input FROM job_inputs WHERE job_id = $1",
          [rec.jobId],
        )
      ).rows[0];
      if (input)
        writeFileSync(
          join(jobCache, "task-input.json"),
          JSON.stringify(input.task_input),
        );
      const out = await owner.query(
        `SELECT s.slot, f.object_key FROM files f
         JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
         WHERE f.job_id = $1 AND f.purpose = 'output' AND f.state IN ('completed', 'verified')
           AND (s.slot IN ('segments.json', 'captions.json') OR s.slot LIKE 'diagnostics/%')`,
        [rec.jobId],
      );
      for (const row of out.rows) {
        const body = await storage.send(
          new GetObjectCommand({
            Bucket: storageConfig.bucket,
            Key: row.object_key,
          }),
        );
        const dest = join(jobCache, "outputs", row.slot);
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(
          dest,
          Buffer.from(await body.Body.transformToByteArray()),
        );
      }
      log(`ran ${rec.scenario}: ${state}`);
      return {
        scenario: rec.scenario,
        recordingId: rec.recordingId,
        jobId: rec.jobId,
        jobState: state,
        stages,
        ...(retry && { retry }),
        ...(taskResult && { settleMs, taskResult }),
      };
    };
    // Zero-flaky rule: every scenario must end in its expected states on the first attempt.
    const results = [];
    for (const rec of recordings) {
      const result = await runOne(rec);
      const mismatch = scenarioMismatch(result, scenarios);
      if (mismatch)
        throw new Error(
          `${rec.scenario}: unexpected outcome: ${mismatch} ${JSON.stringify({ settleMs: result.settleMs, taskResult: result.taskResult, serverLog: stack.logs().slice(-1500) })}`,
        );
      results.push(result);
    }
    const stopRunner = () => {
      for (const p of procs)
        try {
          process.kill(-p.pid, "SIGTERM");
        } catch {}
      // Stage children run in their own sessions: stop any a re-entry scenario left (exact PIDs).
      for (const ref of childRefs)
        for (const pid of workerPids(ref))
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
    };
    return {
      summary: {
        recordings: results,
        skipped,
        workflowTokenFile: workflow.file,
        stateDir: dirs.state,
        cacheDir: dirs.cache,
      },
      stopRunner,
    };
  } catch (error) {
    for (const p of procs)
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {}
    for (const ref of childRefs)
      for (const pid of workerPids(ref))
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
    throw error;
  } finally {
    await Promise.allSettled([owner.end(), app.end()]);
    storage.destroy();
  }
}

async function freePort() {
  const { createServer } = await import("node:http");
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
