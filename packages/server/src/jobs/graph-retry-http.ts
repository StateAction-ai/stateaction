import { randomUUID } from "node:crypto";
import type { DatasetAuthenticate } from "../datasets/http.js";
import {
  hostedDevProfile,
  HOSTED_DEV_READ_ONLY_MESSAGE,
} from "../hosted-dev.js";
import { TransportError } from "../transport/errors.js";
import { errorResponse, readBoundedJson } from "../transport/http.js";
import { confirmGraphRetry, previewGraphRetry } from "./graph-retry.js";
import type { JobsDeps } from "./service.js";

export function graphRetryRoutes(
  authenticate: DatasetAuthenticate,
  deps: () => JobsDeps,
) {
  function route(mode: "preview" | "confirm") {
    return async (request: Request, recordingId: string) => {
      const auth = await authenticate(request, "staff");
      if (!auth.ok) return auth.response;
      const requestId = auth.requestId ?? randomUUID();
      try {
        if (hostedDevProfile()?.mode === "read-only")
          throw new TransportError("forbidden", HOSTED_DEV_READ_ONLY_MESSAGE);
        if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(recordingId))
          throw new TransportError("not_found", "Recording not found");
        const actor = auth.principal.userId;
        const headers = new Headers(auth.headers);
        headers.set("cache-control", "private, no-store");
        if (mode === "preview") {
          const body = (await readBoundedJson(
            request,
            "http.graph-retry-request.v1",
            8192,
          )) as Parameters<typeof previewGraphRetry>[3];
          const data = await previewGraphRetry(
            deps(),
            actor,
            recordingId,
            body,
          );
          return Response.json({ data, requestId }, { headers });
        }
        const body = (await readBoundedJson(
          request,
          "http.graph-retry-command.v1",
          8192,
        )) as Parameters<typeof confirmGraphRetry>[3];
        const data = await confirmGraphRetry(deps(), actor, recordingId, body);
        return Response.json(
          { data, requestId },
          { headers, status: data.replayed ? 200 : 201 },
        );
      } catch (error) {
        return errorResponse(error, requestId);
      }
    };
  }
  return { preview: route("preview"), confirm: route("confirm") };
}
