import type { ReactNode } from "react";
import { ConsoleClient } from "../../components/console-client";
import { AccessNotice } from "../../components/access-notice";
import { consoleAccess } from "../../lib/server-session";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await consoleAccess();
  if (access.state !== "ok") return <AccessNotice access={access} />;
  return <ConsoleClient session={access.session}>{children}</ConsoleClient>;
}
