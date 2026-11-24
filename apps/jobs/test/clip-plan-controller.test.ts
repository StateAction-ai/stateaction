import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ModalRerunBinding } from "@stateaction/contracts";
import { JobsApi } from "../src/api-client.js";
import { HAND_POSE_MODULE } from "../src/config.js";
import { runController } from "../src/controller.js";
import { JournalStore } from "../src/journal.js";
import type { ModalBootstrap } from "../src/modal-executor.js";
import { closeStubs, startStub } from "./stub-api.js";

after(closeStubs);

for (const expected of [
  "verified",
  "definition drift",
  "stale revision",
] as const)
  test(`clip plan CPU binding: ${expected}`, async () => {
    const jobId = randomUUID();
    const callId = "fc-ClipPlanFixture";
    const stub = await startStub({
      jobId,
      jobKind: "clip_plan",
      state: "submitting",
      submission: "recorded",
      statusBackend: "modal",
      statusCodeRevision: (expected === "stale revision" ? "b" : "a").repeat(
        40,
      ),
      executionDeadline: new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000),
    });
    const stateDir = mkdtempSync(join(tmpdir(), "sa147-controller-"));
    const spawns: ModalBootstrap[] = [];
    const binding: ModalRerunBinding = {
      functionId: "fu-fixture",
      definitionId: "fd-fixture",
      definitionSha256: "a".repeat(64),
      gpu: "none",
      maxBilledSeconds: 1050,
      microUsdPerGpuSecond: 0,
      microUsdPerCpuSecond: 328,
      maxContainers: 1,
      maxCpuMilli: 4000,
      maxMemoryMib: 26215,
      environment: "main",
      appName: "stateaction-processing",
      codeRevision: "a".repeat(40),
      paramsSha256: "b".repeat(64),
    };
    let inspections = 0;
    try {
      const result = await runController(
        {
          settings: {
            executor: "modal",
            apiUrl: stub.url,
            stateDir,
            renewIntervalMs: 100,
            pollIntervalMs: 20,
            leaseWaitMs: 0,
            reapGraceMs: 500,
            apiTimeoutMs: 5000,
            appName: "stateaction-processing",
            functionName: "process_recording",
            pipeline: "hand_pose_cpu_v1",
            verifiedBindings: new Map([[HAND_POSE_MODULE, binding]]),
          },
          api: new JobsApi(stub.url, "cap", 5000),
          store: new JournalStore(stateDir),
          modal: {
            async checkFunction(module, candidate) {
              assert.equal(module, HAND_POSE_MODULE);
              assert.deepEqual(candidate, binding);
              inspections += 1;
              return expected === "verified";
            },
            async spawn(bootstrap, _canSubmit, candidate) {
              assert.deepEqual(candidate, binding);
              assert.equal(inspections, 1);
              spawns.push(bootstrap);
              const claim = await fetch(
                `${stub.url}/internal/v1/jobs/${jobId}/claim`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    schemaVersion: 1,
                    jobId,
                    invocationNonce: randomBytes(32).toString("base64url"),
                    executor: { kind: "modal", functionCallId: callId },
                  }),
                },
              );
              assert.equal(claim.status, 200);
              return callId;
            },
            async poll() {
              return {
                kind: "returned",
                value: {
                  schemaVersion: 1,
                  functionCallId: callId,
                  exitCode: 0,
                },
              };
            },
            async cancel() {
              assert.fail("a completed call needs no cancellation");
            },
          },
        },
        { jobId, runRef: "run-clip-plan" },
      );
      assert.equal(inspections, expected === "stale revision" ? 0 : 1);
      if (expected !== "verified") {
        assert.deepEqual(result, {
          outcome: "needs_operator",
          reason: "clip_plan_binding_unavailable",
        });
        assert.equal(spawns.length, 0);
        assert.ok(
          !stub.calls.some(
            (call) => call.body?.action === "record_worker_submission",
          ),
        );
        return;
      }
      assert.equal(spawns.length, 1);
      assert.ok("pipeline" in spawns[0]!);
      assert.equal(spawns[0].pipeline, "clip_plan_cpu_v1");
      assert.equal(
        stub.calls.filter(
          (call) => call.body?.action === "record_execution_evidence",
        ).length,
        1,
      );
    } finally {
      rmSync(stateDir, { force: true, recursive: true });
    }
  });
