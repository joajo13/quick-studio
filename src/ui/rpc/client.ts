/**
 * quick-studio UI (Ring 2) — typed RPC client.
 *
 * Centralizes the token-gated `POST /rpc` call the UI has so far inlined. Reads the
 * per-boot session token from `window.__QS_TOKEN__`, sends it as `x-qs-token`, and
 * always resolves to a typed {@link RpcReply<T>} — a transport/network failure is
 * turned into an error-envelope-shaped reply (`internal_error`) rather than a throw,
 * so every caller handles exactly one shape.
 *
 * The UI never holds a credential or a key: it sends credentials only inside an
 * add/edit submit body and receives only credential-free results back.
 */

import type { RpcReply } from "../../shared/contract.ts";

declare global {
  interface Window {
    __QS_TOKEN__?: string;
  }
}

/**
 * Milliseconds before a hung `/rpc` request is aborted. Without this, a wedged Core
 * would leave the fetch pending forever and the panel's `busy` flag never clears.
 */
const RPC_TIMEOUT_MS = 10_000;

/** A synthetic `internal_error` envelope for a malformed/non-envelope reply body. */
function malformedReply<T>(): RpcReply<T> {
  return { ok: false, error: { code: "internal_error", message: "malformed reply from core" } };
}

/**
 * Issue a token-gated RPC. Resolves to the parsed {@link RpcReply}; on a network or
 * transport failure (fetch throws, the request times out, or the body is not valid
 * JSON / not a well-formed envelope) it resolves to a synthetic `internal_error`
 * envelope so the caller never has to catch and `busy` always clears.
 */
export async function rpc<T>(method: string, params?: unknown): Promise<RpcReply<T>> {
  const token = window.__QS_TOKEN__ ?? "";
  // Abort a hung request after the timeout so a wedged Core can't pin the panel.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch("/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-qs-token": token,
      },
      body: JSON.stringify(params === undefined ? { method } : { method, params }),
      signal: controller.signal,
    });
    // A non-JSON body (proxy error page, truncated response) throws here — map it to
    // the same malformed-reply envelope rather than letting it escape as a throw.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return malformedReply<T>();
    }
    // Validate the envelope shape before casting: a body without a boolean `ok`
    // would make callers reading `.ok`/`.error` throw a `TypeError`.
    if (typeof body !== "object" || body === null || typeof (body as { ok?: unknown }).ok !== "boolean") {
      return malformedReply<T>();
    }
    return body as RpcReply<T>;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "internal_error",
        message: "request failed",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
