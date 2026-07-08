/**
 * quick-studio UI (Ring 2) — Workspace shell.
 *
 * The two-Panel resizable layout: a launcher sidebar (buttons that open each of
 * the five Tab kinds) and a main area (Tab strip + active Tab body). Uses
 * `react-resizable-panels` — the primitive shadcn's `resizable` wraps — with a
 * draggable `PanelResizeHandle` so the Panels resize live (FR-24). Restore of
 * Panel sizes on launch is Epic 2; here the layout is Ephemeral.
 */

import { useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ExposureInfo } from "../../shared/contract.ts";
import { SettingsPanel } from "../settings/SettingsPanel.tsx";
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

/**
 * The launcher rail: new-Tab buttons at the top and a bottom-PINNED Settings
 * toggle (a rail control, NOT a `TabKind`). The Settings control opens the
 * Settings surface that hosts Connections management (Story 2.4).
 */
function LauncherRail({
  onOpen,
  settingsOpen,
  onToggleSettings,
}: {
  onOpen: (kind: TabKind) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
}): React.JSX.Element {
  return (
    <nav aria-label="Open a new tab" className="flex h-full flex-col gap-1 p-2">
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

      {/* Bottom-pinned Settings control (mt-auto pushes it to the rail bottom). */}
      <button
        type="button"
        aria-label="Settings"
        aria-pressed={settingsOpen}
        data-testid="settings-toggle"
        onClick={onToggleSettings}
        className={`mt-auto flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-left font-mono text-xs lowercase transition-colors hover:bg-accent hover:text-accent-foreground ${
          settingsOpen ? "bg-accent text-accent-foreground" : "text-muted-foreground"
        }`}
      >
        <span aria-hidden>⚙</span>
        <span>settings</span>
      </button>
    </nav>
  );
}

/**
 * Prominent, unmistakable full-width Port-Exposure Warning (FR-22, UX-DR5).
 * Rendered directly under the header only when the Core bound a non-loopback
 * address. States the risk and the exact steps to revert to localhost-only.
 */
function ExposureBanner({ exposure }: { exposure: ExposureInfo }): React.JSX.Element {
  return (
    <div
      role="alert"
      data-testid="exposure-banner"
      className="shrink-0 border-b border-red-700 bg-red-600 px-4 py-3 text-sm text-white"
    >
      <div className="font-semibold">
        ⚠ Port exposure: quick-studio is reachable off-machine at {exposure.host}:{exposure.port}
      </div>
      <p className="mt-1 text-red-50">
        Anyone on the network can reach this UI and, through it, the connected database — the
        session token is the only thing protecting your data. To revert to localhost-only: stop
        quick-studio, unset <code className="rounded bg-red-700 px-1">QS_HOST</code> (or set{" "}
        <code className="rounded bg-red-700 px-1">QS_HOST=127.0.0.1</code>), then start it again.
      </p>
    </div>
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
  exposure,
}: {
  state: WorkspaceState;
  onOpen: (kind: TabKind) => void;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onStop: () => void;
  stopping: boolean;
  connectionIndicator: React.ReactNode;
  exposure?: ExposureInfo;
}): React.JSX.Element {
  const activeTab =
    state.tabs.find((t) => t.id === state.activeTabId) ?? null;

  // Settings surface open/closed lives in React memory only (Ephemeral — the
  // story explicitly does NOT persist Settings open state; that is Story 2.5).
  const [settingsOpen, setSettingsOpen] = useState(false);

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

      {exposure?.exposed ? <ExposureBanner exposure={exposure} /> : null}

      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={20} minSize={12} maxSize={40} className="bg-card">
          <LauncherRail
            onOpen={onOpen}
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((v) => !v)}
          />
        </Panel>

        <PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-primary data-[resize-handle-state=drag]:bg-primary" />

        <Panel defaultSize={80} minSize={30}>
          {settingsOpen ? (
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          ) : (
            <div className="flex h-full flex-col">
              <TabBar state={state} onActivate={onActivate} onClose={onClose} />
              <div className="min-h-0 flex-1 overflow-auto">
                <TabContent tab={activeTab} />
              </div>
            </div>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
