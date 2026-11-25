"use client";

import { useId, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import type {
  ClipReviewCommandV2,
  ClipReviewReceipt,
  ClipReviewStateV2,
} from "@stateaction/server/datasets";
import { browserApi, BrowserApiError } from "../data-browser/client";

const BUTTON =
  "min-h-11 rounded-lg border border-line bg-white px-3 text-sm font-semibold hover:bg-field disabled:opacity-50";
const FIELD =
  "min-h-11 min-w-0 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";
type Dataset = ClipReviewStateV2["availableDatasets"][number];
type PickerResults = {
  matches: Dataset[];
  saved: Dataset[];
  exactMatch: boolean;
};
type Preferences = {
  recent: string[];
  pinned: string[];
  last: { ids: string[]; names: string[]; label: string } | null;
};
type Notice = {
  clipId: string;
  message: string;
  undo: ClipReviewCommandV2;
  backHref: string;
};
const INITIAL: Preferences = { recent: [], pinned: [], last: null };

function readStorage<T>(storage: Storage, key: string, empty: T): T {
  try {
    return (JSON.parse(storage.getItem(key) ?? "null") as T) ?? empty;
  } catch {
    return empty;
  }
}

function writeStorage(storage: Storage, key: string, value: unknown) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Review state remains on the server if browser storage is unavailable.
  }
}

type Action = ClipReviewCommandV2 extends infer Command
  ? Command extends ClipReviewCommandV2
    ? Omit<
        Command,
        | "jobId"
        | "resultManifestSha256"
        | "selectionRevision"
        | "commandId"
        | "expectedReviewRevision"
      >
    : never
  : never;

const decisionPath = (clipId: string) =>
  `/api/v2/review-clips/${clipId}/decision`;

