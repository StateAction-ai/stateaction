import { requireConsoleSession } from "../../../lib/server-session";

export const metadata = { title: "Data browser · StateAction.ai" };

export default async function DataBrowserPage() {
  await requireConsoleSession();
  return (
    <>
      <h1 className="m-0 text-[32px] font-bold tracking-[-0.03em]">
        Data browser
      </h1>
      <p className="mt-2 text-muted">
        Datasets arrive with their catalog tickets. Nothing has been shared with
        you yet.
      </p>
    </>
  );
}
