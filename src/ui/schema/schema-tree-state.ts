/**
 * quick-studio UI (Ring 2) — multi-root schema-tree state (Story 10.5).
 *
 * Every DECISION the multi-root tree makes, extracted DOM-free so it can be unit
 * tested: root-list construction (boot target + saved connections), the key
 * namespacing that keeps two roots from colliding in one expansion Set, the
 * per-root `idle | loading | ready | error` reducer, schema grouping, the
 * single-schema auto-expand convenience, and the registry-refresh reconciliation.
 *
 * Why a separate module: the repo deliberately has no jsdom/testing-library and
 * `renderToStaticMarkup` never runs effects, so anything left inside the component
 * is unverifiable by construction — including this story's central guarantee, that
 * one root's failure provably never touches another's state.
 *
 * Nothing here imports React or touches the DOM; `SchemaTree.tsx` owns the markup
 * and the `rpc` calls, this module owns what they mean.
 */

import type {
  ActiveConnectionInfo,
  ConnectionSummary,
  ConnectResult,
  DatabaseSchema,
  RpcReply,
  SchemaTableInfo,
} from "../../shared/contract.ts";
import { envelopeText } from "../rpc/envelope-text.ts";

/**
 * Sentinel key for the BOOT root (the default target — `connectionId` omitted, AR-12).
 * Safe against collision with a saved connection: saved ids are `randomUUID()`
 * (`connection-registry.ts`), which can never be the literal `"boot"`.
 */
export const BOOT_ROOT_KEY = "boot";

/**
 * Display name for a boot target that IS configured but cannot be described
 * (a url that parses with no host, e.g. `postgres:///shop` — `ConnectionManager.describe()`
 * returns null for it, IG-3/IG-B). The root still renders (in `error`, with Reintentar);
 * it just has no engine/host to show.
 */
export const BOOT_ROOT_FALLBACK_NAME = "boot";

/** Stable per-root key: the saved connection id, or the boot sentinel for the default target. */
export function rootKey(connectionId: string | null): string {
  return connectionId ?? BOOT_ROOT_KEY;
}

/** Root-namespaced schema-node key (`expandedSchemas` membership). */
export function schemaKey(root: string, schema: string): string {
  return `${root}::${schema}`;
}

/** Root-namespaced table key (`expandedTables` membership + React list keys). */
export function tableKey(root: string, schema: string, table: string): string {
  return `${root}::${schema}.${table}`;
}

/**
 * The root part of a namespaced key — everything before the `::` separator, or the
 * whole key when there is none (the un-namespaced `states`/`expandedRoots` keys).
 * The separator cannot appear inside a root key: those are UUIDs or the sentinel.
 */
function rootOfKey(key: string): string {
  const at = key.indexOf("::");
  return at === -1 ? key : key.slice(0, at);
}

/** One rendered connection root: the boot target (`connectionId === null`) or a saved one. */
export type RootDescriptor = {
  /** The Core target this root browses; `null` = the boot manager (the default target). */
  readonly connectionId: string | null;
  /** {@link rootKey} of `connectionId` — the key every per-root store is addressed by. */
  readonly key: string;
  readonly name: string;
  /** Engine tag for the badge (`postgres`/`mysql`); empty when unknown (undescribable boot). */
  readonly engine: string;
  /** `host[:port]` for the trailing slot; empty when unknown. */
  readonly host: string;
  /** Story-10.2 pinned introspection scope, when this connection has one. */
  readonly pinnedSchema?: string;
};

/**
 * A single root's introspection state. Per-root and structurally independent: the
 * component holds these in a `ReadonlyMap` keyed by {@link RootDescriptor.key}, so one
 * root's transition can never read from or blank another's (epics.md 10.5 AC3).
 */
export type RootState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly schema: DatabaseSchema }
  | { readonly kind: "error"; readonly text: string };

/** A schema level inside a `ready` root: its name plus the tables that live in it. */
export type SchemaGroup = {
  readonly schema: string;
  readonly tables: ReadonlyArray<SchemaTableInfo>;
};

/**
 * The boot-target root, or `null` when no boot target is configured at all.
 *
 * `hasTarget` (not `connection !== null`) is what decides existence: `describe()`
 * collapses "nothing configured" and "configured but not describable" into the same
 * `null`, and only the former may contribute no root (IG-3, narrowed by IG-B). A
 * configured-but-undescribable target therefore renders a nameless-but-present root
 * whose own `connect` supplies the Core's engine-neutral verdict.
 */
