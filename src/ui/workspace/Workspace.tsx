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
import type { ErdTabLayout, ExposureInfo, SchemaIndexInfo, SchemaTableInfo } from "../../shared/contract.ts";
import { CreateTablePanel } from "../schema/CreateTablePanel.tsx";
import { SchemaTree } from "../schema/SchemaTree.tsx";
import { SettingsPanel } from "../settings/SettingsPanel.tsx";
import type { ChatState } from "./chat-model.ts";
import type { ReportState, ReportStateUpdate } from "../report/report-state.ts";
import { TabBar } from "./TabBar.tsx";
import { TabContent } from "./TabContent.tsx";
import { TAB_KINDS, type TabKind, type WorkspaceState } from "./workspace-state.ts";

/** Launcher-rail tooltip/aria-label per kind — every rail button opens a NEW tab of
 * that kind, so the (now icon-only) button keeps its accurate "New …" wording as its
 * `title`/`aria-label` rather than a visible clipped label (Epic 7). */
const LAUNCH_LABEL: Readonly<Record<TabKind, string>> = {
  table: "New table",
  query: "New query",
  erd: "New ERD",
  chat: "New chat",
  report: "New report",
};

/** Per-kind rail icon (also reused by `TabBar`'s per-tab leading icon). */
const KIND_ICON: Readonly<Record<TabKind, React.JSX.Element>> = {
  table: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M3 14.5h18M9 9v11M15 9v11" />
    </svg>
  ),
  query: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <path d="M6 8l4 4-4 4M12.5 16H18" />
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
    </svg>
  ),
  erd: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <rect x="3" y="3" width="7" height="6" rx="1" />
      <rect x="14" y="15" width="7" height="6" rx="1" />
      <path d="M6.5 9v4a2 2 0 0 0 2 2h5.5" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <path d="M4 5h16v11H9l-4 3.5V16H4z" />
      <path d="M9 10.5h.01M12.5 10.5h.01M16 10.5h.01" />
    </svg>
  ),
  report: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  ),
};

/**
 * The launcher rail: a pure-black icon-only column (prototype `.rail`) — the brand
 * mark, an icon button per `TabKind` (tooltipped via `title`/`aria-label`, no clipped
 * text), and a bottom-pinned create-table + Settings toggle. (The authoritative,
 * text-bearing connection status lives in the status bar, not on the rail.) The
 * Settings control opens the Settings surface that hosts Connections
 * management (Story 2.4); create-table opens the `CreateTablePanel` (Story 3.4). Both
 * toggles keep their exact `data-testid`/`aria-pressed` contract.
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
    <nav aria-label="Open a new tab" className="flex h-full flex-col items-center gap-0.5 bg-background py-2.5">
      <div
        role="img"
        aria-label="quick-studio"
        title="quick-studio"
        className="mb-3 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-foreground font-mono text-[15px] font-bold text-background"
      >
        q
      </div>

      {TAB_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          title={LAUNCH_LABEL[kind]}
          aria-label={LAUNCH_LABEL[kind]}
          onClick={() => onOpen(kind)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span aria-hidden className="h-[18px] w-[18px]">
            {KIND_ICON[kind]}
          </span>
        </button>
      ))}

      <div className="flex-1" />

      {/* Create-table control (Story 3.4): a rail toggle mirroring Settings, pinned
          just above it. Opens the CreateTablePanel. */}
      <button
        type="button"
        aria-label="Create table"
        aria-pressed={createOpen}
        data-testid="create-table-toggle"
        title="Create table"
        onClick={onToggleCreate}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-foreground ${
          createOpen ? "bg-accent text-foreground" : "text-muted-foreground"
        }`}
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-[18px] w-[18px]">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>

      {/* Bottom-pinned Settings control. */}
      <button
        type="button"
        aria-label="Settings"
        aria-pressed={settingsOpen}
        data-testid="settings-toggle"
        title="Settings"
        onClick={onToggleSettings}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-foreground ${
          settingsOpen ? "bg-accent text-foreground" : "text-muted-foreground"
        }`}
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} className="h-[18px] w-[18px]">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
        </svg>
      </button>
    </nav>
  );
}

