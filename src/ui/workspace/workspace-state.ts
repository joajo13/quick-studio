/**
 * quick-studio UI (Ring 2) — Workspace state model.
 *
 * Dependency-free, pure Tab model for the Workspace shell. All Tab lifecycle
 * logic (open / close / activate) lives here as pure, total functions so it is
 * unit-testable with no DOM and no React harness (FR-23). React holds a single
 * {@link WorkspaceState} value and calls these helpers to derive the next one.
 *
 * This module itself still never persists anything — it stays a pure, DOM-free
 * model. Persistence lives ONLY in Core (Story 2.5, `src/core/workspace-*.ts`);
 * this module is the SERIALIZATION BRIDGE between the wire `WorkspaceSnapshot`
 * and this reducer state: {@link restoreWorkspace} turns a loaded snapshot into
 * a `WorkspaceState` (recomputing `nextId`/`activeTabId` defensively, since a
 * snapshot may be stale or partially invalid even after Core's own validation),
 * and {@link toWorkspaceSnapshot} is its inverse for `workspace.save`.
 *
 * Ids are a monotonically increasing counter carried in {@link WorkspaceState}
 * (`nextId`) rather than `Math.random`/`Date.now`, so every transition is
 * deterministic and tests are stable.
 */

import {
  PROVIDER_KINDS,
  WORKSPACE_SNAPSHOT_VERSION,
  WORKSPACE_TAB_KINDS,
  type ErdTabLayout,
  type ProviderKind,
  type WorkspaceSnapshot,
  type WorkspaceTabKind,
} from "../../shared/contract.ts";

/**
 * The kinds of Tab the Workspace can hold — the five document kinds plus the
 * `settings` system singleton (Story 8.6). Alias of the shared contract's
 * {@link WorkspaceTabKind} — kept as `TabKind` so every existing UI importer keeps
 * working unchanged; `contract.ts` is the single source of truth.
 */
export type TabKind = WorkspaceTabKind;

/**
 * A reference to a live table bound to a `table` Tab (Story 3.2). It carries ONLY
 * the schema-qualified name needed to (re)request `table.rows`; it is deliberately
 * NOT part of the persisted snapshot (the open-table binding does not survive an app
 * restart — see the story's Block-If), so `toWorkspaceSnapshot` drops it.
 */
export type TableRef = {
  readonly schema: string;
  readonly name: string;
};

/** A single open document Tab. Ids are unique within a {@link WorkspaceState}. */
export type WorkspaceTab = {
  readonly id: number;
  readonly kind: TabKind;
  /** Human label shown in the Tab strip (e.g. "table 1"). */
  readonly title: string;
  /**
   * For a `table` Tab: the bound live table, or absent when the Tab is unbound
   * (a fresh "New table" or a restored table Tab) — the UI shows a "select a
   * table" empty state until a tree table is activated into it.
   */
  readonly table?: TableRef;
};

/** The complete in-memory Workspace Tab state. Immutable — helpers return new values. */
export type WorkspaceState = {
  readonly tabs: ReadonlyArray<WorkspaceTab>;
  /** Id of the active Tab, or `null` when no Tab is open. */
  readonly activeTabId: number | null;
  /** Next id to assign. Monotonic; never reused, even after closes. */
  readonly nextId: number;
};

/** Human-readable label for a Tab kind (used to build Tab titles). */
const KIND_LABEL: Readonly<Record<TabKind, string>> = {
  table: "Table",
  query: "Query",
  erd: "ERD",
  chat: "Chat",
  report: "Report",
  settings: "Settings",
};

/** All Tab kinds (includes the `settings` system singleton) — the widened contract enum. */
export const TAB_KINDS: ReadonlyArray<TabKind> = WORKSPACE_TAB_KINDS;

/**
 * The FIVE document kinds only, in launcher order — the sidebar rail iterates THIS
 * subset so `settings` never gains a per-kind launcher button (it stays the separate
 * bottom-pinned rail toggle). `settings` is a system singleton tab, not a document kind.
 */
export const LAUNCHER_KINDS: ReadonlyArray<TabKind> = TAB_KINDS.filter((k) => k !== "settings");

/** An empty Workspace: no Tabs, nothing active, ids start at 1. */
export function emptyWorkspace(): WorkspaceState {
  return { tabs: [], activeTabId: null, nextId: 1 };
}

/**
 * Open a new Tab of `kind`. Appends a distinct Tab (multiple Tabs of one kind
 * may coexist) and makes it active. Pure — returns a new state.
 */
export function openTab(state: WorkspaceState, kind: TabKind): WorkspaceState {
  // Settings is a SINGLETON — route it through the sole open-or-focus seam even if a
  // caller reaches openTab with it (the widened enum now type-accepts "settings"), so
  // no path can mint a duplicate "Settings 2" tab that bypasses the singleton guard.
  if (kind === "settings") return openOrFocusSettings(state);
  const id = state.nextId;
  // Suffix the title with the tab's unique, monotonic id (never reused) so two
  // coexisting tabs of the same kind can never share a title — even after an
  // earlier same-kind tab is closed and a new one opened.
  const tab: WorkspaceTab = { id, kind, title: `${KIND_LABEL[kind]} ${id}` };
  return {
    tabs: [...state.tabs, tab],
    activeTabId: id,
    nextId: id + 1,
  };
}

