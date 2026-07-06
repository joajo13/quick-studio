/**
 * quick-studio UI (Ring 2) — App.
 *
 * Minimal React 19 component. NO Tailwind/shadcn theming yet (that lands with
 * the Workspace shell in 1.4). Reads the injected per-boot token, calls the
 * `health` RPC over `POST /rpc` with the `X-QS-Token` header, and renders the
 * status + frozen-data schema version — proving the authenticated channel.
 */

import { useEffect, useState } from "react";
import type { HealthResult, RpcErrorEnvelope, RpcReply } from "../shared/contract.ts";

declare global {
  interface Window {
    __QS_TOKEN__?: string;
  }
}

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

export function App(): React.JSX.Element {
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
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", lineHeight: 1.5 }}>
      <h1 style={{ margin: 0 }}>quick-studio</h1>
      <p style={{ color: "#666" }}>walking skeleton — authenticated Core↔UI channel</p>

      {status.phase === "loading" && <p data-testid="health">Connecting…</p>}

      {status.phase === "ok" && (
        <div data-testid="health">
          <p>
            Core health: <strong style={{ color: "#0a0" }}>{status.result.status}</strong>
          </p>
          <p>
            Frozen-data schema version: <strong>{status.result.schemaVersion}</strong>
          </p>
        </div>
      )}

      {status.phase === "error" && (
        <div data-testid="health" style={{ color: "#c00" }}>
          <p>
            RPC failed: <code>{status.error.code}</code> — {status.error.message}
          </p>
        </div>
      )}
    </main>
  );
}
