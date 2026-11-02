import { createHash, randomBytes } from "node:crypto";
import { errorResponse, newRequestId } from "./http.js";

/**
 * Non-human callers. Each has its own credential, audience and narrow scopes;
 * none holds a human session, database URL or storage key, and service
 * routes never fall back to cookies.
 */
export type ServiceKind = "workflow" | "cron" | "worker";

export const SERVICE_SCOPES = [
  // Workflow controller: drive one job through claim/status/reconcile.
  "jobs:status",
  "jobs:reconcile",
  // Repair cron: request reconciliation of pending jobs only.
  "jobs:repair",
  // Processing worker: claim its job, heartbeat and submit its result.
  "job:claim",
  "job:heartbeat",
  "job:result",
] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

/** Only the SHA-256 of the token is stored; the token is shown once. */
export type ServiceCredentialRecord = {
  credentialId: string;
  kind: ServiceKind;
  audience: string;
  scopes: readonly ServiceScope[];
  /** Required for workers; null for workflow/cron credentials. */
  jobId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  tokenSha256: string;
};

export interface ServiceCredentialStore {
  findByTokenSha256(sha256: string): Promise<ServiceCredentialRecord | null>;
}

const PREFIX = "sa_svc_";
const TOKEN = /^sa_svc_[A-Za-z0-9_-]{43}$/;

export function hashServiceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function issueServiceCredential(input: {
  credentialId: string;
  kind: ServiceKind;
  audience: string;
  scopes: readonly ServiceScope[];
  jobId?: string | null;
  ttlSeconds: number;
  now?: Date;
}): { token: string; record: ServiceCredentialRecord } {
  const jobId = input.jobId ?? null;
  if (input.kind === "worker" && !jobId)
    throw new Error("Worker credentials are bound to exactly one job");
  if (input.kind !== "worker" && jobId)
    throw new Error("Only worker credentials are job-bound");
  if (!(input.ttlSeconds > 0 && input.ttlSeconds <= 24 * 3600))
    throw new Error("Service credential lifetime must be within 24 hours");
  if (input.scopes.length === 0)
    throw new Error("At least one scope is required");
  const token = PREFIX + randomBytes(32).toString("base64url");
  const now = input.now ?? new Date();
  return {
    token,
    record: {
      credentialId: input.credentialId,
      kind: input.kind,
      audience: input.audience,
      scopes: [...input.scopes],
      jobId,
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
      revokedAt: null,
      tokenSha256: hashServiceToken(token),
    },
  };
}

export type ServiceRequirement = {
  audience: string;
  kinds: readonly ServiceKind[];
  scope: ServiceScope;
  /** The job addressed by the route; workers must be bound to it. */
  jobId?: string;
};

export type ServicePrincipal = {
  kind: ServiceKind;
  credentialId: string;
  audience: string;
  scopes: readonly ServiceScope[];
  jobId: string | null;
};

export type ServiceGuardResult =
  | { ok: true; principal: ServicePrincipal; requestId: string }
  | { ok: false; response: Response; reason: string };

export async function authenticateService(
  request: Request,
  store: ServiceCredentialStore,
  requirement: ServiceRequirement,
  now: Date = new Date(),
): Promise<ServiceGuardResult> {
  const requestId = newRequestId();
  const deny = (status: "unauthenticated" | "forbidden", reason: string) => ({
    ok: false as const,
    reason,
    // Reasons stay server-side; callers get a stable generic message.
    response: errorResponse(
      status,
      status === "unauthenticated"
        ? "Service credential required"
        : "Not permitted",
      requestId,
    ),
  });

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match?.[1]) return deny("unauthenticated", "missing_bearer");
  const token = match[1];
  if (!TOKEN.test(token)) return deny("unauthenticated", "malformed_token");

  let record: ServiceCredentialRecord | null;
  try {
    record = await store.findByTokenSha256(hashServiceToken(token));
  } catch {
    return {
      ok: false,
      reason: "store_unavailable",
      response: errorResponse(
        "provider_unavailable",
        "Temporarily unavailable",
        requestId,
      ),
    };
  }
  if (!record) return deny("unauthenticated", "unknown_token");
  if (record.revokedAt && record.revokedAt <= now)
    return deny("unauthenticated", "revoked");
  if (record.expiresAt <= now) return deny("unauthenticated", "expired");
  if (record.audience !== requirement.audience)
    return deny("forbidden", "audience_mismatch");
  if (!requirement.kinds.includes(record.kind))
    return deny("forbidden", "kind_not_allowed");
  if (!record.scopes.includes(requirement.scope))
    return deny("forbidden", "scope_missing");
  if (record.kind === "worker") {
    if (!requirement.jobId || record.jobId !== requirement.jobId)
      return deny("forbidden", "job_mismatch");
  } else if (record.jobId !== null) return deny("forbidden", "job_mismatch");

  return {
    ok: true,
    requestId,
    principal: {
      kind: record.kind,
      credentialId: record.credentialId,
      audience: record.audience,
      scopes: record.scopes,
      jobId: record.jobId,
    },
  };
}
