"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildMarkCommand,
  markMap,
  type MarkChoice,
  type MarkMap,
  type SegmentMarkRow,
} from "./marks";
import type { MarksListing, MarksStore } from "./marks-store";

export type MarksState = {
  marks: MarkMap;
  /** False until the first listing arrived; marking is disabled before. */
  loaded: boolean;
  busy: boolean;
  /** A short, curated message for the last failure, or null. */
  error: string | null;
  /** Append a mark for one segment (the newest mark is what the reviewer saw). */
  choose: (segmentId: string, choice: MarkChoice) => Promise<void>;
};

/**
 * Marks of one recording. A mark is appended, never edited: the next choice is
 * a new revision against the newest one seen. A conflict (another reviewer or
 * a new accepted result) reloads the listing instead of overwriting it.
 */
export function useMarks(
  store: MarksStore,
  /** The accepted job this page shows; a different current job blocks marking. */
  shownJobId: string | null,
): MarksState {
  const [rows, setRows] = useState<ReadonlyMap<string, SegmentMarkRow>>(
    () => new Map(),
  );
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const pin = useRef<Pick<MarksListing, "jobId" | "segmentsSha256">>({
    jobId: null,
    segmentsSha256: null,
  });
  const latest = useRef(rows);
  latest.current = rows;
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    const listing = await store.load();
    pin.current = {
      jobId: listing.jobId,
      segmentsSha256: listing.segmentsSha256,
    };
    setRows(markMap(listing.marks));
    setLoaded(true);
    setLoadFailed(false);
  }, [store]);

  useEffect(() => {
    let live = true;
    reload().catch(() => {
      if (live) {
        setLoadFailed(true);
        setError("Marks could not be loaded.");
      }
    });
    return () => {
      live = false;
    };
  }, [reload]);

  const choose = useCallback(
    async (segmentId: string, choice: MarkChoice) => {
      const { jobId, segmentsSha256 } = pin.current;
      if (inFlight.current) return;
      if (!loaded) {
        setError(
          loadFailed
            ? "Marks could not be loaded."
            : "Marks are still loading. Try again.",
        );
        return;
      }
      if (!jobId || !segmentsSha256) {
        setError("This recording has no accepted segments to mark.");
        return;
      }
      if (shownJobId !== null && jobId !== shownJobId) {
        // A newer result replaced the one on screen: never mark it with this page's ids.
        setError("A newer result is available. Reload this page to mark it.");
        return;
      }
      const shown = latest.current.get(segmentId);
      if (
        shown &&
        shown.verdict === choice.verdict &&
        (choice.verdict === "good" ||
          shown.issueType === (choice.issueType ?? shown.issueType)) &&
        (choice.note === undefined || choice.note === (shown.note ?? ""))
      )
        return; // nothing changes: no duplicate revision
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const result = await store.post(
          segmentId,
          buildMarkCommand({
            markId: crypto.randomUUID(),
            jobId,
            segmentsSha256,
            current: latest.current.get(segmentId),
            choice,
          }),
        );
        if (result.ok) {
          setRows((m) => new Map(m).set(segmentId, result.row));
        } else {
          setError(result.message);
          if (result.code === "conflict")
            await reload().catch(() =>
              setError("Marks could not be reloaded. Reload this page."),
            );
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [store, reload, loaded, loadFailed, shownJobId],
  );

  return { marks: rows, loaded, busy, error, choose };
}
