import "server-only";
import { s3ObjectReader } from "../admission/object-reader.js";
import { errorResponse, successResponse } from "../auth/http.js";
import { authRuntime, withHuman, type AuthRuntime } from "../auth/runtime.js";
import { CatalogError } from "../catalog/errors.js";
import { serverConfig } from "../config.js";
import {
  exportReviewDatasetCaptions,
  type ReviewDatasetSearchOptions,
} from "./review-catalog.js";
import { searchReviewPickerDatasets } from "./review-picker.js";

function failure(error: unknown, requestId: string, headers: Headers) {
  if (error instanceof CatalogError) {
    if (error.code === "invalid_request")
      return errorResponse(error.code, error.message, requestId, headers);
    if (error.code === "not_found" || error.code === "conflict")
      return Response.json(
        {
          error: {
            code: error.code,
            message: error.code === "not_found" ? "Not found" : error.message,
            retryable: error.code === "conflict",
          },
          requestId,
        },
        { status: error.code === "not_found" ? 404 : 409, headers },
      );
  }
  console.error(
    "[review-browse]",
    error instanceof Error ? error.name : "unknown",
  );
  return errorResponse(
    "internal",
    "The request could not be completed.",
    requestId,
    headers,
  );
}

export function reviewBrowseRoutes(get: () => AuthRuntime = authRuntime) {
  return {
    captions(
      request: Request,
      parse: (
        params: URLSearchParams,
        staff: boolean,
      ) => Omit<ReviewDatasetSearchOptions, "viewerUserId">,
    ) {
      return withHuman(
        request,
        { anyRole: ["staff", "customer"] },
        async (principal, requestId, headers) => {
          try {
            const params = new URL(request.url).searchParams;
            const options = parse(
              params,
              principal.access.roles.includes("staff"),
            );
            const body = await exportReviewDatasetCaptions(
              get().pool,
              {
                ...options,
                viewerUserId: principal.userId,
              },
              () => s3ObjectReader(serverConfig(), { timeoutMs: 3000 }),
            );
            headers.set("Content-Type", "application/json");
            headers.set("Content-Length", String(Buffer.byteLength(body)));
            headers.set(
              "Content-Disposition",
              'attachment; filename="captions.json"',
            );
            return new Response(body, { headers });
          } catch (error) {
            return failure(error, requestId, headers);
          }
        },
        get,
      );
    },
    picker(request: Request, clipId: string) {
      return withHuman(
        request,
        { anyRole: ["staff", "customer"] },
        async (principal, requestId, headers) => {
          try {
            if (!principal.access.roles.includes("staff"))
              throw new CatalogError("not_found", "Not found");
            const params = new URL(request.url).searchParams;
            if (
              params.toString().length > 4500 ||
              params.getAll("q").length > 1 ||
              [...params.keys()].some((key) => key !== "q" && key !== "id")
            )
              throw new CatalogError(
                "invalid_request",
                "Invalid dataset picker query",
              );
            return successResponse(
              await searchReviewPickerDatasets(get().pool, {
                viewerUserId: principal.userId,
                clipId,
                q: params.get("q") ?? "",
                ids: params.getAll("id"),
              }),
              requestId,
              headers,
            );
          } catch (error) {
            return failure(error, requestId, headers);
          }
        },
        get,
      );
    },
  };
}
