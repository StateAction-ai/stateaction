import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../api/platform-verify.v1.schema.json" with { type: "json" };
export * from "./canonical.js";
export * from "./modal-binding.js";
export * from "./validate.js";
export * from "./types.js";
export * from "./simulation.js";
export {
  captionSteps,
  checkSealedInventory,
  HAND_ARRAY_SHAPES,
  moduleManifestEntry,
  SEGMENT_ID_NAMESPACE,
  segmentId,
  STAGE_ROLES,
  type RuleViolation,
} from "./rules.js";
export type PlatformVerifyRequest = { requestId: string };
export type WorkerHealth = {
  protocolVersion: 1;
  requestId: string;
  status: "ok";
  python: string;
  workerVersion: string;
};
export type PlatformVerifyResult = {
  requestId: string;
  renderRunId: string;
  worker: WorkerHealth;
};
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile<PlatformVerifyRequest>(schema);
export function parsePlatformVerifyRequest(
  value: unknown,
): PlatformVerifyRequest {
  if (!validate(value))
    throw new TypeError("Invalid platform verification request");
  return value;
}
export function parseWorkerHealth(value: unknown): WorkerHealth {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Invalid worker health");
  const item = value as Record<string, unknown>;
  parsePlatformVerifyRequest({ requestId: item.requestId });
  if (
    item.protocolVersion !== 1 ||
    item.status !== "ok" ||
    typeof item.python !== "string" ||
    typeof item.workerVersion !== "string" ||
    Object.keys(item).length !== 5
  )
    throw new TypeError("Invalid worker health");
  return item as WorkerHealth;
}
