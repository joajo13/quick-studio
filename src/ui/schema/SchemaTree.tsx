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

  useEffect(() => {
    let alive = true;
    void rpc<ConnectResult>("connect").then((reply) => {
      if (!alive) return;
      if (!reply.ok) {
        setLoad({ phase: "error", text: envelopeText(reply.error) });
        return;
      }
      if (reply.result.status === "failed") {
        setLoad({ phase: "error", text: `${reply.result.failure}: ${reply.result.message}` });
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
      className="flex h-full w-full min-w-0 flex-col overflow-auto border-l border-[var(--border)] bg-[var(--card)]"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      <div
        className="shrink-0 px-3 py-2 uppercase text-[var(--muted-foreground)]"
        style={{ fontSize: "var(--label-size)", letterSpacing: "0.11em" }}
      >
        {load.phase === "ready" ? `${load.schema.engine} · ${tables.length} tables` : "schema"}
      </div>

      <div className="min-h-0 flex-1">
        {load.phase === "loading" ? (
          <p className="px-3 py-2 text-xs lowercase text-[var(--muted-foreground)]">loading schema…</p>
        ) : load.phase === "error" ? (
          <p role="alert" className="px-3 py-2 text-xs lowercase text-red-400">
            {load.text}
          </p>
        ) : tables.length === 0 ? (
          <p className="px-3 py-2 text-xs lowercase text-[var(--muted-foreground)]">no tables</p>
        ) : (
          <ul className="flex flex-col gap-0.5 px-1.5 py-1">
            {tables.map((table) => {
              const on = activeTable?.schema === table.schema && activeTable?.name === table.name;
              const activate = (): void => onActivate(table);
              return (
                <li key={`${table.schema}.${table.name}`}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={on}
                    onClick={activate}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        activate();
                      }
                    }}
                    title={`${table.schema}.${table.name}`}
                    className="flex cursor-pointer select-none items-baseline gap-2 rounded-[var(--radius)] px-2 py-1 text-[12px] transition-colors"
                    style={{
                      backgroundColor: on ? "var(--coral-soft)" : undefined,
                      color: on ? "var(--coral)" : "var(--muted-foreground)",
                    }}
                    onMouseEnter={(e) => {
                      if (!on) e.currentTarget.style.backgroundColor = "var(--muted)";
                    }}
                    onMouseLeave={(e) => {
                      if (!on) e.currentTarget.style.backgroundColor = "";
                    }}
                  >
                    <span className="truncate">{table.name}</span>
                    <span
                      className="ml-auto shrink-0 text-[10px] opacity-70"
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      {table.columns.length}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
