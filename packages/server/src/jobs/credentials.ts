import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  issueServiceCredential,
  type ServiceCredentialRecord,
  type ServiceCredentialStore,
  type ServiceKind,
  type ServiceScope,
} from "../auth/service.js";
import { WORKER_AUDIENCE } from "../transport/runtime.js";

type Db = Pick<pg.Pool, "query">;
const NEVER = new Date(0);

/**
 * Private bootstrap capability: handed once to the submitted physical worker
 * (never in task manifests) and good only for `job:claim`, only while the job
 * is awaiting its first claim and inside the start deadline. Winning the claim
 * ends it: the state leaves submitting/submit_unknown, so replays resolve to
 * nothing and cannot read data.
 */
export class BootstrapCapabilityStore implements ServiceCredentialStore {
  constructor(private readonly pool: Db) {}
  async findByTokenSha256(
    sha256: string,
  ): Promise<ServiceCredentialRecord | null> {
    const { rows } = await this.pool.query<{
      id: string;
      start_deadline: Date | null;
    }>(
      `SELECT id, start_deadline FROM jobs
       WHERE bootstrap_token_sha256 = $1 AND state IN ('submitting', 'submit_unknown')
         AND claimed_at IS NULL`,
      [sha256],
    );
    const job = rows[0];
    if (!job) return null;
    return {
      credentialId: job.id,
      kind: "worker",
      audience: WORKER_AUDIENCE,
      scopes: ["job:claim"],
      jobId: job.id,
      expiresAt: job.start_deadline ?? NEVER,
      revokedAt: null,
      tokenSha256: sha256,
    };
  }
}

/** Scopes of the running-capability issued by a won claim. */
export const RUNNING_WORKER_SCOPES: readonly ServiceScope[] = [
  "job:heartbeat",
  "job:result",
  "job:input",
  "job:output",
];

/**
 * Operator-issued workflow-controller and repair-cron credentials, stored only
 * as SHA-256 hashes in service_capabilities. Revocation and expiry are read on
 * every request. Humans and Better Auth sessions never reach this store.
 */
export class ControllerCapabilityStore implements ServiceCredentialStore {
  constructor(private readonly pool: Db) {}
  async findByTokenSha256(
    sha256: string,
  ): Promise<ServiceCredentialRecord | null> {
    const { rows } = await this.pool.query<{
      credential_id: string;
      kind: ServiceKind;
      audience: string;
      scopes: ServiceScope[];
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT credential_id, kind, audience, scopes, expires_at, revoked_at
       FROM service_capabilities WHERE token_sha256 = $1`,
      [sha256],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      credentialId: row.credential_id,
      kind: row.kind,
      audience: row.audience,
      scopes: row.scopes,
      jobId: null,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      tokenSha256: sha256,
    };
  }
}

/**
 * Operator setup (owner credential, outside any request path): mints one
 * controller/cron credential and returns the token exactly once. Only the hash
 * is stored.
 */
export async function issueControllerCapability(
  owner: Db,
  input: {
    kind: "workflow" | "cron";
    scopes: readonly ("jobs:status" | "jobs:reconcile" | "jobs:repair")[];
    label: string;
    ttlSeconds: number;
    audience?: string;
  },
): Promise<{ token: string; credentialId: string; expiresAt: Date }> {
  const credentialId = randomUUID();
  const { token, record } = issueServiceCredential({
    credentialId,
    kind: input.kind,
    audience: input.audience ?? WORKER_AUDIENCE,
    scopes: input.scopes,
    ttlSeconds: input.ttlSeconds,
  });
  await owner.query(
    `INSERT INTO service_capabilities (credential_id, token_sha256, kind, audience, scopes, label, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      credentialId,
      record.tokenSha256,
      input.kind,
      record.audience,
      [...input.scopes],
      input.label,
      record.expiresAt,
    ],
  );
  return { token, credentialId, expiresAt: record.expiresAt };
}
