// SA-40 local staff-to-customer review/isolation qualification driver.
//
// Runs ENTIRELY inside one `agent-resource run` job (this driver, the operator
// CLI children and the agent-browser daemons). It targets an ALREADY RUNNING
// synthetic runtime described by a protected 0600 SA40_CONFIG file; it starts
// no stack, creates no database, runs no bootstrap and builds nothing. It never
// writes the uploaded source, files, jobs, execution evidence or acceptance
// rows: owner SQL is read-only observation (a before/after row digest proves
// it), apart from one restored `access` toggle (customer role disabled), and
// all other owner mutations go through the existing `dataset-sharing` operator
// CLI for datasets this driver itself creates (names prefixed `sa40-`).
//
// The qualifying clip is DISCOVERED through the staff recording grid from the
// real, accepted adapter run; no fixture, golden RRD or hand-written
// acceptance row is accepted. Every missing precondition fails closed.
// Simulation, source integrity, hand-detection coverage, pose accuracy and
// hardware are reported as separate claims and nothing here claims accuracy or
// hardware. Chrome WebGL is software rendered and labelled as such.
//
// SA40_PHASE: `trace` (read-only trace + operator CLI health), `probe`
// (trace + read-only staff browser pass), `all` (default; reviews, access
// matrix, revocation, both browsers), `access` (explicit state recovery: resume
// after the review matrix of an earlier `all` run that stopped later; needs
// SA40_RESUME_EVIDENCE naming that run's evidence file for its dataset ids),
// `browser` (same recovery, browser stage only).
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Jar, browserHeaders, call } from "./harness.mjs";

const fail = (message) => {
  throw new Error(message);
};
if (!readFileSync("/proc/self/cgroup", "utf8").includes("agent-work.slice"))
  fail("Must run inside agent-resource (whole driver incl. browser daemons)");
const PHASE = process.env.SA40_PHASE ?? "all";
if (!["trace", "probe", "all", "access", "browser"].includes(PHASE))
  fail("SA40_PHASE must be trace, probe, all, access or browser");

// ---------------------------------------------------------------- config
const configPath = process.env.SA40_CONFIG ?? fail("SA40_CONFIG is required");
if ((statSync(configPath).mode & 0o077) !== 0)
  fail("SA40_CONFIG must not be group/world accessible (0600)");
const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const need = (ok, what) => ok || fail(`SA40_CONFIG: ${what}`);
const origin = cfg.origin;
need(typeof origin === "string", "origin");
need(
  ["127.0.0.1", "localhost"].includes(new URL(origin).hostname),
  "origin must be loopback (local synthetic runtime only)",
);
for (const role of ["staff", "customer", "collector", "outsider"])
  need(cfg.users?.[role]?.email && cfg.users[role].password, `users.${role}`);
for (const role of ["staff", "customer"])
  need(
    typeof cfg.users[role].id === "string" && cfg.users[role].id.length > 0,
    `users.${role}.id (opaque Better Auth id, not necessarily a UUID)`,
  );
need(UUID.test(cfg.recordingId ?? ""), "recordingId uuid");
need(UUID.test(cfg.jobId ?? ""), "jobId uuid");
const exp = cfg.expected ?? {};
need(
  /^[0-9a-f]{40}$/.test(exp.codeRevision ?? ""),
  "expected.codeRevision full git SHA",
);
need(UUID.test(exp.nativeRecordingId ?? ""), "expected.nativeRecordingId full");
const sources = [
  ["sourceMcap", "source_mcap"],
  ["recorderMetadata", "recorder_metadata"],
  ["sourceManifest", "source_manifest"],
];
for (const [key] of sources) {
  need(UUID.test(exp[`${key}FileId`] ?? ""), `expected.${key}FileId full`);
  need(SHA.test(exp[`${key}Sha256`] ?? ""), `expected.${key}Sha256 full`);
}
need(
  typeof exp.recorderMetadataPath === "string",
  "expected.recorderMetadataPath",
);
need(
  typeof exp.actualExecutionEvidencePath === "string",
  "expected.actualExecutionEvidencePath",
);
const ownerUrl =
  process.env.SA40_OWNER_DATABASE_URL ?? fail("SA40_OWNER_DATABASE_URL unset");
need(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(ownerUrl).hostname),
  "owner database must be loopback",
);

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const pg = createRequire(serverDir + "package.json")("pg");
const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
const q = async (sql, params = []) => (await owner.query(sql, params)).rows;

// ---------------------------------------------------------------- evidence
const evidenceDir =
  process.env.SA40_OUTPUT_DIR ?? fail("SA40_OUTPUT_DIR unset");
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
if ((statSync(evidenceDir).mode & 0o077) !== 0)
  fail("SA40_OUTPUT_DIR must be private (0700)");
const outDir = join(evidenceDir, "/");
mkdirSync(outDir + "browser", { recursive: true, mode: 0o700 });
const evidence = {
  phase: PHASE,
  startedAt: new Date().toISOString(),
  claims: {
    simulationOnly: true,
    sourceIntegrity: null,
    handDetectionCoverage: "reported, not an accuracy claim",
    poseAccuracy: "not evaluated",
    hardware: "not qualified",
    browserWebGL: "software-rendering-not-accelerated",
  },
  ids: {},
  checks: [],
  revocation: [],
};
const flush = () =>
  writeFileSync(
    outDir + `evidence-${PHASE}.json`,
    JSON.stringify(evidence, null, 2) + "\n",
    { mode: 0o600 },
  );
const check = (name, ok, extra) => {
  evidence.checks.push({ name, ok: Boolean(ok), ...(extra && { extra }) });
  if (!ok) {
    flush();
    fail(`FAIL ${name}${extra ? " " + JSON.stringify(extra) : ""}`);
  }
  console.log(`PASS ${name}`);
};
const fileSha = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

