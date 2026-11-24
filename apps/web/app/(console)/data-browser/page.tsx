import Link from "next/link";
import { serverConfig } from "@stateaction/server";
import { authRuntime } from "@stateaction/server/auth";
import {
  recordingTitle,
  shortRecordingId,
} from "@stateaction/server/pipeline-model";
import { notFound } from "next/navigation";
import { requireConsoleSession } from "../../../lib/server-session";
import {
  browserHref,
  parseBrowserQuery,
} from "../../../lib/data-browser-query";
import { DataBrowser } from "../../../components/data-browser/data-browser";

export const metadata = { title: "Data browser · StateAction.ai" };
export const dynamic = "force-dynamic";

export default async function DataBrowserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of typeof value === "string" ? [value] : (value ?? []))
      params.append(key, item);
  }
  let query;
  try {
    query = parseBrowserQuery(params, session.role);
  } catch {
    return (
      <section>
        <h1 className="text-[32px] font-bold tracking-[-0.03em]">
          Data browser
        </h1>
        <p role="alert">
          This view is unavailable. Check the link or open your datasets.
        </p>
        <Link href="/data-browser" className="text-brand underline">
          Open datasets
        </Link>
      </section>
    );
  }
  let recordingName: string | undefined;
  if (query.recordingId) {
    const runtime = authRuntime();
    await runtime.ready();
    const { rows } = await runtime.pool.query<{ started_at: Date }>(
      "SELECT started_at FROM recordings WHERE id=$1 AND deleted_at IS NULL AND catalog_has_role($2, 'staff')",
      [query.recordingId, session.userId],
    );
    if (!rows[0]) notFound();
    recordingName =
      recordingTitle(rows[0].started_at) +
      " · " +
      shortRecordingId(query.recordingId);
  }
  let mediaOrigin: string | null = null;
  try {
    mediaOrigin = new URL(serverConfig().publicEndpoint).origin;
  } catch {
    /* preview remains unavailable */
  }
  return (
    <DataBrowser
      key={browserHref(query)}
      query={query}
      role={session.role}
      mediaOrigin={mediaOrigin}
      {...(recordingName ? { recordingName } : {})}
    />
  );
}
