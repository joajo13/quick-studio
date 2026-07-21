/**
 * quick-studio UI (Ring 2) — schema tree.
 *
 * The left-region schema browser (Story 3.2). On mount it fetches the live schema
 * via the token-gated `connect` RPC (which introspects and returns the neutral
 * {@link DatabaseSchema}), then lists the tables in mono, grouped by schema, one
 * `.on` (active) at a time. Each table row is keyboard-operable (`role="button"`,
 * `tabindex=0`, Enter/Space) — no mouse-only path to select a table. Activating a
 * table calls back so the Workspace can bind it to the active data tab.
 *
 * Follows the established client pattern: an `alive`-guarded effect, branch on
 * `reply.ok`, and surface `reply.error` in-panel (never console-only).
 *
 * Epic 7 restyle: the neutral `.side` schema sidebar (`design-artifacts/workspace.html`)
 * — a `.conn-row` status header, a `.side-cap` caption, and `.tree-row` table rows that
 * expand in place (local, presentation-only `expanded` state — no new prop/RPC) to reveal
 * `.col-row` columns with type-colored dots. The active-row highlight is now the neutral
 * `bg-coral-soft`/`text-coral` Tailwind utilities (both resolve to ink) in place of the old
 * inline coral style. All RPC/props/roles/aria are unchanged.
 */

import { useEffect, useState } from "react";
import type {
  ConnectResult,
  DatabaseSchema,
  SchemaTableInfo,
} from "../../shared/contract.ts";
import type { TableRef } from "../workspace/workspace-state.ts";
import { rpc } from "../rpc/client.ts";
import { envelopeText } from "../rpc/envelope-text.ts";

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly schema: DatabaseSchema }
  // "empty" = no connection target configured (the persistent-mode boot with no
  // URL). It is NOT an error — the app is fine, there is just nothing to browse
  // yet. Distinct phase so it renders a calm call-to-action, never the red alert.
  // Discriminated by the typed `no-target` ConnectionFailureKind (Epic 10), not a
  // message-string match.
  | { readonly phase: "empty" }
  | { readonly phase: "error"; readonly text: string };

/**
 * Merge the introspected tables with the optimistically-created ones, deduped by
 * `schema.name` (introspected truth wins if the same table is somehow present both
 * ways — e.g. after a reconnect that reset nothing). Preserves introspection order,
 * appending only genuinely-new optimistic entries.
 */
