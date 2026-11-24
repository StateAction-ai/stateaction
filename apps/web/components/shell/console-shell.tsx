"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Database, ListChecks, MonitorPlay } from "lucide-react";
import { Brand } from "../brand";
import { AccountMenu } from "./account-menu";
import { ProfileProvider } from "./profile-context";
import { SignOutProvider, SignOutStatusBanner } from "./sign-out";
import { navigationFor, type ConsoleSession } from "../../lib/console-session";
import { cn } from "../../lib/utils";

const ICONS = {
  pipeline: ListChecks,
  data: Database,
  review: MonitorPlay,
} as const;

function sectionTitle(
  pathname: string,
  items: { href: string; label: string }[],
): string {
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/recordings/")) return "Recordings";
  return (
    items.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
      ?.label ?? ""
  );
}

export function ConsoleShell({
  session,
  revoke,
  children,
}: {
  session: ConsoleSession;
  revoke: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const items = navigationFor(session.role);
  return (
    <ProfileProvider session={session}>
      <SignOutProvider revoke={revoke}>
        <div className="grid min-h-screen grid-cols-1 md:grid-cols-[230px_minmax(0,1fr)]">
          <a
            href="#console-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-paper focus:px-4 focus:py-2 focus:font-semibold focus:text-ink"
          >
            Skip to main content
          </a>
          <aside className="border-b border-line bg-sidebar px-4 py-3 md:sticky md:top-0 md:h-screen md:border-r md:border-b-0 md:px-4 md:py-7">
            <div className="md:px-2 md:pb-8">
              <Brand />
            </div>
            <nav aria-label="Primary" className="mt-2 md:mt-0">
              <p className="mx-3 mb-2 hidden text-[9px] font-bold tracking-[0.14em] text-muted uppercase md:block">
                Workspace
              </p>
              <ul className="m-0 flex list-none gap-1 p-0 md:block">
                {items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const active =
                    pathname === item.href ||
                    pathname.startsWith(`${item.href}/`);
                  return (
                    <li
                      key={item.href}
                      className="min-w-0 flex-1 md:mb-1 md:flex-none"
                    >
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-11 items-center justify-center gap-2.5 rounded-lg px-3 text-[13px] font-medium text-[#53625a] md:justify-start",
                          active && "bg-brand-soft text-brand-ink",
                        )}
                      >
                        <Icon
                          aria-hidden="true"
                          className="hidden h-[18px] w-[18px] md:block"
                        />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </aside>
          <div className="min-w-0">
            <header className="flex min-h-[61px] items-center justify-between border-b border-line bg-topbar px-4 text-xs text-muted sm:px-6 md:px-10">
              <span className="font-semibold text-ink">
                {sectionTitle(pathname, items)}
              </span>
              <AccountMenu />
            </header>
            <SignOutStatusBanner />
            <main
              id="console-content"
              tabIndex={-1}
              className="px-4 py-8 sm:px-6 md:px-10"
            >
              {children}
            </main>
          </div>
        </div>
      </SignOutProvider>
    </ProfileProvider>
  );
}
