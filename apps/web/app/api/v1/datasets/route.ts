import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
/** GET /api/v1/datasets: datasets visible to the signed-in staff/customer. */
export const GET = (request: Request) => routes.listDatasets(request);
/** POST /api/v1/datasets: staff create a dataset (client-chosen datasetId). */
export const POST = (request: Request) => routes.createDataset(request);
