import { hostedDevProfile } from "@stateaction/server";
import type { ReactNode } from "react";
import "./styles.css";
export const metadata = {
  title: "StateAction.ai",
  description: "Robotics data collection and review",
};
export default function Layout({ children }: { children: ReactNode }) {
  const profile = hostedDevProfile();
  return (
    <html lang="en">
      <body>
        {profile ? (
          <p
            role="status"
            className="m-0 border-b bg-amber-100 p-2 text-center text-sm font-semibold text-amber-950"
          >
            Hosted production data ·{" "}
            {profile.mode === "read-only" ? "Read only" : "Writes enabled"}
          </p>
        ) : null}
        {children}
      </body>
    </html>
  );
}
