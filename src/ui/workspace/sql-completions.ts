/**
 * quick-studio UI (Ring 2) — SQL schema completion builder (Story 8.8).
 *
 * The pure, DOM-free completion-config builder `QueryTabView`'s CodeMirror
 * editor wires up for schema/table/column autocomplete. Maps the ALREADY-loaded
 * `SchemaTableInfo[]` (`App.allTables → Workspace → TabContent → QueryTabView`,
 * the same list the ERD and the PK-icon lookup already consume — see
 * `sql-completions.test.ts`'s header note) into completion entries — no new RPC,
 * no new schema-completion endpoint.
 *
 * This module never touches the DOM: `collectSqlCompletionEntries` /
 * `filterSqlCompletionEntries` / `resolveQualifiedColumns` are plain pure
 * functions over data, directly unit-testable with `bun:test` (no
 * jsdom/testing-library, mirroring how `run-raw-query.ts` extracted the
 * execute round-trip so it stays testable without a live DOM). The exported
 * `schemaCompletionSource` builds a `@codemirror/autocomplete` `CompletionSource`
 * — a plain function CodeMirror calls with a `CompletionContext`, which the CM
 * docs explicitly note "is mostly useful for testing completion sources" and can
 * be constructed without a live `EditorView` — so even the CM-shaped completion
 * source itself stays constructible and callable outside a mounted editor.
 *
 * Highlighting/completion here are authoring aids ONLY (AR-3): this module never
 * decides what is sent to `execute` — it only derives NAMES to show/insert.
 */

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { SchemaTableInfo } from "../../shared/contract.ts";

/** The three kinds of identifier the completion source can offer. */
export type SqlCompletionKind = "schema" | "table" | "column";

/** One deduplicated schema/table/column completion candidate. */
export type SqlCompletionEntry = {
  readonly label: string;
  readonly kind: SqlCompletionKind;
  /** A human-readable qualifier shown in the popup (e.g. `public.orders` for a table, `public.orders.id` for a column). Absent for a bare schema entry. */
  readonly detail?: string;
};

/**
 * Every distinct schema/table/column name derivable from `tables`, deduplicated
 * by `(kind, label)` so a schema/table/column name repeated across entries (e.g.
 * the same schema owning several tables) is offered exactly once. Order is
 * stable (input order) — schema, then that row's table, then its columns — which
 * is irrelevant for correctness (the popup lists in whatever order CM sorts) but
 * keeps this function deterministic for the tests below.
 */
export function collectSqlCompletionEntries(
  tables: ReadonlyArray<SchemaTableInfo>,
): ReadonlyArray<SqlCompletionEntry> {
  const seen = new Set<string>();
  const entries: SqlCompletionEntry[] = [];
  const push = (label: string, kind: SqlCompletionKind, detail?: string): void => {
    const key = `${kind}:${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(detail === undefined ? { label, kind } : { label, kind, detail });
  };
  for (const table of tables) {
    push(table.schema, "schema");
    push(table.name, "table", `${table.schema}.${table.name}`);
    for (const column of table.columns) {
      push(column.name, "column", `${table.schema}.${table.name}.${column.name}`);
    }
  }
  return entries;
}

/**
 * Case-insensitive prefix filter over `entries` — the as-you-type / explicit
 * `Ctrl+Space` narrowing. An EMPTY `prefix` (explicit `Ctrl+Space` with nothing
 * typed yet) returns every entry unfiltered.
 */
export function filterSqlCompletionEntries(
  entries: ReadonlyArray<SqlCompletionEntry>,
  prefix: string,
): ReadonlyArray<SqlCompletionEntry> {
  if (prefix === "") return entries;
  const needle = prefix.toLowerCase();
  return entries.filter((entry) => entry.label.toLowerCase().startsWith(needle));
}

/**
 * Resolve the column names owned by a schema-qualified `schema.table` pair —
 * the qualified-name lookup the `schema.table.` drill-down resolves against.
 * Returns an empty array when no table matches (never throws): an unresolved
 * qualified name is simply "no columns", not an error, mirroring the
 * empty-schema safety of the entry collector above.
 */
export function resolveQualifiedColumns(
  tables: ReadonlyArray<SchemaTableInfo>,
  schema: string,
  table: string,
): ReadonlyArray<string> {
  const found = tables.find((t) => t.schema === schema && t.name === table);
  return found ? found.columns.map((c) => c.name) : [];
}

/**
 * Resolve the entries offered *after* a dotted qualifier — the `table.` /
 * `schema.table.` drill-down. `path` is the dotted segment(s) BEFORE the caret's
 * trailing partial word:
 *   - `["orders"]`          → the columns of every table named `orders` PLUS the
 *                             table names of a schema named `orders` (a single
 *                             identifier before a dot is ambiguous between a
 *                             table and a schema, so offer both).
 *   - `["public","orders"]` → the columns of `public.orders`.
 * Returns `null` when the qualifier names no known schema/table, so the caller
 * offers NOTHING (rather than exploding into the whole flat identifier list)
 * after an unrecognized `foo.`. A `path` longer than two segments is unsupported
 * (`null`). Never throws.
 */
export function resolveQualifiedEntries(
  tables: ReadonlyArray<SchemaTableInfo>,
  path: ReadonlyArray<string>,
): ReadonlyArray<SqlCompletionEntry> | null {
  if (path.length === 1) {
    const name = path[0];
    if (!tables.some((t) => t.name === name || t.schema === name)) return null;
    const seen = new Set<string>();
    const out: SqlCompletionEntry[] = [];
    const push = (label: string, kind: SqlCompletionKind, detail: string): void => {
      const key = `${kind}:${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ label, kind, detail });
    };
    // `name` as a TABLE (in any schema) → its columns.
    for (const table of tables) {
      if (table.name === name) {
        for (const column of table.columns) {
          push(column.name, "column", `${table.schema}.${table.name}.${column.name}`);
        }
      }
    }
    // `name` as a SCHEMA → its table names.
    for (const table of tables) {
      if (table.schema === name) push(table.name, "table", `${table.schema}.${table.name}`);
    }
    return out;
  }
  if (path.length === 2) {
    const [schema, table] = path;
    if (schema === undefined || table === undefined) return null;
    if (!tables.some((t) => t.schema === schema && t.name === table)) return null;
    return resolveQualifiedColumns(tables, schema, table).map((col) => ({
      label: col,
      kind: "column" as const,
      detail: `${schema}.${table}.${col}`,
    }));
  }
  return null;
}

