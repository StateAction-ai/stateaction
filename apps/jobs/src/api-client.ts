import {
  contractMaxBytes,
  parseContract,
  type ControllerAction,
  type ControllerResult,
  type ReconcileResult,
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

  async act(
    jobId: string,
    action: ControllerAction,
  ): Promise<ControllerResult> {
    parseContract("jobs.controller-action.v1", action);
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
