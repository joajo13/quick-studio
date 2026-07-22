/**
 * quick-studio Core — driver-rows → FrozenData mapping (pure, total).
 *
 * The one place raw driver values become tagged {@link FrozenCell}s (Story 3.2).
 * `rowsToFrozenData` takes ordered column names and position-aligned raw row
 * arrays (as `Driver.query` yields) and produces a well-formed {@link FrozenData}:
 * one neutral `type` per column, inferred from that column's non-null values, and
 * every cell tagged to match. It never throws for ordinary data — an unknown /
 * heterogeneous value falls back to a `string` cell so the result always satisfies
 * `assertWellFormed` (cell kind matches column type, or is `null`).
 */

import {
  FROZEN_SCHEMA_VERSION,
  toIsoUtc,
  type FrozenCell,
  type FrozenColumn,
  type FrozenData,
  type FrozenRow,
} from "../shared/contract.ts";

/** The neutral cell kinds a column can settle on (a SQL NULL is admissible in any). */
type ValueKind = "string" | "number" | "boolean" | "date";

/**
 * The natural neutral kind of a single raw driver value, or `null` for a SQL NULL
 * (`null`/`undefined`). Anything that cannot be represented losslessly as a
 * number/boolean/date — a `bigint` (precision), a non-finite number, an object,
 * a plain string — is `"string"` (the safe, always-valid fallback).
 */
function naturalKind(value: unknown): ValueKind | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "string";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "string" : "date";
  // bigint, string, object, symbol, function → string.
  return "string";
}

/**
 * Coerce any non-null raw value to a canonical string (used for a `string` column).
 * Dates become their ISO-UTC form; objects are JSON-serialized (best-effort);
 * everything else goes through `String`.
 */
function coerceString(value: unknown): string {
  if (typeof value === "string") return value;
  // An Invalid Date (e.g. mysql2 `0000-00-00`) must never reach toIsoUtc (it throws).
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : toIsoUtc(value);
  if (typeof value === "object") {
    // Binary buffers must not JSON-dump to a giant `{"type":"Buffer","data":[…]}`.
    if (value instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) {
      return `\\x…(${value.length} bytes)`;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Build one tagged cell for `value` under an already-decided column `kind`. */
function cellFor(value: unknown, kind: ValueKind): FrozenCell {
  if (value === null || value === undefined) return { kind: "null" };
  switch (kind) {
    case "number":
      // Guaranteed a finite number by the column-kind consistency check; a stray
      // non-number here would only arrive if the column fell back to string.
      return { kind: "number", value: value as number };
    case "boolean":
      return { kind: "boolean", value: value as boolean };
    case "date": {
      // Millisecond precision (DW-6): both drivers hand back a JS `Date` under their
      // DEFAULT configuration, so a Postgres `timestamp(6)` / MySQL `DATETIME(6)` is
      // already floored to millisecond precision by the driver library before `toIsoUtc`
      // runs — the sub-millisecond digits are gone by the time a date cell is built here.
      // This is NOT true "by construction": a connection URL carrying `dateStrings=true`
      // makes mysql2 yield timestamp STRINGS, which `naturalKind` routes to a `string`
      // column instead (never a date cell), so that microsecond text survives verbatim as
      // string content — the encode/decode boundary's `normalizeIsoUtc` only floors real
      // date cells.
      //
      // Defensive: an Invalid Date can never satisfy toIsoUtc — fall back to a
      // string cell so this stays total (naturalKind already routes invalid
      // dates to a string column, but a lone value must not be able to throw).
      const d = value as Date;
      if (d instanceof Date && Number.isNaN(d.getTime())) {
        return { kind: "string", value: coerceString(value) };
      }
      return { kind: "date", iso: toIsoUtc(d) };
    }
    case "string":
      return { kind: "string", value: coerceString(value) };
  }
}

/**
 * Decide a column's single neutral type from all its raw values: the shared kind
 * of every non-null value when they agree, else `"string"` (mixed or all-null
 * columns default to `string`, which admits any coerced value). Column index
 * `col` selects the value out of each row array.
 */
function inferColumnKind(rows: ReadonlyArray<ReadonlyArray<unknown>>, col: number): ValueKind {
  let decided: ValueKind | null = null;
  for (const row of rows) {
    const kind = naturalKind(row[col]);
    if (kind === null) continue; // NULLs never constrain the column type
    if (decided === null) {
      decided = kind;
    } else if (decided !== kind) {
      return "string"; // heterogeneous → the always-valid fallback
    }
  }
  return decided ?? "string";
}

/**
 * Map ordered column names + raw driver rows into a well-formed {@link FrozenData}.
 * Pure and total: per-column type inference then per-cell tagging, so the output
 * always satisfies the contract's `assertWellFormed` invariant. Columns are always
 * present even when `rows` is empty (the empty-table / past-end page case).
 */
export function rowsToFrozenData(
  columnNames: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): FrozenData {
  const kinds: ValueKind[] = columnNames.map((_name, col) => inferColumnKind(rows, col));
  const columns: FrozenColumn[] = columnNames.map((name, col) => ({ name, type: kinds[col]! }));
  const frozenRows: FrozenRow[] = rows.map((row) => columnNames.map((_n, col) => cellFor(row[col], kinds[col]!)));
  return { schemaVersion: FROZEN_SCHEMA_VERSION, columns, rows: frozenRows };
}
