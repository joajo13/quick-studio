/**
 * quick-studio UI (Ring 2) — App / shell root.
 *
 * Hosts the in-memory Workspace state (Ephemeral — React memory only) over the
 * pure `workspace-state` model via `useReducer`, renders the Workspace shell,
 * and still performs the token-gated `health` RPC on mount to drive a small
 * connection indicator — proving the authenticated Core↔UI channel from story
 * 1.1 remains intact.
 */

import { useEffect, useReducer, useState } from "react";
import type {
  ExposureInfo,
  HealthResult,
  RpcErrorEnvelope,
  RpcReply,
  ShutdownResult,
} from "../shared/contract.ts";
import { Workspace } from "./workspace/Workspace.tsx";
import {
  activateTab,
  closeTab,
  emptyWorkspace,
  openTab,
  type TabKind,
  type WorkspaceState,
} from "./workspace/workspace-state.ts";

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
  | { type: "activate"; id: number };

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "open":
      return openTab(state, action.kind);
    case "close":
      return closeTab(state, action.id);
    case "activate":
      return activateTab(state, action.id);
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

/* ------------------------------------------------------------------ *
 * App shell root
 * ------------------------------------------------------------------ */

export function App(): React.JSX.Element {
  const [workspace, dispatch] = useReducer(workspaceReducer, undefined, emptyWorkspace);
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
      />
    </div>
  );
}