// ---------------------------------------------------------------- HTTP
async function signIn(label) {
  const jar = new Jar();
  const res = await call(origin, "/api/auth/sign-in/email", {
    method: "POST",
    jar,
    body: JSON.stringify({
      email: cfg.users[label].email,
      password: cfg.users[label].password,
    }),
    headers: browserHeaders(origin),
  });
  if (res.status !== 200) fail(`${label} sign-in failed (${res.status})`);
  return jar;
}
const get = (jar, path) => call(origin, path, { jar });
const send = (jar, path, payload, method = "POST", extra = {}) =>
  call(origin, path, {
    method,
    jar,
    body: JSON.stringify(payload),
    headers: browserHeaders(origin, extra),
  });
const data = (res) => {
  if (res.status < 200 || res.status > 299)
    fail(`unexpected HTTP ${res.status}`);
  return JSON.parse(res.text).data;
};
const DENIED = [401, 403, 404];

// ------------------------------------------------ operator CLI (existing)
function operator(args) {
  const run = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "src/dataset-sharing-cli.ts",
      ...args,
    ],
    {
      cwd: serverDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        APP_ENV: "local",
        MIGRATION_DATABASE_URL: ownerUrl,
      },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  if (run.status !== 0)
    fail(
      `dataset-sharing ${args[0]} failed: ${(run.stderr ?? "").split("\n")[0].slice(0, 200)}`,
    );
  return JSON.parse(run.stdout || "null");
}
const sha256Stream = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return { status: res.status };
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { status: res.status, size, sha256: hash.digest("hex") };
};
// One-byte ranged probe of an already issued URL (no full download).
const probeUrl = async (url) =>
  (await fetch(url, { headers: { range: "bytes=0-0" } })).status;

// ---------------------------------------------------------------- browser
const stateDir = mkdtempSync(join(tmpdir(), "sa40-browser-"));
chmodSync(stateDir, 0o700);
const browsers = [];
class Browser {
  launched = false;
  constructor(label, jar) {
    this.session = `sa40-${label}-${process.pid}`;
    // Session cookie goes in a 0600 storage-state file, never argv.
    this.stateFile = join(stateDir, `${label}.json`);
    writeFileSync(
      this.stateFile,
      JSON.stringify({
        cookies: [...jar.cookies].map(([name, value]) => ({
          name,
          value,
          domain: new URL(origin).hostname,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        })),
        origins: [],
      }),
      { mode: 0o600 },
    );
    browsers.push(this);
  }
  run(args, launch = []) {
    return execFileSync(
      "agent-browser",
      ["--session", this.session, ...launch, ...args],
      { encoding: "utf8", timeout: 60000 },
    ).trim();
  }
  ab(...args) {
    if (!this.launched) {
      this.launched = true;
      // Launch flags apply to the first command only; `--state` is ignored on
      // launch (verified), so the 0600 state file is loaded right after.
      this.run(
        ["open", origin + "/login"],
        [
          "--executable-path",
          "/usr/bin/google-chrome",
          "--args",
          "--no-sandbox,--enable-unsafe-swiftshader",
        ],
      );
      this.run(["state", "load", this.stateFile]);
    }
    return this.run(args);
  }
  ev(code) {
    return JSON.parse(this.ab("eval", code));
  }
  close() {
    if (!this.launched) return;
    try {
      execFileSync("agent-browser", ["--session", this.session, "close"], {
        timeout: 30000,
      });
    } catch {}
  }
}
const until = async (fn, name, seconds = 60) => {
  const deadline = Date.now() + seconds * 1000;
  while (!(await fn())) {
    check(`wait: ${name}`, Date.now() < deadline);
    await sleep(400);
  }
};
const screenshots = [];

// ================================================================ main
let restoreCustomerRole = null;
try {
  await main();
} catch (error) {
  evidence.outcome = `FAILED: ${String(error?.message ?? error)
    .split("\n")[0]
    .slice(0, 300)}`;
  evidence.finishedAt = new Date().toISOString();
  flush();
  console.error(evidence.outcome);
  process.exitCode = 1;
} finally {
  if (restoreCustomerRole) {
    try {
      await owner.query(
        "UPDATE access SET enabled=$2 WHERE user_id=$1 AND role='customer'",
        [cfg.users.customer.id, restoreCustomerRole.was],
      );
      console.log("restored customer role access");
    } catch {
      console.error("FAILED to restore customer role access: do it manually");
      process.exitCode = 1;
    }
  }
  for (const b of browsers) b.close();
  rmSync(stateDir, { recursive: true, force: true });
  await owner.end().catch(() => undefined);
}

