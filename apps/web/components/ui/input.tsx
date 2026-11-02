import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "block min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold text-ink read-only:bg-field read-only:text-[#4f5d4c] aria-[invalid=true]:border-danger",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
