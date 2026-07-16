/**
 * quick-studio UI (Ring 2) — shadcn/ui `Popover` primitive (Story 8.1 foundation).
 *
 * Thin wrappers over `@radix-ui/react-popover`, re-pointed onto this project's
 * existing tokens: the content panel is `bg-card`/`border-border`. No
 * animation utility. Story 8.5 mounts a `Command` inside this for the
 * provider combobox — NOT wired into any shipping surface by this story.
 */

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils.ts";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-[var(--radius)] border border-border bg-card p-4 text-card-foreground shadow-md outline-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