/**
 * Prominent, unmistakable full-width Port-Exposure Warning (FR-22, UX-DR5).
 * Rendered at the very top of the shell (above the rail/tab/panel chrome) only
 * when the Core bound a non-loopback address. States the risk and the exact
 * steps to revert to localhost-only.
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
  chatStates,
  onChatStateChange,
  reportStates,
  onReportStateChange,
  erdLayouts,
  onErdLayoutChange,
  onStop,
  stopping,
  connectionIndicator,
  saveIndicator,
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
  /** Session-only chat state per chat Tab id (Story 5.2; never persisted). */
  chatStates: ReadonlyMap<number, ChatState>;
  /** Update the chat state for chat Tab `id`. */
  onChatStateChange: (id: number, next: ChatState) => void;
  /** Session-only report state per report Tab id (Story 6.1; never persisted). */
  reportStates: ReadonlyMap<number, ReportState>;
  /** Update the report state for report Tab `id`. */
  onReportStateChange: (id: number, next: ReportStateUpdate) => void;
  /** Persisted ERD layouts keyed by stringified tab id (Story 4.2). */
  erdLayouts: Readonly<Record<string, ErdTabLayout>>;
  /** Report an ERD tab's captured geometry up for the debounced persist. */
  onErdLayoutChange: (tabId: number, layout: ErdTabLayout) => void;
  onStop: () => void;
  stopping: boolean;
  connectionIndicator: React.ReactNode;
  /** Terse status-bar save-failure indicator (DW-22), shown only when a save failed. */
  saveIndicator?: React.ReactNode;
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
      {exposure?.exposed ? <ExposureBanner exposure={exposure} /> : null}

      <PanelGroup direction="horizontal" className="flex-1" onLayout={onLayout}>
        <Panel defaultSize={panelSizes[0] ?? 20} minSize={12} maxSize={40} className="bg-background">
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
          {/* Chrome-style shell: a transparent .topbar hosting the Tab strip + new-tab
              "+" (hidden while Settings/Create fill the pane, exactly as the Tab strip
              itself did before), and a rounded, detached `.content-panel` below it that
              always hosts the neutral status bar (connection + Stop stay reachable no
              matter which of the three panes — Tabs, Settings, or Create — is showing). */}
          <div className="flex h-full flex-col bg-background">
            {!settingsOpen && !createOpen ? (
              <div className="flex shrink-0 items-end gap-0.5 pt-[5px] pr-2 pb-0 pl-1.5">
                <div className="min-w-0 flex-1 self-end">
                  <TabBar state={state} onActivate={onActivate} onClose={onClose} />
                </div>
                <button
                  type="button"
                  title="New tab"
                  aria-label="New tab"
                  onClick={() => onOpen(activeTab?.kind ?? TAB_KINDS[0]!)}
                  className="mx-[2px] grid h-9 w-[34px] shrink-0 place-items-center self-end rounded-[10px] p-0 text-[19px] font-normal leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  +
                </button>
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-xl bg-card">
              <div className="min-h-0 flex-1 overflow-auto">
                {settingsOpen ? (
                  <SettingsPanel onClose={() => setSettingsOpen(false)} />
                ) : createOpen ? (
                  <CreateTablePanel
                    schemas={schemas}
                    onCreated={onTableCreated}
                    onClose={() => setCreateOpen(false)}
                  />
                ) : (
                  <TabContent
                    tab={activeTab}
                    primaryKeys={primaryKeys}
                    indexes={indexes}
                    tables={allTables}
                    queryDraft={activeTab !== null ? (queryDrafts.get(activeTab.id) ?? "") : ""}
                    onQueryDraftChange={(sql) => {
                      if (activeTab !== null) onQueryDraftChange(activeTab.id, sql);
                    }}
                    chatState={activeTab !== null ? chatStates.get(activeTab.id) : undefined}
                    onChatStateChange={(next) => {
                      if (activeTab !== null) onChatStateChange(activeTab.id, next);
                    }}
                    reportState={activeTab !== null ? reportStates.get(activeTab.id) : undefined}
                    onReportStateChange={(next) => {
                      if (activeTab !== null) onReportStateChange(activeTab.id, next);
                    }}
                    erdLayout={activeTab !== null ? erdLayouts[String(activeTab.id)] : undefined}
                    onErdLayoutChange={onErdLayoutChange}
                  />
                )}
              </div>

              {/* Neutral status bar (prototype `.statusbar`): the proven connection
                  indicator + Stop control, always reachable regardless of which pane
                  (Tabs/Settings/Create) is active. */}
              <div className="flex shrink-0 items-center gap-3 border-t border-border px-3.5 py-1.5">
                {connectionIndicator}
                {saveIndicator}
                <button
                  type="button"
                  onClick={onStop}
                  disabled={stopping}
                  className="ml-auto rounded-md px-2.5 py-1 font-mono text-[11px] text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  {stopping ? "Stopping…" : "Stop"}
                </button>
              </div>
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
