/**
 * quick-studio UI (Ring 2) — ReportChart pivot tests (Story 6.1).
 *
 * Pure, DOM-free tests over the exported `pivot` helper: the single-series identity, the
 * multi-series namespacing that stops a series value colliding with the `xKey` column
 * name, and the skip of null/empty series values (no phantom `dataKey=""` series).
 */

import { describe, expect, test } from "bun:test";
import { pivot } from "./ReportChart.tsx";
import type { ChartData } from "./report-chart.ts";

const chart = (over: Partial<ChartData>): ChartData => ({
  records: [],
  xKey: "x",
  yKey: "y",
  series: null,
  mark: "line",
  ...over,
});

describe("pivot", () => {
  test("single-series is the identity on records + yKey", () => {
    const c = chart({ records: [{ x: 1, y: 10 }, { x: 2, y: 20 }] });
    const { rows, keys } = pivot(c);
    expect(keys).toEqual(["y"]);
    expect(rows).toEqual([{ x: 1, y: 10 }, { x: 2, y: 20 }]);
  });

  test("a series value equal to the xKey name never overwrites the x value", () => {
    // series value "x" collides with the xKey column NAME → must stay namespaced.
    const c = chart({
      series: "s",
      records: [
        { x: "a", y: 10, s: "x" },
        { x: "b", y: 20, s: "x" },
      ],
    });
    const { rows, keys } = pivot(c);
    expect(keys).toEqual(["s:x"]);
    // The x value survives (not clobbered by the y value under an "x" key).
    expect(rows).toEqual([
      { x: "a", "s:x": 10 },
      { x: "b", "s:x": 20 },
    ]);
  });

  test("null/empty series values are skipped — no phantom empty-named series", () => {
    const c = chart({
      series: "s",
      records: [
        { x: "a", y: 10, s: "north" },
        { x: "b", y: 20, s: null },
        { x: "c", y: 30, s: "" },
      ],
    });
    const { rows, keys } = pivot(c);
    expect(keys).toEqual(["s:north"]);
    expect(rows).toEqual([{ x: "a", "s:north": 10 }]);
  });
});
