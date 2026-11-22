import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { moduleManifestEntry } from "@stateaction/contracts";

/** Finite, explicit controller limits. Everything here is bounded; nothing waits forever. */
type BaseSettings = {
  apiUrl: string;
  /** State directory for the execution journal (0700). On Render this is task-local disk. */
  stateDir: string;
  renewIntervalMs: number;
  pollIntervalMs: number;
  /** Maximum time to wait for a predecessor's lease (same-run native retry). */
  leaseWaitMs: number;
  /** After a kill/cancel, how long to wait for proof the execution is gone. */
  reapGraceMs: number;
  apiTimeoutMs: number;
};

/** The qualified local executor: a detached child on this host, APP_ENV=local only. */
export type LocalControllerSettings = BaseSettings & {
  /** Absent means local (the discriminator is optional so existing local callers are unchanged). */
  executor?: "local";
  python: string;
  /** Worker pipeline: an explicit local-only fixture name or the production pipeline. */
  pipeline: "hand_pose_cpu_v1" | "local_fixture_noop";
  /** Local fixture only: bounded hold so recovery cases can be exercised. */
  fixtureHoldSeconds?: number;
};

/**
 * SA-42 Modal executor: one finite CPU function call per job. Only the production
 * pipeline exists here; the Modal client belongs to the controller, never the
 * processing container. Image, model, code, resources and retries are pinned by
 * the deployed Modal app, not by controller settings.
 */
export type ModalControllerSettings = BaseSettings & {
  executor: "modal";
  appName: string;
  functionName: string;
  environmentName?: string;
  pipeline: "hand_pose_cpu_v1";
  /**
   * SA-91: deployed function per recipe stage module (`module@version` to function name), from
   * `MODAL_STAGE_FUNCTIONS`. `hand_pose_cpu_v1@1` is always `functionName`. A module without a
   * binding is never spawned.
   */
  stageFunctions?: Readonly<Record<string, string>>;
};

export type ControllerSettings =
  | LocalControllerSettings
  | ModalControllerSettings;

function secretFrom(fileVar: string, tokenVar: string): string {
  const file = process.env[fileVar];
  if (file) {
    // Protected file: not a symlink, a regular file, owned by this user, owner-only.
    const named = lstatSync(file);
    if (named.isSymbolicLink() || !named.isFile())
      throw new Error(`${fileVar} must be a regular file, not a symlink`);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.ino !== named.ino ||
        info.dev !== named.dev
      )
        throw new Error(
          `${fileVar} must be an owner-only file owned by this user`,
        );
      return readFileSync(fd, "utf8").trim();
    } finally {
      closeSync(fd);
    }
  }
  const token = process.env[tokenVar];
  if (token) return token.trim();
  throw new Error(`${fileVar} or ${tokenVar} is required`);
}

export const controllerToken = (): string =>
  secretFrom("CONTROLLER_CAPABILITY_FILE", "CONTROLLER_CAPABILITY_TOKEN");
/** Repair-cron capability (scope jobs:repair only). */
export const repairToken = (): string =>
  secretFrom("REPAIR_CAPABILITY_FILE", "REPAIR_CAPABILITY_TOKEN");

const int = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
};

export function apiUrl(): string {
  const raw = process.env.STATEACTION_API_URL;
  if (!raw) throw new Error("STATEACTION_API_URL is required");
  const url = new URL(raw);
  // Origin only: no credentials, path, query or fragment may be silently dropped.
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    raw.includes("?") ||
    raw.includes("#")
  )
    throw new Error("STATEACTION_API_URL must be a bare origin");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error(
      "STATEACTION_API_URL must be https (http only on loopback)",
    );
  return url.origin;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function common() {
  const stateDir = process.env.JOBS_STATE_DIR;
  if (!stateDir) throw new Error("JOBS_STATE_DIR is required");
  return {
    stateDir,
    renewIntervalMs: int("CONTROLLER_RENEW_MS", 30_000, 200, 60_000),
    pollIntervalMs: int("CONTROLLER_POLL_MS", 2_000, 50, 30_000),
    leaseWaitMs: int("CONTROLLER_LEASE_WAIT_MS", 150_000, 0, 300_000),
    reapGraceMs: int("CONTROLLER_REAP_GRACE_MS", 30_000, 100, 120_000),
    apiTimeoutMs: int("CONTROLLER_API_TIMEOUT_MS", 15_000, 100, 60_000),
  };
}

/**
 * Explicit, discriminated executor selection. The backend is never inferred:
 *  - `local` exists only in APP_ENV=local (development and production REJECT it);
 *  - `modal` exists only in APP_ENV=development|production, with explicit
 *    Modal app/function names and a non-loopback https API origin.
 * Anything else fails closed.
 */
export function controllerSettings(): ControllerSettings {
  const backend = process.env.EXECUTION_BACKEND;
  const env = process.env.APP_ENV;
  if (backend === "local") {
    if (env !== "local")
      throw new Error(
        "The local executor is only qualified in APP_ENV=local; development and production reject it",
      );
    return localSettings();
  }
  if (backend === "modal") {
    if (env !== "development" && env !== "production")
      throw new Error(
        "The Modal executor requires APP_ENV=development or production",
      );
    return modalSettings();
  }
  throw new Error(
    "EXECUTION_BACKEND must be explicit: local (APP_ENV=local) or modal (development/production)",
  );
}

