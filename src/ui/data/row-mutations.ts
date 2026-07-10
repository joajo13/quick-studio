/**
 * quick-studio UI (Ring 2) — structured row-mutation builders (pure).
 *
 * The tested seam between the presentational {@link DataGrid} / `TabContent` and the
 * Story 3.1 guarded Core executor. Given the current page's `FrozenColumn`s, the
 * table's primary keys, and a user edit, it produces a typed {@link StructuredOp}
 * (`insert`/`update`/`delete`) or a `{ error }` — never raw SQL.
 *
 * The one correctness trap this module owns: outgoing `value`s are JS-typed to the
 * column's inferred {@link FrozenCell} kind before they leave the UI. postgres.js
 * serializes a JS string as `text`, and Postgres will NOT assignment-cast `text` →
 * int/bool — so a bare string in a number/bool column is a runtime error.
 * `coerceValue` converts by kind (number→`Number` rejecting non-finite; boolean→
 * bool; date→validated but sent as the RAW literal string; string→string; explicit
 * NULL→`null`). Dates deliberately stay strings: a JS `Date` can't cross the JSON-RPC
 * wire (JSON.stringify → UTC ISO) and `new Date()` reinterprets a tz-less literal in
 * JS-local time, shifting the instant — so we validate parseability and forward the
 * user's literal, letting the DB/driver parse it in its own context.
 * A column whose kind can't be inferred (all-NULL on the page → kind `"null"`)
 * falls back to a best-effort string; superseded once `SchemaColumnInfo` is threaded.
 */

import type {
  FrozenCell,
  FrozenColumn,
  FrozenRow,
  StructuredColumnValue,
  StructuredOp,
  StructuredPk,
} from "../../shared/contract.ts";

/** A validation failure carrying a terse, in-panel-displayable message. */
export type MutationError = { readonly error: string };

/** Discriminate a builder result from a validation failure. */
export function isMutationError(v: unknown): v is MutationError {
  return typeof v === "object" && v !== null && "error" in v;
}

/**
 * A single cell's intended new content: either an explicit SQL NULL, or a raw text
 * value from an editor to be coerced by the column's kind. The `DataGrid` editor
 * emits exactly one of these per committed cell.
 */
export type CellEdit = { readonly setNull: true } | { readonly raw: string };

/** One insert-draft entry: a column plus the user's (possibly-untouched) input. */
export type DraftCell = { readonly column: string; readonly edit: CellEdit };

/** The target table address every op carries (schema optional, disambiguating). */
export type TableTarget = { readonly schema?: string; readonly table: string };

/** Spread a `TableTarget` into an op, omitting an absent `schema`. */
function target(t: TableTarget): { readonly schema?: string; readonly table: string } {
  return t.schema === undefined ? { table: t.table } : { schema: t.schema, table: t.table };
}

/** A coerced value ready to bind, or a validation error. */
type Coerced = { readonly value: unknown } | MutationError;

/**
 * Coerce a raw editor string to the native JS value for a column of `kind`. Pure;
 * rejects values that Postgres could not accept for the kind (NaN, invalid dates).
 */
export function coerceValue(kind: FrozenCell["kind"], raw: string): Coerced {
  switch (kind) {
    case "number": {
      // `Number("")` is 0 — treat an empty numeric input as "no value", not zero.
      if (raw.trim() === "") return { error: "expected a number, got empty" };
      const n = Number(raw);
      // `Number.isFinite` also rejects Infinity (e.g. `Number("1e400")`), which
      // `!Number.isNaN` would let through — Postgres has no plain `Infinity` int.
      if (!Number.isFinite(n)) return { error: `not a number: ${raw}` };
      return { value: n };
    }
    case "boolean": {
      const t = raw.trim().toLowerCase();
      if (t === "true" || t === "t" || t === "1") return { value: true };
      if (t === "false" || t === "f" || t === "0") return { value: false };
      return { error: `not a boolean: ${raw}` };
    }
    case "date": {
      // Validate parseability but SEND THE RAW LITERAL — a JS `Date` can't survive the
      // JSON-RPC wire (serializes to a UTC ISO string) and `new Date("2026-07-10T12:00")`
      // reinterprets a tz-less input in JS-local time, silently shifting the instant.
      if (Number.isNaN(new Date(raw).getTime())) return { error: `not a date: ${raw}` };
      return { value: raw };
    }
    // `string` and the un-inferable `null`-kind column both bind the raw string.
    default:
      return { value: raw };
  }
}

/** Resolve a `CellEdit` to a bound value or an error, given the column kind. */
function resolveEdit(kind: FrozenCell["kind"], edit: CellEdit): Coerced {
  if ("setNull" in edit) return { value: null };
  return coerceValue(kind, edit.raw);
}

