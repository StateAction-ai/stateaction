import type { ReactNode } from "react";
import "./styles.css";
export const metadata = {
  title: "StateAction.ai",
  description: "Robotics data collection and review",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
