/**
 * quick-studio UI (Ring 2) — Report chart mapper tests (Story 6.1).
 *
 * Pure, DOM-free tests over `mapChart`/`frozenToRecords`: every mark kind, every cell
 * kind (null → null, date → ISO string), a series channel, and the totality guard that
 * returns `null` when the spec references an absent column.
 */

import { describe, expect, test } from "bun:test";
import { FROZEN_SCHEMA_VERSION, type FrozenData } from "../../shared/contract.ts";
import type { ChartSpec, MarkKind } from "../../shared/chart-spec.ts";
import { frozenToRecords, mapChart } from "./report-chart.ts";

const sample: FrozenData = {
  schemaVersion: FROZEN_SCHEMA_VERSION,
  columns: [
    { name: "day", type: "date" },
    { name: "total", type: "number" },
    { name: "label", type: "string" },
    { name: "ok", type: "boolean" },
    { name: "note", type: "string" },
  ],
  rows: [
    [
      { kind: "date", iso: "2026-01-01T00:00:00Z" },
      { kind: "number", value: 10 },
      { kind: "string", value: "a" },
      { kind: "boolean", value: true },
      { kind: "null" },
    ],
    [
      { kind: "date", iso: "2026-01-02T00:00:00Z" },
      { kind: "number", value: 20 },
      { kind: "string", value: "b" },
      { kind: "boolean", value: false },
      { kind: "null" },
    ],
  ],
};

describe("frozenToRecords", () => {
  test("flattens each cell kind to a primitive (date → ISO, null → null)", () => {
    const records = frozenToRecords(sample);
    expect(records).toEqual([
      { day: "2026-01-01T00:00:00Z", total: 10, label: "a", ok: true, note: null },
      { day: "2026-01-02T00:00:00Z", total: 20, label: "b", ok: false, note: null },
    ]);
  });
});

describe("mapChart", () => {
  test.each(["line", "bar", "dot", "area"] as MarkKind[])("maps a %s mark with x/y keys", (mark) => {
    const spec: ChartSpec = { mark, x: "day", y: "total" };
    const out = mapChart(sample, spec);
    expect(out).not.toBeNull();
    expect(out?.mark).toBe(mark);
    expect(out?.xKey).toBe("day");
    expect(out?.yKey).toBe("total");
    expect(out?.series).toBeNull();
    expect(out?.records).toHaveLength(2);
    // Dates carried as ISO strings, not live Date objects.
    expect(out?.records[0]?.day).toBe("2026-01-01T00:00:00Z");
  });

  test("carries a series column when present", () => {
    const out = mapChart(sample, { mark: "line", x: "day", y: "total", series: "label" });
    expect(out?.series).toBe("label");
  });

  test("returns null for a null spec", () => {
    expect(mapChart(sample, null)).toBeNull();
  });

  test("returns null when x, y, or series names an absent column", () => {
    expect(mapChart(sample, { mark: "bar", x: "missing", y: "total" })).toBeNull();
    expect(mapChart(sample, { mark: "bar", x: "day", y: "missing" })).toBeNull();
    expect(mapChart(sample, { mark: "bar", x: "day", y: "total", series: "missing" })).toBeNull();
  });

  test("returns null when the y column is not numeric (degrade to the table view)", () => {
    // A string y column → blank/NaN chart, so mapChart declines it.
    expect(mapChart(sample, { mark: "bar", x: "total", y: "label" })).toBeNull();
    // A date y column is likewise non-numeric → null.
    expect(mapChart(sample, { mark: "line", x: "label", y: "day" })).toBeNull();
  });

  test("preserves null cells in the mapped records (no crash on missing values)", () => {
    // `note` is an all-null column carried on the x/other channel; the numeric y keeps
    // the spec valid, and the null cell survives into the mapped record.
    const out = mapChart(sample, { mark: "bar", x: "note", y: "total" });
    expect(out?.records[0]?.note).toBeNull();
  });
});