/** The native JS value a `FrozenCell` already carries (for reading a PK from a row). */
function cellToValue(cell: FrozenCell): unknown {
  switch (cell.kind) {
    case "null":
      return null;
    // A date PK must also cross as a string literal, not a `Date` (same wire/tz trap
    // as `coerceValue`); the ISO the cell already carries is that literal.
    case "date":
      return cell.iso;
    default:
      return cell.value;
  }
}

/** Look up a column's index by name in the current page's columns (-1 if absent). */
function columnIndex(columns: ReadonlyArray<FrozenColumn>, name: string): number {
  return columns.findIndex((c) => c.name === name);
}

/**
 * The single-PK guard + PK-value extraction. Requires EXACTLY one primary-key column
 * (matching the executor's `resolveSinglePkTable`); a composite or absent PK is a
 * hard error surfaced to the caller (which disables edit/delete). The PK value is
 * read from the row's cell at the PK column's index.
 */
export function pkForRow(
  columns: ReadonlyArray<FrozenColumn>,
  primaryKeys: ReadonlyArray<string>,
  row: FrozenRow,
): StructuredPk | MutationError {
  if (primaryKeys.length !== 1) {
    return { error: `expected exactly one primary-key column, got ${primaryKeys.length}` };
  }
  const column = primaryKeys[0]!;
  const idx = columnIndex(columns, column);
  if (idx < 0) return { error: `primary-key column not on page: ${column}` };
  const cell = row[idx];
  if (cell === undefined) return { error: `row is missing the primary-key cell for ${column}` };
  const value = cellToValue(cell);
  // A NULL PK can't safely address a row: `WHERE pk = NULL` matches 0 rows, yet the
  // executor still returns `ok` — the update/delete would silently no-op as success.
  if (value === null || value === undefined) {
    return { error: `primary-key value is null — row cannot be addressed (${column})` };
  }
  return { column, value };
}

/**
 * Build a single-cell structured `update`: PK address + one coerced `set`. Rejects
 * (before any RPC) a non-single-PK table, an unknown column, or a value that fails
 * coercion for the column's kind.
 */
export function buildUpdateOp(params: {
  readonly target: TableTarget;
  readonly columns: ReadonlyArray<FrozenColumn>;
  readonly primaryKeys: ReadonlyArray<string>;
  readonly row: FrozenRow;
  readonly column: string;
  readonly edit: CellEdit;
}): StructuredOp | MutationError {
  const { columns, primaryKeys, row, column, edit } = params;
  const pk = pkForRow(columns, primaryKeys, row);
  if (isMutationError(pk)) return pk;
  const idx = columnIndex(columns, column);
  if (idx < 0) return { error: `unknown column: ${column}` };
  const kind = columns[idx]!.type;
  const coerced = resolveEdit(kind, edit);
  if (isMutationError(coerced)) return coerced;
  return { kind: "update", ...target(params.target), pk, set: [{ column, value: coerced.value }] };
}

/** Build a structured `delete` addressed by the row's single PK. */
export function buildDeleteOp(params: {
  readonly target: TableTarget;
  readonly columns: ReadonlyArray<FrozenColumn>;
  readonly primaryKeys: ReadonlyArray<string>;
  readonly row: FrozenRow;
}): StructuredOp | MutationError {
  const pk = pkForRow(params.columns, params.primaryKeys, params.row);
  if (isMutationError(pk)) return pk;
  return { kind: "delete", ...target(params.target), pk };
}

/**
 * Build a structured `insert` from a draft. Untouched/empty inputs are OMITTED so the
 * column's DB default or NULL applies — this is how serial PKs and defaulted columns
 * insert without threading full schema metadata. An explicit "set NULL" is kept (it
 * forces NULL over a default). A value that fails coercion aborts the whole insert.
 */
export function buildInsertOp(params: {
  readonly target: TableTarget;
  readonly columns: ReadonlyArray<FrozenColumn>;
  readonly draft: ReadonlyArray<DraftCell>;
}): StructuredOp | MutationError {
  const { columns, draft } = params;
  const values: StructuredColumnValue[] = [];
  for (const { column, edit } of draft) {
    // Omit an untouched/empty text input → the DB default (or NULL) applies.
    if ("raw" in edit && edit.raw.trim() === "") continue;
    const idx = columnIndex(columns, column);
    if (idx < 0) return { error: `unknown column: ${column}` };
    const coerced = resolveEdit(columns[idx]!.type, edit);
    if (isMutationError(coerced)) return coerced;
    values.push({ column, value: coerced.value });
  }
  if (values.length === 0) return { error: "no values to insert" };
  return { kind: "insert", ...target(params.target), columns: values };
}
