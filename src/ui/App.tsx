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
import type { HealthResult, RpcErrorEnvelope, RpcReply } from "../shared/contract.ts";
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
  | { phase: "error"; error: RpcErrorEnvelope | { code: string; message: string } };

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

function ConnectionIndicator({ status }: { status: Status }): React.JSX.Element {
  const dotColor =
    status.phase === "ok"
      ? "bg-emerald-500"
      : status.phase === "error"
        ? "bg-red-500"
        : "bg-amber-500";

  const label =
    status.phase === "loading"
      ? "Connecting…"
      : status.phase === "ok"
        ? `Connected · schema v${status.result.schemaVersion}`
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

  useEffect(() => {
    let alive = true;
    void callHealth().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="h-full">
      <Workspace
        state={workspace}
        onOpen={(kind) => dispatch({ type: "open", kind })}
        onActivate={(id) => dispatch({ type: "activate", id })}
        onClose={(id) => dispatch({ type: "close", id })}
        connectionIndicator={<ConnectionIndicator status={status} />}
      />
    </div>
  );
}
