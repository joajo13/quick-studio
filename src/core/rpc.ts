/**
 * quick-studio Core — RPC dispatch (wire conventions).
 *
 * A small dispatch table maps a method name to a handler. Every reply is
 * wrapped as a typed result OR the single error envelope (never a naked error).
 * An unknown method yields a typed `unknown_method` error.
 */

import {
  FROZEN_SCHEMA_VERSION,
  errorReply,
  okReply,
  type HealthResult,
  type RpcReply,
  type RpcRequest,
} from "../shared/contract.ts";

/** A dispatch handler: takes typed params, returns a typed result payload. */
type Handler = (params: unknown) => unknown;

const HANDLERS: Readonly<Record<string, Handler>> = {
  /** Liveness + schema-version probe. Proves the authenticated channel works. */
  health: (): HealthResult => ({
    status: "ok",
    schemaVersion: FROZEN_SCHEMA_VERSION,
  }),
};

/**
 * Dispatch an already-authenticated RPC request. Returns a typed reply. Any
 * handler throw is caught and wrapped as an `internal_error` envelope, so the
 * caller never sees a naked error.
 */
export function dispatch(request: RpcRequest): RpcReply<unknown> {
  const { method } = request;
  if (typeof method !== "string" || method.length === 0) {
    return errorReply("bad_request", "RPC request is missing a method name");
  }

  // Look up via `Object.hasOwn` — a plain-object index would otherwise resolve
  // inherited `Object.prototype` keys (`toString`, `valueOf`, `constructor`,
  // `__proto__`, …) to a truthy function and dispatch them instead of returning
  // `unknown_method`, breaking the "unknown method → typed error" contract.
  const handler = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : undefined;
  if (handler === undefined) {
    return errorReply("unknown_method", `No such RPC method`, `method=${method}`);
  }

  try {
    return okReply(handler(request.params));
  } catch (err) {
    // Log the real cause to stderr (terse, server-side only). Do NOT echo the
    // raw exception message to the client `detail` — internal error text may
    // carry paths, driver output, or query fragments in later stories.
    const cause = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[rpc] handler '${method}' threw: ${cause}\n`);
    return errorReply("internal_error", "RPC handler failed");
  }
}

/** Names of all registered RPC methods (for diagnostics/tests). */
export function methodNames(): ReadonlyArray<string> {
  return Object.keys(HANDLERS);
}
