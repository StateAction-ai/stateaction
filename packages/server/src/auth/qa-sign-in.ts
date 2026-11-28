const MARKER = "x-stateaction-qa-sign-in";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "10.0.2.2"]);
const MAX_BODY_BYTES = 1024;

/** Recognize the explicitly marked password exchange before Better Auth runs. */
export async function allowsQaSignIn(
  request: Request,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!request.headers.has(MARKER)) return true;

  const email = env.AUTH_QA_COLLECTOR_EMAIL;
  if (
    request.headers.get(MARKER) !== "1" ||
    request.headers.get("x-stateaction-client") !== "android" ||
    request.method !== "POST" ||
    env.NODE_ENV !== "development" ||
    env.RENDER === "true" ||
    (env.APP_ENV !== "local" && env.APP_ENV !== "development") ||
    env.AUTH_LOCAL_PASSWORD !== "true" ||
    !email ||
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    return false;
  }

  const target = new URL(request.url);
  const backend = URL.parse(env.BETTER_AUTH_URL ?? "");
  // Next can construct request.url from its internal loopback bind address.
  // The configured public origin stays authoritative for the password request.
  const host = request.headers.get("host");
  const localTarget = LOCAL_HOSTS.has(target.hostname);
  if (
    target.pathname !== "/api/auth/sign-in/email" ||
    target.search ||
    !backend ||
    (backend.protocol !== "http:" && backend.protocol !== "https:") ||
    !(
      LOCAL_HOSTS.has(backend.hostname) ||
      (backend.protocol === "https:" && backend.hostname.endsWith(".ts.net"))
    ) ||
    (target.origin !== backend.origin && !localTarget) ||
    request.headers.get("origin") !== backend.origin ||
    (host !== backend.host &&
      !(
        localTarget &&
        target.host === host &&
        backend.protocol === "https:" &&
        request.headers.get("x-forwarded-host") === backend.host &&
        request.headers.get("x-forwarded-proto") === "https"
      ))
  ) {
    return false;
  }

  // Clone only after the deployment and origin checks. Better Auth consumes
  // the original request and remains responsible for the password exchange.
  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  const bytes = new Uint8Array(MAX_BODY_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) return false;
      bytes.set(value, length);
      length += value.byteLength;
    }
    const body = JSON.parse(
      new TextDecoder().decode(bytes.subarray(0, length)),
    );
    return (
      body !== null &&
      typeof body === "object" &&
      Object.keys(body).every((key) =>
        ["email", "password", "rememberMe"].includes(key),
      ) &&
      typeof body.email === "string" &&
      body.email.toLowerCase() === email.toLowerCase() &&
      typeof body.password === "string" &&
      body.rememberMe === true
    );
  } catch {
    return false;
  } finally {
    // The clone's cancellation may wait for the original stream to close.
    void reader.cancel().catch(() => undefined);
  }
}
