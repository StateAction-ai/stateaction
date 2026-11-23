import Link from "next/link";
import { redirect } from "next/navigation";
import { requireConsoleSession } from "../../../lib/server-session";
import { reviewLoader } from "../../../lib/review/loader";
import { ReviewDataUnavailable } from "../../../lib/review/types";

export const metadata = { title: "Review · StateAction.ai" };
export const dynamic = "force-dynamic";

/** The recording selector lives on the review page itself; this opens the first recording. */
export default async function ReviewIndexPage() {
  const session = await requireConsoleSession(["staff"]);
  let first: string | undefined;
  try {
    first = (await reviewLoader().listRecordings(session.userId))[0]
      ?.recordingId;
  } catch (error) {
    if (!(error instanceof ReviewDataUnavailable)) throw error;
    return (
      <p role="alert" className="text-sm text-danger">
        Review data is not available yet. {error.message}
      </p>
    );
  }
  if (first) redirect(`/review/${first}`);
  return (
    <>
      <h1 className="m-0 text-[32px] leading-tight font-bold">Review</h1>
      <p className="mt-2 text-muted">
        No recording has accepted annotations yet. Recordings appear here after
        processing; see the{" "}
        <Link href="/pipeline" className="text-brand">
          Pipeline
        </Link>
        .
      </p>
    </>
  );
}
