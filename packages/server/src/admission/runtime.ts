import { serverConfig } from "../config.js";
import type { Queryable } from "../catalog/catalog.js";
import { s3ObjectReader } from "./object-reader.js";
import { admissionConfigFromEnv, type AdmissionDeps } from "./recordings.js";

/**
 * Production composition of the admission dependencies from explicit
 * settings. The pool must be the restricted application-role pool (the same
 * applicationDatabaseUrl the auth runtime uses); storage credentials are the
 * backend-only S3/R2 settings, used here solely for the bounded manifest read.
 * Identical in local, development and hosted (Render) environments: only the
 * injected environment differs.
 */
export function admissionDepsFromEnv(
  pool: Queryable,
  env: NodeJS.ProcessEnv = process.env,
): AdmissionDeps {
  return {
    pool,
    reader: s3ObjectReader(serverConfig(env)),
    config: admissionConfigFromEnv(env),
  };
}
