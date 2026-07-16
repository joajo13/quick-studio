/**
 * quick-studio UI (Ring 2) — shadcn/ui `Command` primitive (Story 8.1 foundation).
 *
 * Thin wrappers over `cmdk`, re-pointed onto this project's existing tokens:
 * mono neutral list on `bg-card`, items highlight via `aria-selected:bg-accent`,
 * the search glyph is inline SVG (no icon library). This is the combobox
 * Story 8.5 uses to replace the native `#chat-provider` `<select>` — NOT
 * wired into any shipping surface by this story.
 */

import * as React from "react";
import {
  Command as CommandPrimitive,
  CommandEmpty as CommandPrimitiveEmpty,
  CommandGroup as CommandPrimitiveGroup,
  CommandInput as CommandPrimitiveInput,
  CommandItem as CommandPrimitiveItem,
  CommandList as CommandPrimitiveList,
  CommandSeparator as CommandPrimitiveSeparator,
} from "cmdk";

import { cn } from "../../lib/utils.ts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog.tsx";

function SearchIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-[var(--radius)] bg-card font-mono text-card-foreground",
      className,
    )}
    {...props}
  />
));
Command.displayName = CommandPrimitive.displayName;

function CommandDialog({
  title = "command",
  description = "search…",
  children,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
}): React.JSX.Element {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0">
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitiveInput>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveInput>
>(({ className, ...props }, ref) => (
  <div className="flex items-center gap-2 border-b border-border px-3" data-slot="command-input-wrapper">
    <SearchIcon className="h-4 w-4 shrink-0 opacity-50" />
    <CommandPrimitiveInput
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-[var(--radius)] bg-transparent py-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = CommandPrimitiveInput.displayName;

const CommandList = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitiveList>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveList>
>(({ className, ...props }, ref) => (
  <CommandPrimitiveList
    ref={ref}
    className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className)}
    {...props}
  />
));
CommandList.displayName = CommandPrimitiveList.displayName;

const CommandEmpty = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitiveEmpty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveEmpty>
>((props, ref) => (
  <CommandPrimitiveEmpty
    ref={ref}
    className="py-6 text-center font-mono text-xs lowercase text-muted-foreground"
    {...props}
  />
));
CommandEmpty.displayName = CommandPrimitiveEmpty.displayName;

const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitiveGroup>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveGroup>
>(({ className, ...props }, ref) => (
  <CommandPrimitiveGroup
    ref={ref}
    className={cn(
      "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground",
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = CommandPrimitiveGroup.displayName;

const CommandSeparator = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitiveSeparator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveSeparator>
>(({ className, ...props }, ref) => (
  <CommandPrimitiveSeparator ref={ref} className={cn("-mx-1 h-px bg-border", className)} {...props} />
));
CommandSeparator.displayName = CommandPrimitiveSeparator.displayName;

const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitiveItem>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveItem>
>(({ className, ...props }, ref) => (
  <CommandPrimitiveItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 font-mono text-xs text-foreground outline-none aria-selected:bg-accent aria-selected:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = CommandPrimitiveItem.displayName;

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
};
