/**
 * quick-studio Core — driver-rows → FrozenData mapping (pure, total).
 *
 * The one place raw driver values become tagged {@link FrozenCell}s (Story 3.2).
 * `rowsToFrozenData` takes ordered column DESCRIPTORS (name + optional canonical SQL
 * `dataType`) and position-aligned raw row arrays (as `Driver.query` yields) and
 * produces a well-formed {@link FrozenData}: one neutral `type` per column, inferred
 * from that column's non-null values, and every cell tagged to match. It never throws
 * for ordinary data — an unknown / heterogeneous value falls back to a `string` cell so
 * the result always satisfies `assertWellFormed` (cell kind matches column type, or is
 * `null`). The `dataType` rides along as a display/binding hint and steers exactly one
 * mapping decision: tz-less temporals become literal wall-clock strings (DW-34).
 */

import {
  FROZEN_SCHEMA_VERSION,
  isNaiveDateTimeType,
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

/** Two-digit (or `w`-digit) zero-padded decimal — the wall-clock formatter's only helper. */
const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/**
 * Render a tz-LESS temporal `Date` as the literal wall clock the database holds (DW-34):
 * `2026-07-22T18:14:13`, with `.sss` appended only when the millisecond field is non-zero.
 *
 * It reads LOCAL getters on purpose. Both drivers parse a tz-less `timestamp`/`DATETIME`
 * into a Date constructed in the HOST's local zone, so the local field values are exactly
 * the digits the database returned — on any `TZ`. Going through `toIsoUtc` instead would
 * shift those digits by the host offset AND stamp a `Z` the value never had. The result is
 * deliberately NOT `Z`-suffixed and therefore lands in a `string` cell, never a `date`
 * cell — the `date`-cell ISO-UTC invariant stays absolute.
 *
 * The YEAR is zero-padded to four digits like every other field: a raw `getFullYear()`
 * would render a Postgres `timestamp` of `0500-01-01 00:00:00` as the malformed
 * `500-01-01T00:00:00` — and that malformed string is exactly what the inline editor
 * then seeds and would commit straight back into the row.
 */
function wallClock(d: Date): string {
  const base =
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return d.getMilliseconds() === 0 ? base : `${base}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Build one tagged cell for `value` under an already-decided column `kind`. `naive` marks
 * a tz-less temporal column (see {@link wallClock}): a valid `Date` in one is rendered as
 * a literal wall-clock STRING instead of being coerced through the UTC path. Every other
 * value — and every column with `naive` false — takes the byte-identical original route.
 */
function cellFor(value: unknown, kind: ValueKind, naive = false): FrozenCell {
  if (value === null || value === undefined) return { kind: "null" };
  if (naive && value instanceof Date && !Number.isNaN(value.getTime())) {
    return { kind: "string", value: wallClock(value) };
  }
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
 * A column DESCRIPTOR as this mapper needs it: the live name plus the OPTIONAL canonical
 * SQL type. Structural on purpose, so both read paths pass what they already hold with no
 * adaptation — the ad-hoc path its `DriverColumn`s, the browse path its `SchemaColumnInfo`s.
 */
export type ColumnDescriptor = {
  readonly name: string;
  readonly dataType?: string;
};

/**
 * Map ordered column descriptors + raw driver rows into a well-formed {@link FrozenData}.
 * Pure and total: per-column type inference then per-cell tagging, so the output
 * always satisfies the contract's `assertWellFormed` invariant. Columns are always
 * present even when `rows` is empty (the empty-table / past-end page case).
 *
 * A descriptor's `dataType` is carried onto the emitted {@link FrozenColumn} verbatim
 * (the display/binding hint for DW-30/DW-40) and changes the MAPPING in exactly one
 * case: a tz-less temporal column (DW-34) is forced to kind `"string"` and its `Date`
 * values become literal wall-clock strings, because a naive value has no instant to
 * express as a UTC `date` cell. A descriptor with NO `dataType` — a legacy caller, a
 * driver without type metadata, an unmapped engine type — infers exactly as before.
 */
export function rowsToFrozenData(
  columnDescriptors: ReadonlyArray<ColumnDescriptor>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): FrozenData {
  // Per column: the naive-temporal verdict, then the kind. A naive column short-circuits
  // inference to `"string"` — it is the only kind a wall-clock literal can legally take.
  const naives: boolean[] = columnDescriptors.map((c) => isNaiveDateTimeType(c.dataType));
  const kinds: ValueKind[] = columnDescriptors.map((_c, col) =>
    naives[col]! ? "string" : inferColumnKind(rows, col),
  );
  const columns: FrozenColumn[] = columnDescriptors.map((c, col) =>
    // Omit `dataType` entirely when absent, so a descriptor without one produces the
    // byte-identical `{name, type}` column this mapper has always produced.
    c.dataType === undefined
      ? { name: c.name, type: kinds[col]! }
      : { name: c.name, type: kinds[col]!, dataType: c.dataType },
  );
  const frozenRows: FrozenRow[] = rows.map((row) =>
    columnDescriptors.map((_c, col) => cellFor(row[col], kinds[col]!, naives[col]!)),
  );
  return { schemaVersion: FROZEN_SCHEMA_VERSION, columns, rows: frozenRows };
}
