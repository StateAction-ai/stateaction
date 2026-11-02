import "server-only";
export {
  ROLES,
  decideAccess,
  CatalogAccessStore,
  TestFixtureAccessStore,
  type Role,
  type AccessGrant,
  type AccessStore,
  type AccessStatus,
  type AccessDecision,
} from "./access.js";
export {
  verifyEffectiveContext,
  type EffectiveAuthContext,
} from "./ambient.js";
export {
  UNSUPPORTED_AMBIENT_SETTINGS,
  assertNoUnsupportedAmbientSettings,
  authConfig,
  AuthConfigError,
  type AuthConfig,
  type AuthConfigOptions,
  type AppEnvironment,
} from "./config.js";
export {
  CLIENT_HEADER,
  authenticateHuman,
  betterAuthSessionLookup,
  mutationOriginProblem,
  type GuardDeps,
  type GuardResult,
  type HumanPrincipal,
  type HumanRequirement,
  type SessionLookup,
} from "./guard.js";
export {
  PRIVATE_CACHE_HEADERS,
  errorResponse,
  successResponse,
} from "./http.js";
export {
  createAuth,
  createAuthPool,
  DISABLED_AUTH_PATHS,
  type Auth,
} from "./instance.js";
export {
  authRuntime,
  createAuthRuntime,
  authRouteHandlers,
  meRoute,
  withHuman,
  pageIdentity,
  signInMethods,
  type AuthRuntime,
  type AuthRuntimeOptions,
  type PageIdentity,
} from "./runtime.js";
export {
  SERVICE_SCOPES,
  authenticateService,
  hashServiceToken,
  issueServiceCredential,
  type ServiceKind,
  type ServiceScope,
  type ServicePrincipal,
  type ServiceRequirement,
  type ServiceCredentialRecord,
  type ServiceCredentialStore,
} from "./service.js";
