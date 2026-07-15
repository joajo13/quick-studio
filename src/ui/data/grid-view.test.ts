/**
 * Unit tests for the pure result-grid presentation helpers (Story 7.2). No DOM /
 * React harness — the client-side row filter and the CSV serializer are pure
 * functions over already-loaded `FrozenData` rows.
 */

import { describe, expect, test } from "bun:test";
import type { FrozenColumn, FrozenRow } from "../../shared/contract.ts";
import { filterRows, rowsToCsv } from "./grid-view.ts";

const columns: ReadonlyArray<FrozenColumn> = [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
  { name: "note", type: "string" },
];

const rows: ReadonlyArray<FrozenRow> = [
  [
    { kind: "number", value: 1 },
    { kind: "string", value: "Alice" },
    { kind: "null" },
  ],
  [
    { kind: "number", value: 2 },
    { kind: "string", value: "Bob" },
    { kind: "string", value: "hello, world" },
  ],
];

describe("filterRows", () => {
  test("keeps rows whose any cell contains the query (case-insensitive)", () => {
    const out = filterRows(rows, "ALI");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(rows[0]);
  });

  test("matches on non-string cells' display text (e.g. a numeric id)", () => {
    const out = filterRows(rows, "2");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(rows[1]);
  });

  test("no match returns an empty array", () => {
    expect(filterRows(rows, "zzz")).toHaveLength(0);
  });

  test("an empty query returns all rows (same reference)", () => {
    expect(filterRows(rows, "")).toBe(rows);
  });

  test("a whitespace-only query returns all rows (same reference)", () => {
    expect(filterRows(rows, "   ")).toBe(rows);
  });

  test("a null cell is never matched (empty display text)", () => {
    // "null" as a needle must not select the row whose note cell is SQL NULL.
    expect(filterRows(rows, "null")).toHaveLength(0);
  });
});

describe("rowsToCsv", () => {
  test("emits a header row then one line per row", () => {
    const csv = rowsToCsv(columns, [rows[0]!]);
    expect(csv).toBe("id,name,note\n1,Alice,");
  });

  test("null cells serialize as an empty field", () => {
    const csv = rowsToCsv(columns, [rows[0]!]);
    expect(csv.split("\n")[1]).toBe("1,Alice,");
  });

  test("quotes fields containing a comma", () => {
    const csv = rowsToCsv(columns, [rows[1]!]);
    expect(csv).toBe('id,name,note\n2,Bob,"hello, world"');
  });

  test("quotes and doubles interior quotes", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: 'a "quoted" b' }]]);
    expect(csv.split("\n")[1]).toBe('"a ""quoted"" b"');
  });

  test("quotes fields containing a newline", () => {
    const csv = rowsToCsv(columns, [[{ kind: "string", value: "line1\nline2" }]]);
    expect(csv.split("\n").slice(1).join("\n")).toBe('"line1\nline2"');
  });

  test("header-only output when there are no rows", () => {
    expect(rowsToCsv(columns, [])).toBe("id,name,note");
  });
});