async function main() {
  const staff = await signIn("staff");
  const customer = await signIn("customer");
  const collector = await signIn("collector");
  const outsider = await signIn("outsider");

  // ============================================================ Phase 1
  // Trace the real native source -> real adapter run -> accepted clip. All of
  // it is read-only against rows written by the real runner/controller.
  const jobId = cfg.jobId;
  const [rec] = await q(
    "SELECT current_job_id, deleted_at, source_manifest_sha256, simulation FROM recordings WHERE id=$1",
    [cfg.recordingId],
  );
  check("recording exists and is current", rec && !rec.deleted_at);
  check(
    "recording's current job is the configured job",
    rec.current_job_id === jobId,
  );
  check(
    "recording carries the emulator simulation marker",
    rec.simulation !== null,
  );
  check(
    "migration 009 acceptance tables present",
    Boolean(
      (await q("SELECT to_regclass('public.job_result_candidates') AS t"))[0].t,
    ),
  );

  const sourceRows = [];
  for (const [key, role] of sources) {
    const [f] = await q(
      "SELECT id, sha256, state, purpose, role, recording_id FROM files WHERE id=$1",
      [exp[`${key}FileId`]],
    );
    check(
      `source ${role} is the frozen original`,
      f &&
        f.recording_id === cfg.recordingId &&
        f.purpose === "source" &&
        f.role === role &&
        f.sha256 === exp[`${key}Sha256`] &&
        ["completed", "verified"].includes(f.state),
    );
    sourceRows.push(f);
  }
  check(
    "recording sealed on the configured source manifest digest",
    rec.source_manifest_sha256 === exp.sourceManifestSha256,
  );

  // Native recording UUID from the SHA-checked provider-fetched metadata.
  check(
    "native metadata file matches the configured recorder-metadata SHA-256",
    fileSha(exp.recorderMetadataPath) === exp.recorderMetadataSha256,
  );
  const meta = JSON.parse(readFileSync(exp.recorderMetadataPath, "utf8"));
  check(
    "native recording id comes from the metadata, not only config",
    meta.recording_id === exp.nativeRecordingId &&
      meta.capture_recording_id === exp.nativeRecordingId &&
      meta.capture_result_valid === true &&
      meta.finalization_complete === true,
  );

  // Root's genuine completed-run report, compared to the database below.
  const report = JSON.parse(
    readFileSync(exp.actualExecutionEvidencePath, "utf8"),
  );
  const final = report.final ?? {};
  check(
    "the completed-run report names this recording, job and tested revision",
    report.ok === true &&
      report.recordingId === cfg.recordingId &&
      report.jobId === jobId &&
      report.source === exp.codeRevision,
  );

  const [job] = await q(
    `SELECT state, profile_revision, result_manifest_sha256, execution_call_id,
            invocation_nonce, source_manifest_sha256, recording_id
     FROM jobs WHERE id=$1`,
    [jobId],
  );
  const [inp] = await q(
    `SELECT execution_backend, code_revision, profile_revision, source_manifest_sha256
     FROM job_inputs WHERE job_id=$1`,
    [jobId],
  );
  const [cand] = await q(
    `SELECT status, outcome, clip_count, summary, invocation_nonce, manifest_sha256,
            inventory_sha256, verified_checks
     FROM job_result_candidates WHERE job_id=$1`,
    [jobId],
  );
  const [closure] = await q(
    "SELECT outcome, clip_count, invocation_nonce, inventory_sha256, file_count FROM job_output_closures WHERE job_id=$1",
    [jobId],
  );
  const [exe] = await q(
    "SELECT kind, execution_ref, recorded_by, detail FROM job_execution_evidence WHERE job_id=$1",
    [jobId],
  );
  const [slot] = await q("SELECT job_id FROM dispatch_admission WHERE slot=1");
  check(
    "job succeeded for this recording on the sealed source manifest",
    job?.state === "succeeded" &&
      job.recording_id === cfg.recordingId &&
      job.source_manifest_sha256 === exp.sourceManifestSha256 &&
      inp?.source_manifest_sha256 === exp.sourceManifestSha256,
  );
  check(
    "profile revision hand-pose-cpu-v1 on the local backend",
    job.profile_revision === "hand-pose-cpu-v1" &&
      inp.profile_revision === "hand-pose-cpu-v1" &&
      inp.execution_backend === "local",
  );
  check(
    "admitted processing code matches the tested runtime revision",
    inp.code_revision === report.source,
  );
  check(
    "candidate accepted, bound to this job's nonce and manifest",
    cand?.status === "accepted" &&
      cand.outcome === "succeeded" &&
      closure?.outcome === "succeeded" &&
      cand.invocation_nonce === job.invocation_nonce &&
      closure.invocation_nonce === job.invocation_nonce &&
      cand.manifest_sha256 === job.result_manifest_sha256 &&
      cand.inventory_sha256 === closure.inventory_sha256 &&
      cand.clip_count === closure.clip_count,
  );
  check(
    "execution evidence is a genuine reaped local child bound to this execution",
    exe?.kind === "local_child_reaped" &&
      exe.execution_ref === job.execution_call_id &&
      !/fixture/i.test(`${exe.recorded_by} ${JSON.stringify(exe.detail)}`),
    { recordedBy: exe.recorded_by },
  );
  check(
    "admission slot is released",
    slot.job_id === null || slot.job_id !== jobId,
  );
  check(
    "not a fixture/noop result",
    !/fixture|noop/i.test(
      JSON.stringify([cand.summary, cand.verified_checks, inp.code_revision]),
    ),
  );
  check(
    "root's report agrees with the database",
    final.state === "succeeded" &&
      final.candidate_status === "accepted" &&
      final.result_manifest_sha256 === job.result_manifest_sha256 &&
      final.execution_ref === job.execution_call_id &&
      final.evidence_kind === exe.kind &&
      final.clip_count === cand.clip_count &&
      final.holds_slot === false,
  );
  const verifiedRows = await q(
    `SELECT f.id, f.role, f.sha256, f.size_bytes
     FROM files f JOIN job_output_verifications v
       ON v.file_id=f.id AND v.sha256=f.sha256 AND v.size_bytes=f.size_bytes
     WHERE f.job_id=$1 AND f.purpose='output' ORDER BY f.role, f.id`,
    [jobId],
  );
  check(
    "all outputs (clip files + manifest) hash-verified by the server",
    verifiedRows.length === final.verified_count &&
      verifiedRows.length === final.output_count,
    { verified: verifiedRows.length, closureFileCount: closure.file_count },
  );
  const checks = Object.fromEntries(
    (cand.verified_checks ?? []).map((c) => [c.code, c]),
  );
  const m = checks.decode_and_inference_once?.measurements ?? {};
  check(
    "real decode+inference once per frame was recorded",
    checks.source_accepted?.status === "pass" &&
      checks.decode_and_inference_once?.status === "pass" &&
      m.frames_decoded === m.frames_inferred &&
      Number(m.frames_decoded) === meta.rgb_written_count,
    { frames: m.frames_decoded },
  );
  evidence.claims.sourceIntegrity =
    "catalog declarations match frozen digests; original bytes proven independently by root";
  evidence.ids = {
    recordingId: cfg.recordingId,
    nativeRecordingId: exp.nativeRecordingId,
    jobId,
    testedCodeRevision: exp.codeRevision,
    backendSource: report.source,
    resultManifestSha256: job.result_manifest_sha256,
    clipCount: cand.clip_count,
    profileRevision: job.profile_revision,
    codeRevisionRecorded: inp.code_revision,
    evidenceKind: exe.kind,
    executionRef: exe.execution_ref,
    framesDecoded: m.frames_decoded,
    framesInferred: m.frames_inferred,
  };

  // Read-only guard: the digest of every row we must never write.
  const frozen = async () =>
    createHash("sha256")
      .update(
        JSON.stringify(
          await Promise.all([
            q(
              "SELECT to_jsonb(f) j FROM files f WHERE recording_id=$1 ORDER BY id",
              [cfg.recordingId],
            ),
            q(
              "SELECT to_jsonb(j) j FROM jobs j WHERE recording_id=$1 ORDER BY id",
              [cfg.recordingId],
            ),
            q("SELECT to_jsonb(r) j FROM recordings r WHERE id=$1", [
              cfg.recordingId,
            ]),
            q(
              "SELECT to_jsonb(c) j FROM job_result_candidates c WHERE job_id=$1",
              [jobId],
            ),
            q(
              "SELECT to_jsonb(c) j FROM job_output_closures c WHERE job_id=$1",
              [jobId],
            ),
            q(
              "SELECT to_jsonb(v) j FROM job_output_verifications v WHERE job_id=$1 ORDER BY file_id",
              [jobId],
            ),
            q(
              "SELECT to_jsonb(e) j FROM job_execution_evidence e WHERE job_id=$1",
              [jobId],
            ),
            q("SELECT to_jsonb(c) j FROM clips c WHERE job_id=$1 ORDER BY id", [
              jobId,
            ]),
          ]),
        ),
      )
      .digest("hex");
  const frozenBefore = await frozen();
  evidence.ids.frozenRowsDigestBefore = frozenBefore;

  check(
    "operator CLI + owner database reachable (read-only list)",
    Array.isArray(operator(["list", "--dataset", randomUUID()])),
  );

  if (cand.clip_count === 0) {
    evidence.outcome = "no_clips: honest empty result; nothing to review";
    fail("Accepted result has zero clips; review phases cannot run");
  }

  // Discover the clip through the staff recording grid (never from config).
  const listed = data(
    await get(staff, `/api/v1/clips?recordingId=${cfg.recordingId}&limit=100`),
  );
  check(
    "staff recording grid lists the accepted clips",
    listed.clips.length === cand.clip_count,
  );
  const clip = listed.clips.find((c) => c.jobId === jobId);
  check("grid clip belongs to the accepted job", Boolean(clip));
  const clipId = clip.clipId;
  check(
    "grid clip matches root's report",
    (report.clips ?? []).some((c) => c.id === clipId),
  );
  evidence.ids.clipId = clipId;
  const clipRows = await q(
    `SELECT f.id, f.role, f.sha256, f.size_bytes, (v.file_id IS NOT NULL) AS verified
     FROM clips c JOIN files f ON f.id IN (c.rgb_mp4_file_id, c.hand_arrays_file_id,
       c.hand_observations_file_id, c.frame_map_file_id, c.thumbnail_file_id, c.viewer_rrd_file_id)
     LEFT JOIN job_output_verifications v ON v.file_id=f.id AND v.sha256=f.sha256
     WHERE c.id=$1`,
    [clipId],
  );
  check(
    "six clip outputs, all hash-verified by acceptance",
    clipRows.length === 6 && clipRows.every((o) => o.verified),
  );
  evidence.ids.outputs = clipRows.map((o) => ({
    role: o.role,
    sha256: o.sha256,
    size: o.size_bytes,
  }));

  const viewerRow = clipRows.find((o) => o.role === "viewer_rrd");
  const issue = (jar, role, path = `/api/v1/clips/${clipId}/reads`) =>
    send(jar, path, { role });
  const first = await issue(staff, "viewer_rrd");
  check("staff broker read issued", first.status === 200);
  const issued = data(first);
  const proof = await sha256Stream(issued.url);
  check(
    "streamed viewer_rrd bytes equal the accepted size and SHA-256 (real file, no golden RRD)",
    proof.sha256 === viewerRow.sha256 &&
      String(proof.size) === String(viewerRow.size_bytes),
  );
  evidence.ttlSecondsReported = issued.ttlSeconds;
  check("broker TTL is bounded to 60 s", issued.ttlSeconds <= 60);

  // ---------------------------------------------------- shared helpers
  const reviewPath = `/api/v1/clips/${clipId}/review`;
  const reviewState = async () => data(await get(staff, reviewPath));
  const reviewCount = async () =>
    Number(
      (await q("SELECT count(*) n FROM reviews WHERE clip_id=$1", [clipId]))[0]
        .n,
    );
  const members = async () =>
    (
      await q(
        "SELECT dataset_id FROM dataset_clips WHERE clip_id=$1 ORDER BY 1",
        [clipId],
      )
    ).map((r) => r.dataset_id);
  const dsRev = async (id) =>
    (await q("SELECT revision FROM datasets WHERE id=$1", [id]))[0].revision;
  const post = (body) => send(staff, reviewPath, body);

  async function browserPass(label, jar, isStaff) {
    const b = new Browser(label, jar);
    const clipPath = `/clips/${clipId}`;
    const canvases =
      "document.querySelectorAll('[data-testid=clip-viewer-host]:not(.invisible) canvas').length";
    const recordingGrid = `/data-browser?recordingId=${cfg.recordingId}`;
    const clipSelector = `a[href*="/clips/${clipId}"]`;
    const loaded = () =>
      !/Loading (Rerun|clip)/.test(b.ev("document.body.innerText"));
    const shoot = async (name) => {
      for (const w of [1280, 375]) {
        b.ab("set", "viewport", String(w), "900");
        await sleep(1500);
        await until(loaded, `${name} viewer finished loading`, 120);
        const file = `${outDir}browser/${name}-${w}.png`;
        b.ab("screenshot", file, "--full");
        screenshots.push(file.split("/").pop());
      }
    };
    b.ab("set", "viewport", "1280", "900");
    if (isStaff) {
      b.ab("open", `${origin}/pipeline/${cfg.recordingId}`);
      await until(
        () =>
          b.ev("(document.querySelector('main')?.innerText.length ?? 0) > 0"),
        "pipeline detail",
      );
      check(
        "staff Pipeline detail loads for the recording",
        b.ev("location.pathname") === `/pipeline/${cfg.recordingId}`,
        {
          pathname: b.ev("location.pathname"),
          title: b.ev("document.title"),
          mainChars: b.ev(
            "document.querySelector('main')?.innerText.length ?? 0",
          ),
        },
      );
      await until(
        () =>
          b.ev(
            "Boolean(document.querySelector('a[href^=\"/data-browser?recordingId=\"]'))",
          ),
        "Pipeline links to the recording clips",
      );
      b.ab("click", 'a[href^="/data-browser?recordingId="]');
      await until(
        () => b.ev("location.pathname + location.search") === recordingGrid,
        "recording filter in the Data browser URL",
      );
      await until(
        () =>
          b.ev(
            `Boolean(document.querySelector('a[href*="/clips/${clipId}"]'))`,
          ),
        "recording-filtered grid shows the clip",
      );
      check("recording grid links to the discovered clip", true);
      await shoot(`${label}-grid`);
      b.ab("click", clipSelector);
      await until(
        () => b.ev("location.pathname") === clipPath,
        "grid click opens the clip",
      );
      b.ab("click", `main a[href="${recordingGrid}"]`);
      await until(
        () =>
          b.ev("location.pathname + location.search") === recordingGrid &&
          b.ev(
            `Boolean(document.querySelector(${JSON.stringify(clipSelector)}))`,
          ),
        "Back to Data browser restores the recording filter and clip",
      );
      check(
        "Back to Data browser restores the recording-filtered clip grid",
        true,
      );
      b.ab("click", clipSelector);
    } else {
      b.ab("open", origin + clipPath);
    }
    await until(() => b.ev(canvases) > 0, `${label} Rerun canvas`, 120);
    check(
      `${label}: opens the SAME clip URL`,
      b.ev("location.pathname") === clipPath,
    );
    if (isStaff) {
      await until(
        () => b.ev("Boolean(document.querySelector('#task-label'))"),
        "staff review editor",
      );
      check("staff: review editor present beside the real viewer", true);
    } else {
      check(
        "customer: no review editor or notes",
        b.ev(
          "!document.querySelector('#task-label') && !document.querySelector('#review-notes')",
        ),
      );
    }
    check(
      `${label}: no release/export action`,
      !b.ev(
        "[...document.querySelectorAll('button,a')].some(e=>/\\b(export|release)\\b/i.test(e.textContent))",
      ),
    );
    return { b, shoot, canvases };
  }

  // ============================================================ probe
  if (PHASE === "probe" || PHASE === "trace") {
    if (PHASE === "probe") {
      const { shoot } = await browserPass("staff-probe", staff, true);
      await shoot("staff-probe-clip");
    }
    check(
      "read-only phase wrote no source/job/acceptance rows",
      (await frozen()) === frozenBefore,
    );
    evidence.screenshots = screenshots;
    evidence.finishedAt = new Date().toISOString();
    evidence.outcome = `${PHASE} phase passed (read-only)`;
    flush();
    console.log(`SA-40 ${PHASE} checks passed: ${evidence.checks.length}`);
    return;
  }

  // ============================================================ Phase 2
  const resume = PHASE === "access" || PHASE === "browser";
  const st0 = await reviewState();
  if (!resume) {
    check(
      "clip is current and still unreviewed (fail closed on reuse)",
      st0.current && st0.review.revision === 0 && (await reviewCount()) === 0,
    );
    check(
      "clip is invisible to the customer while unreviewed",
      (await get(customer, `/api/v1/clips/${clipId}`)).status === 404,
    );
  }

  const tag = `sa40-${new Date().toISOString().slice(0, 10)}`;
  let datasets;
  if (resume) {
    datasets = JSON.parse(
      readFileSync(
        process.env.SA40_RESUME_EVIDENCE ?? fail("SA40_RESUME_EVIDENCE unset"),
        "utf8",
      ),
    ).ids.datasets;
    check(
      "resume: both prior SA40 datasets exist",
      datasets.length === 2 &&
        (
          await q("SELECT count(*)::int n FROM datasets WHERE id = ANY($1)", [
            datasets,
          ])
        )[0].n === 2,
    );
  } else {
    datasets = [randomUUID(), randomUUID()];
    for (const [i, datasetId] of datasets.entries())
      check(
        `dataset ${i + 1} created through the API`,
        (
          await send(staff, "/api/v1/datasets", {
            datasetId,
            name: `${tag}-${i + 1}`,
          })
        ).status === 201,
      );
  }
  evidence.ids.datasets = datasets;
  const command = (state, over = {}) => ({
    reviewId: randomUUID(),
    expectedReviewRevision: state.review.revision,
    jobId: state.jobId,
    resultManifestSha256: state.resultManifestSha256,
    decision: "approved",
    taskLabel: `${tag} label A`,
    ...over,
  });
  // expectedRevisions must cover every dataset the change touches: the
  // desired set plus the clip's current memberships.
  const selection = async (ids) => {
    const touched = [...new Set([...ids, ...(await members())])];
    return {
      datasetIds: ids,
      expectedRevisions: Object.fromEntries(
        await Promise.all(touched.map(async (d) => [d, await dsRev(d)])),
      ),
    };
  };

  let state = st0;
  let latestLabel;
  if (!resume) {
    // Rolled-back writes: nothing changes on blank/stale/wrong-result input.
    for (const [name, body] of [
      ["blank label", command(state, { taskLabel: "   " })],
      ["stale review revision", command(state, { expectedReviewRevision: 7 })],
      [
        "changed result hash",
        command(state, { resultManifestSha256: "0".repeat(64) }),
      ],
      ["wrong job identity", command(state, { jobId: randomUUID() })],
      [
        "stale dataset revision",
        command(state, {
          datasetSelection: {
            datasetIds: [datasets[0]],
            expectedRevisions: { [datasets[0]]: 99 },
          },
        }),
      ],
    ]) {
      const res = await post(body);
      check(
        `${name} refused (4xx) and rolled back`,
        res.status >= 400 &&
          res.status < 500 &&
          (await reviewCount()) === 0 &&
          (await members()).length === 0,
        { status: res.status },
      );
    }

    // Approve while unassigned; then assign to two datasets.
    let res = await post(command(state));
    check(
      "approve an unassigned clip",
      res.status === 201 && (await members()).length === 0,
    );
    state = await reviewState();
    const rcAssign = await reviewCount();
    res = await post(
      command(state, { datasetSelection: await selection(datasets) }),
    );
    check(
      "assign to two datasets",
      res.status === 201 &&
        (await members()).length === 2 &&
        (await reviewCount()) === rcAssign + 1,
    );
    state = await reviewState();

    // Two concurrent writers at the same revision: exactly one wins.
    const rc = await reviewCount();
    const racers = await Promise.all(
      ["B", "C"].map((x) =>
        post(command(state, { taskLabel: `${tag} label ${x}` })),
      ),
    );
    const codes = racers.map((r) => r.status).sort();
    check(
      "concurrent writers: one 201, one 409, one new row",
      codes[0] === 201 && codes[1] === 409 && (await reviewCount()) === rc + 1,
      { codes },
    );
    state = await reviewState();
    check(
      "loser did not overwrite the winner; memberships intact",
      /label [BC]$/.test(state.review.taskLabel) &&
        (await members()).length === 2,
    );

    // Replay is idempotent; changed body under the same key conflicts.
    const replayBody = command(state, { taskLabel: `${tag} label D` });
    const created = await post(replayBody);
    const replay = await post(replayBody);
    check(
      "identical replay returns the stored review (200, no new row)",
      created.status === 201 &&
        replay.status === 200 &&
        (await reviewCount()) === rc + 2,
    );
    const conflict = await post({ ...replayBody, taskLabel: `${tag} label E` });
    check(
      "changed body under the same reviewId conflicts (409, no new row)",
      conflict.status === 409 && (await reviewCount()) === rc + 2,
    );
    state = await reviewState();

    // Reject removes ALL memberships; reapprove does NOT restore them.
    const dsBeforeReject = await Promise.all(datasets.map(dsRev));
    res = await post(
      command(state, { decision: "rejected", taskLabel: undefined }),
    );
    check(
      "reject removes every membership",
      res.status === 201 && (await members()).length === 0,
    );
    const dsAfterReject = await Promise.all(datasets.map(dsRev));
    check(
      "each dataset revision bumped once",
      dsAfterReject.every((r, i) => r === dsBeforeReject[i] + 1),
    );
    state = await reviewState();
    res = await post(command(state, { taskLabel: `${tag} latest approved` }));
    check(
      "reapprove with omitted selection restores nothing",
      res.status === 201 && (await members()).length === 0,
    );
    state = await reviewState();
    check(
      "latest review is approved with the latest label",
      state.review.decision === "approved" &&
        state.review.taskLabel === `${tag} latest approved`,
    );
    latestLabel = state.review.taskLabel;
  } else {
    latestLabel = st0.review.taskLabel;
    check(
      "resume: latest review approved and member of dataset 1 only",
      st0.review.decision === "approved" &&
        (await members()).join() === datasets[0],
    );
  }

  // ============================================================ Phase 3
  const D1 = datasets[0];
  const ref = (n) => `sa40-${Date.now()}-${n}`;
  let evidenceRef = ref(1);
  if (resume) {
    const active = await q(
      "SELECT permission_ref FROM dataset_sharing_permissions WHERE dataset_id=$1 AND status='active'",
      [D1],
    );
    check("resume: exactly one active evidence row on D1", active.length === 1);
    evidenceRef = active[0].permission_ref;
  }
  const operatorId = "sa40-driver";
  async function assignD1() {
    const s = await reviewState();
    const body = () => ({ taskLabel: s.review.taskLabel });
    const r = await post(
      command(s, { ...body(), datasetSelection: await selection([D1]) }),
    );
    if (r.status === 201) return r;
    // Shared dataset needs the clip cleared on active evidence first.
    operator([
      "clear",
      "--ref",
      evidenceRef,
      "--clips",
      clipId,
      "--by",
      operatorId,
    ]);
    const s2 = await reviewState();
    return post(
      command(s2, {
        taskLabel: s2.review.taskLabel,
        datasetSelection: await selection([D1]),
      }),
    );
  }
  if (!resume) {
    check(
      "assign D1 before any recipient exists",
      (await assignD1()).status === 201,
    );
    operator([
      "record",
      "--ref",
      evidenceRef,
      "--dataset",
      D1,
      "--recipient",
      cfg.users.customer.id,
      "--evidence",
      `sa40-local-evidence-${evidenceRef}`,
      "--by",
      operatorId,
    ]);
    operator([
      "clear",
      "--ref",
      evidenceRef,
      "--all-members",
      "--by",
      operatorId,
    ]);
    operator(["grant", "--ref", evidenceRef, "--actor", cfg.users.staff.id]);
  }

  if (PHASE !== "browser") {
    const cust = (path) => get(customer, path);
    const visible = async () =>
      (await cust(`/api/v1/clips/${clipId}`)).status === 200;
    check("granted customer sees the same clip", await visible());
    const cdto = data(await cust(`/api/v1/clips/${clipId}`));
    const allowed = new Set([
      "clipId",
      "datasetId",
      "title",
      "taskLabel",
      "durationNs",
      "raster",
      "frameCount",
      "simulation",
      "media",
    ]);
    check(
      "customer DTO is the whitelist (no recording/job/hash/notes/QC fields)",
      Object.keys(cdto).every((k) => allowed.has(k)),
      { keys: Object.keys(cdto) },
    );
    check(
      "customer sees the latest approved label",
      cdto.taskLabel === latestLabel,
    );
    check(
      "customer DTO flags simulation-only",
      cdto.simulation?.productionQualified === false,
    );
    const dsDto = data(await cust(`/api/v1/datasets/${D1}/clips/${clipId}`));
    check(
      "dataset-context clip DTO is the same whitelist",
      dsDto.clipId === clipId &&
        Object.keys(dsDto).every((k) => allowed.has(k)),
    );
    const custDatasets = data(await cust("/api/v1/datasets")).datasets;
    check(
      "customer dataset list includes the granted dataset and not the ungranted one",
      custDatasets.some((d) => d.datasetId === D1) &&
        !custDatasets.some((d) => d.datasetId === datasets[1]),
    );
    for (const [what, r] of [
      ["catalog list", await cust("/api/v1/clips")],
      [
        "catalog list by recording",
        await cust(`/api/v1/clips?recordingId=${cfg.recordingId}`),
      ],
      ["review state", await cust(reviewPath)],
      ["review write", await send(customer, reviewPath, command(state))],
      [
        "recording detail (raw source path)",
        await cust(`/api/v1/recordings/${cfg.recordingId}`),
      ],
      ["ungranted dataset", await cust(`/api/v1/datasets/${datasets[1]}`)],
    ])
      check(`customer denied: ${what}`, DENIED.includes(r.status), {
        status: r.status,
      });
    check(
      "ungranted dataset is indistinguishable from missing",
      (await cust(`/api/v1/datasets/${datasets[1]}`)).status === 404,
    );
    for (const role of [
      "source_mcap",
      "recorder_metadata",
      "source_manifest",
      "clip_mp4",
      "hand_arrays_npz",
      "hand_observations_json",
      "frame_map_json",
      "result_manifest",
    ]) {
      const r = await send(customer, `/api/v1/clips/${clipId}/reads`, { role });
      check(
        `customer cannot broker ${role}`,
        r.status >= 400 && r.status < 500,
        {
          status: r.status,
        },
      );
    }
    for (const role of ["source_mcap", "clip_mp4"]) {
      const r = await send(staff, `/api/v1/clips/${clipId}/reads`, { role });
      check(
        `even staff cannot broker raw/derived ${role}`,
        r.status >= 400 && r.status < 500,
        { status: r.status },
      );
    }
    for (const [who, jar] of [
      ["anonymous", new Jar()],
      ["collector", collector],
      ["outsider", outsider],
    ]) {
      const r = await get(jar, `/api/v1/clips/${clipId}`);
      const rv = await get(jar, reviewPath);
      const rd = await send(jar, `/api/v1/clips/${clipId}/reads`, {
        role: "viewer_rrd",
      });
      check(
        `${who} denied clip, review and read broker`,
        DENIED.includes(r.status) &&
          DENIED.includes(rv.status) &&
          DENIED.includes(rd.status),
        { clip: r.status, review: rv.status, reads: rd.status },
      );
    }
    const customerRead = await issue(customer, "viewer_rrd");
    check(
      "customer receives the same real viewer bytes",
      customerRead.status === 200 &&
        (await sha256Stream(data(customerRead).url)).sha256 ===
          viewerRow.sha256,
    );

    // ============================================================ Phase 4
    // Fresh metadata and URL issuance are denied after each revocation. A URL
    // issued just before is probed once right after (recorded, not hidden) and
    // a dedicated measurement follows its life to expiry.
    async function revokeAndExpectDenied(name, revoke, statuses = [404]) {
      const before = data(await issue(customer, "viewer_rrd"));
      const issuedAt = Date.now();
      await revoke();
      const meta = (await cust(`/api/v1/clips/${clipId}`)).status;
      const url = (await issue(customer, "viewer_rrd")).status;
      const thumb = (await issue(customer, "thumbnail_jpeg")).status;
      const list = (await cust(`/api/v1/datasets/${D1}/clips`)).status;
      const prior = await probeUrl(before.url);
      evidence.revocation.push({
        name,
        freshMetadata: meta,
        freshViewerUrl: url,
        freshThumbnailUrl: thumb,
        datasetClipList: list,
        previouslyIssuedUrlStatus: prior,
        previouslyIssuedAgeMs: Date.now() - issuedAt,
      });
      check(
        `${name}: fresh metadata and URL issuance denied`,
        statuses.includes(meta) &&
          statuses.includes(url) &&
          statuses.includes(thumb),
        { meta, url, thumb },
      );
    }
    const expectAllowed = async (name) =>
      check(`${name}: access restored`, await visible());

    await revokeAndExpectDenied("dataset access disabled", async () =>
      operator([
        "disable",
        "--dataset",
        D1,
        "--recipient",
        cfg.users.customer.id,
        "--actor",
        cfg.users.staff.id,
      ]),
    );
    operator(["grant", "--ref", evidenceRef, "--actor", cfg.users.staff.id]);
    await expectAllowed("re-grant");

    await revokeAndExpectDenied(
      "membership removal via atomic review",
      async () => {
        const s = await reviewState();
        const r = await post(
          command(s, {
            taskLabel: s.review.taskLabel,
            datasetSelection: await selection([]),
          }),
        );
        check(
          "membership removal committed",
          r.status === 201 && (await members()).length === 0,
        );
      },
    );
    check("re-add membership explicitly", (await assignD1()).status === 201);
    await expectAllowed("membership re-add");

    await revokeAndExpectDenied(
      "latest-review rejection (withdrawal)",
      async () => {
        const s = await reviewState();
        check(
          "rejection committed",
          (
            await post(
              command(s, { decision: "rejected", taskLabel: undefined }),
            )
          ).status === 201,
        );
      },
    );
    const sRe = await reviewState();
    check(
      "reapprove",
      (await post(command(sRe, { taskLabel: latestLabel }))).status === 201,
    );
    check(
      "rejection removed membership; reapprove did not restore it",
      (await members()).length === 0 && !(await visible()),
    );
    check("explicit reassign", (await assignD1()).status === 201);
    await expectAllowed("explicit reassign");

    await revokeAndExpectDenied(
      "sharing-evidence (grant) revocation",
      async () =>
        operator([
          "revoke",
          "--ref",
          evidenceRef,
          "--by",
          operatorId,
          "--reason",
          "sa40 revocation check",
        ]),
    );
    evidenceRef = ref(2);
    operator([
      "record",
      "--ref",
      evidenceRef,
      "--dataset",
      D1,
      "--recipient",
      cfg.users.customer.id,
      "--evidence",
      `sa40-local-evidence-${evidenceRef}`,
      "--by",
      operatorId,
    ]);
    operator([
      "clear",
      "--ref",
      evidenceRef,
      "--all-members",
      "--by",
      operatorId,
    ]);
    operator(["grant", "--ref", evidenceRef, "--actor", cfg.users.staff.id]);
    await expectAllowed("new evidence + grant");

    // Customer account access disabled (temporary; restored in finally).
    const [acc] = await q(
      "SELECT enabled FROM access WHERE user_id=$1 AND role='customer'",
      [cfg.users.customer.id],
    );
    check("customer role row exists and is enabled", acc?.enabled === true);
    restoreCustomerRole = { was: true };
    await revokeAndExpectDenied(
      "customer account access disabled",
      async () => {
        await owner.query(
          "UPDATE access SET enabled=false WHERE user_id=$1 AND role='customer'",
          [cfg.users.customer.id],
        );
      },
      [401, 403, 404],
    );
    await owner.query(
      "UPDATE access SET enabled=true WHERE user_id=$1 AND role='customer'",
      [cfg.users.customer.id],
    );
    restoreCustomerRole = null;
    await expectAllowed("customer account access re-enabled");

    // Measured lifetime of an already issued URL after revocation.
    const measured = data(await issue(customer, "viewer_rrd"));
    const t0 = Date.now();
    operator([
      "disable",
      "--dataset",
      D1,
      "--recipient",
      cfg.users.customer.id,
      "--actor",
      cfg.users.staff.id,
    ]);
    const samples = [];
    let firstRefusedS = null;
    for (let age = 0; age < 90_000; age = Date.now() - t0) {
      const status = await probeUrl(measured.url);
      samples.push({ ageS: Math.round((Date.now() - t0) / 100) / 10, status });
      if (status >= 400) {
        firstRefusedS = (Date.now() - t0) / 1000;
        break;
      }
      await sleep(4000);
    }
    evidence.urlLifetime = {
      ttlSecondsReported: measured.ttlSeconds,
      expiresAt: measured.expiresAt,
      samples,
      firstRefusedAfterIssueS: firstRefusedS,
      note: "an already issued presigned URL cannot be recalled; fresh issuance is denied immediately",
    };
    check(
      "already issued URL is refused within the 60 s hard maximum",
      firstRefusedS !== null && firstRefusedS <= 65,
      { firstRefusedS },
    );
    operator(["grant", "--ref", evidenceRef, "--actor", cfg.users.staff.id]);
    await expectAllowed("final re-grant");
  }

  // ============================================================ Phase 5
  const finalState = await reviewState();
  check(
    "final state: approved, member of D1 only, latest label",
    finalState.review.decision === "approved" &&
      finalState.review.taskLabel === latestLabel &&
      (await members()).join() === D1,
  );
  const s = await browserPass("staff", staff, true);
  check(
    "staff sees the latest approved label",
    s.b.ev("document.querySelector('#task-label').value") === latestLabel,
  );
  await s.shoot("staff-clip");
  s.b.close(); // two live Chromes exceed the guard's pids limit
  const c = await browserPass("customer", customer, false);
  check(
    "customer sees the latest approved label",
    c.b.ev("document.body.innerText").includes(latestLabel),
  );
  await c.shoot("customer-clip");

  check(
    "no source/job/acceptance/evidence row was written by this qualification",
    (await frozen()) === frozenBefore,
  );
  evidence.screenshots = screenshots;
  evidence.finishedAt = new Date().toISOString();
  evidence.outcome = "all checks passed (simulation-only, software WebGL)";
  flush();
  console.log(`SA-40 qualification checks passed: ${evidence.checks.length}`);
}
