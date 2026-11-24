import {
  contractMaxBytes,
  parseContract,
  type ControllerActionV3,
  type ControllerResult,
  type DagRunV1,
  type ReconcileResult,
  type RecipeV1,
} from "@stateaction/contracts";

/** The request reached (or may have reached) the server but no usable answer came back. */
export class AmbiguousApiError extends Error {}
/** The server answered with a definite rejection. */
export class ApiRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API rejected request: ${status} ${code}`);
  }
}

export type JobStatus = {
  jobId: string;
  state: string;
  kind: string;
  targetId: string;
  /** SA-42: server-recorded identity only. Adoption of a known call; never spawn authority. */
  executionBackend: "local" | "modal" | null;
  executionRef: string | null;
  /** Immutable worker start deadline; null before the submission intent. */
  startDeadline: string | null;
  /** Immutable absolute execution deadline; null before admission. */
  executionDeadline: string | null;
};

/** SA-91 jobs.prior-stages.v1: segment and caption runs with every file their slots attribute to them. */
export type PriorStage = {
  stage: "segment" | "caption";
  state: string;
  errorCode: string | null;
  counts: Record<string, number>;
  outputs: {
    fileId: string;
    role: string;
    slot: string;
    sizeBytes: string;
    sha256: string;
  }[];
};
export type PriorStages = {
  schemaVersion: 1;
  jobId: string;
  stages: PriorStage[];
};

/** Machine-credential HTTP client over SA-25's /internal/v1/jobs (never SQL, never S3). */
export class JobsApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  /** Response bounded by the published contract size plus envelope overhead; no unbounded json(). */
  private async call(
    path: string,
    method: "GET" | "POST",
    contract: string,
    body?: unknown,
  ): Promise<unknown> {
    const limit = contractMaxBytes(contract) + 4096;
    let response: Response;
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.token}`,
      };
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        // The machine credential must never follow a redirect to another origin.
        redirect: "error",
      };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      response = await fetch(`${this.base}${path}`, init);
    } catch {
      // Includes timeouts and resets after the server may have committed: lost acknowledgement.
      throw new AmbiguousApiError("No acknowledgement from the jobs API");
    }
    let json: unknown;
    try {
      json = JSON.parse(await readBounded(response, limit));
    } catch {
      // A body we cannot read or bound after a mutation is not an acknowledgement.
      if (response.ok || response.status >= 500)
        throw new AmbiguousApiError("Unreadable or oversized API response");
    }
    if (response.status >= 500)
      throw new AmbiguousApiError(`API ${response.status}`);
    if (!response.ok) {
      const raw = (json as { error?: { code?: unknown } } | undefined)?.error
        ?.code;
      // Server-supplied text is never echoed unless it is a plain error code.
      const code =
        typeof raw === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(raw)
          ? raw
          : "rejected";
      throw new ApiRejection(response.status, code);
    }
    return (json as { data?: unknown } | undefined)?.data;
  }

  /** Validation failure of an accepted response is ambiguous: recover intent, never respawn. */
  private checked<T>(contract: string, data: unknown): T {
    try {
      return parseContract<T>(contract, data);
    } catch {
      throw new AmbiguousApiError("Response violated its contract");
    }
  }

  async status(jobId: string): Promise<JobStatus> {
    const data = (await this.call(
      `/internal/v1/jobs/${jobId}`,
      "GET",
      "jobs.job-status.v2",
    )) as Record<string, unknown>;
    return this.checked<JobStatus>("jobs.job-status.v2", data);
  }

  /**
   * SA-91: the admitted recipe of a recipe job, or null for a job without one (the server
   * answers 404). Identity and budgets only; never spawn authority.
   */
  async recipe(jobId: string): Promise<RecipeV1 | null> {
    let data: unknown;
    try {
      data = await this.call(
        `/internal/v1/jobs/${jobId}/recipe`,
        "GET",
        "jobs.recipe.v1",
      );
    } catch (error) {
      if (error instanceof ApiRejection && error.status === 404) return null;
      throw error;
    }
    return this.checked<RecipeV1>("jobs.recipe.v1", data);
  }

  /** SA-91: the server's recorded stage runs (http.dag-run.v1), including each stage's call ID. */
  async dagRun(jobId: string): Promise<DagRunV1> {
    const data = await this.call(
      `/internal/v1/jobs/${jobId}/dag-run`,
      "GET",
      "http.dag-run.v1",
    );
    return this.checked<DagRunV1>("http.dag-run.v1", data);
  }

  /** SA-91: the earlier stages' recorded runs and their files (the hand_pose `priorStages`). */
  async priorStages(jobId: string): Promise<PriorStages> {
    const data = await this.call(
      `/internal/v1/jobs/${jobId}/prior-stages`,
      "GET",
      "jobs.prior-stages.v1",
    );
    return this.checked<PriorStages>("jobs.prior-stages.v1", data);
  }

  async act(
    jobId: string,
    action: ControllerActionV3,
  ): Promise<ControllerResult> {
    // v3 preserves the earlier actions and adds the parallel recipe controls.
    parseContract("jobs.controller-action.v3", action);
    const data = await this.call(
      `/internal/v1/jobs/${jobId}/controller`,
      "POST",
      "jobs.controller-result.v1",
      action,
    );
    return this.checked<ControllerResult>("jobs.controller-result.v1", data);
  }

  async reconcile(): Promise<ReconcileResult> {
    const data = await this.call(
      "/internal/v1/jobs/reconcile",
      "POST",
      "jobs.reconcile-result.v1",
      {},
    );
    return this.checked<ReconcileResult>("jobs.reconcile-result.v1", data);
  }
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
