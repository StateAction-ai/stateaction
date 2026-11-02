export type AppEnv = "local" | "development" | "production";
export type ServerConfig = {
  appEnv: AppEnv;
  databaseUrl: string;
  endpoint: string;
  /** Origin embedded in presigned URLs; clients (phones) must reach it. */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const EXAMPLE_SECRETS = [
  "stateaction-local",
  "stateaction-local-only",
  "stateaction-local-only-secret",
];
export function appEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const value = env.APP_ENV;
  if (value === "local" || value === "development" || value === "production")
    return value;
  throw new Error("APP_ENV must be local, development or production");
}
/**
 * Database URL for the restricted application role. Hosted Blueprints supply
 * host/port/name from Render and a generated role password, so no human has to
 * compose a connection string and the owner URL is never in this process.
 */
export function applicationDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.DATABASE_URL) {
    // An explicit DSN is accepted outside production. In production it must be
    // the restricted application role: Render's fromDatabase connectionString
    // is the OWNER and must never run the web service.
    if (env.APP_ENV === "production") {
      let username: string;
      try {
        username = decodeURIComponent(new URL(env.DATABASE_URL).username);
      } catch {
        throw new Error("Production DATABASE_URL is not a valid URL");
      }
      if (username !== APP_DB_ROLE)
        throw new Error(
          `Production DATABASE_URL must use the restricted ${APP_DB_ROLE} role`,
        );
    }
    return env.DATABASE_URL;
  }
  const { DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, APP_DB_PASSWORD } = env;
  if (!DATABASE_HOST || !DATABASE_NAME || !APP_DB_PASSWORD)
    throw new Error(
      "Missing server setting: DATABASE_URL (or DATABASE_HOST, DATABASE_NAME, APP_DB_PASSWORD)",
    );
  const url = new URL("postgresql://localhost");
  url.username = APP_DB_ROLE;
  url.password = APP_DB_PASSWORD;
  url.hostname = DATABASE_HOST;
  url.port = DATABASE_PORT ?? "5432";
  url.pathname = `/${DATABASE_NAME}`;
  return url.toString();
}
export const APP_DB_ROLE = "stateaction_app";
export function serverConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing server setting: ${key}`);
    return value;
  };
  const endpoint = required("S3_ENDPOINT");
  const config: ServerConfig = {
    appEnv: appEnv(env),
    databaseUrl: applicationDatabaseUrl(env),
    endpoint,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT || endpoint,
    region: required("S3_REGION"),
    bucket: required("S3_BUCKET"),
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  };
  assertEnvironmentIsolation(config);
  return config;
}
const isLoopback = (address: string) =>
  LOOPBACK.includes(new URL(address).hostname);
const isR2 = (address: string) =>
  new URL(address).hostname.endsWith(".r2.cloudflarestorage.com");
/**
 * Local, development and production endpoints/secrets must never mix:
 * - local: loopback database, non-R2 storage, never a hosted bucket.
 * - development: real private R2 with a local or Tailscale database.
 * - production: no loopback endpoints, HTTPS R2, no example credentials.
 */
export function assertEnvironmentIsolation(config: ServerConfig): void {
  const storage = [config.endpoint, config.publicEndpoint];
  if (config.appEnv === "local") {
    if (!isLoopback(config.databaseUrl) || !isLoopback(config.endpoint))
      throw new Error("Local environment requires loopback database/storage");
    if (storage.some(isR2))
      throw new Error("Local environment must not use Cloudflare R2");
    return;
  }
  if (
    !isR2(config.endpoint) ||
    storage.some((address) => new URL(address).protocol !== "https:")
  )
    throw new Error(
      `${config.appEnv} environment requires HTTPS Cloudflare R2`,
    );
  if (
    EXAMPLE_SECRETS.includes(config.accessKeyId) ||
    EXAMPLE_SECRETS.includes(config.secretAccessKey) ||
    config.bucket === "stateaction-local"
  )
    throw new Error("Local example credentials are not valid outside local");
  // Presigned URLs are credentials-bearing: outside local they may only be
  // issued for the configured private R2 origin (TLS hostname is the R2 host).
  if (new URL(config.publicEndpoint).origin !== new URL(config.endpoint).origin)
    throw new Error(
      `${config.appEnv} S3_PUBLIC_ENDPOINT must equal the private R2 S3_ENDPOINT origin`,
    );
  if (config.appEnv === "production" && isLoopback(config.databaseUrl))
    throw new Error("Production must not use a loopback database");
  if (config.appEnv === "production" && config.bucket.endsWith("-dev"))
    throw new Error("Production must not use the development bucket");
}
export function assertLocalDispatch(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env.APP_ENV !== "local" ||
    env.NODE_ENV === "production" ||
    env.RENDER_USE_LOCAL_DEV !== "true"
  )
    throw new Error("Development dispatch is disabled");
  const target = new URL(env.RENDER_LOCAL_DEV_URL ?? "http://127.0.0.1:8120");
  if (target.protocol !== "http:" || !LOOPBACK.includes(target.hostname))
    throw new Error("Local workflow endpoint must be loopback HTTP");
  if (
    !env.LOCAL_SMOKE_TOKEN ||
    env.LOCAL_SMOKE_TOKEN.length < 24 ||
    env.LOCAL_SMOKE_TOKEN === "replace-with-a-local-random-token"
  )
    throw new Error("Set a random local smoke token");
}
