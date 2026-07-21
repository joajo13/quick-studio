/**
 * quick-studio Core — per-target connection resolver (Story 6.2).
 *
 * A Report may run its query blocks against a saved-connection *target* other than
 * the one the Core bound at boot (FR-19, UJ-4). This module owns that resolution: it
 * turns an optional saved-connection **id** (which is the ONLY thing the UI sends —
 * never a url/credential, AR-12) into the {@link ConnectionSeams} the guarded executor
 * runs over. The boot connection is the default (id null/absent), keeping the
 * untargeted path byte-identical to today.
 *
 * Lifecycle & isolation (why this is a separate, driver-free module):
 *  - **Lazy + cached by id:** a target manager is created on first `resolve(id)` and
 *    memoized, so N re-runs of the same Report reuse ONE live connection.
 *  - **Cache self-invalidation (revocation-correct):** every `resolve` of a cached id
 *    re-reads `getStoredUrl(id)`. If the stored url OR pinned schema now DIFFERS (the
 *    connection was repointed or re-scoped in Settings) the stale manager is
 *    closed+evicted and re-opened at the new url/scope; if it is now absent (the
 *    connection was removed) the manager is
 *    closed+evicted and `not-found` is returned. The registry is the single source of
 *    truth — a cached manager can never keep serving a revoked/edited connection for
 *    the rest of the session.
 *  - **Store-unavailable ≠ unknown-id:** a transient credential-store open failure is
 *    surfaced as `unavailable` (→ `internal_error` at the executor), distinct from a
 *    genuinely unknown id (→ `not-found`), so a valid target during a store blip is
 *    never mislabeled "unknown connection".
 *  - **Shutdown latch:** `closeAll()` closes every opened target manager and latches
 *    `closed`, so a `resolve` racing shutdown returns `not-found` and never opens a new
 *    (leaked) target. The boot manager is owned/closed by the caller (`server.ts`).
 */

import { errorReply, type ConnectResult, type DatabaseSchema, type DbEngine, type RpcReply } from "../shared/contract.ts";
import type { ConnectionManager } from "./connection.ts";
import type { DriverQueryResult } from "./driver.ts";

/**
 * The side-effecting seams a Core read path is built over, bound to ONE connection (the
 * boot manager, or a resolved target). Mirrors the executor's former fixed dep set — now
 * produced per-`resolve` so targeting lives in one place. Story 10.4 widened it past the
 * executor: `connect` (so `table.rows`/`connect` can open a resolved target) and
 * `invalidateSchema` (so a mutation can bust exactly the memo it just invalidated).
 */
export type ConnectionSeams = {
  readonly runQuery: (sql: string, params: ReadonlyArray<unknown>) => Promise<DriverQueryResult>;
  readonly runReadOnly: (sql: string, params: ReadonlyArray<unknown>) => Promise<DriverQueryResult>;
  /**
   * The target's engine. Answered from the CONNECTION (its url scheme), never by
   * re-introspecting the catalog — the engine cannot go stale when a DDL runs, so this
   * seam is unaffected by `invalidateSchema`.
   */
  readonly getEngine: () => Promise<DbEngine>;
  readonly getSchema: () => Promise<DatabaseSchema>;
  readonly quoteIdent: (ident: string) => string;
  /**
   * Open (once) + introspect THIS target, resolving the same neutral {@link ConnectResult}
   * the boot manager already returns — a classified driver failure is a `status:"failed"`
   * payload, never a throw, so no failure-shape logic is duplicated outside `connection.ts`.
   */
  readonly connect: () => Promise<ConnectResult>;
  /**
   * Mark THIS target's memoized schema stale (DW-45) so its next `getSchema`/`connect`
   * re-introspects. Scoped by construction: a caller holding one resolve's seams cannot
   * flush another target's memo (nor the whole pool).
   */
  readonly invalidateSchema: () => void;
};

/**
 * The outcome of a Core-internal id→url lookup. `not-found` (unknown id) is kept
 * DISTINCT from `unavailable` (the credential store itself could not be opened) so a
 * valid target during a transient store failure is not misreported as unknown.
 */
export type StoredUrlLookup =
  | {
      readonly kind: "found";
      readonly url: string;
      /** The record's pinned introspection scope (Story 10.2), absent when unpinned. */
      readonly schema?: string;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly detail: string };

/** The resolver's answer to the executor: the seams to run over, or a typed reason. */
export type ResolvedConnection =
  | { readonly ok: true; readonly seams: ConnectionSeams }
  | { readonly ok: false; readonly reason: "not-found" | "unavailable"; readonly detail?: string };

/** Dependencies for {@link createConnectionTargets}. Every one is a pure DI seam. */
export type ConnectionTargetsDeps = {
  /** The boot connection manager — the default target (id null/absent). */
  readonly bootManager: ConnectionManager;
  /** Core-internal id→url resolution (backed by the same credential store the registry uses). */
  readonly getStoredUrl: (id: string) => StoredUrlLookup;
  /**
   * Lazily construct a connection manager for a target url (driver opens on first
   * use), scoped to the record's pinned `schema` when it has one (Story 10.2).
   */
  readonly createManager: (url: string, schema?: string) => ConnectionManager;
};

