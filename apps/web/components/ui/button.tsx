import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-brand bg-brand text-white hover:bg-brand-strong",
        outline: "border-line bg-white text-ink hover:bg-field",
        ghost: "border-transparent bg-transparent hover:bg-brand-soft",
        danger: "border-[#edc8cc] bg-white text-danger hover:bg-danger-soft",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        {...(asChild ? {} : { type: type ?? "button" })}
        className={cn(buttonVariants({ variant }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
