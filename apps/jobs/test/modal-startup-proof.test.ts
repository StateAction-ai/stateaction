import assert from "node:assert/strict";
import test from "node:test";
import { observeModalStartupFailure } from "../src/modal-startup-proof.js";

const callId = "fc-Original";
const inputId = "in-Original";

function provider(status = 3) {
  const state = {
    call: { functionCallId: callId, numInputs: 1 },
    output: {
      outputs: [
        {
          idx: 0,
          inputId,
          taskId: "",
          inputStartedAt: 0,
          retryCount: 0,
          outputCreatedAt: 10,
          result: { status },
        },
      ],
      numUnfinishedInputs: 0,
    },
    graph: {
      truncated: false,
      functionCalls: [{ functionCallId: callId }],
      inputs: [{ functionCallId: callId, inputId, taskId: "", status }],
    },
  };
  const api = {
    async functionCallFromId(request: { functionCallId: string }) {
      assert.equal(request.functionCallId, callId);
      return state.call;
    },
    async functionGetOutputs(request: {
      functionCallId: string;
      clearOnSuccess: boolean;
    }) {
      assert.equal(request.functionCallId, callId);
      assert.equal(request.clearOnSuccess, false);
      return state.output;
    },
    async functionGetCallGraph(request: { functionCallId: string }) {
      assert.equal(request.functionCallId, callId);
      return state.graph;
    },
  } as Parameters<typeof observeModalStartupFailure>[0];
  return { api, ...state };
}

test("requires matching terminal provider evidence for the sole input before it started", async () => {
  for (const [status, name] of [
    [3, "terminated"],
    [5, "init_failure"],
  ] as const) {
    assert.deepEqual(
      await observeModalStartupFailure(provider(status).api, callId),
      {
        callId,
        inputId,
        status: name,
        outputCreatedAt: 10,
      },
    );
  }
});

test("rejects live, already-started, ambiguous and mismatched provider records", async () => {
  for (const modify of [
    (f: ReturnType<typeof provider>) => {
      f.output.numUnfinishedInputs = 1;
    },
    (f: ReturnType<typeof provider>) => {
      f.output.outputs.length = 0;
    },
    (f: ReturnType<typeof provider>) => {
      f.output.outputs[0]!.inputStartedAt = 1;
    },
    (f: ReturnType<typeof provider>) => {
      f.output.outputs[0]!.retryCount = 1;
    },
    (f: ReturnType<typeof provider>) => {
      f.output.outputs[0]!.taskId = "ta-worker";
    },
    (f: ReturnType<typeof provider>) => {
      f.call.functionCallId = "fc-Foreign";
    },
    (f: ReturnType<typeof provider>) => {
      f.call.numInputs = 2;
    },
    (f: ReturnType<typeof provider>) => {
      f.graph.truncated = true;
    },
    (f: ReturnType<typeof provider>) => {
      f.graph.inputs[0]!.inputId = "in-Foreign";
    },
    (f: ReturnType<typeof provider>) => {
      f.graph.inputs[0]!.functionCallId = "fc-Foreign";
    },
    (f: ReturnType<typeof provider>) => {
      f.graph.inputs[0]!.status = 1;
    },
  ]) {
    const f = provider();
    modify(f);
    await assert.rejects(
      observeModalStartupFailure(f.api, callId),
      /before starting/,
    );
  }
  for (const status of [0, 1, 2, 4, 6, -1]) {
    await assert.rejects(
      observeModalStartupFailure(provider(status).api, callId),
      /before starting/,
    );
  }
});
