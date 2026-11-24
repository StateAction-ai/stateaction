"use client";

import { clientHeaders } from "../../app/client-header";
import { privateSignal } from "../../lib/private-state";

export class BrowserApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Private control responses stay small; media always uses a separate credential-free fetch. */
export async function readBounded(
  response: Response,
  max: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
    throw new Error("Response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new Error("Response too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function browserApi<T>(
  path: string,
  options: {
    method?: "POST" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: clientHeaders,
    signal: AbortSignal.any([
      privateSignal(),
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(20_000),
    ]),
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const bytes = await readBounded(response, 1024 * 1024);
  let json: { data?: T; error?: { code?: unknown; message?: unknown } };
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) {
    throw new BrowserApiError(
      response.status,
      response.status === 401
        ? "Your session ended. Sign in again."
        : response.status === 404
          ? "This page could not be found or is unavailable to your account."
          : response.status === 403
            ? "This view is unavailable for your account."
            : response.status === 409
              ? "The dataset changed, or a clip is not cleared for its recipients. Refresh and try again."
              : "The request could not be completed. Try again.",
    );
  }
  if (json.data === undefined)
    throw new Error("The server returned an unreadable response.");
  return json.data;
}
