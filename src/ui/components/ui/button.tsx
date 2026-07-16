/**
 * quick-studio UI (Ring 2) — shadcn/ui `Button` primitive (Story 8.1 foundation).
 *
 * Authored in the shadcn structure but re-pointed onto this project's EXISTING
 * neutral tokens: the default/primary variant is the ink accent (`bg-coral
 * text-coral-ink`), NOT the blue `--primary`. Destructive stays functional red
 * (`--err`). No new token, no animation utility, no icon-library import.
 */

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] font-mono text-xs lowercase transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-coral text-coral-ink hover:opacity-90",
        outline: "border border-border bg-transparent hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent",
        destructive: "border border-err-line bg-err-soft text-err hover:bg-err/20",
        secondary: "bg-muted text-foreground hover:bg-accent",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-8",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
