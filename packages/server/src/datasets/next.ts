import "server-only";
import { authenticateHuman } from "../auth/guard.js";
import { errorResponse, newRequestId } from "../auth/http.js";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import { serverConfig } from "../config.js";
import { storageClient } from "../storage.js";
import { S3ReadSigner } from "./broker.js";
import { datasetRoutes, type DatasetAuthenticate } from "./http.js";

/**
 * The Better Auth boundary for dataset routes. Every request re-reads the
 * session from the shared Better Auth instance and the enabled roles from
 * operator-managed `access` rows (staff, or staff/customer for reads);
 * mutations must also pass the origin/Fetch-Metadata/client-header checks.
 * Bearer credentials are refused. The database queries then recheck the role,
 * grant, evidence, membership and approval in the same statement they read.
 * There is no fixture identity or header fallback and no owner credential:
 * the pool is the restricted application role's.
 */
export function datasetAuthenticator(
  get: () => AuthRuntime = authRuntime,
): DatasetAuthenticate {
  return async (request, need) => {
    let runtime: AuthRuntime;
    try {
      runtime = get();
      await runtime.ready();
    } catch (error) {
      console.error(
        "[datasets] auth unavailable",
        error instanceof Error ? error.name : "unknown",
      );
      return { ok: false, response: unavailable() };
    }
    const result = await authenticateHuman(request, runtime.guard, {
      anyRole: need === "staff" ? ["staff"] : ["staff", "customer"],
    });
    if (!result.ok) return result;
    return {
      ok: true,
      principal: { userId: result.principal.userId },
      requestId: result.requestId,
      headers: result.headers,
    };
  };
}

function unavailable(): Response {
  return errorResponse(
    "provider_unavailable",
    "Dataset service is temporarily unavailable",
    newRequestId(),
  );
}

type Routes = ReturnType<typeof datasetRoutes>;
const KEY = Symbol.for("stateaction.datasets.routes");
type Holder = { [KEY]?: Routes };

/**
 * Process-wide dataset routes: the auth runtime's restricted application-role
 * pool and a read signer from the same S3/R2 settings uploads use (signing
 * against the origin clients can reach; credentials never leave the process).
 * Configuration errors answer 503 and are logged without detail.
 */
export function datasetRouteHandlers(get: () => AuthRuntime = authRuntime) {
  const routes = (): Routes => {
    const holder = globalThis as Holder;
    if (holder[KEY]) return holder[KEY];
    const runtime = get();
    const config = serverConfig();
    return (holder[KEY] = datasetRoutes({
      pool: runtime.pool,
      signer: new S3ReadSigner(
        storageClient(config, 15_000, config.publicEndpoint),
        config.bucket,
      ),
      authenticate: datasetAuthenticator(get),
    }));
  };
  const guarded =
    <A extends unknown[]>(
      pick: (r: Routes) => (request: Request, ...args: A) => Promise<Response>,
    ) =>
    async (request: Request, ...args: A): Promise<Response> => {
      let r: Routes;
      try {
        r = routes();
      } catch (error) {
        console.error(
          "[datasets] configuration error:",
          error instanceof Error ? error.message : "unknown",
        );
        return unavailable();
      }
      return pick(r)(request, ...args);
    };
  return {
    listDatasets: guarded((r) => r.listDatasets),
    createDataset: guarded((r) => r.createDataset),
    getDataset: guarded((r) => r.getDataset),
    renameDataset: guarded((r) => r.renameDataset),
    listDatasetClips: guarded((r) => r.listDatasetClips),
    addDatasetClips: guarded((r) => r.addDatasetClips),
    removeDatasetClip: guarded((r) => r.removeDatasetClip),
    getDatasetClip: guarded((r) => r.getDatasetClip),
    readDatasetClip: guarded((r) => r.readDatasetClip),
    listClips: guarded((r) => r.listClips),
    getClip: guarded((r) => r.getClip),
    readClip: guarded((r) => r.readClip),
  };
}
