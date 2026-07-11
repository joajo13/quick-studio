/**
 * quick-studio UI (Ring 2) — Workspace shell.
 *
 * The two-Panel resizable layout: a launcher sidebar (buttons that open each of
 * the five Tab kinds) and a main area (Tab strip + active Tab body). Uses
 * `react-resizable-panels` — the primitive shadcn's `resizable` wraps — with a
 * draggable `PanelResizeHandle` so the Panels resize live (FR-24). Panel-size
 * restore-on-launch is Core-gated (Story 2.5): `App.tsx` gates this component's
 * FIRST mount behind the initial `workspace.load` and passes the restored sizes
 * in via `panelSizes` (read once as `defaultSize`, per `react-resizable-panels`);
 * `onLayout` reports every subsequent drag back up for the debounced save. This
 * component never touches `workspace.save`/`localStorage` itself — it is
 * oblivious to run-mode, exactly like the rest of the UI ring.
 */

import { useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ExposureInfo, SchemaIndexInfo, SchemaTableInfo } from "../../shared/contract.ts";
import { CreateTablePanel } from "../schema/CreateTablePanel.tsx";
import { SchemaTree } from "../schema/SchemaTree.tsx";
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
  createOpen,
  onToggleCreate,
}: {
  onOpen: (kind: TabKind) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  createOpen: boolean;
  onToggleCreate: () => void;
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

      {/* Create-table control (Story 3.4): a rail toggle mirroring Settings, pinned
          to the rail bottom (mt-auto) just above it. Opens the CreateTablePanel. */}
      <button
        type="button"
        aria-label="Create table"
        aria-pressed={createOpen}
        data-testid="create-table-toggle"
        onClick={onToggleCreate}
        className={`mt-auto flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-left font-mono text-xs lowercase transition-colors hover:bg-accent hover:text-accent-foreground ${
          createOpen ? "bg-accent text-accent-foreground" : "text-muted-foreground"
        }`}
      >
        <span aria-hidden>＋</span>
        <span>create table</span>
      </button>

      {/* Bottom-pinned Settings control. */}
      <button
        type="button"
        aria-label="Settings"
        aria-pressed={settingsOpen}
        data-testid="settings-toggle"
        onClick={onToggleSettings}
        className={`flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-left font-mono text-xs lowercase transition-colors hover:bg-accent hover:text-accent-foreground ${
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
  onActivateTable,
  onSchemaLoaded,
  primaryKeys,
  indexes,
  allTables,
  queryDrafts,
  onQueryDraftChange,
  onStop,
  stopping,
  connectionIndicator,
  exposure,
  panelSizes,
  onLayout,
  extraTables,
  schemas,
  onTableCreated,
}: {
  state: WorkspaceState;
  onOpen: (kind: TabKind) => void;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  /** Route a schema-tree table activation into the workspace reducer (Story 3.2). */
  onActivateTable: (table: SchemaTableInfo) => void;
  /** Fired once when the schema tree resolves the live schema. */
  onSchemaLoaded: (tables: ReadonlyArray<SchemaTableInfo>) => void;
  /** PK column names of the active table tab's bound table (grid key-icon). */
  primaryKeys: ReadonlyArray<string>;
  /** Introspected indexes of the active table tab's bound table (Story 3.5 sub-view). */
  indexes: ReadonlyArray<SchemaIndexInfo>;
  /** All tables (introspected + optimistically-created) — the ERD data source (Story 4.1). */
  allTables: ReadonlyArray<SchemaTableInfo>;
  /** Session-only draft SQL per query Tab id (Story 3.6; never persisted). */
  queryDrafts: ReadonlyMap<number, string>;
  /** Update the draft SQL for query Tab `id`. */
  onQueryDraftChange: (id: number, sql: string) => void;
  onStop: () => void;
  stopping: boolean;
  connectionIndicator: React.ReactNode;
  exposure?: ExposureInfo;
  /** `[rail size, main size]`, read once as each Panel's `defaultSize` at mount. */
  panelSizes: ReadonlyArray<number>;
  /** Fired by `PanelGroup` on every layout change (drag or programmatic). */
  onLayout: (sizes: number[]) => void;
  /** Optimistically-created tables (Story 3.4), fed into the schema tree. */
  extraTables: ReadonlyArray<SchemaTableInfo>;
  /** Existing schema names for the create-table target selector (default + options). */
  schemas: ReadonlyArray<string>;
  /** Append a freshly-created table to the App-level list (tree + PK lookup). */
  onTableCreated: (table: SchemaTableInfo) => void;
}): React.JSX.Element {
  const activeTab =
    state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const activeTable =
    activeTab !== null && activeTab.kind === "table" ? (activeTab.table ?? null) : null;

  // Settings surface open/closed lives in React memory only — it is NOT part of
  // the persisted Workspace snapshot (out of scope for Story 2.5's Panel-sizes +
  // Tabs restore; see the spec's Block-If).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The create-table surface (Story 3.4) shares the main Panel with Settings and is
  // MUTUALLY EXCLUSIVE with it — opening one closes the other. Like Settings, it is
  // React-memory-only (not part of the persisted Workspace snapshot).
  const [createOpen, setCreateOpen] = useState(false);
  const toggleSettings = (): void => {
    setSettingsOpen((v) => !v);
    setCreateOpen(false);
  };
  const toggleCreate = (): void => {
    setCreateOpen((v) => !v);
    setSettingsOpen(false);
  };

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

      <PanelGroup direction="horizontal" className="flex-1" onLayout={onLayout}>
        <Panel defaultSize={panelSizes[0] ?? 20} minSize={12} maxSize={40} className="bg-card">
          {/* Left region: fixed launcher rail + the resizable schema tree. */}
          <div className="flex h-full">
            <div className="shrink-0" style={{ width: "52px" }}>
              <LauncherRail
                onOpen={onOpen}
                settingsOpen={settingsOpen}
                onToggleSettings={toggleSettings}
                createOpen={createOpen}
                onToggleCreate={toggleCreate}
              />
            </div>
            <div className="min-w-0 flex-1">
              <SchemaTree
                activeTable={activeTable}
                onActivate={onActivateTable}
                onSchemaLoaded={onSchemaLoaded}
                extraTables={extraTables}
              />
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-primary data-[resize-handle-state=drag]:bg-primary" />

        <Panel defaultSize={panelSizes[1] ?? 80} minSize={30}>
          {settingsOpen ? (
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          ) : createOpen ? (
            <CreateTablePanel
              schemas={schemas}
              onCreated={onTableCreated}
              onClose={() => setCreateOpen(false)}
            />
          ) : (
            <div className="flex h-full flex-col">
              <TabBar state={state} onActivate={onActivate} onClose={onClose} />
              <div className="min-h-0 flex-1 overflow-auto">
                <TabContent
                  tab={activeTab}
                  primaryKeys={primaryKeys}
                  indexes={indexes}
                  tables={allTables}
                  queryDraft={activeTab !== null ? (queryDrafts.get(activeTab.id) ?? "") : ""}
                  onQueryDraftChange={(sql) => {
                    if (activeTab !== null) onQueryDraftChange(activeTab.id, sql);
                  }}
                />
              </div>
            </div>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
