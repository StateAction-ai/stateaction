/**
 * Authentication settings. Every value comes from the environment so the same
 * code runs on loopback, behind Tailscale Serve and on Render. Missing or
 * unsafe settings throw `AuthConfigError`; callers turn that into a generic
 * 503 and never echo setting names to ordinary users.
 */
/**
 * `local` (loopback-only dev), `development` (non-hosted dev, e.g. behind
 * Tailscale with real private storage), `test` (automated tests; the only
 * mode allowing the test-fixture access store), `staging`/`production`
 * (hosted: no local password sign-in, HTTPS required).
 */
export type AppEnvironment =
  | "local"
  | "development"
  | "test"
  | "staging"
  | "production";

export type AuthConfig = {
  appEnv: AppEnvironment;
  /** Public origin of the web service, e.g. https://host.example:8443. */
  baseURL: string;
  secret: string;
  /** Exact origins allowed for cookie-bearing mutations (baseURL first). */
  trustedOrigins: string[];
  /** HTTPS base URL implies `Secure` cookies with the `__Secure-` prefix. */
  secureCookies: boolean;
  /** Seeded email/password sign-in. Never available in hosted environments. */
  localPassword: boolean;
  google: { clientId: string; clientSecret: string } | null;
  databaseUrl: string;
  /** Where pilot roles are read from; `test-fixture` exists only for tests. */
  accessSource: { kind: "catalog" } | { kind: "test-fixture"; file: string };
};

export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

/**
 * Better Auth 1.7.15 settings it reads straight from the process environment,
 * even when explicit options are passed:
 *
 * - `BETTER_AUTH_TRUSTED_ORIGINS` is appended, unvalidated and including
 *   wildcard patterns, to `trustedOrigins` when the context is created and
 *   again on every request (context/helpers.mjs `getTrustedOrigins`).
 * - `BETTER_AUTH_SECRETS` takes precedence over `options.secret`
 *   (context/create-context.mjs), replacing the validated signing secret.
 *
 * StateAction does not support either. Trusted origins come only from the
 * validated `AUTH_TRUSTED_ORIGINS`; the signing secret only from
 * `BETTER_AUTH_SECRET` (rotating it signs everyone out, by design). Any
 * presence, including an empty value, fails closed. Values are never read
 * into messages or logs; only the setting name is reported.
 */
export const UNSUPPORTED_AMBIENT_SETTINGS = [
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "BETTER_AUTH_SECRETS",
] as const;

export function unsupportedAmbientSettings(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return UNSUPPORTED_AMBIENT_SETTINGS.filter((name) => env[name] !== undefined);
}

export function assertNoUnsupportedAmbientSettings(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const found = unsupportedAmbientSettings(env);
  if (found.length > 0)
    throw new AuthConfigError(
      `${found.join(" and ")} must not be set; use AUTH_TRUSTED_ORIGINS and BETTER_AUTH_SECRET`,
    );
}

const PLACEHOLDER = /^replace-with/i;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HOSTED = new Set<AppEnvironment>(["staging", "production"]);

function origin(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthConfigError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new AuthConfigError(`${label} must use http or https`);
  if (url.username || url.password || url.search || url.hash)
    throw new AuthConfigError(`${label} must be a bare origin`);
  if (url.pathname !== "/" && url.pathname !== "")
    throw new AuthConfigError(`${label} must not contain a path`);
  return url;
}

export type AuthConfigOptions = {
  /**
   * Resolves the auth database URL. Defaults to DATABASE_URL; hosted wiring
   * may inject the shared application-database resolver instead.
   */
  resolveDatabaseUrl?: (env: NodeJS.ProcessEnv) => string | undefined;
};

