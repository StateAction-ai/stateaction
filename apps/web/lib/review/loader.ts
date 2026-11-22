import "server-only";
import { reviewReads } from "@stateaction/server/annotations";
import { estimateDurationS } from "./duration.ts";
import { fixtureEnabled } from "./fixture-gate.ts";
import { fixtureLoader } from "./fixture.ts";
import { originOf } from "./model.ts";
import {
  ReviewDataUnavailable,
  type ReviewBundle,
  type ReviewLoader,
} from "./types.ts";

/**
 * The review page's data source: the accepted job's annotations, read
 * server-side (the same reader the `GET /api/v1/recordings/{id}/annotations`
 * route uses), the recording's clips and whether `recording.mp4` exists.
 * Fixture data exists for screenshots only and needs STATEACTION_REVIEW_DATA=
 * fixture (never on a hosted build; see fixture-gate.ts); every page it feeds
 * is labelled "Fixture data".
 */
export function reviewLoader(): ReviewLoader {
  if (fixtureEnabled(process.env)) return fixtureLoader();
  const reads = reviewReads();
  return {
    listRecordings: (userId) => reads.list(userId),
    async load(userId, recordingId): Promise<ReviewBundle | null> {
      let found;
      try {
        found = await reads.load(userId, recordingId);
      } catch (error) {
        // A coded failure (unreadable or invalid document, storage outage) is shown as such.
        const code = (error as { code?: unknown }).code;
        if (
          (error as Error).name === "TransportError" &&
          (code === "conflict" || code === "provider_unavailable")
        )
          throw new ReviewDataUnavailable(
            `${(error as Error).message} (${String(code)}).`,
          );
        throw error;
      }
      if (!found) return null;
      const { annotations, extras } = found;
      return {
        recording: {
          recordingId,
          title: extras.title,
          durationS: estimateDurationS(annotations, originOf(annotations)),
        },
        annotations,
        clips: extras.clips,
        video: extras.hasVideo
          ? {
              kind: "broker",
              readPath: `/api/v1/recordings/${recordingId}/reads`,
            }
          : { kind: "none", reason: "This recording has no review video." },
        origin: "api",
      };
    },
  };
}
