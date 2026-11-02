import { notFound } from "next/navigation";
import { serverConfig } from "@stateaction/server";
import { requireConsoleSession } from "../../../../lib/server-session";
import { clipReturnTo } from "../../../../lib/review-draft";
import { ClipPage } from "../../../../components/clip-review/clip-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clip · StateAction.ai" };

export default async function ClipRoute({
  params,
  searchParams,
}: {
  params: Promise<{ clipId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession();
  const { clipId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      clipId,
    )
  )
    notFound();
  const query = await searchParams;
  const raw = typeof query.returnTo === "string" ? query.returnTo : undefined;
  const returnTo = clipReturnTo(raw, session.role);
  let mediaOrigin: string | null = null;
  try {
    mediaOrigin = new URL(serverConfig().publicEndpoint).origin;
  } catch {
    /* viewer will fail closed */
  }
  return (
    <ClipPage
      key={`${session.userId}:${clipId}`}
      clipId={clipId}
      userId={session.userId}
      role={session.role}
      returnTo={returnTo}
      mediaOrigin={mediaOrigin}
    />
  );
}
