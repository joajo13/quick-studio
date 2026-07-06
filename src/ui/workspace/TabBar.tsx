/**
 * quick-studio UI (Ring 2) — TabBar.
 *
 * Renders the strip of open Tabs with an active highlight and a per-Tab close
 * control. Clicking a Tab activates it; clicking its close button removes it
 * (FR-23). Renders nothing when no Tabs are open.
 */

import type { WorkspaceState } from "./workspace-state.ts";

export function TabBar({
  state,
  onActivate,
  onClose,
}: {
  state: WorkspaceState;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
}): React.JSX.Element | null {
  if (state.tabs.length === 0) {
    return null;
  }

  return (
    <div
      role="tablist"
      aria-label="Open tabs"
      className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-card px-2 pt-2"
    >
      {state.tabs.map((tab) => {
        const active = tab.id === state.activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(e) => {
              // Only handle keys that land on the tab row itself. Keys fired
              // while the nested close button is focused must reach that
              // button's native Enter/Space → click (which closes the tab);
              // calling preventDefault here would swallow it and re-activate.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate(tab.id);
              }
            }}
            className={[
              "group flex cursor-pointer select-none items-center gap-2 rounded-t-[var(--radius)] border border-b-0 px-3 py-1.5 text-sm transition-colors",
              active
                ? "border-border bg-background text-foreground"
                : "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            ].join(" ")}
          >
            <span className="whitespace-nowrap">{tab.title}</span>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground opacity-70 transition hover:bg-border hover:text-foreground hover:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
