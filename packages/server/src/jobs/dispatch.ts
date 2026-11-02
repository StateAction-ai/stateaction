import { Render } from "@renderinc/sdk";

/**
 * The Render task start for an admitted job. This is the ONLY place the API
 * holds Render-start authority; the repair cron holds a repair-scoped API
 * capability and nothing else (no database, Render or Modal credential).
 *
 * Idempotency: the key is the fixed `job:{jobId}`. Render scopes a key to ONE
 * workflow version for 24 hours, so a repeat start inside that window returns
 * the first task run, but a new workflow version or a start after 24 hours can
 * create a second run. That limit is explicit and is never the safety fence:
 * the database fences it (the first controller to claim the lease fixes the
 * run, a different run is refused with no effects, submission intent is
 * written once and a physical worker can win its claim once).
 */
export type TaskStarter = {
  start(
    input: { jobId: string; dispatchKey: string },
    signal: AbortSignal,
  ): Promise<{ taskRunId: string }>;
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}\/process-recording$/;
const LOCAL_SLUG = /^(?:[a-z0-9][a-z0-9-]{0,62}\/)?process-recording$/;

/**
 * Builds the starter from explicit settings, or null when none is configured
 * (the repair pass then reports dispatch as unavailable and starts nothing).
 *
 * Hosted: `RENDER_API_KEY` (a secret of the API service only) plus
 * `PROCESS_RECORDING_TASK_SLUG=<workflow-slug>/process-recording`.
 * Local: `APP_ENV=local` with `RENDER_USE_LOCAL_DEV=true` or
 * `RENDER_LOCAL_DEV_URL` (the official local task server; no key).
 */
export function renderTaskStarterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TaskStarter | null {
  const configured = env.PROCESS_RECORDING_TASK_SLUG;
  const local =
    env.APP_ENV === "local" &&
    (env.RENDER_USE_LOCAL_DEV === "true" || !!env.RENDER_LOCAL_DEV_URL);
  let slug: string;
  if (!configured) {
    if (!local) return null;
    slug = "process-recording";
  } else {
    if (!(local ? LOCAL_SLUG : SLUG).test(configured))
      throw new Error(
        "PROCESS_RECORDING_TASK_SLUG must be <workflow-slug>/process-recording",
      );
    slug = configured;
  }
  let render: Render;
  if (local) {
    render = new Render({
      useLocalDev: true,
      ...(env.RENDER_LOCAL_DEV_URL
        ? { localDevUrl: env.RENDER_LOCAL_DEV_URL }
        : {}),
    });
  } else {
    const token = env.RENDER_API_KEY;
    if (!token) return null;
    render = new Render({ token });
  }
  return {
    async start(input, signal) {
      const run = await render.workflows.startTask(
        slug,
        [{ jobId: input.jobId }],
        {
          idempotencyKey: input.dispatchKey,
          signal,
        },
      );
      return { taskRunId: run.taskRunId };
    },
  };
}
