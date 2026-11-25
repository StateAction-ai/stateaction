import { redirect } from "next/navigation";
import { consoleAccess } from "../lib/server-session";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Signed-out requests redirect to /login inside consoleAccess().
  const access = await consoleAccess();
  redirect(
    access.state === "ok" && access.session.role === "staff"
      ? "/recordings"
      : "/data-browser",
  );
}
