"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { DatasetView } from "@stateaction/contracts";
import {
  browserDurationBounds,
  browserHref,
  durationPresets,
  type BrowserQuery,
} from "../../lib/data-browser-query";
import { registerPrivateState } from "../../lib/private-state";
import { Button } from "../ui/button";
import { browserApi } from "./client";

const field =
  "min-h-10 w-full rounded-lg border border-line bg-white px-2.5 text-sm";
export type Facet = { value: string; label: string; count: number };

export function PrivateBrowser({ children }: { children: React.ReactNode }) {
  const [signedOut, setSignedOut] = React.useState(false);
  React.useEffect(() => registerPrivateState(() => setSignedOut(true)), []);
  return signedOut ? null : children;
}

export function BrowserLoadError() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <section className="space-y-4">
      <h1 className="text-[32px] font-bold tracking-[-0.03em]">Data browser</h1>
      <div role="alert" className="rounded-lg border border-line bg-white p-4">
        <p className="mb-3">The catalog could not load.</p>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => startTransition(() => router.refresh())}
        >
          {pending ? "Loading…" : "Try again"}
        </Button>
      </div>
    </section>
  );
}

export function SearchForm({
  query,
  children,
}: {
  query: BrowserQuery;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const clips = query.mode === "clips";
  return (
    <form
      role="search"
      className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-white p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const q = String(
          new FormData(event.currentTarget).get("q") ?? "",
        ).trim();
        const next = { ...query, page: undefined, ...(q ? { q } : {}) };
        if (!q) {
          delete next.q;
          if (next.sort === "match") delete next.sort;
        }
        startTransition(() => router.push(browserHref(next)));
      }}
    >
      <label className="grid min-w-36 flex-1 gap-1 text-sm font-medium">
        {clips ? "Search clips" : "Search datasets"}
        <input
          type="search"
          name="q"
          maxLength={160}
          defaultValue={query.q}
          placeholder={clips ? 'Try "shelf bracket" -drawer' : "Dataset name"}
          className={field}
        />
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        Search
      </Button>
      {children}
      {pending ? (
        <p role="status" className="basis-full text-sm text-muted">
          Loading…
        </p>
      ) : null}
    </form>
  );
}

