import Link from "next/link";
import { notFound } from "next/navigation";
import { serverConfig } from "@stateaction/server";
import { requireConsoleSession } from "../../../../lib/server-session";
import { ReviewPage } from "../../../../components/review/review-page";
import { reviewLoader } from "../../../../lib/review/loader";
import { ReviewDataUnavailable } from "../../../../lib/review/types";

export const metadata = { title: "Review · StateAction.ai" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReviewRecordingPage({
  params,
}: {
  params: Promise<{ recordingId: string }>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const { recordingId } = await params;
  if (!UUID.test(recordingId)) notFound();
  const loader = reviewLoader();
  try {
    const [bundle, recordings] = await Promise.all([
      loader.load(session.userId, recordingId),
      loader.listRecordings(session.userId),
    ]);
    if (!bundle) notFound();
    let mediaOrigin: string | null = null;
    try {
      mediaOrigin = new URL(serverConfig().publicEndpoint).origin;
    } catch {
      mediaOrigin = null;
    }
    return (
      <ReviewPage
        key={recordingId}
        bundle={bundle}
        recordings={recordings}
        mediaOrigin={mediaOrigin}
      />
    );
  } catch (error) {
    if (error instanceof ReviewDataUnavailable)
      return <Unavailable message={error.message} />;
    throw error;
  }
}

function Unavailable({ message }: { message: string }) {
  return (
    <>
      <Link href="/pipeline" className="text-[13px] text-brand">
        ← Pipeline
      </Link>
      <p role="alert" className="mt-6 text-sm text-danger">
        Review data is not available yet. {message}
      </p>
    </>
  );
}