function localSettings(): LocalControllerSettings {
  const pipeline = process.env.WORKER_PIPELINE ?? "hand_pose_cpu_v1";
  if (pipeline !== "hand_pose_cpu_v1" && pipeline !== "local_fixture_noop")
    throw new Error("Unknown WORKER_PIPELINE");
  // The no-output fixture exists for controller plumbing tests only.
  if (pipeline === "local_fixture_noop" && process.env.APP_ENV !== "local")
    throw new Error("local_fixture_noop is local-only");
  const python = process.env.PYTHON_EXECUTABLE;
  if (!python) throw new Error("PYTHON_EXECUTABLE is required");
  return {
    executor: "local",
    apiUrl: apiUrl(),
    python,
    ...common(),
    pipeline,
    ...(pipeline === "local_fixture_noop"
      ? { fixtureHoldSeconds: int("WORKER_FIXTURE_HOLD_SECONDS", 0, 0, 600) }
      : {}),
  };
}

function modalSettings(): ModalControllerSettings {
  // The worker pipeline is not selectable here: only the production pipeline runs on Modal.
  if (process.env.WORKER_PIPELINE !== undefined)
    throw new Error(
      "WORKER_PIPELINE is not configurable for the Modal executor",
    );
  const api = apiUrl();
  // A Modal container can never reach a loopback API: refuse it rather than spawn a doomed call.
  const url = new URL(api);
  if (url.protocol !== "https:" || LOOPBACK.has(url.hostname))
    throw new Error(
      "The Modal executor requires a non-loopback https STATEACTION_API_URL",
    );
  const appName = process.env.MODAL_APP_NAME;
  const functionName = process.env.MODAL_FUNCTION_NAME;
  if (!appName || !NAME.test(appName))
    throw new Error("MODAL_APP_NAME is required");
  if (!functionName || !NAME.test(functionName))
    throw new Error("MODAL_FUNCTION_NAME is required");
  const environmentName = process.env.MODAL_ENVIRONMENT;
  if (environmentName !== undefined && !NAME.test(environmentName))
    throw new Error("MODAL_ENVIRONMENT is invalid");
  const stageFunctions = stageFunctionBindings(
    process.env.MODAL_STAGE_FUNCTIONS,
  );
  return {
    executor: "modal",
    apiUrl: api,
    appName,
    functionName,
    ...(environmentName === undefined ? {} : { environmentName }),
    ...common(),
    pipeline: "hand_pose_cpu_v1",
    ...(stageFunctions ? { stageFunctions } : {}),
  };
}

const MODULE_REF = /^[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,5}$/;
const HAND_POSE_MODULE = "hand_pose_cpu_v1@1";

/** `module@version=function,...`: strict, unique, never the hand-pose module (it is fixed). */
function stageFunctionBindings(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (raw === undefined || raw === "") return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [ref, fn, extra] = pair.trim().split("=");
    if (
      extra !== undefined ||
      !ref ||
      !fn ||
      !MODULE_REF.test(ref) ||
      !NAME.test(fn) ||
      ref === HAND_POSE_MODULE ||
      ref in out ||
      !moduleManifestEntry(ref) ||
      moduleManifestEntry(ref)!.localOnly
    )
      throw new Error("MODAL_STAGE_FUNCTIONS is invalid");
    out[ref] = fn;
  }
  return out;
}

/** The deployed Modal function of one stage module, or undefined when none is bound. */
export function modalFunctionFor(
  settings: ModalControllerSettings,
  module: string,
): string | undefined {
  if (module === HAND_POSE_MODULE) return settings.functionName;
  return Object.hasOwn(settings.stageFunctions ?? {}, module)
    ? settings.stageFunctions![module]
    : undefined;
}

/**
 * SA-91 module policy, checked before a stage claim is issued (nothing is spawned for a refused
 * module). Same pattern as `local_fixture_noop`: a `localOnly` module (the stub and replay
 * modules) runs only in APP_ENV=local, on the local executor. The local executor runs only
 * CPU modules; the Modal executor runs only modules with a deployed function binding.
 */
export function stageModuleRefusal(
  settings: ControllerSettings,
  stage: string,
  module: string,
  appEnv = process.env.APP_ENV,
): string | undefined {
  const entry = moduleManifestEntry(module);
  if (!entry || entry.stage !== stage) return "module_unknown";
  if (entry.localOnly && (appEnv !== "local" || settings.executor === "modal"))
    return "module_local_only";
  if (settings.executor === "modal")
    return modalFunctionFor(settings, module) === undefined
      ? "module_unbound"
      : undefined;
  return entry.gpu.minimum === "none" ? undefined : "module_needs_gpu";
}

/** Modal API credentials: controller-side only, never forwarded to the processing container. */
export function modalCredentials(): { tokenId: string; tokenSecret: string } {
  const tokenId = process.env.MODAL_TOKEN_ID;
  const tokenSecret = process.env.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret)
    throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required");
  return { tokenId, tokenSecret };
}