/**
 * Close the Tab with `id`. Never mutates any other Tab (FR-23): the remaining
 * Tabs keep their identity and order. Closing an unknown id returns the state
 * unchanged. When the active Tab is closed, the active Tab becomes the nearest
 * remaining sibling: the Tab at the same index if one remains there, else the
 * new last Tab, else `null`. Pure — returns a new state.
 */
export function closeTab(state: WorkspaceState, id: number): WorkspaceState {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index === -1) {
    // Unknown id — no-op.
    return state;
  }

  const tabs = state.tabs.filter((t) => t.id !== id);

  // Closing a non-active Tab leaves the active selection untouched.
  if (state.activeTabId !== id) {
    return { ...state, tabs };
  }

  // Closing the active Tab: pick the nearest remaining sibling.
  let activeTabId: number | null;
  if (tabs.length === 0) {
    activeTabId = null;
  } else {
    // Same index if it still exists, else the new last Tab.
    const nearest = tabs[index] ?? tabs[tabs.length - 1];
    activeTabId = nearest?.id ?? null;
  }

  return { ...state, tabs, activeTabId };
}

/**
 * Activate the Tab with `id`. If `id` is not an open Tab, the state is returned
 * unchanged. Pure — returns a new state.
 */
export function activateTab(state: WorkspaceState, id: number): WorkspaceState {
  if (!state.tabs.some((t) => t.id === id)) {
    return state;
  }
  if (state.activeTabId === id) {
    return state;
  }
  return { ...state, activeTabId: id };
}

/**
 * Open the Settings tab, or FOCUS it if one is already open (Story 8.6). Settings is
 * a SINGLETON — you can't configure two in parallel — so this is the SOLE open seam:
 * if a `settings` tab exists it delegates to {@link activateTab} (a no-op when it is
 * already active), else it appends exactly one `settings` tab (title `"Settings"`, no
 * numeric suffix — unlike {@link openTab}) and makes it active. Pure — returns a new state.
 */
export function openOrFocusSettings(state: WorkspaceState): WorkspaceState {
  const existing = state.tabs.find((t) => t.kind === "settings");
  if (existing) return activateTab(state, existing.id);
  const id = state.nextId;
  const tab: WorkspaceTab = { id, kind: "settings", title: "Settings" };
  return { ...state, tabs: [...state.tabs, tab], activeTabId: id, nextId: id + 1 };
}

/**
 * Bind a live table to the active data Tab (Story 3.2). If the active Tab is a
 * `table` Tab, it is REUSED — rebound to `ref` and renamed to the table name (so
 * clicking table after table in the tree reuses one grid Tab). Otherwise a new,
 * active `table` Tab is opened for it. The Tab title is the table name verbatim
 * (AR-19 — never re-cased). Pure — returns a new state.
 */
export function bindTableToActiveTab(state: WorkspaceState, ref: TableRef): WorkspaceState {
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const title = ref.name;
  if (active !== null && active.kind === "table") {
    const tabs = state.tabs.map((t) =>
      t.id === active.id ? { ...t, table: ref, title } : t,
    );
    return { ...state, tabs };
  }
  const id = state.nextId;
  const tab: WorkspaceTab = { id, kind: "table", title, table: ref };
  return {
    tabs: [...state.tabs, tab],
    activeTabId: id,
    nextId: id + 1,
  };
}

/* ------------------------------------------------------------------ *
 * Snapshot bridge (Story 2.5) — wire WorkspaceSnapshot <-> WorkspaceState
 * ------------------------------------------------------------------ */

/**
 * Rebuild a {@link WorkspaceState} from a loaded {@link WorkspaceSnapshot}. Pure
 * and total, and defensive even though Core already validated the snapshot on
 * the way in: `nextId` is recomputed as `max(tab ids) + 1` whenever the stored
 * value doesn't already clear that bar (so a future `openTab` can never mint a
 * colliding id), and a dangling `activeTabId` (not among the restored tabs)
 * falls back to the first tab, or `null` when there are no tabs at all.
 *
 * Duplicate-id defense (DW-26): a hand-edited on-disk snapshot can slip two tabs
 * sharing an id past the load shape-guard (intentionally looser than `checkTabs`,
 * which REJECTS duplicates outright, so a bad file still opens). Here we tolerate
 * it by keeping ONLY the FIRST occurrence per id — otherwise a later `closeTab`
 * would filter out and remove BOTH tabs at once. The `maxId`/`nextId`/`activeTabId`
 * logic below is unchanged and simply operates on the deduped set.
 */
