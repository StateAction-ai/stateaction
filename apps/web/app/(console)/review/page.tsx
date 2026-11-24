import { ReviewQueue } from "../../../components/review/review-queue";
import { loadReviewQueue } from "../../../lib/review/clip-reads";
import { parseReviewQueueQuery } from "../../../lib/review/queue";
import { requireConsoleSession } from "../../../lib/server-session";

export const metadata = { title: "Review · StateAction.ai" };
export const dynamic = "force-dynamic";

export default async function ReviewIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const query = parseReviewQueueQuery(await searchParams);
  try {
    const page = await loadReviewQueue(session.userId, query);
    return <ReviewQueue page={page} query={query} />;
  } catch {
    return (
      <>
        <h1 className="mb-4 text-2xl font-bold">Review queue</h1>
        <p role="alert" className="text-sm text-danger">
          The review queue is temporarily unavailable.
        </p>
      </>
    );
  }
}