/** The live resolver handle returned by {@link createConnectionTargets}. */
export type ConnectionTargets = {
  /**
   * Resolve a saved-connection id (null/absent ⇒ the boot manager) to the seams to run
   * over, re-validating a cached id's url against the registry on every call.
   */
  resolve: (connectionId?: string | null) => ResolvedConnection;
  /** Close every opened target manager and latch shutdown (a later `resolve` ⇒ not-found). */
  closeAll: () => Promise<void>;
};

/** Build the {@link ConnectionSeams} view over a connection manager. */
function seamsFor(manager: ConnectionManager): ConnectionSeams {
  return {
    runQuery: (sql, params) => manager.query(sql, params),
    runReadOnly: (sql, params) => manager.queryReadOnly(sql, params),
    // 1:1, like every other seam — and deliberately NOT `(await manager.getSchema()).engine`:
    // that routed the engine through the memoized (and now bustable) catalog, so every
    // statement following a schema-mutating one paid a full re-introspection to learn a value
    // fixed by the connection's url scheme. `manager.getEngine()` reads it off the connection
    // without honoring the stale flag.
    getEngine: () => manager.getEngine(),
    getSchema: () => manager.getSchema(),
    quoteIdent: (ident) => manager.quoteIdent(ident),
    connect: () => manager.connect(),
    invalidateSchema: () => manager.invalidateSchema(),
  };
}

/**
 * Map a failed {@link ConnectionTargets.resolve} onto its typed wire reply. Lives HERE,
 * beside the `reason` union it translates, so every targeted RPC (`execute`,
 * `table.rows`, `connect`, …) shares ONE mapping instead of copy-pasting the
 * `not-found → not_found` / `unavailable → internal_error` convention until it drifts.
 * Credential-neutral by construction: neither branch echoes an id, a url, or the store's
 * own detail. `RpcReply<never>` is assignable into any `RpcReply<T>` position, so callers
 * need no generic argument.
 */
export function targetError(reason: "not-found" | "unavailable"): RpcReply<never> {
  return reason === "not-found"
    ? errorReply("not_found", "no connection with that id")
    : errorReply("internal_error", "credential store is unavailable");
}

/**
 * Construct the per-target resolver over the injected boot manager + id→url + manager
 * factory. Holds one lazily-opened manager per target id, each tagged with the url it
 * was opened at so a Settings edit/removal invalidates it on the next resolve.
 */
export function createConnectionTargets(deps: ConnectionTargetsDeps): ConnectionTargets {
  const { bootManager, getStoredUrl, createManager } = deps;

  /**
   * A cached target manager + the url AND pinned schema it was opened with (for
   * self-invalidation). The schema is part of the identity because a manager memoizes
   * its introspected schema at the scope it was built with (Story 10.2).
   */
  type Cached = {
    readonly manager: ConnectionManager;
    readonly url: string;
    readonly schema: string | undefined;
  };
  const cache = new Map<string, Cached>();
  // Latched by `closeAll()`: after shutdown begins, no target is opened or served.
  let closed = false;

  /** Close a cached manager best-effort and drop it from the cache. */
  function evict(id: string, entry: Cached | undefined): void {
    if (entry === undefined) return;
    cache.delete(id);
    // Fire-and-forget close; the manager's own `close` swallows teardown errors.
    void entry.manager.close();
  }

  return {
    resolve(connectionId?: string | null): ResolvedConnection {
      // Default (untargeted) path: the boot manager, byte-identical to pre-6.2.
      if (connectionId === null || connectionId === undefined) {
        return { ok: true, seams: seamsFor(bootManager) };
      }
      // After shutdown: never open (or serve) a target — treat as not-found (no leak).
      if (closed) {
        return { ok: false, reason: "not-found" };
      }

      const lookup = getStoredUrl(connectionId);
      if (lookup.kind === "unavailable") {
        // Store blip — do NOT evict a good cached manager; surface a distinct class.
        return { ok: false, reason: "unavailable", detail: lookup.detail };
      }
      if (lookup.kind === "not-found") {
        // The connection was removed — a cached manager must stop serving it.
        evict(connectionId, cache.get(connectionId));
        return { ok: false, reason: "not-found" };
      }

      const existing = cache.get(connectionId);
      if (existing !== undefined) {
        if (existing.url === lookup.url && existing.schema === lookup.schema) {
          // Cache hit, url AND pinned scope unchanged — reuse the live manager.
          return { ok: true, seams: seamsFor(existing.manager) };
        }
        // Repointed OR re-scoped in Settings: close+evict the stale manager and re-open
        // at the new url/scope. The schema comparison is REQUIRED — a manager memoizes
        // its introspected schema, so url-only equality would keep serving the old scope
        // for the rest of the session after a Settings schema edit (Story 10.2).
        evict(connectionId, existing);
      }

      const manager = createManager(lookup.url, lookup.schema);
      cache.set(connectionId, { manager, url: lookup.url, schema: lookup.schema });
      return { ok: true, seams: seamsFor(manager) };
    },

    async closeAll(): Promise<void> {
      closed = true;
      const managers = [...cache.values()].map((c) => c.manager);
      cache.clear();
      // Close every opened target manager; each `close` is best-effort (never throws).
      await Promise.all(managers.map((m) => m.close()));
    },
  };
}
