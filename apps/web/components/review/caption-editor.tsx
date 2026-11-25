"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CaptionCorrection,
  CaptionCorrectionCommandV2,
  ClipReviewStateV2,
} from "@stateaction/server/datasets";
import type { Card } from "../../lib/review/types";
import { browserApi, BrowserApiError } from "../data-browser/client";

const BUTTON =
  "min-h-11 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold hover:bg-field disabled:opacity-50";
const MAX_LENGTH = 2000;

export function CaptionEditor({
  state,
  card,
  original,
  provenance,
  corrected,
  markRevision,
  segmentsSha256,
  onCorrect,
  onSaved,
  onDirty,
}: {
  state: ClipReviewStateV2;
  card: Card;
  original: string | null;
  provenance: string | null;
  corrected: boolean;
  markRevision: number;
  segmentsSha256: string | null;
  onCorrect: () => void;
  onSaved: (result: CaptionCorrection) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [history, setHistory] = useState<CaptionCorrection[]>();
  const [moreHistory, setMoreHistory] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const current = card.caption.state === "complete" ? card.caption.text : "";
  const dirty = editing && text.trim() !== current.trim();
  const path = `/api/v2/review-clips/${state.clipId}/segments/${card.segmentId}/caption`;
  const historyPath =
    path +
    "?" +
    new URLSearchParams({
      job: state.jobId,
      manifest: state.resultManifestSha256,
      selection: String(state.selectionRevision),
    });

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);

  const loadHistory = useCallback(
    async (before?: number) => {
      setLoading(true);
      setError("");
      try {
        const rows = await browserApi<CaptionCorrection[]>(
          historyPath + (before === undefined ? "" : "&before=" + before),
        );
        setHistory((previous) =>
          before === undefined ? rows : [...(previous ?? []), ...rows],
        );
        setMoreHistory(rows.length === 50);
        return rows;
      } catch {
        setError("Caption history could not be loaded. Try again.");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [historyPath],
  );

  useEffect(() => {
    if (corrected) void loadHistory();
  }, [corrected, loadHistory]);

  function cancel() {
    if (dirty && !window.confirm("Discard the unsaved caption changes?"))
      return;
    setEditing(false);
    setError("");
  }

  async function save(action: "edit" | "omit" | "undo") {
    if (saving || !segmentsSha256) return;
    const trimmed = text.trim();
    if (
      action === "edit" &&
      (!trimmed || trimmed.length > MAX_LENGTH || trimmed === current.trim())
    ) {
      setError(
        "Enter a changed caption between 1 and 2,000 characters, or choose Caption not needed.",
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      const prior = history ?? (await loadHistory());
      if (!prior) return;
      const command: CaptionCorrectionCommandV2 = {
        correctionId: crypto.randomUUID(),
        jobId: state.jobId,
        resultManifestSha256: state.resultManifestSha256,
        selectionRevision: state.selectionRevision,
        segmentsSha256,
        expectedRevision: prior[0]?.revision ?? 0,
        expectedMarkRevision: markRevision,
        ...(action === "edit" ? { action, text: trimmed } : { action }),
      };
      const { correction: response } = await browserApi<{
        correction: CaptionCorrection;
      }>(path, { method: "POST", body: command });
      setHistory([response, ...prior]);
      setEditing(false);
      setSaved(action !== "undo");
      onSaved(response);
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 409) {
        setHistory(undefined);
        setError("A new review arrived. Reload the clip and try again.");
      } else {
        setError("The caption could not be saved. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  const latest = history?.[0];
  return (
    <div className="col-span-full mt-3 space-y-2 border-t border-line pt-2">
      {corrected ? (
        <p className="text-xs text-muted">
          {latest
            ? `Edited by ${latest.reviewerName}, ${new Date(latest.createdAt).toLocaleString()}`
            : "Caption edited"}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={!segmentsSha256 || saving}
          onClick={onCorrect}
        >
          Correct
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={!segmentsSha256 || saving}
          onClick={() => {
            setEditing(true);
            setText(current);
            if (!history) void loadHistory();
          }}
        >
          Incorrect
        </button>
        <button
          type="button"
          className={BUTTON}
          aria-expanded={showHistory}
          onClick={() => {
            setShowHistory(!showHistory);
            if (!showHistory && !history) void loadHistory();
          }}
        >
          Show original / history
        </button>
      </div>
      {showHistory ? (
        <div className="space-y-2 rounded-lg bg-white p-3 text-sm">
          <p className="font-semibold">Original model caption</p>
          <p>{original ?? "No caption was produced."}</p>
          {provenance ? (
            <p className="text-xs text-muted">{provenance}</p>
          ) : null}
          {loading ? <p role="status">Loading history…</p> : null}
          {history?.map((row) => (
            <div key={row.revision} className="border-t border-line pt-2">
              <p className="text-xs text-muted">
                Edited by {row.reviewerName},{" "}
                {new Date(row.createdAt).toLocaleString()}
              </p>
              <p>
                {row.notNeeded
                  ? "Caption not needed"
                  : (row.text ?? "Original caption restored")}
              </p>
            </div>
          ))}
          {moreHistory ? (
            <button
              type="button"
              className={BUTTON}
              disabled={loading}
              onClick={() => void loadHistory(history?.at(-1)?.revision)}
            >
              Show earlier edits
            </button>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save("edit");
          }}
          className="space-y-2"
        >
          <label className="grid gap-1 text-sm font-semibold">
            Corrected caption
            <textarea
              autoFocus
              value={text}
              maxLength={MAX_LENGTH}
              rows={4}
              className="w-full resize-y rounded-lg border border-line bg-white p-2 text-sm font-normal"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void save("edit");
                }
              }}
            />
          </label>
          {dirty ? <p className="text-xs text-muted">Unsaved changes</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={BUTTON}
              disabled={saving || loading}
            >
              {saving ? "Saving…" : "Save correction"}
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={saving || loading}
              onClick={() => void save("omit")}
            >
              Caption not needed
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={saving}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {saved && !editing ? (
        <div className="flex items-center gap-2">
          <span role="status" className="text-xs text-good">
            Caption saved
          </span>
          <button
            type="button"
            className={BUTTON}
            disabled={saving}
            onClick={() => void save("undo")}
          >
            Undo
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
