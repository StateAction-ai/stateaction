import { betterAuth } from "better-auth";
import pg from "pg";
import {
  assertNoUnsupportedAmbientSettings,
  type AuthConfig,
} from "./config.js";

const DAY = 60 * 60 * 24;

/**
 * Endpoints the pilot does not use. Account linking/unlinking would let one
 * identity adopt another; email change, deletion and password-reset need
 * operator or mail flows that do not exist. Sign-up stays off: identities
 * are seeded locally, and Google creates an identity with no roles.
 * `/update-user` is off too: display names are set by the seed or Google and
 * are untrusted display text either way, never an operator-assigned label.
 */
export const DISABLED_AUTH_PATHS = [
  "/sign-up/email",
  "/update-user",
  "/request-password-reset",
  "/reset-password",
  "/verify-email",
  "/send-verification-email",
  "/change-email",
  "/delete-user",
  "/link-social",
  "/unlink-account",
  "/account-info",
  "/get-access-token",
  "/refresh-token",
];

/**
 * Builds the one Better Auth instance. `ambientEnv` is the environment Better
 * Auth itself reads (always `process.env` in Node); settings it would merge
 * behind the validated config fail closed here, before construction.
 */
export function createAuth(
  config: AuthConfig,
  pool: pg.Pool,
  ambientEnv: Readonly<Record<string, string | undefined>> = process.env,
) {
  assertNoUnsupportedAmbientSettings(ambientEnv);
  return betterAuth({
    appName: "StateAction.ai",
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    database: pool,
    trustedOrigins: config.trustedOrigins,
    telemetry: { enabled: false },
    disabledPaths: DISABLED_AUTH_PATHS,
    emailAndPassword: {
      enabled: config.localPassword,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    socialProviders: config.google
      ? {
          google: {
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
            prompt: "select_account",
          },
        }
      : {},
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
    },
    user: {
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    session: {
      expiresIn: 7 * DAY,
      updateAge: DAY,
      // Authoritative revocation: every request reads the session row.
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: "memory" },
    advanced: {
      // Only the single-value X-Forwarded-For set by the selected ingress
      // (Tailscale Serve overwrites it; it preserves a forged X-Real-IP), never
      // X-Real-IP or other client-controlled headers. See auth-and-access.md.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
      useSecureCookies: config.secureCookies,
      // Explicit so NODE_ENV=test never silently skips the checks.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.secureCookies,
        path: "/",
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuthPool(config: AuthConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}
