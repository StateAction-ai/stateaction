import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../../apps/jobs/package.json", import.meta.url),
);
const { ModalClient } = require("modal");

export async function readSchedule(client, functionId, report) {
  const started = performance.now();
  let status = "OK";
  try {
    const { autoscalerConfiguration } =
      await client.cpClient.functionGetSchedulingParams(
        { functionId },
        { timeoutMs: 5000, retries: 0 },
      );
    const settings = autoscalerConfiguration?.settings;
    return {
      max_containers: settings?.maxContainers ?? null,
      min_containers: settings?.minContainers ?? null,
      buffer_containers: settings?.bufferContainers ?? null,
      scaledown_window: settings?.scaledownWindow ?? null,
      override_settings_present: Object.values(
        autoscalerConfiguration?.overrideSettings ?? {},
      ).some((value) => value !== undefined),
      override_events_present:
        Object.keys(autoscalerConfiguration?.overrideEvents ?? {}).length > 0,
    };
  } catch (error) {
    status = Number.isInteger(error?.code) ? error.code : "CLIENT_ERROR";
    throw error;
  } finally {
    report({
      method: "FunctionGetSchedulingParams",
      status,
      elapsed_ms: performance.now() - started,
    });
  }
}

export function clientFor(environment, endpoint) {
  process.env.MODAL_SERVER_URL = endpoint;
  const client = new ModalClient({
    environment,
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  if (client.profile.serverUrl !== endpoint) {
    client.close();
    throw new Error("Unexpected Modal endpoint");
  }
  return client;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , functionId, environment, endpoint] = process.argv;
  const local = process.env.STATEACTION_MODAL_TEST === "loopback";
  const allowed = local
    ? /^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(endpoint)
    : /^https:\/\/api\.modal2?\.com\/?$/.test(endpoint);
  if (!/^fu-[A-Za-z0-9]+$/.test(functionId) || !allowed) process.exit(2);
  let rpc;
  let client;
  try {
    client = clientFor(environment, endpoint);
    const scheduling = await readSchedule(
      client,
      functionId,
      (row) => (rpc = row),
    );
    console.log(JSON.stringify({ functionId, rpc, scheduling }));
  } catch {
    console.log(JSON.stringify({ functionId, rpc, scheduling: null }));
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}
