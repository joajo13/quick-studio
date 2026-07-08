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
  WORKSPACE_SNAPSHOT_VERSION,
  WORKSPACE_TAB_KINDS,
  type WorkspaceSnapshot,
  type WorkspaceTabKind,
} from "../../shared/contract.ts";

/**
 * The five kinds of document Tab the Workspace can hold. Alias of the shared
 * contract's {@link WorkspaceTabKind} — kept as `TabKind` so every existing UI
 * importer keeps working unchanged; `contract.ts` is the single source of truth.
 */
export type TabKind = WorkspaceTabKind;

/** A single open document Tab. Ids are unique within a {@link WorkspaceState}. */
export type WorkspaceTab = {
  readonly id: number;
  readonly kind: TabKind;
  /** Human label shown in the Tab strip (e.g. "table 1"). */
  readonly title: string;
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
};

/** All Tab kinds in launcher order — handy for the sidebar rail. */
export const TAB_KINDS: ReadonlyArray<TabKind> = WORKSPACE_TAB_KINDS;

/** An empty Workspace: no Tabs, nothing active, ids start at 1. */
export function emptyWorkspace(): WorkspaceState {
  return { tabs: [], activeTabId: null, nextId: 1 };
}

/**
 * Open a new Tab of `kind`. Appends a distinct Tab (multiple Tabs of one kind
 * may coexist) and makes it active. Pure — returns a new state.
 */
export function openTab(state: WorkspaceState, kind: TabKind): WorkspaceState {
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
 */
export function restoreWorkspace(snapshot: WorkspaceSnapshot): WorkspaceState {
  const tabs: WorkspaceTab[] = snapshot.tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title }));
  const maxId = tabs.reduce((max, t) => Math.max(max, t.id), 0);
  const nextId = Math.max(snapshot.nextId, maxId + 1);
  const activeTabId = tabs.some((t) => t.id === snapshot.activeTabId)
    ? snapshot.activeTabId
    : (tabs[0]?.id ?? null);
  return { tabs, activeTabId, nextId };
}

/**
 * Derive the wire {@link WorkspaceSnapshot} to persist via `workspace.save`.
 * Pure — `panelSizes` is supplied separately since it is React-held layout
 * state, not part of {@link WorkspaceState}.
 */
export function toWorkspaceSnapshot(
  state: WorkspaceState,
  panelSizes: ReadonlyArray<number>,
): WorkspaceSnapshot {
  return {
    version: WORKSPACE_SNAPSHOT_VERSION,
    panelSizes: [...panelSizes],
    tabs: state.tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title })),
    activeTabId: state.activeTabId,
    nextId: state.nextId,
  };
}
