/**
 * quick-studio UI (Ring 2) — ReportChart (Recharts, AR-14) — Story 6.1.
 *
 * Draws a Report query block's chart IN-APP with Recharts (Ring 2) — never the Ring 3
 * sandbox / Observable Plot (that surface is reserved for exported/untrusted content in
 * 6.3/6.4). It consumes the pure {@link ChartData} produced by `report-chart.ts`
 * (`mapChart`), so this component holds no data-shape logic: it only maps a whitelisted
 * mark kind to the matching Recharts primitive from a CLOSED switch.
 *
 * The four whitelisted marks map as: `line → Line`, `bar → Bar`, `area → Area`,
 * `dot → Scatter` (a scatter of points). When a `series` column is present the records
 * are pivoted so each distinct series value becomes its own drawn series; otherwise a
 * single series is drawn on `yKey`. Purely presentational — the parent owns all state.
 */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartData, ChartRecord, ChartValue } from "./report-chart.ts";

/** A stable, readable palette for series strokes/fills (coral-led, mono-friendly). */
const SERIES_COLORS = [
  "var(--coral-line)",
  "#5eb0ef",
  "#7bd88f",
  "#e6c86e",
  "#c78bd8",
  "#e08a6b",
] as const;

const colorAt = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length] as string;

/**
 * Pivot records for a multi-series chart: one row per distinct `xKey` value, with one
 * column per distinct `series` value holding that group's `yKey`. Returns the pivoted
 * rows plus the ordered list of series keys. When `series` is `null`, the identity: the
 * original records and the single `yKey`. Pure and total.
 *
 * The pivoted series columns are NAMESPACED with a reserved `s:` prefix so a series value
 * that happens to equal the `xKey` column NAME can never overwrite the stored x value
 * (the XAxis reads the unprefixed `xKey`; every mark reads a `s:`-prefixed key). Rows
 * whose series value is `null`/empty are skipped — no phantom `dataKey=""` series.
 */
export function pivot(chart: ChartData): { rows: ChartRecord[]; keys: string[] } {
  if (chart.series === null) {
    return { rows: [...chart.records], keys: [chart.yKey] };
  }
  const seriesCol = chart.series;
  const byX = new Map<string, ChartRecord>();
  const keys: string[] = [];
  for (const rec of chart.records) {
    const rawSeries = rec[seriesCol];
    // Skip null/empty series values so no phantom, empty-named series is drawn.
    if (rawSeries === null || rawSeries === undefined || rawSeries === "") continue;
    const sKey = `s:${String(rawSeries)}`;
    if (!keys.includes(sKey)) keys.push(sKey);
    const xVal = rec[chart.xKey] as ChartValue;
    const xKeyStr = String(xVal ?? "");
    let row = byX.get(xKeyStr);
    if (row === undefined) {
      row = { [chart.xKey]: xVal };
      byX.set(xKeyStr, row);
    }
    row[sKey] = rec[chart.yKey] as ChartValue;
  }
  return { rows: [...byX.values()], keys };
}

/** Strip the reserved `s:` series-key prefix for a human-readable mark/tooltip name. */
const seriesLabel = (key: string): string => (key.startsWith("s:") ? key.slice(2) : key);

/** Shared axis + grid + tooltip furniture for every mark. */
function Frame({ xKey }: { xKey: string }): React.JSX.Element {
  return (
    <>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
      <XAxis dataKey={xKey} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
      <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
      <Tooltip
        contentStyle={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
        }}
      />
    </>
  );
}

/**
 * Render {@link ChartData} with Recharts. The mark kind selects the chart+primitive from
 * a closed switch (exhaustively checked); a `series` column draws one primitive per
 * pivoted series key. Sized by a {@link ResponsiveContainer} inside the parent's box.
 */
export function ReportChart({ chart }: { chart: ChartData }): React.JSX.Element {
  const { rows, keys } = pivot(chart);
  const common = { data: rows, margin: { top: 8, right: 12, bottom: 8, left: 0 } };

  switch (chart.mark) {
    case "line":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart {...common}>
            <Frame xKey={chart.xKey} />
            {keys.map((k, i) => (
              <Line key={k} name={seriesLabel(k)} type="monotone" dataKey={k} stroke={colorAt(i)} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      );
    case "bar":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart {...common}>
            <Frame xKey={chart.xKey} />
            {keys.map((k, i) => (
              <Bar key={k} name={seriesLabel(k)} dataKey={k} fill={colorAt(i)} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      );
    case "area":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart {...common}>
            <Frame xKey={chart.xKey} />
            {keys.map((k, i) => (
              <Area
                key={k}
                name={seriesLabel(k)}
                type="monotone"
                dataKey={k}
                stroke={colorAt(i)}
                fill={colorAt(i)}
                fillOpacity={0.25}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      );
    case "dot":
      return (
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart {...common}>
            <Frame xKey={chart.xKey} />
            {keys.map((k, i) => (
              <Scatter key={k} name={seriesLabel(k)} dataKey={k} fill={colorAt(i)} isAnimationActive={false} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      );
    default: {
      const _exhaustive: never = chart.mark;
      throw new Error(`unknown chart mark: ${String(_exhaustive)}`);
    }
  }
}