export function bootDescriptor(active: ActiveConnectionInfo | null): RootDescriptor | null {
  if (active === null || !active.hasTarget) return null;
  const conn = active.connection;
  return {
    connectionId: null,
    key: BOOT_ROOT_KEY,
    // The database name is the most table-of-contents-ish label available; fall back to
    // the host when the url carries no path, and to the sentinel when it carries neither.
    name: conn === null ? BOOT_ROOT_FALLBACK_NAME : (conn.database ?? conn.host),
    engine: conn?.engine ?? "",
    host: conn?.host ?? "",
  };
}

/** One saved connection's root — always `idle` until the user expands it (never at mount). */
function savedDescriptor(summary: ConnectionSummary): RootDescriptor {
  return {
    connectionId: summary.id,
    key: rootKey(summary.id),
    name: summary.name,
    engine: summary.engine,
    host: summary.host,
    // Carried ONLY when the summary actually has a pin — the badge is absence-driven.
    ...(summary.schema === undefined ? {} : { pinnedSchema: summary.schema }),
  };
}

/**
 * The rendered root list: the boot target FIRST (it is the default target, AR-12, and
 * the only root that introspects at mount), then one root per saved connection in
 * registry order. An empty result is what the "Sin conexión activa" empty-state keys off.
 */
export function buildRoots(
  active: ActiveConnectionInfo | null,
  summaries: ReadonlyArray<ConnectionSummary>,
): ReadonlyArray<RootDescriptor> {
  const boot = bootDescriptor(active);
  const saved = summaries.map(savedDescriptor);
  return boot === null ? saved : [boot, ...saved];
}

/**
 * Group a root's flat `DatabaseSchema.tables` into the collapsible schema level
 * (`connection → schema → tables`), preserving introspection order for both the
 * schemas (first-seen) and the tables inside each.
 */
export function groupBySchema(tables: ReadonlyArray<SchemaTableInfo>): ReadonlyArray<SchemaGroup> {
  const order: string[] = [];
  const byName = new Map<string, SchemaTableInfo[]>();
  for (const t of tables) {
    const bucket = byName.get(t.schema);
    if (bucket === undefined) {
      order.push(t.schema);
      byName.set(t.schema, [t]);
    } else {
      bucket.push(t);
    }
  }
  return order.map((schema) => ({ schema, tables: byName.get(schema) ?? [] }));
}

/**
 * Merge the introspected tables with the optimistically-created ones, deduped by
 * `schema.name` (introspected truth wins if the same table is somehow present both
 * ways — e.g. after a reconnect that reset nothing). Preserves introspection order,
 * appending only genuinely-new optimistic entries. Moved verbatim from `SchemaTree.tsx`;
 * only the BOOT root merges these (DW-41 — created tables can only belong to the
 * default target, since create-table still executes id-less).
 */
export function mergeTables(
  loaded: ReadonlyArray<SchemaTableInfo>,
  extra: ReadonlyArray<SchemaTableInfo>,
): ReadonlyArray<SchemaTableInfo> {
  if (extra.length === 0) return loaded;
  const seen = new Set(loaded.map((t) => `${t.schema}.${t.name}`));
  const appended = extra.filter((t) => !seen.has(`${t.schema}.${t.name}`));
  return appended.length === 0 ? loaded : [...loaded, ...appended];
}

/**
 * Map one root's `connect` reply into that root's next state. Note both failure shapes
 * land on `error`: a transport envelope (`!ok`) via {@link envelopeText}, and a classified
 * driver failure (`status:"failed"`) via the terse `` `${failure}: ${message}` `` template
 * the single-root tree already used. Even `no-target` is a real per-root error here — a
 * root only EXISTS because `connection.active`/`connections.list` already proved a target
 * did, so `no-target` means it vanished mid-session, never the calm empty-state.
 */
export function connectStateFromReply(reply: RpcReply<ConnectResult>): RootState {
  if (!reply.ok) return { kind: "error", text: envelopeText(reply.error) };
  if (reply.result.status === "failed") {
    return { kind: "error", text: `${reply.result.failure}: ${reply.result.message}` };
  }
  return { kind: "ready", schema: reply.result.schema };
}

