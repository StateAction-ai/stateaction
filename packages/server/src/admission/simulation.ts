/**
 * SA-71: whether this server may accept explicitly labelled simulated capture
 * (rgb profile h264_mcap_simulation_v1, emulator only).
 *
 * Accepted ONLY when APP_ENV is exactly local or development AND
 * ALLOW_SIMULATED_CAPTURE_INPUTS is exactly "true". In every other APP_ENV
 * (staging, production, unset, spoofed) or when the process runs in a known
 * Render-hosted deployment environment, the flag must be ABSENT: its mere
 * presence is a configuration error, so a hosted Blueprint that carries it
 * fails preflight instead of silently ignoring it. The Render markers are the
 * variables Render injects into every service, preview and workflow task; this
 * is defense in depth for that platform and is not a claim about arbitrary
 * hosts (the database and storage isolation rules in config.ts still apply).
 */
export const SIMULATION_FLAG = "ALLOW_SIMULATED_CAPTURE_INPUTS";

const RENDER_MARKERS = [
  "RENDER",
  "RENDER_SERVICE_ID",
  "RENDER_SERVICE_NAME",
  "RENDER_SERVICE_TYPE",
  "RENDER_INSTANCE_ID",
  "RENDER_EXTERNAL_URL",
  "RENDER_EXTERNAL_HOSTNAME",
  "RENDER_DISCOVERY_SERVICE",
  "RENDER_GIT_COMMIT",
  "RENDER_GIT_BRANCH",
  "RENDER_GIT_REPO_SLUG",
  "IS_PULL_REQUEST",
] as const;

/** Name of the first Render-injected variable that is set, if any. */
export function renderHostedMarker(
  env: Record<string, string | undefined>,
): string | undefined {
  return RENDER_MARKERS.find(
    (key) => env[key] !== undefined && env[key] !== "",
  );
}

export function simulatedCaptureInputsEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env[SIMULATION_FLAG];
  const hosted = renderHostedMarker(env);
  const development = env.APP_ENV === "local" || env.APP_ENV === "development";
  if (raw === undefined) return false;
  if (!development || hosted !== undefined)
    throw new Error(
      `${SIMULATION_FLAG} is refused outside APP_ENV local/development and in hosted deployments; remove it`,
    );
  if (raw === "true") return true;
  if (raw === "false" || raw === "") return false;
  throw new Error(`${SIMULATION_FLAG} must be exactly "true" or "false"`);
}
