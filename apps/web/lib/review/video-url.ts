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
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(readPath, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-stateaction-client": "web",
      },
      body: JSON.stringify({ role: "recording_mp4" }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new VideoUrlError("The video link could not be requested.");
  }
  if (!response.ok) throw new VideoUrlError("The video link was not issued.");
  const body = (await response.json().catch(() => null)) as {
    data?: { url?: unknown };
  } | null;
  if (typeof body?.data?.url !== "string")
    throw new VideoUrlError("The video link was missing.");
  return body.data.url;
}

/** Renewals allowed in a row before the player reports the video as unavailable. */
export const MAX_RENEWALS = 3;

/**
 * Where playback resumes after a renewal: the time the element had reached,
 * clamped into the recording; falls back to the last known playhead.
 */
export function resumeAt(
  elementTime: number,
  lastKnown: number,
  durationS: number,
): number {
  const t =
    Number.isFinite(elementTime) && elementTime > 0 ? elementTime : lastKnown;
  return Math.min(Math.max(0, t), Math.max(0, durationS));
}
