import { AuthConfigError, type AuthConfig } from "./config.js";

export {
  UNSUPPORTED_AMBIENT_SETTINGS,
  unsupportedAmbientSettings,
  assertNoUnsupportedAmbientSettings,
} from "./config.js";

/** The subset of the awaited Better Auth context this module checks. */
export type EffectiveAuthContext = {
  baseURL: string;
  secret: string;
  secretConfig: unknown;
  trustedOrigins: string[];
};

/**
 * Compares the effective, awaited Better Auth context with the validated
 * config: same origin set, the configured secret (and no versioned secret
 * set), and the configured base URL. Throws `AuthConfigError` naming only the
 * mismatching property.
 */
export function verifyEffectiveContext(
  context: EffectiveAuthContext,
  config: Pick<AuthConfig, "baseURL" | "secret" | "trustedOrigins">,
): void {
  const expected = new Set(config.trustedOrigins);
  const actual = new Set(context.trustedOrigins);
  if (
    actual.size !== expected.size ||
    [...actual].some((origin) => !expected.has(origin))
  )
    throw new AuthConfigError(
      "Better Auth trusted origins differ from AUTH_TRUSTED_ORIGINS",
    );
  if (
    context.secret !== config.secret ||
    context.secretConfig !== config.secret
  )
    throw new AuthConfigError(
      "Better Auth signing secret differs from BETTER_AUTH_SECRET",
    );
  let base: string;
  try {
    base = new URL(context.baseURL).origin;
  } catch {
    base = "";
  }
  if (base !== config.baseURL)
    throw new AuthConfigError(
      "Better Auth base URL differs from BETTER_AUTH_URL",
    );
}
