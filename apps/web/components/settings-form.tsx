"use client";
import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MESSAGES,
  parseDisplayName,
} from "@stateaction/server/display-name";
import * as React from "react";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useProfile } from "./shell/profile-context";
import { ROLE_LABEL } from "../lib/console-session";

export type SaveResult =
  | { ok: true; name: string }
  | {
      ok: false;
      code: "invalid" | "stale" | "unavailable" | "unauthenticated";
      message?: string;
    };

const FAILURE_COPY = {
  invalid: "That name was not accepted. Check it and try again.",
  stale: "Your session changed. Reload the page and try again.",
  unavailable:
    "We could not save your name. Check your connection and try again.",
  unauthenticated: "Your session has ended. Sign in again to continue.",
} as const;

export function SettingsForm({
  save,
  onSaved,
}: {
  save: (name: string) => Promise<SaveResult>;
  /** Called after server success, e.g. router.refresh() so server components re-read. */
  onSaved?: () => void;
}) {
  const { session, applyServerName } = useProfile();
  const [value, setValue] = React.useState(session.name);
  const [state, setState] = React.useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const input = React.useRef<HTMLInputElement>(null);
  const parsed = parseDisplayName(value);
  const error = state.kind === "error" ? state.message : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind === "saving") return;
    const result = parseDisplayName(value);
    if (!result.ok) {
      setState({
        kind: "error",
        message: DISPLAY_NAME_MESSAGES[result.reason],
      });
      input.current?.focus();
      return;
    }
    setState({ kind: "saving" });
    let outcome: SaveResult;
    try {
      outcome = await save(result.value);
    } catch {
      outcome = { ok: false, code: "unavailable" };
    }
    if (outcome.ok) {
      // The shell name/avatar change only now, from the server's answer.
      applyServerName(outcome.name);
      setValue(outcome.name);
      setState({ kind: "saved" });
      onSaved?.();
    } else {
      setState({
        kind: "error",
        message: outcome.message ?? FAILURE_COPY[outcome.code],
      });
      input.current?.focus();
    }
  }

  const unchanged = parsed.ok && parsed.value === session.name;
  return (
    <div className="max-w-[570px]">
      <p className="mb-1 text-[11px] font-bold tracking-[0.14em] text-muted uppercase">
        Your account
      </p>
      <h1 className="m-0 text-[32px] leading-tight font-bold tracking-[-0.03em]">
        Settings
      </h1>
      <p className="mt-2 mb-6 text-muted">Manage your display name.</p>
      <Card>
        <CardHeader>
          <h2 className="m-0 text-base font-bold">Profile</h2>
        </CardHeader>
        <CardBody>
          <form onSubmit={submit} noValidate className="grid gap-5">
            <div>
              <Label htmlFor="display-name">Display name</Label>
              <Input
                id="display-name"
                ref={input}
                name="displayName"
                autoComplete="name"
                value={value}
                maxLength={DISPLAY_NAME_MAX * 4}
                aria-invalid={error ? true : undefined}
                aria-describedby={
                  error ? "display-name-error" : "display-name-hint"
                }
                onChange={(e) => {
                  setValue(e.target.value);
                  if (state.kind !== "saving") setState({ kind: "idle" });
                }}
              />
              <p
                id="display-name-hint"
                className="mt-1.5 text-[11px] text-muted"
              >
                Shown to your team. 1 to {DISPLAY_NAME_MAX} characters.
              </p>
              {error ? (
                <p
                  id="display-name-error"
                  role="alert"
                  className="mt-1.5 text-xs font-semibold text-danger"
                >
                  {error}
                </p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                readOnly
                value={session.email}
                aria-readonly="true"
              />
            </div>
            <div>
              <Label htmlFor="role">Current role</Label>
              <Input
                id="role"
                readOnly
                value={ROLE_LABEL[session.role]}
                aria-readonly="true"
              />
              <p className="mt-1.5 text-[11px] text-muted">
                Access is managed by an operator.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="submit"
                disabled={state.kind === "saving" || unchanged}
                className="min-h-11"
              >
                {state.kind === "saving" ? "Saving…" : "Save changes"}
              </Button>
              <p role="status" className="m-0 text-xs font-semibold text-good">
                {state.kind === "saved" ? "Saved." : ""}
              </p>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
