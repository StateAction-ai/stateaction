import type { ModalClient } from "modal";
import { CALL_ID } from "./journal.js";
import type { ModalStartupProof } from "@stateaction/server/operator-db";

type ControlPlane = Pick<
  ModalClient["cpClient"],
  "functionCallFromId" | "functionGetOutputs" | "functionGetCallGraph"
>;

// GenericResult_GenericStatus from the pinned Modal SDK's generated protocol.
const TERMINATED = 3;
const INIT_FAILURE = 5;

/** Inspect one async input without consuming its output or decoding a remote exception. */
export async function observeModalStartupFailure(
  modal: ControlPlane,
  callId: string,
): Promise<ModalStartupProof> {
  if (!CALL_ID.test(callId)) throw new Error("Expected a Modal call ID");
  const [call, result, graph] = await Promise.all([
    modal.functionCallFromId({ functionCallId: callId }),
    modal.functionGetOutputs({
      functionCallId: callId,
      maxValues: 2,
      timeout: 0,
      lastEntryId: "0-0",
      clearOnSuccess: false,
      requestedAt: Date.now() / 1000,
      inputJwts: [],
    }),
    modal.functionGetCallGraph({ functionCallId: callId }),
  ]).catch(() => {
    throw new Error("Could not verify the call with Modal");
  });

  const output = result.outputs[0];
  const input = graph.inputs[0];
  const status = output?.result?.status;
  if (
    call.functionCallId !== callId ||
    call.numInputs !== 1 ||
    result.numUnfinishedInputs !== 0 ||
    result.outputs.length !== 1 ||
    !output ||
    output.idx !== 0 ||
    !/^in-[A-Za-z0-9]{1,77}$/.test(output.inputId) ||
    output.taskId !== "" ||
    output.inputStartedAt !== 0 ||
    output.retryCount !== 0 ||
    !Number.isFinite(output.outputCreatedAt) ||
    output.outputCreatedAt <= 0 ||
    graph.truncated ||
    graph.functionCalls.length !== 1 ||
    graph.functionCalls[0]?.functionCallId !== callId ||
    graph.inputs.length !== 1 ||
    input?.functionCallId !== callId ||
    input.inputId !== output.inputId ||
    input.taskId !== "" ||
    input.status !== status ||
    (status !== INIT_FAILURE && status !== TERMINATED)
  )
    throw new Error(
      "Modal did not prove that the exact call ended before starting",
    );

  return {
    callId,
    inputId: output.inputId,
    status: status === INIT_FAILURE ? "init_failure" : "terminated",
    outputCreatedAt: output.outputCreatedAt,
  };
}
