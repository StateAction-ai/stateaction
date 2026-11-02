import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { pageIdentity, type Role } from "@stateaction/server/auth";
import type { ConsoleRole, ConsoleSession } from "./console-session";

/**
 * What the current request may do in the console. Identity, session validity
 * and roles are read on every request from the shared Better Auth session and
 * the operator-managed access table (`pageIdentity`); nothing here trusts a
 * header, environment variable or client value for identity.
 *
 * - `ok`: an enabled staff or customer grant (staff wins when both exist).
 * - `no-console`: signed in but not allowed into the web console: access
 *   pending/disabled, or a collector-only account (collectors capture in the
 *   Android app and are never granted staff or customer pages here).
 * - `unavailable`: the auth/access lookup failed. Fail closed, never guess.
 * Signed-out requests redirect to /login.
 */
export type ConsoleAccess =
  | { state: "ok"; session: ConsoleSession }
  | {
      state: "no-console";
      reason: "pending" | "disabled" | "collector-only";
      email: string;
      name: string;
    }
  | { state: "unavailable" };

export function consoleRoleOf(roles: readonly Role[]): ConsoleRole | null {
  if (roles.includes("staff")) return "staff";
  if (roles.includes("customer")) return "customer";
  return null;
}

export async function consoleAccess(): Promise<ConsoleAccess> {
  const identity = await pageIdentity(await headers());
  if (identity.state === "signed-out") redirect("/login");
  if (identity.state === "unavailable") return { state: "unavailable" };
  const { user, access } = identity;
  if (access.status !== "active")
    return {
      state: "no-console",
      reason: access.status,
      email: user.email,
      name: user.name,
    };
  const role = consoleRoleOf(access.roles);
  if (!role)
    return {
      state: "no-console",
      reason: "collector-only",
      email: user.email,
      name: user.name,
    };
  return {
    state: "ok",
    session: { userId: user.id, email: user.email, name: user.name, role },
  };
}

/**
 * Page-level guard. Layouts do not re-run on client navigation, so every
 * protected page checks again. Anything but an allowed role is a 404 so a
 * customer cannot probe staff routes.
 */
export async function requireConsoleSession(
  allowed: readonly ConsoleRole[] = ["staff", "customer"],
): Promise<ConsoleSession> {
  const access = await consoleAccess();
  if (access.state !== "ok" || !allowed.includes(access.session.role))
    notFound();
  return access.session;
}
