/**
 * quick-studio UI (Ring 2) — TabBar.
 *
 * Renders the strip of open Tabs with an active highlight and a per-Tab close
 * control. Clicking a Tab activates it; clicking its close button removes it
 * (FR-23). Renders nothing when no Tabs are open.
 *
 * Epic 7 restyle: Chrome-style rounded-top tabs (`design-artifacts/workspace.html`
 * `.tab`/`.tab.on`) with a per-kind leading icon; the active tab shares the
 * content panel's surface (`bg-card`) and pulls down a hairline (`-mb-px`) so it
 * visually fuses with the panel below. Presentation only: every ARIA role, the
 * close button's `aria-label`, and all handlers are unchanged.
 */

import type { TabKind, WorkspaceState } from "./workspace-state.ts";

/** Per-kind leading tab icon (mirrors the launcher rail's icon set). */
const TAB_ICON: Readonly<Record<TabKind, React.JSX.Element>> = {
  table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  ),
  query: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M6 8l4 4-4 4M12.5 16H18" />
    </svg>
  ),
  erd: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="7" height="6" rx="1" />
      <rect x="14" y="15" width="7" height="6" rx="1" />
      <path d="M6.5 9v4a2 2 0 0 0 2 2h5.5" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M4 5h16v11H9l-4 3.5V16H4z" />
      <path d="M9 10.5h.01M12.5 10.5h.01M16 10.5h.01" />
    </svg>
  ),
  report: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  ),
};

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
      className="flex shrink-0 items-end gap-[3px] overflow-visible"
    >
      {state.tabs.map((tab) => {
        const active = tab.id === state.activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            data-active={active ? "true" : undefined}
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
              "wtab group relative mx-2 flex h-9 shrink-0 cursor-pointer select-none items-center gap-2 rounded-t-xl px-3.5 text-xs transition-colors",
              active
                ? "-mb-px h-[37px] bg-card text-foreground"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <span aria-hidden className="h-[13px] w-[13px] shrink-0 opacity-85">
              {TAB_ICON[tab.kind]}
            </span>
            <span className="whitespace-nowrap">{tab.title}</span>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="ml-0.5 grid h-[15px] w-[15px] shrink-0 place-items-center rounded-[4px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
