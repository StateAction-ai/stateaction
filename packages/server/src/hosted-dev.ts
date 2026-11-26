/** Local developer configuration for reading the production catalog and bucket. */
export const HOSTED_DEV_DATABASE_HOST =
  "dpg-dc2bek3rjlhs73ae5qg0-a.ohio-postgres.render.com";
export const HOSTED_DEV_READER = "stateaction_dev_reader";
export const HOSTED_DEV_READ_ONLY_MESSAGE = "This environment is read-only";
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export function hostedDevProfile(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.STATEACTION_HOSTED_DEV_MODE;
  if (!mode) return null;
  if (
    (mode !== "read-only" && mode !== "allow-writes") ||
    env.NODE_ENV !== "development" ||
    env.APP_ENV !== "development" ||
    env.RENDER ||
    env.RENDER_SERVICE_ID ||
    env.CI ||
    env.STATEACTION_WEB_HOST !== "127.0.0.1" ||
    env.AUTH_LOCAL_PASSWORD !== "true" ||
    env.GOOGLE_CLIENT_ID ||
    env.GOOGLE_CLIENT_SECRET
  ) {
    throw new Error(
      "Hosted data profile requires an interactive loopback development server with local password auth",
    );
  }
  const db = new URL(env.DATABASE_URL ?? "");
  const auth = new URL(env.STATEACTION_HOSTED_DEV_AUTH_DATABASE_URL ?? "");
  const origin = new URL(env.BETTER_AUTH_URL ?? "");
  const expectedRole =
    mode === "read-only" ? HOSTED_DEV_READER : "stateaction_app";
  if (
    db.protocol !== "postgresql:" ||
    db.hostname !== HOSTED_DEV_DATABASE_HOST ||
    db.pathname !== "/stateaction" ||
    db.username !== expectedRole ||
    db.search !== "?sslmode=verify-full" ||
    !LOOPBACK.includes(auth.hostname) ||
    auth.username !== "stateaction_app" ||
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    env.S3_BUCKET !== "stateaction-prod"
  ) {
    throw new Error(
      "Hosted data profile requires the designated catalog role, a local auth database and the production bucket",
    );
  }
  return { mode, authDatabaseUrl: auth.toString(), origin: origin.origin };
}