/**
 * Whether expanding a root should introspect. ONLY an `idle` root fetches: a `ready` or
 * `error` root re-shows its cached state on re-expand (no second `connect`, no automatic
 * re-attempt against an unreachable host — only the explicit "Reintentar" bypasses this),
 * and a `loading` root already has one in flight.
 */
export function shouldFetchOnExpand(state: RootState): boolean {
  return state.kind === "idle";
}

/**
 * The schema keys to auto-expand when a root first reaches `ready`: exactly one when the
 * root returned a single schema (the common `public`-only — and every pinned-schema —
 * case, which must not need a forced second click), none when it returned several (a
 * multi-schema root stays collapsed so it scales to a thousand-table catalog).
 */
export function autoExpandKeys(
  root: string,
  groups: ReadonlyArray<SchemaGroup>,
): ReadonlyArray<string> {
  const only = groups.length === 1 ? groups[0] : undefined;
  return only === undefined ? [] : [schemaKey(root, only.schema)];
}

/**
 * Drop every entry whose owning root is gone (REGISTRY-DRIVEN REFRESH, IG-A): a removed
 * connection takes its cached state with it. Surviving roots are untouched — the same
 * value under the same key, so a refresh can never re-introspect, collapse, or blank a
 * root the user already opened. Returns the SAME reference when nothing was pruned.
 */
export function pruneByRoot<T>(
  entries: ReadonlyMap<string, T>,
  liveRoots: ReadonlySet<string>,
): ReadonlyMap<string, T> {
  const dead: string[] = [];
  for (const key of entries.keys()) {
    if (!liveRoots.has(rootOfKey(key))) dead.push(key);
  }
  if (dead.length === 0) return entries;
  const next = new Map(entries);
  for (const key of dead) next.delete(key);
  return next;
}

/**
 * The root keys a root-list reader may KEEP cached state for: every live root, MINUS every
 * connection whose saved record was repointed (its url and/or its pinned schema changed in
 * Settings) and whose cache has not actually been dropped yet.
 *
 * An edit keeps the connection's id, so the plain liveness rule above — which only drops
 * roots that are GONE — leaves a repointed root standing with the catalog of the database
 * it used to point at, and nothing can ever refetch it: `shouldFetchOnExpand` fetches only
 * from `idle`, and "Reintentar" is rendered only for a root in `error`. Excluding it here
 * hands it to {@link pruneByRoot}/{@link pruneSetByRoot} as if it were removed, which
 * returns it to collapsed `idle` — the one state that re-introspects on the next expand.
 *
 * This mirrors what Core already does one layer down: `connection-targets.ts` closes and
 * evicts a cached manager whose stored url or pinned schema no longer matches the registry.
 * A name-only edit contributes no id and changes nothing — the target is the same database,
 * so collapsing that root would cost a click and buy nothing.
 *
 * A SET, not one id, because the invalidation is DURABLE STATE rather than an event: the
 * reader that learned about a repoint may never reach a commit (its `connections.list` can
 * fail, or a newer read can supersede it), so ids must accumulate until a reconciliation
 * actually applies them — otherwise the stale catalog outlives the only signal about it.
 * Ids naming no live root simply do not appear in the result, so a connection repointed and
 * then removed needs no special case.
 */
export function retainedRoots(
  roots: ReadonlyArray<RootDescriptor>,
  repointedConnectionIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const live = new Set(roots.map((r) => r.key));
  // Only ever SAVED connections' ids (Settings edits no other kind of record), so this
  // can never delete the boot sentinel — the boot target has no registry record to edit.
  for (const id of repointedConnectionIds) live.delete(rootKey(id));
  return live;
}

/** {@link pruneByRoot} for the expansion Sets (root, schema and table keys alike). */
export function pruneSetByRoot(
  keys: ReadonlySet<string>,
  liveRoots: ReadonlySet<string>,
): ReadonlySet<string> {
  const dead: string[] = [];
  for (const key of keys) {
    if (!liveRoots.has(rootOfKey(key))) dead.push(key);
  }
  if (dead.length === 0) return keys;
  const next = new Set(keys);
  for (const key of dead) next.delete(key);
  return next;
}
