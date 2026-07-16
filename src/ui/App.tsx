/**
 * quick-studio UI (Ring 2) — App / shell root.
 *
 * Hosts the Workspace state over the pure `workspace-state` model via
 * `useReducer`, renders the Workspace shell, and still performs the token-gated
 * `health` RPC on mount to drive a small connection indicator — proving the
 * authenticated Core↔UI channel from story 1.1 remains intact.
 *
 * Restore-on-launch (Story 2.5): on mount this issues `workspace.load` and gates
 * the Workspace/`PanelGroup` render behind it — `react-resizable-panels` reads
 * `defaultSize` only at the FIRST mount, so Panel sizes must already be resolved
 * before that mount happens. The UI is oblivious to run-mode: it calls
 * `workspace.load`/`workspace.save` unconditionally in BOTH Persistent and
 * Ephemeral mode; Core alone enforces the Ephemeral no-write contract (a
 * `saved:false`/`snapshot:null` reply either way). A debounced effect saves on
 * every `workspace`/`panelSizes` change so a drag doesn't spray writes.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ErdTabLayout,
  ExposureInfo,
  HealthResult,
  LoadWorkspaceResult,
  ProviderKind,
  RpcErrorEnvelope,
  RpcReply,
  SaveWorkspaceResult,
  SchemaIndexInfo,
  SchemaTableInfo,
  ShutdownResult,
  WorkspaceSnapshot,
} from "../shared/contract.ts";
import { rpc, saveWorkspaceSync } from "./rpc/client.ts";
import type { ChatState } from "./workspace/chat-model.ts";
import { emptyReport, type ReportState, type ReportStateUpdate } from "./report/report-state.ts";
import { createSaveScheduler, type SaveScheduler } from "./workspace/save-scheduler.ts";
import { Workspace } from "./workspace/Workspace.tsx";
import {
  activateTab,
  bindTableToActiveTab,
  closeTab,
  emptyWorkspace,
  openTab,
  restoreErdLayouts,
  restoreLastProvider,
  restoreWorkspace,
  toWorkspaceSnapshot,
  type TableRef,
  type TabKind,
  type WorkspaceState,
} from "./workspace/workspace-state.ts";

/** Default `[rail, main]` Panel sizes when no persisted snapshot restores them. */
const DEFAULT_PANEL_SIZES: readonly [number, number] = [20, 80];

/** Debounce window (ms) before a Workspace/Panel-size change is flushed to disk. */
const SAVE_DEBOUNCE_MS = 400;

declare global {
  interface Window {
    __QS_TOKEN__?: string;
    __QS_EXPOSURE__?: ExposureInfo;
  }
}

/* ------------------------------------------------------------------ *
 * Workspace reducer over the pure model
 * ------------------------------------------------------------------ */

type WorkspaceAction =
  | { type: "open"; kind: TabKind }
  | { type: "close"; id: number }
  | { type: "activate"; id: number }
  | { type: "bindTable"; ref: TableRef }
  | { type: "restore"; snapshot: WorkspaceSnapshot };

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "open":
      return openTab(state, action.kind);
    case "close":
      return closeTab(state, action.id);
    case "activate":
      return activateTab(state, action.id);
    case "bindTable":
      return bindTableToActiveTab(state, action.ref);
    case "restore":
      return restoreWorkspace(action.snapshot);
  }
}

/* ------------------------------------------------------------------ *
 * Connection indicator — the proven token-gated `health` channel
 * ------------------------------------------------------------------ */

type Status =
  | { phase: "loading" }
  | { phase: "ok"; result: HealthResult }
  | { phase: "error"; error: RpcErrorEnvelope | { code: string; message: string } }
  | { phase: "stopped" };

