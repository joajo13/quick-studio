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

/** Flatten one tagged {@link FrozenCell} to the plain value Recharts reads. Pure/total. */
function cellValue(cell: FrozenCell): ChartValue {
  switch (cell.kind) {
    case "null":
      return null;
    case "string":
      return cell.value;
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
 * column order is the schema's order; a `null` cell becomes JS `null`. Pure and total.
 */
export function frozenToRecords(data: FrozenData): ChartRecord[] {
  const names = data.columns.map((c) => c.name);
  return data.rows.map((row) => {
    const record: ChartRecord = {};
    for (let i = 0; i < names.length; i++) {
      record[names[i] as string] = cellValue(row[i] as FrozenCell);
    }
    return record;
  });
}

/**
 * Map {@link FrozenData} + a {@link ChartSpec} to a {@link ChartData}, or `null` when the
 * spec cannot be drawn against this data: a `null`/absent spec, a spec whose `x`, `y`,
 * or `series` names a column NOT present in the data (a stale spec after the SQL changed),
 * or a spec whose `y` column is NOT numeric (a string/date `y` plots blank/NaN).
 * Pure and total — never throws. The caller degrades a `null` result to the table view.
 */
export function mapChart(data: FrozenData, chart: ChartSpec | null): ChartData | null {
  if (chart === null) return null;
  const names = new Set(data.columns.map((c) => c.name));
  if (!names.has(chart.x) || !names.has(chart.y)) return null;
  if (chart.series !== undefined && !names.has(chart.series)) return null;
  // The `y` channel must be numeric — a string/date column plots as a blank/NaN chart,
  // so an invalid spec degrades to the table view (AC) rather than drawing nothing.
  const yCol = data.columns.find((c) => c.name === chart.y);
  if (yCol === undefined || yCol.type !== "number") return null;
  return {
    records: frozenToRecords(data),
    xKey: chart.x,
    yKey: chart.y,
    series: chart.series ?? null,
    mark: chart.mark,
  };
}