export function CatalogSelect({
  label,
  value,
  options,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; href: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted">
      {label}
      <select
        className="min-h-9 max-w-44 rounded-md border border-line bg-white px-2 text-sm text-ink"
        value={value}
        disabled={pending}
        onChange={(event) => {
          const option = options.find(
            (item) => item.value === event.target.value,
          );
          if (option) startTransition(() => router.push(option.href));
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FacetGroup({
  label,
  options,
  selected,
  onChange,
  searchable,
}: {
  label: string;
  options: Facet[];
  selected: string[];
  onChange: (value: string, checked: boolean) => void;
  searchable?: boolean;
}) {
  const [search, setSearch] = React.useState("");
  const visible = [
    ...options,
    ...selected
      .filter((value) => !options.some((option) => option.value === value))
      .map((value) => ({ value, label: value, count: 0 })),
  ].filter((option) =>
    option.label.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <details
      className="border-t border-line py-2"
      open={selected.length > 0 || undefined}
    >
      <summary className="cursor-pointer py-1 text-sm font-semibold">
        {label}
      </summary>
      {searchable ? (
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={`Find ${label.toLowerCase()}`}
          placeholder={`Find ${label.toLowerCase()}`}
          className={`${field} my-1`}
        />
      ) : null}
      <div className="max-h-56 overflow-auto">
        {visible.map((option) => (
          <label
            key={option.value}
            className="grid min-h-8 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs"
          >
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(event) => onChange(option.value, event.target.checked)}
              className="accent-brand"
            />
            <span className="break-words">{option.label}</span>
            <span className="text-muted">
              {option.count.toLocaleString("en-US")}
            </span>
          </label>
        ))}
        {!visible.length ? (
          <p className="py-1 text-xs text-muted">No matches.</p>
        ) : null}
      </div>
    </details>
  );
}

export function CatalogFilters({
  query,
  labels,
  staff,
}: {
  query: BrowserQuery;
  labels?: Facet[];
  staff?: { recordings?: Facet[]; problems: Facet[] };
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [durationError, setDurationError] = React.useState("");
  const id = React.useId();
  const update = (changes: Partial<BrowserQuery>) => {
    startTransition(() =>
      router.push(browserHref({ ...query, ...changes, page: undefined })),
    );
  };
  const tasks = query.task ?? (query.label ? [query.label] : []);
  const recording = query.recording ?? [];
  const problem = query.problem ?? [];
  const toggle = <T extends string>(values: T[], value: T, checked: boolean) =>
    checked ? [...values, value] : values.filter((entry) => entry !== value);
  return (
    <aside
      aria-label="Clip filters"
      className="rounded-lg border border-line bg-white p-3"
    >
      <h2 className="mb-2 hidden text-sm font-semibold lg:block">Filters</h2>
      <button
        type="button"
        className="min-h-7 w-full text-left text-sm font-semibold lg:hidden"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        Filters
      </button>
      <fieldset
        id={id}
        disabled={pending}
        aria-busy={pending}
        className={open ? "" : "hidden lg:block"}
      >
        {labels ? (
          <FacetGroup
            label="Task label"
            options={labels}
            selected={tasks}
            searchable
            onChange={(value, checked) => {
              const next = { ...query };
              delete next.label;
              startTransition(() =>
                router.push(
                  browserHref({
                    ...next,
                    page: undefined,
                    task: toggle(tasks, value, checked),
                  }),
                ),
              );
            }}
          />
        ) : null}
        {staff ? (
          <>
            {staff.recordings ? (
              <FacetGroup
                label="Recording"
                options={staff.recordings}
                selected={recording}
                searchable
                onChange={(value, checked) =>
                  update({ recording: toggle(recording, value, checked) })
                }
              />
            ) : null}
            <details
              className="border-t border-line py-2"
              open={
                Boolean(
                  query.duration || query.minDuration || query.maxDuration,
                ) || undefined
              }
            >
              <summary className="cursor-pointer py-1 text-sm font-semibold">
                Duration
              </summary>
              {Object.entries(durationPresets).map(([key, preset]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={query.duration === key}
                  className="block min-h-8 w-full rounded px-1 text-left text-xs hover:bg-field aria-pressed:bg-brand-soft"
                  onClick={() =>
                    update({
                      duration:
                        query.duration === key
                          ? undefined
                          : (key as NonNullable<BrowserQuery["duration"]>),
                      minDuration: undefined,
                      maxDuration: undefined,
                    })
                  }
                >
                  {preset.label}
                </button>
              ))}
              <form
                className="mt-2 grid grid-cols-2 gap-1.5 text-xs"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const minDuration =
                    String(form.get("minDuration") || "") || undefined;
                  const maxDuration =
                    String(form.get("maxDuration") || "") || undefined;
                  const range = {
                    duration: undefined,
                    minDuration,
                    maxDuration,
                  };
                  try {
                    const { min, max } = browserDurationBounds({
                      ...query,
                      ...range,
                    });
                    if (min && max && BigInt(min) > BigInt(max))
                      throw new Error();
                  } catch {
                    setDurationError("Enter a valid minimum and maximum.");
                    return;
                  }
                  setDurationError("");
                  update(range);
                }}
              >
                <label className="min-w-0">
                  Min (s)
                  <input
                    name="minDuration"
                    type="number"
                    min="0"
                    step="0.001"
                    defaultValue={query.minDuration}
                    className={`${field} mt-1`}
                  />
                </label>
                <label className="min-w-0">
                  Max (s)
                  <input
                    name="maxDuration"
                    type="number"
                    min="0"
                    step="0.001"
                    defaultValue={query.maxDuration}
                    className={`${field} mt-1`}
                  />
                </label>
                {durationError ? (
                  <p className="col-span-2 text-danger" role="alert">
                    {durationError}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  variant="outline"
                  className="col-span-2 px-1"
                >
                  Apply range
                </Button>
              </form>
            </details>
            <FacetGroup
              label="Problems"
              options={staff.problems}
              selected={problem}
              onChange={(value, checked) =>
                update({
                  problem: toggle(
                    problem,
                    value as (typeof problem)[number],
                    checked,
                  ),
                })
              }
            />
          </>
        ) : null}
      </fieldset>
      {pending ? (
        <p role="status" className="text-xs text-muted">
          Loading clips…
        </p>
      ) : null}
    </aside>
  );
}

export function DatasetEditor({
  dataset,
}: {
  dataset?: { datasetId: string; name: string };
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [name, setName] = React.useState(dataset?.name ?? "");
  const [revision, setRevision] = React.useState<number>();
  const id = React.useRef<string>(null);
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const title = dataset ? "Edit dataset" : "New dataset";
  const datasetPath = dataset
    ? `/api/v1/datasets/${dataset.datasetId}`
    : "/api/v1/datasets";
  React.useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    const controller = new AbortController();
    if (dataset) {
      void browserApi<DatasetView>(datasetPath, { signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return;
          setName(data.name);
          setRevision(data.revision);
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted)
            setError(
              failure instanceof Error
                ? failure.message
                : "Could not load the dataset.",
            );
        });
    }
    return () => {
      controller.abort();
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open, dataset, datasetPath]);
  return (
    <>
      <Button
        variant={dataset ? "outline" : "default"}
        onClick={() => {
          setError("");
          setBusy(false);
          setName(dataset?.name ?? "");
          setRevision(undefined);
          id.current = null;
          setOpen(true);
        }}
      >
        {title}
      </Button>
      {open ? (
        <dialog
          ref={ref}
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) setOpen(false);
          }}
          className="fixed inset-0 m-auto w-[min(32rem,calc(100%-2rem))] rounded-xl border border-line bg-paper p-5 text-ink shadow-lg backdrop:bg-black/25"
        >
          <h2 id={titleId} className="mb-4 text-xl font-semibold">
            {title}
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || (dataset && revision === undefined)) return;
              if (!name.trim()) {
                setError("Enter a dataset name.");
                return;
              }
              if (!dataset) id.current ??= crypto.randomUUID();
              setBusy(true);
              setError("");
              void browserApi<{ datasetId: string }>(datasetPath, {
                method: dataset ? "PATCH" : "POST",
                body: dataset
                  ? { name: name.trim(), expectedRevision: revision }
                  : { datasetId: id.current, name: name.trim() },
              })
                .then((data) => {
                  setOpen(false);
                  if (dataset) router.refresh();
                  else
                    router.push(
                      browserHref({ mode: "clips", datasetId: data.datasetId }),
                    );
                })
                .catch((failure: unknown) => {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Could not save the dataset.",
                  );
                  setBusy(false);
                });
            }}
          >
            <label className="grid gap-2 text-sm font-medium">
              Dataset name
              <input
                className={field}
                name="name"
                required
                maxLength={120}
                autoFocus
                value={name}
                disabled={busy || Boolean(dataset && revision === undefined)}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {dataset && revision === undefined && !error ? (
              <p role="status" className="mt-2 text-sm text-muted">
                Loading dataset…
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || Boolean(dataset && revision === undefined)}
              >
                {busy ? "Saving…" : dataset ? "Save changes" : "Create dataset"}
              </Button>
            </div>
          </form>
        </dialog>
      ) : null}
    </>
  );
}
