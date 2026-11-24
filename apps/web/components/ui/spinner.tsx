import { Loader2, type LucideProps } from "lucide-react";
import { cn } from "../../lib/utils";

export function Spinner({ className, ...props }: LucideProps) {
  return (
    <Loader2
      {...props}
      aria-hidden="true"
      className={cn(
        "size-4 shrink-0 animate-spin motion-reduce:animate-none",
        className,
      )}
    />
  );
}