export function restoreWorkspace(snapshot: WorkspaceSnapshot): WorkspaceState {
  const seenIds = new Set<number>();
  const deduped: WorkspaceTab[] = [];
  for (const t of snapshot.tabs) {
    if (seenIds.has(t.id)) continue; // keep the first tab per id; drop later dupes
    seenIds.add(t.id);
    deduped.push({ id: t.id, kind: t.kind, title: t.title });
  }
  // Settings-singleton defense (Story 8.6): a hand-edited/legacy snapshot could carry
  // two `settings` tabs with DISTINCT ids (which the id-dedupe above keeps). Settings is
  // a singleton, so collapse to the FIRST `kind:"settings"` tab and drop any later ones —
  // a second, independent guard alongside `openOrFocusSettings`'s open seam. `activeTabId`
  // is recomputed below and defensively falls back if it pointed at a dropped tab.
  let seenSettings = false;
  const tabs: WorkspaceTab[] = [];
  for (const t of deduped) {
    if (t.kind === "settings") {
      if (seenSettings) continue; // drop extra settings tabs
      seenSettings = true;
    }
    tabs.push(t);
  }
  const maxId = tabs.reduce((max, t) => Math.max(max, t.id), 0);
  const nextId = Math.max(snapshot.nextId, maxId + 1);
  const activeTabId = tabs.some((t) => t.id === snapshot.activeTabId)
    ? snapshot.activeTabId
    : (tabs[0]?.id ?? null);
  return { tabs, activeTabId, nextId };
}

/**
 * Prune an `erdLayouts` map (Story 4.2) to only the tab ids present in `tabs` —
 * defensive on BOTH persistence directions so a layout for a closed/absent tab never
 * lingers on disk or after a restore. Layout keys are stringified tab ids. Pure.
 */
function pruneErdLayouts(
  erdLayouts: Readonly<Record<string, ErdTabLayout>>,
  tabs: ReadonlyArray<{ readonly id: number }>,
): Record<string, ErdTabLayout> {
  const ids = new Set(tabs.map((t) => String(t.id)));
  const out: Record<string, ErdTabLayout> = {};
  for (const [tabKey, layout] of Object.entries(erdLayouts)) {
    if (ids.has(tabKey)) out[tabKey] = layout;
  }
  return out;
}

/**
 * Seed the App-held `erdLayouts` from a loaded {@link WorkspaceSnapshot} (Story 4.2),
 * dropping any layout whose tab id is not among `tabs` (the restored tab set) — the
 * restore-side twin of {@link toWorkspaceSnapshot}'s pruning. Pure and total: a snapshot
 * with no `erdLayouts` (a pre-4.2 file) yields `{}` so the ERD falls back to dagre. Like
 * `panelSizes`, ERD geometry is React-held App state rather than part of the pure
 * {@link WorkspaceState}, so it is threaded through this sibling helper.
 */
export function restoreErdLayouts(
  snapshot: WorkspaceSnapshot,
  tabs: ReadonlyArray<{ readonly id: number }>,
): Record<string, ErdTabLayout> {
  return snapshot.erdLayouts ? pruneErdLayouts(snapshot.erdLayouts, tabs) : {};
}

/**
 * Seed the App-held `lastProvider` default hint from a loaded {@link WorkspaceSnapshot}
 * (Story 8.5) — the restore-side twin of {@link restoreErdLayouts}. Returns the stored
 * `lastProvider` ONLY when it is a recognized {@link ProviderKind}, else `null` — defensive
 * against a hand-edited/unknown value, so a single bad field never blocks the default (the
 * picker simply falls back to single/first-connected). A pre-8.5 file (no `lastProvider`)
 * yields `null`. Pure and total.
 */
export function restoreLastProvider(snapshot: WorkspaceSnapshot): ProviderKind | null {
  const value = snapshot.lastProvider;
  return value !== undefined && (PROVIDER_KINDS as readonly string[]).includes(value) ? value : null;
}

/**
 * Derive the wire {@link WorkspaceSnapshot} to persist via `workspace.save`.
 * Pure — `panelSizes`, `erdLayouts`, and `lastProvider` are supplied separately since they
 * are React-held state, not part of {@link WorkspaceState}. `erdLayouts` (Story 4.2) is
 * pruned to the current tab set and only carried when non-empty; `lastProvider` (Story 8.5)
 * is only carried when it is a non-null {@link ProviderKind}. So a workspace with no ERD
 * geometry and no picked provider serializes byte-identically to a pre-4.2/pre-8.5 snapshot
 * (preserving the untouched-workspace no-resave invariant).
 */
export function toWorkspaceSnapshot(
  state: WorkspaceState,
  panelSizes: ReadonlyArray<number>,
  erdLayouts?: Readonly<Record<string, ErdTabLayout>>,
  lastProvider?: ProviderKind | null,
): WorkspaceSnapshot {
  const base: WorkspaceSnapshot = {
    version: WORKSPACE_SNAPSHOT_VERSION,
    panelSizes: [...panelSizes],
    tabs: state.tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title })),
    activeTabId: state.activeTabId,
    nextId: state.nextId,
  };
  const pruned = erdLayouts ? pruneErdLayouts(erdLayouts, state.tabs) : {};
  const withErd = Object.keys(pruned).length > 0 ? { ...base, erdLayouts: pruned } : base;
  // Only attach `lastProvider` when a provider is actually set, so an untouched workspace
  // stays byte-identical to today's snapshot (the no-resave invariant).
  return lastProvider != null ? { ...withErd, lastProvider } : withErd;
}
