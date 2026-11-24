import { randomUUID } from "node:crypto";
import { withHuman } from "../auth/runtime.js";
import { hostedDevProfile } from "../hosted-dev.js";

type Ticket = { signedUrl: string; expires: number };
const KEY = Symbol.for("stateaction.hosted-dev.media");
const holder = globalThis as { [KEY]?: Map<string, Ticket> };
const MAX_TICKETS = 1024;

/** Keep R2 presigned URLs server-side in this profile. The browser uses loopback. */
export function issueHostedDevMedia(
  signedUrl: string,
  ttlSeconds: number,
): string {
  const profile = hostedDevProfile();
  if (!profile) return signedUrl;
  const tickets = (holder[KEY] ??= new Map());
  const now = Date.now();
  for (const [id, entry] of tickets)
    if (entry.expires <= now) tickets.delete(id);
  if (tickets.size >= MAX_TICKETS)
    throw new Error("Too many active local media reads");
  const id = randomUUID();
  tickets.set(id, { signedUrl, expires: now + ttlSeconds * 1000 });
  return `${profile.origin}/api/v1/development/hosted-media/${id}`;
}

const MEDIA_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
] as const;

export async function hostedDevMediaRoute(
  request: Request,
  id: string,
): Promise<Response> {
  const profile = hostedDevProfile();
  // Next's loopback dev server can normalize request.url to localhost.
  // Validate the exact incoming Host and any browser-supplied Origin instead.
  const origin = request.headers.get("origin");
  if (
    !profile ||
    request.headers.get("host") !== new URL(profile.origin).host ||
    (origin !== null && origin !== profile.origin)
  )
    return new Response(null, { status: 404 });
  return withHuman(request, { anyRole: ["staff"] }, async () => {
    const entry = holder[KEY]?.get(id);
    if (!entry || entry.expires <= Date.now())
      return new Response(null, { status: 404 });
    const range = request.headers.get("range");
    if (range && !/^bytes=[0-9]{0,16}-[0-9]{0,16}$/.test(range))
      return new Response(null, { status: 416 });
    let upstream: Response;
    try {
      upstream = await fetch(entry.signedUrl, {
        headers: range ? { range } : {},
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
      });
    } catch {
      return new Response(null, { status: 502 });
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return new Response(null, {
        status: upstream.status === 416 ? 416 : 502,
      });
    }
    const headers = new Headers({
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    for (const name of MEDIA_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}
