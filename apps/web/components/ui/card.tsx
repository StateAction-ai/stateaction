import * as React from "react";
import { cn } from "../../lib/utils";

export function Card({
  as: Element = "section",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: "div" | "section" }) {
  return (
    <Element
      className={cn(
        "rounded-2xl border border-line bg-paper shadow-[0_6px_25px_#21332a06]",
        className,
      )}
      {...props}
    />
  );
}
export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("border-b border-line px-5 py-4 sm:px-6", className)}
      {...props}
    />
  );
}
export function CardBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 sm:p-6", className)} {...props} />;
}
