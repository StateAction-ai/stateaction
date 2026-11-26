"use client";

import Link from "next/link";
import { useState } from "react";
import { ProcessingStatus } from "./processing-status";
import { Button } from "../ui/button";

const pageSize = 12;
const problems = new Set([
  "failed",
  "partially_failed",
  "partially_complete",
  "cancelled",
  "timed_out",
  "needs_attention",
  "needs_setup",
  "not_run",
]);

export function ClipTable({
  clips,
}: {
  clips: readonly {
    href: string;
    label: string;
    range: string;
    status: string;
  }[];
}) {
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [page, setPage] = useState(0);
  if (!clips.length)
    return <p className="text-sm text-muted">Clips appear after planning.</p>;
  const visible = problemsOnly
    ? clips.filter(({ status }) => problems.has(status))
    : clips;
  const lastPage = Math.max(0, Math.ceil(visible.length / pageSize) - 1);
  const current = Math.min(page, lastPage);
  const start = current * pageSize;
  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted">
          {visible.length
            ? `${start + 1}–${Math.min(start + pageSize, visible.length)} of ${visible.length} clips`
            : "No clips with problems."}
        </span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={problemsOnly}
            onChange={(event) => {
              setProblemsOnly(event.target.checked);
              setPage(0);
            }}
          />{" "}
          Problems only
        </label>
      </div>
      {visible.length > 0 && (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="py-2 pr-2">
                Clip
              </th>
              <th scope="col" className="pr-2">
                Source range
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible
              .slice(start, start + pageSize)
              .map(({ href, label, range, status }) => (
                <tr key={href} className="border-b border-line">
                  <th scope="row" className="py-2 pr-2">
                    <Link
                      className="inline-block whitespace-nowrap text-brand underline"
                      href={href}
                    >
                      {label}
                    </Link>
                  </th>
                  <td className="pr-2 tabular-nums">{range}</td>
                  <td>
                    <ProcessingStatus state={status} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      {lastPage > 0 && (
        <nav
          aria-label="Clip pages"
          className="flex items-center justify-between gap-2"
        >
          <Button
            variant="outline"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </Button>
          <span className="text-muted">
            Page {current + 1} of {lastPage + 1}
          </span>
          <Button
            variant="outline"
            disabled={current === lastPage}
            onClick={() => setPage(current + 1)}
          >
            Next
          </Button>
        </nav>
      )}
    </div>
  );
}
