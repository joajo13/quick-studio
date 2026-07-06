/**
 * quick-studio UI (Ring 2) — Workspace state model.
 *
 * Dependency-free, pure Tab model for the Workspace shell. All Tab lifecycle
 * logic (open / close / activate) lives here as pure, total functions so it is
 * unit-testable with no DOM and no React harness (FR-23). React holds a single
 * {@link WorkspaceState} value and calls these helpers to derive the next one.
 *
 * Ephemeral: this module never persists anything. State lives in React memory
 * only and is gone at exit.
 *
 * Ids are a monotonically increasing counter carried in {@link WorkspaceState}
 * (`nextId`) rather than `Math.random`/`Date.now`, so every transition is
 * deterministic and tests are stable.
 */

/** The five kinds of document Tab the Workspace can hold. */
export type TabKind = "table" | "query" | "erd" | "chat" | "report";

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
export const TAB_KINDS: ReadonlyArray<TabKind> = ["table", "query", "erd", "chat", "report"];

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