export function ReviewActions({
  state,
  userId,
  labels,
  suggested,
  pending,
  advanceHref,
  currentHref,
  focusPicker,
  onUpdated,
}: {
  state: ClipReviewStateV2;
  userId: string;
  labels: string[];
  suggested: string;
  pending: boolean;
  advanceHref: string | null;
  currentHref: string;
  focusPicker: boolean;
  onUpdated: (receipt: ClipReviewReceipt) => void;
}) {
  const router = useRouter();
  const picker = useId();
  const taskList = useId();
  const pickerRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const [preferences, setPreferences] = useState(INITIAL);
  const [addedDatasets, setAddedDatasets] = useState<Dataset[]>([]);
  const [savedDatasets, setSavedDatasets] = useState<Dataset[]>([]);
  const [search, setSearch] = useState<{
    term: string;
    results: PickerResults | null;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [term, setTerm] = useState("");
  const [label, setLabel] = useState(state.review.taskLabel ?? suggested);
  const [note, setNote] = useState("");
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const prefKey = "sa:dataset-review-prefs:" + userId;
  const noticeKey = "sa:dataset-review-undo:" + userId;
  const locked = busy || !state.capabilities.canReview;
  const rejected = state.review.decision === "rejected";
  const pickerPath = `/api/v2/review-clips/${state.clipId}/dataset-picker`;
  const searchTerm = term.trim();
  const resolved = search?.term === searchTerm ? search.results : undefined;
  const loadingMatches = Boolean(searchTerm && resolved === undefined);
  const searchFailed = Boolean(searchTerm && resolved === null);
  const byId = new Map(
    [
      ...addedDatasets,
      ...savedDatasets,
      ...state.availableDatasets,
      ...(resolved?.matches ?? []),
    ].map((dataset) => [dataset.datasetId, dataset]),
  );
  const eligible = (d: Dataset) => !d.member && !selected.includes(d.datasetId);
  const matching = (
    searchTerm ? (resolved?.matches ?? []) : [...byId.values()]
  ).filter(eligible);
  const create = Boolean(
    searchTerm &&
      resolved &&
      !resolved.exactMatch &&
      ![...byId.values()].some(
        (dataset) => dataset.name.toLowerCase() === searchTerm.toLowerCase(),
      ),
  );
  const savedParams = new URLSearchParams(
    [
      ...new Set([
        ...(preferences.last?.ids ?? []),
        ...preferences.recent,
        ...preferences.pinned.slice().reverse(),
      ]),
    ]
      .slice(0, 100)
      .map((id) => ["id", id]),
  ).toString();
  const pinned = preferences.pinned.flatMap((id) => {
    const item = byId.get(id);
    return item && eligible(item) ? [item] : [];
  });
  const recent = preferences.recent.flatMap((id) => {
    const item = byId.get(id);
    return item && eligible(item) && !preferences.pinned.includes(id)
      ? [item]
      : [];
  });
  const suggestions = searchTerm
    ? [{ title: "Matching datasets", items: matching.slice(0, 50) }]
    : [
        { title: "Recent", items: recent },
        { title: "Pinned", items: pinned },
        {
          title: "Datasets",
          items: matching
            .filter((item) => !pinned.includes(item) && !recent.includes(item))
            .slice(0, 50),
        },
      ];
  const options = suggestions.flatMap((group) => group.items);
  const repeated =
    preferences.last &&
    preferences.last.ids.every((id) => {
      const item = byId.get(id);
      return Boolean(item && !item.member);
    })
      ? preferences.last
      : null;

  useEffect(() => {
    const stored = readStorage(localStorage, prefKey, INITIAL);
    setPreferences(stored);
    if (pending && stored.last?.label) setLabel(stored.last.label);
    setNotice(readStorage<Notice | null>(sessionStorage, noticeKey, null));
    setReady(true);
  }, [noticeKey, pending, prefKey]);

  useEffect(() => {
    if (!ready || !savedParams) return;
    const controller = new AbortController();
    void browserApi<PickerResults>(pickerPath + "?" + savedParams, {
      signal: controller.signal,
    })
      .then(({ saved }) => {
        if (!controller.signal.aborted) setSavedDatasets(saved);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [pickerPath, ready, savedParams]);

  useEffect(() => {
    if (!open || !searchTerm) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const params = new URLSearchParams({ q: searchTerm });
      void browserApi<PickerResults>(pickerPath + "?" + params, {
        signal: controller.signal,
      })
        .then((results) => {
          if (!controller.signal.aborted) {
            setSearch({ term: searchTerm, results });
            setActive(0);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setSearch({ term: searchTerm, results: null });
        });
    }, 150);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [open, pickerPath, searchTerm]);

  useEffect(() => {
    if (ready && pending && focusPicker) pickerRef.current?.focus();
  }, [ready, pending, focusPicker]);

  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(picker + "-option-" + active)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, picker]);

  function remember(next: Preferences) {
    setPreferences(next);
    writeStorage(localStorage, prefKey, next);
  }

  function retainDataset(id: string) {
    const dataset = byId.get(id);
    if (dataset)
      setAddedDatasets((previous) => [
        ...previous.filter((item) => item.datasetId !== id),
        dataset,
      ]);
  }

  function star(id: string) {
    retainDataset(id);
    remember({
      ...preferences,
      pinned: preferences.pinned.includes(id)
        ? preferences.pinned.filter((value) => value !== id)
        : [...preferences.pinned, id],
    });
  }

  function pick(id: string) {
    retainDataset(id);
    setSelected((previous) => [...previous, id]);
    setTerm("");
    setSearch(null);
    setActive(-1);
    setOpen(false);
    pickerRef.current?.focus();
  }

  async function createDataset() {
    if (locked || !create) return;
    const name = term.trim();
    setBusy(true);
    setError("");
    try {
      const dataset = await browserApi<{ datasetId: string; revision: number }>(
        "/api/v1/datasets",
        { method: "POST", body: { datasetId: crypto.randomUUID(), name } },
      );
      setAddedDatasets((previous) => [
        ...previous,
        { ...dataset, name, member: false, shared: false },
      ]);
      pick(dataset.datasetId);
    } catch {
      setError(
        "The dataset could not be created. Check the name and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  function pickerKeys(event: KeyboardEvent<HTMLInputElement>) {
    const total = options.length + Number(create);
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      if (!event.shiftKey) {
        event.preventDefault();
        labelRef.current?.focus();
      }
      return;
    }
    if (event.altKey && event.key.toLowerCase() === "p" && options[active]) {
      event.preventDefault();
      star(options[active].datasetId);
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && total) {
      event.preventDefault();
      setOpen(true);
      setActive((index) =>
        Math.max(
          0,
          Math.min(total - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
        ),
      );
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!open) {
        labelRef.current?.focus();
        return;
      }
      if (loadingMatches || searchFailed) return;
      const chosen =
        options[active] ??
        (term.trim() && options.length === 1 ? options[0] : undefined);
      if (chosen) pick(chosen.datasetId);
      else if (create && active === options.length) void createDataset();
      else labelRef.current?.focus();
    }
  }

  async function commit(action: Action, message: string, advance = false) {
    if (locked) return false;
    setBusy(true);
    setError("");
    const command: ClipReviewCommandV2 = {
      ...action,
      commandId: crypto.randomUUID(),
      expectedReviewRevision: state.review.revision,
      jobId: state.jobId,
      resultManifestSha256: state.resultManifestSha256,
      selectionRevision: state.selectionRevision,
    };
    try {
      const receipt = await browserApi<ClipReviewReceipt>(
        decisionPath(state.clipId),
        { method: "POST", body: command },
      );
      const undoable = action.action === "add" || action.action === "reject";
      const nextNotice: Notice | null = undoable
        ? {
            clipId: state.clipId,
            message,
            undo: {
              commandId: crypto.randomUUID(),
              expectedReviewRevision: receipt.reviewRevision,
              jobId: state.jobId,
              resultManifestSha256: state.resultManifestSha256,
              selectionRevision: state.selectionRevision,
              action: "undo",
              targetCommandId: command.commandId,
            },
            backHref: currentHref,
          }
        : null;
      setNotice(nextNotice);
      writeStorage(sessionStorage, noticeKey, nextNotice);
      onUpdated(receipt);
      setSelected([]);
      setReject(false);
      setReason("");
      if (advance && advanceHref) router.push(advanceHref);
      else router.refresh();
      return true;
    } catch (cause) {
      if (cause instanceof BrowserApiError && cause.status === 409) {
        setError(
          "This clip or dataset changed while you were reviewing. Reloaded current data. Try again.",
        );
        router.refresh();
      } else setError("The review could not be saved. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(ids: string[], task: string) {
    const choices = ids.flatMap((id) => byId.get(id) ?? []);
    const names = choices.map((dataset) => dataset.name);
    const actualLabel = task.trim();
    if (!choices.length || !actualLabel) return;
    const success = await commit(
      {
        action: "add",
        taskLabel: actualLabel,
        ...(note.trim() ? { notes: note.trim() } : {}),
        datasetRevisions: Object.fromEntries(
          choices.map((dataset) => [dataset.datasetId, dataset.revision]),
        ),
      },
      `Added to ${names.join(", ")}.${pending ? " It is no longer in Pending Review." : ""}`,
      pending,
    );
    if (success)
      remember({
        ...preferences,
        last: { ids, names, label: actualLabel },
        recent: [...new Set([...ids, ...preferences.recent])].slice(0, 3),
      });
  }

  async function undo() {
    if (!notice || busy) return;
    setBusy(true);
    try {
      const response = await browserApi<ClipReviewReceipt>(
        decisionPath(notice.clipId),
        { method: "POST", body: notice.undo },
      );
      if (notice.clipId === state.clipId) {
        onUpdated(response);
        router.refresh();
      } else router.push(notice.backHref);
      setNotice(null);
      writeStorage(sessionStorage, noticeKey, null);
    } catch {
      setError(
        "Could not undo this review. Someone may have updated the clip.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="space-y-4 p-4"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.altKey && repeated && !locked) {
          event.preventDefault();
          void add(repeated.ids, repeated.label);
        }
      }}
    >
      {notice ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-soft p-3 text-sm">
          <span role="status">{notice.message}</span>
          <button
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => void undo()}
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
      {!state.capabilities.canReview ? (
        <p className="text-sm text-muted">
          Review is unavailable for this result.
        </p>
      ) : null}
      {rejected ? (
        <>
          <h2 className="font-semibold">Rejected</h2>
          <p className="text-sm">{state.review.notes}</p>
          <button
            type="button"
            className={BUTTON}
            disabled={locked}
            onClick={() =>
              void commit({ action: "restore" }, "Restored to Pending Review.")
            }
          >
            Restore
          </button>
        </>
      ) : (
        <>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void add(selected, label);
            }}
          >
            <h2 className="font-semibold">Add to dataset</h2>
            {repeated ? (
              <button
                type="button"
                aria-keyshortcuts="Alt+Enter"
                className={BUTTON}
                disabled={locked}
                onClick={() => void add(repeated.ids, repeated.label)}
              >
                Same as last clip · {repeated.names.join(", ")} ·{" "}
                {repeated.label}
              </button>
            ) : null}
            <div
              className="relative"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setOpen(false);
              }}
            >
              <label htmlFor={picker} className="text-xs font-semibold">
                Datasets
              </label>
              <input
                ref={pickerRef}
                id={picker}
                type="search"
                role="combobox"
                autoComplete="off"
                aria-autocomplete="list"
                aria-controls={picker + "-list"}
                aria-expanded={open}
                aria-activedescendant={
                  open &&
                  active >= 0 &&
                  active < options.length + Number(create)
                    ? picker + "-option-" + active
                    : undefined
                }
                className={FIELD}
                value={term}
                maxLength={120}
                disabled={locked || !ready}
                placeholder="Search datasets"
                onFocus={() => setOpen(true)}
                onClick={() => setOpen(true)}
                onChange={(event) => {
                  const nextTerm = event.target.value;
                  if (nextTerm.trim() !== searchTerm) setSearch(null);
                  setTerm(nextTerm);
                  setActive(0);
                  setOpen(true);
                }}
                onKeyDown={pickerKeys}
              />
              {open ? (
                <div
                  id={picker + "-list"}
                  role="listbox"
                  aria-label="Available datasets"
                  className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-white p-2 shadow-lg"
                >
                  {suggestions
                    .filter((group) => group.items.length)
                    .map((group) => (
                      <div
                        key={group.title}
                        role="group"
                        aria-label={group.title}
                      >
                        <div className="px-2 pt-2 text-xs font-semibold text-muted">
                          {group.title}
                        </div>
                        {group.items.map((dataset) => {
                          const index = options.indexOf(dataset);
                          return (
                            <div
                              key={dataset.datasetId}
                              id={picker + "-option-" + index}
                              role="option"
                              aria-selected={index === active}
                              className="flex items-center rounded aria-selected:bg-brand-soft"
                            >
                              <button
                                type="button"
                                tabIndex={-1}
                                onMouseDown={(event) => event.preventDefault()}
                                className="min-h-11 flex-1 truncate px-2 text-left text-sm"
                                title={dataset.name}
                                onClick={() => pick(dataset.datasetId)}
                              >
                                {dataset.name}
                              </button>
                              <button
                                type="button"
                                tabIndex={-1}
                                onMouseDown={(event) => event.preventDefault()}
                                className="h-11 w-11"
                                title={`Pin ${dataset.name}`}
                                aria-label={`Pin ${dataset.name}`}
                                aria-pressed={preferences.pinned.includes(
                                  dataset.datasetId,
                                )}
                                onClick={() => star(dataset.datasetId)}
                              >
                                {preferences.pinned.includes(dataset.datasetId)
                                  ? "★"
                                  : "☆"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  {create ? (
                    <button
                      type="button"
                      role="option"
                      id={picker + "-option-" + options.length}
                      aria-selected={active === options.length}
                      className="min-h-11 w-full truncate px-2 text-left text-sm font-semibold text-brand-ink aria-selected:bg-brand-soft"
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void createDataset()}
                    >
                      Create new dataset “{term.trim()}”
                    </button>
                  ) : null}
                  {!options.length && !create ? (
                    <p role="status" className="px-2 py-3 text-sm text-muted">
                      {loadingMatches
                        ? "Searching…"
                        : searchFailed
                          ? "Dataset search is unavailable. Try again."
                          : searchTerm
                            ? "No available datasets match."
                            : "Type a name to search for a dataset."}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            {selected.length ? (
              <div
                className="flex flex-wrap gap-1.5"
                aria-label="Selected datasets"
              >
                {selected.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={BUTTON}
                    title={`Remove ${byId.get(id)?.name ?? "dataset"} from selection`}
                    onClick={() =>
                      setSelected(selected.filter((value) => value !== id))
                    }
                  >
                    {byId.get(id)?.name} ×
                  </button>
                ))}
              </div>
            ) : null}
            <label className="grid gap-1 text-xs font-semibold">
              Task label
              <input
                ref={labelRef}
                className={FIELD}
                list={taskList}
                value={label}
                required
                maxLength={120}
                disabled={locked}
                onChange={(event) => setLabel(event.target.value)}
              />
              <datalist id={taskList}>
                {labels.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </label>
            <label className="grid gap-1 text-xs font-semibold">
              Note (optional)
              <textarea
                className={FIELD}
                value={note}
                rows={2}
                maxLength={2000}
                disabled={locked}
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    void add(selected, label);
                  }
                }}
              />
            </label>
            <button
              type="submit"
              className={BUTTON + " bg-brand text-white hover:bg-brand-strong"}
              disabled={locked || !label.trim() || !selected.length}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </form>
          <div className="border-t border-line pt-3">
            {reject ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (reason.trim())
                    void commit(
                      { action: "reject", reason: reason.trim() },
                      "Rejected and moved to Recycle Bin.",
                      pending,
                    );
                }}
              >
                <label className="grid gap-1 text-xs font-semibold">
                  Reason for rejection
                  <textarea
                    autoFocus
                    className={FIELD}
                    required
                    value={reason}
                    rows={3}
                    maxLength={2000}
                    disabled={locked}
                    onChange={(event) => setReason(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                      if (event.key === "Escape") setReject(false);
                    }}
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className={BUTTON + " text-danger"}
                    disabled={locked || !reason.trim()}
                  >
                    Reject clip
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy}
                    onClick={() => setReject(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className={BUTTON + " text-danger"}
                disabled={locked}
                onClick={() => setReject(true)}
              >
                Reject
              </button>
            )}
          </div>
        </>
      )}
      {state.memberships.length ? (
        <div className="space-y-2 border-t border-line pt-3">
          <h2 className="text-sm font-semibold">Already in</h2>
          {state.memberships.map((dataset) => (
            <div
              key={dataset.datasetId}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-field p-2 text-sm"
            >
              <span className="break-words" title={dataset.name}>
                {dataset.name}
              </span>
              <button
                type="button"
                className={BUTTON}
                disabled={locked}
                onClick={() =>
                  void commit(
                    {
                      action: "remove",
                      datasetId: dataset.datasetId,
                      expectedDatasetRevision: dataset.revision,
                    },
                    `Removed from ${dataset.name}.`,
                  )
                }
              >
                Remove from this dataset
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
