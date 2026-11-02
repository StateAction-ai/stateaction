"use client";
import * as React from "react";
import type { ConsoleSession } from "../../lib/console-session";

interface ProfileValue {
  session: ConsoleSession;
  /** Call only with the name the server returned after a successful update. */
  applyServerName: (name: string) => void;
}

const ProfileContext = React.createContext<ProfileValue | null>(null);

export function ProfileProvider({
  session,
  children,
}: {
  session: ConsoleSession;
  children: React.ReactNode;
}) {
  const [name, setName] = React.useState(session.name);
  // A server-driven refresh (router.refresh) may deliver a new name.
  React.useEffect(() => setName(session.name), [session.name]);
  const value = React.useMemo<ProfileValue>(
    () => ({ session: { ...session, name }, applyServerName: setName }),
    [session, name],
  );
  return (
    <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
  );
}

export function useProfile(): ProfileValue {
  const value = React.useContext(ProfileContext);
  if (!value) throw new Error("useProfile requires ProfileProvider");
  return value;
}
