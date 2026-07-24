/**
 * quick-studio UI (Ring 2) — Report chart mapper (pure, DOM-free) — Story 6.1.
 *
 * A pure mapper from canonical {@link FrozenData} + a validated {@link ChartSpec} to a
 * Recharts-ready shape (`{ records, xKey, yKey, series, mark }`). It flattens tagged
 * {@link FrozenCell}s to plain JS primitives (a `date` cell becomes its ISO string, a
 * `null` cell becomes JS `null`) — the row shape Recharts consumes — and decouples the
 * Recharts wiring in `ReportChart.tsx` from the frozen-data shape, so the conversion is
 * unit-testable with no DOM.
 *
 * NOTHING here imports Recharts or the DOM. `mapChart` is TOTAL: it returns `null` when
 * the spec references a column ABSENT from the data (x, y, or series) — the caller then
 * degrades to the table view rather than handing Recharts a dangling channel. This
 * mirrors the Ring 3 `frozenToRecords` pass (`src/sandbox/render.ts`) but is duplicated
 * here to keep Ring boundaries clean (Ring 2 must not import Ring 3).
 */

import { frozenColumnDisplayKind } from "../../shared/contract.ts";
import type { FrozenCell, FrozenData } from "../../shared/contract.ts";
import type { ChartSpec, MarkKind } from "../../shared/chart-spec.ts";

/** A plain, chart-ready cell value (dates flattened to their ISO string). */
export type ChartValue = string | number | boolean | null;

/** One Recharts-ready record: `{ [columnName]: value }` for every column. */
export type ChartRecord = Record<string, ChartValue>;

/**
 * The Recharts-ready projection of a chart block. `records` are plain rows in schema
 * column order; `xKey`/`yKey` name the axis columns; `series` (or `null`) names the
 * grouping column; `mark` is the whitelisted mark kind. Everything is a column NAME or
 * a primitive — never code, never a live cell.
 */
export type ChartData = {
  readonly records: ReadonlyArray<ChartRecord>;
  readonly xKey: string;
  readonly yKey: string;
  readonly series: string | null;
  readonly mark: MarkKind;
};

/**
 * Flatten one tagged {@link FrozenCell} to the plain value Recharts reads. Pure/total.
 *
 * `displayKind` is the OWNING column's display classification (see
 * `frozenColumnDisplayKind`). It matters for exactly one case: a numeric column whose
 * values travel as STRINGS — a Postgres `int8`/`numeric`, or, since the big-number pin,
 * any MySQL `BIGINT` including a plain `COUNT(*)`/`SUM(...)`. Recharts plots a string
 * `y` as blank, so such a cell is parsed back to a JS number here; an unparseable one
 * falls through as the original string rather than becoming a chart-breaking `NaN`.
 * Precision is irrelevant at this boundary — a pixel coordinate cannot express 2^53+1
 * anyway — and nothing here ever flows back into a row.
 */
function cellValue(cell: FrozenCell, displayKind: FrozenCell["kind"]): ChartValue {
  switch (cell.kind) {
    case "null":
      return null;
    case "string": {
      if (displayKind !== "number" || cell.value.trim() === "") return cell.value;
      const n = Number(cell.value);
      return Number.isFinite(n) ? n : cell.value;
    }
    case "number":
      return cell.value;
    case "boolean":
      return cell.value;
    case "date":
      return cell.iso;
    default: {
      const _exhaustive: never = cell;
      return String(_exhaustive);
    }
  }
}

/**
 * Convert canonical {@link FrozenData} to plain `{ [columnName]: value }` records —
 * column order is the schema's order; a `null` cell becomes JS `null`; a string-encoded
 * value in a numerically-typed column becomes a JS number. Pure and total.
 */
export function frozenToRecords(data: FrozenData): ChartRecord[] {
  const names = data.columns.map((c) => c.name);
  const kinds = data.columns.map((c) => frozenColumnDisplayKind(c));
  return data.rows.map((row) => {
    const record: ChartRecord = {};
    for (let i = 0; i < names.length; i++) {
      record[names[i] as string] = cellValue(row[i] as FrozenCell, kinds[i] as FrozenCell["kind"]);
    }
    return record;
  });
}

/**
 * True iff the named column holds at least one non-null cell that resolves to a FINITE
 * JS number — the empirical half of the `y`-channel gate. A `number` cell counts when it
 * is finite; a `string` cell counts when its text parses finitely (that is exactly what
 * {@link cellValue} will do to it). An all-NULL column is `false`: there is nothing to
 * plot, so the table view is the honest fallback. Pure and total.
 */
function hasFiniteNumericValue(data: FrozenData, column: string): boolean {
  const idx = data.columns.findIndex((c) => c.name === column);
  if (idx < 0) return false;
  for (const row of data.rows) {
    const cell = row[idx];
    if (cell === undefined || cell.kind === "null") continue;
    if (cell.kind === "number" && Number.isFinite(cell.value)) return true;
    if (cell.kind === "string" && cell.value.trim() !== "" && Number.isFinite(Number(cell.value))) {
      return true;
    }
  }
  return false;
}

/**
 * Map {@link FrozenData} + a {@link ChartSpec} to a {@link ChartData}, or `null` when the
 * spec cannot be drawn against this data: a `null`/absent spec, a spec whose `x`, `y`,
 * or `series` names a column NOT present in the data (a stale spec after the SQL changed),
 * or a spec whose `y` column is NOT numeric — either by SQL/display type, or because no
 * cell in it parses to a finite number (a string/date `y` plots blank/NaN).
 * Pure and total — never throws. The caller degrades a `null` result to the table view.
 */
export function mapChart(data: FrozenData, chart: ChartSpec | null): ChartData | null {
  if (chart === null) return null;
  const names = new Set(data.columns.map((c) => c.name));
  if (!names.has(chart.x) || !names.has(chart.y)) return null;
  if (chart.series !== undefined && !names.has(chart.series)) return null;
  // The `y` channel must be numeric — a string/date column plots as a blank/NaN chart,
  // so an invalid spec degrades to the table view (AC) rather than drawing nothing.
  //
  // TWO conditions, and both are load-bearing:
  //
  //  1. The DISPLAY kind is `number`, not the runtime `type`. A `bigint`/`numeric`
  //     column is genuinely numeric even though it travels as strings, and since the
  //     MySQL big-number pin that includes every MySQL `BIGINT` — keyed on `type` this
  //     would silently degrade every such chart to a table.
  //  2. At least one non-null cell in that column actually PARSES to a finite number.
  //     Condition 1 alone is not sufficient, because a display-numeric SQL type does not
  //     guarantee a numeric-looking value: Postgres `money` comes back from postgres.js
  //     as locale-formatted text (`"$1,234.00"`), and a Postgres `numeric` may legally
  //     hold `'NaN'`. Both make `Number(...)` yield `NaN`, and the user would get a BLANK
  //     chart instead of the table fallback this gate exists to produce — a strictly
  //     worse outcome than before the display-kind switch. Scanning is O(rows) on the
  //     ONE y column and stops at the first parseable cell.
  const yCol = data.columns.find((c) => c.name === chart.y);
  if (yCol === undefined || frozenColumnDisplayKind(yCol) !== "number") return null;
  if (!hasFiniteNumericValue(data, chart.y)) return null;
  return {
    records: frozenToRecords(data),
    xKey: chart.x,
    yKey: chart.y,
    series: chart.series ?? null,
    mark: chart.mark,
  };
}
