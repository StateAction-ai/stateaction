import assert from "node:assert/strict";
import test from "node:test";
import type { ControllerActionV2, DagRunV1 } from "@stateaction/contracts";
import type { JobStatus } from "../src/api-client.js";
import { recoveryBinding } from "../src/modal-executor.js";
import { recoverModalExecution } from "../src/modal-recovery.js";

const jobId = "00573d25-ffa0-4a3f-b1e2-134080fb58fb";
const callId = "fc-OneAuthorizedCall";
const apiUrl = "https://test.example";
const bootstrap = "b".repeat(64);
const input = { jobId, callId, apiUrl, runRef: "task-run-original" };
const baseStatus: JobStatus = {
  jobId,
  state: "cancel_requested",
  kind: "recording",
  targetId: jobId,
  executionBackend: "modal",
  executionRef: null,
  startDeadline: "2026-01-01T00:00:00.000Z",
  executionDeadline: "2026-01-01T06:00:00.000Z",
};

function fake(
  options: {
    status?: Partial<JobStatus>;
    stage?: "caption";
    call?: string;
    leaseRefused?: boolean;
    returned?: unknown;
  } = {},
) {
  const actions: ControllerActionV2[] = [];
  const stage = options.stage
    ? ({
        jobId,
        stage: options.stage,
        module: "flora_captioner_vllm_fp8@1",
      } as const)
    : undefined;
  const value = options.returned ?? {
    schemaVersion: stage ? 2 : 1,
    functionCallId: callId,
    exitCode: 75,
    callBinding: recoveryBinding(jobId, apiUrl, bootstrap, stage),
    ...(stage ? { receipt: null } : {}),
  };
  const api = {
    async status() {
      return { ...baseStatus, ...options.status };
    },
    async recipe() {
      return stage
        ? ({ stages: [{ ...stage, enabled: true }] } as never)
        : null;
    },
    async dagRun() {
      return {
        stages: [
          { ...stage, state: "submit_unknown", callId: options.call ?? null },
        ],
      } as DagRunV1;
    },
    async act(_job: string, action: ControllerActionV2) {
      actions.push(action);
      if (action.action === "claim_lease") {
        if (options.leaseRefused)
          return { granted: false, reason: "live_owner" } as const;
        return {
          granted: true,
          expiresAt: "2026-01-01T00:05:00.000Z",
        } as const;
      }
      return { recorded: true, slotReleased: false } as const;
    },
  };
  let polls = 0;
  const modal = {
    async poll(id: string) {
      assert.equal(id, callId);
      polls++;
      return { kind: "returned", value } as const;
    },
  };
  return {
    actions,
    api,
    modal,
    bootstrapHash: async () => bootstrap,
    polls: () => polls,
  };
}

test("recovers only the bound terminal call using the original workflow lease", async () => {
  const f = fake();
  await recoverModalExecution(f, input);
  assert.deepEqual(
    f.actions.map((a) => a.action),
    ["claim_lease", "record_execution", "record_execution_evidence"],
  );
  assert.equal(f.polls(), 1);
  const grant = f.actions[0]!;
  assert.equal(grant.action, "claim_lease");
  assert.equal(grant.runRef, input.runRef);
  assert.deepEqual(f.actions[1], {
    action: "record_execution",
    owner: grant.owner,
    executor: { kind: "modal", functionCallId: callId },
  });
  assert.equal(f.actions[2]?.action, "record_execution_evidence");
});

test("a lost stage call is bound, given evidence, then settled cancelled", async () => {
  const f = fake({ stage: "caption" });
  await recoverModalExecution(f, { ...input, stage: "caption" });
  assert.deepEqual(
    f.actions.map((a) => a.action),
    [
      "claim_lease",
      "record_stage_run",
      "record_execution_evidence",
      "record_stage_run",
    ],
  );
  assert.equal(f.actions[1]?.action, "record_stage_run");
  assert.equal(f.actions[1].state, "running");
  assert.equal(f.actions[1].callId, callId);
  assert.equal(f.actions[3]?.action, "record_stage_run");
  assert.equal(f.actions[3].state, "cancelled");
});

test("call ID alone, conflicting reference, wrong binding and non-terminal observations never mutate", async () => {
  const fWrongIntent = fake();
  fWrongIntent.bootstrapHash = async () => "c".repeat(64);
  const cases = [
    fWrongIntent,
    fake({
      returned: { schemaVersion: 1, functionCallId: callId, exitCode: 0 },
    }),
    fake({ status: { executionRef: "fc-Other" } }),
    fake({
      returned: {
        schemaVersion: 1,
        functionCallId: callId,
        exitCode: 0,
        callBinding: recoveryBinding(
          jobId,
          "https://another.example",
          bootstrap,
        ),
      },
    }),
    fake({ status: { state: "submit_unknown" } }),
  ];
  for (const f of cases) {
    await assert.rejects(() => recoverModalExecution(f, input));
    assert.deepEqual(f.actions, []);
  }
  const f = fake();
  await assert.rejects(() =>
    recoverModalExecution(
      {
        api: f.api,
        bootstrapHash: f.bootstrapHash,
        modal: {
          async poll() {
            return { kind: "unavailable", detail: "function_timeout" };
          },
        },
      },
      input,
    ),
  );
  assert.deepEqual(f.actions, []);
});

test("an occupied lease stops the operator before any identity or evidence writes", async () => {
  const f = fake({ leaseRefused: true });
  await assert.rejects(() => recoverModalExecution(f, input), /lease/);
  assert.deepEqual(
    f.actions.map((a) => a.action),
    ["claim_lease"],
  );
});