/** Map a completion kind to the small type tag CM's popup renders beside the label. */
function completionType(kind: SqlCompletionKind): string {
  switch (kind) {
    case "schema":
      return "namespace";
    case "table":
      return "type";
    case "column":
      return "property";
  }
}

/**
 * Build the schema-driven `CompletionSource` `QueryTabView` registers as a
 * CodeMirror `autocomplete` language-data source (via
 * `StandardSQL.language.data.of({ autocomplete: ... })` inside a `Compartment`,
 * alongside `autocompletion({ activateOnTyping: true })` and lang-sql's own
 * keyword completion). Offers matching
 * schema/table/column names from `tables` on explicit `Ctrl+Space` (regardless
 * of whether a prefix has been typed) AND as-you-type once a prefix exists
 * (`context.explicit === false` requires a non-empty word before the caret).
 * Returns `null` (no popup) when there is nothing to offer — an empty `tables`
 * (pre-connect / no tables) never crashes, it just yields no identifier matches.
 */
export function schemaCompletionSource(tables: ReadonlyArray<SchemaTableInfo>): CompletionSource {
  const entries = collectSqlCompletionEntries(tables);
  const toOption = (entry: SqlCompletionEntry): Completion => ({
    label: entry.label,
    type: completionType(entry.kind),
    detail: entry.detail,
  });
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\w*/);
    if (word === null) return null;
    // Dotted-qualifier drill-down: when an `ident.` (or `schema.table.`) sits
    // immediately before the caret, scope completion to that table's columns /
    // that schema's tables instead of the whole flat identifier list. This also
    // stops an unrecognized `foo.` from exploding into every name.
    const dotted = context.matchBefore(/[\w.]+/);
    if (dotted !== null && dotted.text.includes(".")) {
      const segments = dotted.text.split(".");
      const path = segments.slice(0, -1); // the qualifier: everything before the trailing partial word
      const qualified = resolveQualifiedEntries(tables, path);
      if (qualified === null) return null; // unknown qualifier → offer nothing
      const scoped = filterSqlCompletionEntries(qualified, word.text);
      if (scoped.length === 0) return null;
      return { from: word.from, options: scoped.map(toOption) };
    }
    // Unqualified: the flat schema/table/column list. Explicit `Ctrl+Space`
    // offers everything; as-you-type requires a non-empty word before the caret.
    if (word.from === word.to && !context.explicit) return null;
    const matches = filterSqlCompletionEntries(entries, word.text);
    if (matches.length === 0) return null;
    return { from: word.from, options: matches.map(toOption) };
  };
}
