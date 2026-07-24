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

// DW-30/35 — a `bigint`/`numeric` column is genuinely numeric even though it travels as
// STRINGS, and since the MySQL big-number pin that includes every MySQL `BIGINT` (a
// `COUNT(*)`/`SUM(...)` included). Gated on the runtime `type`, every such chart would
// have silently degraded to a table; flattened without column context, Recharts would
// have plotted the strings as blanks.
describe("string-encoded numeric columns (DW-30/35)", () => {
  const bigints: FrozenData = {
    schemaVersion: FROZEN_SCHEMA_VERSION,
    columns: [
      { name: "day", type: "date" },
      { name: "total", type: "string", dataType: "bigint" },
      { name: "amount", type: "string", dataType: "numeric" },
      { name: "code", type: "string" },
    ],
    rows: [
      [
        { kind: "date", iso: "2026-01-01T00:00:00Z" },
        { kind: "string", value: "1284" },
        { kind: "string", value: "12.50" },
        { kind: "string", value: "0042" },
      ],
      [
        { kind: "date", iso: "2026-01-02T00:00:00Z" },
        { kind: "string", value: "9007199254740993" },
        { kind: "null" },
        { kind: "string", value: "0043" },
      ],
    ],
  };

  test("mapChart accepts a string-cell bigint as the y channel", () => {
    const out = mapChart(bigints, { mark: "bar", x: "day", y: "total" });
    expect(out).not.toBeNull();
    expect(out?.yKey).toBe("total");
    expect(mapChart(bigints, { mark: "bar", x: "day", y: "amount" })).not.toBeNull();
    // A plain TEXT column of digit-looking strings is still declined — no dataType.
    expect(mapChart(bigints, { mark: "bar", x: "day", y: "code" })).toBeNull();
  });

  test("frozenToRecords emits NUMBERS for numerically-typed columns only", () => {
    const records = frozenToRecords(bigints);
    expect(records[0]).toEqual({
      day: "2026-01-01T00:00:00Z",
      total: 1284,
      amount: 12.5,
      code: "0042", // untyped text keeps its leading zero — never numberified
    });
    expect(records[1]?.amount).toBeNull();
    expect(typeof records[1]?.total).toBe("number");
  });

  test("an unparseable string in a numeric column falls through as the string", () => {
    const messy: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [{ name: "n", type: "string", dataType: "bigint" }],
      rows: [[{ kind: "string", value: "n/a" }], [{ kind: "string", value: "" }]],
    };
    // Better a string Recharts ignores than a NaN that breaks the whole axis domain.
    expect(frozenToRecords(messy)).toEqual([{ n: "n/a" }, { n: "" }]);
  });
});

// Moving the y-gate to the DISPLAY kind alone would have removed the documented
// degrade-to-table fallback: a display-numeric SQL type does not guarantee a
// numeric-LOOKING value, so `mapChart` would return non-null, `Number(...)` would yield
// NaN, and the user would get a BLANK chart instead of the table the AC promises.
describe("mapChart degrades to the table when nothing in y parses (DW-30 fallback)", () => {
  const yOnly = (dataType: string, values: ReadonlyArray<string | null>): FrozenData => ({
    schemaVersion: FROZEN_SCHEMA_VERSION,
    columns: [
      { name: "x", type: "string" },
      { name: "y", type: "string", dataType },
    ],
    rows: values.map((v, i) => [
      { kind: "string", value: `r${i}` } as const,
      v === null ? ({ kind: "null" } as const) : ({ kind: "string", value: v } as const),
    ]),
  });
  const spec: ChartSpec = { mark: "bar", x: "x", y: "y" };

  test("a Postgres `money` column of locale-formatted text degrades to the table", () => {
    // postgres.js returns `money` as `"$1,234.00"`. `money` is in the display-numeric
    // set, so the kind gate alone passes it — and `Number("$1,234.00")` is NaN.
    expect(mapChart(yOnly("money", ["$1,234.00", "$99.00"]), spec)).toBeNull();
  });

  test("a Postgres `numeric` column holding 'NaN' degrades to the table", () => {
    // `'NaN'` is a legal value for a Postgres `numeric`.
    expect(mapChart(yOnly("numeric", ["NaN", "NaN"]), spec)).toBeNull();
  });

  test("an all-NULL numeric column degrades to the table — nothing to plot", () => {
    expect(mapChart(yOnly("bigint", [null, null]), spec)).toBeNull();
  });

  test("ONE parseable cell is enough — a partly-null/partly-junk column still charts", () => {
    expect(mapChart(yOnly("numeric", [null, "NaN", "12.5"]), spec)).not.toBeNull();
    expect(mapChart(yOnly("bigint", ["9007199254740993", null]), spec)).not.toBeNull();
  });

  test("a real `number`-cell column is unaffected (finite values still chart)", () => {
    const numeric: FrozenData = {
      schemaVersion: FROZEN_SCHEMA_VERSION,
      columns: [
        { name: "x", type: "string" },
        { name: "y", type: "number" },
      ],
      rows: [[{ kind: "string", value: "a" }, { kind: "number", value: 1 }]],
    };
    expect(mapChart(numeric, spec)).not.toBeNull();
    // …but an all-NaN float column degrades, exactly as a blank chart would be worse.
    const nan: FrozenData = {
      ...numeric,
      rows: [[{ kind: "string", value: "a" }, { kind: "number", value: Number.NaN }]],
    };
    expect(mapChart(nan, spec)).toBeNull();
  });
});
