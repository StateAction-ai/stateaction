import { requireConsoleSession } from "../../../lib/server-session";

export const metadata = { title: "Pipeline · StateAction.ai" };

export default async function PipelinePage() {
  await requireConsoleSession(["staff"]);
  return (
    <>
      <h1 className="m-0 text-[32px] font-bold tracking-[-0.03em]">Pipeline</h1>
      <p className="mt-2 text-muted">
        Recording monitoring arrives with its own ticket. No recordings are
        shown yet.
      </p>
    </>
  );
}
