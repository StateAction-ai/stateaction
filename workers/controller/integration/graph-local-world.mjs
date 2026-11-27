import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { call, freePort, sha, startWorld } from "./harness.mjs";
import {
  findChrome,
  launchChrome,
} from "../../../apps/web/test-e2e/chrome.mjs";
import { requestSha256 } from "../../../packages/contracts/dist/index.js";
import { jobsDepsFromEnv } from "../../../packages/server/dist/jobs/next.js";
import {
  failUndispatched,
  finalizeCancellations,
} from "../../../packages/server/dist/jobs/recovery.js";
import {
  admitNextJob,
  requestJobCancel,
} from "../../../packages/server/dist/jobs/service.js";
import cpuGraph from "../../../recipes/compiled/cpu_hand_canary.json" with { type: "json" };
import hand from "../../processing/src/stateaction_processing/hand_model.json" with { type: "json" };

import defaultGraph from "../../../recipes/compiled/indego_hosted_canary.json" with { type: "json" };
import checkpoints from "../../../packages/contracts/api/flora-checkpoints.v1.json" with { type: "json" };

const graph = process.argv[2] === "default" ? defaultGraph : cpuGraph;
const earlyRetry = process.argv[2] === "early-retry";
const nodes = (scope) =>
  Object.keys(graph.nodes)
    .filter((id) => graph.nodes[id].scope === scope)
    .sort();
const label = (id) => id[0].toUpperCase() + id.slice(1).replaceAll("_", " ");
const revision = "a".repeat(40);
const bindings = Object.fromEntries(
  Object.values(graph.nodes).map((node) => [
    node.module,
    {
      mode: node.resources.gpu ? "local_replay" : "local_cpu",
      definitionFormat: "local",
      codeRevision: revision,
      imageSha256: "b".repeat(64),
      definitionSha256: "c".repeat(64),
      moduleLockSha256: node.moduleLockSha256,
      paramsSha256: requestSha256(node.params),
      gpu: node.resources.gpu,
      maxContainers: 1,
      maxBilledSeconds: 1800,
      microUsdPerCpuSecond: 0,
      microUsdPerGpuSecond: node.resources.gpu ? 100 : 0,
      environment: "local",
      ...(node.module === "hand_pose_cpu@1"
        ? { modelSha256: hand.sha256 }
        : {}),
      ...(node.resources.gpu ? replayBinding(node.module) : {}),
    },
  ]),
);
function replayBinding(module) {
  const pin =
    checkpoints.checkpoints[
      module === "flora_tempseg_vllm_fp8@1" ? "tempseg" : "captioner"
    ];
  return {
    volumeName: checkpoints.volumeName,
    volumeVersion: checkpoints.volumeVersion,
    volumeManifestSha256: pin.manifestSha256,
    modelRevision: pin.modelRevision,
    definitionId: "def-local",
    functionId: "fu-local",
    imageId: "im-local",
    modelSha256: "d".repeat(64),
    promptSha256: "e".repeat(64),
  };
}

function prepareReplay(mcap, root, failedWindows = 1) {
  const sourceSha256 = sha(mcap);
  const fixtures = "workers/processing/tests/fixtures/flora_native";
  const source = (file) =>
    JSON.parse(readFileSync(join(fixtures, file), "utf8"));
  const destination = join(root, sourceSha256, "flora");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const segments = source("segments_failed_window.json");
  segments.source = { ...segments.source, frames: 5, sha256: sourceSha256 };
  segments.segments = [{ ...segments.segments[0], end_frame_exclusive: 1 }];
  segments.windows = {
    total: failedWindows + 1,
    failed: Array.from({ length: failedWindows }, (_, index) => ({
      window_index: index + 1,
      error_code: "fixture_failure",
      start_s: 0.025 * (index + 1),
      end_s: index + 1 === failedWindows ? 1 : 0.025 * (index + 2),
    })),
  };
  const bytes = JSON.stringify(segments);
  writeFileSync(join(destination, "segments.json"), bytes);
  const captions = source("captions_failed_window.json");
  captions.source_sha256 = sourceSha256;
  captions.segments_sha256 = sha(bytes);
  captions.captions = captions.captions.slice(0, 1);
  writeFileSync(join(destination, "captions.json"), JSON.stringify(captions));
  writeFileSync(
    join(destination, "env.json"),
    readFileSync(join(fixtures, "env.json")),
  );
}

