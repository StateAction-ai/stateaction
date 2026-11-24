import type { SegmentMarkCommand } from "@stateaction/contracts";
import { rowOf, type SegmentMarkRow } from "./marks.ts";

/**
 * Where marks are kept. The API store talks to the staff routes of SA-99; the
 * in-memory store backs fixture data (no accepted job exists to pin a mark
 * to) and is labelled as such by the page.
 */
export type MarksListing = {
  jobId: string | null;
  segmentsSha256: string | null;
  marks: SegmentMarkRow[];
};

export type PostResult =
  | { ok: true; row: SegmentMarkRow }
  | { ok: false; code: FailCode; message: string };

export interface MarksStore {
  load(): Promise<MarksListing>;
  post(segmentId: string, command: SegmentMarkCommand): Promise<PostResult>;
}

const TIMEOUT_MS = 15_000;
const HEADERS = {
  "Content-Type": "application/json",
  "X-StateAction-Client": "web",
} as const;

type FailCode = "conflict" | "forbidden" | "invalid" | "unavailable";
const COPY: Record<FailCode, string> = {
  conflict:
    "Another mark or a new result arrived first. Marks were reloaded; choose again.",
  forbidden: "Only staff can record marks.",
  invalid: "The mark was not accepted.",
  unavailable: "Marks are unavailable right now. Try again.",
};

const fail = (code: FailCode): PostResult => ({
  ok: false,
  code,
  message: COPY[code],
});

export function apiMarksStore(recordingId: string, jobId?: string): MarksStore {
  const base = `/api/v1/recordings/${encodeURIComponent(recordingId)}`;
  return {
    async load() {
      const response = await fetch(
        `${base}/segment-marks?version=2${jobId ? `&run=${encodeURIComponent(jobId)}` : ""}`,
        {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`marks failed: ${response.status}`);
      const body = (await response.json()) as { data: MarksListing };
      return {
        jobId: body.data.jobId,
        segmentsSha256: body.data.segmentsSha256,
        marks: body.data.marks.map(rowOf),
      };
    },
    async post(segmentId, command) {
      const response = await fetch(
        `${base}/segments/${encodeURIComponent(segmentId)}/marks`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: HEADERS,
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      ).catch(() => null);
      if (!response) return fail("unavailable");
      if (response.status === 403 || response.status === 401)
        return fail("forbidden");
      if (response.status === 409) return fail("conflict");
      if (response.status === 404 || response.status === 422)
        return fail("invalid");
      if (!response.ok) return fail("unavailable");
      const body = (await response.json().catch(() => null)) as {
        data?: Parameters<typeof rowOf>[0];
      } | null;
      return body?.data
        ? { ok: true, row: rowOf(body.data) }
        : fail("unavailable");
    },
  };
}

/** Fixture-only store: same revision rules as the database, kept in memory. */
export function memoryMarksStore(
  jobId: string,
  segmentsSha256: string,
): MarksStore {
  const rows = new Map<string, SegmentMarkRow>();
  return {
    async load() {
      return { jobId, segmentsSha256, marks: [...rows.values()] };
    },
    async post(segmentId, command) {
      const current = rows.get(segmentId);
      if ((current?.revision ?? 0) !== command.expectedRevision)
        return fail("conflict");
      const row: SegmentMarkRow = {
        segmentId,
        revision: command.expectedRevision + 1,
        verdict: command.verdict,
        issueType:
          command.verdict === "issue" ? (command.issueType ?? null) : null,
        note: command.note ?? null,
        createdAt: new Date().toISOString(),
      };
      rows.set(segmentId, row);
      return { ok: true, row };
    },
  };
}
