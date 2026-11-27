import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  authRuntime,
  pageIdentity,
  signInMethods,
} from "@stateaction/server/auth";
import { Brand } from "../../components/brand";
import { LoginForm } from "./login-form";
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · StateAction.ai" };
export default async function LoginPage() {
  const methods = await signInMethods();
  if (methods) {
    const requestHeaders = await headers();
    if (methods.google && !methods.password) {
      // OAuth state and session cookies stay on the registered callback host.
      const signInUrl = new URL("/login", authRuntime().config.baseURL);
      if (requestHeaders.get("host")?.toLowerCase() !== signInUrl.host) {
        redirect(signInUrl.href);
      }
    }
    const identity = await pageIdentity(requestHeaders);
    if (identity.state === "signed-in") redirect("/console");
  }
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-sm content-center gap-6 px-6 py-12">
      <Brand />
      <h1 className="m-0 text-[28px] font-bold tracking-[-0.03em]">Sign in</h1>
      {methods ? (
        <LoginForm password={methods.password} google={methods.google} />
      ) : (
        <p role="alert" className="m-0 text-xs font-semibold text-danger">
          Sign-in is temporarily unavailable. Try again later.
        </p>
      )}
    </main>
  );
}
