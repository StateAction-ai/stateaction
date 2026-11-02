"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { initialsOf } from "../../lib/profile";
import { useProfile } from "./profile-context";
import { useSignOut } from "./sign-out";

export function Avatar({
  name,
  email,
  size = "h-[30px] w-[30px]",
}: {
  name: string;
  email: string;
  size?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="avatar"
      className={`grid shrink-0 place-items-center rounded-full bg-[#dfebe4] text-[11px] font-bold ${size}`}
    >
      {initialsOf(name, email)}
    </span>
  );
}

export function AccountMenu() {
  const { session } = useProfile();
  const { signOut, status } = useSignOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${session.name}`}
        className="flex min-h-11 min-w-11 items-center gap-2 rounded-lg border border-transparent p-1.5 text-[11px] font-semibold data-[state=open]:bg-white"
      >
        <Avatar name={session.name} email={session.email} />
        <span
          className="hidden max-w-[150px] truncate sm:inline"
          data-testid="account-name"
        >
          {session.name}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="hidden h-3.5 w-3.5 text-muted sm:block"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <div className="mb-1.5 grid gap-0.5 border-b border-line px-3 py-3 [overflow-wrap:anywhere]">
          <strong className="text-xs">{session.name}</strong>
          <span className="text-[11px] text-muted">{session.email}</span>
        </div>
        <DropdownMenuItem asChild>
          <Link href="/settings">Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-danger"
          disabled={status === "pending"}
          onSelect={() => void signOut()}
        >
          {status === "pending" ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
