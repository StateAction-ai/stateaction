/** What the console shell knows about the signed-in human. Roles come only from the server. */
export type ConsoleRole = "staff" | "customer";

export interface ConsoleSession {
  userId: string;
  email: string;
  name: string;
  /** Highest-privilege role; staff sees staff navigation. */
  role: ConsoleRole;
}

export interface NavItem {
  href: string;
  label: string;
  icon: "pipeline" | "data";
}

/** Role-specific navigation. No project selector, Review or Releases entries. */
export function navigationFor(role: ConsoleRole): NavItem[] {
  const data: NavItem = {
    href: "/data-browser",
    label: "Data browser",
    icon: "data",
  };
  return role === "staff"
    ? [{ href: "/pipeline", label: "Pipeline", icon: "pipeline" }, data]
    : [data];
}

export const ROLE_LABEL: Record<ConsoleRole, string> = {
  staff: "Staff reviewer",
  customer: "Customer",
};
