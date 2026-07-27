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
 * The kinds of Tab the Workspace can hold — the five document kinds, the `settings`
 * system singleton (Story 8.6), plus the UI-only `create-table` singleton (Story 9.4).
 * A SUPERSET of the shared contract's {@link WorkspaceTabKind}: `create-table` is a
 * transient, React-memory-only authoring surface that must NEVER persist, so it stays
 * OUT of the persisted `WORKSPACE_TAB_KINDS` enum and lives only here in the UI. The
 * persisted `WorkspaceSnapshotTab.kind` stays `WorkspaceTabKind`, so tsc PROVES a
 * `create-table` tab can never reach disk (see {@link toWorkspaceSnapshot}'s filter).
 */
export type TabKind = WorkspaceTabKind | "create-table";

/**
 * A reference to a live table bound to a `table` Tab (Story 3.2). It carries ONLY
 * the schema-qualified name needed to (re)request `table.rows`; it is deliberately
 * NOT part of the persisted snapshot (the open-table binding does not survive an app
 * restart — see the story's Block-If), so `toWorkspaceSnapshot` drops it.
 */
export type TableRef = {
  readonly schema: string;
  readonly name: string;
  /**
   * The connection the table was activated FROM (Story 10.5): a saved connection's id,
   * or `null`/absent for the boot target (the default). Every Core call the bound tab
   * makes — `table.rows`, `execute` for cell edits and row DML, and the PK/index lookup
   * that feeds them — carries it, so the rows come from the database the user actually
   * clicked in and a write can never land in a different one. Still SESSION-ONLY as a
   * REF field: `toWorkspaceSnapshot` maps tabs field-by-field and never emits `table`,
   * so the whole ref (this id included) dies with the session. What DOES survive a
   * restart since Story 10.6 is the tab-level mirror {@link WorkspaceTab.connectionId},
   * which {@link bindTableToActiveTab} keeps in lockstep with this value.
   */
  readonly connectionId?: string | null;
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
  /**
   * Which connection this Tab targets (Story 10.6) — INDEPENDENT of {@link table}, and
   * the ONE connection fact that survives a restart. It exists precisely BECAUSE `table`
   * still does not persist (Story 3.2 stands: the schema/name binding is session-only),
   * so a restored table Tab can remember which database it was browsing even though it
   * has forgotten which table. {@link bindTableToActiveTab} mirrors `ref.connectionId`
   * here on every bind so the live and persisted values can never disagree.
   *
   * `undefined` and `null` mean the SAME thing everywhere — the boot/default target —
   * mirroring `ExecuteRequest.connectionId`'s convention; `undefined` is what a pre-10.6
   * snapshot (and any never-bound tab) restores as, `null` is what an explicit boot-root
   * bind writes. Only the OPAQUE id is ever held here (AR-12) — never a url or credential.
   * Reachability is NOT decided here: this module is pure and has no RPC, so the live-set
   * comparison is {@link isTabConnectionMissing}, fed by the render layer.
   */
  readonly connectionId?: string | null;
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
  "create-table": "New Table",
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
  // Create-table is likewise a SINGLETON (Story 9.4) — route it through its sole
  // open-or-focus seam even if a caller reaches openTab with it (the widened UI enum
  // now type-accepts "create-table"), so no path can mint a duplicate "New Table 2".
  if (kind === "create-table") return openOrFocusCreateTable(state);
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
 * The first-run onboarding routing decision (Story 11.7). `base` is whatever the
 * caller has already decided the launch state is (a restored snapshot, or
 * {@link emptyWorkspace} on a fresh launch) — this function does not know or care
 * which. When `firstRun` is true it routes onto Settings -> connections via
 * {@link openOrFocusSettings}, which is what makes this safe to call
 * unconditionally: the singleton guard means a restored state that ALREADY holds
 * a Settings Tab is focused, never duplicated, and a restored state with other
 * Tabs open keeps every one of them — onboarding only ever ADDS or FOCUSES the
 * one system Tab, never drops data. When `firstRun` is false, `base` is returned
 * BY REFERENCE (not a shallow copy) — callers that diff against object identity
 * (e.g. an autosave-baseline seed) must see a true no-op, not a same-shaped clone.
 * Pure — returns a new state (or the same reference) and never mutates `base`.
 */
export function initialWorkspace(base: WorkspaceState, firstRun: boolean): WorkspaceState {
  return firstRun ? openOrFocusSettings(base) : base;
}

/**
 * Whether a launch should route onto onboarding (Story 11.7) — the `firstRun`
 * boot signal AND nothing to restore. Extracted here, rather than written inline
 * at the one call site in `App.tsx`, because `App.tsx` has no test harness (no
 * jsdom, by repo convention): an inline predicate could be inverted, or lose the
 * `firstRun` conjunct, without a single test going red — and the failure mode is
 * every returning user's `activeTabId` being hijacked on every boot.
 *
 * `snapshot` is the reply from `workspace.load`. The absence check is deliberately
 * LOOSE (`== null`), so a reply that ever carries `undefined` — an optional field,
 * a normalizer that drops null keys — is read as "nothing to restore" and still
 * onboards. The strict form would answer `false` there while the caller's own
 * truthiness check answered "empty workspace", which is exactly the empty-tree
 * outcome this story exists to eliminate.
 *
 * Requiring "nothing to restore" is what keeps the coarse, once-per-PROCESS boot
 * flag from becoming a nuisance: a snapshot that restored Tabs means the user has
 * somewhere to be, and a snapshot holding ZERO Tabs means they explicitly closed
 * everything — including, possibly, a Settings Tab this very routing opened for
 * them. Re-opening it on the next launch would silently undo that.
 */
export function shouldRouteToOnboarding(
  firstRun: boolean,
  snapshot: WorkspaceSnapshot | null | undefined,
): boolean {
  return firstRun && snapshot == null;
}

/**
 * Open the create-table tab, or FOCUS it if one is already open (Story 9.4). Create-table
 * is a SINGLETON — you author one new table at a time — so this is the SOLE open seam:
 * if a `create-table` tab exists it delegates to {@link activateTab} (a no-op when it is
 * already active), else it appends exactly one `create-table` tab (title `"New Table"`,
 * no numeric suffix — unlike {@link openTab}) and makes it active. Mirrors
 * {@link openOrFocusSettings}. Pure — returns a new state.
 *
 * NOTE on the draft's lifetime: the create-table draft lives in `CreateTablePanel`'s
 * local state (preserved VERBATIM per the Story 9.4 relocation constraint — it is NOT
 * lifted to App-held per-tab state the way query/chat/report drafts are). `TabContent`
 * mounts only the active tab body, so the draft survives a re-click that is a no-op on
 * the already-active tab, but a switch to another tab and back remounts the panel fresh
 * (draft discarded). Lifting it is deferred — see deferred-work.md.
 */
export function openOrFocusCreateTable(state: WorkspaceState): WorkspaceState {
  const existing = state.tabs.find((t) => t.kind === "create-table");
  if (existing) return activateTab(state, existing.id);
  const id = state.nextId;
  const tab: WorkspaceTab = { id, kind: "create-table", title: "New Table" };
  return { ...state, tabs: [...state.tabs, tab], activeTabId: id, nextId: id + 1 };
}

/**
 * The ONE blank-id predicate for {@link WorkspaceTab.connectionId} (Story 10.6), applied at
 * every seam that writes the field — {@link bindTableToActiveTab} (the primary writer, fed by
 * the tree), {@link setTabConnection} (the reassign seam) and {@link restoreWorkspace}'s
 * on-read sanitize — so "blank" cannot mean one thing in one place and another somewhere else.
 *
 * A blank id is normalised to `null` (the boot/default target) rather than kept, because
 * `ConnectionSummary.id` is only `typeof`-checked where it enters the UI: a hand-edited
 * registry can yield `id: ""` or `id: "   "`, and Core's save boundary (`checkTabs` in
 * `workspace-registry.ts`) rejects a PRESENT-but-blank `connectionId` outright. Letting one
 * through would poison EVERY subsequent `workspace.save` with `bad_request` for the rest of
 * the session, silently — a failed autosave has no UI surface. `null` is the one value that is
 * always accepted and always means the same thing everywhere.
 */
function normalizeConnectionId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  return raw.trim().length === 0 ? null : raw;
}

/**
 * Bind a live table to the active data Tab (Story 3.2). If the active Tab is a
 * `table` Tab, it is REUSED — rebound to `ref` and renamed to the table name (so
 * clicking table after table in the tree reuses one grid Tab). Otherwise a new,
 * active `table` Tab is opened for it. The Tab title is the table name verbatim
 * (AR-19 — never re-cased). Pure — returns a new state.
 *
 * Story 10.6: the tab-level {@link WorkspaceTab.connectionId} is mirrored from
 * `ref.connectionId` in BOTH branches (an absent ref id is the boot target, the same thing
 * `null` means), so the persisted value can never drift from the live binding. Writing it on
 * the REBIND branch too is what stops a tab that used to point at `conn-2` from persisting
 * `conn-2` after being rebound to a boot table. This is the PRIMARY writer of the field — the
 * one a user hits by clicking a table in the tree — so it runs the same
 * {@link normalizeConnectionId} guard as the reassign seam.
 */
export function bindTableToActiveTab(state: WorkspaceState, ref: TableRef): WorkspaceState {
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const title = ref.name;
  const connectionId = normalizeConnectionId(ref.connectionId);
  if (active !== null && active.kind === "table") {
    const tabs = state.tabs.map((t) =>
      t.id === active.id ? { ...t, table: ref, title, connectionId } : t,
    );
    return { ...state, tabs };
  }
  const id = state.nextId;
  const tab: WorkspaceTab = { id, kind: "table", title, table: ref, connectionId };
  return {
    tabs: [...state.tabs, tab],
    activeTabId: id,
    nextId: id + 1,
  };
}

/**
 * Point Tab `tabId` at `connectionId` (Story 10.6) — the "Reasignar conexión…" seam for a
 * Tab whose saved connection was removed while the workspace was closed.
 *
 * The stale {@link WorkspaceTab.table} binding is CLEARED, never carried over: it named a
 * `schema.name` inside a DIFFERENT database, and a same-named table in the newly chosen one
 * is not the same table — reusing it would silently browse (and, with a PK in hand, write
 * to) rows the user never asked for. Dropping it returns the Tab to its ordinary unbound
 * "select a table" state, which is exactly where a restored Tab already lives (Story 3.2).
 *
 * Total: an unknown `tabId` returns the SAME state reference (so a React `useReducer` bails
 * out of the re-render, like {@link closeTab}/{@link activateTab} on a no-op). Every sibling
 * Tab keeps its object identity. Pure — never throws.
 */
export function setTabConnection(
  state: WorkspaceState,
  tabId: number,
  connectionId: string | null,
): WorkspaceState {
  if (!state.tabs.some((t) => t.id === tabId)) return state;
  // Same blank-id rule as every other writer of the field — see `normalizeConnectionId`.
  const normalized = normalizeConnectionId(connectionId);
  const tabs = state.tabs.map((t) => {
    if (t.id !== tabId) return t;
    // Rebuild WITHOUT `table` rather than setting it to `undefined`, so the tab object
    // stays key-for-key what a freshly-restored (unbound) tab looks like.
    const { table: _dropped, ...rest } = t;
    return { ...rest, connectionId: normalized };
  });
  return { ...state, tabs };
}

/**
 * Whether `tab` points at a connection that is no longer in the live saved-connection set
 * (Story 10.6). The live ids arrive as a PLAIN `ReadonlySet` parameter — this module owns
 * the decision but must never own the `connections.list` RPC that produces it (it is pure,
 * DOM-free and dependency-free), which is also what makes the rule unit-testable at all.
 *
 * Three deliberate rules:
 *  - `liveIds === null` ⇒ `false`. The set is NOT KNOWN yet (fetch in flight, or it failed).
 *    A registry read that never answered must never accuse a tab of pointing at nothing —
 *    the tab renders its normal body until the truth is actually in hand.
 *  - `tab.connectionId == null` ⇒ `false` (covers `null` AND `undefined`, i.e. an explicit
 *    boot bind and a pre-10.6/never-bound tab alike). The boot target is not a saved
 *    connection, so it is never in `connections.list` and can never be "missing".
 *  - otherwise the id must be present in the live set.
 */
export function isTabConnectionMissing(
  tab: WorkspaceTab,
  liveIds: ReadonlySet<string> | null,
): boolean {
  if (liveIds === null) return false;
  if (tab.connectionId == null) return false;
  return !liveIds.has(tab.connectionId);
}

/* ------------------------------------------------------------------ *
 * Snapshot bridge (Story 2.5) — wire WorkspaceSnapshot <-> WorkspaceState
 * ------------------------------------------------------------------ */

/**
 * Sanitize a loaded `panelSizes` array into a guaranteed-valid split for the
 * current panel count (DW-23). The store/registry keep `panelSizes` length- and
 * range-agnostic (any finite-number array), so a hand-edited/legacy file can carry
 * a wrong-length or out-of-range split that would break `react-resizable-panels`'
 * initial layout. This UI-side guard collapses any such value to `defaults`:
 *
 *  - a length that doesn't match `defaults` (wrong panel count, or empty) → `defaults`;
 *  - otherwise each entry is clamped to `[0,100]` (a non-finite entry → `defaults`);
 *  - if the clamped values don't sum to ~100 (tolerance 0.5) → `defaults`, since a
 *    non-100 split is what actually triggers the "Invalid layout" break;
 *  - else the clamped values are used (`[-5,105]` → `[0,100]`, which sums to 100).
 *
 * Pure and total — never throws, always returns a fresh array.
 */
export function sanitizePanelSizes(
  loaded: readonly number[],
  defaults: readonly number[],
): number[] {
  if (loaded.length !== defaults.length) return [...defaults];
  const clamped: number[] = [];
  for (const n of loaded) {
    if (!Number.isFinite(n)) return [...defaults];
    clamped.push(Math.max(0, Math.min(100, n)));
  }
  const sum = clamped.reduce((acc, n) => acc + n, 0);
  if (Math.abs(sum - 100) > 0.5) return [...defaults];
  return clamped;
}

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
 *
 * Story 10.6: a tab's persisted `connectionId` is carried across here — and SANITIZED on
 * the way in, because the store deliberately does NOT gate the field (gating it there is
 * all-or-nothing over `tabs`, so one hand-edited value would nuke the entire workspace;
 * see `workspace-store.ts`'s note). Only a NON-EMPTY STRING survives; anything else
 * (absent, `null`, `42`, `{}`) omits the key entirely rather than writing `null`, so a
 * restored tab is key-for-key what a pre-10.6 tab restored as. `table` still stays
 * `undefined` for every restored tab — this story persists the connection, never the
 * schema/name binding (Story 3.2 stands).
 */
export function restoreWorkspace(snapshot: WorkspaceSnapshot): WorkspaceState {
  const seenIds = new Set<number>();
  const deduped: WorkspaceTab[] = [];
  for (const t of snapshot.tabs) {
    if (seenIds.has(t.id)) continue; // keep the first tab per id; drop later dupes
    seenIds.add(t.id);
    // Same blank-id rule as the two in-memory writers (`normalizeConnectionId`), except a
    // blank/absent/wrong-typed value OMITS the key rather than writing `null` — so a
    // restored tab is key-for-key what a never-bound tab looks like.
    const connectionId = normalizeConnectionId(t.connectionId);
    deduped.push({
      id: t.id,
      kind: t.kind,
      title: t.title,
      ...(connectionId !== null ? { connectionId } : {}),
    });
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

/** A finite number (rejects NaN/±Infinity, strings, and everything else off-disk). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Sanitize ONE persisted ERD layout read off disk (Story 4.2). `erdLayouts` is a FIELD-DROP
 * field — the Core's load guard deliberately does not gate it, because that boundary is
 * all-or-nothing and one bad coordinate must never discard the whole workspace — so the
 * per-entry rescue lives here, exactly like `restoreLastProvider`'s unknown → null.
 *
 * Returns `undefined` when the entry is unusable as a whole (not an object, or no `positions`
 * object); otherwise keeps every FINITE `{x,y}` position and drops the malformed ones, and
 * keeps the `viewport` only when it is finite with a POSITIVE zoom (0/negative restores a
 * blank canvas, and the Core's save validator rejects it). This matters beyond rendering:
 * the restored map is fed straight back into `toWorkspaceSnapshot`, so passing malformed
 * geometry through would make every later `workspace.save` a `bad_request` for the session.
 */
function sanitizeErdLayout(value: unknown): ErdTabLayout | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const l = value as Record<string, unknown>;
  if (typeof l.positions !== "object" || l.positions === null || Array.isArray(l.positions)) {
    return undefined;
  }
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [nodeId, pos] of Object.entries(l.positions as Record<string, unknown>)) {
    if (typeof pos !== "object" || pos === null) continue;
    const p = pos as Record<string, unknown>;
    if (isFiniteNumber(p.x) && isFiniteNumber(p.y)) positions[nodeId] = { x: p.x, y: p.y };
  }
  if (typeof l.viewport === "object" && l.viewport !== null) {
    const vp = l.viewport as Record<string, unknown>;
    if (isFiniteNumber(vp.x) && isFiniteNumber(vp.y) && isFiniteNumber(vp.zoom) && vp.zoom > 0) {
      return { positions, viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } };
    }
  }
  return { positions };
}

/**
 * Seed the App-held `erdLayouts` from a loaded {@link WorkspaceSnapshot} (Story 4.2),
 * dropping any layout whose tab id is not among `tabs` (the restored tab set) — the
 * restore-side twin of {@link toWorkspaceSnapshot}'s pruning — and sanitizing what survives
 * (see {@link sanitizeErdLayout}). Pure and total: a snapshot with no `erdLayouts` (a pre-4.2
 * file) yields `{}` so the ERD falls back to dagre. Like `panelSizes`, ERD geometry is
 * React-held App state rather than part of the pure {@link WorkspaceState}, so it is threaded
 * through this sibling helper.
 */
export function restoreErdLayouts(
  snapshot: WorkspaceSnapshot,
  tabs: ReadonlyArray<{ readonly id: number }>,
): Record<string, ErdTabLayout> {
  // Defensive on the container too: `erdLayouts` is no longer shape-gated at the Core load
  // boundary, so a hand-edited array (whose numeric indices could collide with tab ids) or a
  // scalar must degrade to "no saved geometry", not be walked as a map.
  if (
    !snapshot.erdLayouts ||
    typeof snapshot.erdLayouts !== "object" ||
    Array.isArray(snapshot.erdLayouts)
  ) {
    return {};
  }
  const pruned = pruneErdLayouts(snapshot.erdLayouts, tabs);
  const out: Record<string, ErdTabLayout> = {};
  for (const [tabKey, layout] of Object.entries(pruned)) {
    const clean = sanitizeErdLayout(layout);
    if (clean !== undefined) out[tabKey] = clean;
  }
  return out;
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
  // Drop any UI-only `create-table` tab (Story 9.4): it is a transient authoring
  // surface that must NEVER persist. The `.filter` is REQUIRED by tsc — the widened
  // UI `TabKind` won't assign into the `WorkspaceTabKind`-typed `WorkspaceSnapshotTab.kind`,
  // so this filter is the compile-enforced non-persist boundary at the save side.
  const persistedTabs = state.tabs.filter(
    (t): t is WorkspaceTab & { readonly kind: WorkspaceTabKind } => t.kind !== "create-table",
  );
  // Reconcile `activeTabId` against the SURVIVING tabs (mirror `restoreWorkspace`'s
  // fallback). If the active tab was the dropped create-table tab, keeping the raw
  // `state.activeTabId` would emit a dangling id (∉ persisted tab ids, or a non-null id
  // with empty tabs) and Core's save validator would reject the whole snapshot
  // (`workspace-registry.ts` — activeTabId must be a present tab id, or null when empty),
  // so `workspace.save` would fail for as long as create-table is active. Fall back to
  // the first surviving tab, or null when none remain.
  const activeTabId = persistedTabs.some((t) => t.id === state.activeTabId)
    ? state.activeTabId
    : (persistedTabs[0]?.id ?? null);
  const base: WorkspaceSnapshot = {
    version: WORKSPACE_SNAPSHOT_VERSION,
    panelSizes: [...panelSizes],
    // `connectionId` (Story 10.6) rides along ONLY when the tab actually targets a saved
    // connection. `!= null` covers BOTH `null` and `undefined` — mirroring the
    // `lastProvider` line below — so a boot-bound or never-bound tab emits no key at all
    // and an ephemeral/single-connection workspace stays byte-identical to a pre-10.6
    // snapshot (the untouched-workspace no-resave invariant). Writing `null` would add
    // bytes without adding information: `null` and absent are read identically everywhere.
    tabs: persistedTabs.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      ...(t.connectionId != null ? { connectionId: t.connectionId } : {}),
    })),
    activeTabId,
    nextId: state.nextId,
  };
  const pruned = erdLayouts ? pruneErdLayouts(erdLayouts, state.tabs) : {};
  const withErd = Object.keys(pruned).length > 0 ? { ...base, erdLayouts: pruned } : base;
  // Only attach `lastProvider` when a provider is actually set, so an untouched workspace
  // stays byte-identical to today's snapshot (the no-resave invariant).
  return lastProvider != null ? { ...withErd, lastProvider } : withErd;
}
