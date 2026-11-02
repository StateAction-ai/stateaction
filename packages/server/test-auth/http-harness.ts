// Real socket harness for auth runtime tests: a node:http server that turns
// requests into Fetch `Request`s for the same handlers Next mounts, and a raw
// node:http client. Unlike fetch(), the client adds no Fetch Metadata headers,
// so each case sends exactly the browser or native headers it simulates.
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";

export const SESSION_COOKIE = "better-auth.session_token";

async function toRequest(req: IncomingMessage, origin: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method ?? "GET",
    headers,
    ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
  });
}

let clients = 0;
/** TEST-ONLY simulated client address for Better Auth's per-IP limiter. */
export const nextIp = () => `198.51.100.${(++clients % 250) + 1}`;

export class Jar {
  cookies = new Map<string, string>();
  ip = nextIp();
  apply(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get session() {
    return this.cookies.get(SESSION_COOKIE);
  }
  /** The server-side token (the signed cookie value before its signature). */
  get token() {
    return decodeURIComponent(this.session ?? "").split(".")[0]!;
  }
}

export type CallInit = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  jar?: Jar;
};

export type Harness = {
  origin: string;
  call(path: string, init?: CallInit): Promise<Response>;
  browserPost(
    jar: Jar | undefined,
    body: unknown,
    extra?: Record<string, string>,
  ): CallInit;
  close(): Promise<void>;
};

export async function startHarness(
  route: (request: Request) => Promise<Response>,
): Promise<Harness> {
  let origin = "";
  const server: Server = createServer(async (req, res) => {
    try {
      const response = await route(await toRequest(req, origin));
      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") headers[key] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(path: string, init: CallInit = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {}))
      if (v !== "") headers[k.toLowerCase()] = v;
    if (init.jar?.cookies.size) headers.cookie = init.jar.header();
    headers["x-forwarded-for"] ??= init.jar?.ip ?? nextIp();
    const response = await new Promise<Response>((resolve, reject) => {
      const req = request(
        origin + path,
        { method: init.method ?? "GET", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers))
              if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
              else if (v !== undefined) h.set(k, v);
            resolve(
              new Response(chunks.length ? Buffer.concat(chunks) : null, {
                status: res.statusCode ?? 0,
                headers: h,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      if (init.body !== undefined) req.end(init.body);
      else req.end();
    });
    init.jar?.apply(response);
    return response;
  }

  const browserPost = (
    jar: Jar | undefined,
    body: unknown,
    extra: Record<string, string> = {},
  ): CallInit => ({
    method: "POST",
    ...(jar ? { jar } : {}),
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "x-stateaction-client": "web",
      ...extra,
    },
  });

  return {
    origin,
    call,
    browserPost,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
