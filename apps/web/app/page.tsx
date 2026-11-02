import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { pageIdentity } from "@stateaction/server/auth";
import { SessionRefresh } from "./session-refresh";
import { SignOutButton } from "./sign-out-button";
export const dynamic = "force-dynamic";
const ROLE_LABELS: Record<string, string> = {
  collector: "Collector",
  staff: "Staff",
  customer: "Customer",
};
export default async function Home() {
  const identity = await pageIdentity(await headers());
  if (identity.state === "signed-out") redirect("/login");
  if (identity.state === "unavailable")
    return (
      <main>
        <p className="brand">StateAction.ai</p>
        <h1>Temporarily unavailable</h1>
        <p role="alert">We could not check your access. Try again shortly.</p>
      </main>
    );
  const { user, access } = identity;
  return (
    <main>
      <p className="brand">StateAction.ai</p>
      {access.status === "active" ? (
        <>
          <h1>Collection and review</h1>
          <p>
            Signed in as <strong>{user.email}</strong>.
          </p>
          <p data-testid="roles">
            Access: {access.roles.map((r) => ROLE_LABELS[r] ?? r).join(", ")}
          </p>
          <p>
            Capture, review and Dataset screens will connect here as their
            implementation lands.
          </p>
        </>
      ) : (
        <>
          <h1>
            {access.status === "pending" ? "Access pending" : "Access disabled"}
          </h1>
          <p>
            Signed in as <strong>{user.email}</strong>.
          </p>
          <p>
            {access.status === "pending"
              ? "Your account is waiting for a StateAction.ai operator to enable access. You can sign out and come back later."
              : "Access for this account is currently disabled. Contact your StateAction.ai operator if you think this is a mistake."}
          </p>
          <p className="muted">Account ID: {user.id}</p>
        </>
      )}
      <SessionRefresh />
      <SignOutButton />
    </main>
  );
}
