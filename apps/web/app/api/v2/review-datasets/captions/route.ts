import { CatalogError } from "@stateaction/server";
import { reviewBrowseRoutes } from "@stateaction/server/review-browse";
import {
  isBuiltInDataset,
  parseBrowserQuery,
} from "../../../../../lib/data-browser-query";
import { reviewBrowseOptions } from "../../../../../lib/review-browse-options";

export const runtime = "nodejs";

export function GET(request: Request) {
  return reviewBrowseRoutes().captions(request, (params, staff) => {
    try {
      const query = parseBrowserQuery(params, staff ? "staff" : "customer");
      if (
        !query.datasetId ||
        isBuiltInDataset(query.datasetId) ||
        query.cursor ||
        query.reviewCursor ||
        query.reviewStatus
      )
        throw new Error("Invalid dataset context");
      return reviewBrowseOptions(query, staff).filters;
    } catch {
      throw staff
        ? new CatalogError(
            "invalid_request",
            "Invalid caption download filters.",
          )
        : new CatalogError("not_found", "Not found");
    }
  });
}
