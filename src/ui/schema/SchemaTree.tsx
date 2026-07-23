/**
 * quick-studio UI (Ring 2) — schema tree.
 *
 * The left-region schema browser (Story 3.2). Since Story 10.5 it is MULTI-ROOT,
 * DBeaver-style: one collapsible root per saved connection (`connections.list`) plus
 * one for the boot target when one is configured (`connection.active`), and inside a
 * root the tables sit under a collapsible SCHEMA level — `connection → schema → tables`
 * (a Postgres/MySQL catalog has many schemas, so it is a level, not a caption).
 *
 * Introspection is LAZY per saved root: expanding an `idle` root fires exactly one
 * `connect{connectionId}` (Story 10.4); re-expanding a `ready`/`error` root re-shows the
 * cached state with no second call, so twenty saved connections never mean twenty
 * handshakes at boot. The ONE exception is the boot root, which auto-expands and
 * introspects at mount via the paramless `rpc("connect")` exactly as the single-root tree
 * always did (AR-12 byte-for-byte, and load-bearing: that call is what populates
 * `App.tsx`'s `schemaTables` for the ERD, the create-table schema selector, and PK
 * resolution). Per-root state is a keyed map, so one root's error can never blank,
 * delay, or dim another — a single unreachable host cannot tank the tree.
 *
 * Every DECISION lives in the DOM-free `schema-tree-state.ts` (root construction, key
 * namespacing, the reply→state reducer, grouping, auto-expand, refresh reconciliation)
 * and the per-root markup in the exported presentational `ConnectionRoot`, because the
 * repo has no jsdom and `renderToStaticMarkup` never runs effects — logic left inside
 * the component would be untestable by construction.
 *
 * Follows the established client pattern: `alive`-guarded effects, branch on `reply.ok`,
 * and surface `reply.error` in-panel (never console-only). Keyboard operability is total:
 * root headers, schema nodes and table rows are all `role="button"`/`tabindex=0` with
 * Enter/Space — no mouse-only path anywhere in the tree.
 */

import { useEffect, useRef, useState } from "react";
import type {
  ActiveConnectionInfo,
  ConnectionSummary,
  ConnectResult,
  ListConnectionsResult,
  RpcErrorEnvelope,
  SchemaTableInfo,
} from "../../shared/contract.ts";
import type { TableRef } from "../workspace/workspace-state.ts";
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";
import {
  autoExpandKeys,
  buildRoots,
  connectStateFromReply,
  groupBySchema,
  mergeTables,
  pruneByRoot,
  pruneSetByRoot,
  retainedRoots,
  schemaKey,
  shouldFetchOnExpand,
  tableKey,
  type RootDescriptor,
  type RootState,
} from "./schema-tree-state.ts";

/**
 * The TREE-level phase — about the ROOT LIST, never about any single root's
 * introspection (that is {@link RootState}, one per root). `error` is reserved for the
 * case where no root list can be built at all: `connections.list` failed AND no boot
 * target exists. When a boot target DOES exist, a failed registry read degrades to the
 * non-fatal `warning` instead, because an ephemeral session never uses the credential
 * registry and its working tree must not die for it (IG-4).
 */
type TreePhase =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly text: string }
  | {
      readonly kind: "roots";
      readonly roots: ReadonlyArray<RootDescriptor>;
      readonly warning: string | null;
    };

/** The idle default for a root that has never been expanded (absence in the map = idle). */
const IDLE: RootState = { kind: "idle" };

/**
 * The ONE wording for "the saved-connection registry could not be read" (IG-4), used by
 * both the mount read and every registry refresh so the two can never drift apart.
 */
function registryWarning(error: RpcErrorEnvelope): string {
  return `no se pudieron cargar las conexiones guardadas — ${envelopeText(error)}`;
}

/** The same, for a failed `connection.active` (the boot-target read). */
function bootTargetWarning(error: RpcErrorEnvelope): string {
  return `no se pudo leer la conexión de arranque — ${envelopeText(error)}`;
}

/**
 * The single non-fatal warning line for the mount reads. BOTH mount calls are pure reads
 * that degrade rather than tank the tree, so both must still be VISIBLE when they fail:
 * a silently-degraded `connection.active` next to an empty registry paints the calm
 * "Sin conexión activa" empty-state, which tells the user nothing is configured when in
 * fact a transport read broke — and leaves `App.tsx`'s `schemaTables` empty (dead ERD,
 * empty create-table schema list, unresolvable PKs) for the whole session.
 *
 * At most ONE line is ever produced — never two stacked paragraphs. A failed
 * `connection.active` wins, because "we don't know whether there is a boot target" is the
 * more consequential of the two degradations. The both-failed case never reaches here at
 * all: no boot target AND no registry means no root list can be built, which the caller
 * already turns into the whole-tree `error` phase (IG-4).
 */
function mountWarning(
  activeError: RpcErrorEnvelope | null,
  listError: RpcErrorEnvelope | null,
): string | null {
  if (activeError !== null) return bootTargetWarning(activeError);
  if (listError !== null) return registryWarning(listError);
  return null;
}

