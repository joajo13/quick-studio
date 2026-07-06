/**
 * quick-studio UI (Ring 2) — Workspace shell.
 *
 * The two-Panel resizable layout: a launcher sidebar (buttons that open each of
 * the five Tab kinds) and a main area (Tab strip + active Tab body). Uses
 * `react-resizable-panels` — the primitive shadcn's `resizable` wraps — with a
 * draggable `PanelResizeHandle` so the Panels resize live (FR-24). Restore of
 * Panel sizes on launch is Epic 2; here the layout is Ephemeral.
 */

import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { TabBar } from "./TabBar.tsx";
import { TabContent } from "./TabContent.tsx";
import { TAB_KINDS, type TabKind, type WorkspaceState } from "./workspace-state.ts";

/** Launcher-rail labels per kind. */
const LAUNCH_LABEL: Readonly<Record<TabKind, string>> = {
  table: "New table",
  query: "New query",
  erd: "New ERD",
  chat: "New chat",
  report: "New report",
};

function LauncherRail({ onOpen }: { onOpen: (kind: TabKind) => void }): React.JSX.Element {
  return (
    <nav aria-label="Open a new tab" className="flex flex-col gap-1 p-2">
      <div className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Launcher
      </div>
      {TAB_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          onClick={() => onOpen(kind)}
          className="flex items-center rounded-[var(--radius)] px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {LAUNCH_LABEL[kind]}
        </button>
      ))}
    </nav>
  );
}

export function Workspace({
  state,
  onOpen,
  onActivate,
  onClose,
  onStop,
  stopping,
  connectionIndicator,
}: {
  state: WorkspaceState;
  onOpen: (kind: TabKind) => void;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onStop: () => void;
  stopping: boolean;
  connectionIndicator: React.ReactNode;
}): React.JSX.Element {
  const activeTab =
    state.tabs.find((t) => t.id === state.activeTabId) ?? null;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">quick-studio</span>
          <span className="text-xs text-muted-foreground">workspace</span>
        </div>
        <div className="flex items-center gap-2">
          {connectionIndicator}
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="rounded-[var(--radius)] border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-foreground"
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        </div>
      </header>

      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={20} minSize={12} maxSize={40} className="bg-card">
          <LauncherRail onOpen={onOpen} />
        </Panel>

        <PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-primary data-[resize-handle-state=drag]:bg-primary" />

        <Panel defaultSize={80} minSize={30}>
          <div className="flex h-full flex-col">
            <TabBar state={state} onActivate={onActivate} onClose={onClose} />
            <div className="min-h-0 flex-1 overflow-auto">
              <TabContent tab={activeTab} />
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
