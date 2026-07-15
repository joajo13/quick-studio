/**
 * quick-studio UI (Ring 2) — result-grid presentation helpers (pure).
 *
 * Dependency-free, DOM-free, RPC-free helpers that back the result bar's live row
 * filter and its Export button. Both operate ONLY over already-loaded `FrozenData`
 * rows — they never refetch, never compose SQL, and never touch the `DataGridState`
 * pager model. Kept pure + deterministic so they are unit-testable with no harness.
 */

import type { FrozenCell, FrozenColumn, FrozenRow } from "../../shared/contract.ts";

/**
 * The plain display text of one cell — the same value the grid renders. `null` is the
 * empty string (it is never matched by a filter, and exports as an empty CSV field).
 */
function cellText(cell: FrozenCell): string {
  switch (cell.kind) {
    case "null":
      return "";
    case "string":
      return cell.value;
    case "number":
      return String(cell.value);
    case "boolean":
      return cell.value ? "true" : "false";
    case "date":
      return cell.iso;
  }
}

/**
 * Presentation-only client-side row filter: keep a row when ANY of its cells' display
 * text contains `query` (case-insensitive substring). An empty/whitespace query returns
 * the input array UNCHANGED (same reference) so the caller can skip needless re-renders.
 */
export function filterRows(rows: ReadonlyArray<FrozenRow>, query: string): ReadonlyArray<FrozenRow> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter((row) => row.some((cell) => cellText(cell).toLowerCase().includes(needle)));
}

/** Escape one CSV field (RFC-4180-ish): quote + double interior quotes when it holds a
 * comma, a quote, or a newline; otherwise emit it verbatim. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serialize the loaded page to an RFC-4180-ish CSV: a header row of column names then
 * one row per `FrozenRow`, fields escaped by {@link csvField} and `null` → empty field.
 * Pure — the caller triggers the client-side download; this never issues an RPC.
 */
export function rowsToCsv(
  columns: ReadonlyArray<FrozenColumn>,
  rows: ReadonlyArray<FrozenRow>,
): string {
  const header = columns.map((c) => csvField(c.name)).join(",");
  const lines = rows.map((row) => row.map((cell) => csvField(cellText(cell))).join(","));
  return [header, ...lines].join("\n");
}
