import type pg from "pg";
import { serverConfig, type ServerConfig } from "../config.js";
import { storageClient } from "../storage.js";
import { admissionDepsFromEnv } from "../admission/runtime.js";
import type { AdmissionDeps } from "../admission/recordings.js";
import { S3MultipartProvider } from "./provider.js";
import type { TransportDeps } from "./service.js";
import {
  hashServiceToken,
  type ServiceCredentialRecord,
  type ServiceCredentialStore,
  type ServiceScope,
} from "../auth/service.js";

/** Audience every worker credential for this API is minted for. */
export const WORKER_AUDIENCE = "stateaction-api";

/**
 * Production composition of the multipart provider from the same S3/R2
 * settings the rest of the server uses (SeaweedFS locally, R2 hosted, nothing
 * else differs). The signing client uses the public endpoint so presigned URLs
 * carry a host the client can reach; credentials never leave the process.
 */
export function transportDepsFromEnv(
  pool: pg.Pool,
  env: NodeJS.ProcessEnv = process.env,
): TransportDeps {
  let admission: AdmissionDeps | undefined;
  return {
    pool,
    provider: providerFromConfig(serverConfig(env)),
    // Same admission settings as the recording routes, resolved on first use.
    admission: () => (admission ??= admissionDepsFromEnv(pool, env)),
  };
}
export function providerFromConfig(config: ServerConfig): S3MultipartProvider {
  return new S3MultipartProvider(
    storageClient(config, 15_000),
    storageClient(config, 15_000, config.publicEndpoint),
    config.bucket,
  );
}

/**
 * Worker credential store backed by the job row. The processing controller
 * issues one server-generated capability per attempt and stores only its
 * SHA-256 (jobs.capability_token_sha256). The credential is valid only while
 * that exact job is `running` and inside its execution deadline; a finished,
 * cancelled, retried or expired attempt resolves to nothing. It carries only
 * the scopes this store was built for (SA-20: `job:output`).
 */
export class JobCapabilityStore implements ServiceCredentialStore {
  constructor(
    private readonly pool: Pick<pg.Pool, "query">,
    private readonly scopes: readonly ServiceScope[] = ["job:output"],
    private readonly audience: string = WORKER_AUDIENCE,
  ) {}
  async findByTokenSha256(
    sha256: string,
  ): Promise<ServiceCredentialRecord | null> {
    const { rows } = await this.pool.query<{
      id: string;
      execution_deadline: Date | null;
    }>(
      `SELECT id, execution_deadline FROM jobs
       WHERE capability_token_sha256 = $1 AND state = 'running' AND claimed_at IS NOT NULL
         AND recipe IS NULL`,
      [sha256],
    );
    const job = rows[0];
    if (!job) return this.stage(sha256);
    return {
      credentialId: job.id,
      kind: "worker",
      audience: this.audience,
      scopes: this.scopes,
      jobId: job.id,
      // No deadline recorded means no authority: fail closed.
      expiresAt: job.execution_deadline ?? new Date(0),
      revokedAt: null,
      tokenSha256: sha256,
    };
  }

  /**
   * SA-88 stage capability (recipe jobs): valid while the job is running and
   * that stage is claimed and has no terminal run, so it ends when the
   * controller records the stage finished. Only the sealing hand_pose stage
   * may report the result (`job:result`).
   */
  private async stage(sha256: string): Promise<ServiceCredentialRecord | null> {
    const { rows } = await this.pool.query<{
      job_id: string;
      stage: string;
      execution_deadline: Date | null;
    }>(
      `SELECT c.job_id, c.stage, j.execution_deadline FROM job_stage_claims c JOIN jobs j ON j.id = c.job_id
       WHERE c.capability_token_sha256 = $1 AND c.claimed_at IS NOT NULL
         AND j.state = 'running' AND j.claimed_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM job_stage_runs r WHERE r.job_id = c.job_id AND r.stage = c.stage
                         AND job_stage_terminal(r.state))`,
      [sha256],
    );
    const claim = rows[0];
    if (!claim) return null;
    return {
      credentialId: `stage:${claim.stage}:${claim.job_id}`,
      kind: "worker",
      audience: this.audience,
      scopes:
        claim.stage === "hand_pose"
          ? this.scopes
          : this.scopes.filter((s) => s !== "job:result"),
      jobId: claim.job_id,
      expiresAt: claim.execution_deadline ?? new Date(0),
      revokedAt: null,
      tokenSha256: sha256,
    };
  }
}
export { hashServiceToken };