/** Chevron (collapsed → points right; expanded → rotated to point down). */
function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      className={`h-[11px] w-[11px] shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** Table-row leading icon. */
function TableIcon({ className }: { className: string }): React.JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      className={`h-3.5 w-3.5 shrink-0 ${className}`}
    >
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  );
}

/** Schema-node leading icon (the mockup's folder glyph on the intermediate level). */
function SchemaIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      className="h-[13px] w-[13px] shrink-0 text-t-time opacity-90"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/**
 * Classify a column's engine-verbatim `dataType` into one of the neutral shell's
 * type-color buckets (`--t-int`/`-time`/`-bool`/`-json`/`-text`). Presentation-only
 * derived classification — the underlying `dataType` string is never rewritten.
 */
function typeDotClass(dataType: string): string {
  const t = dataType.toLowerCase();
  if (/bool/.test(t)) return "bg-t-bool";
  if (/time|date|interval/.test(t)) return "bg-t-time";
  // `time|date|interval` and `bool` are already handled above, so a plain
  // substring test is safe here and — unlike an anchored `\bint` — also catches
  // the prefixed integer families (`bigint`/`smallint`/`mediumint`/`tinyint`,
  // `bigserial`/`smallserial`). `\bint` still admits bare `int`/`integer`/`int4`.
  if (/\bint|serial|(?:big|small|medium|tiny)int/.test(t)) return "bg-t-int";
  if (/numeric|decimal|float|double|real|json|money/.test(t)) return "bg-t-json";
  return "bg-t-text";
}

/** Per-phase status-dot classes (the mockup's `.status-dot` ok/err/loading/idle). */
function statusDotClass(state: RootState): string {
  switch (state.kind) {
    case "ready":
      return "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]";
    case "error":
      return "bg-err shadow-[0_0_0_3px_var(--err-soft)]";
    case "loading":
      return "bg-muted-foreground animate-pulse motion-reduce:animate-none";
    case "idle":
      return "bg-muted-foreground";
  }
}

/** Shared Enter/Space activation for the three keyboard-operable row kinds. */
function onRowKeyDown(run: () => void): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  };
}

/**
 * ONE connection root, rendered from explicit props only — no effects, no `rpc`, no
 * internal state. Exported so every visual state (collapsed idle / loading /
 * error+Reintentar / ready with its schema nodes, tables and columns) is assertable
 * under `renderToStaticMarkup`, which cannot reach state produced by effects.
 */
export function ConnectionRoot({
  descriptor,
  state,
  open,
  expandedSchemas,
  expandedTables,
  activeTable,
  extraTables = [],
  onToggleRoot,
  onToggleSchema,
  onRetry,
  onActivate,
}: {
  descriptor: RootDescriptor;
  /** This root's own introspection state — structurally independent of every other root. */
  state: RootState;
  open: boolean;
  /** Root-namespaced schema keys currently expanded (`schemaKey`). */
  expandedSchemas: ReadonlySet<string>;
  /** Root-namespaced table keys whose column list is disclosed (`tableKey`). */
  expandedTables: ReadonlySet<string>;
  /** The currently-bound table (drives the single `.on` highlight), or null. */
  activeTable: TableRef | null;
  /** Optimistically-created tables — merged into the BOOT root only (DW-41). */
  extraTables?: ReadonlyArray<SchemaTableInfo>;
  onToggleRoot: (descriptor: RootDescriptor) => void;
  onToggleSchema: (key: string) => void;
  onRetry: (descriptor: RootDescriptor) => void;
  onActivate: (table: SchemaTableInfo, connectionId: string | null, key: string) => void;
}): React.JSX.Element {
  const root = descriptor.key;
  // Created tables can only ever belong to the DEFAULT target (create-table still
  // executes id-less), so they are scoped to the boot root instead of leaking into
  // every root as phantoms — the first half of DW-41.
  const tables =
    state.kind === "ready"
      ? descriptor.connectionId === null
        ? mergeTables(state.schema.tables, extraTables)
        : state.schema.tables
      : [];
  const groups = groupBySchema(tables);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => onToggleRoot(descriptor)}
        onKeyDown={onRowKeyDown(() => onToggleRoot(descriptor))}
        title={descriptor.host === "" ? descriptor.name : `${descriptor.name} · ${descriptor.host}`}
        className="mx-1.5 my-px flex cursor-pointer select-none items-center gap-[7px] rounded-[var(--radius)] py-2 pl-2 pr-1.5 text-[12.5px] text-foreground transition-colors hover:bg-muted"
      >
        <Chevron open={open} />
        <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${statusDotClass(state)}`} />
        <span className="truncate font-semibold">{descriptor.name}</span>
        {descriptor.engine === "" ? null : (
          <span className="shrink-0 rounded-[4px] border border-border px-1 py-px text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
            {descriptor.engine}
          </span>
        )}
        {descriptor.pinnedSchema === undefined ? null : (
          // Story-10.2 pinned scope: introspection came back scoped to this one schema.
          <span
            title={`schema pineado: ${descriptor.pinnedSchema}`}
            className="inline-flex shrink-0 items-center gap-[3px] rounded-[4px] bg-coral-soft px-[5px] py-px text-[9px] text-coral"
          >
            ⚲ {descriptor.pinnedSchema}
          </span>
        )}
        {descriptor.host === "" || descriptor.host === descriptor.name ? null : (
          <span className="ml-auto shrink-0 truncate pl-1.5 text-[10px] text-muted-foreground opacity-80">
            {descriptor.host}
          </span>
        )}
      </div>

      {!open ? null : state.kind === "loading" ? (
        <p className="py-2 pl-11 pr-3 text-[11px] lowercase text-muted-foreground">introspecting…</p>
      ) : state.kind === "error" ? (
        <>
          <p role="alert" className="py-2 pl-[26px] pr-3 text-[11px] text-err">
            {state.text}
          </p>
          <button
            type="button"
            onClick={() => onRetry(descriptor)}
            className="mb-1.5 ml-[26px] rounded-[var(--radius)] border border-border px-2.5 py-[3px] text-[11px] text-foreground transition-colors hover:bg-muted"
          >
            Reintentar
          </button>
        </>
      ) : state.kind === "idle" ? null : groups.length === 0 ? (
        <p className="py-2 pl-11 pr-3 text-[11px] lowercase text-muted-foreground">no tables</p>
      ) : (
        <ul className="flex flex-col">
          {groups.map((group) => {
            const sKey = schemaKey(root, group.schema);
            const sOpen = expandedSchemas.has(sKey);
            // A BLANK schema name means "the connection's default namespace" — the shape
            // an optimistically-created table carries when it was created without one
            // (`App.tsx`'s schema selector skips it for the same reason). Rendered raw it
            // produced a nameless, tooltip-less node: a clickable row with no label at all.
            const sLabel = group.schema === "" ? "(default)" : group.schema;
            return (
              <li key={sKey}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={sOpen}
                  onClick={() => onToggleSchema(sKey)}
                  onKeyDown={onRowKeyDown(() => onToggleSchema(sKey))}
                  title={sLabel}
                  className="mx-1.5 my-px flex cursor-pointer select-none items-center gap-[7px] rounded-[var(--radius)] py-1.5 pl-6 pr-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted"
                >
                  <Chevron open={sOpen} />
                  <SchemaIcon />
                  <span className="truncate font-medium text-foreground">{sLabel}</span>
                  {group.schema === "public" ? (
                    <span className="shrink-0 text-[9px] uppercase tracking-[0.04em] opacity-70">default</span>
                  ) : null}
                  <span className="ml-auto shrink-0 text-[10px] opacity-70">{group.tables.length}</span>
                </div>

                {sOpen ? (
                  <ul className="flex flex-col">
                    {group.tables.map((table) => {
                      const key = tableKey(root, table.schema, table.name);
                      // The bound tab carries its owning root's target since Story 10.5, so
                      // the highlight is EXACT: a same-named table in another root never
                      // lights up alongside this one.
                      const on =
                        activeTable !== null &&
                        activeTable.schema === table.schema &&
                        activeTable.name === table.name &&
                        (activeTable.connectionId ?? null) === descriptor.connectionId;
                      const tOpen = expandedTables.has(key);
                      const hasColumns = table.columns.length > 0;
                      const activate = (): void => onActivate(table, descriptor.connectionId, key);
                      return (
                        <li key={key}>
                          <div
                            role="button"
                            tabIndex={0}
                            aria-pressed={on}
                            aria-expanded={hasColumns ? tOpen : undefined}
                            onClick={activate}
                            onKeyDown={onRowKeyDown(activate)}
                            title={`${table.schema}.${table.name}`}
                            className={[
                              "mx-1.5 my-px flex cursor-pointer select-none items-center gap-[7px] rounded-[var(--radius)] py-1.5 pl-11 pr-2.5 text-[12.5px] transition-colors",
                              on
                                ? "bg-coral-soft text-coral"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground",
                            ].join(" ")}
                          >
                            <TableIcon className={on ? "text-coral" : "text-muted-foreground"} />
                            <span className="truncate">{table.name}</span>
                            <span className="ml-auto shrink-0 text-[10px] opacity-70">
                              {table.columns.length}
                            </span>
                          </div>

                          {tOpen && hasColumns ? (
                            <ul className="flex flex-col gap-0.5 py-0.5 pl-[62px] pr-1.5">
                              {table.columns.map((col) => {
                                const isPk = table.primaryKey.includes(col.name);
                                return (
                                  <li
                                    key={col.name}
                                    className="flex cursor-default items-center gap-2 rounded px-1.5 py-1 text-[11.5px] text-muted-foreground hover:bg-muted"
                                  >
                                    <span
                                      aria-hidden
                                      className={`h-1.5 w-1.5 shrink-0 rounded-[1px] ${isPk ? "bg-t-key" : typeDotClass(col.dataType)}`}
                                    />
                                    <span className={`truncate ${isPk ? "text-t-key" : "text-foreground"}`}>
                                      {col.name}
                                    </span>
                                    <span className="ml-auto shrink-0 text-[9.5px] tracking-wide text-muted-foreground">
                                      {col.dataType}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function SchemaTree({
  activeTable,
  onActivate,
  onSchemaLoaded,
  extraTables = [],
  registryRevision = 0,
  repointedConnectionId = null,
}: {
  /** The currently-bound table (drives the single `.on` highlight), or null. */
  activeTable: TableRef | null;
  /**
   * Fired when a table is activated (click or Enter/Space), carrying the OWNING ROOT's
   * target (`null` = the boot root). The bound tab retains that id and sends it with
   * every Core call it makes — reads and writes alike — so the rows come from the
   * database the user actually clicked in and a write can never land in another one.
   */
  onActivate: (table: SchemaTableInfo, connectionId: string | null) => void;
  /**
   * Fired on every `ready` TRANSITION of a root, carrying that root's tables plus its
   * target. In practice that is once per root — a cache-hit re-expand never re-fetches,
   * so it never re-fires — with ONE exception: a successful "Reintentar" is a genuine new
   * introspection and DOES fire it again, deliberately, since that is what refreshes
   * `schemaTables` after a boot-root retry. Callers that describe the boot target only —
   * the ERD, PK/index lookups, the create-table schema selector — must accept
   * `connectionId === null` alone.
   */
  onSchemaLoaded?: (tables: ReadonlyArray<SchemaTableInfo>, connectionId: string | null) => void;
  /**
   * Optimistically-created tables (Story 3.4) appended to the introspected list so a
   * freshly-created table appears with no re-introspection (the Core's connect-time
   * schema is memoized). Deduped by `schema.name` against the loaded tables, and merged
   * into the BOOT root only (DW-41) — create-table still executes against the default
   * target, so a created table can belong to no other root.
   */
  extraTables?: ReadonlyArray<SchemaTableInfo>;
  /**
   * Bumped by the shell whenever the connection registry mutates (a connection saved,
   * edited or removed in Settings). Each bump re-reads `connections.list` and RECONCILES
   * the roots: a new summary arrives as a fresh `idle` collapsed root, a removed one
   * takes its root and cached state with it, and every surviving root keeps its cached
   * AND expand state verbatim — a refresh never re-introspects, collapses, or blanks a
   * root the user already opened. `0` is the mount value and fetches nothing extra.
   */
  registryRevision?: number;
  /**
   * The saved connection whose record the mutation behind this `registryRevision`
   * REPOINTED — its url and/or its pinned schema changed — or `null` when that mutation
   * added a connection, removed one, or only renamed one.
   *
   * An edit keeps the connection's id, so the root survives reconciliation with the cached
   * catalog of the database it used to point at, and no path can refetch it (a `ready` root
   * renders no "Reintentar" and re-expanding is a cache hit). Naming the repointed id lets
   * the refresh drop exactly that one root's state — the same thing Core does one layer
   * down, where `connection-targets.ts` evicts a cached manager whose stored url or pinned
   * schema no longer matches the registry.
   */
  repointedConnectionId?: string | null;
}): React.JSX.Element {
  const [phase, setPhase] = useState<TreePhase>({ kind: "loading" });
  // Per-root introspection state, keyed by `RootDescriptor.key`. A Map (not a field on
  // the descriptor) is what makes per-root isolation STRUCTURAL: every write is a
  // functional update touching exactly ONE key, so no root's transition can read from
  // or blank another's — mirroring the `expanded: ReadonlySet<string>` pattern below.
  const [states, setStates] = useState<ReadonlyMap<string, RootState>>(new Map());
  // Three independent visibility Sets — root open, schema-node open, and per-table
  // column disclosure. All keys are root-namespaced (`rootKey`/`schemaKey`/`tableKey`)
  // so a table named `public.orders` under two different roots can never collide.
  const [expandedRoots, setExpandedRoots] = useState<ReadonlySet<string>>(new Set());
  const [expandedSchemas, setExpandedSchemas] = useState<ReadonlySet<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<ReadonlySet<string>>(new Set());
  // The last SUCCESSFUL `connection.active` reply, held so a later registry refresh can
  // rebuild the root list without re-asking (the boot target cannot change mid-session:
  // it is a CLI/env boot argument, not a registry entry). Only ever written from an `ok`
  // reply — a failed pure read means "unknown", never "there is no boot target", and
  // demoting it would delete a live, already-introspected boot root (see `loadTree`).
  const activeRef = useRef<ActiveConnectionInfo | null>(null);
  // The same for the last SUCCESSFUL `connections.list`. The refresh effect already
  // leaves the roots standing when its re-read fails (IG-4); retaining the summaries is
  // what lets the RETRY path honour the same rule instead of rebuilding from `[]` and
  // wiping every saved root over one transient failure.
  const summariesRef = useRef<ReadonlyArray<ConnectionSummary>>([]);
  // Monotonic token shared by BOTH root-list readers (`loadTree` and the registry
  // refresh). They race — a "Reintentar" in flight when a Settings save bumps the
  // revision — and both end in an unconditional `setPhase`, so without an ordering the
  // older reply can land last and drop the just-saved connection with no further bump
  // to recover from. Only the newest issued read may commit.
  const treeSeqRef = useRef(0);
  // The same discipline PER ROOT: `loadRoot`'s issue counter, keyed by `RootDescriptor.key`.
  // Never reset or pruned — that is the point. A key that is deleted and later re-created
  // (the repoint path is the only one that does this) keeps its counter, so a `connect`
  // issued before the repoint can be recognised as superseded by the one issued after,
  // instead of being waved through by a presence test that the re-creation just made true.
  const rootSeqRef = useRef<Map<string, number>>(new Map());
  // `states` mirrored into a ref, written through `updateStates` so the two can never
  // drift. A functional `setState` updater runs during the NEXT render, so its result
  // cannot be read at the call site — and an in-flight `connect` needs exactly that
  // read to know whether its root is still alive (see `loadRoot`).
  const statesRef = useRef<ReadonlyMap<string, RootState>>(new Map());
  // The boot-target read's warning, held across REFRESHES. A registry refresh rebuilds
  // `phase` wholesale, and without this the first Settings save would wipe a live
  // "no se pudo leer la conexión de arranque" line while the degradation behind it (no
  // boot root, and therefore an empty `schemaTables`) is still very much in force —
  // leaving a tree that looks healthy on top of a dead ERD.
  const bootWarningRef = useRef<string | null>(null);
  // Connections repointed in Settings whose cached catalog has NOT been dropped yet. A ref,
  // and additive, because the invalidation is durable state, not an event: the refresh that
  // learns of a repoint can fail its own `connections.list`, be superseded by a tree-level
  // "Reintentar", or be torn down by the next mutation — and a stale catalog that outlives
  // its only signal is exactly the wrong-database read this exists to stop. Ids stay here
  // until a reconciliation actually prunes them, and BOTH root-list readers apply them.
  const pendingRepointRef = useRef<ReadonlySet<string>>(new Set());
  const updateStates = (
    next: (cur: ReadonlyMap<string, RootState>) => ReadonlyMap<string, RootState>,
  ): void => {
    statesRef.current = next(statesRef.current);
    setStates(statesRef.current);
  };
  // Component-alive guard for the `setState`s of fetches started by a CLICK (which
  // outlive no effect of their own). Re-armed on mount so React's StrictMode
  // double-invoke leaves it true.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Introspect ONE root. Writes only that root's key, so a slow or failing root never
   * touches a sibling. The boot root sends the PARAMLESS `connect` — absent and `null`
   * `connectionId` resolve identically in Core, but AR-12's "byte-for-byte unchanged"
   * is about the wire, and omitting the params object keeps that literally true.
   */
  const loadRoot = (descriptor: RootDescriptor): void => {
    // One handshake at a time per root. `toggleRoot` gates on `shouldFetchOnExpand`, but
    // "Reintentar" deliberately bypasses that gate (it must be able to re-fetch an
    // `error`/`ready` root), so the only guard covering EVERY entry point is here: two
    // activations inside a single frame — a double-tap, or Enter fired twice before the
    // `loading` commit repaints the button away — would otherwise issue two concurrent
    // `connect`s whose reply order decides the surviving state, and fire `onSchemaLoaded`
    // twice for the boot root.
    if (statesRef.current.get(descriptor.key)?.kind === "loading") return;
    // IDENTITY, not just presence. The `loading` bail above orders two activations of one
    // key against each other only while the key SURVIVES; a repoint deletes a live root's
    // `loading` entry (`retainedRoots`) and the very same id can then be re-expanded, so
    // two `connect`s for one key really can be in flight and the later-landing one wins.
    // A per-root monotonic token settles that by identity: only the newest issued fetch for
    // this key may commit, so a slow pre-repoint reply can never paint the OLD database's
    // catalog over the new target's — the tree's own `treeSeqRef` discipline, per root.
    const seq = (rootSeqRef.current.get(descriptor.key) ?? 0) + 1;
    rootSeqRef.current.set(descriptor.key, seq);
    updateStates((cur) => new Map(cur).set(descriptor.key, { kind: "loading" }));
    void rpc<ConnectResult>(
      "connect",
      descriptor.connectionId === null ? undefined : { connectionId: descriptor.connectionId },
    ).then((reply) => {
      if (!alive.current) return;
      // Superseded by a newer fetch for this same root (the repoint-then-re-expand race).
      if (rootSeqRef.current.get(descriptor.key) !== seq) return;
      // LIVENESS: the root may have been PRUNED while this `connect` was in flight (the
      // user removed that connection in Settings). `loadRoot` writes this key as
      // `loading` before firing and `pruneByRoot` deletes it on removal, so "the key is
      // still present" is exactly the liveness test — without it the reply resurrects a
      // dead root's state and seeds dead keys into `expandedSchemas`, and no later prune
      // ever cleans them up. It stays alongside the token because it answers a different
      // question: the token orders fetches, this one asks whether the root exists at all
      // (a removal issues no new fetch, so its token never advances). The boot root is
      // never pruned, so it always passes.
      if (!statesRef.current.has(descriptor.key)) return;
      const next = connectStateFromReply(reply);
      updateStates((cur) => (cur.has(descriptor.key) ? new Map(cur).set(descriptor.key, next) : cur));
      if (next.kind !== "ready") return;
      // Convenience (user-confirmed): a root that came back with exactly one schema
      // opens it, so the common `public`-only — and every pinned — case needs no
      // forced second click. A multi-schema root stays collapsed so it scales.
      const auto = autoExpandKeys(descriptor.key, groupBySchema(next.schema.tables));
      if (auto.length > 0) {
        setExpandedSchemas((cur) => {
          const set = new Set(cur);
          for (const key of auto) set.add(key);
          return set;
        });
      }
      onSchemaLoaded?.(next.schema.tables, descriptor.connectionId);
    });
  };

  /**
   * BOOT-ROOT MOUNT EXCEPTION (AR-12): the default target auto-expands and introspects,
   * exactly as the single-root tree always did. It is the ONLY root that does, and
   * `App.tsx`'s `schemaTables` (ERD, create-table schemas, PK resolution) depends on it.
   *
   * Shared by BOTH root-list readers, because either can be the one that first puts a boot
   * root on the tree: `loadTree` at mount (and on a retry that recovers a failed read), and
   * the registry refresh whenever it commits a root list `loadTree` learned the boot target
   * for but was superseded before it could act on (see the retention above the ordering
   * guard). A boot root that appears without introspecting leaves `schemaTables` empty for
   * the whole session — the exact degradation this exception exists to prevent.
   *
   * The EXPANSION is gated by the same `idle`-only rule as the fetch, not applied
   * unconditionally: a `ready` boot root must neither re-handshake nor be forced back open,
   * and re-expanding a 400-table root the user deliberately collapsed (to reach the saved
   * roots below it, say, and then hit the tree-level "Reintentar") undoes their own action.
   */
  const ensureBootRoot = (roots: ReadonlyArray<RootDescriptor>): void => {
    const boot = roots.find((r) => r.connectionId === null);
    if (boot === undefined) return;
    if (!shouldFetchOnExpand(statesRef.current.get(boot.key) ?? IDLE)) return;
    setExpandedRoots((cur) => (cur.has(boot.key) ? cur : new Set(cur).add(boot.key)));
    loadRoot(boot);
  };

  /**
   * The ONE reconciliation both root-list readers run once they hold an authoritative root
   * list: drop every entry whose root is gone (a removed connection) or whose target moved
   * out from under it (a repointed one), then honour the boot-root mount exception.
   *
   * Sharing it is what makes the repoint invalidation durable. Applied ids are cleared only
   * HERE, after the prune they caused has actually been committed — so a repoint whose own
   * refresh never got to commit is still applied by whatever reader commits next, including
   * the tree-level "Reintentar" that used to prune with a repoint-blind liveness set and so
   * looked like a recovery path while provably not being one.
   */
  const reconcile = (roots: ReadonlyArray<RootDescriptor>): void => {
    const keep = retainedRoots(roots, pendingRepointRef.current);
    pendingRepointRef.current = new Set();
    updateStates((cur) => pruneByRoot(cur, keep));
    setExpandedRoots((cur) => pruneSetByRoot(cur, keep));
    setExpandedSchemas((cur) => pruneSetByRoot(cur, keep));
    setExpandedTables((cur) => pruneSetByRoot(cur, keep));
    ensureBootRoot(roots);
  };

  /**
   * Contribute the boot root a SUPERSEDED `loadTree` proved exists. `connection.active` has
   * exactly one reader, so when the refresh commits its root list first — it can, the two
   * readers race in both directions — it builds from `activeRef === null` and the boot root
   * is simply absent, with `schemaTables` empty for the session and (since the warning was
   * never written either) no line on screen and no Reintentar to click. Retaining `activeRef`
   * above the ordering guard is only half the fix; this is the other half: splice the one
   * root the newer reader could not know about into the list it committed, without touching
   * the saved-connection half it owns.
   */
  const adoptBootRoot = (): void => {
    const active = activeRef.current;
    if (active === null || !active.hasTarget) return;
    // Built from the FRESHEST known registry, which is whatever the newer reader just
    // stored — so this is that reader's own list with the boot root spliced back in front,
    // never an older one resurrected.
    const roots = buildRoots(active, summariesRef.current);
    setPhase((cur) =>
      cur.kind === "roots" && !cur.roots.some((r) => r.connectionId === null)
        ? { ...cur, roots }
        : cur,
    );
    // Full reconciliation, not just the boot exception: this can be the last commit of the
    // sequence, and banked repoints must not be left waiting on a reader that never comes.
    // Idempotent against the newer reader's own prune (both `prune*` return the same
    // reference when nothing is dropped).
    reconcile(roots);
  };

  /**
   * The TREE-level read: exactly TWO rpcs — the boot-target descriptor and the
   * saved-connection registry — plus, only when a boot target actually exists and has
   * never been introspected, that one root's own paramless `connect`. No saved root is
   * introspected here (twenty saved connections ⇒ zero handshakes at boot); nothing
   * speculative probes for emptiness.
   *
   * Extracted from the mount effect so BOTH degraded outcomes have a way back. Neither
   * is self-healing otherwise: a failed `connection.active` yields no boot root for the
   * rest of the session — and with it an empty `App.tsx` `schemaTables`, i.e. a dead
   * ERD, an empty create-table schema selector and unresolvable PKs — while a failed
   * `connections.list` next to no boot target yields a tree with nothing in it at all.
   * The registry-refresh effect cannot rescue either: it never re-reads
   * `connection.active`, and it only runs on a Settings mutation the empty tree gives
   * no path to. So both render a "Reintentar" wired straight back here.
   */
  const loadTree = (): void => {
    // Only blank the panel when there is nothing to blank: a retry raised from the
    // WARNING line still has live roots on screen, and those must not flash away
    // (their cached per-root state survives regardless — it lives in `states`).
    setPhase((cur) => (cur.kind === "roots" ? cur : { kind: "loading" }));
    const seq = ++treeSeqRef.current;
    void Promise.all([
      rpc<ActiveConnectionInfo>("connection.active"),
      rpc<ListConnectionsResult>("connections.list"),
    ]).then(([activeReply, listReply]) => {
      if (!alive.current) return;
      // RETAINED BEFORE THE ORDERING GUARD, deliberately. `connection.active` describes a
      // CLI/env boot argument that cannot change mid-session, and this is its only reader —
      // the registry refresh never re-reads it — so a superseded reply is still the only
      // proof of the boot target anyone will get. Dropping it with the reply is what let a
      // refresh that overtook the mount read rebuild the roots from `activeRef === null`:
      // no boot root, no mount introspection, an empty `schemaTables` (dead ERD, empty
      // create-table schema list, unresolvable PKs) for the whole session — and, since the
      // warning was dropped with it, not one word on screen and no Reintentar to click.
      // `summariesRef` stays BELOW the guard: the registry is mutable and the refresh
      // writes it too, so an older list landing late must not regress a newer one.
      if (activeReply.ok) {
        activeRef.current = activeReply.result;
        // CLEARED here too, not only on the winning path below. A superseded reply is proof
        // the boot target IS readable, and the clear used to sit below the guard — so a
        // retry that succeeded but lost the race left "no se pudo leer la conexión de
        // arranque" pinned above the very boot root `adoptBootRoot` then spliced in, green
        // and fully introspected, with every later refresh re-publishing the same dead
        // string off this ref. Safe in the other direction as well: a failed read only ever
        // means "unknown", so an `ok` from any read is the more authoritative answer.
        bootWarningRef.current = null;
      } else if (activeRef.current === null && bootWarningRef.current === null) {
        // Same retention for the failure: with no boot knowledge at all, a superseded read
        // is also the only thing that knows the tree is degraded. Only ever RAISES a warning
        // no one has raised yet, so it cannot resurrect one an `ok` reply just cleared.
        bootWarningRef.current = bootTargetWarning(activeReply.error);
      }
      // A newer root-list read (another Reintentar, or a registry refresh) was issued
      // while this one was in flight — it owns `phase` now, so this reply must not
      // overwrite it with an older list. It may, however, have committed that list before
      // this reply taught anyone a boot target exists, so hand it the one root it could
      // not have known about before standing down.
      if (seq !== treeSeqRef.current) {
        adoptBootRoot();
        return;
      }
      // Both calls are pure reads, and a FAILED one means "unknown", never "gone". On the
      // first mount the refs are empty so this reads exactly as a plain degradation; on a
      // RETRY it is what stops a transient failure from deleting what we already proved:
      // a demoted `connection.active` would take a live, already-introspected boot root
      // (and with it the ERD's catalog) off the tree, and a demoted `connections.list`
      // would wipe every saved root — the very thing the refresh effect refuses to do.
      // The failures are still surfaced, never swallowed: `mountWarning` renders them.
      // (`activeRef` was already retained above the guard, for the same reason.)
      if (listReply.ok) summariesRef.current = listReply.result;
      const active = activeRef.current;
      const summaries = summariesRef.current;
      const hasBoot = active !== null && active.hasTarget;
      bootWarningRef.current = activeReply.ok ? null : bootTargetWarning(activeReply.error);
      if (!listReply.ok && !hasBoot && summaries.length === 0) {
        // Nothing known from either side ⇒ no root list can be built at all. When the
        // boot read failed too, BOTH envelopes ride the line: "the registry is
        // unreadable" alone would assert there is no boot target, which is precisely
        // what a failed `connection.active` means we do not know (`mountWarning`).
        setPhase({
          kind: "error",
          text: activeReply.ok
            ? envelopeText(listReply.error)
            : `${envelopeText(activeReply.error)} · ${envelopeText(listReply.error)}`,
        });
        return;
      }
      const roots = buildRoots(active, summaries);
      setPhase({
        kind: "roots",
        roots,
        warning: mountWarning(
          activeReply.ok ? null : activeReply.error,
          listReply.ok ? null : listReply.error,
        ),
      });
      // The SAME reconciliation the refresh effect performs (shared, so the two cannot
      // drift): a root that is genuinely gone — or one whose target was repointed and whose
      // invalidation no reader has applied yet — takes its cached state and expansion keys
      // with it. Without it the orphans survive forever AND `loadRoot`'s liveness guard
      // keeps accepting replies for a root that no longer exists. Safe here precisely
      // because of the retention above: the list only ever SHRINKS on an authoritative reply.
      reconcile(roots);
    });
  };

  useEffect(() => {
    loadTree();
    // `loadTree` (and the `loadRoot`/`onSchemaLoaded` it closes over) is intentionally
    // excluded: this pass runs exactly once on mount, so it deliberately freezes the
    // FIRST render's closure. That is safe because nothing in that chain reads from the
    // render except `onSchemaLoaded` — every store it writes goes through a functional
    // updater or a ref, never a captured value. The retry paths are unaffected: their
    // `onClick`/`onRetry` hand over the CURRENT render's closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // REGISTRY-DRIVEN REFRESH: a mount-only fetch froze the root list for the session
  // (saving a connection added no root until an app restart — verbatim the complaint
  // this story exists to fix), so every registry mutation re-reads the list and
  // reconciles. Only the removed roots' entries are dropped — plus any REPOINTED one's, whose
  // id survived an edit that pointed it at a different database; every other survivor keeps
  // the exact same values under the same keys, so nothing it holds is re-fetched or reset.
  //
  // `repointedConnectionId` is deliberately NOT a dependency: it is set in the same commit as
  // the revision bump that describes it, so this body always reads the id belonging to the
  // mutation it is reconciling — while listing it would re-run the whole refetch when it
  // later resets to `null` for an unrelated add/remove. The id is banked SYNCHRONOUSLY here,
  // before the round-trip, precisely because this effect run may never reach its commit: a
  // failed list read, a "Reintentar" that supersedes it, or the next mutation's cleanup all
  // end it early, and the prop is gone by then. Banked, it survives for whichever reader
  // commits next (`reconcile`).
  useEffect(() => {
    if (registryRevision === 0) return;
    if (repointedConnectionId !== null) {
      pendingRepointRef.current = new Set(pendingRepointRef.current).add(repointedConnectionId);
    }
    let mounted = true;
    // Shares `loadTree`'s token so the two readers are ordered against EACH OTHER, not
    // just against themselves: whichever was issued last is the one allowed to commit.
    const seq = ++treeSeqRef.current;
    void rpc<ListConnectionsResult>("connections.list").then((reply) => {
      if (!mounted || seq !== treeSeqRef.current) return;
      if (!reply.ok) {
        // A failed refetch leaves the current roots standing — same non-fatal warning
        // as a failed mount-time read next to a live boot root (IG-4). A still-unresolved
        // boot-target read outranks it, per `mountWarning`'s priority.
        setPhase((cur) =>
          cur.kind === "roots"
            ? { ...cur, warning: bootWarningRef.current ?? registryWarning(reply.error) }
            : cur,
        );
        return;
      }
      // Retained so a later `loadTree` retry whose own list read fails still rebuilds
      // from the FRESHEST known registry rather than from the mount-time one.
      summariesRef.current = reply.result;
      const roots = buildRoots(activeRef.current, reply.result);
      // A SUCCESSFUL refresh clears only the REGISTRY warning it just disproved. A live
      // boot-target warning survives: the degradation it reports (no boot root, empty
      // `schemaTables`) is untouched by anything the registry has to say, and dropping
      // the line would leave a healthy-looking tree over a dead ERD.
      setPhase({ kind: "roots", roots, warning: bootWarningRef.current });
      // Every live root KEEPS its cached state (IG-A) — except a repointed one, which keeps
      // its id but no longer describes the same database. Shared with `loadTree`, and it is
      // what clears the banked repoints, so exactly one reader can be the one that applies
      // them and neither can silently skip them.
      reconcile(roots);
    });
    return () => {
      mounted = false;
    };
  }, [registryRevision]);

  const toggleRoot = (descriptor: RootDescriptor): void => {
    const willOpen = !expandedRoots.has(descriptor.key);
    setExpandedRoots((cur) => {
      const set = new Set(cur);
      if (willOpen) set.add(descriptor.key);
      else set.delete(descriptor.key);
      return set;
    });
    // Only an `idle` root fetches: collapsing is pure visibility, and a cached
    // `ready`/`error` root re-shows itself without a second `connect` (no automatic
    // re-attempt against an unreachable host — "Reintentar" is the only way back).
    // Gated on `statesRef`, NOT the render closure's `states`: `loadRoot` writes the
    // `loading` marker through the ref synchronously, so the ref is the only reader that
    // sees it before the next commit. Two activations of one root inside a single frame
    // (double-tap, or Enter fired twice) would otherwise both read `idle` and issue two
    // `connect`s whose reply order decides the surviving state.
    if (willOpen && shouldFetchOnExpand(statesRef.current.get(descriptor.key) ?? IDLE))
      loadRoot(descriptor);
  };

  const toggleSchema = (key: string): void => {
    setExpandedSchemas((cur) => {
      const set = new Set(cur);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return set;
    });
  };

  // Selecting a not-yet-active table always expands it (never collapses on first
  // select); re-activating the already-active table toggles its disclosure — matches a
  // standard tree's expand-on-select + re-click-to-collapse behavior.
  const activateTable = (table: SchemaTableInfo, connectionId: string | null, key: string): void => {
    const on =
      activeTable !== null &&
      activeTable.schema === table.schema &&
      activeTable.name === table.name &&
      (activeTable.connectionId ?? null) === connectionId;
    onActivate(table, connectionId);
    setExpandedTables((cur) => {
      const set = new Set(cur);
      if (on && set.has(key)) set.delete(key);
      else set.add(key);
      return set;
    });
  };

  return (
    <nav
      // Since Story 10.5 this panel lists CONNECTIONS, each of which owns its schemas and
      // tables — the old "Schema tables" label described the pre-multi-root flat list and
      // now contradicts the panel's own visible `connections` header.
      aria-label="Connections"
      className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      <div
        className="shrink-0 px-3 py-2.5 uppercase text-muted-foreground"
        style={{ fontSize: "var(--label-size)", letterSpacing: "0.11em" }}
      >
        connections
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {phase.kind === "loading" ? (
          // This phase is about the ROOT LIST, not any root's schema — the old
          // "loading schema…" is single-root copy that no longer describes it.
          <p className="px-3 py-2 text-xs lowercase text-muted-foreground">loading connections…</p>
        ) : phase.kind === "error" ? (
          <>
            <p role="alert" className="px-3 py-2 text-xs lowercase text-err">
              {phase.text}
            </p>
            {/* Without this the tree is dead for the whole session: this phase means no
                root list could be built at all, so there is no root to expand, no
                empty-state CTA, and no registry mutation to drive the refresh effect. */}
            <button
              type="button"
              onClick={loadTree}
              className="ml-3 rounded-[var(--radius)] border border-border px-2.5 py-[3px] text-[11px] text-foreground transition-colors hover:bg-muted"
            >
              Reintentar
            </button>
          </>
        ) : (
          <>
            {phase.warning === null ? null : (
              // Non-fatal, and rendered ABOVE BOTH branches below: a root list can be
              // EMPTY and still be degraded (no boot target, and a `connections.list`
              // that failed), in which case swallowing this line would show the calm
              // "Agregá una conexión" empty-state to someone who just added one.
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <p role="status" className="text-[11px] lowercase text-warn">
                  {phase.warning}
                </p>
                {/* Both mount reads degrade rather than tank the tree, but neither
                    self-heals: nothing re-reads `connection.active` (so a boot root lost
                    to a transient failure — and with it `App.tsx`'s `schemaTables` — stays
                    lost), and the registry re-read only fires on a Settings mutation. */}
                <button
                  type="button"
                  onClick={loadTree}
                  className="shrink-0 rounded-[var(--radius)] border border-border px-2.5 py-[3px] text-[11px] text-foreground transition-colors hover:bg-muted"
                >
                  Reintentar
                </button>
              </div>
            )}
            {phase.roots.length === 0 ? (
              <div className="flex flex-col items-center gap-2.5 px-5 pt-10 text-center">
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  className="h-7 w-7 text-muted-foreground/60"
                >
                  <ellipse cx="12" cy="5" rx="8" ry="3" />
                  <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
                  <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
                </svg>
                <p className="text-[12.5px] font-medium text-foreground">Sin conexión activa</p>
                <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                  Agregá una conexión en Ajustes para explorar tablas.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col py-1">
                {phase.roots.map((descriptor) => (
                  <ConnectionRoot
                    key={descriptor.key}
                    descriptor={descriptor}
                    state={states.get(descriptor.key) ?? IDLE}
                    open={expandedRoots.has(descriptor.key)}
                    expandedSchemas={expandedSchemas}
                    expandedTables={expandedTables}
                    activeTable={activeTable}
                    extraTables={extraTables}
                    onToggleRoot={toggleRoot}
                    onToggleSchema={toggleSchema}
                    onRetry={loadRoot}
                    onActivate={activateTable}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
