import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserHeaders, call, signIn, startStack } from "./harness.mjs";
import { jobsEnv, newSeedDirs, seedAnnotations } from "./seed-annotations.mjs";
import { SYNTHETIC_SCENARIOS } from "./seed-scenarios.mjs";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const python =
  process.env.PYTHON_EXECUTABLE ??
  path("../../../workers/processing/.venv/bin/python");
const renderCli =
  process.env.RENDER_CLI ??
  path("../../../artifacts/platform-tools/render/render");

test(
  "hand-pose only reruns a real seeded recipe and replays a lost confirmation",
  { timeout: 240000 },
  async () => {
    const dirs = newSeedDirs();
    let stack;
    let seeded;
    try {
      stack = await startStack({
        storage: true,
        extraEnv: {
          ...jobsEnv(python),
          STATEACTION_LOCAL_RECIPE_DIR: dirs.recipes,
        },
      });
      seeded = await seedAnnotations(stack, {
        dirs,
        python,
        renderCli,
        scenarios: { ok: SYNTHETIC_SCENARIOS.ok },
        afterSeed: async (recordings, runJob) => {
          const parent = recordings.find(
            (recording) => recording.scenario === "ok",
          );
          assert.ok(parent, "a successful real seeded stub job is required");
          const staff = await signIn(stack, "staff");
          const server = createRequire(
            new URL("../../../packages/server/package.json", import.meta.url),
          );
          const { Pool } = server("pg");
          const db = new Pool({ connectionString: stack.db.ownerUrl, max: 1 });
          const rows = await db
            .query("SELECT id FROM clips WHERE job_id = $1 ORDER BY ordinal", [
              parent.jobId,
            ])
            .finally(() => db.end());
          const parentClip = rows.rows[0]?.id;
          assert.ok(parentClip, "seeded parent must own an accepted clip");
          const input = {
            parentJobId: parent.jobId,
            stage: "hand_pose",
            scope: "only",
          };
          const url = `/api/v1/recordings/${parent.recordingId}/stage-reruns`;
          const post = (path, body) =>
            call(stack.origin, path, {
              method: "POST",
              jar: staff,
              headers: browserHeaders(stack.origin),
              body: JSON.stringify(body),
            });
          const markBase = `/api/v1/recordings/${parent.recordingId}`;
          const baseline = await call(stack.origin, `${markBase}/annotations`, {
            jar: staff,
          });
          assert.equal(baseline.status, 200);
          const segmentId = JSON.parse(baseline.text).data.segments.rows[0]
            .segment_id;
          const markList = await call(
            stack.origin,
            `${markBase}/segment-marks`,
            { jar: staff },
          );
          assert.equal(markList.status, 200);
          const segmentsSha256 = JSON.parse(markList.text).data.segmentsSha256;
          const firstMark = await post(
            `${markBase}/segments/${segmentId}/marks`,
            {
              markId: randomUUID(),
              jobId: parent.jobId,
              segmentsSha256,
              expectedRevision: 0,
              verdict: "good",
            },
          );
          assert.equal(firstMark.status, 201, firstMark.text);
          const preview = await post(`${url}/plan`, input);
          assert.equal(preview.status, 200, preview.text);
          const plan = JSON.parse(preview.text).data;
          assert.deepEqual(
            plan.execute.map((item) => item.stage),
            ["hand_pose"],
          );
          assert.deepEqual(
            plan.reuse.map((item) => [item.stage, item.state]),
            [
              ["segment", "succeeded"],
              ["caption", "succeeded"],
            ],
          );
          assert.equal(plan.maxGpuCostUsd, "0.00");

          const command = {
            ...input,
            requestId: randomUUID(),
            reason: "Verify CPU-only rerun",
            expectedPlanSha256: plan.planSha256,
            expectedMaxGpuCostUsd: "0.00",
          };
          await new Promise((resolve, reject) => {
            const req = request(
              stack.origin + url,
              {
                method: "POST",
                headers: browserHeaders(stack.origin, {
                  cookie: staff.header(),
                }),
              },
              (res) => {
                if (res.statusCode !== 201) {
                  let error = "";
                  res.setEncoding("utf8");
                  res.on("data", (chunk) => {
                    if (error.length < 2048) error += chunk;
                  });
                  res.on("end", () =>
                    reject(
                      new Error(
                        `Confirmation expected 201, got ${res.statusCode}: ${error.slice(0, 2048)}`,
                      ),
                    ),
                  );
                  return;
                }
                res.destroy();
                resolve();
              },
            );
            req.on("error", reject);
            req.end(JSON.stringify(command));
          });
          const replay = await post(url, command);
          assert.equal(replay.status, 200, replay.text);
          assert.deepEqual(JSON.parse(replay.text).data, {
            jobId: command.requestId,
            parentJobId: parent.jobId,
            replayed: true,
          });
          const conflict = await post(url, {
            ...command,
            reason: "different confirmation",
          });
          assert.equal(conflict.status, 409, conflict.text);
          const parentRead = () =>
            post(`/api/v1/clips/${parentClip}/reads`, { role: "viewer_rrd" });
          assert.equal(
            (await parentRead()).status,
            200,
            "selected parent while child is queued",
          );
          const child = await runJob(parent.recordingId, command.requestId);
          assert.equal(child.jobState, "succeeded", JSON.stringify(child));
          assert.deepEqual(
            child.stages.map((item) => [item.stage, item.state]),
            [["hand_pose", "succeeded"]],
          );
          const dag = await call(
            stack.origin,
            `/api/v1/jobs/${command.requestId}/dag-run?version=2`,
            { jar: staff },
          );
          assert.equal(dag.status, 200, dag.text.slice(0, 1500));
          const data = JSON.parse(dag.text).data;
          assert.deepEqual(data.execute, ["hand_pose"]);
          assert.equal(data.derivedFromJobId, parent.jobId);
          assert.deepEqual(
            data.reuse.map((item) => item.receipt.jobId),
            [parent.jobId, parent.jobId],
          );
          assert.equal((await post(url, command)).status, 200);
          const annotations = await call(
            stack.origin,
            `/api/v1/recordings/${parent.recordingId}/annotations`,
            { jar: staff },
          );
          assert.equal(
            annotations.status,
            200,
            annotations.text.slice(0, 1500),
          );
          const result = JSON.parse(annotations.text).data;
          assert.equal(result.job_id, command.requestId);
          assert.equal(result.segments.job_id, parent.jobId);
          assert.equal(result.captions.job_id, parent.jobId);

          const inherited = await call(
            stack.origin,
            `${markBase}/segment-marks?version=2`,
            { jar: staff },
          );
          assert.equal(inherited.status, 200, inherited.text);
          const [oldMark] = JSON.parse(inherited.text).data.marks;
          assert.equal(oldMark.originJobId, parent.jobId);
          assert.equal(oldMark.revision, 0);
          assert.equal(oldMark.originRevision, 1);
          const childMark = await post(
            `${markBase}/segments/${segmentId}/marks`,
            {
              markId: randomUUID(),
              jobId: command.requestId,
              segmentsSha256,
              expectedRevision: 0,
              verdict: "issue",
              issueType: "caption",
            },
          );
          assert.equal(childMark.status, 201, childMark.text);

          const captionInput = {
            parentJobId: command.requestId,
            stage: "caption",
            scope: "from_here",
            params: { fail_captions: "0,1" },
          };
          const captionPreview = await post(`${url}/plan`, captionInput);
          assert.equal(captionPreview.status, 200, captionPreview.text);
          const captionPlan = JSON.parse(captionPreview.text).data;
          assert.deepEqual(
            captionPlan.execute.map((entry) => entry.stage),
            ["caption"],
          );
          const captionId = randomUUID();
          const captionConfirm = await post(url, {
            ...captionInput,
            requestId: captionId,
            reason: "Verify failed captions with copied hand pose",
            expectedPlanSha256: captionPlan.planSha256,
            expectedMaxGpuCostUsd: "0.00",
          });
          assert.equal(captionConfirm.status, 201, captionConfirm.text);
          const caption = await runJob(parent.recordingId, captionId);
          assert.equal(
            caption.jobState,
            "succeeded",
            JSON.stringify(caption) + stack.logs().slice(-1600),
          );
          assert.deepEqual(
            caption.stages.map((row) => [row.stage, row.state]),
            [["caption", "succeeded"]],
          );
          const updated = await call(
            stack.origin,
            `${markBase}/annotations?run=${captionId}`,
            { jar: staff },
          );
          assert.equal(updated.status, 200, updated.text.slice(0, 1500));
          const captionDocument = JSON.parse(updated.text).data;
          assert.equal(captionDocument.hand_presence.job_id, command.requestId);
          assert.equal(
            captionDocument.captions.rows.filter(
              (row) => row.status === "failed",
            ).length,
            2,
          );
          assert.equal(
            (await parentRead()).status,
            200,
            "staff read of accepted historical parent",
          );
          const proofDb = new Pool({
            connectionString: stack.db.ownerUrl,
            max: 1,
          });
          try {
            const { rows: calls } = await proofDb.query(
              "SELECT stage, requested_gpu FROM job_stage_runs WHERE job_id = $1",
              [command.requestId],
            );
            assert.deepEqual(calls, [
              { stage: "hand_pose", requested_gpu: "none" },
            ]);
            const { rows: copies } = await proofDb.query(
              `SELECT c.file_id, c.source_file_id, c.sha256,
                  v.sha256 AS verified_sha256, src.sha256 AS parent_sha256
           FROM job_rerun_copies c JOIN files src ON src.id = c.source_file_id
           JOIN job_output_verifications v ON v.file_id = c.file_id
           WHERE c.job_id = $1`,
              [command.requestId],
            );
            const firstClip = async (jobId) => {
              const { rows } = await proofDb.query(
                "SELECT id FROM clips WHERE job_id = $1 ORDER BY ordinal LIMIT 1",
                [jobId],
              );
              assert.ok(rows[0]?.id);
              return rows[0].id;
            };
            const handClip = await firstClip(command.requestId);
            const captionClip = await firstClip(captionId);
            assert.notEqual(captionClip, handClip);
            const handFrames = (jobId, clipId, key = "run") =>
              call(
                stack.origin,
                `${markBase}/hand-frames?${key}=${jobId}&clip=${clipId}`,
                {
                  jar: staff,
                },
              );
            const originalHand = await handFrames(command.requestId, handClip);
            assert.equal(originalHand.status, 200);
            const reusedHand = await handFrames(captionId, captionClip);
            assert.equal(reusedHand.status, 200, reusedHand.text);
            const observations = JSON.parse(originalHand.text).data;
            assert.ok(observations.frames.length > 0);
            assert.deepEqual(JSON.parse(reusedHand.text).data, observations);
            assert.equal((await handFrames(captionId, handClip)).status, 404);
            assert.equal(
              (await handFrames(captionId, captionClip, "job")).status,
              404,
            );
            assert.equal(
              (
                await post(`${markBase}/reads?run=${captionId}`, {
                  role: "recording_mp4",
                })
              ).status,
              200,
            );

            assert.ok(copies.length >= 2);
            for (const copy of copies) {
              assert.notEqual(copy.file_id, copy.source_file_id);
              assert.equal(copy.sha256, copy.verified_sha256);
              assert.equal(copy.sha256, copy.parent_sha256);
            }
          } finally {
            await proofDb.end();
          }
          const history = async () => {
            const response = await call(stack.origin, `${markBase}/runs`, {
              jar: staff,
            });
            assert.equal(response.status, 200, response.text);
            return JSON.parse(response.text).data;
          };
          const newest = await history();
          assert.deepEqual(
            newest.runs
              .filter((item) => item.selected)
              .map((item) => item.jobId),
            [command.requestId],
            "A result with more failed captions must not replace the selected run",
          );

          const previousFrames = await call(
            stack.origin,
            `${markBase}/hand-frames?run=${parent.jobId}&clip=${parentClip}`,
            { jar: staff },
          );
          assert.equal(previousFrames.status, 200, previousFrames.text);
          assert.ok(JSON.parse(previousFrames.text).data.frames.length > 0);
          const staleFrames = await call(
            stack.origin,
            `${markBase}/hand-frames?job=${parent.jobId}&clip=${parentClip}`,
            { jar: staff },
          );
          assert.equal(staleFrames.status, 404);
          const previousVideo = await post(
            `${markBase}/reads?run=${parent.jobId}`,
            {
              role: "recording_mp4",
            },
          );
          assert.equal(previousVideo.status, 200, previousVideo.text);
          const staleVideo = await post(
            `${markBase}/reads?job=${parent.jobId}`,
            {
              role: "recording_mp4",
            },
          );
          assert.equal(staleVideo.status, 404);

          const browserOut = process.env.SA142_BROWSER_EVIDENCE;
          if (browserOut) {
            const { checkStageRerunBrowser } = await import(
              "./stage-rerun-browser.mjs"
            );
            await checkStageRerunBrowser({
              stack,
              parent,
              handRunId: command.requestId,
              captionRunId: captionId,
              out: browserOut,
            });
          }
          const beforeReselect = browserOut ? await history() : newest;
          const reselect = await post(`${markBase}/result-selection`, {
            jobId: parent.jobId,
            expectedSelectionSeq: beforeReselect.selectionSeq,
            reason: "Keep the original selected result",
          });
          assert.equal(reselect.status, 201, reselect.text);
          const restored = await history();
          assert.equal(restored.selectionSeq, beforeReselect.selectionSeq + 1);
          assert.deepEqual(
            restored.runs
              .filter((item) => item.selected)
              .map((item) => item.jobId),
            [parent.jobId],
          );
          assert.ok(
            restored.runs.some(
              (item) =>
                item.jobId === captionId && item.parentId === command.requestId,
            ),
          );
        },
      });
    } finally {
      seeded?.stopRunner();
      await stack?.stop();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  },
);