const runnerPort = await freePort();
const world = await startWorld({
  RENDER_USE_LOCAL_DEV: "true",
  RENDER_LOCAL_DEV_URL: "http://127.0.0.1:" + runnerPort,
  PROCESSING_CODE_REVISION: revision,
  PROCESSING_IMAGE_SPEC_SHA256: "b".repeat(64),
  PROCESSING_MODEL_SHA256: hand.sha256,
  STATEACTION_CAPTURE_RECIPE_SELECTION: "manual",
  STATEACTION_GRAPH_BINDINGS: JSON.stringify(bindings),
});
let runner;
let runnerClosed;
let chrome;

async function openStaffBrowser(browser) {
  const chromeBinary = await findChrome();
  assert.ok(chromeBinary, "Chrome is required for the staff graph fixture");
  chrome = await launchChrome(chromeBinary);
  for (const cookie of browser.cookies) {
    const separator = cookie.indexOf("=");
    assert.ok(separator > 0);
    assert.equal(
      (
        await chrome.send("Network.setCookie", {
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          url: world.origin,
          httpOnly: true,
        })
      ).success,
      true,
    );
  }
  async function navigate(url) {
    const { errorText } = await chrome.send("Page.navigate", { url });
    assert.equal(errorText, undefined);
  }
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await chrome.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    assert.ok(!exceptionDetails, "The local browser probe threw");
    return result.value;
  };
  const until = async (probe, description) => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const result = await probe();
      if (result) return result;
      assert.ok(Date.now() < deadline, description);
      await wait(100);
    }
  };
  const click = (label) =>
    evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find(
      node => node.textContent.trim() === ${JSON.stringify(label)} && !node.disabled
    );
    if (!button || !Object.keys(button).some(key => key.startsWith("__reactProps$"))) return false;
    button.click();
    return true;
  })()`);
  return { navigate, evaluate, until, click };
}
async function retryBeforeAnyResult({
  browser,
  recordingId,
  clipId,
  clipJobId,
  runJob,
}) {
  const deps = jobsDepsFromEnv(world.app, world.env);
  const getClip = async () => {
    const {
      rows: [clip],
    } = await world.owner.query(
      "SELECT live_job_id, selected_job_id FROM review_clips WHERE id = $1",
      [clipId],
    );
    assert.equal(clip.selected_job_id, null);
    return clip.live_job_id;
  };
  async function settle(jobId, cancelled) {
    const admission = await admitNextJob(deps);
    assert.equal(admission.job?.jobId, jobId);
    const repair = { jobId, recordedBy: "fixture-repair", limit: 1 };
    if (cancelled) {
      assert.equal(
        (await requestJobCancel(deps, jobId)).state,
        "cancel_requested",
      );
      assert.deepEqual(await finalizeCancellations(deps, repair), [jobId]);
    } else {
      assert.deepEqual(
        await failUndispatched(
          {
            ...deps,
            config: { ...deps.config, repair: { dispatchWindowSeconds: 0 } },
          },
          repair,
        ),
        [jobId],
      );
    }
    const { rows } = await world.owner.query(
      `SELECT r.node_id, r.state, r.error_code, j.kind AS proof, c.job_id IS NULL AS no_claim
       FROM job_recipe_node_results r JOIN job_execution_evidence j USING (job_id)
       LEFT JOIN job_recipe_node_claims c USING (job_id,node_id)
       WHERE r.job_id = $1`,
      [jobId],
    );
    assert.deepEqual(rows, [
      {
        node_id: "track_hands",
        state: "skipped",
        error_code: "never_submitted",
        proof: "pre_submission_rejected",
        no_claim: true,
      },
    ]);
  }

  await settle(clipJobId, true);
  const { navigate, evaluate, until, click } = await openStaffBrowser(browser);
  await chrome.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 900,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const recordingPath = "/recordings/" + recordingId;
  async function retry(path, parent, batch) {
    await navigate(world.origin + path);
    await until(
      () =>
        evaluate(
          `location.pathname === ${JSON.stringify(path)} && !!document.querySelector("main h1")`,
        ),
      "The retry page did not load",
    );
    assert.ok(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
    );
    if (!batch) {
      assert.ok(
        await evaluate(`Array.from(document.querySelectorAll("button"))
        .some(b => b.textContent.trim() === "Open processed clip" && b.disabled &&
          document.getElementById(b.getAttribute("aria-describedby"))?.textContent.includes("cancelled"))`),
      );
    }
    await until(
      () => click("Retry failed steps"),
      "The retry action did not hydrate",
    );
    await until(
      () =>
        evaluate(`(() => {
      const dialog = document.querySelector("dialog[open]");
      if (dialog?.querySelector("[role=alert]")) throw Error("Retry preview refused");
      const text = dialog?.textContent ?? "";
      return text.includes("Runs track hands") && text.includes("Maximum cost") &&
        (!${batch} || text.includes("Clip 1"));
    })()`),
      "The retry preview must list the hand node and cost",
    );
    await until(
      () => click("Start retry"),
      "The retry confirmation did not hydrate",
    );
    const next = await until(async () => {
      const live = await getClip();
      return live !== parent && live;
    }, "The confirmation did not create a retry");
    const { rows } = await world.owner.query(
      `SELECT j.derived_from_job_id, j.state, p.plan -> 'execute' AS nodes,
              p.plan -> 'reuse' AS kept
       FROM jobs j JOIN job_rerun_plans p ON p.job_id = j.id WHERE j.id = $1`,
      [next],
    );
    assert.deepEqual(rows, [
      {
        derived_from_job_id: parent,
        state: "queued",
        nodes: ["track_hands"],
        kept: [],
      },
    ]);
    return next;
  }

  const leaf = await retry(
    recordingPath + "/clips/" + clipId + "/processing",
    clipJobId,
    false,
  );
  await settle(leaf, false);
  const batch = await retry(recordingPath, leaf, true);
  assert.equal(await getClip(), batch);
  assert.equal(await runJob(batch), "succeeded");
  const { rows } = await world.owner.query(
    `SELECT c.selected_job_id, n.node_id FROM review_clips c
     JOIN job_recipe_node_claims n ON n.job_id = c.selected_job_id WHERE c.id = $1`,
    [clipId],
  );
  assert.deepEqual(rows, [{ selected_job_id: batch, node_id: "track_hands" }]);
  console.log(
    JSON.stringify({
      beforeAnyResult: true,
      browserClipRetry: true,
      browserBatchRetry: true,
    }),
  );
}

async function failBeforeCaptionClaim(jobId, handNode) {
  const deps = jobsDepsFromEnv(world.app, world.env);
  assert.equal((await admitNextJob(deps)).job?.jobId, jobId);
  const path = "/internal/v1/jobs/" + jobId;
  const owner = "unclaimed-caption-fixture";
  const send = async (route, body) => {
    const response = await call(world.origin, path + route, {
      method: "POST",
      body: { owner, ...body },
      token: world.workflow.token,
    });
    assert.equal(response.status, 200, body.action);
    return response.json.data;
  };
  assert.equal(
    (
      await send("/controller", {
        action: "claim_lease",
        runRef: "local-unclaimed-caption",
      })
    ).granted,
    true,
  );
  const prepare = () => send("/graph", { action: "prepare_graph" });
  let prepared = await prepare();
  for (let index = 0; prepared.state === "copying" && index < 64; index++) {
    prepared = await prepare();
  }
  assert.equal(prepared.state, "ready");
  const node = (action, facts = {}) =>
    send("/graph", { action, nodeId: "caption", ...facts });
  assert.equal(
    (
      await node("issue_node_claim", {
        bindingSha256: requestSha256(bindings[graph.nodes.caption.module]),
      })
    ).state,
    "issued",
  );
  assert.equal((await node("begin_node_submission")).state, "started");
  const executionRef = "local-caption-no-claim";
  await node("record_node_call", { executionRef });
  await node("record_node_terminal", {
    executionRef,
    kind: "local_child_reaped",
    observed: { exitCode: 1 },
  });
  await node("record_node_result", {
    state: "failed",
    errorCode: "node_receipt_unavailable",
    files: [],
    receipt: null,
  });
  assert.equal(
    (await send("/graph", { action: "seal_graph" })).state,
    "recorded",
  );
  const { rows } = await world.owner.query(
    `SELECT j.state,j.claimed_at,j.error_code,e.kind AS proof, hand.state AS hand,
            NOT EXISTS (SELECT 1 FROM dispatch_admission WHERE job_id = j.id) AS slot_released,
            NOT EXISTS (SELECT 1 FROM job_result_candidates WHERE job_id = j.id) AS no_candidate
     FROM jobs j JOIN job_execution_evidence e ON e.job_id = j.id
     JOIN job_recipe_node_results hand ON hand.job_id = j.id AND hand.node_id = $2
     WHERE j.id = $1`,
    [jobId, handNode],
  );
  assert.deepEqual(rows, [
    {
      state: "failed",
      claimed_at: null,
      error_code: "graph_worker_unclaimed",
      proof: "graph_nodes_terminal",
      hand: "succeeded",
      slot_released: true,
      no_candidate: true,
    },
  ]);
}

async function exerciseGraph() {
  const controllerPython = join(
    process.cwd(),
    "workers/controller/.venv/bin/python",
  );
  const processingPython = join(
    process.cwd(),
    "workers/processing/.venv/bin/python",
  );
  const mcap = execFileSync(
    processingPython,
    [
      "-c",
      "import sys; from stage_helpers import GOLDEN_MCAP; from indexed_fixture import chunked; sys.stdout.buffer.write(chunked(GOLDEN_MCAP.read_bytes()))",
    ],
    { cwd: "workers/processing/tests" },
  );
  const { recordingId, admission, sourceManifestSha256 } =
    await world.heldGraphRecording(mcap, {
      frames: 5,
      clockDomain: "android.camera.sensor_timestamp",
    });
  assert.deepEqual(admission, {
    state: "held",
    reason: "choose_recipe",
    code: "manual_selection",
  });
  const browser = await world.staffBrowser();
  const selectPath = "/api/v1/recordings/" + recordingId + "/capture-recipe";
  assert.equal(
    (
      await browser(selectPath, {
        recipeId: graph.recipe,
        sourceManifestSha256: "0".repeat(64),
      })
    ).status,
    409,
  );
  const selected = await browser(selectPath, {
    recipeId: graph.recipe,
    sourceManifestSha256,
  });
  assert.equal(selected.status, 200);
  const {
    data: { jobId },
  } = await selected.json();
  assert.ok(jobId);
  const state = join(world.secretsDir, "graph-journal");
  mkdirSync(state, { mode: 0o700 });
  const replayDir = join(world.secretsDir, "replay");
  if (graph === defaultGraph) prepareReplay(mcap, replayDir);
  const render = join(process.cwd(), "artifacts/platform-tools/render/render");
  const cliEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DO_NOT_TRACK: "1",
    RENDER_CLI_CONFIG_DIR: join(world.secretsDir, "render"),
  };
  runner = spawn(
    render,
    [
      "workflows",
      "dev",
      "--env-file",
      "/dev/null",
      "--port",
      String(runnerPort),
      "--",
      controllerPython,
      "-m",
      "stateaction_controller.workflow",
    ],
    {
      env: {
        ...cliEnv,
        APP_ENV: "local",
        EXECUTION_BACKEND: "local",
        STATEACTION_API_URL: world.origin,
        CONTROLLER_CAPABILITY_FILE: world.workflow.file,
        JOBS_STATE_DIR: state,
        PYTHON_EXECUTABLE: processingPython,
        ...(graph === defaultGraph
          ? { STATEACTION_REPLAY_DIR: replayDir }
          : {}),
        CONTROLLER_POLL_MS: "50",
      },
      stdio: "ignore",
    },
  );
  runnerClosed = once(runner, "close");
  const readyBy = Date.now() + 30000;
  while (true) {
    try {
      const tasks = execFileSync(
        render,
        [
          "workflows",
          "tasks",
          "list",
          "--local",
          "--port",
          String(runnerPort),
          "-o",
          "json",
        ],
        { env: cliEnv, timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (tasks.includes("process-recording")) break;
    } catch {}
    assert.ok(
      Date.now() < readyBy && runner.exitCode === null,
      "The official Python workflow runner did not register the task",
    );
    await wait(100);
  }
  async function runJob(jobId, repairCli = false) {
    if (repairCli) {
      const { stdout } = await promisify(execFile)(
        controllerPython,
        ["-m", "stateaction_controller.repair"],
        {
          env: {
            ...cliEnv,
            APP_ENV: "local",
            STATEACTION_API_URL: world.origin,
            REPAIR_CAPABILITY_FILE: world.cron.file,
          },
          timeout: 60000,
        },
      );
      const { admission, pendingDispatches } = JSON.parse(stdout);
      assert.equal(admission, "admitted");
      assert.ok([0, 1].includes(pendingDispatches));
    } else {
      const admitted = (await world.admit()).admission;
      assert.equal(admitted.jobId, jobId);
    }
    const until = Date.now() + 60000;
    for (;;) {
      const job = await world.row(jobId);
      assert.ok(job);
      if (["succeeded", "failed", "cancelled"].includes(job.state)) {
        assert.ok(
          job.workflow_run_ref,
          "The Render workflow run must own the job",
        );
        return job.state;
      }
      if (Date.now() >= until) {
        const { rows: nodes } = await world.owner.query(
          "SELECT node_id, state FROM job_recipe_node_read_status WHERE job_id = $1 ORDER BY node_id",
          [jobId],
        );
        const seal = await call(
          world.origin,
          "/internal/v1/jobs/" + jobId + "/graph",
          {
            method: "POST",
            token: world.workflow.token,
            body: {
              action: nodes.every((node) => node.state === "not_run")
                ? "prepare_graph"
                : "seal_graph",
              owner: job.controller_lease_owner,
            },
          },
        );
        const message = seal.json?.error?.message;
        const safe =
          typeof message === "string" &&
          /^[a-zA-Z0-9 ._/:(),"-]{1,240}$/.test(message)
            ? message
            : "details unavailable";
        throw new Error(
          "Graph workflow did not finish " +
            JSON.stringify(nodes) +
            " (" +
            seal.status +
            " " +
            safe +
            ", dispatch " +
            JSON.stringify(world.dispatchDiagnostics()) +
            ", SQLSTATE " +
            world.sqlDiagnostics().join(",") +
            ")",
        );
      }
      await wait(100);
    }
  }
  const beforeRepair = world.dispatchDiagnostics().length;
  assert.equal(await runJob(jobId, graph === cpuGraph), "succeeded");
  if (graph === cpuGraph) {
    assert.deepEqual(world.dispatchDiagnostics().slice(beforeRepair), [
      { dispatchAvailable: true, started: 1, ambiguous: [] },
    ]);
  }
  const { rows } = await world.owner.query(
    `SELECT n.node_id, r.state, r.error_code, e.kind AS evidence, e.observed,
            c.submission_started_at IS NOT NULL AS submitted
     FROM job_recipe_nodes n
     LEFT JOIN job_recipe_node_results r USING(job_id,node_id)
     LEFT JOIN job_recipe_node_claims c USING(job_id,node_id)
     LEFT JOIN job_recipe_node_evidence e USING(job_id,node_id)
     WHERE n.job_id = $1 ORDER BY n.node_id`,
    [jobId],
  );
  const failures = rows.map((row) => {
    if (row.submitted) {
      const log = readFileSync(
        join(state, jobId, row.node_id, "child.log"),
        "utf8",
      );
      return {
        ...row,
        workerErrors: [
          ...log.matchAll(/"stateactionNodeError": "([a-z_0-9]+)"/g),
        ].map((item) => item[1]),
      };
    }
    return row;
  });
  assert.deepEqual(
    rows.map(({ node_id, state }) => ({ node_id, state })),
    nodes("recording").map((node_id) => ({ node_id, state: "succeeded" })),
    JSON.stringify(failures),
  );
  const {
    rows: [published],
  } = await world.owner.query(
    `SELECT j.state, c.status, c.reason_code FROM jobs j
     LEFT JOIN job_result_candidates c ON c.job_id = j.id WHERE j.id = $1`,
    [jobId],
  );
  assert.deepEqual(published, {
    state: "succeeded",
    status: "accepted",
    reason_code: null,
  });
  const { rows: clips } = await world.owner.query(
    "SELECT id, live_job_id FROM review_clips WHERE recording_id = $1",
    [recordingId],
  );
  assert.equal(clips.length, 1);
  const clipJobId = clips[0].live_job_id;
  assert.ok(clipJobId);
  const replay = await call(
    world.origin,
    "/internal/v1/jobs/" + jobId + "/graph",
    {
      method: "POST",
      token: world.workflow.token,
      body: {
        action: "seal_graph",
        owner: (await world.row(jobId)).controller_lease_owner,
      },
    },
  );
  assert.equal(replay.status, 200);
  const { rows: childJobs } = await world.owner.query(
    "SELECT id FROM jobs WHERE recording_id = $1 AND kind = 'clip_pipeline'",
    [recordingId],
  );
  assert.deepEqual(childJobs, [{ id: clipJobId }]);
  if (earlyRetry) {
    await retryBeforeAnyResult({
      browser,
      recordingId,
      clipId: clips[0].id,
      clipJobId,
      runJob,
    });
    return;
  }
  assert.equal(await runJob(clipJobId), "succeeded");
  const { rows: clipResults } = await world.owner.query(
    `SELECT j.state AS job, n.node_id AS node, n.state, n.receipt -> 'counts' AS counts,
            c.status, c.reason_code, (j.id = review.selected_job_id) AS selected
     FROM jobs j JOIN job_recipe_node_results n ON n.job_id = j.id
     JOIN review_clips review ON review.id = j.clip_id
     LEFT JOIN job_result_candidates c ON c.job_id = j.id
     WHERE j.id = $1`,
    [clipJobId],
  );
  assert.deepEqual(
    clipResults.map(({ counts, ...result }) => result),
    nodes("clip").map((node) => ({
      job: "succeeded",
      node,
      state: "succeeded",
      status: "accepted",
      reason_code: null,
      selected: true,
    })),
  );
  if (graph === defaultGraph) {
    assert.equal(
      clipResults.find(({ node }) => node === "segment").counts.failed_windows,
      1,
    );
  }
  assert.equal(
    (
      await browser(selectPath, {
        recipeId: graph === cpuGraph ? defaultGraph.recipe : cpuGraph.recipe,
        sourceManifestSha256,
      })
    ).status,
    409,
  );
  const recipeLabel =
    graph === defaultGraph
      ? "IndEgo processing @2"
      : graph.recipe.replaceAll("_", " ");
  for (const [path, expected] of [
    [
      "/recordings/" + recordingId,
      [...nodes("recording").map(label), recipeLabel],
    ],
    [
      "/recordings/" + recordingId + "/clips/" + clips[0].id + "/processing",
      [...nodes("clip").map(label), recipeLabel],
    ],
  ]) {
    const response = await browser(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const text of expected)
      assert.ok(html.includes(text), path + " does not show " + text);
  }
  const retryPath = "/api/v1/recordings/" + recordingId + "/graph-retries";
  const handNode = graph === cpuGraph ? "track_hands" : "hand_pose";
  const {
    rows: [selectedChunk],
  } = await world.owner.query(
    `SELECT c.id, s.seq FROM clips c JOIN clip_result_selections s ON s.job_id = c.job_id
     WHERE c.job_id = $1 AND s.clip_id = $2 ORDER BY c.ordinal, s.seq DESC LIMIT 1`,
    [clipJobId, clips[0].id],
  );
  assert.ok(
    selectedChunk,
    "The selected result must have an accepted hand chunk",
  );
  const framesResponse = await browser(
    "/api/v2/review-clips/" +
      clips[0].id +
      "/hand-frames?" +
      new URLSearchParams({
        clip: selectedChunk.id,
        selection: selectedChunk.seq,
      }),
  );
  assert.equal(framesResponse.status, 200);
  const { data: hands } = await framesResponse.json();
  assert.equal(hands.frames.length, 5);
  assert.ok(hands.frames.every((frame) => frame.hands.length === 0));
  const retryInput = {
    schemaVersion: 1,
    clipId: clips[0].id,
    parentJobId: clipJobId,
    nodes: [handNode],
  };
  if (graph === defaultGraph) {
    const request = {
      ...retryInput,
      nodes: ["segment"],
    };
    assert.equal((await browser(retryPath + "/preview", request)).status, 409);
    await world.owner.query(
      `INSERT INTO rerun_spend_authorizations
         (id,environment,approval,recording_id,max_compute_cents,max_gpu_cents,expires_at)
       VALUES ($1,'local','Synthetic bound in an isolated fixture',$2,100,100,now() + interval '10 minutes')`,
      [randomUUID(), recordingId],
    );
    const response = await browser(retryPath + "/preview", {
      ...retryInput,
      nodes: ["segment"],
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.notEqual(data.maxGpuCostUsd, "0.00");
    assert.deepEqual(data.execute, ["segment", "caption"]);
    assert.deepEqual(
      data.reuse.map(({ nodeId }) => nodeId),
      [handNode],
    );
  }
  const planned = await browser(retryPath + "/preview", retryInput);
  assert.equal(planned.status, 200);
  const { data: preview } = await planned.json();
  assert.deepEqual(preview.execute, [handNode]);
  assert.equal(preview.maxComputeCostUsd, "0.00");
  let retryId = randomUUID();
  const confirm = {
    ...retryInput,
    requestId: retryId,
    expectedPlanSha256: preview.planSha256,
    reason:
      graph === cpuGraph
        ? "Rerun this step"
        : "Verify explicit leaf execution.",
  };
  assert.equal(
    (
      await browser(retryPath + "/confirm", {
        ...confirm,
        expectedPlanSha256: "0".repeat(64),
      })
    ).status,
    409,
  );
  if (graph === cpuGraph) {
    const { navigate, evaluate, until, click } =
      await openStaffBrowser(browser);
    const processingUrl =
      world.origin +
      "/recordings/" +
      recordingId +
      "/clips/" +
      clips[0].id +
      "/processing?step=" +
      handNode;
    await navigate(processingUrl);
    const processedHref = await until(
      () =>
        evaluate(`Array.from(document.links).find(
        link => link.textContent.trim() === "Open processed clip"
      )?.href`),
      "The executed processing page has no processed-clip link",
    );
    assert.equal(new URL(processedHref).pathname, "/clips/" + clips[0].id);
    await navigate(processedHref);
    await until(
      () =>
        evaluate(`location.pathname === "/clips/" + ${JSON.stringify(clips[0].id)} &&
        !!document.querySelector("video")`),
      "The selected processed clip did not render the review player",
    );
    await navigate(processingUrl);
    await until(
      () => click("Rerun this step"),
      "The hand-node retry button did not hydrate",
    );
    await until(
      () =>
        evaluate(
          '!!document.querySelector("dialog[open]")?.textContent.includes("Runs track hands")',
        ),
      "The preview did not show the exact hand leaf",
    );
    await until(
      () => click("Start retry"),
      "The confirm button did not hydrate",
    );
    retryId = await until(async () => {
      const {
        rows: [clip],
      } = await world.owner.query(
        "SELECT live_job_id FROM review_clips WHERE id = $1",
        [clips[0].id],
      );
      return clip.live_job_id !== clipJobId ? clip.live_job_id : null;
    }, "The browser did not confirm the retry");
    assert.equal((await world.row(retryId)).state, "queued");
  } else {
    const confirmed = await browser(retryPath + "/confirm", confirm);
    assert.equal(
      confirmed.status,
      201,
      JSON.stringify((await confirmed.clone().json()).error ?? {}),
    );
  }
  const recovered = await browser(retryPath + "/confirm", {
    ...confirm,
    requestId: retryId,
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).data, {
    jobId: retryId,
    replayed: true,
  });
  assert.equal(await runJob(retryId), "succeeded");
  const { rows: calls } = await world.owner.query(
    "SELECT node_id FROM job_recipe_node_claims WHERE job_id = $1",
    [retryId],
  );
  assert.deepEqual(calls, [{ node_id: handNode }]);
  const { rows: reused } = await world.owner.query(
    "SELECT node_id FROM job_recipe_node_results WHERE job_id = $1 AND reuse_job_id = $2 ORDER BY node_id",
    [retryId, clipJobId],
  );
  assert.deepEqual(
    reused.map(({ node_id }) => node_id),
    preview.reuse.map(({ nodeId }) => nodeId),
  );
  let reusedProducer = false;
  let preservedSelectionAfterWorseResult = false;
  let reservedExactlyOnce = false;
  let batchRejectsMissingRetainedFile = false;
  let releasedUnclaimedRetryWithRetainedHand = false;
  if (graph === defaultGraph) {
    const unclaimed = {
      ...retryInput,
      parentJobId: retryId,
      nodes: ["caption"],
    };
    const unclaimedPreview = await browser(retryPath + "/preview", unclaimed);
    assert.equal(unclaimedPreview.status, 200);
    const { data: unclaimedPlan } = await unclaimedPreview.json();
    const unclaimedId = randomUUID();
    const unclaimedConfirmation = await browser(retryPath + "/confirm", {
      ...unclaimed,
      requestId: unclaimedId,
      expectedPlanSha256: unclaimedPlan.planSha256,
      reason: "Reproduce an executor that stops before claiming its node.",
    });
    assert.equal(unclaimedConfirmation.status, 201);
    await failBeforeCaptionClaim(unclaimedId, handNode);
    releasedUnclaimedRetryWithRetainedHand = true;

    const request = { ...unclaimed, parentJobId: unclaimedId };
    const response = await browser(retryPath + "/preview", request);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.execute, ["caption"]);
    assert.ok(data.reuse.some(({ nodeId }) => nodeId === "segment"));
    const captionRetryId = randomUUID();
    const captionCommand = {
      ...request,
      requestId: captionRetryId,
      expectedPlanSha256: data.planSha256,
      reason: "Verify the caption node consumes a retained segment output.",
    };
    const confirmed = await browser(retryPath + "/confirm", captionCommand);
    assert.equal(
      confirmed.status,
      201,
      JSON.stringify((await confirmed.clone().json()).error ?? {}),
    );
    assert.notEqual(data.maxGpuCostUsd, "0.00");
    assert.equal(
      (await browser(retryPath + "/confirm", captionCommand)).status,
      200,
    );
    const reservation = await world.owner.query(
      "SELECT gpu_cents,compute_cents FROM rerun_spend_reservations WHERE job_id = $1",
      [captionRetryId],
    );
    assert.deepEqual(reservation.rows, [
      {
        gpu_cents: String(Math.round(Number(data.maxGpuCostUsd) * 100)),
        compute_cents: String(Math.round(Number(data.maxComputeCostUsd) * 100)),
      },
    ]);
    assert.equal(await runJob(captionRetryId), "succeeded");
    reservedExactlyOnce = true;
    const {
      rows: [caption],
    } = await world.owner.query(
      `SELECT result.state, result.receipt #>> '{counts,not_captioned}' AS not_captioned,
          (SELECT reuse_job_id FROM job_recipe_node_results
           WHERE job_id = $1 AND node_id = 'segment') AS segment_origin,
          (SELECT count(*)::integer FROM job_recipe_node_claims WHERE job_id = $1) AS calls
       FROM job_recipe_node_results result WHERE job_id = $1 AND node_id = 'caption'`,
      [captionRetryId],
    );
    assert.deepEqual(caption, {
      state: "succeeded",
      not_captioned: "1",
      segment_origin: clipJobId,
      calls: 1,
    });
    reusedProducer = true;

    const batch = { schemaVersion: 1, scope: "failed_clips" };
    const selectedClip = async () =>
      (
        await world.owner.query(
          "SELECT selected_job_id FROM review_clips WHERE id = $1",
          [clips[0].id],
        )
      ).rows[0].selected_job_id;
    const selectedBeforeBatch = await selectedClip();
    assert.ok(selectedBeforeBatch);
    const worseRequest = {
      ...retryInput,
      parentJobId: captionRetryId,
      nodes: ["segment"],
    };
    const worsePreview = await browser(retryPath + "/preview", worseRequest);
    assert.equal(worsePreview.status, 200);
    const { data: worsePlan } = await worsePreview.json();
    prepareReplay(mcap, replayDir, 2);
    const worseId = randomUUID();
    const worseConfirmed = await browser(retryPath + "/confirm", {
      ...worseRequest,
      requestId: worseId,
      expectedPlanSha256: worsePlan.planSha256,
      reason:
        "Verify that a result with more failed windows cannot replace the selected result.",
    });
    assert.equal(worseConfirmed.status, 201);
    assert.equal(await runJob(worseId), "succeeded");
    const {
      rows: [worse],
    } = await world.owner.query(
      "SELECT failed_window_count FROM jobs WHERE id = $1",
      [worseId],
    );
    const worseErrors = () => {
      const log = readFileSync(
        join(state, worseId, "segment", "child.log"),
        "utf8",
      );
      return [...log.matchAll(/"stateactionNodeError": "([a-z_0-9]+)"/g)]
        .map((item) => item[1])
        .join(", ");
    };
    assert.ok(
      worse.failed_window_count === 2,
      "Expected two failed windows. " + worseErrors(),
    );
    assert.equal(await selectedClip(), selectedBeforeBatch);
    preservedSelectionAfterWorseResult = true;
    const batchPreview = await browser(retryPath + "/preview", batch);
    assert.equal(batchPreview.status, 200);
    const { data: batchPlan } = await batchPreview.json();
    assert.equal(batchPlan.maxComputeCostUsd, worsePlan.maxComputeCostUsd);
    assert.equal(batchPlan.clips.length, 1);
    assert.equal(batchPlan.clips[0].parentJobId, worseId);
    assert.deepEqual(batchPlan.clips[0].execute, ["segment", "caption"]);
    assert.deepEqual(
      batchPlan.clips[0].reuse.map(({ nodeId }) => nodeId),
      [handNode],
    );
    const batchId = randomUUID();
    const command = {
      ...batch,
      requestId: batchId,
      expectedPlanSha256: batchPlan.planSha256,
      reason: "Verify missing retained bytes block the retry.",
    };
    const batchConfirmed = await browser(retryPath + "/confirm", command);
    assert.equal(batchConfirmed.status, 201);
    assert.deepEqual((await batchConfirmed.json()).data, {
      jobIds: [batchId],
      replayed: false,
    });
    const batchReplay = await browser(retryPath + "/confirm", command);
    assert.equal(batchReplay.status, 200);
    assert.deepEqual((await batchReplay.json()).data, {
      jobIds: [batchId],
      replayed: true,
    });
    await world.removeRetainedFixtureOutput(worseId, handNode);
    assert.equal(await runJob(batchId), "failed");
    assert.equal(
      (
        await world.owner.query(
          "SELECT 1 FROM job_recipe_node_claims WHERE job_id = $1",
          [batchId],
        )
      ).rowCount,
      0,
    );
    assert.equal(await selectedClip(), selectedBeforeBatch);
    batchRejectsMissingRetainedFile = true;
  }
  console.log(
    JSON.stringify({
      outcome: published.state,
      nodes: rows,
      clipJobs: clips.length,
      clipResults,
      retryCalls: calls.length,
      repairCli: graph === cpuGraph,
      browserReview: graph === cpuGraph,
      browserRetry: graph === cpuGraph,
      noHandFrames: hands.frames.length,
      retainedNodes: reused.length,
      reusedProducer,
      batchRejectsMissingRetainedFile,
      preservedSelectionAfterWorseResult,
      reservedExactlyOnce,
      releasedUnclaimedRetryWithRetainedHand,
    }),
  );
}
try {
  await exerciseGraph();
} finally {
  try {
    await chrome?.close();
  } finally {
    try {
      if (runner && runner.exitCode === null && runner.signalCode === null) {
        runner.kill("SIGTERM");
        if (
          !(await Promise.race([
            runnerClosed.then(() => true),
            wait(2000, false),
          ]))
        ) {
          runner.kill("SIGKILL");
          await runnerClosed;
        }
      }
    } finally {
      await world.stop();
    }
  }
}