function mergeTables(
  loaded: ReadonlyArray<SchemaTableInfo>,
  extra: ReadonlyArray<SchemaTableInfo>,
): ReadonlyArray<SchemaTableInfo> {
  if (extra.length === 0) return loaded;
  const seen = new Set(loaded.map((t) => `${t.schema}.${t.name}`));
  const appended = extra.filter((t) => !seen.has(`${t.schema}.${t.name}`));
  return appended.length === 0 ? loaded : [...loaded, ...appended];
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
      className={`h-[11px] w-[11px] shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
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

export function SchemaTree({
  activeTable,
  onActivate,
  onSchemaLoaded,
  extraTables = [],
}: {
  /** The currently-bound table (drives the single `.on` highlight), or null. */
  activeTable: TableRef | null;
  /** Fired when a table is activated (click or Enter/Space). */
  onActivate: (table: SchemaTableInfo) => void;
  /** Fired once when the schema resolves, so the parent can look up PK columns. */
  onSchemaLoaded?: (tables: ReadonlyArray<SchemaTableInfo>) => void;
  /**
   * Optimistically-created tables (Story 3.4) appended to the introspected list so a
   * freshly-created table appears with no re-introspection (the Core's connect-time
   * schema is memoized). Deduped by `schema.name` against the loaded tables; the fetch
   * is otherwise unchanged.
   */
  extraTables?: ReadonlyArray<SchemaTableInfo>;
}): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  // Which tables have their column list expanded (Epic 7 tree disclosure) — local,
  // session-only UI state, never persisted and never part of any RPC/prop contract.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void rpc<ConnectResult>("connect").then((reply) => {
      if (!alive) return;
      if (!reply.ok) {
        setLoad({ phase: "error", text: envelopeText(reply.error) });
        return;
      }
      if (reply.result.status === "failed") {
        setLoad(
          reply.result.failure === "no-target"
            ? { phase: "empty" }
            : { phase: "error", text: `${reply.result.failure}: ${reply.result.message}` },
        );
        return;
      }
      setLoad({ phase: "ready", schema: reply.result.schema });
      onSchemaLoaded?.(reply.result.schema.tables);
    });
    return () => {
      alive = false;
    };
    // onSchemaLoaded is intentionally excluded — the fetch runs exactly once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The introspected tables plus any optimistically-created ones (Story 3.4).
  const tables = load.phase === "ready" ? mergeTables(load.schema.tables, extraTables) : [];

  return (
    <nav
      aria-label="Schema tables"
      className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {/* Connection status row (prototype `.conn-row`): dot + terse status text. The
          shell has no connection name/host available client-side without a new RPC
          (out of scope for a presentation-only pass), so this reads the load phase. */}
      <div className="flex shrink-0 items-center gap-2 px-2.5 py-2.5">
        <span
          aria-hidden
          className={[
            "h-[7px] w-[7px] shrink-0 rounded-full",
            load.phase === "ready"
              ? "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]"
              : load.phase === "error"
                ? "bg-red-500"
                : "bg-muted-foreground",
          ].join(" ")}
        />
        <span className="truncate text-[12.5px] font-semibold text-foreground">
          {load.phase === "ready"
            ? load.schema.engine
            : load.phase === "error"
              ? "connection error"
              : load.phase === "empty"
                ? "sin conexión"
                : "connecting…"}
        </span>
      </div>

      <div
        className="shrink-0 px-3 py-1.5 uppercase text-muted-foreground"
        style={{ fontSize: "var(--label-size)", letterSpacing: "0.11em" }}
      >
        {load.phase === "ready" ? `${load.schema.engine} · ${tables.length} tables` : "schema"}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {load.phase === "loading" ? (
          <p className="px-3 py-2 text-xs lowercase text-muted-foreground">loading schema…</p>
        ) : load.phase === "empty" ? (
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
        ) : load.phase === "error" ? (
          <p role="alert" className="px-3 py-2 text-xs lowercase text-red-400">
            {load.text}
          </p>
        ) : tables.length === 0 ? (
          <p className="px-3 py-2 text-xs lowercase text-muted-foreground">no tables</p>
        ) : (
          <ul className="flex flex-col gap-0.5 px-1.5 py-1">
            {tables.map((table) => {
              const key = `${table.schema}.${table.name}`;
              const on = activeTable?.schema === table.schema && activeTable?.name === table.name;
              const open = expanded.has(key);
              // Selecting a not-yet-active table always expands it (never collapses on
              // first select); re-activating the already-active table toggles its
              // disclosure — matches a standard tree's expand-on-select + re-click-to-
              // collapse behavior.
              const activate = (): void => {
                onActivate(table);
                setExpanded((cur) => {
                  const next = new Set(cur);
                  if (on) {
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                  } else {
                    next.add(key);
                  }
                  return next;
                });
              };
              const hasColumns = table.columns.length > 0;
              return (
                <li key={key}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={on}
                    aria-expanded={hasColumns ? open : undefined}
                    onClick={activate}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        activate();
                      }
                    }}
                    title={`${table.schema}.${table.name}`}
                    className={[
                      "flex w-full cursor-pointer select-none items-center gap-1.5 rounded-[var(--radius)] px-2 py-1.5 text-[12.5px] transition-colors",
                      on ? "bg-coral-soft text-coral" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    ].join(" ")}
                  >
                    {hasColumns ? <Chevron open={open} /> : <span aria-hidden className="h-[11px] w-[11px] shrink-0" />}
                    <TableIcon className={on ? "text-coral" : "text-muted-foreground"} />
                    <span className="truncate">{table.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] opacity-70">{table.columns.length}</span>
                  </div>

                  {open && table.columns.length > 0 ? (
                    <ul className="flex flex-col gap-0.5 py-0.5 pl-[22px] pr-1">
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
        )}
      </div>
    </nav>
  );
}
