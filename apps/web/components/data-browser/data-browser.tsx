"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  DatasetClipView,
  DatasetView,
  StaffClipView,
} from "@stateaction/contracts";
import type { ConsoleRole } from "../../lib/console-session";
import {
  browserApiPath,
  browserHref,
  type BrowserQuery,
} from "../../lib/data-browser-query";
import { registerPrivateState } from "../../lib/private-state";
import { Button } from "../ui/button";
import { ClipThumbnail } from "./thumbnail";
import { browserApi, BrowserApiError } from "./client";

type Page = {
  datasets?: DatasetView[];
  clips?: (DatasetClipView | StaffClipView)[];
  nextCursor: string | null;
};
type Loaded = { href: string; page: Page; dataset?: DatasetView };
const field =
  "min-h-11 w-full rounded-lg border border-line bg-white px-3 text-sm";
const hours = (ns: string) =>
  (Number(BigInt(ns)) / 3_600_000_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const duration = (ns: string) => {
  const seconds = Number(BigInt(ns) / 1_000_000_000n);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const decision = (value: string) =>
  ({ pending: "Not reviewed", approved: "Approved", rejected: "Rejected" })[
    value
  ] ?? "Not reviewed";

export function DataBrowser({
  query,
  role,
  mediaOrigin,
  recordingName,
}: {
  query: BrowserQuery;
  role: ConsoleRole;
  mediaOrigin: string | null;
  recordingName?: string;
}) {
  const router = useRouter();
  const [loaded, setLoaded] = React.useState<Loaded>();
  const [error, setError] = React.useState<string>();
  const [signedOut, setSignedOut] = React.useState(false);
  const [needsSignIn, setNeedsSignIn] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [dialog, setDialog] = React.useState<"new" | "add">();
  const href = browserHref(query);
  React.useEffect(
    () =>
      registerPrivateState(() => {
        setLoaded(undefined);
        setDialog(undefined);
        setSignedOut(true);
      }),
    [],
  );
  React.useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const page = await browserApi<Page>(browserApiPath(query), {
        signal: controller.signal,
      });
      const dataset = query.datasetId
        ? await browserApi<DatasetView>(`/api/v1/datasets/${query.datasetId}`, {
            signal: controller.signal,
          })
        : undefined;
      if (!controller.signal.aborted) {
        setLoaded({ href, page, ...(dataset ? { dataset } : {}) });
        setError(undefined);
      }
    })().catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setLoaded(undefined);
      setNeedsSignIn(
        failure instanceof BrowserApiError && failure.status === 401,
      );
      setError(
        failure instanceof BrowserApiError
          ? failure.message
          : "This view could not be loaded. Try again.",
      );
    });
    return () => controller.abort();
  }, [href, reload]);
  if (signedOut) return null;
  const current = loaded?.href === href ? loaded : undefined;
  const dataset = current?.dataset;
  const clips = current?.page.clips;
  return (
    <section aria-labelledby="browser-heading">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          {query.datasetId ? (
            <Link
              href="/data-browser"
              className="mb-2 inline-block text-sm text-brand underline"
            >
              Datasets
            </Link>
          ) : null}
          <h1
            id="browser-heading"
            className="m-0 text-[32px] font-bold tracking-[-0.03em]"
          >
            {query.datasetId
              ? (dataset?.name ?? "Dataset")
              : query.recordingId
                ? "Recording clips"
                : "Data browser"}
          </h1>
          {query.recordingId ? (
            <p className="mt-2 text-muted">
              <Link
                href={`/pipeline/${query.recordingId}`}
                className="font-medium text-brand underline"
              >
                {recordingName ?? "Recording"}
              </Link>
            </p>
          ) : dataset ? (
            <p className="mt-2 text-muted">
              {dataset.clipCount.toLocaleString()} approved clips{" "}
              <span className="mx-2" aria-hidden="true">
                /
              </span>{" "}
              {hours(dataset.durationNs)} total hours
            </p>
          ) : null}
        </div>
        {role === "staff" && !query.recordingId ? (
          <Button
            onClick={() => setDialog(query.datasetId ? "add" : "new")}
            disabled={Boolean(query.datasetId && !dataset)}
          >
            {query.datasetId ? "Add clips" : "New dataset"}
          </Button>
        ) : null}
      </div>
      {role === "staff" && !query.datasetId && !query.recordingId ? (
        <nav
          aria-label="Data views"
          className="mb-5 flex gap-5 border-b border-line"
        >
          {(
            [
              ["datasets", "Datasets"],
              ["clips", "All clips"],
            ] as const
          ).map(([mode, label]) => (
            <Link
              key={mode}
              href={browserHref({ mode })}
              aria-current={query.mode === mode ? "page" : undefined}
              className={`border-b-2 px-1 pb-3 text-sm font-semibold ${query.mode === mode ? "border-brand text-brand" : "border-transparent text-muted"}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      ) : null}
      <form
        key={href}
        role="search"
        className="mb-6 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const q = String(form.get("q") ?? "").trim();
          const label = String(form.get("label") ?? "").trim();
          const status = String(form.get("reviewStatus") ?? "");
          router.push(
            browserHref({
              mode: query.mode,
              ...(query.datasetId ? { datasetId: query.datasetId } : {}),
              ...(query.recordingId ? { recordingId: query.recordingId } : {}),
              ...(q ? { q } : {}),
              ...(label ? { label } : {}),
              ...(status
                ? {
                    reviewStatus: status as NonNullable<
                      BrowserQuery["reviewStatus"]
                    >,
                  }
                : {}),
            }),
          );
        }}
      >
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
          <label className="min-w-0 text-xs font-medium">
            Search {query.mode === "datasets" ? "datasets" : "clips"}
            <input
              className={`${field} mt-1`}
              name="q"
              type="search"
              defaultValue={query.q}
              maxLength={160}
              placeholder={
                query.mode === "datasets"
                  ? "Dataset name"
                  : "Title or task label"
              }
            />
          </label>
          {query.mode === "clips" ? (
            <label className="min-w-0 text-xs font-medium">
              Task label
              <input
                name="label"
                defaultValue={query.label}
                maxLength={160}
                className={`${field} mt-1`}
              />
            </label>
          ) : null}
          {role === "staff" && query.mode === "clips" && !query.datasetId ? (
            <label className="text-xs font-medium">
              Review status
              <select
                name="reviewStatus"
                defaultValue={query.reviewStatus ?? ""}
                className={`${field} mt-1`}
              >
                <option value="">All review statuses</option>
                <option value="pending">Not reviewed</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
          ) : null}
        </div>
        <Button variant="outline" type="submit" className="self-end">
          Search
        </Button>
      </form>
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-line bg-white p-6"
        >
          <p>{error}</p>
          {needsSignIn ? (
            <Link href="/login" className="mr-4 text-brand underline">
              Sign in
            </Link>
          ) : null}
          <Button
            variant="outline"
            onClick={() => {
              setError(undefined);
              setReload((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : !current ? (
        <p role="status" className="py-12 text-muted">
          Loading {query.mode === "datasets" ? "datasets" : "clips"}…
        </p>
      ) : query.mode === "datasets" ? (
        <DatasetTable datasets={current.page.datasets ?? []} />
      ) : !clips?.length ? (
        <div className="rounded-xl border border-line bg-white p-8">
          <p className="font-semibold">No clips match this view.</p>
          <p className="text-muted">
            {query.datasetId
              ? "This dataset contains only approved clips. Adjust your filters or add an approved clip."
              : "Adjust your filters, or open a completed recording from Pipeline."}
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">
            {clips.length}{" "}
            {query.q || query.label || query.reviewStatus ? "matching " : ""}
            clips on this page
          </p>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {clips.map((clip) => (
              <Link
                key={clip.clipId}
                href={`/clips/${clip.clipId}?returnTo=${encodeURIComponent(href)}`}
                className="overflow-hidden rounded-xl border border-line bg-white focus-visible:outline-offset-4"
              >
                <ClipThumbnail
                  clipId={clip.clipId}
                  {...(query.datasetId ? { datasetId: query.datasetId } : {})}
                  available={clip.media.thumbnail}
                  mediaOrigin={mediaOrigin}
                />
                <div className="p-4">
                  <h2 className="m-0 break-words text-base font-semibold">
                    {clip.title}
                  </h2>
                  <p className="mt-1 break-words text-sm text-muted">
                    {clip.taskLabel ?? "No task label"}
                  </p>
                  <p className="mt-3 text-xs text-muted">
                    {duration(clip.durationNs)}{" "}
                    <span className="mx-1" aria-hidden="true">
                      /
                    </span>{" "}
                    {clip.raster.width} × {clip.raster.height}{" "}
                    <span className="mx-1" aria-hidden="true">
                      /
                    </span>{" "}
                    {clip.frameCount.toLocaleString()} frames
                  </p>
                  {role === "staff" ? (
                    <p
                      className={`mt-3 text-xs font-medium ${query.datasetId || ("reviewStatus" in clip && clip.reviewStatus === "approved") ? "text-good" : "text-muted"}`}
                    >
                      {query.datasetId
                        ? "Approved"
                        : "reviewStatus" in clip
                          ? decision(clip.reviewStatus)
                          : "Not reviewed"}
                    </p>
                  ) : null}
                  {clip.simulation ? (
                    <p className="mt-2 text-xs text-muted">
                      Simulation recording
                    </p>
                  ) : null}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
      {current?.page.nextCursor ? (
        <div className="mt-6">
          <Link
            href={browserHref({ ...query, cursor: current.page.nextCursor })}
            className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 font-semibold"
          >
            Next page
          </Link>
        </div>
      ) : null}
      {dialog === "new" ? (
        <NewDataset
          onClose={() => setDialog(undefined)}
          onCreated={(datasetId) => {
            setDialog(undefined);
            router.push(browserHref({ mode: "clips", datasetId }));
          }}
        />
      ) : null}
      {dialog === "add" && dataset ? (
        <AddClips
          dataset={dataset}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            setLoaded(undefined);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}

function DatasetTable({ datasets }: { datasets: DatasetView[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <table className="w-full table-fixed border-collapse text-left">
        <thead className="bg-topbar text-xs text-muted">
          <tr>
            <th scope="col" className="w-1/2 px-4 py-3 font-medium sm:px-5">
              Dataset
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Clips
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Total hours
            </th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((dataset) => (
            <tr key={dataset.datasetId} className="border-t border-line">
              <td className="break-words px-4 py-4 sm:px-5">
                <Link
                  className="inline-flex min-h-11 items-center font-semibold text-brand hover:underline"
                  href={browserHref({
                    mode: "clips",
                    datasetId: dataset.datasetId,
                  })}
                >
                  {dataset.name}
                </Link>
              </td>
              <td className="px-3 py-4 tabular-nums">
                {dataset.clipCount.toLocaleString()}
              </td>
              <td className="px-3 py-4 tabular-nums">
                {hours(dataset.durationNs)}
              </td>
            </tr>
          ))}
          {!datasets.length ? (
            <tr>
              <td colSpan={3} className="px-5 py-10 text-muted">
                No datasets match this view.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      style={{ width: "min(36rem, calc(100% - 2rem))" }}
      aria-labelledby={titleId}
      onCancel={onClose}
      className="fixed inset-0 m-auto max-h-[85dvh]  overflow-auto rounded-xl border border-line bg-paper p-5 text-ink shadow-lg backdrop:bg-black/25"
    >
      <div className="mb-5 flex items-center justify-between gap-4">
        <h2 id={titleId} className="m-0 text-xl font-semibold">
          {title}
        </h2>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {children}
    </dialog>
  );
}

function NewDataset({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const id = React.useRef(crypto.randomUUID());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  return (
    <Modal title="New dataset" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          const name = String(
            new FormData(event.currentTarget).get("name") ?? "",
          ).trim();
          if (!name) {
            setError("Enter a dataset name.");
            return;
          }
          setBusy(true);
          setError(undefined);
          void browserApi<{ datasetId: string }>("/api/v1/datasets", {
            method: "POST",
            body: { datasetId: id.current, name },
          })
            .then((data) => onCreated(data.datasetId))
            .catch((e: unknown) => {
              setError(
                e instanceof Error
                  ? e.message
                  : "Could not create the dataset.",
              );
              setBusy(false);
            });
        }}
      >
        <label className="text-sm font-medium">
          Dataset name
          <input
            name="name"
            maxLength={120}
            required
            autoFocus
            className={`${field} mt-2`}
          />
        </label>
        <p className="mt-2 text-xs text-muted">
          Recipients can see this name when the dataset is shared.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Button className="mt-4" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create dataset"}
        </Button>
      </form>
    </Modal>
  );
}

function AddClips({
  dataset,
  onClose,
  onSaved,
}: {
  dataset: DatasetView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = React.useState("");
  const [cursor, setCursor] = React.useState<string>();
  const [page, setPage] = React.useState<Page>();
  const [reload, setReload] = React.useState(0);
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    setPage(undefined);
    setError(undefined);
    const query: BrowserQuery = {
      mode: "clips",
      reviewStatus: "approved",
      ...(search ? { q: search } : {}),
      ...(cursor ? { cursor } : {}),
    };
    void browserApi<Page>(browserApiPath(query), { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setPage(data);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load clips.");
      });
    return () => controller.abort();
  }, [search, cursor, reload]);
  return (
    <Modal title={`Add clips to ${dataset.name}`} onClose={onClose}>
      <p className="text-sm text-muted">
        Choose approved clips. Shared datasets also require clearance for their
        recipients.
      </p>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(
            String(new FormData(event.currentTarget).get("q") ?? "").trim(),
          );
          setCursor(undefined);
          setError(undefined);
        }}
      >
        <label className="min-w-0 flex-1 text-xs font-medium">
          Search approved clips
          <input
            name="q"
            type="search"
            maxLength={160}
            className={`${field} mt-1`}
          />
        </label>
        <Button type="submit" variant="outline" className="self-end">
          Search
        </Button>
      </form>
      {error ? (
        <div role="alert">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="outline" onClick={() => setReload((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : null}
      {!page && !error ? (
        <p role="status">Loading approved clips…</p>
      ) : !page?.clips?.length ? (
        <p className="text-muted">No approved clips match.</p>
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {page.clips.map((clip) => (
            <li key={clip.clipId}>
              <label className="flex min-h-14 items-center gap-3 py-3">
                <input
                  type="checkbox"
                  checked={selection.has(clip.clipId)}
                  onChange={(event) =>
                    setSelection((prior) => {
                      const next = new Set(prior);
                      if (event.target.checked && next.size < 100)
                        next.add(clip.clipId);
                      else next.delete(clip.clipId);
                      return next;
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block break-words text-sm font-semibold">
                    {clip.title}
                  </span>
                  <span className="block text-xs text-muted">
                    {clip.taskLabel ?? "No task label"} /{" "}
                    {duration(clip.durationNs)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {page?.nextCursor ? (
        <Button variant="ghost" onClick={() => setCursor(page.nextCursor!)}>
          More approved clips
        </Button>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {selection.size} selected (up to 100)
        </p>
        <Button
          disabled={busy || !selection.size || dataset.revision === undefined}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void browserApi(`/api/v1/datasets/${dataset.datasetId}/clips`, {
              method: "POST",
              body: {
                clipIds: [...selection],
                expectedRevision: dataset.revision,
              },
            })
              .then(onSaved)
              .catch((e: unknown) => {
                setError(
                  e instanceof Error ? e.message : "Could not add clips.",
                );
                setBusy(false);
              });
          }}
        >
          {busy ? "Adding…" : "Add selected clips"}
        </Button>
      </div>
    </Modal>
  );
}
