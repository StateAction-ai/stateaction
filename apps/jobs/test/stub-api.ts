import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A contract-shaped stand-in for SA-25's machine API, used ONLY by fast unit
 * tests of the controller (deadline kill, lost acknowledgement, journals).
 * The real API/Postgres proof is test-integration. It records every call.
 */
export type StubOptions = {
  jobId: string;
  state: string;
  executionDeadline: Date;
  /** First record_worker_submission outcome: token handed out, or already recorded. */
  submission: "recorded" | "already_recorded";
  claimWins?: boolean;
};
/** Every started stub; test files close them in an `after` hook even when assertions fail. */
export const stubs: Server[] = [];
export const closeStubs = () => {
  for (const s of stubs) {
    s.closeAllConnections();
    s.close();
  }
};
export type Call = { path: string; body?: Record<string, unknown> };

export async function startStub(options: StubOptions) {
  const calls: Call[] = [];
  const token = `sa_svc_${randomBytes(32).toString("base64url")}`;
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  let state = options.state;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url ?? "";
      calls.push({ path: `${req.method} ${url}`, body });
      const send = (data: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ data, requestId: randomUUID() }));
      };
      if (req.method === "GET")
        return send({
          jobId: options.jobId,
          kind: "process_recording",
          targetId: randomUUID(),
          state,
          previousJobId: null,
          createdAt: iso(new Date()),
          updatedAt: iso(new Date()),
        });
      if (url.endsWith("/claim")) {
        if (options.claimWins === false) return send({ error: "x" }, 403);
        state = "running";
        return send({
          jobId: options.jobId,
          invocationNonce: body.invocationNonce,
          executionDeadline: iso(options.executionDeadline),
          capability: {
            token: `sa_svc_${randomBytes(32).toString("base64url")}`,
          },
        });
      }
      if (url.endsWith("/heartbeat"))
        return send({
          accepted: true,
          executionDeadline: iso(options.executionDeadline),
        });
      const later = iso(new Date(Date.now() + 120_000));
      switch (body.action) {
        case "record_workflow_run":
          return send({ recorded: true });
        case "claim_lease":
          return send({ granted: true, expiresAt: later });
        case "renew_lease":
          return send({ renewed: true, expiresAt: later });
        case "record_worker_submission":
          if (options.submission === "already_recorded")
            return send({ state: "already_recorded" });
          return send({
            state: "recorded",
            bootstrapToken: token,
            startDeadline: iso(
              new Date(
                Math.min(
                  Date.now() + 60_000,
                  options.executionDeadline.getTime(),
                ),
              ),
            ),
            executionDeadline: iso(options.executionDeadline),
            taskInput: {
              schemaVersion: 2,
              jobId: options.jobId,
              targetId: randomUUID(),
              profileRevision: "stub-1",
              kind: "process_recording",
              sourceManifestSha256: "a".repeat(64),
              rgbProfile: "h264_mcap_v1",
            },
            executionBackend: "local",
          });
        case "record_execution":
          return send({ recorded: true });
        case "mark_submit_unknown":
          state = "submit_unknown";
          return send({ state: "submit_unknown" });
        case "record_execution_evidence":
          return send({ recorded: true, slotReleased: false });
      }
      send({ error: "unhandled" }, 400);
    });
  });
  server.unref(); // a failing test must never hold the process open
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  stubs.push(server);
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    calls,
    actions: () =>
      calls.filter((c) => c.body?.action).map((c) => c.body!.action as string),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