export function authConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: AuthConfigOptions = {},
): AuthConfig {
  const appEnv = env.APP_ENV;
  if (
    appEnv !== "local" &&
    appEnv !== "development" &&
    appEnv !== "test" &&
    appEnv !== "staging" &&
    appEnv !== "production"
  )
    throw new AuthConfigError(
      "APP_ENV must be local, development, test, staging or production",
    );
  // Render always sets RENDER=true; refuse local-only modes there even if
  // APP_ENV was copied incorrectly.
  const onRender = env.RENDER === "true";
  const hosted = HOSTED.has(appEnv) || onRender;

  assertNoUnsupportedAmbientSettings(env);

  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32 || PLACEHOLDER.test(secret))
    throw new AuthConfigError(
      "BETTER_AUTH_SECRET must be a random value of at least 32 characters",
    );
  // Better Auth ignores AUTH_SECRET while BETTER_AUTH_SECRET is passed, so a
  // different value is a copied or stale setting, never a second key.
  if (env.AUTH_SECRET !== undefined && env.AUTH_SECRET !== secret)
    throw new AuthConfigError(
      "AUTH_SECRET must be unset or equal BETTER_AUTH_SECRET",
    );

  let databaseUrl: string | undefined;
  try {
    databaseUrl = (options.resolveDatabaseUrl ?? ((e) => e.DATABASE_URL))(env);
  } catch {
    throw new AuthConfigError("The auth database URL could not be resolved");
  }
  if (!databaseUrl) throw new AuthConfigError("DATABASE_URL is required");

  const base = origin(env.BETTER_AUTH_URL ?? "", "BETTER_AUTH_URL");
  if (base.protocol !== "https:" && (hosted || !LOOPBACK.has(base.hostname)))
    throw new AuthConfigError(
      "BETTER_AUTH_URL must use https outside loopback development",
    );
  const baseURL = base.origin;

  const extra = (env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      if (v.includes("*"))
        throw new AuthConfigError(
          "AUTH_TRUSTED_ORIGINS must not contain wildcards",
        );
      const url = origin(v, "AUTH_TRUSTED_ORIGINS");
      if (url.protocol !== "https:" && (hosted || !LOOPBACK.has(url.hostname)))
        throw new AuthConfigError(
          "AUTH_TRUSTED_ORIGINS must use https outside loopback development",
        );
      return url.origin;
    });
  const trustedOrigins = [...new Set([baseURL, ...extra])];

  const localPasswordSetting = env.AUTH_LOCAL_PASSWORD ?? "false";
  if (localPasswordSetting !== "true" && localPasswordSetting !== "false")
    throw new AuthConfigError("AUTH_LOCAL_PASSWORD must be true or false");
  const localPassword = localPasswordSetting === "true";
  if (localPassword && hosted)
    throw new AuthConfigError(
      "AUTH_LOCAL_PASSWORD is only allowed for local, development or test environments",
    );

  const clientId = env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET ?? "";
  if (Boolean(clientId) !== Boolean(clientSecret))
    throw new AuthConfigError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
    );
  const google = clientId ? { clientId, clientSecret } : null;
  if (!google && !localPassword)
    throw new AuthConfigError("No sign-in method is configured");

  const source = env.AUTH_ACCESS_SOURCE ?? "catalog";
  let accessSource: AuthConfig["accessSource"];
  if (source === "catalog") accessSource = { kind: "catalog" };
  else if (source === "test-fixture") {
    if (appEnv !== "test" || onRender)
      throw new AuthConfigError(
        "AUTH_ACCESS_SOURCE=test-fixture is only allowed with APP_ENV=test",
      );
    const file = env.AUTH_TEST_ACCESS_FIXTURE ?? "";
    if (!file)
      throw new AuthConfigError(
        "AUTH_TEST_ACCESS_FIXTURE is required for test-fixture access",
      );
    accessSource = { kind: "test-fixture", file };
  } else
    throw new AuthConfigError(
      "AUTH_ACCESS_SOURCE must be catalog or test-fixture",
    );

  return {
    appEnv,
    baseURL,
    secret,
    trustedOrigins,
    secureCookies: base.protocol === "https:",
    localPassword,
    google,
    databaseUrl,
    accessSource,
  };
}
