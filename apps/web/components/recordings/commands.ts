import { privateSignal } from "../../lib/private-state";

const refusal: Record<string, string> = {
  active_job: "A processing attempt is already in progress.",
  no_failed_clips: "There are no eligible failed clips.",
  stale_current_job:
    "The current run changed. Refresh and review the new plan.",
  plan_changed: "The plan changed. Refresh and review a new plan.",
  cost_cap_missing: "There is no remaining authorization for this retry.",
  cost_cap_exceeded: "The retry exceeds the job’s compute cap.",
  rerun_outside_admission_scope: "This canary allows hand pose retries only.",
  deployment_binding_unavailable:
    "The required processing worker is unavailable.",
  source_reupload_required: "The source needs to be uploaded again.",
  source_unavailable: "The source is unavailable.",
  source_not_sealed: "The source upload is incomplete.",
  termination_unproven: "The earlier execution has not been confirmed stopped.",
  budget_exceeded: "The remaining budget does not cover this retry.",
  stage_disabled: "This stage is disabled in the current recipe.",
};

export async function postRecordingCommand<T>(
  path: string,
  input: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-stateaction-client": "web",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.any([privateSignal(), AbortSignal.timeout(30_000)]),
  }).catch(() => null);
  if (!response)
    throw new Error("The request could not be confirmed. Try again.");
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { message?: string; code?: string };
  } | null;
  if (response.ok && body?.data !== undefined) return body.data;
  const message = body?.error?.message;
  throw new Error(
    response.status === 401 || response.status === 403
      ? "Your staff session is required."
      : (message &&
          (Object.hasOwn(refusal, message) ? refusal[message] : message)) ||
        "The request failed. Try again.",
  );
}
