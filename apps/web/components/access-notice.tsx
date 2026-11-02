"use client";
import * as React from "react";
import { Brand } from "./brand";
import { Button } from "./ui/button";
import { SessionRefresh } from "./session-refresh";
import {
  SignOutProvider,
  SignOutStatusBanner,
  useSignOut,
} from "./shell/sign-out";
import { revokeSession } from "../lib/client-api";

type Notice =
  | { state: "unavailable" }
  | {
      state: "no-console";
      reason: "pending" | "disabled" | "collector-only";
      email: string;
      name: string;
    };

const COPY = {
  pending: {
    title: "Access pending",
    body: "Your account is waiting for a StateAction.ai operator to enable access. You can sign out and come back later.",
  },
  disabled: {
    title: "Access disabled",
    body: "Access for this account is currently disabled. Contact your StateAction.ai operator if you think this is a mistake.",
  },
  "collector-only": {
    title: "Capture accounts use the Android app",
    body: "This account is set up for recording with the StateAction.ai Android app. It has no pages in the web console. Your recordings are not affected.",
  },
} as const;

function SignOutAction() {
  const { signOut, status } = useSignOut();
  return (
    <Button
      type="button"
      variant="outline"
      disabled={status === "pending"}
      onClick={() => void signOut()}
    >
      {status === "pending" ? "Signing out…" : "Sign out"}
    </Button>
  );
}

/** Honest non-console states: no navigation, no private data, sign-out only. */
export function AccessNotice({ access }: { access: Notice }) {
  const copy =
    access.state === "unavailable"
      ? {
          title: "Temporarily unavailable",
          body: "We could not check your access. Try again shortly.",
        }
      : COPY[access.reason];
  return (
    <SignOutProvider revoke={revokeSession}>
      <SignOutStatusBanner />
      <main className="mx-auto grid max-w-xl gap-4 px-6 py-16">
        <Brand />
        <h1 className="m-0 text-[28px] font-bold tracking-[-0.03em]">
          {copy.title}
        </h1>
        {access.state === "no-console" ? (
          <p className="m-0 text-muted [overflow-wrap:anywhere]">
            Signed in as <strong>{access.email}</strong>.
          </p>
        ) : null}
        <p
          className="m-0 text-muted"
          role={access.state === "unavailable" ? "alert" : undefined}
        >
          {copy.body}
        </p>
        <div className="flex flex-wrap gap-3">
          {access.state === "unavailable" ? (
            <Button type="button" onClick={() => window.location.reload()}>
              Try again
            </Button>
          ) : null}
          <SignOutAction />
        </div>
        <SessionRefresh />
      </main>
    </SignOutProvider>
  );
}