async function callHealth(): Promise<Status> {
  const token = window.__QS_TOKEN__ ?? "";
  try {
    const res = await fetch("/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qs-token": token,
      },
      body: JSON.stringify({ method: "health" }),
    });
    const body = (await res.json()) as RpcReply<HealthResult>;
    if (body.ok) {
      return { phase: "ok", result: body.result };
    }
    return { phase: "error", error: body.error };
  } catch (err) {
    return {
      phase: "error",
      error: { code: "network_error", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Mirrors `callHealth()`: same token-gated POST shape. The reply acks
 * `{stopping:true}` BEFORE the Core tears itself down, so a thrown fetch here
 * (connection dropped mid-teardown) is an EXPECTED shape of "it stopped," not
 * a real failure — both paths resolve to the `stopped` phase.
 */
async function callShutdown(): Promise<Status> {
  const token = window.__QS_TOKEN__ ?? "";
  try {
    const res = await fetch("/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qs-token": token,
      },
      body: JSON.stringify({ method: "shutdown" }),
    });
    const body = (await res.json()) as RpcReply<ShutdownResult>;
    if (body.ok) {
      return { phase: "stopped" };
    }
    return { phase: "error", error: body.error };
  } catch {
    // Same network-error catch shape as `callHealth`, but here a dropped
    // connection means the shutdown worked — the server is gone.
    return { phase: "stopped" };
  }
}

function ConnectionIndicator({ status }: { status: Status }): React.JSX.Element {
  // Neutral status-bar segment (prototype `.statusbar .seg` / `.rail-status .sdot`):
  // green `--ok` when connected, red when errored, muted for stopped AND loading —
  // color is spent only where it is functional, never as decoration.
  const dotColor =
    status.phase === "ok" ? "bg-ok" : status.phase === "error" ? "bg-red-500" : "bg-muted-foreground";

  const label =
    status.phase === "loading"
      ? "Connecting…"
      : status.phase === "ok"
        ? `Connected · schema v${status.result.schemaVersion}`
        : status.phase === "stopped"
          ? "Stopped"
          : `Disconnected · ${status.error.code}`;

  const title =
    status.phase === "error" ? `${status.error.code}: ${status.error.message}` : label;

  return (
    <div
      data-testid="health"
      title={title}
      className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground"
    >
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

/**
 * Terse status-bar save-failure indicator (DW-22), mirroring {@link ConnectionIndicator}
 * exactly (same mono type scale, same dot+label shape) rather than introducing a
 * toast/snackbar system. Rendered ONLY while a persistent-mode `workspace.save`
 * is failing; it clears the moment a save succeeds. The `title` tooltip states the
 * self-healing behavior — the next content change re-attempts the save.
 */
function SaveIndicator(): React.JSX.Element {
  return (
    <div
      data-testid="save-status"
      title="Workspace save failed — retrying on next change"
      className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground"
    >
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden />
      <span>Save failed</span>
    </div>
  );
}

/**
 * The brief pre-mount gate while the initial `workspace.load` is in flight.
 * `react-resizable-panels` reads `defaultSize` only once, at its FIRST mount, so
 * `Workspace`/`PanelGroup` must not render until the restored (or default) Panel
 * sizes are known. Intentionally minimal — "no spinner beyond the brief layout
 * gate" — just the app background so there is no flash of unstyled content.
 */
function LayoutGate(): React.JSX.Element {
  return <div className="h-full bg-background" />;
}

/* ------------------------------------------------------------------ *
 * App shell root
 * ------------------------------------------------------------------ */

export function App(): React.JSX.Element {
  const [workspace, dispatch] = useReducer(workspaceReducer, undefined, emptyWorkspace);
  const [panelSizes, setPanelSizes] = useState<number[]>([...DEFAULT_PANEL_SIZES]);
  // Gates the Workspace/`PanelGroup` first mount (Panel-size restore timing): the
  // layout must not render until the initial `workspace.load` has resolved (either
  // with a snapshot or not), because `react-resizable-panels` reads `defaultSize`
  // only once, at first mount.
  const [workspaceReady, setWorkspaceReady] = useState(false);
  // Gates the debounced save effect. Enabled ONLY after a *successful* load — a
  // load that errored (RPC failure/timeout, store `internal_error`) must NOT turn
  // saving on: we may have failed to READ a perfectly good on-disk snapshot, and
  // writing the empty fallback over it would be silent data loss. On a load error
  // we still render (fresh, usable) but never persist this session.
  const [savingEnabled, setSavingEnabled] = useState(false);
  // Serialized snapshot last known to be on disk, so an *unchanged* Workspace does
  // not trigger a needless (and, pre-fix, clobber-prone) save on every launch:
  // `onLayout` fires a fresh array at `PanelGroup` mount, which would otherwise
  // always look "changed". Only a genuinely different snapshot writes.
  const lastPersistedRef = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [stopping, setStopping] = useState(false);
  // True while a persistent-mode `workspace.save` is failing — surfaced via the
  // status-bar `SaveIndicator` (DW-22). Set by the scheduler's `onError`, cleared
  // by its `onSuccess`; `saved:false` (ephemeral) is a success and never sets it.
  const [saveFailed, setSaveFailed] = useState(false);
  // Set true the instant Stop is pressed so the debounce timer's callback and any
  // future arming both bail — no new save is scheduled once we're quitting (the
  // quit path owns the final, ordered write). A ref (not state) so the already-armed
  // debounce callback reads the latest value without a re-render race.
  const stoppingRef = useRef(false);
  // Holds the armed debounce `setTimeout` handle so `onStop` can cancel a pending
  // (not-yet-fired) save before flushing the current snapshot through the scheduler.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Component-alive guard for post-`await` `setState` in `onStop` (mirrors the load
  // effect's `alive` pattern): a shutdown-time unmount must not warn on a late set.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The ONE serialization primitive every async `workspace.save` goes through
  // (DW-27): debounce AND the quit flush both `schedule` onto it, so at most one
  // save is ever outstanding and the newest snapshot always lands last (no reorder
  // from the store's temp-file+rename). Created once — lazy `useRef` init keeps a
  // single instance across renders. Its callbacks close over stable setters/refs.
  const schedulerRef = useRef<SaveScheduler | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = createSaveScheduler({
      // Thin `rpc` wrapper: the scheduler only needs the `ok` bit. `reply.ok===true`
      // covers BOTH a real persistent write (`saved:true`) and the ephemeral no-op
      // (`saved:false`) — both are successes; only `!reply.ok` is a failure.
      save: (s) => rpc<SaveWorkspaceResult>("workspace.save", s).then((r) => ({ ok: r.ok })),
      // Advance the persisted marker ONLY on success (DW-22 retry invariant): a
      // failed write leaves it stale so an identical later change still re-saves.
      onPersisted: (serialized) => {
        lastPersistedRef.current = serialized;
      },
      // Guard the `setState`s: a save can settle after a shutdown-time unmount, and
      // setting state on an unmounted tree warns. `onPersisted` only touches a ref, so
      // it needs no guard.
      onError: () => {
        if (mountedRef.current) setSaveFailed(true);
      },
      onSuccess: () => {
        if (mountedRef.current) setSaveFailed(false);
      },
    });
  }
  const scheduler = schedulerRef.current;
  // The live introspected tables (from the schema tree's `connect`), kept so the
  // grid of the active table tab can look up its PK columns (for the key icon).
  const [schemaTables, setSchemaTables] = useState<ReadonlyArray<SchemaTableInfo>>([]);
  // Tables created optimistically this session (Story 3.4). A createTable `ok`
  // guarantees the table exists exactly as submitted, but the Core's connect-time
  // schema is memoized and cannot be re-introspected — so we synthesize the
  // `SchemaTableInfo` and append it here. This list is session-only (a fresh process
  // resets it, and the reconnect reflects introspected truth).
  const [createdTables, setCreatedTables] = useState<ReadonlyArray<SchemaTableInfo>>([]);
  const onTableCreated = (table: SchemaTableInfo): void => setCreatedTables((cur) => [...cur, table]);

  // Session-only draft SQL per query Tab id (Story 3.6), keyed by Tab id so each
  // query Tab keeps its own typed-but-unrun text across Tab switches. Deliberately
  // NEVER folded into `toWorkspaceSnapshot`/`workspace.save` — the snapshot invariant
  // is that query text never touches disk; a relaunch starts every query Tab blank.
  const [queryDrafts, setQueryDrafts] = useState<ReadonlyMap<number, string>>(new Map());
  const onQueryDraftChange = (tabId: number, sql: string): void =>
    setQueryDrafts((cur) => new Map(cur).set(tabId, sql));

  // Session-only chat state per chat Tab id (Story 5.2), keyed by Tab id so each chat
  // Tab keeps its own message log + picked provider across Tab switches. Like the query
  // drafts, chat CONTENT (messages, reasoning, run outcomes, per-Tab `ChatState`) is
  // deliberately NEVER folded into `toWorkspaceSnapshot`/`workspace.save` — it never
  // touches disk; a relaunch starts every chat blank. The ONE exception (Story 8.5) is
  // the lightweight `lastProvider` default HINT below — not chat content, no key, no rows.
  const [chatStates, setChatStates] = useState<ReadonlyMap<number, ChatState>>(new Map());
  // The last-used chat provider (Story 8.5): an App-held UX default hint that DOES ride
  // into the snapshot (like `erdLayouts`), so a fresh chat Tab can auto-select it instead
  // of forcing a manual pick. Captured whenever a chat Tab reports a non-null provider,
  // seeded on restore, and persisted through the existing debounced save pipeline.
  const [lastProvider, setLastProvider] = useState<ProviderKind | null>(null);
  const onChatStateChange = (tabId: number, next: ChatState): void => {
    setChatStates((cur) => new Map(cur).set(tabId, next));
    // Remember the last-used provider as a durable default hint: only advance it when a Tab
    // reports a real provider, never reset it to null (a Tab that starts unselected must not
    // wipe a previously-remembered choice). The picker exposes no clear-to-null affordance.
    if (next.provider !== null) setLastProvider(next.provider);
  };

  // Session-only report state per report Tab id (Story 6.1), keyed by Tab id so each
  // report Tab keeps its own ordered blocks + query results across Tab switches. Like the
  // chat states, this is deliberately NEVER folded into `toWorkspaceSnapshot`/`workspace.save`
  // — report content (prose + query results) never touches disk; a relaunch starts blank.
  const [reportStates, setReportStates] = useState<ReadonlyMap<number, ReportState>>(new Map());
  // Accept a functional updater so two query-block runs completing in the same React
  // batch each fold against the LATEST report state (never a stale snapshot that clobbers
  // the other block's just-stored result). FR-18.
  const onReportStateChange = (tabId: number, next: ReportStateUpdate): void =>
    setReportStates((cur) => {
      const prev = cur.get(tabId) ?? emptyReport();
      const resolved = typeof next === "function" ? next(prev) : next;
      return new Map(cur).set(tabId, resolved);
    });

  // Persisted ERD layouts per tab id (Story 4.2), keyed by stringified tab id to match
  // the snapshot shape. Unlike query drafts, this DOES ride into `toWorkspaceSnapshot`
  // (geometry only — positions + viewport, never credentials/rows/SQL). Seeded from the
  // loaded snapshot, updated from each ERD tab's `onLayoutChange`, and pruned on close.
  const [erdLayouts, setErdLayouts] = useState<Record<string, ErdTabLayout>>({});
  const onErdLayoutChange = (tabId: number, layout: ErdTabLayout): void =>
    setErdLayouts((cur) => ({ ...cur, [String(tabId)]: layout }));

  // The introspected tables plus the optimistically-created ones — the single source
  // for both the PK lookup (so a freshly-created table is immediately editable per
  // Story 3.3) and the create-form's schema selector.
  const allTables = useMemo<ReadonlyArray<SchemaTableInfo>>(
    () => [...schemaTables, ...createdTables],
    [schemaTables, createdTables],
  );

  // Existing schema names (unique, introspection order) for the create-table target.
  const schemas = useMemo<ReadonlyArray<string>>(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const t of allTables) {
      // Skip a blank schema (an optimistic entry created into the default namespace):
      // it is never a selectable target and would render as an empty option.
      if (t.schema.trim() === "") continue;
      if (!seen.has(t.schema)) {
        seen.add(t.schema);
        names.push(t.schema);
      }
    }
    return names;
  }, [allTables]);

  // PK column names of the active table tab's bound table, or empty otherwise.
  const primaryKeys = useMemo<ReadonlyArray<string>>(() => {
    const active = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? null;
    if (active === null || active.kind !== "table" || active.table === undefined) return [];
    const ref = active.table;
    const match = allTables.find((t) => t.schema === ref.schema && t.name === ref.name);
    return match?.primaryKey ?? [];
  }, [workspace, allTables]);

  // Introspected indexes of the active table tab's bound table (Story 3.5), from the
  // same `allTables` lookup that yields `primaryKeys` — already in hand via the
  // memoized connect payload, so the index sub-view needs no round-trip.
  const indexes = useMemo<ReadonlyArray<SchemaIndexInfo>>(() => {
    const active = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? null;
    if (active === null || active.kind !== "table" || active.table === undefined) return [];
    const ref = active.table;
    const match = allTables.find((t) => t.schema === ref.schema && t.name === ref.name);
    return match?.indexes ?? [];
  }, [workspace, allTables]);

  useEffect(() => {
    let alive = true;
    void callHealth().then((s) => {
      // `stopped` is terminal: a late-resolving mount probe must never clobber
      // the state the user reached by hitting Stop (else the indicator flips
      // from "Stopped" back to a scary "Disconnected · network_error").
      if (alive) setStatus((prev) => (prev.phase === "stopped" ? prev : s));
    });
    return () => {
      alive = false;
    };
  }, []);

  // Restore-on-launch: the UI calls `workspace.load` unconditionally — it never
  // branches on run-mode itself. On a *successful* load, Persistent mode may
  // resolve a real snapshot; Ephemeral mode (and first launch) resolves
  // `snapshot: null`, the ordinary "start fresh" case. A *failed* load (error
  // reply) is deliberately NOT treated as "start fresh and save": it renders
  // fresh but leaves saving disabled so a good-but-unreadable file is never
  // overwritten.
  useEffect(() => {
    let alive = true;
    void rpc<LoadWorkspaceResult>("workspace.load").then((reply) => {
      if (!alive) return;
      if (!reply.ok) {
        // Load errored — render fresh but keep auto-save OFF (data-loss guard).
        setWorkspaceReady(true);
        return;
      }
      const snapshot = reply.result.snapshot;
      // The reducer state we will actually hold after this effect, and the panel
      // sizes to render — computed up front so we can seed the "already on disk"
      // baseline with exactly what a subsequent save would serialize (so an
      // untouched Workspace does not re-save on launch).
      const restored = snapshot ? restoreWorkspace(snapshot) : emptyWorkspace();
      const sizes =
        snapshot && snapshot.panelSizes.length > 0
          ? [...snapshot.panelSizes]
          : [...DEFAULT_PANEL_SIZES];
      // Seed ERD geometry from the snapshot, pruned to the restored tab set (a pre-4.2
      // file has no `erdLayouts` → {} → dagre fallback).
      const layouts = snapshot ? restoreErdLayouts(snapshot, restored.tabs) : {};
      // Seed the last-used provider default hint (Story 8.5): an unknown/absent value → null,
      // so a chat Tab falls back to single/first-connected.
      const provider = snapshot ? restoreLastProvider(snapshot) : null;
      if (snapshot) {
        // These updates plus `setSavingEnabled`/`setWorkspaceReady` below are
        // batched into one re-render, so by the time `workspaceReady` flips true
        // (and `Workspace`/`PanelGroup` first mounts) the reducer state and
        // `panelSizes` already reflect the restored values.
        dispatch({ type: "restore", snapshot });
        setPanelSizes(sizes);
        setErdLayouts(layouts);
        setLastProvider(provider);
      }
      lastPersistedRef.current = JSON.stringify(toWorkspaceSnapshot(restored, sizes, layouts, provider));
      setSavingEnabled(true);
      setWorkspaceReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Debounced save-on-change: any rearrange (open/close/activate a Tab, drag the
  // split) schedules a single trailing `workspace.save` ~400ms later, so a drag
  // doesn't spray writes. Guarded on `savingEnabled` (successful load only) and
  // on an actual change vs the last-persisted snapshot, so neither the
  // pre-restore empty Workspace nor an unchanged launch ever writes.
  useEffect(() => {
    if (!savingEnabled) return;
    const handle = setTimeout(() => {
      // Once Stop is pressed, the quit path owns the final write — never schedule a
      // fresh debounced save that could race or resurrect content after shutdown.
      if (stoppingRef.current) return;
      const snapshot = toWorkspaceSnapshot(workspace, panelSizes, erdLayouts, lastProvider);
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastPersistedRef.current) return; // nothing actually changed
      // Route through the single scheduler: it advances `lastPersistedRef` itself,
      // and ONLY on success — do NOT advance it optimistically here (a failed write
      // must stay retryable).
      scheduler.schedule(serialized, snapshot);
    }, SAVE_DEBOUNCE_MS);
    saveTimerRef.current = handle;
    return () => clearTimeout(handle);
  }, [workspace, panelSizes, erdLayouts, lastProvider, savingEnabled, scheduler]);

  // Window-close last-chance flush (DW-24): on `beforeunload`, if the current
  // snapshot differs from what's persisted AND the async scheduler is idle, do a
  // best-effort SYNCHRONOUS save (an async `fetch` cannot reliably finish during
  // teardown). When the scheduler IS busy we do NOTHING — the async writer owns the
  // write, and overlapping a sync XHR with an in-flight async save is the exact
  // DW-27 reorder. Advance the persisted marker only when the sync write confirmed.
  useEffect(() => {
    if (!savingEnabled) return;
    const handler = (): void => {
      const snapshot = toWorkspaceSnapshot(workspace, panelSizes, erdLayouts, lastProvider);
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastPersistedRef.current) return; // already persisted
      if (scheduler.isBusy()) return; // async writer owns the write — never overlap
      if (saveWorkspaceSync(snapshot)) {
        lastPersistedRef.current = serialized;
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [workspace, panelSizes, erdLayouts, lastProvider, savingEnabled, scheduler]);

  const onStop = (): void => {
    // Guard the destructive control: ignore repeat clicks so a double-click
    // can't fire a second `shutdown` RPC, and reflect a pending state.
    if (stopping) return;
    // Mark quitting FIRST so an already-armed debounce callback bails, then cancel
    // the pending debounce timer outright — the quit flush below owns the final write.
    stoppingRef.current = true;
    setStopping(true);
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    void (async () => {
      // Flush the last pre-Stop change through the SAME scheduler so it can never
      // overlap an in-flight debounced save (DW-27): schedule it (if changed), then
      // `drain()` waits for the in-flight save, its trailing save, and this quit save
      // to all settle in order — newest snapshot last, no reorder — before shutdown.
      if (savingEnabled) {
        const snapshot = toWorkspaceSnapshot(workspace, panelSizes, erdLayouts, lastProvider);
        const serialized = JSON.stringify(snapshot);
        if (serialized !== lastPersistedRef.current) {
          scheduler.schedule(serialized, snapshot);
        }
      }
      await scheduler.drain();
      // Last-ditch flush: if the drained quit save FAILED (async `save` returned
      // `!ok`, so `lastPersistedRef` is still stale) the change would be lost on
      // shutdown. The scheduler is now idle, so a synchronous write here cannot
      // reorder — attempt it best-effort before Core goes away.
      if (savingEnabled) {
        const snapshot = toWorkspaceSnapshot(workspace, panelSizes, erdLayouts, lastProvider);
        const serialized = JSON.stringify(snapshot);
        if (serialized !== lastPersistedRef.current && saveWorkspaceSync(snapshot)) {
          lastPersistedRef.current = serialized;
        }
      }
      const s = await callShutdown();
      // Guard the post-`await` set: a shutdown-time unmount must not warn on a late set.
      if (mountedRef.current) setStatus(s);
    })();
  };

  // Exposure state is injected at boot (static for the session), so read it once
  // straight from the global rather than round-tripping an RPC.
  const exposure = window.__QS_EXPOSURE__;

  if (!workspaceReady) {
    return <LayoutGate />;
  }

  return (
    <div className="h-full">
      <Workspace
        state={workspace}
        onOpen={(kind) => dispatch({ type: "open", kind })}
        onActivate={(id) => dispatch({ type: "activate", id })}
        onClose={(id) => {
          dispatch({ type: "close", id });
          // Reclaim the closed Tab's draft SQL — ids are monotonic (never reused),
          // so a closed query Tab's entry would otherwise linger for the session.
          setQueryDrafts((cur) => {
            if (!cur.has(id)) return cur;
            const next = new Map(cur);
            next.delete(id);
            return next;
          });
          // Reclaim the closed chat Tab's session state (mirrors the query-draft cleanup;
          // ids are monotonic so a closed Tab's entry would otherwise linger).
          setChatStates((cur) => {
            if (!cur.has(id)) return cur;
            const next = new Map(cur);
            next.delete(id);
            return next;
          });
          // Reclaim the closed report Tab's session state (mirrors the chat cleanup;
          // ids are monotonic so a closed Tab's entry would otherwise linger).
          setReportStates((cur) => {
            if (!cur.has(id)) return cur;
            const next = new Map(cur);
            next.delete(id);
            return next;
          });
          // Prune the closed tab's ERD layout so it stops being persisted (Story 4.2).
          setErdLayouts((cur) => {
            const key = String(id);
            if (!(key in cur)) return cur;
            const next = { ...cur };
            delete next[key];
            return next;
          });
        }}
        onActivateTable={(table) =>
          dispatch({ type: "bindTable", ref: { schema: table.schema, name: table.name } })
        }
        onSchemaLoaded={setSchemaTables}
        primaryKeys={primaryKeys}
        indexes={indexes}
        allTables={allTables}
        queryDrafts={queryDrafts}
        onQueryDraftChange={onQueryDraftChange}
        chatStates={chatStates}
        onChatStateChange={onChatStateChange}
        lastProvider={lastProvider}
        reportStates={reportStates}
        onReportStateChange={onReportStateChange}
        erdLayouts={erdLayouts}
        onErdLayoutChange={onErdLayoutChange}
        extraTables={createdTables}
        schemas={schemas}
        onTableCreated={onTableCreated}
        onStop={onStop}
        stopping={stopping}
        connectionIndicator={<ConnectionIndicator status={status} />}
        saveIndicator={saveFailed ? <SaveIndicator /> : undefined}
        exposure={exposure}
        panelSizes={panelSizes}
        onLayout={setPanelSizes}
      />
    </div>
  );
}
