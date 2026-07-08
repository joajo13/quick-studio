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

import { useEffect, useReducer, useRef, useState } from "react";
import type {
  ExposureInfo,
  HealthResult,
  LoadWorkspaceResult,
  RpcErrorEnvelope,
  RpcReply,
  SaveWorkspaceResult,
  ShutdownResult,
  WorkspaceSnapshot,
} from "../shared/contract.ts";
import { rpc } from "./rpc/client.ts";
import { Workspace } from "./workspace/Workspace.tsx";
import {
  activateTab,
  closeTab,
  emptyWorkspace,
  openTab,
  restoreWorkspace,
  toWorkspaceSnapshot,
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
  | { type: "restore"; snapshot: WorkspaceSnapshot };

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "open":
      return openTab(state, action.kind);
    case "close":
      return closeTab(state, action.id);
    case "activate":
      return activateTab(state, action.id);
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
  const dotColor =
    status.phase === "ok"
      ? "bg-emerald-500"
      : status.phase === "error"
        ? "bg-red-500"
        : status.phase === "stopped"
          ? "bg-muted-foreground"
          : "bg-amber-500";

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
      className="flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} aria-hidden />
      <span>{label}</span>
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
      if (snapshot) {
        // These updates plus `setSavingEnabled`/`setWorkspaceReady` below are
        // batched into one re-render, so by the time `workspaceReady` flips true
        // (and `Workspace`/`PanelGroup` first mounts) the reducer state and
        // `panelSizes` already reflect the restored values.
        dispatch({ type: "restore", snapshot });
        setPanelSizes(sizes);
      }
      lastPersistedRef.current = JSON.stringify(toWorkspaceSnapshot(restored, sizes));
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
      const snapshot = toWorkspaceSnapshot(workspace, panelSizes);
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastPersistedRef.current) return; // nothing actually changed
      lastPersistedRef.current = serialized;
      void rpc<SaveWorkspaceResult>("workspace.save", snapshot);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [workspace, panelSizes, savingEnabled]);

  const onStop = (): void => {
    // Guard the destructive control: ignore repeat clicks so a double-click
    // can't fire a second `shutdown` RPC, and reflect a pending state.
    if (stopping) return;
    setStopping(true);
    void callShutdown().then((s) => setStatus(s));
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
        onClose={(id) => dispatch({ type: "close", id })}
        onStop={onStop}
        stopping={stopping}
        connectionIndicator={<ConnectionIndicator status={status} />}
        exposure={exposure}
        panelSizes={panelSizes}
        onLayout={setPanelSizes}
      />
    </div>
  );
}
