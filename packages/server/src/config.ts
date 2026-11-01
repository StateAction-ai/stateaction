export type ServerConfig = {
  databaseUrl: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};
export function serverConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing server setting: ${key}`);
    return value;
  };
  return {
    databaseUrl: required("DATABASE_URL"),
    endpoint: required("S3_ENDPOINT"),
    region: required("S3_REGION"),
    bucket: required("S3_BUCKET"),
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  };
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
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  )
    throw new Error("Local workflow endpoint must be loopback HTTP");
  if (
    !env.LOCAL_SMOKE_TOKEN ||
    env.LOCAL_SMOKE_TOKEN.length < 24 ||
    env.LOCAL_SMOKE_TOKEN === "replace-with-a-local-random-token"
  )
    throw new Error("Set a random local smoke token");
}
