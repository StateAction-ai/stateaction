import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { pageIdentity, signInMethods } from "@stateaction/server/auth";
import { LoginForm } from "./login-form";
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · StateAction.ai" };
export default async function LoginPage() {
  const methods = await signInMethods();
  if (methods) {
    const identity = await pageIdentity(await headers());
    if (identity.state === "signed-in") redirect("/");
  }
  return (
    <main>
      <p className="brand">StateAction.ai</p>
      <h1>Sign in</h1>
      {methods ? (
        <LoginForm password={methods.password} google={methods.google} />
      ) : (
        <p role="alert" className="error">
          Sign-in is temporarily unavailable. Try again later.
        </p>
      )}
    </main>
  );
}
