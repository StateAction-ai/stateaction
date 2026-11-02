import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import {
  recordingRoutes,
  type RecordingRoutesDeps,
} from "../src/admission/http.js";

/**
 * TEST-ONLY real HTTP adapter: binds the framework-neutral SA-19 handlers to
 * the exact v1 route shapes on an ephemeral loopback port. Production route
 * binding (Next.js app routes + the SA-15 session guard) is a later
 * integration step; this adapter only proves the handlers over real sockets.
 */
export async function startRecordingServer(
  deps: RecordingRoutesDeps,
): Promise<{ url: string; close(): Promise<void> }> {
  const routes = recordingRoutes(deps);
  const server: Server = createServer((req, res) => {
    void (async () => {
      const request = toRequest(req);
      const path = new URL(request.url).pathname;
      let seal: RegExpExecArray | null;
      let one: RegExpExecArray | null;
      let response: Response;
      if (path === "/api/v1/recordings" && req.method === "POST")
        response = await routes.create(request);
      else if (
        (seal = /^\/api\/v1\/recordings\/([^/]+)\/seal$/.exec(path)) &&
        req.method === "POST"
      )
        response = await routes.seal(request, decodeURIComponent(seal[1]!));
      else if (
        (one = /^\/api\/v1\/recordings\/([^/]+)$/.exec(path)) &&
        req.method === "GET"
      )
        response = await routes.get(request, decodeURIComponent(one[1]!));
      else response = new Response(null, { status: 404 });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      // Drain any unread (refused) body bytes so the client sees the response.
      req.removeAllListeners("data");
      req.on("data", () => undefined);
      req.resume();
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String((error as Error).message));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value))
      for (const v of value) headers.append(key, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://127.0.0.1${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as unknown as ReadableStream,
          duplex: "half",
        }
      : {}),
  } as RequestInit);
}
