"use client";
import { useState, type FormEvent } from "react";
import { clientHeaders } from "../client-header";
type Props = { password: boolean; google: boolean };
export function LoginForm({ password, google }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: clientHeaders,
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        }),
      });
      if (response.ok) {
        window.location.replace("/");
        return;
      }
      setError(
        response.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : response.status === 401
            ? "Email or password is incorrect."
            : "Sign-in is temporarily unavailable.",
      );
    } catch {
      setError("Sign-in is temporarily unavailable.");
    } finally {
      setBusy(false);
    }
  }
  async function signInWithGoogle() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: clientHeaders,
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      });
      const body = (await response.json()) as { url?: unknown };
      if (response.ok && typeof body.url === "string") {
        window.location.assign(body.url);
        return;
      }
      setError("Google sign-in is temporarily unavailable.");
    } catch {
      setError("Google sign-in is temporarily unavailable.");
    }
    setBusy(false);
  }
  return (
    <div className="card">
      {google ? (
        <button type="button" onClick={signInWithGoogle} disabled={busy}>
          Continue with Google
        </button>
      ) : null}
      {password ? (
        <form onSubmit={submit} aria-label="Sign in with email">
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={12}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
