import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";

/** Finite, explicit controller limits. Everything here is bounded; nothing waits forever. */
export type ControllerSettings = {
  apiUrl: string;
  /** Local-only state directory for the execution journal (0700). */
  stateDir: string;
  python: string;
  renewIntervalMs: number;
  pollIntervalMs: number;
  /** Maximum time to wait for a predecessor's lease (same-run native retry). */
  leaseWaitMs: number;
  /** After SIGKILL, how long to wait for the process group to empty. */
  reapGraceMs: number;
  apiTimeoutMs: number;
  /** Worker pipeline: an explicit local-only fixture name or the production pipeline. */
  pipeline: "hand_pose_cpu_v1" | "local_fixture_noop";
  /** Local fixture only: bounded hold so recovery cases can be exercised. */
  fixtureHoldSeconds?: number;
};

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
export const dispatchToken = (): string =>
  secretFrom("DISPATCH_CAPABILITY_FILE", "DISPATCH_CAPABILITY_TOKEN");

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

export function controllerSettings(): ControllerSettings {
  // Modal (and any hosted backend) stays fail-closed until a qualified ModalExecutor exists;
  // a local child is only meaningful inside explicit local development.
  if (
    process.env.EXECUTION_BACKEND !== "local" ||
    process.env.APP_ENV !== "local"
  )
    throw new Error(
      "Only the local executor in APP_ENV=local is qualified; Modal stays fail-closed",
    );
  const pipeline = process.env.WORKER_PIPELINE ?? "hand_pose_cpu_v1";
  if (pipeline !== "hand_pose_cpu_v1" && pipeline !== "local_fixture_noop")
    throw new Error("Unknown WORKER_PIPELINE");
  // The no-output fixture exists for controller plumbing tests only.
  if (pipeline === "local_fixture_noop" && process.env.APP_ENV !== "local")
    throw new Error("local_fixture_noop is local-only");
  const stateDir = process.env.JOBS_STATE_DIR;
  if (!stateDir) throw new Error("JOBS_STATE_DIR is required");
  const python = process.env.PYTHON_EXECUTABLE;
  if (!python) throw new Error("PYTHON_EXECUTABLE is required");
  return {
    apiUrl: apiUrl(),
    stateDir,
    python,
    renewIntervalMs: int("CONTROLLER_RENEW_MS", 30_000, 200, 60_000),
    pollIntervalMs: int("CONTROLLER_POLL_MS", 2_000, 50, 30_000),
    leaseWaitMs: int("CONTROLLER_LEASE_WAIT_MS", 150_000, 0, 300_000),
    reapGraceMs: int("CONTROLLER_REAP_GRACE_MS", 30_000, 100, 120_000),
    apiTimeoutMs: int("CONTROLLER_API_TIMEOUT_MS", 15_000, 100, 60_000),
    pipeline,
    ...(pipeline === "local_fixture_noop"
      ? { fixtureHoldSeconds: int("WORKER_FIXTURE_HOLD_SECONDS", 0, 0, 600) }
      : {}),
  };
}

/**
 * Task slug for startTask. Hosted Render requires `<workflow-slug>/process-recording`
 * (explicit, never guessed); the bare task name is valid only for the explicit
 * local runner (APP_ENV=local with RENDER_USE_LOCAL_DEV or RENDER_LOCAL_DEV_URL).
 * Idempotency keys are scoped by Render to one workflow VERSION for 24 h, so
 * duplicate-start safety across deploys rests on the database run/claim fences.
 */
export function taskSlug(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROCESS_RECORDING_TASK_SLUG;
  const local =
    env.APP_ENV === "local" &&
    (env.RENDER_USE_LOCAL_DEV === "true" || !!env.RENDER_LOCAL_DEV_URL);
  if (!configured) {
    if (local) return "process-recording";
    throw new Error("PROCESS_RECORDING_TASK_SLUG is required outside local");
  }
  const pattern = local
    ? /^(?:[a-z0-9][a-z0-9-]{0,62}\/)?process-recording$/
    : /^[a-z0-9][a-z0-9-]{0,62}\/process-recording$/;
  if (!pattern.test(configured))
    throw new Error(
      "PROCESS_RECORDING_TASK_SLUG must be <workflow-slug>/process-recording",
    );
  return configured;
}
