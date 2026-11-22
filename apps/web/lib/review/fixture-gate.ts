// Fixture review data is for local development and screenshots only, and only
// with APP_ENV=local AND an explicit STATEACTION_REVIEW_DATA=fixture. APP_ENV=local
// alone reads the real stack (the SA-96 dev stack runs with APP_ENV=local).
// Hosted builds (Render, production, staging) refuse it even when the flag is set.

export function fixtureEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const hosted =
    env.RENDER === "true" ||
    env.APP_ENV === "production" ||
    env.APP_ENV === "staging";
  if (hosted) return false;
  // Allow-list: a hosted build with APP_ENV unset must not serve fixtures either.
  return env.APP_ENV === "local" && env.STATEACTION_REVIEW_DATA === "fixture";
}
