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
 * comma, a quote, or a newline; otherwise emit it verbatim. Runs AFTER
 * {@link formulaGuard}, so a guard quote lands inside the RFC-4180 quoting. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * CSV/formula-injection mitigation: a field whose FIRST character is `=`, `+`, `-`, `@`,
 * a tab or a CR is treated as a live formula when the exported file is opened in Excel /
 * Google Sheets. Prefixing the OWASP guard character `'` forces the spreadsheet app to
 * read it back as literal text. This deliberately trades byte-fidelity for safety: the
 * export is lossy by one leading `'`, so a non-spreadsheet consumer (pandas, `COPY ... FROM
 * ... CSV`) sees that character too. Nothing else about the payload is rewritten, and a
 * sigil past position 0 cannot start a formula, so it is left alone.
 */
function formulaGuard(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Serialize one piece of user/DB-authored text: guard FIRST, then escape — so the guard
 * lands inside the RFC-4180 quoting (`=a,b` → `"'=a,b"`, never `'"=a,b"`). Both
 * text-bearing sites — column names and `string` cells — go through here so the two
 * copies of that order can never drift apart.
 */
function csvText(text: string): string {
  return csvField(formulaGuard(text));
}

/**
 * One CSV field for one cell. Only `string` cells carry user/DB-authored text and get the
 * guard; `number`/`boolean`/`date`/`null` are machine-formatted by {@link cellText}, so a
 * leading `-` there is a real minus sign and prefixing it would corrupt the exported
 * value. The switch is exhaustive on purpose — a new `FrozenCell` kind fails to compile
 * here instead of silently slipping past the guard.
 */
function csvCell(cell: FrozenCell): string {
  switch (cell.kind) {
    case "string":
      return csvText(cell.value);
    case "null":
    case "number":
    case "boolean":
    case "date":
      return csvField(cellText(cell));
  }
}

/**
 * Serialize the loaded page to an RFC-4180-ish CSV: a header row of column names then
 * one row per `FrozenRow`, `null` → empty field. Column names and `string` cells are both
 * formula-guarded by {@link csvText} before escaping; the other cell kinds are escaped as
 * they are by {@link csvCell}.
 * Pure — the caller triggers the client-side download; this never issues an RPC.
 */
export function rowsToCsv(
  columns: ReadonlyArray<FrozenColumn>,
  rows: ReadonlyArray<FrozenRow>,
): string {
  const header = columns.map((c) => csvText(c.name)).join(",");
  const lines = rows.map((row) => row.map((cell) => csvCell(cell)).join(","));
  return [header, ...lines].join("\n");
}
