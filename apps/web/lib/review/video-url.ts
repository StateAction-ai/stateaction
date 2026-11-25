// Review-video URLs come from the broker (`recording_mp4`, staff only, 60 s
// TTL). The player asks again when the media element errors or the URL
// expires, and resumes at the time it had reached.

export class VideoUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoUrlError";
  }
}

export async function fetchVideoUrl(
  readPath: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    method?: "GET" | "POST";
  } = {},
): Promise<{ url: string; expiresAt: number }> {
  const doFetch = options.fetchImpl ?? fetch;
  const method = options.method ?? "POST";
  let response: Response;
  try {
    response = await doFetch(readPath, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-stateaction-client": "web",
      },
      ...(method === "POST"
        ? { body: JSON.stringify({ role: "recording_mp4" }) }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new VideoUrlError("The video link could not be requested.");
  }
  if (!response.ok) throw new VideoUrlError("The video link was not issued.");
  const body = (await response.json().catch(() => null)) as {
    data?: { url?: unknown; expiresAt?: unknown };
  } | null;
  if (typeof body?.data?.url !== "string")
    throw new VideoUrlError("The video link was missing.");
  const expiresAt =
    typeof body.data.expiresAt === "string"
      ? Date.parse(body.data.expiresAt)
      : NaN;
  if (!Number.isFinite(expiresAt))
    throw new VideoUrlError("The video link expiry was missing.");
  return { url: body.data.url, expiresAt };
}

/** Renewals allowed in a row before the player reports the video as unavailable. */
export const MAX_RENEWALS = 3;
