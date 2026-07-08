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
  type ConnectResult,
  type HealthResult,
  type RpcReply,
  type RpcRequest,
  type ShutdownResult,
} from "../shared/contract.ts";
import type { ConnectionRegistry, RegistryResult } from "./connection-registry.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

/**
 * Per-request capabilities threaded into every handler. `requestShutdown`
 * schedules the actual teardown (never invoked synchronously by a handler —
 * see `server.ts`), so the RPC reply can flush before the socket closes.
 * `connect` opens (once) and introspects the Core-held database connection.
 * `connections` is the manage-connections registry (the sole store holder).
 * `workspace` is the Workspace-state registry (Story 2.5): load/save the Panel
 * sizes + open Tabs snapshot, mode-gated exactly like `connections`.
 */
export type RpcContext = {
  readonly requestShutdown: () => void;
  /** Open + introspect the Core's connection, resolving a neutral outcome payload. */
  readonly connect: () => Promise<ConnectResult>;
  /** Manage-connections registry: list/add/edit/remove over the credential store. */
  readonly connections: ConnectionRegistry;
  /** Workspace-state registry: load/save the Panel-sizes + open-Tabs snapshot. */
  readonly workspace: WorkspaceRegistry;
};

/**
 * A registry result translates 1:1 onto the wire: `ok` → `okReply(value)`, else the
 * error envelope carrying the registry's own code/message/detail. Handlers that
 * return a value of this shape are dispatched verbatim (see {@link dispatch}).
 */
function toReply<T>(result: RegistryResult<T>): RpcReply<T> {
  return result.ok
    ? okReply(result.value)
    : errorReply(result.code, result.message, result.detail);
}

/**
 * Explicit brand marking a handler value as an ALREADY-formed wire reply (vs a raw
 * domain payload dispatch must wrap in `okReply`). A module-private `Symbol` key can
 * never appear in a JSON-parsed request nor serialize onto the wire, so — unlike a
 * structural `ok` sniff — it cannot collide with a future domain payload that happens
 * to carry a boolean `ok`.
 */
const PREFORMED: unique symbol = Symbol("rpc.preformedReply");

/** A handler value tagged as a preformed reply (see {@link PREFORMED}). */
type Preformed = { readonly [PREFORMED]: RpcReply<unknown> };

/** Tag a fully-formed reply so `dispatch` returns it verbatim instead of wrapping it. */
function preformed(reply: RpcReply<unknown>): Preformed {
  return { [PREFORMED]: reply };
}

/**
 * Narrow an unvalidated `params` to a plain object (rejecting `null`/arrays/
 * primitives), so each connections handler can shape-check its fields before
 * delegating. The boundary hands us `params: unknown`.
 */
function asParamsObject(params: unknown): Record<string, unknown> | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return null;
  }
  return params as Record<string, unknown>;
}

/**
 * A dispatch handler: takes typed params + context and returns a typed result
 * payload (or a promise thereof — `connect` is the first async handler).
 */
type Handler = (params: unknown, ctx: RpcContext) => unknown | Promise<unknown>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  /** Liveness + schema-version probe. Proves the authenticated channel works. */
  health: (): HealthResult => ({
    status: "ok",
    schemaVersion: FROZEN_SCHEMA_VERSION,
  }),
  /**
   * Ack-before-teardown: reply first, teardown is scheduled by `ctx` on a
   * macrotask (never run synchronously here) so this reply always flushes.
   */
  shutdown: (_params, ctx): ShutdownResult => {
    ctx.requestShutdown();
    return { stopping: true };
  },
  /**
   * Open (idempotently) and introspect the Core-held connection. The neutral
   * {@link ConnectResult} — including host/auth/network/unsupported-scheme
   * failures — is a normal OK payload; only a genuine bug rejects → internal_error.
   */
  connect: (_params, ctx): Promise<ConnectResult> => ctx.connect(),
  /**
   * Manage-connections CRUD. Each entry shape-checks its `params` (the boundary
   * passes `params: unknown`) → `bad_request` on a missing/ill-typed field, then
   * delegates to the registry and maps its {@link RegistryResult} to a reply. The
   * registry owns semantic validation (empty name, unparseable url), `not_found`
   * on edit, and `internal_error` on a store-open/write failure.
   */
  "connections.list": (_params, ctx): Preformed => preformed(toReply(ctx.connections.list())),
  "connections.add": (params, ctx): Preformed => {
    const p = asParamsObject(params);
    if (p === null || typeof p.name !== "string" || typeof p.url !== "string") {
      return preformed(errorReply("bad_request", "connections.add requires { name, url }"));
    }
    return preformed(toReply(ctx.connections.add({ name: p.name, url: p.url })));
  },
  "connections.edit": (params, ctx): Preformed => {
    const p = asParamsObject(params);
    if (p === null || typeof p.id !== "string") {
      return preformed(errorReply("bad_request", "connections.edit requires { id }"));
    }
    if (p.name !== undefined && typeof p.name !== "string") {
      return preformed(errorReply("bad_request", "connections.edit name must be a string"));
    }
    if (p.url !== undefined && typeof p.url !== "string") {
      return preformed(errorReply("bad_request", "connections.edit url must be a string"));
    }
    return preformed(
      toReply(
        ctx.connections.edit({
          id: p.id,
          ...(p.name === undefined ? {} : { name: p.name }),
          ...(p.url === undefined ? {} : { url: p.url }),
        }),
      ),
    );
  },
  "connections.remove": (params, ctx): Preformed => {
    const p = asParamsObject(params);
    if (p === null || typeof p.id !== "string") {
      return preformed(errorReply("bad_request", "connections.remove requires { id }"));
    }
    return preformed(toReply(ctx.connections.remove({ id: p.id })));
  },
  /**
   * Workspace-state persistence (Story 2.5). No handler-level shape check here —
   * unlike the connections handlers, ALL validation (including "is this even an
   * object") lives in the registry (`workspace-registry.ts`) so there is exactly
   * one place that names the offending field on a malformed snapshot.
   */
  "workspace.load": (_params, ctx): Preformed => preformed(toReply(ctx.workspace.load())),
  "workspace.save": (params, ctx): Preformed => preformed(toReply(ctx.workspace.save(params))),
};

/**
 * Detect a handler value that is ALREADY a wire reply — by an explicit private
 * `Symbol` brand, NOT a structural `ok` sniff. The connections handlers build a
 * reply directly (so they can emit `bad_request`/`not_found`/`internal_error`) and
 * tag it via {@link preformed}; every other handler returns a raw domain payload.
 * The brand can never collide with a domain payload that happens to carry `ok`.
 */
function isPreformed(value: unknown): value is Preformed {
  return typeof value === "object" && value !== null && PREFORMED in value;
}

/**
 * Dispatch an already-authenticated RPC request. Returns a typed reply. Any
 * handler throw is caught and wrapped as an `internal_error` envelope, so the
 * caller never sees a naked error.
 */
export async function dispatch(
  request: RpcRequest,
  ctx: RpcContext,
): Promise<RpcReply<unknown>> {
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
    // `await` resolves a sync handler's value AND a promise-returning handler's
    // (e.g. `connect`) to a concrete result, so `value` is never a live Promise.
    // The same try/catch now also catches a rejected promise → internal_error.
    const value = await handler(request.params, ctx);
    // A connections handler already produced its own reply (so it can signal
    // bad_request/not_found/internal_error) and branded it; unwrap and dispatch it
    // verbatim. Every other handler returns a raw domain payload → wrap as OK.
    return isPreformed(value) ? value[PREFORMED] : okReply(value);
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
